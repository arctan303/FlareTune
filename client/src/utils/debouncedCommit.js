export const createDebouncedCommit = (
  commit,
  delay,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
) => {
  let timerId = null;
  let pendingValue;
  let hasPendingValue = false;

  const run = () => {
    timerId = null;
    if (!hasPendingValue) return;
    hasPendingValue = false;
    commit(pendingValue);
  };

  return {
    schedule(value) {
      pendingValue = value;
      hasPendingValue = true;
      if (timerId !== null) clearTimer(timerId);
      timerId = setTimer(run, delay);
    },
    flush() {
      if (timerId !== null) clearTimer(timerId);
      run();
    },
    cancel() {
      if (timerId !== null) clearTimer(timerId);
      timerId = null;
      hasPendingValue = false;
    },
  };
};
