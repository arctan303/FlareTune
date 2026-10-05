const analyserResources = new WeakMap();
const analyserGraphs = new WeakMap();
const playingMediaKeys = new WeakMap();
export const AUDIO_ANALYSER_IDLE_MS = 30000;

const getAudioSourceKey = (audio) => String(
    audio?.currentSrc
    || audio?.getAttribute?.('src')
    || audio?.src
    || ''
);

const shouldKeepNativeAudioOutput = () => {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    return /android/i.test(`${platform} ${navigator.userAgent || ''}`);
};

const shouldRun = (resource) => (
    !resource.disposed
    && resource.context.state !== 'closed'
    && [...resource.consumers].some((consumer) => consumer.active && !consumer.released)
);

const hasLiveAudioTrack = (resource) => (
    resource.stream?.getAudioTracks?.().some((track) => track.readyState !== 'ended')
);

const isResourceCurrent = (resource, audio) => (
    resource
    && !resource.disposed
    && resource.audio === audio
    && resource.context.state !== 'closed'
    && resource.mediaKey === getAudioSourceKey(audio)
    && hasLiveAudioTrack(resource)
);

const getOrCreateAnalyserGraph = (audio) => {
    const existing = analyserGraphs.get(audio);
    if (existing && existing.context.state !== 'closed') {
        return { graph: existing, created: false };
    }
    if (existing) analyserGraphs.delete(audio);

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;

    let context = null;
    try {
        context = new AudioContext();
        if (context.state === 'closed') return null;
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.84;
        const graph = {
            audio,
            analyser,
            context,
            stateQueue: Promise.resolve(),
            idleTimer: null,
        };
        analyserGraphs.set(audio, graph);
        return { graph, created: true };
    } catch (error) {
        if (context?.state !== 'closed') context?.close?.().catch(() => {});
        throw error;
    }
};

const disposeAnalyserGraph = (graph) => {
    if (!graph) return;
    if (graph.idleTimer !== null) clearTimeout(graph.idleTimer);
    graph.idleTimer = null;
    if (analyserGraphs.get(graph.audio) === graph) {
        analyserGraphs.delete(graph.audio);
    }
    if (graph.context.state !== 'closed') {
        graph.context.close().catch(() => {});
    }
};

const reconcileGraphIdle = (graph) => {
    const current = analyserResources.get(graph.audio);
    if (current?.graph === graph && shouldRun(current)) {
        if (graph.idleTimer !== null) clearTimeout(graph.idleTimer);
        graph.idleTimer = null;
        return;
    }
    if (graph.idleTimer !== null || graph.context.state === 'closed') return;
    graph.idleTimer = setTimeout(() => {
        graph.idleTimer = null;
        const latest = analyserResources.get(graph.audio);
        if (latest?.graph === graph && shouldRun(latest)) return;
        if (latest?.graph === graph) disposeResource(latest);
        disposeAnalyserGraph(graph);
    }, AUDIO_ANALYSER_IDLE_MS);
    // Node diagnostics must not stay alive solely for an idle browser resource.
    graph.idleTimer?.unref?.();
};

const disposeResource = (resource) => {
    if (!resource || resource.disposed) return;
    resource.disposed = true;
    if (analyserResources.get(resource.audio) === resource) {
        analyserResources.delete(resource.audio);
    }
    resource.detachTrackListeners?.();
    resource.detachTrackListeners = null;
    resource.consumers.forEach((consumer) => {
        consumer.active = false;
        consumer.released = true;
    });
    resource.consumers.clear();
    try { resource.source?.disconnect?.(); } catch (error) {}
    resource.stream?.getTracks?.().forEach((track) => {
        try { track.stop?.(); } catch (error) {}
    });
    queueContextReconcile(resource);
};

export const markAudioAnalyserPlaying = (audio) => {
    if (audio) playingMediaKeys.set(audio, getAudioSourceKey(audio));
};

export const hasAudioAnalyserEnteredPlaying = (audio) => (
    Boolean(audio && playingMediaKeys.get(audio) === getAudioSourceKey(audio))
);

const queueContextReconcile = (resource) => {
    if (!resource || resource.context.state === 'closed') return;
    const graph = resource.graph;
    reconcileGraphIdle(graph);
    graph.stateQueue = graph.stateQueue
        .catch(() => {})
        .then(async () => {
            for (let pass = 0; pass < 4; pass++) {
                if (resource.context.state === 'closed') break;
                const current = analyserResources.get(graph.audio);
                const wantsRunning = current?.graph === graph && shouldRun(current);
                if (wantsRunning && resource.context.state !== 'running') {
                    await resource.context.resume().catch(() => {});
                    continue;
                }
                if (!wantsRunning && resource.context.state === 'running') {
                    await resource.context.suspend().catch(() => {});
                    continue;
                }
                break;
            }
        });
    resource.stateQueue = graph.stateQueue;
};

const createConsumer = (resource) => {
    const consumer = {
        resource,
        analyser: resource.analyser,
        active: true,
        released: false,
    };
    resource.consumers.add(consumer);
    queueContextReconcile(resource);
    return consumer;
};

export const acquireAudioAnalyser = (audio) => {
    if (!audio) return null;

    // Android devices may apply vendor audio effects only to the native media
    // output path. Keep the element out of a Web Audio graph on that platform.
    if (shouldKeepNativeAudioOutput()) return null;
    if (!hasAudioAnalyserEnteredPlaying(audio)) return null;

    const existing = analyserResources.get(audio);
    if (existing && isResourceCurrent(existing, audio)) return createConsumer(existing);
    if (existing) disposeResource(existing);

    // createMediaElementSource() permanently reroutes the media element through
    // Web Audio. Besides resampling, that can move playback away from the native
    // media path and disable device/vendor audio processing. A spectrum is only
    // cosmetic, so analyse a captured copy when the browser supports it and keep
    // the original element's output untouched. Otherwise degrade gracefully.
    const captureStream = audio.captureStream || audio.mozCaptureStream;
    if (!captureStream) return null;

    let stream = null;
    let source = null;
    let graphResult = null;
    try {
        stream = captureStream.call(audio);
        if (stream.getAudioTracks().length === 0) {
            stream.getTracks?.().forEach(track => track.stop?.());
            return null;
        }

        graphResult = getOrCreateAnalyserGraph(audio);
        if (!graphResult) {
            stream.getTracks?.().forEach(track => track.stop?.());
            return null;
        }
        const { graph } = graphResult;
        source = graph.context.createMediaStreamSource(stream);
        source.connect(graph.analyser);

        const resource = {
            audio,
            analyser: graph.analyser,
            context: graph.context,
            graph,
            source,
            stream,
            mediaKey: getAudioSourceKey(audio),
            disposed: false,
            consumers: new Set(),
            stateQueue: graph.stateQueue,
        };
        const tracks = stream.getAudioTracks();
        const handleTrackEnded = () => disposeResource(resource);
        const handleSourceChanged = () => invalidateAudioAnalyser(audio);
        tracks.forEach((track) => track.addEventListener?.('ended', handleTrackEnded));
        audio.addEventListener?.('loadstart', handleSourceChanged);
        audio.addEventListener?.('emptied', handleSourceChanged);
        resource.detachTrackListeners = () => {
            tracks.forEach((track) => track.removeEventListener?.('ended', handleTrackEnded));
            audio.removeEventListener?.('loadstart', handleSourceChanged);
            audio.removeEventListener?.('emptied', handleSourceChanged);
        };
        analyserResources.set(audio, resource);
        return createConsumer(resource);
    } catch (error) {
        try { source?.disconnect?.(); } catch (disconnectError) {}
        stream?.getTracks?.().forEach((track) => {
            try { track.stop?.(); } catch (stopError) {}
        });
        if (graphResult?.created) disposeAnalyserGraph(graphResult.graph);
        console.warn('Audio spectrum capture unsupported or restricted by browser:', error);
        return null;
    }
};

export const isAudioAnalyserCurrent = (consumer, audio) => (
    Boolean(consumer && !consumer.released && isResourceCurrent(consumer.resource, audio))
);

export const refreshAudioAnalyser = (consumer, audio) => {
    if (isAudioAnalyserCurrent(consumer, audio)) return consumer;
    releaseAudioAnalyser(consumer);
    return acquireAudioAnalyser(audio);
};

export const invalidateAudioAnalyser = (audio) => {
    playingMediaKeys.delete(audio);
    disposeResource(analyserResources.get(audio));
};

export const setAudioAnalyserActive = (consumer, active) => {
    if (!consumer || consumer.released || consumer.resource.disposed) return;
    consumer.active = active;
    queueContextReconcile(consumer.resource);
};

export const releaseAudioAnalyser = (consumer) => {
    if (!consumer || consumer.released) return;
    consumer.released = true;
    consumer.active = false;
    consumer.resource.consumers.delete(consumer);
    queueContextReconcile(consumer.resource);
};
