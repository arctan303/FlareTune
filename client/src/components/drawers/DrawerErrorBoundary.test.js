import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundModuleHarness,
  createBackgroundScheduler,
} from '../../test/fullscreenBackgroundHarness.js';

function createBoundary(children, store = { setVisualMotionPhase: () => {} }) {
  const fixture = createBackgroundModuleHarness({
    file: new URL('./DrawerErrorBoundary.jsx', import.meta.url),
    modules: {
      '../../i18n/index.js': { t: text => text },
      '../../store/useUIStore': { useUIStore: { getState: () => store } },
    },
    globals: { console: { error() {} } },
  });
  return new fixture.exports.default({ isOpen: true, children });
}

test('healthy closed drawers keep their subtree mounted to finish the exit lifecycle', () => {
  const children = { type: 'drawer' };
  const boundary = createBoundary(children);
  assert.equal(boundary.render(), children);
  boundary.props = { ...boundary.props, isOpen: false };
  assert.equal(boundary.render(), children);
});

test('a failed lazy import and closing before first mount do not strand the motion phase', () => {
  let phase = 'drawer-transition';
  const store = { setVisualMotionPhase: update => { phase = update(phase); } };
  const boundary = createBoundary(null, store);
  boundary.componentDidCatch(new Error('Failed to fetch module'), {});
  assert.equal(phase, 'idle');
  phase = 'drawer-transition';
  const previous = boundary.props;
  boundary.props = { ...previous, isOpen: false };
  boundary.componentDidUpdate(previous);
  assert.equal(phase, 'idle');
  phase = 'fullscreen-enter';
  boundary.componentDidCatch(new Error('Render failed'), {});
  assert.equal(phase, 'fullscreen-enter');
});

test('a closed failed drawer hides its error fallback', () => {
  const boundary = createBoundary({ type: 'drawer' });
  boundary.state = { hasError: true, error: new Error('Failed to fetch module') };
  const recovery = boundary.render();
  assert.equal(recovery.props.error, true);
  assert.equal(typeof recovery.props.onClose, 'function');
  boundary.props = { ...boundary.props, isOpen: false };
  assert.equal(boundary.render(), null);
});

for (const context of ['page', 'parent modal', 'new modal', 'inert opener']) test(`the waiting boundary restores focus only into the active context: ${context}`, () => {
  const scheduler = createBackgroundScheduler();
  let focused = 0;
  const opener = { isConnected: true, focus: () => { focused++; }, closest: () => context === 'inert opener' ? {} : null };
  const modal = { contains: target => context === 'parent modal' && target === opener };
  const document = { activeElement: opener, querySelectorAll: () => context.includes('modal') ? [modal] : [] };
  const fixture = createBackgroundModuleHarness({
    file: new URL('./DrawerErrorBoundary.jsx', import.meta.url),
    modules: { '../../i18n/index.js': { t: text => text }, '../../store/useUIStore': { useUIStore: { getState: () => ({ setVisualMotionPhase() {} }) } } },
    globals: { ...scheduler, document },
  });
  const boundary = new fixture.exports.default({ isOpen: false });
  let previous = boundary.props;
  boundary.props = { isOpen: true };
  const snapshot = boundary.getSnapshotBeforeUpdate(previous);
  boundary.componentDidUpdate(previous, {}, snapshot);
  document.activeElement = { description: 'temporary fallback close button' };
  previous = boundary.props;
  boundary.props = { isOpen: false };
  boundary.componentDidUpdate(previous, {}, null);
  assert.equal(focused, 0, 'wait until the inert attributes have been removed');
  scheduler.frame();
  assert.equal(focused, ['page', 'parent modal'].includes(context) ? 1 : 0);
  assert.equal(boundary.returnFocus, null);
  boundary.componentWillUnmount();
});

for (const completion of ['transitionend', 'fallback']) {
  test(`closing a wrapped queue releases the player suspension via ${completion}`, () => {
    const scheduler = createBackgroundScheduler();
    let phase = 'drawer-transition';
    const setVisualMotionPhase = value => { phase = typeof value === 'function' ? value(phase) : value; };
    const lifecycle = createBackgroundModuleHarness({
      file: new URL('./useDrawerTransition.js', import.meta.url),
      exportName: 'useDrawerTransition',
      modules: { '../../store/useUIStore': { useUIStore: selector => selector({ setVisualMotionPhase }) } },
      globals: { ...scheduler, document: { body: { offsetHeight: 600 } } },
    });
    const boundary = createBoundary({ type: 'queue' });
    const render = isOpen => {
      boundary.props = { ...boundary.props, isOpen };
      if (boundary.render() === null) { lifecycle.unmount(); return; }
      return lifecycle.render(isOpen);
    };
    render(true);
    scheduler.frame(); scheduler.frame();
    let state = render(true);
    scheduler.expire(520);
    assert.equal(phase, 'idle');
    assert.equal(state.visible, true);

    // The store marks closing as a drawer transition before notifying React.
    phase = 'drawer-transition';
    state = render(false);
    if (completion === 'transitionend') {
      const panel = {};
      state?.onPanelTransitionEnd({ target: panel, currentTarget: panel, propertyName: 'transform' });
    } else {
      scheduler.expire(520);
    }
    assert.equal(phase, 'idle', 'closed queue must stop suspending the fullscreen player');
    assert.equal(render(false).mounted, false);
    assert.equal(scheduler.frames.size, 0);
    assert.equal(scheduler.timeouts.size, 0);
    lifecycle.unmount();
  });
}
