import test from 'node:test';
import assert from 'node:assert/strict';
import { nodes, flushAsync } from '../../test/lyricCandidateHarness.js';
import { createBackgroundModuleHarness } from '../../test/fullscreenBackgroundHarness.js';

function volumeHarness(enabled) {
  const localChanges = [], speakerChanges = [], audioWrites = [];
  let audioVolume = 0.3;
  const audio = { get volume() { return audioVolume; }, set volume(value) { audioWrites.push(value); audioVolume = value; } };
  const local = { volume: 0.3, audioRef: { current: audio }, setVolume: (value) => { local.volume = value; localChanges.push(value); } };
  const output = { enabled, speakerId: 'one', speakerVolume: 0.6, setSpeakerVolume: (value) => { output.speakerVolume = value; speakerChanges.push(value); } };
  const outputState = () => ({ target: output.enabled ? { id: `speaker:${output.speakerId}`, volume: output.speakerVolume,
    write: output.setSpeakerVolume, fallback: 0.5 } : null });
  const timers = new Map(); let nextTimer = 0;
  const document = { body: {}, activeElement: null }, sliderElement = {};
  const harness = createBackgroundModuleHarness({ file: new URL('./VolumeControl.jsx', import.meta.url),
    modules: {
      '../../i18n/index.js': { t: (text, values) => text.replace(/\{(\w+)\}/gu, (match, key) => values?.[key] ?? match) },
      'react-dom': { createPortal: (node) => node }, 'lucide-react': { Volume2: 'volume-on', VolumeX: 'volume-off' },
      '../store/usePlayerStore.js': { usePlayerStore: Object.assign(selector => selector(local), { getState: () => local }) },
      '../store/useOutputTargetStore.js': { useOutputTargetStore: Object.assign(selector => selector(outputState()), { getState: outputState }) },
      '../../hooks/usePlayerAutoHide.js': { usePlayerInteractionLock() {} },
    }, globals: { document, window: { innerWidth: 320, innerHeight: 640 },
      setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeout: (id) => timers.delete(id) },
  });
  const render = () => {
    const tree = harness.render({}), all = nodes(tree), button = all.find((node) => node.type === 'button');
    button.props.ref.current = { getBoundingClientRect: () => ({ left: 280, top: 500, width: 24 }) };
    const panel = all.find(node => 'inert' in node.props);
    panel.props.ref.current = { contains: (element) => element === sliderElement };
    return { tree, button, panel, sliders: all.filter((node) => node.props.type === 'range') };
  };
  const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } };
  return { harness, render, local, output, audio, localChanges, speakerChanges, audioWrites, document, sliderElement, timers, runTimers };
}

test('speaker mode keeps one slider and cannot alter local audio volume', () => {
  const subject = volumeHarness(true), view = subject.render();
  assert.deepEqual(view.sliders.map((slider) => slider.props['aria-label']), ['音量']);
  view.sliders[0].props.onChange({ target: { value: '0.42' } });
  assert.deepEqual(subject.localChanges, []);
  assert.deepEqual(subject.audioWrites, []);
  assert.deepEqual(subject.speakerChanges, [0.42]);
  assert.match(subject.render().button.props.title, /静音/);
  subject.harness.unmount();
});

test('speaker mode makes mute and wheel target only the speaker without writing local audio', () => {
  const subject = volumeHarness(true);
  let view = subject.render();
  assert.match(view.button.props.title, /60%/);
  view.button.props.onClick({ stopPropagation() {} }); // Open, then mute.
  view = subject.render(); view.button.props.onClick({ stopPropagation() {} });
  assert.deepEqual(subject.speakerChanges, [0]);
  assert.deepEqual(subject.audioWrites, []);
  view = subject.render(); view.button.props.onClick({ stopPropagation() {} });
  assert.deepEqual(subject.speakerChanges, [0, 0.6]);
  view = subject.render(); view.tree.props.onWheel({ deltaY: -1, stopPropagation() {} });
  assert.equal(subject.speakerChanges.at(-1), 0.65);
  assert.equal(subject.audio.volume, 0.3);
  subject.harness.unmount();
});

test('the shared single slider retains keyboard focus and dragging, then closes after lost pointer capture', () => {
  const subject = volumeHarness(true);
  let view = subject.render(); view.button.props.onClick({ stopPropagation() {} }); view = subject.render();
  assert.equal(view.panel.props.inert, undefined);
  subject.document.activeElement = subject.sliderElement;
  view.panel.props.onFocusCapture(); view.tree.props.onMouseLeave(); subject.runTimers();
  view = subject.render();
  assert.equal(view.panel.props.inert, undefined, 'pointer leave cannot hide a keyboard-focused range');
  subject.document.activeElement = null;
  let captured;
  view.sliders[0].props.onPointerDown({ pointerId: 4, currentTarget: { setPointerCapture: id => { captured = id; } } });
  assert.equal(captured, 4);
  view.tree.props.onMouseLeave(); subject.runTimers();
  assert.equal(subject.render().panel.props.inert, undefined, 'the panel stays usable while its range is being dragged');
  view.sliders[0].props.onLostPointerCapture(); subject.runTimers();
  assert.equal(subject.render().panel.props.inert, '');
  subject.harness.unmount();
  assert.equal(subject.timers.size, 0);
});

test('local mode preserves its original single slider and local mute behavior', () => {
  const subject = volumeHarness(false);
  let view = subject.render();
  assert.equal(view.sliders.length, 1);
  assert.equal(view.sliders[0].props['aria-label'], '音量');
  view.sliders[0].props.onChange({ target: { value: '0.5' } });
  assert.equal(subject.audio.volume, 0.5);
  view = subject.render(); view.button.props.onClick({ stopPropagation() {} });
  assert.equal(subject.audio.volume, 0);
  assert.deepEqual(subject.speakerChanges, []);
  subject.harness.unmount();
});

test('speaker volume setter rejections are handled without retrying or affecting local volume', async () => {
  const subject = volumeHarness(true); let attempts = 0;
  subject.output.setSpeakerVolume = async () => { attempts++; throw new Error('safe store error'); };
  subject.render().sliders[0].props.onChange({ target: { value: '0.5' } });
  await flushAsync();
  assert.equal(attempts, 1);
  assert.deepEqual(subject.audioWrites, []);
  subject.harness.unmount();
});
