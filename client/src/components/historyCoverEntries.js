export function reconcileHistoryCoverEntries(songs, current = [], arriving = null) {
  const currentBySong = new Map(current.map((entry) => [entry.song.id, entry]));
  return songs.map((song) => {
    const retained = arriving?.song.id === song.id ? arriving : currentBySong.get(song.id);
    return retained?.song.cover_url === song.cover_url
      ? { ...retained, song }
      : { key: `song-${song.id}`, song, ready: false };
  });
}
