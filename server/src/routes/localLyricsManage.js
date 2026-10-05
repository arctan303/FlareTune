import {
  fetchLyricsDocumentWithFallback,
  fetchUncachedSourceLyricsDocument,
  createSourceCandidateInspectionSnapshot,
  listSourceLyricCandidates,
  LyricSourceError,
} from '../services/lyricSourceLoader.js';
import { applyLyricOffset, listLyricsResolutionCandidates } from '../services/lyricResolution.js';
import { createLyricDocument, parseLrcDocument } from '../utils/lyricDocument.js';
import {
  buildLyricArtifactMarker,
  LyricArtifactStoreError,
  normalizeLyricArtifactSongId,
  validateLyricArtifact,
} from '../services/lyricArtifactStore.js';
import {
  buildEditedLyricArtifact,
  buildReadyLyricArtifact,
  lyricArtifactStoreForEnv,
  projectLyricArtifact,
} from '../services/lyricAssetWorkflow.js';
import { beginLyricAssetAiCompletion, resolveLegacyLyricCleanup } from '../services/lyricAssetTranslation.js';
import { completeLyricDraft } from '../services/lyricDraftAi.js';
import { verifyLyricDraftReceipt } from '../services/lyricDraftReceipt.js';
import { loadLyricAiProcessingSettings } from '../services/lyricAiConfig.js';
import {
  inspectLyricCandidates,
  LYRIC_CANDIDATE_INSPECTION_LIMITS,
  LyricCandidateInspectionError,
} from '../services/lyricCandidateInspection.js';
import { readBoundedJson } from '../instance/httpSecurity.js';

// Only the new account-gated workspace path is dispatched here. Origin and CSRF
// are verified by the outer router before any mutation reaches this module.
const BASE = /^\/api\/lyrics\/workspace\/([^/]+)$/u;
const CHILD = /^\/api\/lyrics\/workspace\/([^/]+)\/(candidates(?:\/inspect)?|offset|timeline|document|import|restore|translation|ai-completion|draft-ai)$/u;
const SOURCE = new Set(['auto', 'kugou', 'netease', 'lrclib']);
const encoder = new TextEncoder();

function response(payload, status, headers) {
  return new Response(JSON.stringify(payload), { status, headers: {
    ...headers, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
const success = (data, status, headers) => response({ ok: true, code: status, data }, status, headers);
const failure = (status, error, message, headers, data) => response({
  ok: false, code: status, error, message, ...(data === undefined ? {} : { data }),
}, status, headers);

function parseSongId(encoded) {
  if (encoded.length > 384) return null;
  try { return normalizeLyricArtifactSongId(decodeURIComponent(encoded)); }
  catch { return null; }
}

function exactFields(body, allowed, required = []) {
  return Object.keys(body).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(body, key));
}

async function bodyOf(request, allowed, required = [], maxBytes = 16 * 1024) {
  let body;
  try { body = await readBoundedJson(request, maxBytes); } catch { return null; }
  return exactFields(body, allowed, required) ? body : null;
}

function textOverride(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value.trim();
}

function searchSong(song, title, artist) {
  const searchTitle = textOverride(title);
  const searchArtist = textOverride(artist);
  if (searchTitle === null || searchArtist === null) return null;
  return { ...song, title: searchTitle || song.title, artist: searchArtist || song.artist };
}

const validEtag = (value) => value === null
  || (typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value));

function currentData(read, song, now, targetLanguage = null, viewerAccountId = null) {
  if (read.state === 'missing' || read.state === 'legacy' || read.artifact?.status === 'reset') {
    return { status: 'missing', etag: read.etag ?? null, asset: null, lyrics: null };
  }
  const asset = read.artifact.aiCompletion?.status === 'review'
    && read.artifact.aiCompletion.reviewAccountId !== viewerAccountId
    ? { ...read.artifact, aiCompletion: null } : read.artifact;
  return { status: read.artifact.status, etag: read.etag, asset,
    lyrics: projectLyricArtifact(read.artifact, { song, now, targetLanguage }) };
}

function notDeleting(read) {
  if (read.state === 'found' && read.artifact.status === 'deleting') {
    throw new LyricArtifactStoreError('lyric_asset_deleting', 'get', 'Lyric asset is being deleted');
  }
  return read;
}

function matches(read, expected) {
  return validEtag(expected) && (read.state === 'missing' ? expected === null : read.etag === expected);
}

function safeCandidate(candidate) {
  if (!candidate || !SOURCE.has(candidate.source) || candidate.source === 'auto'
    || typeof candidate.providerLyricId !== 'string' || !candidate.providerLyricId
    || candidate.providerLyricId.length > 256) return null;
  const numeric = (value) => value === null || value === undefined || value === ''
    ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    source: candidate.source,
    providerLyricId: candidate.providerLyricId,
    matchedTitle: String(candidate.matchedTitle || '').slice(0, 1000),
    matchedArtist: String(candidate.matchedArtist || '').slice(0, 1000),
    matchedAlbum: String(candidate.matchedAlbum || '').slice(0, 1000),
    matchedDuration: numeric(candidate.matchedDuration),
    durationDelta: numeric(candidate.durationDelta),
    score: numeric(candidate.score),
    versionMismatch: candidate.versionMismatch === true,
    warnings: Array.isArray(candidate.warnings) ? candidate.warnings.map(String).slice(0, 8) : [],
  };
}

function validEditorLines(lines) {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 2000) return false;
  return lines.every((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)
      || Object.keys(line).some((key) => !['time', 'endTime', 'text', 'tlyric', 'words'].includes(key))
      || typeof line.text !== 'string' || !line.text.trim() || line.text.length > 4000
      || /\r/u.test(line.text)
      || (line.tlyric !== undefined && (typeof line.tlyric !== 'string'
        || line.tlyric.length > 4000 || /[\r\n]/u.test(line.tlyric)))) return false;
    if (line.time !== undefined && (!Number.isFinite(line.time) || line.time < 0 || line.time > 86400)) return false;
    if (line.endTime !== undefined && (!Number.isFinite(line.endTime)
      || line.time === undefined || line.endTime < line.time || line.endTime > 86400)) return false;
    return line.words === undefined || (Array.isArray(line.words) && line.words.length > 0
      && line.words.every((word) => word && typeof word.text === 'string'
        && Number.isFinite(word.startTime) && Number.isFinite(word.endTime)));
  });
}

function boundedInspection(inspected, headers) {
  const limit = LYRIC_CANDIDATE_INSPECTION_LIMITS.maxResponseBytes;
  const source = Array.isArray(inspected?.items) ? inspected.items : [];
  const items = source.slice(0, LYRIC_CANDIDATE_INSPECTION_LIMITS.maxCandidates);
  const compact = (item) => ({ source: String(item?.source || 'unknown').slice(0, 32),
    providerLyricId: String(item?.providerLyricId || 'unknown').slice(0, 256),
    state: 'error', error: { code: 'response_too_large' } });
  const results = items.map(compact);
  let truncated = Boolean(inspected?.truncated) || source.length > items.length;
  for (let index = 0; index < items.length; index += 1) {
    const fallback = results[index];
    results[index] = items[index];
    const candidate = { ok: true, code: 200, data: { results, truncated: true } };
    if (encoder.encode(JSON.stringify(candidate)).byteLength > limit) {
      results[index] = fallback;
      truncated = true;
    }
  }
  const data = { results, truncated };
  if (encoder.encode(JSON.stringify({ ok: true, code: 200, data })).byteLength > limit) {
    return failure(503, 'LYRIC_INSPECTION_UNAVAILABLE', 'Candidate inspection unavailable', headers);
  }
  return success(data, 200, headers);
}

function knownFailure(error, headers) {
  if (error?.message === 'AI_ASSISTANT_CONFIG_UNAVAILABLE') {
    return failure(503, 'LYRIC_AI_CONFIG_UNAVAILABLE', 'Lyric AI settings unavailable', headers);
  }
  if (error instanceof LyricArtifactStoreError) {
    const invalid = error.code === 'invalid_stored_artifact';
    return failure(invalid ? 502 : 503, invalid ? 'INVALID_LYRIC_ASSET' : 'LYRIC_STORAGE_UNAVAILABLE',
      invalid ? 'Stored lyric asset is invalid' : 'Lyric storage unavailable', headers);
  }
  if (error instanceof LyricSourceError) {
    const invalid = error.kind === 'invalid' || error.kind === 'not_found';
    return failure(invalid ? 422 : 503, invalid ? 'LYRIC_CANDIDATE_INVALID' : 'LYRIC_SOURCE_UNAVAILABLE',
      invalid ? 'Lyric candidate is unavailable' : 'Lyric source unavailable', headers);
  }
  if (error instanceof LyricCandidateInspectionError) {
    const invalid = ['duplicate_candidate', 'invalid_candidate', 'invalid_candidates', 'too_many_candidates'].includes(error.code);
    return failure(invalid ? 400 : 503, invalid ? 'INVALID_LYRIC_CANDIDATES' : 'LYRIC_INSPECTION_UNAVAILABLE',
      invalid ? 'Invalid lyric candidates' : 'Candidate inspection unavailable', headers);
  }
  return null;
}

async function songOf(db, songId) {
  return db.prepare('SELECT id, title, artist, album, duration, language FROM Songs WHERE id = ?')
    .bind(songId).first();
}

async function writeCurrent(store, songId, artifact, current, etag) {
  if (current.state === 'missing') return store.createIfAbsent(songId, artifact);
  return store.putIfMatch(songId, artifact, etag);
}

function schedule(task, ctx) {
  const guarded = Promise.resolve(task).catch(() => {});
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(guarded);
}

export async function handleLocalLyricsManageRoute(request, url, db, headers = {}, session, env = {}, deps = {}) {
  const base = url.pathname.match(BASE);
  const child = url.pathname.match(CHILD);
  if (!base && !child) return null;
  const accountId = session?.account?.accountId;
  if (!accountId || session?.mode !== 'normal'
    || !['admin', 'member'].includes(session?.account?.role)) {
    return failure(401, 'UNAUTHORIZED', 'Normal local session required', headers);
  }
  if (!db?.prepare) return failure(503, 'DATABASE_UNAVAILABLE', 'Database unavailable', headers);
  const songId = parseSongId((base || child)[1]);
  if (!songId) return failure(400, 'INVALID_SONG_ID', 'Invalid song ID', headers);
  if (url.searchParams.has('account_id') || url.searchParams.has('user_sub')) {
    return failure(400, 'INVALID_QUERY', 'Account identity is not accepted', headers);
  }
  const song = await songOf(db, songId);
  if (!song) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
  const action = child?.[2] || 'asset';
  const method = request.method;
  const recognized = {
    asset: ['GET', 'PUT', 'DELETE'], candidates: ['GET'], 'candidates/inspect': ['POST'],
    offset: ['PATCH'], timeline: ['PATCH'], document: ['PUT'], import: ['POST'], restore: ['POST'],
    translation: ['DELETE'], 'ai-completion': ['POST'], 'draft-ai': ['POST'],
  }[action];
  if (!recognized.includes(method)) return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { ...headers, Allow: recognized.join(', ') });
  if (method !== 'GET' && action !== 'candidates/inspect' && action !== 'ai-completion'
    && session.account.role !== 'admin') {
    return failure(403, 'FORBIDDEN', 'Administrator role required for shared lyric changes', headers);
  }
  if (song.language === 'instrumental') {
    if (action === 'asset' && method === 'GET') return success({ song, status: 'not_needed', etag: null, asset: null, lyrics: null }, 200, headers);
    if (action === 'candidates') return success({ status: 'not_needed', candidates: [], warnings: [] }, 200, headers);
    if (action === 'candidates/inspect') return success({ status: 'not_needed', results: [], truncated: false }, 200, headers);
    return failure(422, 'LYRICS_NOT_NEEDED', 'Instrumental songs do not need lyrics', headers);
  }
  let store;
  try { store = deps.store || lyricArtifactStoreForEnv(env); }
  catch (error) { return knownFailure(error, headers) || failure(503, 'LYRIC_STORAGE_UNAVAILABLE', 'Lyric storage unavailable', headers); }
  const now = deps.now || Date.now;
  try {
    const { targetLanguage, completionEnabled } = await loadLyricAiProcessingSettings(db);
    const dataOf = (read) => currentData(read, song, now(), targetLanguage, session.account.accountId);
    if (action === 'asset' && method === 'GET') {
      if ([...url.searchParams.keys()].length) return failure(400, 'INVALID_QUERY', 'Unexpected query', headers);
      const read = notDeleting(await store.get(songId));
      return success({ song, aiCompletionEnabled: completionEnabled,
        ...dataOf(await resolveLegacyLyricCleanup(store, song, read, now)) }, 200, headers);
    }
    if (!completionEnabled && ['ai-completion', 'draft-ai'].includes(action)) {
      return failure(403, 'LYRIC_AI_DISABLED', 'Lyric AI completion is disabled', headers);
    }
    if (action === 'candidates') {
      if ([...url.searchParams.keys()].some((key) => !['title', 'artist', 'source'].includes(key))) {
        return failure(400, 'INVALID_QUERY', 'Unexpected query', headers);
      }
      const target = searchSong(song, url.searchParams.get('title') ?? undefined, url.searchParams.get('artist') ?? undefined);
      if (!target) return failure(400, 'INVALID_QUERY', 'Invalid search override', headers);
      const source = url.searchParams.get('source') || 'all';
      if (source !== 'all' && (!SOURCE.has(source) || source === 'auto')) {
        return failure(400, 'INVALID_QUERY', 'Invalid lyric source filter', headers);
      }
      const found = await (deps.listCandidates || listLyricsResolutionCandidates)(target, {
        source, signal: request.signal, listCandidates: deps.listSourceCandidates || listSourceLyricCandidates,
      });
      return success({ candidates: (found.candidates || []).map(safeCandidate).filter(Boolean),
        warnings: found.warnings || [] }, 200, headers);
    }
    if (action === 'candidates/inspect') {
      const body = await bodyOf(request, ['candidates', 'searchTitle', 'searchArtist'], ['candidates']);
      if (!body) return failure(400, 'INVALID_LYRIC_CANDIDATES', 'Invalid request body', headers);
      const target = searchSong(song, body.searchTitle, body.searchArtist);
      if (!target) return failure(400, 'INVALID_LYRIC_CANDIDATES', 'Invalid search override', headers);
      const emptyEnvelope = encoder.encode(JSON.stringify({ ok: true, code: 200, data: { results: [], truncated: false } })).byteLength;
      const inspected = await (deps.inspectCandidates || inspectLyricCandidates)(target, body.candidates, {
        signal: request.signal,
        createProviderSnapshot: deps.createProviderSnapshot || createSourceCandidateInspectionSnapshot,
        maxResponseBytes: LYRIC_CANDIDATE_INSPECTION_LIMITS.maxResponseBytes - emptyEnvelope,
      });
      return boundedInspection(inspected, headers);
    }
    if (action === 'asset' && method === 'PUT') {
      const body = await bodyOf(request, ['source', 'providerLyricId', 'etag', 'searchTitle', 'searchArtist'], ['etag']);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_LYRIC_UPDATE', 'Invalid request body', headers);
      const source = body.source || 'auto';
      const providerLyricId = body.providerLyricId ?? null;
      if (!SOURCE.has(source) || (providerLyricId !== null && (source === 'auto'
        || typeof providerLyricId !== 'string' || !providerLyricId.trim()
        || providerLyricId.length > 256))) {
        return failure(400, 'INVALID_LYRIC_UPDATE', 'Invalid lyric source', headers);
      }
      const target = searchSong(song, body.searchTitle, body.searchArtist);
      if (!target) return failure(400, 'INVALID_LYRIC_UPDATE', 'Invalid search override', headers);
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      let document;
      try {
        document = await fetchLyricsDocumentWithFallback(source, target,
          deps.fetchDocument || fetchUncachedSourceLyricsDocument,
          { signal: request.signal, ...(providerLyricId ? { providerLyricId } : {}) });
      } catch (error) {
        if (providerLyricId && error instanceof LyricSourceError && error.kind !== 'aborted') {
          return failure(422, 'LYRIC_CANDIDATE_INVALID', 'Selected lyric candidate is unavailable', headers);
        }
        throw error;
      }
      if (!document) return failure(422, 'LYRIC_CANDIDATE_INVALID', 'No usable lyric candidate', headers);
      const built = await buildReadyLyricArtifact(song, document, {
        offsetMs: current.artifact?.status === 'ready' ? current.artifact.offsetMs : 0, now: now(),
      });
      if (!await songOf(db, songId)) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
      const written = await writeCurrent(store, songId, built.artifact, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'import') {
      const body = await bodyOf(request, ['lrc', 'etag'], ['lrc', 'etag'], 2 * 1024 * 1024);
      if (!body || !validEtag(body.etag) || typeof body.lrc !== 'string') {
        return failure(400, 'INVALID_LYRIC_IMPORT', 'Invalid LRC import', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      let artifact;
      try {
        const document = parseLrcDocument(body.lrc, { source: 'manual', format: 'lrc' });
        if (!document.lines.length) throw new RangeError('empty lyrics');
        artifact = (await buildReadyLyricArtifact(song, document, { now: now(), targetLanguage })).artifact;
      } catch {
        return failure(422, 'INVALID_LYRIC_IMPORT', 'LRC has no usable lyrics or exceeds limits', headers);
      }
      const written = await writeCurrent(store, songId, artifact, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'restore') {
      const body = await bodyOf(request, ['asset', 'etag'], ['asset', 'etag'], 4 * 1024 * 1024);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_LYRIC_RESTORE', 'Invalid backup', headers);
      const validated = validateLyricArtifact(body.asset, { expectedSongId: songId });
      if (!validated.valid || validated.artifact.status !== 'ready') {
        return failure(422, 'INVALID_LYRIC_RESTORE', 'Backup is not a valid lyric asset for this song', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const restored = { ...validated.artifact, aiCompletion: null, updatedAt: new Date(now()).toISOString() };
      const written = await writeCurrent(store, songId, restored, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'document') {
      const body = await bodyOf(request, ['lines', 'etag', 'aiReceipt'], ['lines', 'etag'], 2 * 1024 * 1024);
      if (!body || !validEtag(body.etag) || !validEditorLines(body.lines)) {
        return failure(400, 'INVALID_LYRIC_DOCUMENT', 'Invalid lyric document', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!['missing', 'found'].includes(current.state)) {
        return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      }
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      let artifact;
      try {
        artifact = await buildEditedLyricArtifact(song, body.lines, { now: now(), targetLanguage });
        const submittedWords = body.lines.reduce((sum, line) => sum + (line.words?.length || 0), 0);
        const savedWords = artifact.original.lines.reduce((sum, line) => sum + (line.words?.length || 0), 0);
        if (submittedWords !== savedWords) throw new RangeError('word timeline invalid');
      } catch {
        return failure(422, 'INVALID_LYRIC_DOCUMENT', 'Lyric lines are invalid', headers);
      }
      const inferredLanguage = body.aiReceipt === undefined ? null
        : await verifyLyricDraftReceipt(env, body.aiReceipt, {
          songId, accountId: session.account.accountId, etag: body.etag,
          textHash: artifact.textHash, now: now(),
        });
      if (body.aiReceipt !== undefined && !inferredLanguage) {
        return failure(400, 'INVALID_LYRIC_DRAFT_RECEIPT', 'Draft AI result is no longer valid', headers);
      }
      const written = await writeCurrent(store, songId, artifact, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      let languageUpdateFailed = false;
      if (inferredLanguage && inferredLanguage !== song.language) {
        try {
          const updated = await db.prepare('UPDATE Songs SET language = ? WHERE id = ? AND language IS ?')
            .bind(inferredLanguage, songId, song.language ?? null).run();
          if (updated?.meta?.changes === 0 || updated?.changes === 0) {
            const latest = await db.prepare('SELECT language FROM Songs WHERE id = ?').bind(songId).first();
            languageUpdateFailed = latest?.language !== inferredLanguage;
          }
        } catch {
          languageUpdateFailed = true;
        }
      }
      return success({ ...dataOf({ ...written, state: 'found' }), languageUpdateFailed }, 200, headers);
    }
    if (action === 'draft-ai') {
      const body = await bodyOf(request, ['lines', 'etag'], ['lines', 'etag'], 2 * 1024 * 1024);
      if (!body || !validEtag(body.etag) || !validEditorLines(body.lines)) {
        return failure(400, 'INVALID_LYRIC_DRAFT', 'Invalid lyric draft', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) {
        return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      }
      let result;
      try {
        result = await (deps.completeDraft || completeLyricDraft)({
          env, db, song, lines: body.lines, etag: body.etag,
          actorAccountId: session.account.accountId,
          deps: deps.aiDeps || {},
        });
      } catch (error) {
        return knownFailure(error, headers)
          || failure(error instanceof RangeError || error instanceof TypeError ? 422 : 503,
            error instanceof RangeError || error instanceof TypeError
              ? 'INVALID_LYRIC_DRAFT' : 'LYRIC_AI_FAILED',
            error instanceof RangeError || error instanceof TypeError
              ? 'Lyric draft cannot be processed' : 'AI completion failed', headers);
      }
      if (result.status !== 'ready') {
        return failure(503, 'LYRIC_AI_FAILED', result.errorCode || 'AI completion failed', headers);
      }
      return success(result, 200, headers);
    }
    if (action === 'timeline') {
      const body = await bodyOf(request, ['deltaMs', 'etag'], ['deltaMs', 'etag']);
      if (!body || !validEtag(body.etag) || !Number.isInteger(body.deltaMs)
        || body.deltaMs < -5000 || body.deltaMs > 5000) {
        return failure(400, 'INVALID_LYRIC_OFFSET', 'Invalid timeline shift', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (current.state !== 'found' || current.artifact.status !== 'ready') {
        return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      }
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const base = applyLyricOffset({ version: 2, ...current.artifact.original }, current.artifact.offsetMs);
      const shifted = applyLyricOffset(base, body.deltaMs);
      const written = await store.putIfMatch(songId, {
        ...current.artifact,
        original: { ...current.artifact.original, syncMode: shifted.syncMode, lines: shifted.lines },
        offsetMs: 0,
        updatedAt: new Date(now()).toISOString(),
      }, current.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'offset') {
      const body = await bodyOf(request, ['offsetMs', 'etag'], ['offsetMs', 'etag']);
      if (!body || !Number.isInteger(body.offsetMs) || body.offsetMs < -5000
        || body.offsetMs > 5000 || !validEtag(body.etag)) {
        return failure(400, 'INVALID_LYRIC_OFFSET', 'Invalid offset', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (current.state !== 'found' || current.artifact.status !== 'ready') {
        return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      }
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const written = await store.putIfMatch(songId, { ...current.artifact,
        offsetMs: body.offsetMs, updatedAt: new Date(now()).toISOString() }, current.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'translation') {
      const body = await bodyOf(request, ['etag'], ['etag']);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_TRANSLATION_RESET', 'Invalid request body', headers);
      const current = notDeleting(await store.get(songId));
      if (current.state !== 'found' || current.artifact.status !== 'ready') return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const written = await store.putIfMatch(songId, { ...current.artifact, translation: null,
        aiCompletion: null, updatedAt: new Date(now()).toISOString() }, current.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'asset' && method === 'DELETE') {
      const body = await bodyOf(request, ['etag'], ['etag']);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_LYRIC_RESET', 'Invalid request body', headers);
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const marker = buildLyricArtifactMarker(songId, 'reset', { now: now() });
      if (!await songOf(db, songId)) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
      const written = await writeCurrent(store, songId, marker, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success({ status: 'missing', etag: written.etag, asset: null, lyrics: null }, 200, headers);
    }
    if (action === 'ai-completion') {
      const body = await bodyOf(request, []);
      if (!body) return failure(400, 'INVALID_AI_COMPLETION', 'Invalid request body', headers);
      notDeleting(await store.get(songId));
      const started = await (deps.beginCompletion || beginLyricAssetAiCompletion)({
        env, db, song, store, actorAccountId: session.account.accountId, force: true, deps: deps.aiDeps,
      });
      if (started.state === 'missing') return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      if (started.state === 'not_needed') return success({ status: 'not_needed' }, 200, headers);
      if (started.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      if (started.task) schedule(started.task, deps.ctx);
      const projected = projectLyricArtifact(started.artifact, { song, now: now(), targetLanguage });
      return success({ status: started.state, etag: started.etag,
        translationState: projected.translationState,
        translationStartedAt: projected.translationStartedAt }, 202, headers);
    }
  } catch (error) {
    const known = knownFailure(error, headers);
    if (known) return known;
    return failure(503, 'LYRIC_WORKSPACE_UNAVAILABLE', 'Lyric workspace unavailable', headers);
  }
  return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', headers);
}
