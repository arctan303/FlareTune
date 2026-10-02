import { isValidSongLanguage } from '../utils/songLanguage.js';

const encoder = new TextEncoder();
const language = value => isValidSongLanguage(value) && !['other', 'instrumental'].includes(value) ? value : 'und';
const milliseconds = (seconds, offset) => Math.max(0, Math.round(seconds * 1000 + offset));

// Input is a canonical artifact validated by lyricArtifactStore. Expose only
// protocol fields; provider identifiers, AI state and account metadata stay private.
export function structuredLyrics(artifact, song, enhanced = false) {
  const lines = artifact?.status === 'ready' ? artifact.original.lines : [];
  if (!lines.length) return { lyricsList: { structuredLyrics: [] } };
  const offset = artifact.offsetMs || 0;
  const synced = artifact.original.syncMode !== 'none' && lines.every(line => Number.isFinite(line.time));
  const metadata = { displayArtist: song.artist || '', displayTitle: song.title };
  const main = { ...metadata, lang: enhanced ? language(song.language) : 'und', synced, offset: 0,
    line: lines.map(line => ({ value: line.text,
      ...(synced ? { start: milliseconds(line.time, offset) } : {}) })) };
  if (!enhanced) return { lyricsList: { structuredLyrics: [main] } };
  main.kind = 'main';
  const cueLines = [];
  if (synced) for (const [index, line] of lines.entries()) {
    if (!line.words?.length) continue;
    let position = 0;
    const cue = line.words.map(word => {
      const byteStart = position;
      // Offsets address the exact final cueLine.value, before XML escaping.
      position += encoder.encode(word.text).byteLength;
      return { value: word.text, start: milliseconds(word.startTime, offset),
        end: milliseconds(word.endTime, offset), byteStart, byteEnd: position - 1 };
    });
    cueLines.push({ index, start: milliseconds(line.time, offset),
      ...(Number.isFinite(line.endTime) ? { end: milliseconds(line.endTime, offset) } : {}),
      value: line.text, cue });
  }
  if (cueLines.length) main.cueLine = cueLines;
  const result = [main];
  const translation = artifact.translation;
  if (translation) {
    const translated = lines.map((line, index) => ({ ...line, text: translation.lines[index] }))
      .filter(line => line.text.trim());
    if (translated.length) {
      const translationSynced = artifact.original.syncMode !== 'none'
        && translated.every(line => Number.isFinite(line.time));
      // Existing provider translations and legacy AI assets without a language
      // follow the project's Chinese convention; unknown manual layers use und.
      const target = translation.language || (['kugou', 'netease', 'ai'].includes(translation.source) ? 'zh' : null);
      result.push({ ...metadata, lang: language(target), synced: translationSynced, offset: 0, kind: 'translation',
        line: translated.map(line => ({ value: line.text,
          ...(translationSynced ? { start: milliseconds(line.time, offset) } : {}) })) });
    }
  }
  return { lyricsList: { structuredLyrics: result } };
}
