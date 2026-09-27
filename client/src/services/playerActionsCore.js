export function createInsertNextWithFeedback({ getPlayerState, notify, emitBounce }) {
  return (song, event) => {
    event?.stopPropagation();
    const player = getPlayerState();
    const hadCurrentSong = Boolean(player.currentSong);
    if (!player.insertAndPlay(song, null)) return false;

    notify(hadCurrentSong
      ? `已将《${song.title}》插播为下一首`
      : `已开始播放《${song.title}》`);
    emitBounce();
    return true;
  };
}
