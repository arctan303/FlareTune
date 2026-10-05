import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, nodes } from '../../test/lyricCandidateHarness.js';
import { createLyricPlaybackClock } from '../../services/lyricPlaybackClock.js';
import * as timeline from '../../utils/lyricTimeline.js';
import * as adaptive from '../../utils/lyricAdaptiveTiming.js';
import * as interlude from '../../utils/interludeState.js';

function subject(file, currentTime) {
    const frames = new Map(), timers = new Map(), motionListeners = new Set();
    let id = 0;
    const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
    const mediaQuery = { matches: false, addEventListener: (_, fn) => motionListeners.add(fn), removeEventListener: (_, fn) => motionListeners.delete(fn) };
    const clock = createLyricPlaybackClock({ document,
        raf: fn => { frames.set(++id, fn); return id; }, caf: id => frames.delete(id),
        setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id),
    });
    const audio = { currentTime, duration: 120, paused: false, playbackRate: 1, addEventListener() {}, removeEventListener() {} };
    clock.attach(audio);
    const harness = hookComponent({ file: fileURLToPath(new URL(file, import.meta.url)),
        modules: {
            '../../i18n/index.js': { t: text => text },
            '../../services/lyricPlaybackClock.js': { lyricPlaybackClock: clock },
            '../../utils/lyricTimeline.js': timeline,
            '../../utils/lyricAdaptiveTiming.js': adaptive,
            '../../utils/interludeState.js': interlude,
            './synced-lyric-text.css': {}, './interlude-dots.css': {},
        },
        globals: { window: { matchMedia: () => mediaQuery, addEventListener() {}, removeEventListener() {} } },
    });
    return { clock, audio, harness, frames, timers, document, motionListeners };
}

function element() {
    const values = {};
    return { values, dataset: {}, style: { setProperty: (key, value) => { values[key] = value; }, removeProperty: key => { delete values[key]; } } };
}

test('completed characters stay level while only the current character rises, including backward seeks', () => {
    const s = subject('./SyncedLyricText.jsx', 1.25);
    const props = { active: true, visible: true, surface: 'classic', syncMode: 'word', clock: s.clock,
        line: { time: 0, text: 'ABCD', words: [{ text: 'AB', startTime: 0, endTime: 2 }, { text: 'CD', startTime: 2, endTime: 4 }] } };
    const tree = s.harness.render(props);
    const root = element(), words = [element(), element()];
    const characters = [element(), element(), element(), element()];
    tree.props.ref.current = root;
    nodes(tree).filter(node => node.props.className === 'synced-lyric-text__word').forEach((node, index) => node.props.ref(words[index]));
    nodes(tree).filter(node => node.props.className === 'synced-lyric-text__char').forEach((node, index) => node.props.ref(characters[index]));
    // This harness attaches refs after effects; reapply the initial snapshot with them attached.
    s.motionListeners.forEach(fn => fn({ matches: false }));
    s.clock.sample('timeupdate');
    assert.equal(characters[0].values['--synced-char-lift'], '-1.800px');
    assert.equal(characters[1].values['--synced-char-lift'], '-0.281px');
    assert.equal(characters[1].values['--synced-word-progress'], '25%');
    assert.equal(characters[2].values['--synced-char-lift'], '0.000px');
    assert.equal(nodes(tree).filter(node => node.props.className === 'synced-lyric-text__base').length, 0);
    assert.equal(nodes(tree).filter(node => node.props.className === 'synced-lyric-text__sung').length, 0);
    assert.ok(words.every(word => !('--synced-word-lift' in word.values)));
    assert.ok(!('--synced-line-lift' in root.values));
    assert.equal(root.dataset.motionRunning, 'true');
    s.audio.currentTime = 1.5;
    s.clock.sample('timeupdate');
    assert.equal(characters[0].values['--synced-char-lift'], '-1.800px');
    assert.equal(characters[1].values['--synced-char-lift'], '-0.900px');
    s.audio.currentTime = 2.25;
    s.clock.sample('timeupdate');
    assert.equal(characters[0].values['--synced-char-lift'], '-1.800px');
    assert.equal(characters[1].values['--synced-char-lift'], '-1.800px');
    assert.equal(characters[2].values['--synced-char-lift'], '-0.281px');
    assert.equal(characters[3].values['--synced-char-lift'], '0.000px');
    assert.equal(words[0].values['--synced-word-progress'], '100%');
    assert.equal(words[1].values['--synced-word-progress'], '12.5%');
    s.audio.currentTime = 0.5;
    s.clock.sample('seeked');
    assert.equal(characters[0].values['--synced-char-lift'], '-0.900px');
    assert.equal(characters[1].values['--synced-char-lift'], '0.000px');
    assert.equal(characters[2].dataset.charState, 'pending');
    s.audio.paused = true;
    s.clock.sample('pause');
    assert.equal(root.dataset.motionRunning, 'false');
    assert.equal(s.frames.size, 0);
    s.motionListeners.forEach(fn => fn({ matches: true }));
    assert.ok(characters.every(character => character.values['--synced-char-lift'] === '0.000px'));
    s.harness.unmount();
    assert.equal(s.frames.size, 0);
    assert.equal(s.timers.size, 0);
});

test('a combined letter and emoji remain individual visible characters within one timed word', () => {
    const s = subject('./SyncedLyricText.jsx', 0.5);
    const tree = s.harness.render({ active: true, surface: 'classic', syncMode: 'word', clock: s.clock,
        line: { time: 0, text: 'e\u0301🙂', words: [{ text: 'e\u0301🙂', startTime: 0, endTime: 2 }] } });
    const word = element(), characters = [element(), element()];
    nodes(tree).find(node => node.props.className === 'synced-lyric-text__word').props.ref(word);
    const characterNodes = nodes(tree).filter(node => node.props.className === 'synced-lyric-text__char');
    assert.equal(characterNodes.length, 2);
    assert.deepEqual(characterNodes.map(node => node.props.children[0]), ['e\u0301', '🙂']);
    characterNodes.forEach((node, index) => node.props.ref(characters[index]));
    s.clock.sample('timeupdate');
    assert.equal(characters[0].values['--synced-char-lift'], '-0.900px');
    assert.equal(characters[1].values['--synced-char-lift'], '0.000px');
    s.harness.unmount();
});

test('actual interval dots keep continuous progress without React renders and release work on pause, hide and reduced motion', () => {
    const s = subject('./InterludeDots.jsx', 25);
    const props = { active: true, window: { start: 10, end: 100, duration: 90 }, clock: s.clock };
    const tree = s.harness.render(props);
    const root = element(), dots = [element(), element(), element()];
    tree.props.ref.current = root;
    nodes(tree).filter(node => node.props.className === 'classic-interlude-dot').forEach((node, index) => node.props.ref(dots[index]));
    s.clock.sample('timeupdate');
    assert.equal(dots[0].values['--interlude-dot-fill'], '50.000%');
    assert.equal(dots[0].dataset.fillState, 'filling');
    assert.equal(dots[1].dataset.fillState, 'pending');
    assert.equal(s.frames.size, 1);
    s.audio.currentTime = 27;
    s.clock.sample('timeupdate');
    assert.ok(parseFloat(dots[0].values['--interlude-dot-fill']) > 50);
    s.audio.paused = true;
    s.clock.sample('pause');
    assert.equal(s.frames.size, 0);
    assert.equal(root.dataset.motionRunning, 'false');
    s.audio.paused = false;
    s.audio.currentTime = 15;
    s.clock.sample('seeked');
    assert.equal(dots[0].values['--interlude-dot-fill'], '16.667%');
    s.document.visibilityState = 'hidden';
    s.clock.sample('visibilitychange');
    assert.equal(s.frames.size, 0);
    s.document.visibilityState = 'visible';
    s.clock.sample('visibilitychange');
    assert.equal(s.frames.size, 1);
    s.motionListeners.forEach(fn => fn({ matches: true }));
    assert.equal(s.frames.size, 0);
    s.audio.currentTime = 45;
    s.clock.sample('timeupdate');
    assert.equal(dots[0].dataset.fillState, 'complete');
    assert.equal(dots[1].values['--interlude-dot-fill'], '16.667%');
    s.harness.render({ ...props, active: false });
    assert.equal(s.frames.size, 0);
    assert.equal(s.timers.size, 0);
    s.harness.unmount();
    assert.equal(s.motionListeners.size, 0);
});
