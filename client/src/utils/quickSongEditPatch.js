const editableFields = ['title', 'artist', 'album', 'language'];

const fieldValue = (key, value) => key === 'title'
  ? String(value || '').trim()
  : String(value || '').trim() || null;

export function createQuickSongPatch(song, draft, coverUrl = null) {
  const patch = Object.fromEntries(editableFields
    .map((key) => [key, fieldValue(key, draft[key])])
    .filter(([key, value]) => value !== fieldValue(key, song[key])));
  if (coverUrl) patch.cover_url = coverUrl;
  return patch;
}
