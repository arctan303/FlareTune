import { createLyricDocument, parseLrcDocument, projectCanonicalLrc } from '../utils/lyricDocument.js';
import { buildReadyLyricArtifact, lyricArtifactStoreForEnv, lyricTextForHash, projectLyricArtifact,
  projectLyricTranslation, shouldAiCompleteLyrics } from './lyricAssetWorkflow.js';
import { computeHash } from '../utils/lyricsParsing.js';
import { deliveryPluginModules } from '../plugins/delivery.generated.js';
import { pluginRegistry, installationKey } from '../plugins/registry.js';
import { createPluginOperationLease, isPluginServiceLeaseForSession } from '../plugins/services.js';
import { requirePluginSession, pluginFail } from '../plugins/common.js';
import { guardStoreAuthority, storeAuthorityGuard } from './storeAuthority.js';
import { updateDefinedSetting } from '../instanceAdmin/settings.js';
import { subsonicAuthorityForPrincipal } from '../subsonic/credentials.js';
import { isSubsonicPluginServiceLeaseForPrincipal } from '../subsonic/pluginAuthority.js';
import { isServiceConfigurationAssertionForLease } from '../plugins/serviceConfig.js';
import { isPluginVisibleToRole } from '../../../shared/plugins/manifest.js';
import { applyLyricOffset } from './lyricResolution.js';
import { resolveLyricSong, lyricSongStillExists } from './playbackLyrics.js';
import { LyricSourceError } from './lyricSourceError.js';

export const DEFAULT_LYRIC_SOURCE_ORDER = Object.freeze(['lyrics-workbench', 'youtube-music', 'file']);
export const LYRIC_ORDER_KEY = 'lyrics.source-order';
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(id);
const states = new Set(['idle', 'pending', 'ready', 'failed', 'unavailable', 'not_needed']);
const encoder = new TextEncoder();
const localeOf = value => /^zh-(?:Hant|TW|HK)/iu.test(value || '') ? 'zh-Hant'
  : ['zh', 'en', 'ja', 'ko'].includes(String(value || '').split('-')[0]) ? String(value).split('-')[0] : 'en';
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export function validateLyricSourceOrder(value) {
  if (!Array.isArray(value) || value.length > 33 || value.some(id => !validId(id)) || new Set(value).size !== value.length) pluginFail('invalid_input', 400);
  return [...value];
}
export function effectiveLyricSourceOrder(saved, ids) {
  const available = new Set(ids);
  return [...new Set([...saved, ...DEFAULT_LYRIC_SOURCE_ORDER, ...ids])].filter(id => available.has(id));
}
export async function loadLyricSourceOrder(db, ids) {
  const row = await db.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(LYRIC_ORDER_KEY).first();
  let saved = DEFAULT_LYRIC_SOURCE_ORDER;
  if (row) {
    try { saved = validateLyricSourceOrder(JSON.parse(row.value_json)); }
    catch { pluginFail('LYRIC_ORDER_UNAVAILABLE', 503); }
  }
  return { order: effectiveLyricSourceOrder(saved, ids), revision: Number(row?.revision || 0) };
}

// Claims never call a different source. Abort the scoped capability before
// trying the next source, so timed-out work cannot later persist its result.
async function boundedResolve(source, song, options) {
  const controller = new AbortController();
  const parent = options.signal;
  // The same linked signal remains attached to the parent after resolve, as
  // the provider's adoption closure may still perform asynchronous writes.
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timeout = Math.max(1, Math.min(Number(source.timeoutMs) || (source.id === 'file' ? 2000 : 20000), 20000));
  const run = async work => {
    signal.throwIfAborted();
    let timer, interrupted;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          interrupted = () => reject(Object.assign(new Error('LYRIC_SOURCE_INTERRUPTED'), { code: 'LYRIC_SOURCE_INTERRUPTED' }));
          signal.addEventListener('abort', interrupted, { once: true });
          if (signal.aborted) interrupted();
          timer = setTimeout(() => controller.abort('source_timeout'), timeout);
        }),
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', interrupted); }
  };
  const result = await run(() => source.resolve(song, { ...options, signal }));
  return typeof result?.onAdopt === 'function' ? { ...result, onAdopt: () => run(() => result.onAdopt()) } : result;
}
export function normalizeLyricSourceResult(result, sourceId, song = {}) {
  if (!result) return null;
  if (!['good', 'weak'].includes(result.quality)) throw new TypeError('Invalid lyric source quality');
  const document = createLyricDocument(result.document);
  document.lines = document.lines.map(({ tlyric: _embeddedTranslation, ...line }) => line);
  if (!document.lines.length || !document.lines.some(line => /[\p{L}\p{N}]/u.test(line.text))) return null;
  const raw = result.translation || {};
  const state = states.has(raw.state) ? raw.state : 'unavailable';
  const lines = Array.isArray(raw.lines) ? raw.lines : [];
  if (state === 'ready' && raw.supported !== true) throw new TypeError('Ready translation must declare support');
  if (state === 'ready' && (lines.length !== document.lines.length || !lines.some(line => typeof line === 'string' && line.trim())
    || lines.some(line => typeof line !== 'string' || line.length > 4000 || /[\r\n]/u.test(line)))) throw new TypeError('Invalid paired lyric translation');
  const selected = state === 'ready' ? projectLyricTranslation(document, raw, { song,
    targetLanguage: raw.targetLanguage || null }) : null;
  if (state === 'ready' && !selected) {
    const needed = shouldAiCompleteLyrics(document, song, { targetLanguage: raw.targetLanguage || raw.language || 'zh' });
    return { ...result, sourceId, document, translation: { supported: needed && raw.supported === true,
      state: needed ? 'failed' : 'not_needed',
      ...(raw.targetLanguage ? { targetLanguage: raw.targetLanguage } : {}) } };
  }
  const error = raw.error && typeof raw.error.message === 'string' ? {
    code: /^[A-Za-z0-9_]{1,100}$/u.test(raw.error.code || '') ? raw.error.code : 'LYRIC_TRANSLATION_FAILED',
    message: raw.error.message.slice(0, 1000),
  } : undefined;
  return { ...result, sourceId, document, translation: { supported: raw.supported === true,
    state, ...(state === 'ready' ? { lines: selected.lines } : {}),
    ...Object.fromEntries(['language', 'targetLanguage', 'source', 'kind'].filter(key => typeof raw[key] === 'string').map(key => [key, raw[key]])),
    ...(error ? { error } : {}) } };
}
export async function selectLyricSource({ sources, order, song, signal, onDiagnostic = () => {}, adopt = false }) {
  const weak = [];
  let failed = false;
  const adoptResult = async pair => {
    signal?.throwIfAborted();
    if (!adopt || typeof pair.result.onAdopt !== 'function') return pair;
    const beforeHash = await computeHash(lyricTextForHash(pair.result.document.lines));
    const result = normalizeLyricSourceResult(await pair.result.onAdopt(), pair.source.id, song);
    signal?.throwIfAborted();
    if (!result || await computeHash(lyricTextForHash(result.document.lines)) !== beforeHash) pluginFail('LYRIC_RESULT_CHANGED', 409);
    return { source: pair.source, result };
  };
  for (const id of order) {
    signal?.throwIfAborted();
    const source = sources.find(item => item.id === id);
    if (!source) continue;
    try {
      if (!await source.claim(song)) continue;
      const result = normalizeLyricSourceResult(await boundedResolve(source, song, { signal }), id, song);
      if (!result) continue;
      if (result.quality === 'good') return await adoptResult({ source, result });
      weak.push({ source, result });
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code === 'LYRIC_SONG_DELETED') throw error;
      failed = true;
      // No upstream error text, credentials or lyric content enters diagnostics.
      onDiagnostic({ sourceId: id, code: /^[A-Z0-9_]{1,100}$/u.test(error?.code || '') ? error.code : 'LYRIC_SOURCE_FAILED' });
    }
  }
  for (const pair of weak) {
    try { return await adoptResult(pair); }
    catch (error) { signal?.throwIfAborted(); if (error?.code === 'LYRIC_SONG_DELETED') throw error;
      failed = true;
      onDiagnostic({ sourceId: pair.source.id, code: 'LYRIC_SOURCE_ADOPTION_FAILED' }); }
  }
  if (failed) throw new LyricSourceError('upstream', 'chain', 'resolve', 'Lyric sources temporarily unavailable');
  return null;
}

export function fileLyricSource(store) {
  return { id: 'file', name: 'File', epoch: 'builtin', build: 'builtin', assertCurrent: async () => {},
    claim: () => true, async resolve(song) {
      const read = await store.get(song.id);
      if (read.state === 'legacy') {
        const legacy = JSON.parse(read.legacyText);
        if (!legacy.success) return null;
        const data = legacy.data;
        const document = data.type === 'synced'
          ? parseLrcDocument(data.lyrics, { source: 'manual' })
          : createLyricDocument({ source: 'manual', format: 'plain', lines: data.lyrics.split(/\r?\n/u).filter(Boolean).map(text => ({ text })) });
        const original = document.lines;
        const translated = data.translated_lyrics ? (data.type === 'synced'
          ? parseLrcDocument(data.translated_lyrics, { source: 'manual' }).lines
          : data.translated_lyrics.split(/\r?\n/u).filter(Boolean).map(text => ({ text }))) : [];
        const paired = translated.length === original.length && translated.every((line, i) => line.time === original[i].time);
        return { quality: 'good', document, provenance: { evaluation: 'unassessed', originalSource: data.source },
          translation: paired ? { supported: true, state: 'ready', lines: translated.map(line => line.text), source: 'manual', kind: 'unknown' }
            : { supported: false, state: 'unavailable' } };
      }
      if (read.artifact?.status !== 'ready') return null;
      const artifact = read.artifact;
      const projected = projectLyricArtifact(artifact, { song });
      return { quality: artifact.provenance?.quality || 'good', document: createLyricDocument(artifact.original),
        artifact, etag: read.etag, provenance: artifact.provenance,
        translation: { supported: Boolean(projected.translation), state: projected.translation ? 'ready' : 'unavailable',
          ...(projected.translation || {}), ...(projected.translation ? { lines: projected.translation.lines } : {}) } };
    } };
}
export async function createLyricSources({ env, db = env.DB, session, executionContext, deps = {}, enumerate = false, requestIdentity }) {
  const registry = deps.registry || pluginRegistry;
  const modules = deps.modules || deliveryPluginModules;
  const baseStore = deps.store || lyricArtifactStoreForEnv(env);
  const sources = [];
  const { fetchNativeDocument: _nativeCallback, ...sourceDependencies } = deps;
  for (const [id, module] of Object.entries(modules)) {
    if (typeof module.createLyricSource !== 'function') continue;
    let active, initialization;
    const scope = { signal: null };
    const initialize = () => initialization ||= (async () => {
      try {
      const baseContext = deps.subsonicPrincipal
        ? await protocolSourceContext(env, deps.subsonicPrincipal, id, registry)
        : await (deps.createContext || createSourceContext)({ env, session, pluginId: id, registry, requestIdentity });
      const context = { ...baseContext, locale: localeOf(deps.locale) };
      const assertCurrent = async () => { scope.signal?.throwIfAborted(); await context.assertCurrent(); scope.signal?.throwIfAborted(); };
      const guarded = guardStoreAuthority(baseStore, assertCurrent);
      // Shared lyric reads are authorized at entry and before publishing the
      // response. Keep fresh per-write gates without repeating D1 session and
      // installation queries around every read in one candidate evaluation.
      const store = { ...guarded, get: (...args) => baseStore.get(...args),
        ...(baseStore.singleflight ? { singleflight: (...args) => baseStore.singleflight(...args) } : {}) };
      const serviceAuthorities = new Set(), registeredServiceLeases = new Set(), serviceStores = new Map();
      const registerServiceAuthority = lease => {
        const authentic = deps.subsonicPrincipal
          ? isSubsonicPluginServiceLeaseForPrincipal(lease, deps.subsonicPrincipal, env, registry)
          : isPluginServiceLeaseForSession(lease, session, env.DB, registry);
        if (!authentic || lease.consumer.id !== id || lease.consumer.epoch !== context.plugin.epoch
          || lease.identity.accountId !== context.identity.accountId) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
        serviceAuthorities.add(lease.assertCurrent);
        registeredServiceLeases.add(lease);
      };
      // A genuine service lease already pins this source epoch plus all
      // provider epochs. Compose that stronger live gate once, retaining the
      // source cancellation scope at the actual storage boundary.
      Object.defineProperty(store, storeAuthorityGuard, { value: assertion => {
        const ownedConfigurationGate = [...registeredServiceLeases]
          .some(lease => isServiceConfigurationAssertionForLease(assertion, lease));
        if (!serviceAuthorities.has(assertion) && !ownedConfigurationGate) return guardStoreAuthority(guarded, assertion);
        if (serviceStores.has(assertion)) return serviceStores.get(assertion);
        const check = async () => { scope.signal?.throwIfAborted(); await assertion(); scope.signal?.throwIfAborted(); };
        const composed = { ...guardStoreAuthority(baseStore, check) };
        Object.defineProperty(composed, storeAuthorityGuard, { value: next => next === assertion ? composed
          : guardStoreAuthority(guardStoreAuthority(baseStore, check), next) });
        serviceStores.set(assertion, composed); return composed;
      } });
      const source = await module.createLyricSource({ env, db, session, executionContext, context,
        dependencies: { ...sourceDependencies, store, assertCurrent, registerServiceAuthority, assertReadScope: () => scope.signal?.throwIfAborted(),
          // A source may evaluate library and external songs. Provider callbacks
          // only own their virtual IDs; library existence stays with the host.
          resolveSong: songId => resolveLyricSong(db, songId, deps),
          songStillExists: songId => lyricSongStillExists(db, songId, deps), subsonicPrincipal: deps.subsonicPrincipal } });
      if (!source || source.id !== id || typeof source.claim !== 'function' || typeof source.resolve !== 'function') throw new TypeError('Invalid lyric source');
      if (source.enabled === false || typeof source.isEnabled === 'function' && !await source.isEnabled()) return null;
      active = { ...source, epoch: context.plugin.epoch, build: registry.getBuildDigest(id), assertCurrent };
      return active;
    } catch (error) {
      if (!['PLUGIN_NOT_INSTALLED', 'PLUGIN_UNAVAILABLE', 'PLUGIN_NOT_FOUND', 'forbidden', 'PLUGIN_BUILD_MISMATCH'].includes(error?.code)) {
        deps.onDiagnostic?.({ sourceId: id, code: 'LYRIC_SOURCE_UNAVAILABLE' });
        throw new LyricSourceError('upstream', id, 'initialize', 'Lyric source temporarily unavailable');
      }
      return null;
      }
    })();
    // Initialize only sources reached by the configured chain. Unselected
    // plugins perform no reads or authorization queries in this invocation.
    // Initialization still authorizes installation/roles before package code.
    const lazy = { id, initialize,
      get epoch() { return active?.epoch; }, get build() { return active?.build; },
      get name() { return active?.name; }, get timeoutMs() { return active?.timeoutMs; },
      async claim(song) { const source = await initialize(); return source ? source.claim(song) : false; },
      async resolve(song, options) { scope.signal = options.signal; const source = await initialize(); return source ? source.resolve(song, options) : null; },
      async translate(ref, options) { scope.signal = options.signal; const source = await initialize();
        if (!source?.translate) pluginFail('LYRIC_RESULT_RETIRED', 409);
        return source.translate(ref, options); },
      async assertCurrent() { const source = await initialize();
        if (!source) pluginFail('LYRIC_RESULT_RETIRED', 409); await source.assertCurrent(); },
    };
    if (!enumerate || await initialize()) sources.push(lazy);
  }
  sources.push(fileLyricSource(baseStore));
  return sources;
}
async function createSourceContext({ env, session, pluginId, registry, requestIdentity }) {
  const lease = await createPluginOperationLease({ env, session, pluginId, registry, requestIdentity });
  return { ...lease, requireRoles: async roles => {
    const identity = await lease.assertCurrent(); if (!roles.includes(identity.role)) pluginFail('forbidden', 403);
    return identity;
  } };
}

async function assertProtocol(env, principal) {
  const authority = subsonicAuthorityForPrincipal(principal, env);
  const row = await env.DB.prepare(`SELECT 1 AS allowed WHERE ${authority.predicate}`).bind(...authority.bindings()).first();
  if (!row) pluginFail('PLUGIN_SERVICE_RETIRED', 409);
  return authority.identity;
}
async function protocolSourceContext(env, principal, id, registry) {
  const authority = subsonicAuthorityForPrincipal(principal, env);
  const identity = authority.identity;
  if (!isPluginVisibleToRole(registry.manifests.find(manifest => manifest.id === id), identity.role)) pluginFail('forbidden', 403);
  const installations = await registry.requirePluginsInstalled(env, [id]);
  const epochPredicate = [...installations].map(() => `EXISTS(SELECT 1 FROM instance_settings WHERE key=?
    AND json_extract(value_json,'$.installed')=1 AND json_extract(value_json,'$.epoch')=?)`).join(' AND ');
  const epochs = [...installations].flatMap(([pluginId, installed]) => [installationKey(pluginId), installed.epoch]);
  const assertCurrent = async () => {
    subsonicAuthorityForPrincipal(principal, env);
    const row = await env.DB.prepare(`SELECT 1 AS allowed WHERE ${authority.predicate} AND ${epochPredicate}`)
      .bind(...authority.bindings(), ...epochs).first();
    if (!row) pluginFail('PLUGIN_SERVICE_RETIRED', 409);
    return identity;
  };
  await assertCurrent();
  return { identity, plugin: { id, epoch: installations.get(id).epoch }, assertCurrent };
}

async function signingKey(env) {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) pluginFail('LYRIC_RESULT_UNAVAILABLE', 503);
  return crypto.subtle.importKey('raw', encoder.encode('FlareTune lyric result v1:' + env.SETUP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function issueLyricResultRef(env, value) {
  const inspect = object => {
    if (!object || typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      if (/token|secret|cookie|authorization|tracking|continuation/iu.test(key)) pluginFail('LYRIC_RESULT_INVALID', 502);
      if (item && typeof item === 'object') inspect(item);
    }
  };
  inspect(value.sourceRef);
  const payload = encode(encoder.encode(JSON.stringify(value)));
  if (payload.length > 8192) pluginFail('LYRIC_RESULT_INVALID', 502);
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload));
  return payload + '.' + encode(new Uint8Array(signature));
}
export async function verifyLyricResultRef(env, ref, identity, now = Date.now()) {
  if (typeof ref !== 'string' || ref.length > 8500 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(ref)) pluginFail('LYRIC_RESULT_INVALID', 400);
  const [payload, signature] = ref.split('.');
  try {
    if (!await crypto.subtle.verify('HMAC', await signingKey(env), decode(signature), encoder.encode(payload))) pluginFail('LYRIC_RESULT_INVALID', 400);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(payload)));
    if (value.accountId !== identity.accountId || value.sessionHash !== identity.sessionHash || !validId(value.sourceId)
      || !/^[a-f0-9]{64}$/u.test(value.textHash || '') || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < now) pluginFail('LYRIC_RESULT_RETIRED', 409);
    return value;
  } catch (error) {
    if (error?.code) throw error;
    pluginFail('LYRIC_RESULT_INVALID', 400);
  }
}
export async function persistAdoptedLyricResult({ store, song, source, result, signal }) {
  if (source.id === 'file') return;
  signal?.throwIfAborted();
  // A source's adoption hook returns the artifact/ETag from its guarded CAS.
  // Re-reading and re-writing that same result would duplicate both storage
  // work and live authorization queries while its AI task is settling.
  if (result.artifact?.status === 'ready' && result.artifact.songId === song.id && result.etag
    && result.artifact.textHash === await computeHash(lyricTextForHash(result.document.lines))) return;
  await source.assertCurrent();
  const previous = await store.get(song.id);
  // A known legacy payload is still a nonempty file. Only an explicit
  // workbench evaluation may migrate it; generic adoption cannot infer owner.
  if (previous.state === 'legacy') return;
  const current = previous.artifact;
  const protectedFile = current?.status === 'ready' && (current.provenance?.evaluation === 'manual'
    || current.original?.source === 'manual' || current.provenance?.evaluation === 'assessed');
  const owner = current?.provenance?.managedBy;
  const incomingHash = await computeHash(lyricTextForHash(result.document.lines));
  if (current?.status === 'ready' && ((!owner || owner !== source.id)
    || protectedFile && current.textHash !== incomingHash)) return;
  if (result.artifact && current?.textHash === result.artifact.textHash) return;
  const built = await buildReadyLyricArtifact(song, result.document);
  const artifact = { ...built.artifact, provenance: { ...built.artifact.provenance, ...result.provenance,
    managedBy: source.id, evaluation: source.id === 'lyrics-workbench' ? 'assessed' : 'unassessed',
    originalSource: result.provenance?.originalSource || result.document.source, quality: result.quality } };
  if (result.translation.state === 'ready') artifact.translation = { source: result.translation.source || result.document.source,
    originalTextHash: artifact.textHash, lines: result.translation.lines,
    ...(result.translation.language ? { language: result.translation.language } : {}),
    ...(result.translation.kind ? { kind: result.translation.kind } : {}), updatedAt: artifact.updatedAt };
  await source.assertCurrent(); signal?.throwIfAborted();
  if (previous.state === 'absent' || !current && previous.state !== 'legacy') await store.createIfAbsent(song.id, artifact, { signal });
  else if (['legacy', 'found'].includes(previous.state)) await store.putIfMatch(song.id, artifact, previous.etag, { signal });
}
function responseFor(result, ref) {
  const offsetMs = result.artifact?.offsetMs ?? result.offsetMs ?? 0;
  const document = applyLyricOffset(result.document, offsetMs);
  const translation = result.translation;
  return { ...document, lrc: document.lrc || projectCanonicalLrc(document.lines),
    sourceId: result.sourceId, resultRef: ref, quality: result.quality,
    translation, translationAvailable: translation.state === 'ready', translationState: translation.state,
    translationStartedAt: translation.state === 'pending' ? result.artifact?.aiCompletion?.updatedAt || result.translationStartedAt || new Date().toISOString() : null,
    provenance: result.provenance || {}, updatedAt: result.artifact?.updatedAt || result.updatedAt, offsetMs };
}
const documentDigest = result => computeHash(JSON.stringify({ source: result.document.source, format: result.document.format,
  syncMode: result.document.syncMode, lines: result.document.lines, offsetMs: result.artifact?.offsetMs ?? result.offsetMs ?? 0 }));
export async function readLyricsFromChain({ env, db = env.DB, session, song, executionContext, signal, resultRef, translate = false, deps = {} }) {
  const protocol = deps.subsonicPrincipal;
  const assertRequest = protocol ? () => assertProtocol(env, protocol) : () => (deps.requireSession || requirePluginSession)(env, session);
  const authority = await assertRequest();
  if (!protocol && (!session?.account?.accountId || !session?.tokenHash)) pluginFail('forbidden', 403);
  const identity = protocol ? { accountId: authority.accountId, sessionHash: 'protocol' }
    : { accountId: session.account.accountId, sessionHash: await computeHash(session.tokenHash) };
  if (protocol && (resultRef || translate)) pluginFail('forbidden', 403);
  if (song.language === 'instrumental') return { state: 'not_needed', artifact: null, lyrics: {
    version: 2, status: 'not_needed', reason: 'instrumental', source: null, format: null, syncMode: 'none',
    lines: [], translation: { supported: false, state: 'not_needed' }, translationAvailable: false, translationState: 'not_needed' } };
  const onDiagnostic = deps.onDiagnostic || (record => console.warn('lyric-source', JSON.stringify(record)));
  deps = { ...deps, onDiagnostic };
  const sources = deps.sources || await createLyricSources({ env, db, session, executionContext, deps, requestIdentity: authority });
  let chosen;
  let oldRef;
  if (resultRef) {
    oldRef = await verifyLyricResultRef(env, resultRef, identity);
    if (oldRef.songId !== song.id) pluginFail('LYRIC_RESULT_INVALID', 400);
    const source = sources.find(item => item.id === oldRef.sourceId);
    await source?.initialize?.();
    if (!source || source.epoch !== oldRef.epoch || source.build !== oldRef.build) pluginFail('LYRIC_RESULT_RETIRED', 409);
    let result = normalizeLyricSourceResult(await boundedResolve(source, song, { signal, resultRef: oldRef }), source.id, song);
    const validateResult = async candidate => {
      if (!candidate || await computeHash(lyricTextForHash(candidate.document.lines)) !== oldRef.textHash
        || await documentDigest(candidate) !== oldRef.documentHash
        || (candidate.translation.targetLanguage || null) !== oldRef.translationTarget) pluginFail('LYRIC_RESULT_CHANGED', 409);
    };
    await validateResult(result);
    if (translate && typeof source.translate === 'function' && !['ready', 'not_needed'].includes(result.translation.state)) {
      result = normalizeLyricSourceResult(await source.translate(oldRef, { signal, song }), source.id, song);
      await validateResult(result);
    }
    chosen = { source, result };
  } else {
    if (translate) pluginFail('LYRIC_RESULT_INVALID', 400);
    const saved = await loadLyricSourceOrder(db, sources.map(source => source.id));
    try { chosen = await selectLyricSource({ sources, order: saved.order, song, signal, onDiagnostic: deps.onDiagnostic, adopt: true }); }
    catch (error) { if (error?.code === 'LYRIC_SONG_DELETED') return { state: 'song_deleted', artifact: null, lyrics: null }; throw error; }
  }
  if (!chosen) return { state: 'not_found', artifact: null, lyrics: null };
  const { source } = chosen;
  const { result } = chosen;
  signal?.throwIfAborted();
  const textHash = await computeHash(lyricTextForHash(result.document.lines));
  const store = deps.store || lyricArtifactStoreForEnv(env);
  await persistAdoptedLyricResult({ store: guardStoreAuthority(store, source.assertCurrent), song, source, result, signal });
  const ref = protocol ? null : await issueLyricResultRef(env, { sourceId: source.id, songId: song.id, textHash,
    documentHash: await documentDigest(result), translationTarget: result.translation.targetLanguage || null,
    epoch: source.epoch, build: source.build, ...identity, expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    ...(result.sourceRef ? { sourceRef: result.sourceRef } : {}) });
  let artifact = result.artifact;
  if (!artifact) {
    artifact = (await buildReadyLyricArtifact(song, result.document)).artifact;
    if (result.translation.state === 'ready') artifact.translation = { source: result.translation.source || result.document.source,
      originalTextHash: textHash, lines: result.translation.lines, updatedAt: artifact.updatedAt,
      ...(result.translation.language ? { language: result.translation.language } : {}), ...(result.translation.kind ? { kind: result.translation.kind } : {}) };
  }
  if (source.id === 'file') await assertRequest(); else await source.assertCurrent();
  return { state: 'found', artifact, lyrics: responseFor(result, ref) };
}

export async function lyricSourceOrderSettings({ env, db = env.DB, session, executionContext, deps = {}, update }) {
  const identity = await (deps.requireSession || requirePluginSession)(env, session, Boolean(update));
  const sources = deps.sources || await createLyricSources({ env, db, session, executionContext, deps, enumerate: true, requestIdentity: identity });
  const ids = sources.map(source => source.id);
  if (update) {
    const order = validateLyricSourceOrder(update.order);
    if (order.length !== ids.length || order.some(id => !ids.includes(id))) pluginFail('invalid_input', 400);
    await updateDefinedSetting(db, identity.accountId, LYRIC_ORDER_KEY, order, update.expectedRevision,
      { validate: validateLyricSourceOrder });
  }
  const manifests = (deps.registry || pluginRegistry).manifests;
  const fileNames = { zh: '歌词文件', 'zh-Hant': '歌詞檔案', en: 'Lyric files', ja: '歌詞ファイル', ko: '가사 파일' };
  return { ...await loadLyricSourceOrder(db, ids), sources: sources.map(source => {
    const manifest = manifests.find(item => item.id === source.id);
    return { id: source.id, name: source.name || manifest?.name || (source.id === 'file' ? fileNames[localeOf(deps.locale)] : source.id),
      metadata: source.id === 'file' ? Object.fromEntries(Object.entries(fileNames).map(([lang, name]) => [lang, { name }])) : manifest?.metadata,
      enabled: true };
  }) };
}
