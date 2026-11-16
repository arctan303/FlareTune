import { isLeadingProviderMetadata, isSingableLineText } from '../utils/lyricDocument.js';
import { isValidSongLanguage } from '../utils/songLanguage.js';
import { isValidLyricTranslationTarget } from '../../../shared/lyricSources.js';

export const LYRIC_TRANSLATION_POLICY_VERSION = 2;
const emptyLyric = /^(?:暂无歌词|无歌词|纯音乐(?:\s*[，,、-]?\s*请欣赏)?|此歌曲为纯音乐)[。.!！]?$/u;
const spoken = language => /^zh(?:-|$)/u.test(language || '') ? 'zh' : language;
const tagOf = song => isValidSongLanguage(song?.language) && !['other', 'instrumental'].includes(song.language) ? song.language : null;
const targetOf = language => ['zh-CN', 'zh-Hans'].includes(language) ? 'zh'
  : ['zh-TW', 'zh-HK'].includes(language) ? 'zh-Hant' : language;

export function meaningfulLyricLines(original, song = {}) {
  return (original?.lines || []).map((line, index) => ({ line, index, text: String(line?.text || '').trim() }))
    .filter(({ line, index, text }) => !isLeadingProviderMetadata(line, index, song)
      && text && !emptyLyric.test(text) && isSingableLineText(text, song));
}

// A valid catalog tag identifies the song's dominant language. Foreign inserts
// do not reopen classification or create a translation for a same-target song.
// Missing tags are classified once by the workbench's separate AI role.
export function resolveLyricTranslationNeed(original, song = {}, { targetLanguage = 'zh' } = {}) {
  const sourceLanguage = tagOf(song);
  const result = (state, reason) => ({ state, reason, sourceLanguage });
  if (song.language === 'instrumental') return result('not_needed', 'instrumental');
  const meaningful = meaningfulLyricLines(original, song);
  if (!meaningful.length) return result('not_needed', 'empty');
  if (!isValidLyricTranslationTarget(targetOf(targetLanguage))) return result('unknown', 'invalid_target');
  if (!sourceLanguage) return result('unknown', 'unknown_language');
  return result(spoken(sourceLanguage) === spoken(targetLanguage) ? 'not_needed' : 'needed', 'catalog_language');
}

export function getCurrentLyricTranslationDecision(artifact, song = {}, { targetLanguage = 'zh' } = {}) {
  const decision = artifact?.translationDecision;
  if (!decision || artifact.status !== 'ready'
    || artifact.aiCompletion?.status === 'failed' && artifact.aiCompletion.errorCode === 'language_update_failed'
    || decision.policyVersion !== LYRIC_TRANSLATION_POLICY_VERSION
    || decision.textHash !== artifact.textHash || decision.targetLanguage !== targetOf(targetLanguage)
    || decision.songLanguage !== tagOf(song) || !['not_needed', 'needed', 'translated'].includes(decision.status)
    || !['tag', 'ai', 'rules'].includes(decision.basis)) return null;
  if (decision.basis === 'rules') return decision.status === 'not_needed'
    && resolveLyricTranslationNeed(artifact.original, song, { targetLanguage }).reason === 'empty' ? decision : null;
  if (!tagOf({ language: decision.sourceLanguage })) return null;
  if (decision.status === 'not_needed' && spoken(decision.sourceLanguage) !== spoken(targetLanguage)) return null;
  if (decision.status !== 'not_needed' && spoken(decision.sourceLanguage) === spoken(targetLanguage)) return null;
  if (decision.basis === 'tag' && (decision.sourceLanguage !== tagOf(song)
    || resolveLyricTranslationNeed(artifact.original, song, { targetLanguage }).state
      !== (decision.status === 'not_needed' ? 'not_needed' : 'needed'))) return null;
  return decision;
}

export const hasCurrentLyricNoTranslationDecision = (artifact, song, options) =>
  getCurrentLyricTranslationDecision(artifact, song, options)?.status === 'not_needed';

export function buildLyricTranslationDecision(artifact, song = {}, {
  status = 'translated', targetLanguage = 'zh', sourceLanguage = null, basis = 'ai', hasForeignPassages = false,
} = {}) {
  const decision = { status, textHash: artifact.textHash, targetLanguage: targetOf(targetLanguage),
    policyVersion: LYRIC_TRANSLATION_POLICY_VERSION, songLanguage: tagOf(song), sourceLanguage, basis,
    ...(hasForeignPassages ? { hasForeignPassages: true } : {}) };
  if (!isValidLyricTranslationTarget(decision.targetLanguage) || !['tag', 'ai', 'rules'].includes(basis)
    || !getCurrentLyricTranslationDecision({ ...artifact, translationDecision: decision }, song, { targetLanguage })) {
    throw new TypeError('INVALID_LYRIC_TRANSLATION_DECISION');
  }
  return decision;
}

export const buildLyricNoTranslationDecision = (artifact, song, options) =>
  buildLyricTranslationDecision(artifact, song, { ...options, status: 'not_needed' });
