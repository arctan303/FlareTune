const AUDIO_EVENTS = Object.freeze([
    'play',
    'pause',
    'seeking',
    'seeked',
    'ratechange',
    'ended',
    'waiting',
    'stalled',
    'playing',
    'canplay',
    'loadstart',
    'emptied',
    'loadedmetadata',
    'timeupdate',
]);

const makeInitialSnapshot = (visible = true, reason = 'initial') => Object.freeze({
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    paused: true,
    seeking: false,
    buffering: false,
    ended: false,
    visible,
    reason,
});

const readVisibility = (documentTarget) => {
    if (!documentTarget) return true;
    if (typeof documentTarget.visibilityState === 'string') {
        return documentTarget.visibilityState !== 'hidden';
    }
    return documentTarget.hidden !== true;
};

const finiteOr = (value, fallback) => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/**
 * Create a clock whose only high-frequency fact source is an attached audio
 * element. Dependencies are injectable so lifecycle behavior is testable in
 * Node without a browser. Ordinary listeners use events and exact media-time
 * boundaries; only visible active word renderers opt into animation frames.
 */
export function createLyricPlaybackClock(deps = {}) {
    const requestFrame = deps.raf
        || deps.requestAnimationFrame
        || ((callback) => globalThis.requestAnimationFrame?.(callback));
    const cancelFrame = deps.caf
        || deps.cancelAnimationFrame
        || ((frameId) => globalThis.cancelAnimationFrame?.(frameId));
    const setTimer = deps.setTimeout || globalThis.setTimeout;
    const clearTimer = deps.clearTimeout || globalThis.clearTimeout;
    const documentTarget = Object.hasOwn(deps, 'document')
        ? deps.document
        : globalThis.document;
    const reportListenerError = deps.onListenerError
        || ((error) => globalThis.console?.error?.('Lyric clock listener failed:', error));

    let audio = null;
    let frameId = null;
    let boundaryTimer = null;
    let buffering = false;
    let seeking = false;
    let ended = false;
    let snapshot = makeInitialSnapshot(readVisibility(documentTarget));
    const subscriptions = new Set();

    const cancelScheduledFrame = () => {
        if (frameId === null || frameId === undefined) return;
        cancelFrame(frameId);
        frameId = null;
    };

    const cancelBoundaryTimer = () => {
        if (boundaryTimer === null) return;
        clearTimer(boundaryTimer);
        boundaryTimer = null;
    };

    const refreshSnapshot = (reason) => {
        const visible = readVisibility(documentTarget);
        if (!audio) {
            snapshot = makeInitialSnapshot(visible, reason);
            return snapshot;
        }

        snapshot = Object.freeze({
            currentTime: Math.max(0, finiteOr(audio.currentTime, 0)),
            duration: Math.max(0, finiteOr(audio.duration, 0)),
            playbackRate: finiteOr(audio.playbackRate, 1) > 0
                ? finiteOr(audio.playbackRate, 1)
                : 1,
            paused: Boolean(audio.paused),
            seeking,
            buffering,
            ended: ended || Boolean(audio.ended),
            visible,
            reason,
        });
        return snapshot;
    };

    const notify = (nextSnapshot) => {
        for (const subscription of [...subscriptions]) {
            try {
                subscription.listener(nextSnapshot);
            } catch (error) {
                reportListenerError(error);
            }
        }
    };

    const shouldAdvance = () => (
        Boolean(audio)
        && subscriptions.size > 0
        && !snapshot.paused
        && !snapshot.seeking
        && !snapshot.buffering
        && !snapshot.ended
        && snapshot.visible
    );
    const needsFrames = () => {
        for (const subscription of subscriptions) {
            try {
                if (typeof subscription.animationFrames === 'function'
                    ? subscription.animationFrames(snapshot) : subscription.animationFrames) return true;
            } catch (error) {
                reportListenerError(error);
            }
        }
        return false;
    };

    let reconcileFrame = () => {};

    const sample = (reason = 'sample') => {
        const nextSnapshot = refreshSnapshot(reason);
        notify(nextSnapshot);
        reconcileFrame();
        return nextSnapshot;
    };

    const handleAnimationFrame = () => {
        frameId = null;
        if (!shouldAdvance() || !needsFrames()) return;
        sample('animation-frame');
    };

    reconcileFrame = () => {
        cancelBoundaryTimer();
        if (!shouldAdvance()) {
            cancelScheduledFrame();
            return;
        }
        if (needsFrames()) {
            if (frameId === null || frameId === undefined) {
                const scheduledId = requestFrame(handleAnimationFrame);
                frameId = scheduledId === undefined ? null : scheduledId;
            }
            return;
        }
        cancelScheduledFrame();
        let boundary = snapshot.duration > snapshot.currentTime ? snapshot.duration : Infinity;
        for (const subscription of subscriptions) {
            try {
                const candidate = subscription.getNextBoundary?.(snapshot);
                if (Number.isFinite(candidate) && candidate > snapshot.currentTime) {
                    boundary = Math.min(boundary, candidate);
                }
            } catch (error) {
                reportListenerError(error);
            }
        }
        if (Number.isFinite(boundary)) {
            // Re-sample the audio at the deadline rather than extrapolating its
            // position. Rate changes, seeks, pauses and buffering cancel/rearm.
            const delay = Math.max(1, Math.min(2_147_483_647,
                (boundary - snapshot.currentTime) * 1000 / snapshot.playbackRate));
            boundaryTimer = setTimer(() => {
                boundaryTimer = null;
                sample('boundary');
            }, delay);
        }
    };

    const handleAudioEvent = (event) => {
        const reason = event?.type || 'audio-event';
        switch (reason) {
            case 'waiting':
            case 'stalled':
                buffering = true;
                break;
            case 'loadstart':
            case 'emptied':
                buffering = true;
                seeking = false;
                ended = false;
                break;
            case 'playing':
            case 'canplay':
                buffering = false;
                seeking = Boolean(audio?.seeking);
                ended = false;
                break;
            case 'loadedmetadata':
                seeking = Boolean(audio?.seeking);
                ended = false;
                break;
            case 'seeking':
                seeking = true;
                break;
            case 'seeked':
                seeking = false;
                break;
            case 'ended':
                ended = true;
                buffering = false;
                break;
            case 'play':
                ended = false;
                break;
            case 'timeupdate':
                if (
                    buffering
                    && !seeking
                    && !audio?.paused
                    && finiteOr(audio?.readyState, 0) >= 2
                ) {
                    buffering = false;
                }
                break;
            default:
                break;
        }
        sample(reason);
    };

    const handleVisibilityChange = () => sample('visibilitychange');

    const removeEventListeners = (target) => {
        if (target?.removeEventListener) {
            for (const eventName of AUDIO_EVENTS) {
                target.removeEventListener(eventName, handleAudioEvent);
            }
        }
        documentTarget?.removeEventListener?.('visibilitychange', handleVisibilityChange);
    };

    const addEventListeners = (target) => {
        if (target?.addEventListener) {
            for (const eventName of AUDIO_EVENTS) {
                target.addEventListener(eventName, handleAudioEvent);
            }
        }
        documentTarget?.addEventListener?.('visibilitychange', handleVisibilityChange);
    };

    const detach = (expectedAudio) => {
        if (expectedAudio !== undefined && expectedAudio !== audio) return snapshot;

        const previousAudio = audio;
        cancelScheduledFrame();
        cancelBoundaryTimer();
        if (previousAudio) removeEventListeners(previousAudio);
        audio = null;
        buffering = false;
        seeking = false;
        ended = false;
        const nextSnapshot = refreshSnapshot('detach');
        notify(nextSnapshot);
        return nextSnapshot;
    };

    const attach = (nextAudio) => {
        if (!nextAudio) return detach();
        if (nextAudio === audio) return sample('attach');

        if (audio) {
            cancelScheduledFrame();
            cancelBoundaryTimer();
            removeEventListeners(audio);
        }

        audio = nextAudio;
        buffering = false;
        seeking = Boolean(nextAudio.seeking);
        ended = Boolean(nextAudio.ended);
        addEventListeners(nextAudio);
        return sample('attach');
    };

    const subscribe = (listener, { animationFrames = false, getNextBoundary } = {}) => {
        if (typeof listener !== 'function') {
            throw new TypeError('Lyric clock listener must be a function');
        }

        const subscription = { listener, animationFrames, getNextBoundary };
        subscriptions.add(subscription);
        const currentSnapshot = refreshSnapshot('subscribe');
        try {
            listener(currentSnapshot);
        } catch (error) {
            reportListenerError(error);
        }
        reconcileFrame();

        let active = true;
        return () => {
            if (!active) return;
            active = false;
            subscriptions.delete(subscription);
            refreshSnapshot('unsubscribe');
            reconcileFrame();
        };
    };

    return Object.freeze({
        attach,
        detach,
        subscribe,
        getSnapshot: () => snapshot,
        sample,
    });
}

export const lyricPlaybackClock = createLyricPlaybackClock();
