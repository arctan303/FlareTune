import { t } from '../i18n/index.js';
import React from 'react';
import { Languages } from 'lucide-react';
import { useUIStore } from '../store/useUIStore';
import { usePlayerStore } from '../store/usePlayerStore.js';

const VARIANT_CLASS = Object.freeze({
  immersive: 'flex h-11 w-11 items-center justify-center rounded-full bg-black/30 text-white/75 backdrop-blur-md transition hover:bg-white/15 hover:text-white focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70',
});

export default function LyricsWorkspaceEntry({ variant = 'immersive' }) {
  const isAuthenticated = useUIStore((state) => Boolean(state.authSession.authenticated));
  const openLyricsWorkspace = useUIStore((state) => state.openLyricsWorkspace);
  const currentSong = usePlayerStore((state) => state.currentSong);

  if (!isAuthenticated || !currentSong?.id) return null;

  return (
    <button
      type="button"
      aria-label={t("歌词工作台")}
      title={t("歌词工作台")}
      onClick={() => openLyricsWorkspace(currentSong)}
      className={VARIANT_CLASS[variant] || VARIANT_CLASS.immersive}
    >
      <Languages size={18} />
    </button>
  );
}
