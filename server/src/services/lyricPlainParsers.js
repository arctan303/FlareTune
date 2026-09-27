import { parseDocument as parseYamlDocument } from 'yaml';
import { parseLrcLines } from '../utils/lyricsTranslation.js';
import { LYRIC_DOCUMENT_LIMITS, createLyricDocument } from '../utils/lyricDocument.js';
import { LyricSourceError } from './lyricSourceError.js';

const TIMELINE_RATIO_THRESHOLD = 0.6;

export function isBadLyricsData(lrc) {
  if (!lrc || typeof lrc !== 'string' || !lrc.trim()) return true;
  const units = parseLrcLines(lrc);
  if (units.length === 0) return true;
  const withTimeline = units.filter((unit) => unit.timestamps.length > 0).length;
  return (withTimeline / units.length) < TIMELINE_RATIO_THRESHOLD;
}

export function parseLyricsfile(lyricsfile, { providerMeta } = {}) {
  if (typeof lyricsfile !== 'string' || !lyricsfile.trim() || lyricsfile.length > LYRIC_DOCUMENT_LIMITS.maxLyricTextLength) {
    throw new LyricSourceError('invalid', 'lrclib', 'parse-lyricsfile', 'Lyricsfile is empty or exceeds safe size');
  }
  let value;
  try {
    const yaml = parseYamlDocument(lyricsfile, { maxAliasCount: 0, schema: 'core', uniqueKeys: true });
    if (yaml.errors.length > 0) throw yaml.errors[0];
    value = yaml.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new LyricSourceError('invalid', 'lrclib', 'parse-lyricsfile', 'Lyricsfile YAML is invalid', { cause: error });
  }
  if (!value || typeof value !== 'object' || String(value.version || '') !== '1.0') {
    throw new LyricSourceError('invalid', 'lrclib', 'parse-lyricsfile', 'Lyricsfile version is unsupported');
  }
  if (value.metadata?.instrumental === true) {
    return createLyricDocument({ source: 'lrclib', format: 'lyricsfile', lines: [], providerMeta });
  }
  const rawLines = Array.isArray(value.lines) ? value.lines : [];
  if (rawLines.length > LYRIC_DOCUMENT_LIMITS.maxLines) {
    throw new LyricSourceError('invalid', 'lrclib', 'parse-lyricsfile', 'Lyricsfile exceeds safe line count');
  }
  const rawWordCount = rawLines.reduce((count, line) => count + (Array.isArray(line?.words) ? line.words.length : 0), 0);
  if (rawWordCount > LYRIC_DOCUMENT_LIMITS.maxWords) {
    throw new LyricSourceError('invalid', 'lrclib', 'parse-lyricsfile', 'Lyricsfile exceeds safe word count');
  }
  const lines = rawLines.map((line) => {
    const rawWords = Array.isArray(line?.words) ? line.words : [];
    const words = rawWords.map((word, index) => {
      const deterministicEndMs = word?.end_ms ?? rawWords[index + 1]?.start_ms ?? line?.end_ms;
      return {
        text: word?.text,
        startTime: Number(word?.start_ms) / 1_000,
        endTime: deterministicEndMs === undefined || deterministicEndMs === null
          ? Number.NaN
          : Number(deterministicEndMs) / 1_000,
      };
    });
    return {
      text: line?.text,
      time: Number(line?.start_ms) / 1_000,
      endTime: line?.end_ms === undefined || line?.end_ms === null ? undefined : Number(line.end_ms) / 1_000,
      words: words.length > 0 ? words : undefined,
    };
  });
  if (lines.length > 0) {
    return createLyricDocument({ source: 'lrclib', format: 'lyricsfile', lines, providerMeta });
  }
  const plainLines = typeof value.plain === 'string'
    ? value.plain.split(/\r?\n/).filter((line) => line.trim()).map((line) => ({ text: line }))
    : [];
  return createLyricDocument({ source: 'lrclib', format: 'lyricsfile', lines: plainLines, providerMeta });
}
