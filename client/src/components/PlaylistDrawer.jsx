import { t } from '../i18n/index.js';
import React from 'react';
import { X, Trash2, ListMusic, Compass, Loader2, RotateCcw, GripVertical, Disc } from 'lucide-react';
import { usePlayerStore } from '../store/usePlayerStore';
import { useUIStore, showToast } from '../store/useUIStore';
import QualityBadge from './QualityBadge';
import LazyImage from './LazyImage';
import { useShallow } from 'zustand/react/shallow';
import { getCenteredQueueScrollTop } from '../utils/queueScroll';
import useVerticalReorderDrag from '../hooks/useVerticalReorderDrag.js';
import DrawerFrame from './drawers/DrawerFrame';
import { useDrawerTransition } from './drawers/useDrawerTransition';


export default function PlaylistDrawer() {
    const {
        playlist,
        currentSong,
        isPlaying,
        clearPlaylist,
        playSong,
        removePlaylistSong,
        reorderPlaylist,
        randomRoam,
        setRandomRoamEnabled,
        retryRandomRoam,
        triggerManualRandomRoam,
    } = usePlayerStore(useShallow((state) => ({
        playlist: state.playlist,
        currentSong: state.currentSong,
        isPlaying: state.isPlaying,
        clearPlaylist: state.clearPlaylist,
        playSong: state.playSong,
        removePlaylistSong: state.removePlaylistSong,
        reorderPlaylist: state.reorderPlaylist,
        randomRoam: state.randomRoam,
        setRandomRoamEnabled: state.setRandomRoamEnabled,
        retryRandomRoam: state.retryRandomRoam,
        triggerManualRandomRoam: state.triggerManualRandomRoam,
    })));
    const { isPlaylistOpen, setIsPlaylistOpen, isFullScreen, authenticated } = useUIStore(useShallow((state) => ({
        isPlaylistOpen: state.isPlaylistOpen,
        setIsPlaylistOpen: state.setIsPlaylistOpen,
        isFullScreen: state.isFullScreen,
        authenticated: Boolean(state.authSession.authenticated),
    })));

    const { mounted, visible, onPanelTransitionEnd } = useDrawerTransition(isPlaylistOpen);
    const closeButtonRef = React.useRef(null);
    const previousFocusRef = React.useRef(null);
    const queueScrollRef = React.useRef(null);
    const activeRowRef = React.useRef(null);
    const queuePositionFrameRef = React.useRef(null);
    const positionedForOpenRef = React.useRef(false);
    const prevPlaylistLengthRef = React.useRef(playlist.length);
    const [newlyAddedCutoff, setNewlyAddedCutoff] = React.useState(null);

    React.useEffect(() => {
        if (playlist.length > prevPlaylistLengthRef.current) {
            setNewlyAddedCutoff(prevPlaylistLengthRef.current);
            if (prevPlaylistLengthRef.current > 0 && queueScrollRef.current) {
                const container = queueScrollRef.current;
                container.scrollTo({
                    top: container.scrollTop + 180,
                    behavior: 'smooth',
                });
            }
            const timer = setTimeout(() => {
                setNewlyAddedCutoff(null);
            }, 1200);
            prevPlaylistLengthRef.current = playlist.length;
            return () => clearTimeout(timer);
        }
        prevPlaylistLengthRef.current = playlist.length;
    }, [playlist.length]);
    const {
        dragState,
        beginPointerDrag,
        clearDrag,
        getRowStyle,
    } = useVerticalReorderDrag({
        items: playlist,
        scrollRef: queueScrollRef,
        getRow: (handle) => handle.closest('.queue-row'),
        getRowStride: (row) => {
            if (!row) return 62;
            return (row.offsetHeight || 56) + 6;
        },
        onCommit: ({ fromIndex, toIndex }) => reorderPlaylist(fromIndex, toIndex),
        edgeThreshold: 48,
        edgeMaxSpeed: 16,
    });
    const isRoamLibraryQueued = randomRoam.enabled
        && randomRoam.exhausted;
    const handleRoamToggle = () => {
        const nextEnabled = !randomRoam.enabled;
        setRandomRoamEnabled(nextEnabled);
        if (nextEnabled) {
            showToast(playlist.length === 0 ? '已开启随机漫游，正在载入歌曲…' : '已开启队尾随机续播');
        } else {
            showToast(t("已关闭队尾随机续播"));
        }
    };

    const handleManualRoamAppend = () => {
        if (!authenticated) {
            showToast(t("请先登录后体验漫游功能"));
            return;
        }
        if (randomRoam.status === 'loading') return;
        triggerManualRandomRoam();
        showToast(t("正在补充 {p0} 首漫游歌曲…", { p0: (randomRoam.batchSize || 10) }));
    };

    React.useEffect(() => {
        if (!isPlaylistOpen) clearDrag();
    }, [clearDrag, isPlaylistOpen]);
    React.useEffect(() => {
        if (isPlaylistOpen && mounted) {
            previousFocusRef.current = document.activeElement;
            requestAnimationFrame(() => closeButtonRef.current?.focus());
        } else if (previousFocusRef.current instanceof HTMLElement) {
            previousFocusRef.current.focus();
            previousFocusRef.current = null;
        }
    }, [isPlaylistOpen, mounted]);

    React.useEffect(() => {
        if (!isPlaylistOpen) return undefined;
        const handleEscape = (event) => {
            if (event.key === 'Escape') setIsPlaylistOpen(false);
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [isPlaylistOpen, setIsPlaylistOpen]);

    React.useEffect(() => {
        if (!isPlaylistOpen) {
            positionedForOpenRef.current = false;
            if (queuePositionFrameRef.current !== null) {
                cancelAnimationFrame(queuePositionFrameRef.current);
                queuePositionFrameRef.current = null;
            }
            return undefined;
        }
        if (!mounted || positionedForOpenRef.current || !queueScrollRef.current) return undefined;

        queuePositionFrameRef.current = requestAnimationFrame(() => {
            const container = queueScrollRef.current;
            if (!container) return;

            const activeRow = activeRowRef.current;
            let top = 0;
            if (activeRow) {
                const containerRect = container.getBoundingClientRect();
                const activeRowRect = activeRow.getBoundingClientRect();
                const itemTop = container.scrollTop + activeRowRect.top - containerRect.top;
                top = getCenteredQueueScrollTop({
                    itemTop,
                    itemHeight: activeRowRect.height,
                    viewportHeight: container.clientHeight,
                    scrollHeight: container.scrollHeight,
                });
            }

            container.scrollTo({ top, behavior: 'auto' });
            positionedForOpenRef.current = true;
            queuePositionFrameRef.current = null;
        });

        return () => {
            if (queuePositionFrameRef.current !== null) {
                cancelAnimationFrame(queuePositionFrameRef.current);
                queuePositionFrameRef.current = null;
            }
        };
    }, [currentSong?.id, isPlaylistOpen, mounted, playlist.length]);

    return (
        <DrawerFrame
            visible={visible}
            hidden={!mounted && !isPlaylistOpen}
            isFullScreen={isFullScreen}
            labelledBy="playlist-drawer-title"
            onClose={() => setIsPlaylistOpen(false)}
            onPanelTransitionEnd={onPanelTransitionEnd}
            panelClassName="sm:w-[380px]"
        >
            {(mounted || isPlaylistOpen) && (
            <>
            {/* 遮罩 */}

            {/* 抽屉面板 - 右侧滑入 */}
                
                {/* 当前播放队列 */}
                <div className="theme-drawer__header px-4 py-3 border-b border-current/10">
                    <div className="w-full flex items-center justify-between gap-2">
                        <h2 id="playlist-drawer-title" className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
                            <ListMusic size={17} aria-hidden="true" />{' '}{t("当前播放")}{' '}<span className="text-xs text-[var(--muted)]">({playlist.length})</span>
                        </h2>
                        <button
                            ref={closeButtonRef}
                            aria-label={t("关闭播放列表")}
                            onClick={() => setIsPlaylistOpen(false)}
                            className="theme-drawer__close !w-8 !h-8 !min-w-[32px] !min-h-[32px] !rounded-xl !border-transparent !bg-transparent flex items-center justify-center text-[var(--muted)] hover:text-[var(--ink)] hover:!bg-current/10 transition-all shrink-0 cursor-pointer"
                        >
                            <X size={15} strokeWidth={2.2} />
                        </button>
                    </div>
                </div>

                <>
                        {/* 歌曲列表 */}
                        <div ref={queueScrollRef} className="flex-1 overflow-y-auto custom-scrollbar p-3">
                            {playlist.length === 0 ? (
                                <div className="theme-empty text-center py-20 flex flex-col items-center justify-center">
                                    <ListMusic size={48} className="mx-auto mb-4 opacity-30" strokeWidth={1} />
                                    <p className="text-sm text-[var(--muted)] mb-3">{t("列表是空的")}</p>
                                    <button
                                        type="button"
                                        onClick={handleManualRoamAppend}
                                        disabled={randomRoam.status === 'loading'}
                                        className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-contrast,white)] text-xs font-semibold hover:opacity-90 transition-all cursor-pointer shadow-sm disabled:opacity-50"
                                    >
                                        <span>{randomRoam.status === 'loading' ? t("正在载入漫游歌曲…") : t("开启随机漫游 ({p0} 首)", { p0: (randomRoam.batchSize || 10) })}</span>
                                    </button>
                                    {randomRoam.status === 'loading' && (
                                        <div className="mt-6 w-full max-w-xs animate-roam-loading-expand space-y-2 text-left">
                                            {[1, 2].map((n) => (
                                                <div
                                                    key={`empty-skeleton-${n}`}
                                                    className="relative overflow-hidden flex items-center gap-3 p-2 rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5"
                                                >
                                                    <div className="absolute inset-0 -translate-x-full animate-roam-shimmer bg-gradient-to-r from-transparent via-white/10 dark:via-white/5 to-transparent pointer-events-none" />
                                                    <div className="w-9 h-9 rounded-lg bg-black/10 dark:bg-white/10 shrink-0 flex items-center justify-center text-current/30">
                                                        <Disc size={16} className="animate-spin-slow opacity-40" />
                                                    </div>
                                                    <div className="flex-1 space-y-1.5 py-0.5">
                                                        <div className="h-3 bg-black/15 dark:bg-white/15 rounded-md w-3/5" />
                                                        <div className="h-2 bg-black/10 dark:bg-white/10 rounded-md w-2/5" />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="flex flex-col gap-1.5">
                                    {playlist.map((song, index) => {
                                        const isActive = currentSong?.id === song.id;
                                        const isDraggingCard = Boolean(dragState && !dragState.settling && index === dragState.startIndex);
                                        const isNewlyAdded = newlyAddedCutoff !== null && index >= newlyAddedCutoff && !isDraggingCard;

                                        return (
                                            <div
                                                key={song.id}
                                                ref={isActive ? activeRowRef : null}
                                                data-song-id={song.id}
                                                style={{
                                                    ...getRowStyle(index),
                                                    ...(isNewlyAdded ? {
                                                        animationDelay: `${Math.min(index - newlyAddedCutoff, 8) * 40}ms`,
                                                    } : {}),
                                                }}
                                                className={`queue-row group relative flex items-center gap-3 rounded-xl p-2 transition-colors ${
                                                    isActive ? 'is-active' : ''
                                                } ${isDraggingCard ? 'is-drag-active' : ''} ${
                                                    isNewlyAdded ? 'animate-roam-song-enter' : ''
                                                }`}
                                            >
                                                {/* 封面与播放态指示 */}
                                                <div
                                                    onClick={() => playSong(song)}
                                                    className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-current/10 cursor-pointer"
                                                >
                                                    <LazyImage
                                                        src={song.cover_url || '/placeholder-album.svg'}
                                                        alt={song.title}
                                                        className="h-full w-full object-cover"
                                                    />
                                                    {isActive && (
                                                        <div className="queue-row__overlay absolute inset-0 flex items-center justify-center">
                                                            <div className="flex items-end gap-0.5 h-3">
                                                                <span className={`w-0.5 bg-white rounded-full ${isPlaying ? 'animate-bounce' : 'h-2'}`} style={{ animationDuration: '0.6s' }} />
                                                                <span className={`w-0.5 bg-white rounded-full ${isPlaying ? 'animate-bounce' : 'h-3'}`} style={{ animationDuration: '0.8s', animationDelay: '0.2s' }} />
                                                                <span className={`w-0.5 bg-white rounded-full ${isPlaying ? 'animate-bounce' : 'h-1.5'}`} style={{ animationDuration: '0.7s', animationDelay: '0.4s' }} />
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>

                                                {/* 歌曲信息 */}
                                                <div
                                                    onClick={() => playSong(song)}
                                                    className="min-w-0 flex-1 cursor-pointer"
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <p className="queue-row__title truncate text-sm font-medium">{song.title}</p>
                                                        <QualityBadge song={song} />
                                                    </div>
                                                    <p className="queue-row__artist truncate text-xs">{song.artist}</p>
                                                </div>

                                                {/* 移出播放列表按钮 */}
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        removePlaylistSong(index);
                                                    }}
                                                    className="queue-row__action relative z-[2] opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 rounded-lg text-current/50 hover:text-red-400 hover:bg-current/10 transition-all flex-shrink-0"
                                                    title={t("从播放列表移出")}
                                                    aria-label={t("从播放列表移出 {p0}", { p0: (song.title) })}
                                                >
                                                    <X size={15} />
                                                </button>

                                                {/* 拖拽手柄 */}
                                                {playlist.length > 1 && (
                                                    <button
                                                        type="button"
                                                        onPointerDown={(event) => {
                                                            event.stopPropagation();
                                                            beginPointerDrag(song.id, index, event);
                                                        }}
                                                        className="queue-row__drag relative z-[2] flex-shrink-0 touch-none select-none"
                                                        title={t("按住拖拽调整排序")}
                                                        aria-label={t("按住拖拽调整 {p0} 排序", { p0: (song.title) })}
                                                    >
                                                        <GripVertical size={16} />
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}

                                    {/* 歌曲队列尾部手动补充按钮与加载骨架过渡 */}
                                    <div className="pt-3 pb-2 px-1 space-y-3">
                                        {randomRoam.status === 'loading' && (
                                            <div className="animate-roam-loading-expand space-y-2 rounded-2xl bg-[var(--surface-raised)]/90 border border-[var(--line)] p-3 backdrop-blur-md shadow-xs">
                                                {/* 动态微型均衡器与状态提示 */}
                                                <div className="flex items-center justify-between text-xs text-[var(--accent)] font-medium px-1">
                                                    <span className="flex items-center gap-2">
                                                        <span className="relative flex h-2 w-2">
                                                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-75" />
                                                            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--accent)]" />
                                                        </span>
                                                        <span>{t("正在漫游探索新歌…")}</span>
                                                    </span>
                                                    <div className="flex items-end gap-0.5 h-3">
                                                        <span className="w-0.5 h-2 bg-[var(--accent)] rounded-full animate-bounce" style={{ animationDuration: '0.6s' }} />
                                                        <span className="w-0.5 h-3 bg-[var(--accent)] rounded-full animate-bounce" style={{ animationDuration: '0.8s', animationDelay: '0.2s' }} />
                                                        <span className="w-0.5 h-1.5 bg-[var(--accent)] rounded-full animate-bounce" style={{ animationDuration: '0.7s', animationDelay: '0.4s' }} />
                                                    </div>
                                                </div>

                                                {/* 发光流光占位卡片 */}
                                                <div className="space-y-1.5">
                                                    {[1, 2].map((n) => (
                                                        <div
                                                            key={`roam-skeleton-${n}`}
                                                            className="relative overflow-hidden flex items-center gap-3 p-2 rounded-xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5"
                                                        >
                                                            <div className="absolute inset-0 -translate-x-full animate-roam-shimmer bg-gradient-to-r from-transparent via-white/10 dark:via-white/5 to-transparent pointer-events-none" />
                                                            <div className="w-9 h-9 rounded-lg bg-black/10 dark:bg-white/10 shrink-0 flex items-center justify-center text-current/30">
                                                                <Disc size={16} className="animate-spin-slow opacity-40" />
                                                            </div>
                                                            <div className="flex-1 space-y-1.5 py-0.5">
                                                                <div className="h-3 bg-black/15 dark:bg-white/15 rounded-md w-3/5" />
                                                                <div className="h-2 bg-black/10 dark:bg-white/10 rounded-md w-2/5" />
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <button
                                            type="button"
                                            onClick={handleManualRoamAppend}
                                            disabled={randomRoam.status === 'loading'}
                                            className="w-full py-2.5 px-4 rounded-xl border border-[var(--line)] hover:border-[var(--accent)]/50 bg-[var(--surface-raised)] hover:bg-[var(--surface)] text-[var(--ink)] hover:text-[var(--accent)] text-xs font-semibold flex items-center justify-center gap-2 shadow-xs transition-all cursor-pointer disabled:opacity-60 active:scale-[0.99]"
                                        >
                                            {randomRoam.status === 'loading' ? (
                                                <span className="flex items-center gap-2">
                                                    <Loader2 size={14} className="animate-spin text-[var(--accent)] shrink-0" />
                                                    <span>{t("正在补充漫游歌曲…")}</span>
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-2">
                                                    <Compass size={14} className="text-[var(--accent)] shrink-0" />
                                                    <span>{t("漫游补充 {p0} 首歌曲", { p0: (randomRoam.batchSize || 10) })}</span>
                                                </span>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* 底部 - 队尾续播与清空按钮 */}
                        <div className="theme-drawer__footer px-4 py-3.5 pb-[max(16px,env(safe-area-inset-bottom))] flex items-center justify-between gap-3 min-h-[64px] bg-[var(--surface-raised)]/90 backdrop-blur-md border-t border-[var(--line)]">
                            {/* 续播漫游开关 */}
                            <div className="flex items-center gap-2.5 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                    <Compass size={17} className={`shrink-0 ${randomRoam.enabled ? 'text-[var(--accent)]' : 'text-[var(--muted)] opacity-70'}`} aria-hidden="true" />
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-xs font-semibold text-[var(--ink)] leading-snug whitespace-nowrap">{t("队尾随机续播")}</span>
                                        <span className="text-[10px] text-[var(--muted)] leading-snug truncate max-w-[125px]">
                                            {randomRoam.status === 'exhausted'
                                                ? t("本轮已走完")
                                                : randomRoam.status === 'loading'
                                                    ? t("正在寻找…")
                                                    : randomRoam.status === 'error'
                                                        ? t("重试续播")
                                                        : randomRoam.enabled && !authenticated
                                                            ? t("未登录暂停")
                                                            : isRoamLibraryQueued
                                                                ? t("全曲库已进队")
                                                                : t("队尾自动补充")}
                                        </span>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={randomRoam.enabled}
                                    aria-label={t("队尾随机续播")}
                                    onClick={handleRoamToggle}
                                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                                        randomRoam.enabled ? 'bg-[var(--accent)]' : 'bg-slate-300 dark:bg-slate-600'
                                    }`}
                                >
                                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                                        randomRoam.enabled ? 'translate-x-5' : 'translate-x-0'
                                    }`} />
                                </button>
                                {/* 状态反馈固定位：放于开关后面，避免开关位移 */}
                                <div className="w-5 h-5 flex items-center justify-center shrink-0">
                                    {randomRoam.status === 'loading' ? (
                                        <Loader2 size={13} className="shrink-0 animate-spin text-[var(--accent)]" aria-label={t("正在加载续播歌曲")} />
                                    ) : randomRoam.status === 'error' && randomRoam.enabled ? (
                                        <button
                                            type="button"
                                            onClick={retryRandomRoam}
                                            className="text-button text-xs font-medium p-0.5 text-[var(--accent)] hover:scale-110 active:scale-95 transition-transform"
                                            title={t("重试续播")}
                                        >
                                            <RotateCcw size={12} aria-hidden="true" />
                                        </button>
                                    ) : null}
                                </div>
                            </div>

                            {/* 清空列表按钮 */}
                            <button
                                type="button"
                                onClick={clearPlaylist}
                                className="theme-drawer__danger flex items-center gap-1.5 px-3 py-2 text-xs font-medium cursor-pointer shrink-0"
                                title={t("清空当前播放队列")}
                            >
                                <Trash2 size={13} strokeWidth={2} />
                                <span>{t("清空列表")}</span>
                            </button>
                        </div>
                </>
            </>
            )}
        </DrawerFrame>
    );
};
