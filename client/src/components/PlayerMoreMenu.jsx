import { t } from '../i18n/index.js';
import React from 'react';
import { FolderPlus, MoreHorizontal, Pencil, Languages } from 'lucide-react';
import { usePlayerStore } from '../store/usePlayerStore';
import { useUIStore } from '../store/useUIStore';
import PlayerModeChoices from './PlayerModeChoices.jsx';

/**
 * 播放器统一二级更多操作菜单 (支持向上下两个方向展开)
 * 收纳当前歌曲操作与歌词工作台；移动全屏时也提供明确的双形态选择。
 */
export default function PlayerMoreMenu({
    direction = 'up',
    showPlayerModes = false,
}) {
    const [isOpen, setIsOpen] = React.useState(false);
    const [mounted, setMounted] = React.useState(false);
    const [visible, setVisible] = React.useState(false);
    const moreButtonRef = React.useRef(null);
    const iconStrokeWidth = 1.75;
    const isDown = direction === 'down';

    React.useEffect(() => {
        if (isOpen) {
            setMounted(true);
            const rafId = requestAnimationFrame(() => {
                setVisible(true);
            });
            return () => cancelAnimationFrame(rafId);
        }
        setVisible(false);
        const timer = setTimeout(() => {
            setMounted(false);
        }, 180);
        return () => clearTimeout(timer);
    }, [isOpen]);

    const isAuthenticated = useUIStore((state) => Boolean(state.authSession.authenticated));
    const isAdmin = useUIStore((state) => Boolean(state.authSession.authenticated) && state.authSession?.user?.role === 'admin');
    const currentSong = usePlayerStore((state) => state.currentSong);
    const openAddToPlaylist = useUIStore((state) => state.openAddToPlaylist);
    const openQuickSongEdit = useUIStore((state) => state.openQuickSongEdit);
    const openLyricsWorkspace = useUIStore((state) => state.openLyricsWorkspace);
    const playerMode = useUIStore((state) => state.playerMode);
    const setPlayerMode = useUIStore((state) => state.setPlayerMode);

    return (
        <div className="relative inline-flex items-center shrink-0" onClick={(event) => event.stopPropagation()}>
            <button
                ref={moreButtonRef}
                type="button"
                aria-label={t("更多操作")}
                aria-expanded={isOpen}
                aria-haspopup="menu"
                onClick={() => setIsOpen((prev) => !prev)}
                className={`w-7 h-6 inline-flex items-center justify-center text-white/70 hover:text-white transition-colors active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70 cursor-pointer shrink-0 ${isOpen ? 'text-white' : ''}`}
                title={t("更多操作")}
            >
                <MoreHorizontal size={20} strokeWidth={2} />
            </button>

            {mounted && (
                <>
                    <div
                        className={`fixed inset-0 z-40 transition-opacity duration-200 ${
                            visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                        }`}
                        onClick={() => setIsOpen(false)}
                    />
                    <div
                        role="menu"
                        aria-label={t("播放器更多操作")}
                        className={`classic-controls__menu absolute right-0 glass-panel !rounded-2xl p-2 flex flex-col gap-1 w-52 shadow-2xl z-50 transform origin-${
                            isDown ? 'top-right' : 'bottom-right'
                        } transition-all duration-200 ease-out ${
                            isDown ? 'top-full mt-2' : 'bottom-full mb-2'
                        } ${
                            visible ? 'scale-100 opacity-100' : 'scale-[0.96] opacity-0 pointer-events-none'
                        }`}
                    >
                        {showPlayerModes && (
                            <div role="group" aria-label={t("播放器形态")} className="border-b border-white/10 pb-1 mb-1">
                                <PlayerModeChoices
                                    currentMode={playerMode}
                                    onSelect={(mode) => {
                                        setIsOpen(false);
                                        if (mode !== playerMode) setPlayerMode(mode);
                                    }}
                                />
                            </div>
                        )}

                        {isAuthenticated && currentSong?.id && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setIsOpen(false);
                                    openAddToPlaylist(currentSong);
                                }}
                                className="classic-controls__menu-item flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all text-gray-300 hover:text-white hover:bg-white/10 text-left focus:outline-none cursor-pointer"
                            >
                                <div className="classic-controls__menu-icon shrink-0 text-white/70">
                                    <FolderPlus size={16} strokeWidth={iconStrokeWidth} />
                                </div>
                                <span>{t("加入歌单")}</span>
                            </button>
                        )}

                        {isAdmin && currentSong?.id && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setIsOpen(false);
                                    openQuickSongEdit(currentSong.id, moreButtonRef.current);
                                }}
                                className="classic-controls__menu-item flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all text-gray-300 hover:text-white hover:bg-white/10 text-left focus:outline-none cursor-pointer"
                            >
                                <div className="classic-controls__menu-icon shrink-0 text-white/70">
                                    <Pencil size={16} strokeWidth={iconStrokeWidth} />
                                </div>
                                <span>{t("编辑歌曲信息")}</span>
                            </button>
                        )}

                        {isAuthenticated && currentSong?.id && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    openLyricsWorkspace(currentSong);
                                    setIsOpen(false);
                                }}
                                className="classic-controls__menu-item flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all text-gray-300 hover:text-white hover:bg-white/10 text-left focus:outline-none cursor-pointer"
                                title={t("打开歌词工作台")}
                            >
                                <div className="classic-controls__menu-icon shrink-0 text-white/70">
                                    <Languages size={16} strokeWidth={iconStrokeWidth} />
                                </div>
                                <span>{t("歌词工作台")}</span>
                            </button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
