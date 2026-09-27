import React, { useEffect, useMemo, useRef, useState } from 'react';
import { lyricPlaybackClock } from '../../services/lyricPlaybackClock';
import { getInterludeDotTimes, getInterludeState } from '../../utils/interludeState';
import InterludeDots from './InterludeDots';

const INACTIVE_STATE = Object.freeze({ isInterlude: false, stage: 0, progress: 0 });

const snapshotTime = (snapshot) => (
    Number.isFinite(snapshot?.currentTime) && snapshot.currentTime >= 0
        ? snapshot.currentTime
        : 0
);

/**
 * 原地渐变替换宿主。时间只由共享歌词时钟驱动；窗口、阶段与圆点
 * seek 均复用 interludeState 的同一解析契约。
 */
export default function InterludeHost({
    audioRef,
    lyrics,
    currentLyricIndex,
    lineIndex,
    isActive,
    isUserScrolling,
    surfaceVisible = true,
    syncMode = 'line',
    onSeekTime,
    children,
}) {
    const isCandidate = surfaceVisible
        && (isActive || (lineIndex === 0 && currentLyricIndex === 0));
    // Read the shared snapshot during render so a mounted inactive line that
    // becomes the active candidate cannot paint one stale lyrics-visible frame.
    const renderTime = snapshotTime(lyricPlaybackClock.getSnapshot());
    const lastClockTimeRef = useRef(renderTime);
    const lastActiveStageRef = useRef(0);
    const [interludeState, setInterludeState] = useState(() => (
        isCandidate
            ? getInterludeState({
                currentTime: renderTime,
                lyrics,
                currentLyricIndex,
                lineIndex,
                isUserScrolling,
                syncMode,
            })
            : INACTIVE_STATE
    ));

    useEffect(() => {
        if (!isCandidate) {
            lastActiveStageRef.current = 0;
            setInterludeState(INACTIVE_STATE);
            return undefined;
        }

        const updateFromClock = (snapshot) => {
            const currentTime = snapshotTime(snapshot);
            const rewound = currentTime + 0.002 < lastClockTimeRef.current;
            lastClockTimeRef.current = currentTime;
            if (rewound) lastActiveStageRef.current = 0;

            const next = getInterludeState({
                currentTime,
                lyrics,
                currentLyricIndex,
                lineIndex,
                isUserScrolling,
                syncMode,
            });
            if (next.isInterlude) lastActiveStageRef.current = next.stage;

            setInterludeState((previous) => {
                if (!rewound
                    && previous.isInterlude === next.isInterlude
                    && previous.stage === next.stage) return previous;
                return rewound
                    ? { ...next, rewindRevision: (previous.rewindRevision || 0) + 1 }
                    : next;
            });
        };

        const unsubscribe = lyricPlaybackClock.subscribe(updateFromClock);
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
    }, [isCandidate, lyrics, currentLyricIndex, lineIndex, isUserScrolling, syncMode]);

    const renderInterludeState = isCandidate
        ? getInterludeState({
            currentTime: renderTime,
            lyrics,
            currentLyricIndex,
            lineIndex,
            isUserScrolling,
            syncMode,
        })
        : INACTIVE_STATE;

    const dotTimes = useMemo(() => {
        if (!isCandidate) return null;
        return getInterludeDotTimes({
            lyrics,
            currentLyricIndex,
            lineIndex,
            currentTime: renderTime,
            syncMode,
        });
    }, [
        isCandidate,
        lyrics,
        currentLyricIndex,
        lineIndex,
        renderTime,
        syncMode,
        interludeState.isInterlude,
        interludeState.stage,
        interludeState.rewindRevision,
    ]);

    const handleSeekDot = React.useCallback((time) => {
        if (!Number.isFinite(time)) return;
        // Exactly one writer owns a seek. The parent callback is authoritative;
        // direct audio mutation remains only as a compatibility fallback.
        if (typeof onSeekTime === 'function') {
            onSeekTime(time);
        } else if (audioRef?.current) {
            audioRef.current.currentTime = time;
        }
    }, [onSeekTime, audioRef]);

    if (!isCandidate) return children;

    const isInterlude = renderInterludeState.isInterlude && !isUserScrolling;
    const displayStage = isInterlude
        ? renderInterludeState.stage
        : lastActiveStageRef.current;
    const animDuration = isInterlude ? '500ms' : '1000ms';

    return (
        <div className="classic-lyrics__interlude-host relative w-full">
            <div
                className="classic-lyrics__text-wrap origin-left"
                style={{
                    transition: `opacity ${animDuration} cubic-bezier(0.22, 1, 0.36, 1), transform ${animDuration} cubic-bezier(0.22, 1, 0.36, 1), filter ${animDuration} cubic-bezier(0.22, 1, 0.36, 1)`,
                    opacity: isInterlude ? 0 : 1,
                    transform: isInterlude ? 'scale(0.97)' : 'scale(1)',
                    filter: isInterlude ? 'blur(6px)' : 'blur(0px)',
                    pointerEvents: isInterlude ? 'none' : 'auto',
                }}
            >
                {children}
            </div>

            <div
                className={`classic-lyrics__dots-overlay absolute inset-0 flex items-center justify-start origin-left z-10 ${
                    isInterlude ? 'pointer-events-auto' : 'pointer-events-none'
                }`}
                onMouseDown={(event) => event.stopPropagation()}
                onMouseUp={(event) => event.stopPropagation()}
                onTouchStart={(event) => event.stopPropagation()}
                onTouchEnd={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                style={{
                    transition: `opacity ${animDuration} cubic-bezier(0.22, 1, 0.36, 1), transform ${animDuration} cubic-bezier(0.22, 1, 0.36, 1), filter ${animDuration} cubic-bezier(0.22, 1, 0.36, 1)`,
                    opacity: isInterlude ? 1 : 0,
                    transform: isInterlude ? 'scale(1)' : 'scale(0.97)',
                    filter: isInterlude ? 'blur(0px)' : 'blur(6px)',
                }}
                aria-hidden={!isInterlude}
                inert={isInterlude ? undefined : ''}
            >
                <InterludeDots
                    stage={displayStage}
                    dotTimes={dotTimes}
                    onSeekDot={isInterlude ? handleSeekDot : null}
                />
            </div>
        </div>
    );
}
