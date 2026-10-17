import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundModuleHarness, createBackgroundScheduler } from '../../test/fullscreenBackgroundHarness.js';

function createFixture({ pair = false } = {}) {
  const scheduler = createBackgroundScheduler();
  let phase = 'idle';
  const setVisualMotionPhase = value => { phase = typeof value === 'function' ? value(phase) : value; };
  const hooks = createBackgroundModuleHarness({
    file: new URL('./useDrawerTransition.js', import.meta.url),
    exportName: 'useDrawerTransition',
    modules: { '../../store/useUIStore': { useUIStore: selector => selector({ setVisualMotionPhase }) } },
    globals: { ...scheduler, document: { body: { offsetHeight: 600 } } },
    render: pair ? (module, props) => ({
      first: module.useDrawerTransition(props.first), second: module.useDrawerTransition(props.second),
    }) : undefined,
  });
  return { ...hooks, scheduler, get phase() { return phase; }, setVisualMotionPhase };
}

test('unmounting during a drawer transition releases suspension and all scheduled work', () => {
  const fixture = createFixture();
  fixture.render(true);
  assert.equal(fixture.phase, 'drawer-transition');
  fixture.unmount();
  assert.equal(fixture.phase, 'idle');
  assert.equal(fixture.scheduler.frames.size, 0);
  assert.equal(fixture.scheduler.timeouts.size, 0);
});

test('unmounting an idle drawer does not clear another visual transition', () => {
  const fixture = createFixture();
  fixture.render(true);
  fixture.scheduler.expire(520);
  fixture.setVisualMotionPhase('fullscreen-exit');
  fixture.unmount();
  assert.equal(fixture.phase, 'fullscreen-exit');
});

test('an older drawer finishing cannot clear the newer drawer transition', () => {
  const fixture = createFixture({ pair: true });
  fixture.render({ first: true, second: false });
  fixture.scheduler.frame(); fixture.scheduler.frame();
  fixture.scheduler.expire(520);
  const state = fixture.render({ first: false, second: true });
  const panel = {};
  state.first.onPanelTransitionEnd({ target: panel, currentTarget: panel, propertyName: 'transform' });
  assert.equal(fixture.phase, 'drawer-transition');
  state.second.onPanelTransitionEnd({ target: panel, currentTarget: panel, propertyName: 'transform' });
  assert.equal(fixture.phase, 'idle');
  fixture.unmount();
});

test('quick close and reopen cancel the old exit without unmounting the reopened drawer', () => {
  const fixture = createFixture();
  fixture.render(true);
  fixture.scheduler.frame(); fixture.scheduler.frame();
  fixture.scheduler.expire(520);
  fixture.render(false);
  fixture.render(true);
  fixture.scheduler.frame(); fixture.scheduler.frame();
  fixture.scheduler.expire(520);
  const reopened = fixture.render(true);
  assert.equal(reopened.mounted, true);
  assert.equal(reopened.visible, true);
  assert.equal(fixture.phase, 'idle');
  fixture.render(false);
  fixture.scheduler.expire(520);
  assert.equal(fixture.render(false).mounted, false);
  assert.equal(fixture.scheduler.frames.size, 0);
  assert.equal(fixture.scheduler.timeouts.size, 0);
  fixture.unmount();
});
