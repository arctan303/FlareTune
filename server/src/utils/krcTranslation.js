const LANGUAGE_TAG_PATTERN = /^\[language:([^\]\r\n]+)]\s*$/mi;
const SEMANTIC_TEXT_PATTERN = /[\p{L}\p{N}]/u;

function decodeLanguagePayload(encoded, maximumBytes) {
  const binary = atob(encoded);
  if (binary.length > maximumBytes) throw new RangeError('KRC language block exceeds safe size');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function normalizeTranslationRows(rows, expectedLineCount, maximumLineLength) {
  if (!Array.isArray(rows) || rows.length !== expectedLineCount) return null;
  const translations = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.some((part) => typeof part !== 'string')) return null;
    const text = row.join('').trim();
    if (text.length > maximumLineLength || /[\r\n]/u.test(text)) return null;
    translations.push(text);
  }
  return translations.some((text) => SEMANTIC_TEXT_PATTERN.test(text)) ? translations : null;
}

export function parseKrcTranslationLines(krcText, expectedLineCount, {
  maximumBytes = 2_000_000,
  maximumLineLength = 4_000,
} = {}) {
  if (!Number.isInteger(expectedLineCount) || expectedLineCount <= 0) return null;
  const encoded = String(krcText || '').match(LANGUAGE_TAG_PATTERN)?.[1];
  if (!encoded) return null;
  try {
    const payload = decodeLanguagePayload(encoded, maximumBytes);
    if (!payload || !Array.isArray(payload.content)) return null;
    for (const entry of payload.content) {
      if (Number(entry?.type) !== 1) continue;
      const translations = normalizeTranslationRows(
        entry.lyricContent,
        expectedLineCount,
        maximumLineLength,
      );
      if (translations) return translations;
    }
  } catch {
    return null;
  }
  return null;
}
