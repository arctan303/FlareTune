import { t } from '../i18n/index.js';
import React from 'react';
import { Disc3, UserRound } from 'lucide-react';
import { useUIStore } from '../store/useUIStore';
import { PLAYER_MODES, PLAYER_MODE_META } from '../constants/playerModes.js';

const VARIANT_CLASS = Object.freeze({
  classic: 'flex h-11 w-11 items-center justify-center rounded-full text-white/80 transition-all duration-200 hover:bg-white/10 hover:text-white active:scale-95 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-white',
  immersive: 'flex h-11 w-11 items-center justify-center rounded-full bg-black/30 text-white/85 backdrop-blur-md transition hover:bg-white/15 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70',
});

export default function PlayerSkinEntry({ variant = 'classic' }) {
  const playerMode = useUIStore((state) => state.playerMode);
  const setPlayerMode = useUIStore((state) => state.setPlayerMode);
  const nextMode = playerMode === PLAYER_MODES.CLASSIC ? PLAYER_MODES.CINEMATIC : PLAYER_MODES.CLASSIC;
  const currentLabel = t(PLAYER_MODE_META[playerMode]?.name || PLAYER_MODE_META[PLAYER_MODES.CLASSIC].name);
  const nextLabel = t(PLAYER_MODE_META[nextMode].name);
  const Icon = playerMode === PLAYER_MODES.CLASSIC ? Disc3 : UserRound;

  return (
    <div className="relative flex">
      <button
        type="button"
        data-player-skin-entry=""
        data-player-mode={playerMode}
        aria-label={t("当前{p0}，点击切换到{p1}", { p0: (currentLabel), p1: (nextLabel) })}
        onClick={() => setPlayerMode(nextMode)}
        className={`group ${VARIANT_CLASS[variant] || VARIANT_CLASS.classic}`}
      >
        <Icon size={19} strokeWidth={1.8} />
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 -translate-x-1 whitespace-nowrap !rounded-full px-3 py-2 text-xs opacity-0 shadow-xl transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 motion-reduce:transition-none ${variant === 'classic' ? 'glass-panel' : 'border border-white/10 bg-black/75 text-white backdrop-blur-xl'}`}
        >{t("当前：")}{currentLabel}
        </span>
      </button>
    </div>
  );
}
