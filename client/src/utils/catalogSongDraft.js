const editableFields = ['artist', 'album', 'duration', 'language', 'cover_url'];
const textOrNull = (value) => String(value ?? '').trim() || null;

export function catalogSongBody(draft, creating) {
  const result = { title: draft.title.trim() };
  if (creating) {
    result.id = draft.id;
    result.audio_url = draft.audio_url;
  }
  for (const key of editableFields) {
    result[key] = key === 'duration'
      ? (draft.duration === '' ? null : Number(draft.duration))
      : textOrNull(draft[key]);
  }
  return result;
}
