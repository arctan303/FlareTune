import React from 'react';
import QualityBadge from './QualityBadge';
import { Play, Pause, ListMusic, Loader2, Star } from 'lucide-react';
import PlaybackModeIcon from './playerbar/PlaybackModeIcon.jsx';
import { SolidRoundedSkipBack, SolidRoundedSkipForward } from './icons/SolidSkipIcons';
import { usePlayerStore } from '../store/usePlayerStore';
import { useUIStore } from '../store/useUIStore';
import { useShallow } from 'zustand/react/shallow';
import { usePlaybackButtonAnimations } from '../hooks/usePlaybackButtonAnimations.js';
import { useFavoriteSongAction } from '../hooks/useFavoriteSongAction.js';
import PlayerMoreMenu from './PlayerMoreMenu';

// 现代化实心圆角播放
const SolidRoundedPlay = ({ size = 28, className = "" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <path 
            d="M7 6.35c0-1.18 1.3-1.9 2.3-1.27l10.1 6.38a1.5 1.5 0 0 1 0 2.54l-10.1 6.38c-1 .63-2.3-.09-2.3-1.27V6.35z" 
            fill="currentColor" 
        />
    </svg>
);

// 现代化实心圆角暂停
const SolidRoundedPause = ({ size = 26, className = "" }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
        <rect x="5.5" y="4" width="4" height="16" rx="2" fill="currentColor" />
        <rect x="14.5" y="4" width="4" height="16" rx="2" fill="currentColor" />
    </svg>
);

const ScrollText = ({ text, className, containerClassName }) => {
    const containerRef = React.useRef(null);
    const contentRef = React.useRef(null);
    const [isOverflowing, setIsOverflowing] = React.useState(false);

    React.useEffect(() => {
        const container = containerRef.current;
        const content = contentRef.current;
        if (!container || !content) return;

        const checkOverflow = () => {
            setIsOverflowing(content.scrollWidth > container.clientWidth);
        };
        checkOverflow();

        const observer = new ResizeObserver(checkOverflow);
        observer.observe(container);
        return () => observer.disconnect();
    }, [text]);

    const maskStyle = isOverflowing ? {
        maskImage: 'linear-gradient(to right, transparent 0%, black 12px, black calc(100% - 16px), transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 12px, black calc(100% - 16px), transparent 100%)',
    } : undefined;

    return (
        <div 
            ref={containerRef} 
            className={`overflow-hidden whitespace-nowrap w-full ${containerClassName || ''}`}
            style={maskStyle}
        >
            <div 
                ref={contentRef}
                className={isOverflowing ? 'inline-block w-max animate-marquee pr-12' : `truncate block ${className}`}
            >
                <span className={isOverflowing ? className : ''}>{text}</span>
                {isOverflowing && (
                    <span className={className} style={{ marginLeft: '3rem' }}>{text}</span>
                )}
            </div>
        </div>
    );
};

const formatTime = (time) => {
    if (isNaN(time) || !time) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export default React.memo(function PlayerControls({
    currentSong, audioRef,
    playMode, handleModeChange,
    playPrev, togglePlay, isPlaying, playNext, setIsPlaylistOpen,
    layoutRef,
    hideMetadata = false,
    showPlayerModes = false,
}) {
    const { progress, duration, setProgress, isBuffering } = usePlayerStore(useShallow((state) => ({
        progress: state.progress,
        duration: state.duration,
        setProgress: state.setProgress,
        isBuffering: state.isBuffering,
    })));
    const [showModeMenu, setShowModeMenu] = React.useState(false);
    const [showMoreMenu, setShowMoreMenu] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const [dragProgress, setDragProgress] = React.useState(0);
    const {
        isFavorite,
        pendingSongIds: pendingFavoriteSongIds,
        justAddedSongIds,
        toggleFavorite,
        clearAddedAnimation,
    } = useFavoriteSongAction();
    const currentSongId = String(currentSong?.id);
    const isInFavorite = isFavorite(currentSong);
    const isPendingFavorite = pendingFavoriteSongIds.has(currentSongId);
    const animateHeart = justAddedSongIds.has(currentSongId);
    const {
        prevAnimNonce,
        nextAnimNonce,
        isPrevAnimating,
        isNextAnimating,
        handlePlayPrev,
        handlePlayNext,
    } = usePlaybackButtonAnimations({ playPrev, playNext });

    const displayProgress = isDragging ? dragProgress : progress;
    const iconStrokeWidth = 1.75;

    return (
        <div ref={layoutRef} className="classic-controls w-full sm:max-w-[440px] lg:max-w-[390px] xl:max-w-[420px] 2xl:max-w-[440px] mx-auto flex flex-col mt-2 flex-shrink-0">
            {!hideMetadata && (
                <div className="classic-controls__metadata mb-3 min-w-0">
                    <div className="classic-controls__title-row flex items-center gap-3 mb-0.5">
                        <div className="flex flex-1 min-w-0 items-center gap-2 opacity-0 animate-[fade-in_0.3s_ease_forwards]">
                            <ScrollText 
                                key={currentSong?.id + '-title'}
                                text={currentSong?.title || '未知歌曲'} 
                                className="classic-controls__title text-lg sm:text-xl md:text-2xl font-bold text-white tracking-tight"
                                containerClassName="flex-1 min-w-0"
                            />
                            <QualityBadge format={currentSong?.format} />
                        </div>

                        {/* 与歌名对齐，避免占用歌手和专辑的横向空间 */}
                        <div className="classic-controls__metadata-actions flex items-center gap-2 shrink-0 relative">
                            <button
                                type="button"
                                aria-label={isInFavorite ? '移出我的收藏' : '加入我的收藏'}
                                title={isInFavorite ? '移出我的收藏' : '加入我的收藏'}
                                onClick={(event) => toggleFavorite(currentSong, event)}
                                aria-busy={isPendingFavorite}
                                className={`h-6 w-6 inline-flex items-center justify-center transition-all hover:scale-110 active:scale-90 focus:outline-none cursor-pointer shrink-0 ${
                                    isInFavorite 
                                        ? 'text-rose-400' 
                                        : 'text-white/60 hover:text-white'
                                } ${isPendingFavorite ? 'animate-heart-pending' : animateHeart ? 'animate-heart-pop' : ''}`}
                                onAnimationEnd={() => clearAddedAnimation(currentSong)}
                            >
                                <Star size={22} fill={isInFavorite && !isPendingFavorite ? 'currentColor' : 'none'} strokeWidth={1.75} />
                            </button>

                            <PlayerMoreMenu
                                direction="up"
                                showPlayerModes={showPlayerModes}
                            />
                        </div>
                    </div>

                    <ScrollText
                        key={currentSong?.id + '-meta'}
                        text={
                            currentSong?.artist && currentSong?.album
                                ? `${currentSong.artist} — ${currentSong.album}`
                                : (currentSong?.artist || currentSong?.album || '未知艺术家')
                        }
                        className="classic-controls__artist text-xs sm:text-sm text-gray-400 font-medium"
                        containerClassName="opacity-0 animate-[fade-in_0.3s_ease_forwards]"
                    />
                </div>
            )}

            <div className="flex items-center gap-3 mb-4">
                <span className="classic-controls__time text-xs text-gray-400 font-mono w-10">{formatTime(displayProgress)}</span>
                <div className="classic-controls__progress flex-1 h-4 bg-transparent flex items-center relative group">
                    <input 
                        type="range" min="0" max={duration || 100} step="0.1" value={displayProgress} 
                        onMouseDown={() => {
                            setIsDragging(true);
                            setDragProgress(progress);
                        }}
                        onTouchStart={() => {
                            setIsDragging(true);
                            setDragProgress(progress);
                        }}
                        onChange={(e) => {
                            setDragProgress(Number(e.target.value));
                        }}
                        onMouseUp={(e) => {
                            setIsDragging(false);
                            const targetTime = Number(e.target.value);
                            setProgress(targetTime);
                            if (audioRef.current) audioRef.current.currentTime = targetTime;
                        }}
                        onTouchEnd={(e) => {
                            setIsDragging(false);
                            const targetTime = Number(e.target.value);
                            setProgress(targetTime);
                            if (audioRef.current) audioRef.current.currentTime = targetTime;
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    />
                    <div className="classic-controls__track w-full h-1 group-hover:h-1.5 bg-white/20 rounded-full overflow-hidden pointer-events-none transition-all duration-200">
                        <div className="classic-controls__progress-fill h-full bg-white rounded-full transition-all duration-75 shadow-[0_0_8px_rgba(255,255,255,0.4)]" style={{ width: `${(displayProgress / (duration || 1)) * 100}%` }}></div>
                    </div>
                </div>
                <span className="classic-controls__time text-xs text-gray-400 font-mono w-10 text-right">{formatTime(duration)}</span>
            </div>

            <div className="classic-controls__transport flex items-center justify-between px-2 text-gray-400">
                <div className="relative">
                    <button data-active={playMode !== 'sequence'} aria-label="选择播放模式" onClick={() => setShowModeMenu(!showModeMenu)} className={`classic-controls__icon transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${playMode !== 'sequence' ? 'text-blue-500 hover:text-blue-400' : 'hover:text-white'}`} title="选择播放模式">
                        <PlaybackModeIcon mode={playMode} size={22} strokeWidth={iconStrokeWidth} />
                    </button>
                    
                    {/* 播放模式选择菜单 */}
                    {showModeMenu && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setShowModeMenu(false)}></div>
                            <div className="classic-controls__menu absolute bottom-full left-0 mb-4 glass-panel !rounded-2xl p-2 flex flex-col gap-1 w-36 shadow-2xl z-50">
                                {[
                                    { id: 'sequence', label: '顺序播放' },
                                    { id: 'loop', label: '列表循环' },
                                    { id: 'single', label: '单曲循环' },
                                    { id: 'random', label: '随机播放' }
                                ].map(mode => (
                                    <button 
                                        key={mode.id}
                                        data-active={playMode === mode.id}
                                        onClick={() => { handleModeChange(mode.id); setShowModeMenu(false); }}
                                        className={`classic-controls__menu-item flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all focus:outline-none ${playMode === mode.id ? 'bg-white/15 text-white font-medium' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                                    >
                                        <div className={`classic-controls__menu-icon shrink-0 ${playMode === mode.id ? 'text-blue-400' : 'opacity-70'}`}>
                                            <PlaybackModeIcon mode={mode.id} size={18} strokeWidth={iconStrokeWidth} />
                                        </div>
                                        {mode.label}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>
                <div className="flex items-center gap-6 md:gap-8">
                    <button
                        aria-label="上一首"
                        onClick={handlePlayPrev}
                        className={`skip-btn skip-btn--prev ${isPrevAnimating ? 'is-animating' : ''} classic-controls__icon classic-controls__skip text-white hover:text-gray-300 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white`}
                    >
                        <SolidRoundedSkipBack size={30} isAnimating={isPrevAnimating} animKey={prevAnimNonce} />
                    </button>
                    <button
                        aria-label={isPlaying ? '暂停' : '播放'}
                        onClick={togglePlay}
                        className="classic-controls__icon classic-controls__play flex items-center justify-center text-white hover:text-gray-200 transition-all hover:scale-110 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    >
                        {isBuffering ? (
                            <Loader2 size={38} strokeWidth={iconStrokeWidth} className="animate-spin text-white opacity-90" />
                        ) : isPlaying ? (
                            <SolidRoundedPause size={38} className="animate-[fade-in_0.2s_ease-out]" />
                        ) : (
                            <SolidRoundedPlay size={38} className="ml-1 animate-[fade-in_0.2s_ease-out]" />
                        )}
                    </button>
                    <button
                        aria-label="下一首"
                        onClick={handlePlayNext}
                        className={`skip-btn skip-btn--next ${isNextAnimating ? 'is-animating' : ''} classic-controls__icon classic-controls__skip text-white hover:text-gray-300 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white`}
                    >
                        <SolidRoundedSkipForward size={30} isAnimating={isNextAnimating} animKey={nextAnimNonce} />
                    </button>
                </div>

                <button aria-label="打开播放列表" onClick={() => setIsPlaylistOpen(true)} className="classic-controls__icon hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"><ListMusic size={22} strokeWidth={iconStrokeWidth} /></button>
            </div>
        </div>
    );
});
