export const normalizeSong = (song) => ({
  id: String(song.id),
  title: String(song.title || ''),
  artist: String(song.artist || ''),
  album: song.album || '',
  duration: Number(song.duration) || 0,
  audio_url: song.audio_url || '',
  cover_url: song.cover_url || '',
  language: song.language || null,
  ...(song.source === 'youtube' && /^yt:[A-Za-z0-9_-]{11}$/.test(String(song.id)) ? {
    source: 'youtube', sourceId: song.sourceId,
    artists: song.artists || [], albumId: song.albumId || null,
  } : {}),
});
