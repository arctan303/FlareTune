import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppleFluidHarness, createBackgroundModuleHarness } from '../../test/fullscreenBackgroundHarness.js';

test('classic background forwards suspension and reduced-motion to the fluid renderer', () => {
  const marker = () => null;
  const component = createBackgroundModuleHarness({
    file: new URL('./MobileClassicBackground.jsx', import.meta.url),
    modules: { './AppleFluidCanvas.jsx': marker },
  });
  const node = component.render({
    showPhotos: false, coverUrl: 'cover.jpg', hasEntered: true,
    isPlaying: true, suspendPlayerEffects: true, prefersReducedMotion: true,
  });
  assert.equal(node.type, marker);
  assert.equal(node.props.suspended, true);
  assert.equal(node.props.prefersReducedMotion, true);
});

test('reduced motion renders a static first frame and updates a new cover without a crossfade loop', () => {
  const fixture = createAppleFluidHarness();
  fixture.render({ coverUrl: 'first.jpg', isPlaying: true, prefersReducedMotion: true });
  fixture.frame();
  assert.equal(fixture.draws.length, 1);
  assert.equal(fixture.draws[0].u_time, 0);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.images.get('first.jpg?_c=1').onload(); fixture.frame();
  assert.equal(fixture.draws.at(-1).u_crossfade, 1);
  fixture.render({ coverUrl: 'second.jpg', isPlaying: true, prefersReducedMotion: true });
  fixture.images.get('second.jpg?_c=1').onload(); fixture.frame();
  assert.equal(fixture.draws.length, 3);
  assert.equal(fixture.draws.at(-1).u_time, 0);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.unmount();
});

test('live suspension stops drawing and resumes the unchanged animation speed', () => {
  const fixture = createAppleFluidHarness();
  fixture.render({ isPlaying: true }); fixture.frame(); fixture.frame();
  assert.ok(Math.abs(fixture.draws.at(-1).u_time - 0.008) < 1e-9);
  const lookupCount = fixture.uniformLookups;
  fixture.render({ isPlaying: true, suspended: true }); fixture.frame();
  assert.equal(fixture.draws.length, 2);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.render({ isPlaying: true, suspended: false }); fixture.frame();
  assert.ok(Math.abs(fixture.draws.at(-1).u_time - 0.008) < 1e-9);
  fixture.frame();
  assert.ok(Math.abs(fixture.draws.at(-1).u_time - 0.016) < 1e-9);
  assert.equal(fixture.uniformLookups, lookupCount);
  fixture.unmount();
  assert.equal(fixture.scheduler.frames.size, 0);
});

test('switching reduced-motion on while playing settles after one static frame and can resume', () => {
  const fixture = createAppleFluidHarness();
  fixture.render({ isPlaying: true }); fixture.frame();
  fixture.render({ isPlaying: true, prefersReducedMotion: true }); fixture.frame();
  assert.equal(fixture.draws.at(-1).u_time, 0);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.render({ isPlaying: true, prefersReducedMotion: false }); fixture.frame();
  assert.equal(fixture.draws.at(-1).u_time, 0);
  assert.equal(fixture.scheduler.frames.size, 1);
  fixture.unmount();
});

test('equal elapsed time at 60, 120 and 144 Hz advances fluid at the original 60 Hz rate', () => {
  for (const rate of [60, 120, 144]) {
    const fixture = createAppleFluidHarness();
    fixture.render({ isPlaying: true }); fixture.frame(0);
    for (let frame = 0; frame < rate * 2; frame++) fixture.frame(1000 / rate);
    assert.ok(Math.abs(fixture.draws.at(-1).u_time - 0.96) < 1e-9, `${rate} Hz`);
    fixture.unmount();
  }
});

test('hidden/resumed and long-delayed frames do not add the time spent away', () => {
  const fixture = createAppleFluidHarness();
  fixture.render({ isPlaying: true }); fixture.frame(0); fixture.frame();
  const before = fixture.draws.at(-1).u_time;
  fixture.document.setVisible(false); fixture.render(); fixture.frame(60000);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.document.setVisible(true); fixture.render(); fixture.frame(60000);
  assert.equal(fixture.draws.at(-1).u_time, before);
  fixture.frame(60000);
  assert.equal(fixture.draws.at(-1).u_time, before);
  fixture.frame();
  assert.ok(Math.abs(fixture.draws.at(-1).u_time - before - 0.008) < 1e-9);
  fixture.unmount();
});

test('paused resize schedules exactly one replacement frame and keeps playback frozen', () => {
  const fixture = createAppleFluidHarness();
  fixture.render({ isPlaying: false }); fixture.frame();
  assert.equal(fixture.draws.length, 1);
  fixture.resize(1200, 600);
  assert.equal(fixture.canvas.width, 264);
  assert.equal(fixture.scheduler.frames.size, 1);
  fixture.frame();
  assert.equal(fixture.draws.length, 2);
  assert.equal(fixture.draws.at(-1).u_time, 0);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.resize(1200, 600);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.unmount();
});

test('resize during suspension waits for resume even when playback stays paused', () => {
  const fixture = createAppleFluidHarness();
  fixture.render({ isPlaying: false }); fixture.frame();
  fixture.render({ isPlaying: false, suspended: true });
  fixture.resize(1200, 600); fixture.frame();
  assert.equal(fixture.draws.length, 1);
  fixture.render({ isPlaying: false, suspended: false }); fixture.frame();
  assert.equal(fixture.draws.length, 2);
  assert.equal(fixture.scheduler.frames.size, 0);
  fixture.unmount();
});
