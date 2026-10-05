import { lyricArtifactStoreForEnv, projectLyricArtifact, readOrCreateLyricArtifact, shouldAiCompleteLyrics } from './lyricAssetWorkflow.js';
import { beginLyricAssetAiCompletion, resolveLegacyLyricCleanup } from './lyricAssetTranslation.js';
import { loadLyricAiProcessingSettings } from './lyricAiConfig.js';

export class PlaybackLyricsError extends Error {
  constructor(message) { super(message); this.name = 'PlaybackLyricsError'; }
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
  const store = deps.store || lyricArtifactStoreForEnv(env);
  let read = await (deps.readOrCreateLyricArtifact || readOrCreateLyricArtifact)({
    env, song, store, signal, executionContext,
    songStillExists: async () => Boolean(await db.prepare('SELECT id FROM Songs WHERE id = ?').bind(song.id).first()),
    ...(deps.fetchDocument ? { fetchDocument: deps.fetchDocument } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (read.state === 'song_deleted') return read;
  if (!read.artifact || read.artifact.status === 'not_found') return { ...read, lyrics: null };
  if (read.artifact.status !== 'ready') throw new PlaybackLyricsError('Lyric asset is not ready');
  read = await resolveLegacyLyricCleanup(store, song, read, deps.now || Date.now);
  if (read.artifact?.status !== 'ready') throw new PlaybackLyricsError('Lyric asset is not ready');
  const { targetLanguage, processingKey, completionEnabled, automaticCompletionEnabled } =
    await loadLyricAiProcessingSettings(db);
  let projected = projectLyricArtifact(read.artifact, { song, targetLanguage });
  for (let attempt = 0; read.artifact.translation && !projected.translationAvailable; attempt += 1) {
    if (attempt >= 3) throw new PlaybackLyricsError('Lyric asset changed during translation update');
    const updatedAt = new Date((deps.now || Date.now)()).toISOString();
    const cleared = await store.putIfMatch(song.id, {
      ...read.artifact, translation: null, aiCompletion: null, updatedAt,
    }, read.etag, { automation: read.automation });
    read = cleared.state === 'updated' ? { ...cleared, state: 'found' } : await store.get(song.id);
    if (read.state !== 'found' || read.artifact?.status !== 'ready') throw new PlaybackLyricsError('Lyric asset is not ready');
    projected = projectLyricArtifact(read.artifact, { song, targetLanguage });
  }
  const needsAutomaticAi = completionEnabled && automaticCompletionEnabled
    && shouldAiCompleteLyrics(read.artifact.original, song, { targetLanguage })
    && !projected.translationAvailable
    && (['created', 'updated'].includes(read.state)
      || (read.state === 'found'
        && (read.artifact.aiCompletion === null
          || read.artifact.aiCompletion?.status === 'completed'
            && read.artifact.aiCompletion.processingKey !== processingKey)));
  if (needsAutomaticAi) {
    try {
      const started = await (deps.beginCompletion || beginLyricAssetAiCompletion)({
        env, db, song, store, actorAccountId: accountId, force: true, targetLanguage, automatic: true,
        deps: deps.aiDeps || {},
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
  return { ...read, lyrics: !completionEnabled && !currentLyrics.translationAvailable
    ? { ...currentLyrics, translationState: 'unavailable', translationStartedAt: null }
    : currentLyrics };
}
