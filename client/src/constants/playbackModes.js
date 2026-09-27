export const PLAYBACK_MODES = Object.freeze(['sequence', 'loop', 'single', 'random']);

export const PLAYBACK_MODE_NAMES = Object.freeze({
  sequence: '顺序播放',
  loop: '列表循环',
  single: '单曲循环',
  random: '随机播放',
});

export const isPlaybackMode = (mode) => PLAYBACK_MODES.includes(mode);
