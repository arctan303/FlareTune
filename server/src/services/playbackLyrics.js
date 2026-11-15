import { lyricArtifactStoreForEnv, projectLyricArtifact, readOrCreateLyricArtifact, shouldAiCompleteLyrics,
  hasCurrentLyricNoTranslationDecision } from './lyricAssetWorkflow.js';
import { beginLyricAssetAiCompletion, resolveLegacyLyricCleanup } from './lyricAssetTranslation.js';
import { loadLyricAiConfig } from './lyricAiConfig.js';
import { createPluginServiceLease } from '../plugins/services.js';
import { createSubsonicPluginServiceLease } from '../subsonic/pluginAuthority.js';
import { guardStoreAuthority as guardLyricsStore, storeAuthorityGuard as lyricsStoreGuard } from './storeAuthority.js';
import { isValidSongLanguage } from '../utils/songLanguage.js';

// Saved translation language is a playback preference even when the optional
// workbench is absent. Model selection, prompts and AI policy stay in its pack.
async function playbackLyricPreferences(db) {
  const row = db?.prepare ? await db.prepare("SELECT value_json FROM instance_settings WHERE key = 'lyrics.ai'").first() : null;
  let value;
  try { value = row?.value_json ? JSON.parse(row.value_json) : null; }
  catch { throw new PlaybackLyricsError('Lyric preferences are unavailable'); }
  const language = value?.targetLanguage ?? 'zh';
  if (!isValidSongLanguage(language) || ['instrumental', 'other'].includes(language)) throw new PlaybackLyricsError('Lyric preferences are unavailable');
  return { targetLanguage: language, completionEnabled: false, automaticCompletionEnabled: false };
}

export class PlaybackLyricsError extends Error {
  constructor(message) { super(message); this.name = 'PlaybackLyricsError'; }
}

export const isExternalLyricSongId = value => typeof value === 'string' && /^yt:[A-Za-z0-9_-]{11}$/u.test(value);

// The resolver is supplied by the authenticated host. It must resolve public
// metadata through the currently installed/connected source, never request data.
export async function resolveLyricSong(db, songId, deps = {}) {
  if (String(songId).startsWith('yt:')) {
    if (!isExternalLyricSongId(songId) || typeof deps.resolveSong !== 'function') return null;
    const song = await deps.resolveSong(songId);
    return song?.id === songId ? { ...song } : null;
  }
  return db.prepare('SELECT id, title, artist, album, duration, language FROM Songs WHERE id = ?')
    .bind(songId).first();
}

export const lyricSongStillExists = (db, songId, deps = {}) => isExternalLyricSongId(songId) && typeof deps.songStillExists === 'function'
  ? deps.songStillExists(songId)
  : resolveLyricSong(db, songId, deps).then(Boolean);

// Keep the ordinary shared store unchanged. A virtual source is rechecked at
// each I/O boundary, including writes made later by an automatic AI task.
export function guardExternalLyricStore(store, songId, exists) {
  if (!isExternalLyricSongId(songId)) return store;
  const guarded = { ...store };
  for (const method of ['get', 'createIfAbsent', 'putIfMatch', 'restoreLegacyIfMatch', 'delete']) {
    if (typeof store[method] !== 'function') continue;
    guarded[method] = async (...args) => {
      const signal = ['createIfAbsent', 'putIfMatch'].includes(method) ? args.at(-1)?.signal : null;
      signal?.throwIfAborted();
      if (args[0] !== songId || !await exists()) throw new PlaybackLyricsError('Song source is no longer available');
      signal?.throwIfAborted();
      return store[method](...args);
    };
  }
  Object.defineProperty(guarded, lyricsStoreGuard, { value: assertCurrent =>
    guardExternalLyricStore(guardLyricsStore(store, assertCurrent), songId, exists) });
  return guarded;
}

const instrumentalLyrics = () => ({
  version: 2, source: null, format: null, syncMode: 'none', lrc: '', lines: [], tlyric: '',
  translation: null, translationAvailable: false, translationState: 'unavailable',
  translationStartedAt: null, offsetMs: 0, reason: 'instrumental',
});

// Callers authenticate before reaching this service. Both playback protocols use
// the same source retrieval, target-language policy and automatic AI settings.
export async function readPlaybackLyrics({ env, db, song, accountId, executionContext, signal, deps = {} }) {
  if (song.language === 'instrumental') return { state: 'not_needed', artifact: null, lyrics: instrumentalLyrics() };
  const songStillExists = () => lyricSongStillExists(db, song.id, deps);
  const store = guardExternalLyricStore(deps.store || lyricArtifactStoreForEnv(env), song.id, songStillExists);
  let read = await (deps.readOrCreateLyricArtifact || readOrCreateLyricArtifact)({
    env, song, store, signal, executionContext,
    songStillExists,
    ...(deps.fetchDocument ? { fetchDocument: deps.fetchDocument } : {}),
    ...(isExternalLyricSongId(song.id) && deps.fetchNativeDocument ? { fetchNativeDocument: deps.fetchNativeDocument } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (read.state === 'song_deleted') return read;
  if (!read.artifact || read.artifact.status === 'not_found') return { ...read, lyrics: null };
  if (read.artifact.status !== 'ready') throw new PlaybackLyricsError('Lyric asset is not ready');
  let aiLease = null;
  if (deps.session || deps.subsonicPrincipal) {
    try {
      aiLease = await (deps.createAiLease || (deps.subsonicPrincipal ? createSubsonicPluginServiceLease : createPluginServiceLease))({ env,
        session: deps.session, principal: deps.subsonicPrincipal,
        consumerId: 'lyrics-workbench', providerId: 'ai-gateway', consumerContext: deps.consumerContext,
        registry: deps.registry });
    } catch { /* Optional plugin services do not prevent ordinary lyric reads. */ }
  }
  let aiStore = aiLease ? guardLyricsStore(store, aiLease.assertCurrent) : null;
  if (aiStore) {
    try { read = await resolveLegacyLyricCleanup(aiStore, song, read, deps.now || Date.now); }
    catch { aiLease = null; aiStore = null; read = await store.get(song.id); }
  }
  if (read.artifact?.status !== 'ready') throw new PlaybackLyricsError('Lyric asset is not ready');
  let lyricConfig = null;
  if (aiLease) {
    try { lyricConfig = await (deps.loadLyricAiConfig || loadLyricAiConfig)(aiLease.guardedDb(db)); }
    catch { aiLease = null; aiStore = null; }
  }
  const { targetLanguage, completionEnabled: configuredCompletion, automaticCompletionEnabled } = lyricConfig
    || await playbackLyricPreferences(db);
  let completionEnabled = configuredCompletion && Boolean(aiLease);
  // A target-language preference is a read projection, not permission to delete
  // a previously saved translation. Replacement happens only after completion.
  const projected = projectLyricArtifact(read.artifact, { song, targetLanguage });
  const notNeeded = hasCurrentLyricNoTranslationDecision(read.artifact, song, { targetLanguage });
  const needsAutomaticAi = completionEnabled && automaticCompletionEnabled
    && !notNeeded
    && shouldAiCompleteLyrics(read.artifact.original, song, { targetLanguage })
    && !projected.translationAvailable
    && (['created', 'updated'].includes(read.state)
      || (read.state === 'found'
        && (read.artifact.aiCompletion === null
          || read.artifact.aiCompletion?.status === 'failed'
            && read.artifact.aiCompletion.errorCode === 'request_budget_exhausted'
          || read.artifact.aiCompletion?.status === 'completed')));
  if (needsAutomaticAi) {
    try {
      const started = await (deps.beginCompletion || beginLyricAssetAiCompletion)({
        // The consumer binds this store to the saved model and the same lease.
        // Passing aiStore would layer the old lease-only guard around it again.
        env, db: aiLease.guardedDb(db), song, store, actorAccountId: accountId, force: true, targetLanguage, automatic: true,
        deps: { ...deps.aiDeps, session: deps.session, consumerContext: deps.consumerContext,
          subsonicPrincipal: deps.subsonicPrincipal, aiLease, lyricConfig, registry: deps.registry, signal },
      });
      if (started.artifact?.status === 'ready') read = started;
      if (started.task) {
        if (executionContext?.waitUntil) executionContext.waitUntil(started.task);
        else void started.task.catch((error) => console.error('Automatic lyric AI failed:', error));
      }
    } catch (error) {
      console.error('Automatic lyric AI could not start:', error);
    }
  }
  const currentLyrics = projectLyricArtifact(read.artifact, { song, targetLanguage });
  const currentNotNeeded = hasCurrentLyricNoTranslationDecision(read.artifact, song, { targetLanguage });
  const lyrics = !completionEnabled && !currentLyrics.translationAvailable
    ? { ...currentLyrics, translationState: 'unavailable', translationStartedAt: null }
    : currentLyrics;
  return { ...read, lyrics: { ...lyrics, targetLanguage,
    translationSupported: Boolean(currentLyrics.translationAvailable || completionEnabled && !currentNotNeeded
      && shouldAiCompleteLyrics(read.artifact.original, song, { targetLanguage })) } };
}
