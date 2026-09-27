import { createLyricArtifactStore, LyricArtifactStoreError } from './lyricArtifactStore.js';
import {
  fetchLyricsDocumentWithFallback,
  fetchSourceLyricsDocument,
} from './lyricSourceLoader.js';
import { applyLyricOffset } from './lyricResolution.js';
import { createLyricDocument, projectCanonicalLrc } from '../utils/lyricDocument.js';
import { analyzeLrcLanguage, computeHash } from '../utils/lyricsParsing.js';
import { resolveSongTranslationNeed } from '../utils/songLanguage.js';

const PLACEHOLDER_LYRIC_PATTERN = /^(?:暂无歌词|无歌词|纯音乐(?:\s*[，,、-]?\s*请欣赏)?|此歌曲为纯音乐)[。.!！]?$/u;
export const LYRIC_AI_PENDING_FRESH_MS = 30_000;
export const LYRIC_NOT_FOUND_RETRY_MS = 10 * 60_000;
const storesByBucket = new WeakMap();

const nowIso = (now) => new Date(now).toISOString();

export function lyricArtifactStoreForEnv(env) {
  const bucket = env?.MEDIA_BUCKET;
  if (!bucket || (typeof bucket !== 'object' && typeof bucket !== 'function')) {
    return createLyricArtifactStore(env);
  }
  let store = storesByBucket.get(bucket);
  if (!store) {
    store = createLyricArtifactStore(env);
    storesByBucket.set(bucket, store);
  }
  return store;
}

function stripProviderTranslation(line) {
  const { tlyric: _translation, ...original } = line || {};
  return original;
}

function safeProvenance(document) {
  const meta = document?.providerMeta || {};
  const provenance = {};
  if (typeof meta.providerLyricId === 'string' && meta.providerLyricId) {
    provenance.providerLyricId = meta.providerLyricId;
  }
  if (typeof meta.matchedTitle === 'string' && meta.matchedTitle) {
    provenance.matchedTitle = meta.matchedTitle;
  }
  if (typeof meta.matchedArtist === 'string' && meta.matchedArtist) {
    provenance.matchedArtist = meta.matchedArtist;
  }
  const matchedDuration = Number(meta.matchedDuration);
  if (Number.isFinite(matchedDuration) && matchedDuration >= 0) {
    provenance.matchedDuration = matchedDuration;
  }
  return provenance;
}

export function lyricTextForHash(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => String(line?.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

export function shouldAiCompleteLyrics(original, song = {}, { targetLanguage = 'zh' } = {}) {
  const lrc = projectCanonicalLrc(original?.lines || []);
  const meaningfulLines = (original?.lines || [])
    .map((line) => String(line?.text || '').trim())
    .filter((text) => text && !PLACEHOLDER_LYRIC_PATTERN.test(text));
  if (meaningfulLines.length === 0) return false;
  if (targetLanguage !== 'zh') return song.language !== 'instrumental' && song.language !== targetLanguage;
  const analysis = analyzeLrcLanguage(lrc);
  return resolveSongTranslationNeed(song.language, analysis);
}

export async function buildReadyLyricArtifact(song, document, {
  offsetMs = 0,
  now = Date.now(),
  targetLanguage = null,
} = {}) {
  const canonical = createLyricDocument(document);
  const lines = canonical.lines.map(stripProviderTranslation);
  const original = {
    source: canonical.source,
    format: canonical.format,
    syncMode: canonical.syncMode,
    lines,
  };
  const textHash = await computeHash(lyricTextForHash(lines));
  const providerTranslationLines = canonical.lines.map((line) => String(line.tlyric || '').trim());
  const hasProviderTranslation = (
    (canonical.source === 'kugou' && canonical.format === 'krc')
    || (canonical.source === 'netease' && canonical.format === 'lrc')
    || canonical.source === 'manual'
  ) && providerTranslationLines.some(Boolean);
  const updatedAt = nowIso(now);
  const translation = hasProviderTranslation
    ? {
        source: canonical.source,
        originalTextHash: textHash,
        lines: providerTranslationLines,
        ...(canonical.source === 'manual' && targetLanguage ? { language: targetLanguage } : {}),
        updatedAt,
      }
    : null;
  return {
    artifact: {
      schemaVersion: 1,
      songId: song.id,
      status: 'ready',
      original,
      translation,
      aiCompletion: null,
      offsetMs,
      textHash,
      provenance: safeProvenance(canonical),
      updatedAt,
    },
  };
}

export async function buildEditedLyricArtifact(song, lines, { now = Date.now(), targetLanguage = 'zh' } = {}) {
  const hasWords = lines.some((line) => Array.isArray(line.words) && line.words.length > 0);
  const canonical = createLyricDocument({
    source: 'manual', format: hasWords ? 'lyricsfile' : 'lrc', lines,
  });
  if (canonical.lines.length !== lines.length || !canonical.lines.some((line) => line.text.trim())) {
    throw new RangeError('edited lyric lines are invalid');
  }
  const originalLines = canonical.lines.map(stripProviderTranslation);
  const textHash = await computeHash(lyricTextForHash(originalLines));
  const translations = canonical.lines.map((line) => String(line.tlyric || '').trim());
  const updatedAt = nowIso(now);
  return {
    schemaVersion: 1,
    songId: song.id,
    status: 'ready',
    original: {
      source: 'manual', format: canonical.format, syncMode: canonical.syncMode, lines: originalLines,
    },
    translation: translations.some(Boolean) ? {
      source: 'manual', originalTextHash: textHash, lines: translations,
      language: targetLanguage, updatedAt,
    } : null,
    aiCompletion: null,
    offsetMs: 0,
    textHash,
    provenance: {},
    updatedAt,
  };
}

export function buildNotFoundLyricArtifact(songId, now = Date.now()) {
  return {
    schemaVersion: 1,
    songId,
    status: 'not_found',
    updatedAt: nowIso(now),
  };
}

export async function readOrCreateLyricArtifact({
  env,
  song,
  signal,
  store,
  fetchDocument = fetchSourceLyricsDocument,
  songStillExists,
  now = Date.now,
}) {
  if (song?.language === 'instrumental') {
    return { state: 'not_needed', artifact: null, etag: null };
  }

  const artifactStore = store || lyricArtifactStoreForEnv(env);
  const ensureReadable = (read) => {
    if (read.state === 'found' && read.artifact.status === 'deleting') {
      throw new LyricArtifactStoreError(
        'lyric_asset_deleting',
        'get',
        'Lyric asset is temporarily unavailable while its song is being deleted',
      );
    }
    return read;
  };
  const isTerminalArtifact = (read) => (
    read.state === 'found' && (read.artifact.status === 'ready'
      || (read.artifact.status === 'not_found'
        && Number.isFinite(Date.parse(read.artifact.updatedAt))
        && now() - Date.parse(read.artifact.updatedAt) < LYRIC_NOT_FOUND_RETRY_MS))
  );

  const current = ensureReadable(await artifactStore.get(song.id));
  if (isTerminalArtifact(current)) return current;

  return artifactStore.singleflight(song.id, async () => {
    const afterWait = ensureReadable(await artifactStore.get(song.id));
    if (isTerminalArtifact(afterWait)) return afterWait;

    const document = await fetchLyricsDocumentWithFallback(
      'auto',
      song,
      fetchDocument,
      { signal },
    );
    const built = document
      ? await buildReadyLyricArtifact(song, document, { now: now() })
      : { artifact: buildNotFoundLyricArtifact(song.id, now()) };
    if (songStillExists && !await songStillExists()) {
      return { state: 'song_deleted', artifact: null, etag: null };
    }
    const written = afterWait.state === 'legacy'
      || (afterWait.state === 'found' && ['reset', 'not_found'].includes(afterWait.artifact.status))
      ? await artifactStore.putIfMatch(song.id, built.artifact, afterWait.etag)
      : await artifactStore.createIfAbsent(song.id, built.artifact);
    if (written.state === 'created' || written.state === 'updated') {
      return written;
    }
    const winner = ensureReadable(await artifactStore.get(song.id));
    if (!isTerminalArtifact(winner)) {
      throw new LyricArtifactStoreError(
        'lyric_asset_conflict',
        'put',
        'Lyric asset changed while it was being rebuilt',
      );
    }
    return winner;
  });
}

export function isFreshLyricAiPending(aiCompletion, now = Date.now()) {
  if (aiCompletion?.status !== 'pending') return false;
  const startedAt = Date.parse(aiCompletion.updatedAt);
  const ageMs = now - startedAt;
  return Number.isFinite(startedAt) && ageMs >= 0 && ageMs <= LYRIC_AI_PENDING_FRESH_MS;
}

function activeTranslation(artifact, targetLanguage) {
  const translation = artifact?.translation;
  if (!translation || !targetLanguage) return translation;
  const language = translation.language || (translation.source === 'ai' ? 'zh' : null);
  return language === targetLanguage || (language === null && targetLanguage === 'zh')
    ? translation : null;
}

export function resolveLyricTranslationState(artifact, song = {}, now = Date.now(), targetLanguage = null) {
  if (!artifact || artifact.status !== 'ready') return 'unavailable';
  if (artifact.aiCompletion?.status === 'failed'
    && artifact.aiCompletion.errorCode === 'language_update_failed') return 'failed';
  if (isFreshLyricAiPending(artifact.aiCompletion, now)) return 'pending';
  if (!shouldAiCompleteLyrics(artifact.original, song, { targetLanguage: targetLanguage || 'zh' })) {
    return 'unavailable';
  }
  if (activeTranslation(artifact, targetLanguage)) return 'ready';
  if (artifact.aiCompletion?.status === 'completed') return 'unavailable';
  if (artifact.aiCompletion?.status === 'failed' || artifact.aiCompletion?.status === 'pending') {
    return 'failed';
  }
  return 'missing';
}

const formatTimestamp = (seconds) => {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1_000));
  const minutes = Math.floor(totalMs / 60_000);
  const remainder = totalMs % 60_000;
  return `[${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder / 1_000)).padStart(2, '0')}.${String(remainder % 1_000).padStart(3, '0')}]`;
};

export function projectLyricArtifact(artifact, { song = {}, now = Date.now(), targetLanguage = null } = {}) {
  if (!artifact || artifact.status !== 'ready') return null;
  const translationState = resolveLyricTranslationState(artifact, song, now, targetLanguage);
  const document = applyLyricOffset({
    version: 2,
    ...artifact.original,
    lrc: projectCanonicalLrc(artifact.original.lines),
  }, artifact.offsetMs);
  const selectedTranslation = activeTranslation(artifact, targetLanguage);
  const translatedLines = selectedTranslation?.lines || [];
  const lines = document.lines.map((line, index) => {
    const tlyric = String(translatedLines[index] || '').trim();
    return tlyric ? { ...line, tlyric } : line;
  });
  const tlyric = document.lines
    .map((line, index) => {
      const text = String(translatedLines[index] || '').trim();
      if (!text) return '';
      return line.time === undefined ? text : `${formatTimestamp(line.time)}${text}`;
    })
    .filter(Boolean)
    .join('\n');
  return {
    ...document,
    lines,
    tlyric,
    translation: selectedTranslation,
    translationAvailable: Boolean(selectedTranslation),
    translationState,
    translationStartedAt: translationState === 'pending'
      ? artifact.aiCompletion.updatedAt
      : null,
    offsetMs: artifact.offsetMs,
    updatedAt: artifact.updatedAt,
    provenance: artifact.provenance,
  };
}
