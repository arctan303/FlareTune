// Continuations belong to a live provider, not to the core player's mode or
// persistence. Retiring one never changes the queue or the current audio.
export function createQueueContinuationRegistry() {
  let provider = null;
  let resumeAllowed = false;
  let waiting = false;
  const live = () => {
    if (!provider || provider.isCurrent?.() === false) {
      provider = null; resumeAllowed = false; waiting = false; return null;
    }
    return provider;
  };
  return Object.freeze({
    register(callbacks, isCurrent = () => true) {
      if (!callbacks || typeof callbacks.onQueueEnd !== 'function') throw new TypeError('A continuation must handle queue end');
      if (live()) throw new Error('A queue continuation is already registered');
      const registration = { callbacks, isCurrent };
      provider = registration; resumeAllowed = false; waiting = false;
      return () => { if (provider === registration) { provider = null; resumeAllowed = false; waiting = false; } };
    },
    notify(event, snapshot) {
      const current = live();
      if (event !== 'onQueueEnd') resumeAllowed = false;
      if (['onQueueCleared', 'onModeChange', 'onExplicitPlay'].includes(event)) waiting = false;
      if (!current) return false;
      try {
        const accepted = current.callbacks[event]?.(snapshot) === true;
        if (event === 'onQueueEnd' && accepted && live() === current) { resumeAllowed = true; waiting = true; }
        return accepted && live() === current;
      } catch {
        if (provider === current) provider = null;
        resumeAllowed = false;
        waiting = false;
        return false;
      }
    },
    prepare() { if (live()) resumeAllowed = true; },
    canResume() { return !!live() && resumeAllowed; },
    isWaiting() { return !!live() && waiting; },
    consumed() { resumeAllowed = false; waiting = false; },
  });
}
