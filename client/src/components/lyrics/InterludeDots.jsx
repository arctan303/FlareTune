import { t } from '../../i18n/index.js';
import React from 'react';
import { lyricPlaybackClock } from '../../services/lyricPlaybackClock.js';
import { getInterludeDotProgress } from '../../utils/interludeState.js';
import './interlude-dots.css';

const DOT_LABELS = [
    '跳转到间奏第 1 阶段（1/3 进度）',
    '跳转到间奏第 2 阶段（2/3 进度）',
    '跳转到间奏冲线阶段（100% 达成）',
];

export default function InterludeDots({
    stage = 0,
    active = false,
    window: interludeWindow = null,
    dotTimes = null,
    onSeekDot = null,
    className = '',
    clock = lyricPlaybackClock,
}) {
    const rootRef = React.useRef(null);
    const dotRefs = React.useRef([]);
    const start = interludeWindow?.start;
    const end = interludeWindow?.end;
    const duration = interludeWindow?.duration;

    React.useLayoutEffect(() => {
        if (!active || !Number.isFinite(start) || !Number.isFinite(end)) {
            if (rootRef.current?.dataset) rootRef.current.dataset.motionRunning = 'false';
            return undefined;
        }
        const mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        let reducedMotion = mediaQuery?.matches === true;
        const update = (snapshot) => {
            const fills = getInterludeDotProgress(snapshot.currentTime, { start, duration });
            if (rootRef.current?.dataset) {
                rootRef.current.dataset.motionRunning = !reducedMotion
                    && snapshot.visible !== false && !snapshot.paused
                    && !snapshot.buffering && !snapshot.seeking && !snapshot.ended
                    ? 'true' : 'false';
            }
            fills.forEach((fill, index) => {
                const dot = dotRefs.current[index];
                if (!dot) return;
                dot.style.setProperty('--interlude-dot-fill', `${(fill * 100).toFixed(3)}%`);
                dot.style.setProperty('--interlude-dot-glow', fill.toFixed(3));
                dot.dataset.fillState = fill >= 1 ? 'complete'
                    : fills.slice(0, index).every(value => value >= 1) ? 'filling' : 'pending';
            });
        };
        update(clock.getSnapshot());
        const unsubscribe = clock.subscribe(update, {
            animationFrames: snapshot => !reducedMotion
                && snapshot.currentTime >= start && snapshot.currentTime < end,
            getNextBoundary: snapshot => [start, end].find(time => time > snapshot.currentTime) ?? null,
        });
        const handleMotionChange = event => {
            reducedMotion = event.matches === true;
            update(clock.getSnapshot());
            clock.sample?.('motion-preference-change');
        };
        mediaQuery?.addEventListener?.('change', handleMotionChange);
        return () => {
            unsubscribe?.();
            mediaQuery?.removeEventListener?.('change', handleMotionChange);
        };
    }, [active, clock, start, end, duration]);

    const isClickable = typeof onSeekDot === 'function' && Boolean(dotTimes);
    const stopPropagation = event => event.stopPropagation();
    return (
        <div
            ref={rootRef}
            className={`classic-lyrics__interlude-dots flex items-center justify-start gap-1 select-none py-1 ${className}`}
            aria-label={t("间奏进度第 {p0} 阶段", { p0: stage })}
            onClick={stopPropagation}
            onMouseDown={stopPropagation}
            onTouchStart={stopPropagation}
            onPointerDown={stopPropagation}
        >
            {DOT_LABELS.map((label, index) => (
                <button
                    key={label}
                    type="button"
                    aria-label={t(label)}
                    disabled={!isClickable}
                    onClick={event => {
                        event.stopPropagation();
                        event.preventDefault();
                        const time = dotTimes?.[`t${index + 1}`];
                        if (isClickable && Number.isFinite(time)) onSeekDot(time, index + 1);
                    }}
                    onMouseDown={stopPropagation}
                    onTouchStart={stopPropagation}
                    onPointerDown={stopPropagation}
                    className="classic-interlude-button group/dot relative min-h-[44px] min-w-[44px] lg:min-h-0 lg:min-w-0 p-2 md:p-2.5 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded-full cursor-pointer"
                >
                    <span
                        ref={node => { dotRefs.current[index] = node; }}
                        className="classic-interlude-dot"
                        aria-hidden="true"
                        data-fill-state={stage > index ? 'complete' : 'pending'}
                        style={{ '--interlude-dot-fill': stage > index ? '100%' : '0%', '--interlude-dot-glow': stage > index ? 1 : 0 }}
                    >
                        <span className="classic-interlude-dot__fill" />
                    </span>
                </button>
            ))}
        </div>
    );
}
