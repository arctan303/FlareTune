import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundModuleHarness, createBackgroundScheduler,
  createVisibilityDocument, flushBackgroundAsync,
} from '../../test/fullscreenBackgroundHarness.js';

function createFixture() {
  const scheduler = createBackgroundScheduler();
  const document = createVisibilityDocument();
  const contexts = [], tracks = [];
  let captures = 0, samples = 0;
  const audio = Object.assign(createVisibilityDocument(), {
    currentSrc: 'https://example.test/song.mp3', currentTime: 1, paused: false, readyState: 2,
    captureStream() {
      captures++;
      const track = Object.assign(createVisibilityDocument(), {
        readyState: 'live', stop() { this.readyState = 'ended'; },
      });
      tracks.push(track);
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    },
  });
  class AudioContext {
    constructor() { this.state = 'running'; contexts.push(this); }
    createAnalyser() {
      return { frequencyBinCount: 128, getByteFrequencyData(array) { samples++; array.fill(32); } };
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const context = new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, {
    get: (target, key) => target[key] ?? (() => {}),
  });
  const canvas = { width: 1000, height: 600, getContext: () => context, getBoundingClientRect: () => ({ width: 1000, height: 600 }) };
  const hook = createBackgroundModuleHarness({
    file: new URL('./ImmersiveAudioAura.jsx', import.meta.url), modules: {}, nodes: { canvas },
    globals: {
      ...scheduler, document, navigator: { platform: 'Win32' },
      window: { AudioContext, devicePixelRatio: 1 },
      HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
      ResizeObserver: class { observe() {} disconnect() {} },
    },
  });
  const props = {
    audioRef: { current: audio }, containerRef: { current: { style: { setProperty() {} } } },
    isPlaying: true, isBuffering: false, enabled: true,
  };
  return {
    ...hook, props, audio, document, scheduler, contexts, tracks,
    get captures() { return captures; }, get samples() { return samples; },
  };
}

test('hidden Aura stops sampling and analysis, and quick visible resume reuses its capture', async () => {
  const fixture = createFixture();
  fixture.render(fixture.props); await flushBackgroundAsync();
  assert.equal(fixture.captures, 1);
  assert.ok(fixture.samples > 0);
  fixture.document.setVisible(false); fixture.render(); await flushBackgroundAsync();
  const previousSamples = fixture.samples;
  assert.equal(fixture.scheduler.frames.size, 0);
  assert.equal(fixture.contexts[0].state, 'suspended');
  fixture.audio.dispatch('timeupdate'); fixture.scheduler.frame();
  assert.equal(fixture.samples, previousSamples);
  fixture.document.setVisible(true); fixture.render(); await flushBackgroundAsync();
  assert.equal(fixture.captures, 1);
  assert.equal(fixture.contexts[0].state, 'running');
  assert.ok(fixture.samples > previousSamples);
  fixture.unmount();
});

test('Aura reacquires after a long hidden interval releases its idle graph and tracks', async () => {
  const fixture = createFixture();
  fixture.render(fixture.props); await flushBackgroundAsync();
  fixture.document.setVisible(false); fixture.render(); await flushBackgroundAsync();
  fixture.scheduler.expire(30000); await flushBackgroundAsync();
  assert.equal(fixture.contexts[0].state, 'closed');
  assert.equal(fixture.tracks[0].readyState, 'ended');
  fixture.document.setVisible(true); fixture.render(); await flushBackgroundAsync();
  assert.equal(fixture.captures, 2);
  assert.equal(fixture.contexts[1].state, 'running');
  assert.equal(fixture.audio.paused, false);
  fixture.unmount();
});

test('hide then immediate show cannot leave a reused consumer inactive behind a pending suspend', async () => {
  const fixture = createFixture();
  fixture.render(fixture.props); await flushBackgroundAsync();
  fixture.document.setVisible(false); fixture.render();
  fixture.document.setVisible(true); fixture.render();
  await flushBackgroundAsync();
  assert.equal(fixture.contexts[0].state, 'running');
  assert.equal(fixture.captures, 1);
  fixture.unmount();
});
