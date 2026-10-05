import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, nodes } from '../test/lyricCandidateHarness.js';
import * as navigation from './lyricKeyboardNavigation.js';

function createHarness(extraProps = {}) {
  const focusEvents = [];
  const locks = [];
  const timers = new Map();
  let nextTimer = 0;
  const document = { activeElement: null };
  const sliderElement = {};
  const buttonElement = {};
  const volumeRegion = { contains: (target) => target === sliderElement || target === buttonElement };
  const audio = { currentTime: 0 };
  const harness = hookComponent({ file: fileURLToPath(new URL('./LyricsScroller.jsx', import.meta.url)),
    modules: {
      '../i18n/index.js': { t: (text) => text },
      'lucide-react': { VolumeX: 'icon', Volume2: 'icon', Loader2: 'icon' },
      './lyrics/InterludeHost': 'interlude-host',
      './lyrics/SyncedLyricText': 'synced-text',
      './lyrics/lyricSurfacePresentation.js': { useLyricSurfacePresentation: ({ lyrics, currentLyricIndex }) => ({
        index: currentLyricIndex, kind: 'line', line: lyrics[currentLyricIndex],
      }) },
      './fullscreen/useMediaQuery': { useMediaQuery: () => false },
      './lyricKeyboardNavigation.js': navigation,
      '../hooks/usePlayerAutoHide.js': { usePlayerInteractionLock: (active) => locks.push(active) },
    },
    globals: { window: { addEventListener() {}, removeEventListener() {} },
      document, cancelAnimationFrame() {},
      setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
      clearTimeout: (id) => timers.delete(id) },
  });
  const props = { lyrics: [{ time: 0, text: 'first' }, { text: 'untimed' },
    { time: 4, text: 'second' }, { time: 9, text: 'third' }], currentLyricIndex: 0,
    audioRef: { current: audio }, volume: 0.8, setVolume() {}, isFullScreen: false, surfaceVisible: true,
    ...extraProps };
  const render = () => {
    const tree = harness.render(props);
    const volume = nodes(tree).find((node) => node.props.className?.startsWith('classic-lyrics__volume '));
    volume.props.ref.current = volumeRegion;
    const slider = nodes(volume).find((node) => node.props.type === 'range');
    const volumeButton = nodes(volume).find((node) => node.type === 'button');
    const panel = nodes(volume).find((node) => 'inert' in node.props);
    const rows = nodes(tree).filter((node) => node.props.role === 'button');
    for (const row of rows) row.props.ref({
      focus: () => focusEvents.push(row.props['data-lyric-index']), scrollIntoView() {},
    });
    return { tree, rows, volume, slider, volumeButton, panel };
  };
  const key = (row, value) => {
    const target = {};
    let prevented = false;
    row.props.onKeyDown({ key: value, target, currentTarget: target,
      preventDefault: () => { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
  };
  const runTimers = () => {
    const pending = [...timers.entries()];
    pending.forEach(([id, timer]) => { timers.delete(id); timer.callback(); });
  };
  return { harness, props, render, key, audio, focusEvents, timers, runTimers,
    document, sliderElement, buttonElement, volumeRegion, locks };
}

test('actual scroller keeps a single lyric tabstop, skips untimed rows and seeks with Enter/Space', () => {
  const subject = createHarness();
  let { rows } = subject.render();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.props.tabIndex), [0, -1, -1]);
  subject.key(rows[0], 'ArrowDown');
  ({ rows } = subject.render());
  assert.deepEqual(subject.focusEvents, [2]);
  assert.deepEqual(rows.map((row) => row.props.tabIndex), [-1, 0, -1]);
  subject.key(rows[1], 'Enter');
  assert.equal(subject.audio.currentTime, 4);
  subject.key(rows[1], 'End');
  ({ rows } = subject.render());
  assert.equal(rows[2].props.tabIndex, 0);
  subject.key(rows[2], ' ');
  assert.equal(subject.audio.currentTime, 9);
  subject.key(rows[2], 'Home');
  ({ rows } = subject.render());
  assert.equal(rows[0].props.tabIndex, 0);
  subject.key(rows[0], 'ArrowUp');
  assert.equal(subject.focusEvents.at(-1), 0);
  subject.harness.unmount();
});

test('hidden-surface rows cannot be tabbed and touch-protected clicks still wake before seeking', () => {
  let wakes = 0;
  const subject = createHarness({ isControlsHidden: true, onWakeControls: () => { wakes += 1; } });
  const { tree, rows } = subject.render();
  const clickable = nodes(tree).filter((node) => node.props.className?.startsWith('classic-lyrics__line '));
  clickable[2].props.onClick();
  assert.equal(wakes, 1);
  assert.equal(subject.audio.currentTime, 0);
  subject.key(rows[1], 'Enter');
  assert.equal(subject.audio.currentTime, 4);
  subject.props.surfaceVisible = false;
  const hidden = subject.render().rows;
  assert.ok(hidden.every((row) => row.props.tabIndex === undefined));
  subject.harness.unmount();
});

test('lyric volume keeps focus interaction open and closes only after focus leaves', () => {
  const subject = createHarness();
  let view = subject.render();
  assert.equal(view.panel.props.inert, '');
  view.volumeButton.props.onClick({ stopPropagation() {} });
  view = subject.render();
  assert.equal(view.panel.props['aria-hidden'], undefined);
  assert.equal(subject.locks.at(-1), true);

  subject.document.activeElement = subject.sliderElement;
  view.volume.props.onFocusCapture();
  assert.equal(subject.timers.size, 0);
  view.volume.props.onMouseLeave();
  subject.runTimers();
  view = subject.render();
  assert.equal(view.panel.props.inert, undefined, 'leaving with the pointer cannot hide the focused slider');
  view.slider.props.onChange({ target: { value: '0.33' } });
  assert.equal(subject.audio.volume, 0.33);
  view.volume.props.onBlurCapture({ currentTarget: subject.volumeRegion, relatedTarget: subject.buttonElement });
  assert.equal(subject.timers.size, 0, 'focus can move between slider and trigger without dismissal');

  subject.document.activeElement = null;
  view.volume.props.onBlurCapture({ currentTarget: subject.volumeRegion, relatedTarget: null });
  assert.equal([...subject.timers.values()][0].delay, 1200);
  subject.runTimers();
  view = subject.render();
  assert.equal(view.panel.props.inert, '');
  assert.equal(view.panel.props['aria-hidden'], true);
  assert.equal(subject.locks.at(-1), false);
  subject.harness.unmount();
  assert.equal(subject.timers.size, 0);
});

test('lyric volume drag retains pointer capture and each release route resumes dismissal', () => {
  const subject = createHarness();
  for (const release of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture']) {
    let view = subject.render();
    view.volumeButton.props.onClick({ stopPropagation() {} });
    view = subject.render();
    let captured;
    view.slider.props.onPointerDown({ pointerId: 7,
      currentTarget: { setPointerCapture: (id) => { captured = id; } } });
    assert.equal(captured, 7);
    view.volume.props.onMouseLeave();
    subject.runTimers();
    view = subject.render();
    assert.equal(view.panel.props.inert, undefined, 'timer cannot hide an active drag');
    view.slider.props[release]();
    assert.equal([...subject.timers.values()][0].delay, 2500);
    subject.runTimers();
    assert.equal(subject.render().panel.props.inert, '');
  }
  let view = subject.render();
  view.volumeButton.props.onClick({ stopPropagation() {} });
  subject.props.surfaceVisible = false;
  subject.render();
  assert.equal(subject.locks.at(-1), false, 'an invisible lyric surface cannot hold player controls open');
  subject.harness.unmount();
  assert.equal(subject.timers.size, 0);
});
