// A one-way capability: retirement may stop only the playback captured while
// the plugin was current. It cannot act on a replacement source or owner.
export function capturePlaybackCleanup(playerStore) {
  const captured = playerStore.getState();
  const audio = captured.audioRef?.current;
  const song = captured.currentSong;
  const src = audio?.src;
  const generation = captured.playbackOwnershipGeneration;
  let cleaned = false;
  return () => {
    if (cleaned) return false;
    cleaned = true;
    const state = playerStore.getState();
    if (!audio || state.audioRef?.current !== audio || state.currentSong !== song
      || audio.src !== src || state.playbackOwnershipGeneration !== generation) return false;
    state.cancelPendingPlayback?.();
    if (!audio.paused) audio.pause();
    return true;
  };
}
