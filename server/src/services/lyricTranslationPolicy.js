import { isLeadingProviderMetadata, isSingableLineText } from '../utils/lyricDocument.js';
import { isValidSongLanguage } from '../utils/songLanguage.js';
import { isValidLyricTranslationTarget } from '../../../shared/lyricSources.js';

export const LYRIC_TRANSLATION_POLICY_VERSION = 1;
const emptyLyric = /^(?:暂无歌词|无歌词|纯音乐(?:\s*[，,、-]?\s*请欣赏)?|此歌曲为纯音乐)[。.!！]?$/u;
const spoken = language => /^zh(?:-|$)/u.test(language || '') ? 'zh' : language;
const tagOf = song => isValidSongLanguage(song?.language) && !['other', 'instrumental'].includes(song.language) ? song.language : null;
const targetOf = language => ['zh-CN', 'zh-Hans'].includes(language) ? 'zh'
  : ['zh-TW', 'zh-HK'].includes(language) ? 'zh-Hant' : language;
const patterns = { han: /\p{Script=Han}/u, kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  hangul: /\p{Script=Hangul}/u, latin: /\p{Script=Latin}/u, cyrillic: /\p{Script=Cyrillic}/u, thai: /\p{Script=Thai}/u };
const latinLanguages = new Set(['en', 'es', 'fr', 'de', 'sv', 'vi', 'it', 'pt']);

export function meaningfulLyricLines(original, song = {}) {
  return (original?.lines || []).map((line, index) => ({ line, index, text: String(line?.text || '').trim() }))
    .filter(({ line, index, text }) => !isLeadingProviderMetadata(line, index, song)
      && text && !emptyLyric.test(text) && isSingableLineText(text, song));
}

// Catalog tags are the default authority. Script checks only send obvious
// contradictions or mixed passages to the allowed AI request; they never
// identify English/French/etc. from a Latin alphabet or rewrite catalog tags.
export function resolveLyricTranslationNeed(original, song = {}, { targetLanguage = 'zh' } = {}) {
  const sourceLanguage = tagOf(song);
  const result = (state, reason) => ({ state, reason, sourceLanguage });
  if (song.language === 'instrumental') return result('not_needed', 'instrumental');
  const meaningful = meaningfulLyricLines(original, song);
  if (!meaningful.length) return result('not_needed', 'empty');
  if (!isValidLyricTranslationTarget(targetOf(targetLanguage))) return result('unknown', 'invalid_target');
  if (!sourceLanguage) return result('unknown', 'unknown_language');
  const text = meaningful.map(line => line.text).join('\n');
  const has = name => patterns[name].test(text);
  const expected = ['zh', 'yue'].includes(sourceLanguage) ? has('han')
    : sourceLanguage === 'ja' ? has('han') || has('kana')
      : sourceLanguage === 'ko' ? has('hangul') : sourceLanguage === 'ru' ? has('cyrillic')
        : sourceLanguage === 'th' ? has('thai') : latinLanguages.has(sourceLanguage) ? has('latin') : false;
  if (!expected) return result('unknown', 'script_mismatch');
  const latinPassage = meaningful.some(({ text: line }) => patterns.latin.test(line)
    && !(patterns.han.test(line) && [...line.matchAll(/\p{Script=Latin}+/gu)].length === 1));
  const mixed = ['zh', 'yue'].includes(sourceLanguage) ? has('kana') || has('hangul') || has('cyrillic') || has('thai') || latinPassage
    : sourceLanguage === 'ja' ? has('hangul') || has('cyrillic') || has('thai') || latinPassage
      : sourceLanguage === 'ko' ? has('kana') || has('cyrillic') || has('thai') || latinPassage
        : sourceLanguage === 'ru' ? has('han') || has('kana') || has('hangul') || has('thai') || has('latin')
          : sourceLanguage === 'th' ? has('han') || has('kana') || has('hangul') || has('cyrillic') || has('latin')
            : has('han') || has('kana') || has('hangul') || has('cyrillic') || has('thai');
  if (mixed) return result('unknown', 'mixed_content');
  return result(spoken(sourceLanguage) === spoken(targetLanguage) ? 'not_needed' : 'needed', 'catalog_language');
}

export function getCurrentLyricTranslationDecision(artifact, song = {}, { targetLanguage = 'zh' } = {}) {
  const decision = artifact?.translationDecision;
  if (!decision || artifact.status !== 'ready'
    || artifact.aiCompletion?.status === 'failed' && artifact.aiCompletion.errorCode === 'language_update_failed'
    || decision.policyVersion !== LYRIC_TRANSLATION_POLICY_VERSION
    || decision.textHash !== artifact.textHash || decision.targetLanguage !== targetOf(targetLanguage)
    || decision.songLanguage !== tagOf(song) || !['not_needed', 'translated'].includes(decision.status)
    || !['tag', 'ai', 'rules'].includes(decision.basis)) return null;
  if (decision.basis === 'rules') return decision.status === 'not_needed'
    && resolveLyricTranslationNeed(artifact.original, song, { targetLanguage }).reason === 'empty' ? decision : null;
  if (!tagOf({ language: decision.sourceLanguage })) return null;
  if (decision.status === 'not_needed' && spoken(decision.sourceLanguage) !== spoken(targetLanguage)) return null;
  if (decision.status === 'translated' && spoken(decision.sourceLanguage) === spoken(targetLanguage)
    && decision.hasForeignPassages !== true) return null;
  if (decision.basis === 'tag' && (decision.sourceLanguage !== tagOf(song)
    || resolveLyricTranslationNeed(artifact.original, song, { targetLanguage }).state !== 'not_needed')) return null;
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
  // An AI no-op must not turn a plainly foreign script into a permanent miss.
  if (basis === 'ai' && status === 'not_needed'
    && resolveLyricTranslationNeed(artifact.original, { ...song, language: sourceLanguage }, { targetLanguage }).reason === 'script_mismatch') {
    throw new TypeError('INVALID_LYRIC_TRANSLATION_DECISION');
  }
  return decision;
}

export const buildLyricNoTranslationDecision = (artifact, song, options) =>
  buildLyricTranslationDecision(artifact, song, { ...options, status: 'not_needed' });
