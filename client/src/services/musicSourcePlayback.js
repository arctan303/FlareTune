// The host owns the audio element. Retire only the source being invalidated;
// cancelling pending playback also covers a paused element waiting for canplay.
export function pauseRetiredMusicSourcePlayback(playerStore, matches, audioRef) {
  const player = playerStore.getState();
  const selectedSong = player.currentSong;
  if (!selectedSong || typeof matches !== 'function') return false;
  let matching;
  try { matching = matches(JSON.parse(JSON.stringify(selectedSong))) === true; }
  catch { return false; }
  if (!matching || playerStore.getState().currentSong !== selectedSong) return false;
  player.cancelPendingPlayback();
  if (playerStore.getState().currentSong === selectedSong) (audioRef?.current || player.audioRef?.current)?.pause();
  return true;
}
