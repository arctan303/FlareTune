export const FULLSCREEN_ROOT_ATTRIBUTE = 'data-fullscreen-open';

export const setFullscreenRootScrollLock = (root, isOpen) => {
  if (!root) return;
  root.toggleAttribute(FULLSCREEN_ROOT_ATTRIBUTE, Boolean(isOpen));
};

export const clearFullscreenRootScrollLock = (root) => {
  root?.removeAttribute(FULLSCREEN_ROOT_ATTRIBUTE);
};
