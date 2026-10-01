import { Clapperboard, Disc3 } from 'lucide-react';

export const PLAYER_MODE_STORAGE_KEY = 'musicPlayer_player_mode_v1';

export const PLAYER_MODES = Object.freeze({
  CLASSIC: 'classic',
  CINEMATIC: 'cinematic',
});

export const DEFAULT_PLAYER_MODE = PLAYER_MODES.CLASSIC;

export const AVAILABLE_PLAYER_MODES = Object.freeze([PLAYER_MODES.CLASSIC, PLAYER_MODES.CINEMATIC]);

export const isPlayerMode = (mode) => AVAILABLE_PLAYER_MODES.includes(mode);

// 设置页的形态元数据（名称 / 图标）
export const PLAYER_MODE_META = Object.freeze({
  [PLAYER_MODES.CLASSIC]: {
    name: '经典播放器',
    icon: Disc3,
  },
  [PLAYER_MODES.CINEMATIC]: {
    name: '歌手写真',
    icon: Clapperboard,
  },
});

export function readStoredPlayerMode() {
  try {
    const stored = localStorage.getItem(PLAYER_MODE_STORAGE_KEY);
    return isPlayerMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function getInitialPlayerMode() {
  const stored = readStoredPlayerMode();
  return stored || DEFAULT_PLAYER_MODE;
}

export function writeStoredPlayerMode(mode) {
  if (!isPlayerMode(mode)) return;
  try {
    localStorage.setItem(PLAYER_MODE_STORAGE_KEY, mode);
  } catch {
    // 存储不可用时形态仍可在当前会话生效
  }
}
