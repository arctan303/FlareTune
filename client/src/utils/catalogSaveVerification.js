import { catalogSongBody } from './catalogSongDraft.js';

// A matching audio path alone does not prove that the metadata write finished.
export function catalogSaveApplied(draft, song, { audioUrl, coverUrl, hasNewCover, keepExistingCover = false }) {
  if (!song || !audioUrl) return false;
  const expected = catalogSongBody({
    ...draft, cover_url: hasNewCover ? coverUrl : keepExistingCover ? song.cover_url : '',
  }, false);
  expected.audio_url = audioUrl;
  return ['title', 'artist', 'album', 'duration', 'language', 'audio_url', 'cover_url']
    .every((field) => field === 'duration'
      ? (song.duration == null ? null : Number(song.duration)) === expected.duration
      : (song[field] ?? null) === expected[field]);
}
