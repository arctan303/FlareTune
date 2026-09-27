import { LyricSourceError } from '../services/lyricSourceLoader.js';
import { LyricArtifactStoreError } from '../services/lyricArtifactStore.js';
import { loadLyricTargetLanguage } from '../services/lyricAiConfig.js';
import {
  lyricArtifactStoreForEnv,
  projectLyricArtifact,
  readOrCreateLyricArtifact,
} from '../services/lyricAssetWorkflow.js';

function jsonResponse(payload, headers, status = 200) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

async function getSong(db, songId) {
  if (!db || typeof songId !== 'string' || !songId.trim()) return null;
  return db.prepare(`
    SELECT s.id, s.title, s.artist, s.album, s.duration, s.language
    FROM Songs s
    WHERE s.id = ?
  `).bind(songId.trim()).first();
}

function lyricFailureResponse(error, headers) {
  if (error?.message === 'AI_ASSISTANT_CONFIG_UNAVAILABLE') {
    return jsonResponse({ code: 503, error: 'LYRIC_AI_CONFIG_UNAVAILABLE',
      message: 'Lyric AI settings unavailable' }, headers, 503);
  }
  if (error instanceof LyricArtifactStoreError) {
    const invalid = error.code === 'invalid_stored_artifact';
    return jsonResponse({
      code: invalid ? 502 : 503,
      error: error.code,
      message: invalid ? 'Stored lyric asset is invalid' : 'Lyric storage temporarily unavailable',
    }, headers, invalid ? 502 : 503);
  }
  if (error instanceof LyricSourceError) {
    const invalid = error.kind === 'invalid';
    return jsonResponse({
      code: invalid ? 502 : 503,
      error: invalid ? 'LYRIC_SOURCE_INVALID' : 'LYRIC_SOURCE_UNAVAILABLE',
      message: invalid ? 'Lyric source returned invalid data' : 'Lyric source temporarily unavailable',
    }, headers, invalid ? 502 : 503);
  }
  return null;
}

export async function handleLyricsRoute(request, url, headers, db, injectedDeps = {}) {
  if (request.method !== 'GET' || url.pathname !== '/api/lyrics') {
    return jsonResponse({ code: 405, message: 'Method not allowed' }, headers, 405);
  }
  if ([...url.searchParams.keys()].some((key) => key !== 'songId')) {
    return jsonResponse({ code: 400, message: 'Only songId is accepted' }, headers, 400);
  }
  const songId = url.searchParams.get('songId')?.trim() || '';
  if (!songId) return jsonResponse({ code: 400, message: 'Missing song id' }, headers, 400);
  if (!db) return jsonResponse({ code: 500, message: 'Database not bound' }, headers, 500);

  const song = await getSong(db, songId);
  if (!song) {
    return jsonResponse({ code: 404, message: 'Song not found', reason: 'song_not_found' }, headers, 404);
  }
  if (song.language === 'instrumental') {
    return jsonResponse({
      code: 200,
      data: {
        version: 2,
        source: null,
        format: null,
        syncMode: 'none',
        lrc: '',
        lines: [],
        tlyric: '',
        translation: null,
        translationAvailable: false,
        translationState: 'unavailable',
        translationStartedAt: null,
        offsetMs: 0,
        reason: 'instrumental',
      },
    }, headers);
  }

  const env = injectedDeps.env;
  try {
    const store = injectedDeps.store || lyricArtifactStoreForEnv(env);
    const result = await (injectedDeps.readOrCreateLyricArtifact || readOrCreateLyricArtifact)({
      env,
      song,
      signal: request.signal,
      store,
      fetchDocument: injectedDeps.fetchLyricsDocument,
      songStillExists: () => getSong(db, songId).then(Boolean),
      now: injectedDeps.now,
    });
    if (result.state === 'song_deleted') {
      return jsonResponse({ code: 404, message: 'Song not found', reason: 'song_not_found' }, headers, 404);
    }
    if (!result.artifact || result.artifact.status === 'not_found') {
      return jsonResponse({
        code: 404,
        data: null,
        message: 'No lyrics found',
        reason: 'lyrics_not_found',
      }, headers, 404);
    }

    const targetLanguage = await loadLyricTargetLanguage(db);
    return jsonResponse({
      code: 200,
      data: projectLyricArtifact(result.artifact, {
        song,
        now: (injectedDeps.now || Date.now)(),
        targetLanguage,
      }),
    }, headers);
  } catch (error) {
    const failure = lyricFailureResponse(error, headers);
    if (failure) return failure;
    console.error('Lyrics fetch error:', error);
    return jsonResponse({ code: 500, message: 'Internal server error' }, headers, 500);
  }
}
