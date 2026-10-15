import { t } from '../i18n/index.js';
export function createInsertNextWithFeedback({ getPlayerState, notify, emitBounce }) {
  return (song, event) => {
    event?.stopPropagation();
    const player = getPlayerState();
    const hadCurrentSong = Boolean(player.currentSong);
    if (!player.insertAndPlay(song, null)) return false;

    notify(hadCurrentSong
      ? t("已将《{p0}》插播为下一首", { p0: (song.title) })
      : t("已开始播放《{p0}》", { p0: (song.title) }));
    emitBounce();
    return true;
  };
}
