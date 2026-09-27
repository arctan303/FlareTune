import React from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useThemeStore } from '../../store/useThemeStore';
import { useShallow } from 'zustand/react/shallow';
import { createDebouncedCommit } from '../../utils/debouncedCommit';

export const SEEK_DEBOUNCE_MS = 120;
const RANGE_SEEK_KEYS = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
]);

const formatDuration = (time) => {
    if (!time || isNaN(time)) return '00:00';
    const m = Math.floor(time / 60);
    const s = Math.floor(time % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export default function ProgressBar({ isImmersiveBottom = false }) {
    const { currentSong, progress, duration, audioRef } = usePlayerStore(useShallow((state) => ({
        currentSong: state.currentSong,
        progress: state.progress,
        duration: state.duration,
        audioRef: state.audioRef,
    })));
    const accentColor = useThemeStore((state) => state.accentColor);
    const progressRef = React.useRef(null);
    const seekSchedulerRef = React.useRef(null);
    const pendingSeekRef = React.useRef(null);
    const seekCommittedRef = React.useRef(false);
    const activeSongKey = `${currentSong?.id ?? ''}:${currentSong?.audio_url ?? ''}`;
    const activeSongKeyRef = React.useRef(activeSongKey);
    activeSongKeyRef.current = activeSongKey;
    const [seekPreview, setSeekPreview] = React.useState(null);
    const [hoverPos, setHoverPos] = React.useState(null);

    React.useEffect(() => {
        pendingSeekRef.current = null;
        seekCommittedRef.current = false;
        setSeekPreview(null);
        const schedulerSongKey = activeSongKey;
        seekSchedulerRef.current = createDebouncedCommit((nextTime) => {
            pendingSeekRef.current = null;
            if (
                activeSongKeyRef.current === schedulerSongKey
                && audioRef?.current
                && Number.isFinite(nextTime)
            ) {
                audioRef.current.currentTime = nextTime;
                seekCommittedRef.current = true;
            }
        }, SEEK_DEBOUNCE_MS);
        return () => {
            seekSchedulerRef.current?.cancel();
            pendingSeekRef.current = null;
        };
    }, [activeSongKey, audioRef]);

    const scheduleSeek = (nextTime) => {
        if (!Number.isFinite(nextTime)) return;
        seekCommittedRef.current = false;
        pendingSeekRef.current = nextTime;
        setSeekPreview(nextTime);
        seekSchedulerRef.current?.schedule(nextTime);
    };

    const flushPendingSeek = () => {
        if (!Number.isFinite(pendingSeekRef.current)) return;
        setSeekPreview(pendingSeekRef.current);
        seekSchedulerRef.current?.flush();
    };

    const commitSeekImmediately = (nextTime) => {
        scheduleSeek(nextTime);
        flushPendingSeek();
    };

    React.useEffect(() => {
        if (
            seekPreview !== null
            && seekCommittedRef.current
            && Math.abs(progress - seekPreview) <= 0.5
        ) {
            setSeekPreview(null);
            seekCommittedRef.current = false;
        }
    }, [progress, seekPreview]);

    const handleSeek = (e) => {
        if (!progressRef.current || !audioRef?.current) return;
        const rect = progressRef.current.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        commitSeekImmediately(ratio * (duration || 0));
    };

    const handleMouseMove = (e) => {
        if (!progressRef.current || !duration) return;
        const rect = progressRef.current.getBoundingClientRect();
        let ratio = (e.clientX - rect.left) / rect.width;
        ratio = Math.max(0, Math.min(1, ratio));
        setHoverPos({
            x: ratio * 100,
            time: ratio * duration,
            clientX: e.clientX,
            clientY: rect.top,
        });
    };

    const handleMouseLeave = () => {
        setHoverPos(null);
    };

    const displayedProgress = seekPreview ?? progress;
    const percentage = duration
        ? Math.max(0, Math.min(100, (displayedProgress / duration) * 100))
        : 0;

    return (
        <div 
            className={`relative flex-1 cursor-pointer group transition-all duration-300 ${
                isImmersiveBottom 
                    ? 'h-1 hover:h-2 bg-white/10 rounded-none w-full' 
                    : 'player-progress h-[3px] hover:h-[5px] w-full rounded-none'
            }`}
            onClick={handleSeek}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            ref={progressRef}
        >
            {!isImmersiveBottom && (
                <input
                    type="range"
                    min="0"
                    max={duration || 1}
                    step="0.1"
                    value={Math.min(displayedProgress, duration || 1)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => scheduleSeek(Number(event.target.value))}
                    onPointerUp={flushPendingSeek}
                    onPointerCancel={flushPendingSeek}
                    onKeyUp={(event) => {
                        if (RANGE_SEEK_KEYS.has(event.key)) flushPendingSeek();
                    }}
                    onBlur={flushPendingSeek}
                    className="absolute bottom-0 inset-x-0 z-10 h-3 w-full cursor-pointer opacity-0"
                    aria-label="播放进度"
                />
            )}
            <div 
                className={`absolute top-0 left-0 h-full transition-[width] duration-100 ease-linear rounded-r-sm`}
                style={{ 
                    width: `${percentage}%`,
                    backgroundColor: isImmersiveBottom
                        ? (accentColor || 'rgba(255,255,255,0.8)')
                        : 'var(--accent)'
                }}
            />
            {hoverPos !== null && (
                typeof document !== 'undefined' && createPortal(
                    <div
                        className="fixed -translate-x-1/2 -translate-y-full -mt-2 bg-black/80 backdrop-blur-md text-white/90 text-xs px-2 py-1 rounded shadow-lg pointer-events-none whitespace-nowrap z-[9999] transition-opacity duration-200"
                        style={{
                            left: `${hoverPos.clientX}px`,
                            top: `${hoverPos.clientY}px`,
                        }}
                        role="tooltip"
                    >
                        {formatDuration(hoverPos.time)}
                    </div>,
                    document.body,
                )
            )}
        </div>
    );
}
