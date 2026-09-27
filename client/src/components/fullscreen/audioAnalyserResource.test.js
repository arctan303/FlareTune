import assert from 'node:assert/strict';
import test from 'node:test';
import {
    acquireAudioAnalyser,
    invalidateAudioAnalyser,
    isAudioAnalyserCurrent,
    markAudioAnalyserPlaying,
    refreshAudioAnalyser,
    releaseAudioAnalyser,
    setAudioAnalyserActive,
} from './audioAnalyserResource.js';

const setNavigator = (value) => {
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value,
    });
};

const withAudioEnvironment = async (run) => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    try {
        setNavigator({ platform: 'Win32', userAgent: 'Desktop browser' });
        const contexts = [];
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                AudioContext: class {
                    constructor() {
                        this.state = 'running';
                        this.suspendCalls = 0;
                        this.resumeCalls = 0;
                        contexts.push(this);
                    }

                    createAnalyser() {
                        return { fftSize: 0, smoothingTimeConstant: 0 };
                    }

                    createMediaStreamSource() {
                        return { connect() {}, disconnect() {} };
                    }

                    suspend() {
                        this.suspendCalls += 1;
                        this.state = 'suspended';
                        return Promise.resolve();
                    }

                    resume() {
                        this.resumeCalls += 1;
                        this.state = 'running';
                        return Promise.resolve();
                    }

                    close() {
                        this.state = 'closed';
                        return Promise.resolve();
                    }
                },
            },
        });

        const createAudio = (initialSrc = 'https://media.example.test/audio/current.mp3') => {
            let currentSrc = initialSrc;
            let captureCalls = 0;
            const tracks = [];
            const audio = {
                get currentSrc() { return currentSrc; },
                set currentSrc(value) { currentSrc = value; },
                captureStream() {
                    captureCalls += 1;
                    const listeners = new Set();
                    const track = {
                        readyState: 'live',
                        addEventListener(type, listener) {
                            if (type === 'ended') listeners.add(listener);
                        },
                        removeEventListener(type, listener) {
                            if (type === 'ended') listeners.delete(listener);
                        },
                        stop() { this.readyState = 'ended'; },
                        end() {
                            this.readyState = 'ended';
                            [...listeners].forEach((listener) => listener());
                        },
                    };
                    tracks.push(track);
                    return {
                        getAudioTracks: () => [track],
                        getTracks: () => [track],
                    };
                },
            };
            return {
                audio,
                get captureCalls() { return captureCalls; },
                tracks,
            };
        };

        await run({ contexts, createAudio });
    } finally {
        if (originalNavigator) {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
            delete globalThis.navigator;
        }
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete globalThis.window;
        }
    }
};

test('audio analyser never reroutes the media element output', () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    try {
        let contextCreations = 0;
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                AudioContext: class {
                    constructor() {
                        contextCreations += 1;
                    }
                },
            },
        });

        setNavigator({ platform: 'Linux armv8l', userAgent: 'Android' });
        const androidAudio = {
            captureStream() {
                assert.fail('Android must retain the native media path');
            },
        };
        assert.equal(acquireAudioAnalyser(androidAudio), null);
        assert.equal(contextCreations, 0);

        setNavigator({ platform: 'Win32', userAgent: 'Desktop browser' });
        const capturedStream = { getAudioTracks: () => [{}] };
        const analyser = { fftSize: 0, smoothingTimeConstant: 0 };
        let connectedTo = null;
        let receivedStream = null;
        let mediaElementSourceCalls = 0;

        window.AudioContext = class {
            constructor() {
                contextCreations += 1;
                this.state = 'running';
            }

            createAnalyser() {
                return analyser;
            }

            createMediaElementSource() {
                mediaElementSourceCalls += 1;
                assert.fail('media playback must not be rerouted through Web Audio');
            }

            createMediaStreamSource(stream) {
                receivedStream = stream;
                return {
                    connect(target) {
                        connectedTo = target;
                    },
                };
            }

            suspend() {
                this.state = 'suspended';
                return Promise.resolve();
            }

            resume() {
                this.state = 'running';
                return Promise.resolve();
            }

            close() {
                this.state = 'closed';
                return Promise.resolve();
            }
        };

        const desktopAudio = { captureStream: () => capturedStream };
        markAudioAnalyserPlaying(desktopAudio);
        const consumer = acquireAudioAnalyser(desktopAudio);
        assert.ok(consumer);
        assert.equal(consumer.analyser, analyser);
        assert.equal(receivedStream, capturedStream);
        assert.equal(connectedTo, analyser);
        assert.equal(mediaElementSourceCalls, 0);
        releaseAudioAnalyser(consumer);

        const previousCreations = contextCreations;
        assert.equal(acquireAudioAnalyser({}), null);
        assert.equal(contextCreations, previousCreations);
    } finally {
        if (originalNavigator) {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
            delete globalThis.navigator;
        }
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete globalThis.window;
        }
    }
});
test('audio analyser replaces the captured stream but preserves its graph when the media element changes source', () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    try {
        setNavigator({ platform: 'Win32', userAgent: 'Desktop browser' });
        const createdAnalysers = [];
        const createdStreams = [];
        const closedContexts = [];
        let currentSrc = 'https://media.example.test/audio/first.mp3';

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                AudioContext: class {
                    constructor() {
                        this.state = 'running';
                    }

                    createAnalyser() {
                        const analyser = { fftSize: 0, smoothingTimeConstant: 0 };
                        createdAnalysers.push(analyser);
                        return analyser;
                    }

                    createMediaStreamSource() {
                        return { connect() {}, disconnect() {} };
                    }

                    suspend() {
                        this.state = 'suspended';
                        return Promise.resolve();
                    }

                    resume() {
                        this.state = 'running';
                        return Promise.resolve();
                    }

                    close() {
                        this.state = 'closed';
                        closedContexts.push(this);
                        return Promise.resolve();
                    }
                },
            },
        });

        const audio = {
            get currentSrc() { return currentSrc; },
            getAttribute() { return currentSrc; },
            captureStream() {
                const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
                const stream = {
                    track,
                    getAudioTracks: () => [track],
                    getTracks: () => [track],
                };
                createdStreams.push(stream);
                return stream;
            },
        };

        markAudioAnalyserPlaying(audio);
        const first = acquireAudioAnalyser(audio);
        currentSrc = 'https://media.example.test/audio/second.mp3';
        assert.equal(acquireAudioAnalyser(audio), null);
        assert.equal(createdStreams.length, 1);
        markAudioAnalyserPlaying(audio);
        const second = acquireAudioAnalyser(audio);

        assert.equal(second.analyser, first.analyser);
        assert.equal(createdAnalysers.length, 1);
        assert.equal(createdStreams.length, 2);
        assert.equal(createdStreams[0].track.readyState, 'ended');
        assert.equal(closedContexts.length, 0);

        releaseAudioAnalyser(first);
        releaseAudioAnalyser(second);
    } finally {
        if (originalNavigator) {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
            delete globalThis.navigator;
        }
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete globalThis.window;
        }
    }
});

test('audio analyser replaces ended tracks and closed contexts instead of reusing a silent resource', () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    try {
        setNavigator({ platform: 'Win32', userAgent: 'Desktop browser' });
        const contexts = [];
        const streams = [];

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                AudioContext: class {
                    constructor() {
                        this.state = 'running';
                        contexts.push(this);
                    }

                    createAnalyser() {
                        return { fftSize: 0, smoothingTimeConstant: 0 };
                    }

                    createMediaStreamSource() {
                        return { connect() {}, disconnect() {} };
                    }

                    suspend() {
                        this.state = 'suspended';
                        return Promise.resolve();
                    }

                    resume() {
                        this.state = 'running';
                        return Promise.resolve();
                    }

                    close() {
                        this.state = 'closed';
                        return Promise.resolve();
                    }
                },
            },
        });

        const audio = {
            currentSrc: 'https://media.example.test/audio/current.mp3',
            captureStream() {
                const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
                const stream = {
                    track,
                    getAudioTracks: () => [track],
                    getTracks: () => [track],
                };
                streams.push(stream);
                return stream;
            },
        };

        markAudioAnalyserPlaying(audio);
        const first = acquireAudioAnalyser(audio);
        streams[0].track.readyState = 'ended';
        const second = refreshAudioAnalyser(first, audio);
        assert.notEqual(second, first);
        assert.equal(second.analyser, first.analyser);
        assert.equal(contexts.length, 1);
        assert.equal(isAudioAnalyserCurrent(first, audio), false);
        assert.equal(isAudioAnalyserCurrent(second, audio), true);

        contexts[0].state = 'closed';
        const third = refreshAudioAnalyser(second, audio);
        assert.notEqual(third, second);
        assert.notEqual(third.analyser, second.analyser);
        assert.equal(isAudioAnalyserCurrent(second, audio), false);
        assert.equal(isAudioAnalyserCurrent(third, audio), true);
        assert.equal(contexts.length, 2);
        assert.equal(streams.length, 3);

        releaseAudioAnalyser(third);
    } finally {
        if (originalNavigator) {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
            delete globalThis.navigator;
        }
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete globalThis.window;
        }
    }
});

test('audio analyser resumes an interrupted context when an active consumer returns', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    try {
        setNavigator({ platform: 'Win32', userAgent: 'Desktop browser' });
        let resumeCalls = 0;
        const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                AudioContext: class {
                    constructor() { this.state = 'running'; }
                    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0 }; }
                    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
                    suspend() { this.state = 'suspended'; return Promise.resolve(); }
                    resume() { resumeCalls += 1; this.state = 'running'; return Promise.resolve(); }
                    close() { this.state = 'closed'; return Promise.resolve(); }
                },
            },
        });

        const audio = {
            currentSrc: 'https://media.example.test/audio/current.mp3',
            captureStream: () => ({
                getAudioTracks: () => [track],
                getTracks: () => [track],
            }),
        };
        markAudioAnalyserPlaying(audio);
        const consumer = acquireAudioAnalyser(audio);
        consumer.resource.context.state = 'interrupted';
        setAudioAnalyserActive(consumer, true);
        await consumer.resource.stateQueue;

        assert.equal(resumeCalls, 1);
        assert.equal(consumer.resource.context.state, 'running');
        releaseAudioAnalyser(consumer);
    } finally {
        if (originalNavigator) {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
            delete globalThis.navigator;
        }
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete globalThis.window;
        }
    }
});

test('audio analyser preserves its graph while waiting for the next source playing epoch', async () => {
    await withAudioEnvironment(async ({ contexts, createAudio }) => {
        const fixture = createAudio('https://media.example.test/audio/first.mp3');

        assert.equal(acquireAudioAnalyser(fixture.audio), null);
        assert.equal(fixture.captureCalls, 0);

        markAudioAnalyserPlaying(fixture.audio);
        const first = acquireAudioAnalyser(fixture.audio);
        assert.ok(first);
        assert.equal(fixture.captureCalls, 1);

        invalidateAudioAnalyser(fixture.audio);
        fixture.audio.currentSrc = 'https://media.example.test/audio/second.mp3';
        assert.equal(acquireAudioAnalyser(fixture.audio), null);
        assert.equal(acquireAudioAnalyser(fixture.audio), null);
        assert.equal(fixture.captureCalls, 1);

        markAudioAnalyserPlaying(fixture.audio);
        const second = acquireAudioAnalyser(fixture.audio);
        assert.ok(second);
        assert.equal(second.analyser, first.analyser);
        assert.equal(contexts.length, 1);
        assert.equal(fixture.captureCalls, 2);
        releaseAudioAnalyser(second);
    });
});

test('audio analyser reuses one healthy resource for multiple consumers', async () => {
    await withAudioEnvironment(async ({ contexts, createAudio }) => {
        const fixture = createAudio();
        markAudioAnalyserPlaying(fixture.audio);

        const first = acquireAudioAnalyser(fixture.audio);
        const second = acquireAudioAnalyser(fixture.audio);

        assert.equal(first.analyser, second.analyser);
        assert.equal(first.resource, second.resource);
        assert.equal(fixture.captureCalls, 1);
        assert.equal(contexts.length, 1);

        releaseAudioAnalyser(first);
        releaseAudioAnalyser(second);
        await second.resource.stateQueue;
    });
});

test('audio analyser keeps running until its final consumer is released', async () => {
    await withAudioEnvironment(async ({ contexts, createAudio }) => {
        const fixture = createAudio();
        markAudioAnalyserPlaying(fixture.audio);
        const first = acquireAudioAnalyser(fixture.audio);
        const second = acquireAudioAnalyser(fixture.audio);
        const resource = first.resource;

        releaseAudioAnalyser(first);
        await resource.stateQueue;
        assert.equal(contexts[0].state, 'running');
        assert.equal(contexts[0].suspendCalls, 0);

        releaseAudioAnalyser(second);
        await resource.stateQueue;
        assert.equal(contexts[0].state, 'suspended');
        assert.equal(contexts[0].suspendCalls, 1);
    });
});

test('audio analyser disposes an ended track through its event listener', async () => {
    await withAudioEnvironment(async ({ contexts, createAudio }) => {
        const fixture = createAudio();
        markAudioAnalyserPlaying(fixture.audio);
        const first = acquireAudioAnalyser(fixture.audio);

        fixture.tracks[0].end();
        await first.resource.stateQueue;
        assert.equal(first.released, true);
        assert.equal(contexts[0].state, 'suspended');
        assert.equal(isAudioAnalyserCurrent(first, fixture.audio), false);

        const second = acquireAudioAnalyser(fixture.audio);
        assert.ok(second);
        assert.equal(fixture.captureCalls, 2);
        assert.equal(first.analyser, second.analyser);
        assert.equal(contexts.length, 1);
        releaseAudioAnalyser(second);
    });
});

test('audio analyser successfully captures and resumes when AudioContext starts in suspended state', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    try {
        setNavigator({ platform: 'Win32', userAgent: 'Desktop browser' });
        let resumeCalls = 0;
        const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                AudioContext: class {
                    constructor() {
                        this.state = 'suspended'; // 模拟现代浏览器自动策略下初始 suspended
                    }
                    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0 }; }
                    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
                    suspend() { this.state = 'suspended'; return Promise.resolve(); }
                    resume() {
                        resumeCalls += 1;
                        this.state = 'running';
                        return Promise.resolve();
                    }
                    close() { this.state = 'closed'; return Promise.resolve(); }
                },
            },
        });

        const audio = {
            currentSrc: 'https://media.example.test/audio/suspended-init.mp3',
            captureStream: () => ({
                getAudioTracks: () => [track],
                getTracks: () => [track],
            }),
        };
        markAudioAnalyserPlaying(audio);
        const consumer = acquireAudioAnalyser(audio);
        assert.ok(consumer, 'Consumer should be acquired even if AudioContext was initially suspended');

        // 等待状态调度队列将 suspended 状态自动 resume
        await consumer.resource.stateQueue;
        assert.equal(resumeCalls, 1);
        assert.equal(consumer.resource.context.state, 'running');

        releaseAudioAnalyser(consumer);
    } finally {
        if (originalNavigator) {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
            delete globalThis.navigator;
        }
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete globalThis.window;
        }
    }
});
