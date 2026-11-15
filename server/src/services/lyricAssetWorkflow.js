import { createLyricArtifactStore, LyricArtifactStoreError } from './lyricArtifactStore.js';
import {
  fetchLyricsDocumentWithFallback,
  fetchSourceLyricsDocument,
} from './lyricSourceLoader.js';
import { applyLyricOffset } from './lyricResolution.js';
import { createLyricDocument, projectCanonicalLrc } from '../utils/lyricDocument.js';
import { computeHash } from '../utils/lyricsParsing.js';
import { scheduleLyricAssetUpgrade } from './lyricAssetUpgrade.js';
import { lyricSourceLoaderForDb } from './lyricSourcesConfig.js';
import { LEGACY_LYRIC_SOURCES, isCustomLyricSourceId, lyricTranslationLanguageMatches, isValidLyricTranslationTarget, storedLyricTranslationLanguage } from '../../../shared/lyricSources.js';
import { createLyricRequestBudget } from './lyricRequestBudget.js';
import { preferredAutomaticDocument } from './lyricAutomaticSelection.js';
import { LyricSourceError } from './lyricSourceError.js';
import { meaningfulLyricLines, resolveLyricTranslationNeed, getCurrentLyricTranslationDecision,
  hasCurrentLyricNoTranslationDecision } from './lyricTranslationPolicy.js';
export { LYRIC_TRANSLATION_POLICY_VERSION, resolveLyricTranslationNeed, getCurrentLyricTranslationDecision,
  hasCurrentLyricNoTranslationDecision, buildLyricNoTranslationDecision, buildLyricTranslationDecision } from './lyricTranslationPolicy.js';

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
  return resolveLyricTranslationNeed(original, song, { targetLanguage }).state !== 'not_needed';
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
    (canonical.source === 'custom_krc' && canonical.format === 'krc')
    || (canonical.source === 'custom_lrc' && canonical.format === 'lrc')
    || (isCustomLyricSourceId(canonical.source) && !['custom_krc', 'custom_lrc'].includes(canonical.source))
    || canonical.source === 'manual'
    || Object.hasOwn(LEGACY_LYRIC_SOURCES, canonical.source)
  ) && providerTranslationLines.some(Boolean);
  const updatedAt = nowIso(now);
  const translation = hasProviderTranslation
    ? {
        source: canonical.source,
        originalTextHash: textHash,
        lines: providerTranslationLines,
        ...(canonical.source === 'manual' && targetLanguage ? { language: targetLanguage }
          : canonical.providerMeta?.translationLanguage ? { language: canonical.providerMeta.translationLanguage } : {}),
        updatedAt,
      }
    : null;
  return {
    artifact: {
      schemaVersion: 1,
      songId: song.id,
      status: 'ready',
      original,
      translation: projectLyricTranslation(original, translation, { song,
        targetLanguage: targetLanguage || translation?.language || null }),
      aiCompletion: null,
      offsetMs,
      textHash,
      provenance: safeProvenance(canonical),
      updatedAt,
    },
  };
}

export async function buildEditedLyricArtifact(song, lines, {
  now = Date.now(), targetLanguage = 'zh', translationLanguage = targetLanguage,
} = {}) {
  if (!isValidLyricTranslationTarget(translationLanguage) && !['zh-CN', 'zh-TW'].includes(translationLanguage)) {
    throw new RangeError('translation language is invalid');
  }
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
    translation: projectLyricTranslation({ lines: originalLines }, translations.some(Boolean) ? {
      source: 'manual', originalTextHash: textHash, lines: translations,
      language: translationLanguage, updatedAt,
    } : null, { song, targetLanguage: translationLanguage }),
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
  executionContext,
  store,
  fetchDocument = fetchSourceLyricsDocument,
  fetchNativeDocument,
  requestBudget = createLyricRequestBudget(),
  songStillExists,
  now = Date.now,
}) {
  if (song?.language === 'instrumental') {
    return { state: 'not_needed', artifact: null, etag: null };
  }

  const loader = fetchDocument === fetchSourceLyricsDocument ? await lyricSourceLoaderForDb(env?.DB) : null;
  const enabledSources = loader?.enabledSources;
  const upgradeFetcher = loader?.fetchSourceDocument || fetchDocument;
  if (loader) fetchDocument = loader.cachedDocument;
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
  if (isTerminalArtifact(current)) {
    scheduleLyricAssetUpgrade({ store: artifactStore, song, read: current, executionContext,
      buildArtifact: buildReadyLyricArtifact, songStillExists, now, enabledSources, requestBudget,
      fetchNativeDocument,
      ...(upgradeFetcher !== fetchSourceLyricsDocument ? { fetchDocument: upgradeFetcher } : {}),
    });
    return current;
  }

  return artifactStore.singleflight(song.id, async ({ signal: sharedSignal = signal } = {}) => {
    const afterWait = ensureReadable(await artifactStore.get(song.id));
    if (isTerminalArtifact(afterWait)) return afterWait;

    const options = { signal: sharedSignal, executionContext, enabledSources, requestBudget };
    const automatic = () => fetchLyricsDocumentWithFallback('auto', song, fetchDocument, options);
    let document;
    if (typeof fetchNativeDocument === 'function') {
      // The exact-resource native document and existing automatic scrapers run
      // once inside the same asset singleflight. Keep real word/line timing when
      // it is a better match; native plain lines never receive invented times.
      const [scraped, native] = await Promise.allSettled([
        automatic(), Promise.resolve().then(() => fetchNativeDocument(song, options)),
      ]);
      sharedSignal?.throwIfAborted();
      document = scraped.status === 'fulfilled' ? scraped.value : null;
      let nativeDocument = null;
      if (native.status === 'fulfilled' && native.value) {
        nativeDocument = createLyricDocument(native.value);
        if (nativeDocument.source !== 'youtube') throw new TypeError('Invalid native lyric source');
      }
      if (preferredAutomaticDocument(nativeDocument, document)) document = nativeDocument;
      if (!document && scraped.status === 'rejected') throw scraped.reason;
      if (!document && native.status === 'rejected') {
        throw new LyricSourceError('upstream', 'youtube', 'native', 'Native lyric source temporarily unavailable');
      }
    } else document = await automatic();
    const built = document
      ? await buildReadyLyricArtifact(song, document, { now: now() })
      : { artifact: buildNotFoundLyricArtifact(song.id, now()) };
    if (songStillExists && !await songStillExists()) {
      return { state: 'song_deleted', artifact: null, etag: null };
    }
    sharedSignal?.throwIfAborted();
    const writeOptions = built.artifact.status === 'ready'
      ? { automation: { checkedAt: nowIso(now()) }, signal: sharedSignal } : { signal: sharedSignal };
    const written = afterWait.state === 'legacy'
      || (afterWait.state === 'found' && ['reset', 'not_found'].includes(afterWait.artifact.status))
      ? await artifactStore.putIfMatch(song.id, built.artifact, afterWait.etag, writeOptions)
      : await artifactStore.createIfAbsent(song.id, built.artifact, writeOptions);
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
  }, { signal, executionContext });
}

export function isFreshLyricAiPending(aiCompletion, now = Date.now()) {
  if (aiCompletion?.status !== 'pending') return false;
  const startedAt = Date.parse(aiCompletion.updatedAt);
  const ageMs = now - startedAt;
  return Number.isFinite(startedAt) && ageMs >= 0 && ageMs <= LYRIC_AI_PENDING_FRESH_MS;
}

export function projectLyricTranslation(original, translation, { targetLanguage = null, song = {} } = {}) {
  if (!translation) return null;
  const language = storedLyricTranslationLanguage(translation);
  if (targetLanguage && !lyricTranslationLanguageMatches(language, targetLanguage)) return null;
  // Hide old same-language rewrites without deleting user assets. A different
  // target and genuine foreign passages still retain their valid translations.
  if (language && !shouldAiCompleteLyrics(original, song, { targetLanguage: language })) return null;
  const normalize = text => String(text || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
  const semantic = meaningfulLyricLines(original, song);
  const translatedBody = semantic.filter(({ text, index }) => normalize(translation.lines[index])
    && normalize(text) !== normalize(translation.lines[index]))
    .map(({ index }) => translation.lines[index]).join('\n');
  if (!translatedBody) return null;
  // A declared language cannot make an obviously incompatible script valid.
  // Latin remains ambiguous between several languages; this is rejection
  // evidence only, never language inference or a catalog metadata update.
  const script = ['zh', 'zh-CN', 'zh-TW', 'zh-Hant', 'yue'].includes(language) ? /\p{Script=Han}/u
    : language === 'ja' ? /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
      : language === 'ko' ? /\p{Script=Hangul}/u : language === 'ru' ? /\p{Script=Cyrillic}/u
        : language === 'th' ? /\p{Script=Thai}/u
          : ['en', 'es', 'fr', 'de', 'sv', 'vi', 'it', 'pt'].includes(language) ? /\p{Script=Latin}/u : null;
  if (script && !script.test(translatedBody)) return null;
  // A translated song may keep a name or phrase unchanged. Render that row
  // once while retaining alignment and the rest of the useful translation.
  const lines = translation.lines.map((text, index) => normalize(text) === normalize(original.lines[index]?.text) ? '' : text);
  return { ...translation, lines };
}
function activeTranslation(artifact, targetLanguage, song = {}) {
  const target = targetLanguage || storedLyricTranslationLanguage(artifact.translation);
  const decision = target ? getCurrentLyricTranslationDecision(artifact, song, { targetLanguage: target }) : null;
  if (decision?.status === 'not_needed') return null;
  const need = target ? resolveLyricTranslationNeed(artifact.original, song, { targetLanguage: target }) : null;
  // Old AI layers with unknown/contradictory source language have no proof of
  // translation rather than paraphrase. Reassess once through the allowed mode.
  const targetTag = /^zh(?:-|$)/u.test(target || '') ? 'zh' : target;
  const targetEvidence = target ? resolveLyricTranslationNeed(artifact.original, { ...song, language: targetTag }, { targetLanguage: target }) : null;
  if (artifact.translation?.source === 'ai' && need?.state === 'unknown' && decision?.status !== 'translated'
    && targetEvidence?.reason !== 'script_mismatch') return null;
  const effectiveSong = decision?.status === 'translated' && !decision.hasForeignPassages
    ? { ...song, language: decision.sourceLanguage } : song;
  return projectLyricTranslation(artifact.original, artifact.translation, { targetLanguage, song: effectiveSong });
}

export function resolveLyricTranslationState(artifact, song = {}, now = Date.now(), targetLanguage = null) {
  if (!artifact || artifact.status !== 'ready') return 'unavailable';
  if (artifact.aiCompletion?.status === 'failed'
    && artifact.aiCompletion.errorCode === 'language_update_failed') return 'failed';
  if (targetLanguage && hasCurrentLyricNoTranslationDecision(artifact, song, { targetLanguage })) return 'unavailable';
  if (!shouldAiCompleteLyrics(artifact.original, song, { targetLanguage: targetLanguage || 'zh' })
    && !activeTranslation(artifact, targetLanguage, song)) return 'unavailable';
  if (isFreshLyricAiPending(artifact.aiCompletion, now)) return 'pending';
  if (activeTranslation(artifact, targetLanguage, song)) return 'ready';
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
  const selectedTranslation = activeTranslation(artifact, targetLanguage, song);
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
