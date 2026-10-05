export function createPlayerAutoHide({ delay, onVisibleChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let enabled = false;
  let visible = true;
  let reportedVisible;
  const holds = new Set();
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const report = value => {
    visible = value;
    if (reportedVisible !== value) { reportedVisible = value; onVisibleChange(value); }
  };
  const show = () => report(true);
  const schedule = () => {
    clear();
    if (!enabled || holds.size) return;
    timer = setTimer(() => {
      timer = null;
      report(false);
    }, delay);
  };
  return {
    reveal() { show(); schedule(); },
    hold(reason) { holds.add(reason); clear(); show(); },
    release(reason) { if (holds.delete(reason)) schedule(); },
    setEnabled(value) { enabled = value; show(); schedule(); },
    isVisible: () => visible,
    destroy() { clear(); holds.clear(); },
  };
}

const openInteractions = new Set();
const listeners = new Set();
const notify = () => listeners.forEach(listener => listener(openInteractions.size > 0));

export function acquirePlayerInteraction() {
  const token = {};
  openInteractions.add(token);
  notify();
  return () => { if (openInteractions.delete(token)) notify(); };
}

export function subscribePlayerInteractions(listener) {
  listeners.add(listener);
  listener(openInteractions.size > 0);
  return () => listeners.delete(listener);
}

export function getPlayerInteraction(target, { pointer = false } = {}) {
  const region = target?.closest?.('[data-player-interaction]');
  if (!region || region.closest?.('[inert]')) return null;
  if (pointer && region.getAttribute('data-player-interaction') === 'keyboard') return null;
  return region;
}
