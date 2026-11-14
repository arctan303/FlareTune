import { artistFromSong, isYouTubeEntity } from './musicSource.js';

export function deriveTopArtists(songs = []) {
  const artistMap = new Map();
  for (const song of songs) {
    const name = (song.artist || '').trim();
    if (!name) continue;
    const reference = isYouTubeEntity(song) ? artistFromSong(song) : null;
    const key = JSON.stringify([reference ? 'youtube' : 'local', reference?.id || name]);
    const existing = artistMap.get(key) || { ...reference, name: reference?.name || name, songs: [], coverUrl: song.cover_url, playCount: 0 };
    existing.songs.push(song);
    existing.playCount += Number(song.play_count) || 1;
    if ((!existing.coverUrl || existing.coverUrl === '/placeholder-album.svg') && song.cover_url) {
      existing.coverUrl = song.cover_url;
    }
    artistMap.set(key, existing);
  }
  return Array.from(artistMap.values()).sort((a, b) => b.playCount - a.playCount);
}
