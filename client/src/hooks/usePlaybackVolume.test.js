import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

function volumeHarness({ render = (module, props) => module.usePlaybackVolume(props) } = {}) {
  const localWrites = [], remoteWrites = [], audio = { volume: 0.3, muted: true };
  const local = { volume: 0.3, audioRef: { current: audio }, setVolume: value => { local.volume = value; localWrites.push(value); } };
  const output = { enabled: false, speakerId: 'one', speakerVolume: 0.6, error: '',
    setSpeakerVolume: value => { output.speakerVolume = value; remoteWrites.push(value); } };
  const playerStore = Object.assign(selector => selector(local), { getState: () => local });
  const outputState = () => ({ target: output.enabled ? { id: `speaker:${output.speakerId}`, volume: output.speakerVolume,
    error: output.error, write: output.setSpeakerVolume, fallback: 0.5 } : null });
  const outputStore = Object.assign(selector => selector(outputState()), { getState: outputState });
  const harness = createBackgroundModuleHarness({
    file: new URL('./usePlaybackVolume.js', import.meta.url),
    modules: { '../store/usePlayerStore.js': { usePlayerStore: playerStore },
      '../store/useOutputTargetStore.js': { useOutputTargetStore: outputStore } }, globals: {},
    render,
  });
  return { ...harness, local, output, audio, localWrites, remoteWrites, view: (props = {}) => harness.render(props) };
}

test('the single volume target routes local writes through the original local store and audio element', () => {
  const subject = volumeHarness(), target = subject.view();
  assert.equal(target.volume, 0.3);
  target.setVolume(0.4);
  assert.deepEqual(subject.localWrites, [0.4]);
  assert.equal(subject.audio.volume, 0.4);
  assert.equal(subject.audio.muted, true, 'volume adjustment does not bypass an existing mute gate');
  assert.deepEqual(subject.remoteWrites, []);
  subject.unmount();
});

test('speaker target volume and mute never write local preferences or bypass native muted state', () => {
  const subject = volumeHarness(); subject.output.enabled = true;
  let target = subject.view();
  assert.equal(target.volume, 0.6);
  target.setVolume(0.75); target = subject.view(); target.toggleMute();
  target = subject.view(); target.toggleMute();
  assert.deepEqual(subject.remoteWrites, [0.75, 0, 0.75]);
  assert.deepEqual(subject.localWrites, []);
  assert.equal(subject.audio.volume, 0.3);
  assert.equal(subject.audio.muted, true);
  subject.unmount();
});

test('mute restoration stays with its target across local and different speaker selections', () => {
  const subject = volumeHarness(); subject.view().toggleMute();
  assert.equal(subject.local.volume, 0);
  subject.output.enabled = true; subject.output.speakerVolume = 0;
  subject.view().toggleMute();
  assert.equal(subject.output.speakerVolume, 0.5, 'a newly muted output uses its own fallback, not local 0.3');
  subject.view().setVolume(0.7); subject.view().toggleMute();
  subject.output.enabled = false; subject.view().toggleMute();
  assert.equal(subject.local.volume, 0.3, 'the speaker restore value cannot leak into local output');
  subject.output.enabled = true; subject.output.speakerId = 'two'; subject.output.speakerVolume = 0;
  subject.view().toggleMute();
  assert.equal(subject.output.speakerVolume, 0.5, 'another speaker cannot inherit the previous speaker restore value');
  subject.unmount();
});

test('a control opened after muting restores the shared value instead of its fallback', () => {
  for (const speaker of [false, true]) {
    // The dock control is always mounted; fullscreen/lyrics controls mount later.
    const subject = volumeHarness({ render: (module, props) => ({ dock: module.usePlaybackVolume(),
      fullscreen: props?.fullscreen ? module.usePlaybackVolume() : null }) });
    subject.output.enabled = speaker;
    const current = () => (speaker ? subject.output.speakerVolume : subject.local.volume);
    subject.view().dock.toggleMute();
    assert.equal(current(), 0);
    subject.view({ fullscreen: true }).fullscreen.toggleMute();
    assert.equal(current(), speaker ? 0.6 : 0.3, speaker ? 'speaker' : 'local');
    subject.unmount();
  }
});

test('callbacks captured before a target switch resolve the current target before writing', () => {
  const subject = volumeHarness(), oldTarget = subject.view();
  subject.output.enabled = true;
  oldTarget.setVolume(0.2); oldTarget.toggleMute();
  assert.deepEqual(subject.remoteWrites, [0.2, 0]);
  assert.deepEqual(subject.localWrites, []);
  assert.equal(subject.audio.volume, 0.3);
  subject.unmount();
});

test('optional local props remain compatible while speaker mode cannot expose that local override', () => {
  const subject = volumeHarness(), audio = { volume: 0.2, muted: false }, writes = [];
  const props = { volume: 0.2, audioRef: { current: audio }, setVolume: value => { props.volume = value; writes.push(value); } };
  assert.equal(subject.view(props).volume, 0.2);
  subject.view(props).setVolume(0.4);
  assert.deepEqual(writes, [0.4]); assert.equal(audio.volume, 0.4);
  assert.deepEqual(subject.localWrites, []);
  subject.output.enabled = true; subject.view(props).setVolume(0.8);
  assert.deepEqual(writes, [0.4]); assert.equal(audio.volume, 0.4);
  assert.deepEqual(subject.remoteWrites, [0.8]);
  subject.unmount();
});

test('invalid volume is ignored, bounds are clamped, and target rejections do not escape', async () => {
  const subject = volumeHarness(); subject.output.enabled = true;
  subject.view().setVolume(Number.NaN); subject.view().setVolume(4); subject.view().setVolume(-2);
  assert.deepEqual(subject.remoteWrites, [1, 0]);
  let attempts = 0;
  subject.output.setSpeakerVolume = async () => { attempts++; throw new Error('target owns safe error'); };
  subject.view().setVolume(0.5); await flushBackgroundAsync();
  assert.equal(attempts, 1);
  assert.equal(subject.audio.muted, true);
  subject.unmount();
});

test('global volume keyboard shortcuts use the same active target setter as both sliders', () => {
  const subject = volumeHarness(), handlers = new Map();
  const keyboard = createBackgroundModuleHarness({ file: new URL('./useKeyboard.js', import.meta.url), exportName: 'useGlobalKeyboardShortcuts',
    modules: { '../i18n/index.js': { t: text => text }, '../utils/keyboardActivation.js': { isInteractiveKeyboardTarget: () => false } },
    globals: { window: { addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener: name => handlers.delete(name) } } });
  const props = () => ({ volume: subject.view().volume, setVolume: subject.view().setVolume,
    togglePlay() {}, playPrev() {}, playNext() {}, showToast() {} });
  const up = () => handlers.get('keydown')({ code: 'ArrowUp', key: 'ArrowUp', target: {}, preventDefault() {} });
  keyboard.render(props()); up();
  assert.equal(subject.local.volume, 0.4);
  subject.output.enabled = true; keyboard.render(props()); up();
  assert.equal(subject.output.speakerVolume, 0.7);
  assert.equal(subject.local.volume, 0.4);
  assert.equal(subject.audio.muted, true);
  keyboard.unmount(); subject.unmount();
});
