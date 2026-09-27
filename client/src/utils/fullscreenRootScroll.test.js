import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FULLSCREEN_ROOT_ATTRIBUTE,
  clearFullscreenRootScrollLock,
  setFullscreenRootScrollLock,
} from './fullscreenRootScroll.js';

const createRoot = () => {
  const attributes = new Set();
  return {
    attributes,
    toggleAttribute(name, force) {
      if (force) attributes.add(name);
      else attributes.delete(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
};

test('fullscreen root scroll lock follows attribute presence and clears on teardown', () => {
  const root = createRoot();

  setFullscreenRootScrollLock(root, true);
  assert.equal(root.attributes.has(FULLSCREEN_ROOT_ATTRIBUTE), true);

  setFullscreenRootScrollLock(root, false);
  assert.equal(root.attributes.has(FULLSCREEN_ROOT_ATTRIBUTE), false);

  setFullscreenRootScrollLock(root, true);
  clearFullscreenRootScrollLock(root);
  assert.equal(root.attributes.has(FULLSCREEN_ROOT_ATTRIBUTE), false);
});
