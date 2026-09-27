import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricPlaybackClock } from './lyricPlaybackClock.js';

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type) {
        for (const listener of [...(this.listeners.get(type) || [])]) {
            listener({ type, currentTarget: this });
        }
    }

    listenerCount(type) {
        return this.listeners.get(type)?.size || 0;
    }
}

class FakeAudio extends FakeEventTarget {
    constructor() {
        super();
        this.currentTime = 0;
        this.duration = 180;
        this.playbackRate = 1;
        this.paused = true;
        this.seeking = false;
        this.ended = false;
        this.readyState = 4;
    }
}

class FakeDocument extends FakeEventTarget {
    constructor() {
        super();
        this.visibilityState = 'visible';
    }
}

const createFrameHarness = () => {
    let nextId = 1;
    const frames = new Map();
    const cancelled = [];
    return {
        raf(callback) {
            const id = nextId;
            nextId += 1;
            frames.set(id, callback);
            return id;
        },
        caf(id) {
            cancelled.push(id);
            frames.delete(id);
        },
        flushOne() {
            const entry = frames.entries().next().value;
            if (!entry) return false;
            const [id, callback] = entry;
            frames.delete(id);
            callback(16);
            return true;
        },
        get pendingCount() {
            return frames.size;
        },
        cancelled,
    };
};

const makeClockHarness = () => {
    const frames = createFrameHarness();
    const document = new FakeDocument();
    const errors = [];
    const clock = createLyricPlaybackClock({
        raf: (callback) => frames.raf(callback),
        caf: (id) => frames.caf(id),
        document,
        onListenerError: (error) => errors.push(error),
    });
    return { clock, document, frames, errors };
};

test('subscribe immediately receives the complete snapshot and idle clocks schedule no frame', () => {
    const { clock, frames } = makeClockHarness();
    const audio = new FakeAudio();
    clock.attach(audio);

    const received = [];
    const unsubscribe = clock.subscribe((snapshot) => received.push(snapshot));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
        currentTime: 0,
        duration: 180,
        playbackRate: 1,
        paused: true,
        seeking: false,
        buffering: false,
        ended: false,
        visible: true,
        reason: 'subscribe',
    });
    assert.equal(frames.pendingCount, 0);
    unsubscribe();
});

test('multiple subscribers share at most one RAF and the final unsubscribe stops it', () => {
    const { clock, frames } = makeClockHarness();
    const audio = new FakeAudio();
    audio.paused = false;
    clock.attach(audio);

    const first = [];
    const second = [];
    const unsubscribeFirst = clock.subscribe((snapshot) => first.push(snapshot.reason));
    const unsubscribeSecond = clock.subscribe((snapshot) => second.push(snapshot.reason));
    assert.equal(frames.pendingCount, 1);

    clock.sample('manual');
    assert.equal(frames.pendingCount, 1);
    assert.equal(frames.flushOne(), true);
    assert.equal(frames.pendingCount, 1);
    assert.equal(first.at(-1), 'animation-frame');
    assert.equal(second.at(-1), 'animation-frame');

    unsubscribeFirst();
    assert.equal(frames.pendingCount, 1);
    unsubscribeSecond();
    assert.equal(frames.pendingCount, 0);
    assert.ok(frames.cancelled.length >= 1);
});

test('audio and visibility events synchronously sample, stop, and restart the loop', () => {
    const { clock, document, frames } = makeClockHarness();
    const audio = new FakeAudio();
    const received = [];
    clock.attach(audio);
    clock.subscribe((snapshot) => received.push(snapshot));

    audio.paused = false;
    audio.dispatch('play');
    assert.equal(frames.pendingCount, 1);

    audio.dispatch('waiting');
    assert.equal(clock.getSnapshot().buffering, true);
    assert.equal(frames.pendingCount, 0);

    audio.currentTime = 12.5;
    audio.readyState = 1;
    audio.dispatch('timeupdate');
    assert.equal(clock.getSnapshot().currentTime, 12.5);
    assert.equal(clock.getSnapshot().buffering, true);
    assert.equal(frames.pendingCount, 0);

    audio.dispatch('playing');
    assert.equal(clock.getSnapshot().buffering, false);
    assert.equal(frames.pendingCount, 1);

    audio.seeking = true;
    audio.dispatch('seeking');
    assert.equal(clock.getSnapshot().seeking, true);
    assert.equal(frames.pendingCount, 0);

    audio.currentTime = 80;
    audio.seeking = false;
    audio.dispatch('seeked');
    assert.equal(clock.getSnapshot().currentTime, 80);
    assert.equal(clock.getSnapshot().seeking, false);
    assert.equal(frames.pendingCount, 1);

    audio.playbackRate = 2;
    audio.dispatch('ratechange');
    assert.equal(clock.getSnapshot().playbackRate, 2);
    assert.equal(received.at(-1).reason, 'ratechange');
    assert.equal(frames.pendingCount, 1);

    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    assert.equal(clock.getSnapshot().visible, false);
    assert.equal(frames.pendingCount, 0);

    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    assert.equal(clock.getSnapshot().visible, true);
    assert.equal(frames.pendingCount, 1);

    audio.ended = true;
    audio.dispatch('ended');
    assert.equal(clock.getSnapshot().ended, true);
    assert.equal(frames.pendingCount, 0);
});

test('buffering can recover from a healthy timeupdate and load lifecycle remains stopped until ready', () => {
    const { clock, frames } = makeClockHarness();
    const audio = new FakeAudio();
    audio.paused = false;
    clock.attach(audio);
    clock.subscribe(() => {});
    assert.equal(frames.pendingCount, 1);

    audio.dispatch('loadstart');
    assert.equal(clock.getSnapshot().buffering, true);
    assert.equal(frames.pendingCount, 0);

    audio.dispatch('loadedmetadata');
    assert.equal(clock.getSnapshot().buffering, true);
    assert.equal(frames.pendingCount, 0);

    audio.readyState = 3;
    audio.dispatch('timeupdate');
    assert.equal(clock.getSnapshot().buffering, false);
    assert.equal(frames.pendingCount, 1);

    audio.dispatch('emptied');
    assert.equal(clock.getSnapshot().buffering, true);
    assert.equal(frames.pendingCount, 0);

    audio.dispatch('canplay');
    assert.equal(clock.getSnapshot().buffering, false);
    assert.equal(frames.pendingCount, 1);
});

test('a new media resource clears stale seeking and ended state before it becomes playable', () => {
    const { clock, frames } = makeClockHarness();
    const audio = new FakeAudio();
    audio.paused = false;
    clock.attach(audio);
    clock.subscribe(() => {});

    audio.seeking = true;
    audio.dispatch('seeking');
    audio.ended = true;
    audio.dispatch('ended');
    assert.equal(clock.getSnapshot().seeking, true);
    assert.equal(clock.getSnapshot().ended, true);

    audio.seeking = false;
    audio.ended = false;
    audio.currentTime = 0;
    audio.dispatch('loadstart');
    assert.equal(clock.getSnapshot().seeking, false);
    assert.equal(clock.getSnapshot().ended, false);
    assert.equal(clock.getSnapshot().buffering, true);
    assert.equal(frames.pendingCount, 0);

    audio.dispatch('canplay');
    assert.equal(clock.getSnapshot().buffering, false);
    assert.equal(frames.pendingCount, 1);
});

test('idempotent attach does not duplicate listeners and stale detach cannot remove a replacement audio', () => {
    const { clock, document, frames } = makeClockHarness();
    const firstAudio = new FakeAudio();
    const secondAudio = new FakeAudio();
    secondAudio.paused = false;

    clock.attach(firstAudio);
    clock.attach(firstAudio);
    assert.equal(firstAudio.listenerCount('play'), 1);
    assert.equal(document.listenerCount('visibilitychange'), 1);

    clock.subscribe(() => {});
    clock.attach(secondAudio);
    assert.equal(firstAudio.listenerCount('play'), 0);
    assert.equal(secondAudio.listenerCount('play'), 1);
    assert.equal(document.listenerCount('visibilitychange'), 1);
    assert.equal(frames.pendingCount, 1);

    clock.detach(firstAudio);
    assert.equal(secondAudio.listenerCount('play'), 1);
    assert.equal(clock.getSnapshot().paused, false);

    clock.detach(secondAudio);
    assert.equal(secondAudio.listenerCount('play'), 0);
    assert.equal(document.listenerCount('visibilitychange'), 0);
    assert.equal(frames.pendingCount, 0);
    assert.equal(clock.getSnapshot().reason, 'detach');
});

test('one failing listener does not prevent other listeners or future frames', () => {
    const { clock, frames, errors } = makeClockHarness();
    const audio = new FakeAudio();
    audio.paused = false;
    clock.attach(audio);

    let healthyCalls = 0;
    clock.subscribe(() => {
        throw new Error('listener failure');
    });
    clock.subscribe(() => {
        healthyCalls += 1;
    });

    assert.equal(errors.length, 1);
    assert.equal(healthyCalls, 1);
    assert.equal(frames.pendingCount, 1);
    frames.flushOne();
    assert.equal(errors.length, 2);
    assert.equal(healthyCalls, 2);
    assert.equal(frames.pendingCount, 1);
});
