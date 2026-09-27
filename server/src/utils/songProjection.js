const RUNTIME_SONG_COLUMNS = Object.freeze([
  'id',
  'title',
  'artist',
  'album',
  'duration',
  'audio_url',
  'cover_url',
  'language',
]);

export function runtimeSongColumns(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return RUNTIME_SONG_COLUMNS.map((column) => `${prefix}${column}`).join(', ');
}
