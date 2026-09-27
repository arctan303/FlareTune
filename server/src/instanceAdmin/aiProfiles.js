import { InstanceAdminError, atomic, changed, currentTime, requireActiveAdmin, statement,
  validateRevision } from './common.js';

const providers = new Set(['deepseek', 'openai', 'gemini', 'compatible']);
const features = new Set(['assistant', 'lyrics']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function credentialSecret(env) {
  const secret = env?.SETUP_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new InstanceAdminError('setup_secret_unavailable', 503);
  }
  return secret;
}

async function encryptionKey(env) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(credentialSecret(env)),
    'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('FlareTune instance secret separation v2'),
    info: encoder.encode('ai_model_profiles AES-GCM key v2') }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function encryptCredential(apiKey, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
    await encryptionKey(env), encoder.encode(apiKey));
  return { encryptedKey: encode(new Uint8Array(ciphertext)), keyIv: encode(iv) };
}

async function decryptCredential(row, env) {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(row.key_iv) },
      await encryptionKey(env), decode(row.encrypted_key));
    return decoder.decode(plaintext);
  } catch {
    throw new Error('AI_CREDENTIAL_UNAVAILABLE');
  }
}

function validateProfile(input, { create = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InstanceAdminError('invalid_ai_profile', 400);
  }
  const { name, provider, model, baseUrl = '', apiKey = '' } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 80
    || !providers.has(provider) || typeof model !== 'string' || !model.trim()
    || model.length > 160 || typeof baseUrl !== 'string' || baseUrl.length > 2048
    || typeof apiKey !== 'string' || apiKey.length > 4096
    || (apiKey && (apiKey.trim() !== apiKey || /[\r\n]/.test(apiKey)))
    || (create && !apiKey)) throw new InstanceAdminError('invalid_ai_profile', 400);
  if (provider === 'compatible' && !baseUrl) throw new InstanceAdminError('invalid_ai_profile', 400);
  if (provider === 'gemini' && baseUrl) throw new InstanceAdminError('invalid_ai_profile', 400);
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new InstanceAdminError('invalid_ai_profile', 400); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !url.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.pathname.endsWith('/chat/completions')) {
      throw new InstanceAdminError('invalid_ai_profile', 400);
    }
  }
  return { name: name.trim(), provider, model: model.trim(), baseUrl, apiKey };
}

const publicProfile = (row, hasKey) => ({ id: row.id, name: row.name, provider: row.provider,
  model: row.model, baseUrl: row.base_url, hasKey, revision: row.revision });

async function isCredentialReadable(row, env) {
  try { return Boolean(await decryptCredential(row, env)); }
  catch { return false; }
}

export async function listAiProfiles(db, actorAccountId, env) {
  await requireActiveAdmin(db, actorAccountId);
  const [profileRows, assignmentRows] = await Promise.all([
    db.prepare('SELECT id, name, provider, model, base_url, encrypted_key, key_iv, revision FROM ai_model_profiles ORDER BY created_at, id').all(),
    db.prepare('SELECT feature, profile_id, revision FROM ai_feature_assignments').all(),
  ]);
  return { profiles: await Promise.all((profileRows.results || []).map(async (row) =>
    publicProfile(row, await isCredentialReadable(row, env)))),
    assignments: Object.fromEntries((assignmentRows.results || []).map((row) => [row.feature,
      { profileId: row.profile_id, revision: row.revision }])),
    credentialReady: Boolean(env?.SETUP_SECRET?.length >= 32) };
}

export async function createAiProfile(db, actorAccountId, input, env, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  const data = validateProfile(input, { create: true });
  currentTime(now);
  const id = crypto.randomUUID();
  const { encryptedKey, keyIv } = await encryptCredential(data.apiKey, env);
  const [result] = await atomic(db, [
    statement(db, `INSERT INTO ai_model_profiles
      (id, name, provider, model, base_url, encrypted_key, key_iv, revision, created_at, updated_at, updated_by)
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE EXISTS
      (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    id, data.name, data.provider, data.model, data.baseUrl, encryptedKey, keyIv,
    now, now, actor.account_id, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.create', 'ai_profile', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, id, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('forbidden', 403);
  return { id, name: data.name, provider: data.provider, model: data.model,
    baseUrl: data.baseUrl, hasKey: true, revision: 1 };
}

export async function updateAiProfile(db, actorAccountId, id, input, expectedRevision, env,
  now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision);
  currentTime(now);
  const data = validateProfile(input);
  const existing = await db.prepare('SELECT provider, base_url, encrypted_key, key_iv FROM ai_model_profiles WHERE id = ?').bind(id).first();
  if (!existing) throw new InstanceAdminError('ai_profile_missing', 404);
  if (!data.apiKey && (data.provider !== existing.provider || data.baseUrl !== existing.base_url)) {
    throw new InstanceAdminError('ai_profile_key_required', 400);
  }
  if (!data.apiKey && !await isCredentialReadable(existing, env)) {
    throw new InstanceAdminError('ai_profile_key_required', 400);
  }
  const key = data.apiKey ? await encryptCredential(data.apiKey, env)
    : { encryptedKey: existing.encrypted_key, keyIv: existing.key_iv };
  const [result] = await atomic(db, [
    statement(db, `UPDATE ai_model_profiles SET name = ?, provider = ?, model = ?, base_url = ?,
      encrypted_key = ?, key_iv = ?, revision = revision + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND revision = ? AND EXISTS
      (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    data.name, data.provider, data.model, data.baseUrl, key.encryptedKey, key.keyIv,
    now, actor.account_id, id, expectedRevision, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.update', 'ai_profile', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, id, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { id, name: data.name, provider: data.provider, model: data.model,
    baseUrl: data.baseUrl, hasKey: true, revision: expectedRevision + 1 };
}

export async function deleteAiProfile(db, actorAccountId, id, expectedRevision, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision);
  const [result] = await atomic(db, [
    statement(db, `DELETE FROM ai_model_profiles WHERE id = ? AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM ai_feature_assignments WHERE profile_id = ?)
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    id, expectedRevision, id, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.delete', 'ai_profile', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, id, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('ai_profile_in_use_or_conflict', 409);
  return { ok: true };
}

export async function assignAiProfile(db, actorAccountId, feature, profileId, expectedRevision,
  now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision, { allowZero: true });
  if (!features.has(feature) || (profileId !== null && (typeof profileId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(profileId)))) throw new InstanceAdminError('invalid_ai_assignment', 400);
  currentTime(now);
  if (profileId !== null) {
    const profile = await db.prepare('SELECT id FROM ai_model_profiles WHERE id = ?').bind(profileId).first();
    if (!profile) throw new InstanceAdminError('ai_profile_missing', 404);
  }
  const [result] = await atomic(db, [
    expectedRevision === 0
      ? statement(db, `INSERT INTO ai_feature_assignments
        (feature, profile_id, revision, updated_at, updated_by)
        SELECT ?, ?, 1, ?, ? WHERE EXISTS
        (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
        ON CONFLICT(feature) DO NOTHING`, feature, profileId, now, actor.account_id,
      actor.account_id)
      : statement(db, `UPDATE ai_feature_assignments SET profile_id = ?, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE feature = ? AND revision = ? AND EXISTS
        (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
      profileId, now, actor.account_id, feature, expectedRevision, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.assign', 'ai_feature', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, feature, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { feature, profileId, revision: expectedRevision + 1 };
}

export async function resolveAiFeature(db, feature, env, legacyConfig) {
  if (!db?.prepare) return null;
  let row;
  try {
    row = await db.prepare(`SELECT p.provider, p.model, p.base_url, p.encrypted_key, p.key_iv
      FROM ai_feature_assignments a JOIN ai_model_profiles p ON p.id = a.profile_id
      WHERE a.feature = ?`).bind(feature).first();
  } catch (error) {
    // Existing instances keep their deployment-bound credentials until migration 0006 is applied.
    if (/no such table: ai_feature_assignments/i.test(String(error?.message))) return null;
    throw error;
  }
  if (!row) return null;
  const apiKey = await decryptCredential(row, env);
  const provider = row.provider === 'compatible' ? 'openai' : row.provider;
  const secretName = { deepseek: 'DEEPSEEK_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' }[provider];
  const urlName = { deepseek: 'DEEPSEEK_BASE_URL', openai: 'OPENAI_BASE_URL' }[provider];
  const baseUrl = row.base_url || (provider === 'deepseek' ? 'https://api.deepseek.com'
    : provider === 'openai' ? 'https://api.openai.com/v1' : '');
  return { config: { ...legacyConfig, provider, model: row.model, exactModel: true },
    env: { ...env, [secretName]: apiKey,
      ...(urlName ? { [urlName]: baseUrl } : {}) } };
}
