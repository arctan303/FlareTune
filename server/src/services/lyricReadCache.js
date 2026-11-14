import { tokenFromCookie } from '../auth/local/index.js';
import { tokenDigest } from '../auth/local/crypto.js';
import { isUsableCredentialMaterial } from '../instance/credentialFormat.js';
import { databaseIdentity } from './databaseIdentity.js';
import { mediaPrefix, mediaObjectKey } from './adminMusicMedia.js';
import { normalizeLyricArtifactSongId, validateLyricArtifact } from './lyricArtifactStore.js';

const encoder = new TextEncoder();
const MISS = Object.freeze({ hitPayload: null, ticket: null });
const SETTINGS_LIMIT = 256;
const PROFILE_LIMIT = 32;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_PEEK_BYTES = 256 * 1024;
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const etagOf = object => {
  const value = object?.etag || object?.httpEtag;
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
};
const rowsJson = (table, columns, order, limit) => `(SELECT json_group_array(json_object(${columns.map(column => `'${column}',${column}`).join(',')}))
  FROM (SELECT ${columns.join(',')} FROM ${table} ORDER BY ${order} LIMIT ${limit + 1}))`;
const SETTINGS_JSON = rowsJson('instance_settings', ['key', 'value_json', 'revision'], 'key', SETTINGS_LIMIT);
const PROFILES_JSON = rowsJson('ai_model_profiles', ['id', 'name', 'provider', 'model', 'base_url', 'encrypted_key', 'key_iv', 'revision', 'created_at', 'updated_at', 'updated_by'], 'id', PROFILE_LIMIT);
const PROTOCOLS_JSON = rowsJson('ai_profile_protocols', ['profile_id', 'source', 'protocol', 'options_json'], 'profile_id', PROFILE_LIMIT);
const ASSIGNMENTS_JSON = rowsJson('ai_feature_assignments', ['feature', 'profile_id', 'revision', 'updated_at', 'updated_by'], 'feature', PROFILE_LIMIT);
const MODELS_JSON = rowsJson('ai_feature_models', ['feature', 'provider_id', 'model', 'supports_images', 'options_json'], 'feature', PROFILE_LIMIT);

// A conservative snapshot deliberately includes every setting and model record.
// It is not a second implementation of plugin availability or lyric decisions.
// Missing legacy tables, oversized snapshots and every read error disable this
// optimization and leave the ordinary authorized reader in charge.
async function fingerprint(input, now) {
  const external = input.songId.startsWith('yt:');
  const songSql = external
    ? `(SELECT json_object('song_id',song_id,'source',source,'source_id',source_id,'metadata_json',metadata_json,'updated_at',updated_at)
       FROM Member_External_Songs WHERE account_id=? AND song_id=?)`
    : `(SELECT json_object('id',id,'title',title,'artist',artist,'album',album,'duration',duration,'language',language) FROM Songs WHERE id=?)`;
  const row = await input.db.prepare(`SELECT a.role AS current_role,s.expires_at,c.kdf,c.kdf_version,c.kdf_params_json,c.salt,c.password_hash,
    ${songSql} AS song_json,${SETTINGS_JSON} AS settings_json,${PROFILES_JSON} AS profiles_json,
    ${PROTOCOLS_JSON} AS protocols_json,${ASSIGNMENTS_JSON} AS assignments_json,${MODELS_JSON} AS models_json
    FROM account_sessions s JOIN accounts a ON a.account_id=s.account_id JOIN account_credentials c ON c.account_id=a.account_id
    WHERE s.token_hash=? AND s.account_id=? AND s.mode='normal' AND s.revoked_at IS NULL AND s.expires_at>?
      AND a.status='active' AND a.role IN ('admin','member') AND c.must_change_password=0`)
    .bind(...(external ? [input.accountId, input.songId] : [input.songId]), input.tokenHash, input.accountId, now).first();
  if (!row || row.current_role !== input.role || !isUsableCredentialMaterial(row) || !row.song_json) return null;
  const snapshots = ['settings_json', 'profiles_json', 'protocols_json', 'assignments_json', 'models_json'];
  let length = 0;
  for (const key of snapshots) {
    if (typeof row[key] !== 'string') return null;
    length += encoder.encode(row[key]).byteLength;
    if (length > MAX_SNAPSHOT_BYTES) return null;
    const rows = JSON.parse(row[key]);
    if (!Array.isArray(rows) || rows.length > (key === 'settings_json' ? SETTINGS_LIMIT : PROFILE_LIMIT)) return null;
  }
  return sha256(JSON.stringify(row));
}

function terminalAsset(artifact) {
  if (artifact?.status !== 'ready' || ['pending', 'failed', 'review'].includes(artifact.aiCompletion?.status)) return false;
  return artifact.translationDecision?.status === 'not_needed'
    || Boolean(artifact.translation?.lines?.some(line => typeof line === 'string' && line.trim()));
}

export function createLyricReadCache({ now = Date.now, ttlMs = 30_000, maxEntries = 64,
  maxBytes = 2 * 1024 * 1024, maxEntryBytes = 256 * 1024 } = {}) {
  const databases = new WeakMap(), tickets = new WeakMap();
  const scopeFor = (database, bucket) => {
    let buckets = databases.get(database);
    if (!buckets) { buckets = new WeakMap(); databases.set(database, buckets); }
    let scope = buckets.get(bucket);
    if (!scope) { scope = { entries: new Map(), bytes: 0 }; buckets.set(bucket, scope); }
    return scope;
  };
  const remove = (scope, key) => {
    const value = scope.entries.get(key);
    if (value) { scope.bytes -= value.bytes; scope.entries.delete(key); }
  };
  const live = input => !input.request.signal.aborted;
  async function begin({ request, env, db = env?.DB, session, accountId, songId, allowFill = true } = {}) {
    try {
      if (!(request instanceof Request) || request.signal.aborted || request.method !== 'GET'
        || !env?.MEDIA_BUCKET?.head || !env.MEDIA_BUCKET.get || !db?.prepare
        || databaseIdentity(db) !== databaseIdentity(env.DB) || session?.mode !== 'normal'
        || !['admin', 'member'].includes(session.account?.role) || accountId !== session.account?.accountId
        || typeof accountId !== 'string' || !accountId || typeof session.tokenHash !== 'string'
        || typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) return MISS;
      const url = new URL(request.url), query = [...url.searchParams.keys()];
      if (url.pathname !== '/api/lyrics' || query.length !== 1 || query[0] !== 'songId'
        || url.searchParams.get('songId') !== songId) return MISS;
      const expectedAccount = request.headers.get('X-FlareTune-Expected-Account');
      if (expectedAccount && expectedAccount !== accountId) return MISS;
      const tokenHash = await tokenDigest(tokenFromCookie(request.headers.get('Cookie')));
      if (!tokenHash || tokenHash !== session.tokenHash || request.signal.aborted) return MISS;
      const normalizedId = normalizeLyricArtifactSongId(songId), prefix = mediaPrefix(env);
      const locale = request.headers.get('Accept-Language') || '';
      if (!prefix || locale.length > 256) return MISS;
      const key = JSON.stringify([prefix, accountId, tokenHash, normalizedId, locale, await sha256(env.SETUP_SECRET)]);
      const bucket = env.MEDIA_BUCKET, scope = scopeFor(databaseIdentity(db), bucket);
      const input = { request, db, bucket, scope, key, songId: normalizedId, tokenHash, accountId,
        role: session.account.role, objectKey: mediaObjectKey(prefix, `lyrics/${normalizedId}.json`) };
      let entry = scope.entries.get(key);
      if (entry && entry.expiresAt <= now()) { remove(scope, key); entry = null; }
      if (entry) {
        // There is no authorization cache: the last external I/O before
        // publishing a hit is this request's genuine fresh D1 SELECT.
        const etag = etagOf(await bucket.head(input.objectKey));
        if (!live(input) || !etag || etag !== entry.etag) { remove(scope, key); return MISS; }
        const current = await fingerprint(input, now());
        if (!live(input) || !current || current !== entry.fingerprint) { remove(scope, key); return MISS; }
        scope.entries.delete(key); scope.entries.set(key, entry);
        return Object.freeze({ hitPayload: JSON.parse(entry.payload), ticket: null });
      }
      // The route first probes hot entries before resolving the song. A cold
      // lookup must do no storage I/O until that resolver has ruled out an
      // instrumental song; this also covers expired entries removed above.
      if (allowFill !== true) return MISS;
      // Cold unknown/missing/pending lyrics spend no extra D1 allowance. Only
      // an existing terminal artifact can start a cache-fill observation.
      const object = await bucket.get(input.objectKey);
      if (!live(input) || !object || !Number.isFinite(object.size) || object.size > MAX_PEEK_BYTES
        || typeof object.text !== 'function') return MISS;
      const text = await object.text();
      if (!live(input) || encoder.encode(text).byteLength > MAX_PEEK_BYTES) return MISS;
      const checked = validateLyricArtifact(JSON.parse(text), { expectedSongId: normalizedId, maxBytes: MAX_PEEK_BYTES });
      const etag = etagOf(object);
      if (!checked.valid || !etag || !terminalAsset(checked.artifact)) return MISS;
      const before = await fingerprint(input, now());
      if (!live(input) || !before) return MISS;
      const ticket = Object.freeze({});
      tickets.set(ticket, { ...input, etag, before, createdAt: now() });
      return Object.freeze({ hitPayload: null, ticket });
    } catch { return MISS; }
  }
  async function store(ticket, request, payload) {
    const input = tickets.get(ticket);
    if (!input) return false;
    tickets.delete(ticket);
    try {
      if (request !== input.request || !live(input) || now() - input.createdAt > ttlMs
        || payload?.code !== 200 || payload.data?.sourceId !== 'lyrics-workbench'
        || !['ready', 'not_needed'].includes(payload.data?.translation?.state)) return false;
      // Serialize immediately so caller mutations during the following I/O
      // cannot change what was validated by the ordinary source reader.
      const serialized = JSON.stringify(payload), bytes = encoder.encode(serialized).byteLength;
      if (bytes > maxEntryBytes || bytes > maxBytes) return false;
      const etag = etagOf(await input.bucket.head(input.objectKey));
      if (!live(input) || etag !== input.etag) return false;
      const after = await fingerprint(input, now());
      if (!live(input) || !after || after !== input.before) return false;
      remove(input.scope, input.key);
      input.scope.entries.set(input.key, { etag, fingerprint: after, payload: serialized, bytes, expiresAt: now() + ttlMs });
      input.scope.bytes += bytes;
      while (input.scope.entries.size > maxEntries || input.scope.bytes > maxBytes) remove(input.scope, input.scope.entries.keys().next().value);
      return true;
    } catch { return false; }
  }
  return Object.freeze({ begin, store });
}

const shared = createLyricReadCache();
export const beginLyricReadCache = input => shared.begin(input);
export const storeLyricReadCache = (ticket, request, payload) => shared.store(ticket, request, payload);
