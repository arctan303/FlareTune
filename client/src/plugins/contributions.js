import { useSyncExternalStore } from 'react';

const entries = new Map(), listeners = new Set();
const keyFor = (pluginId, slot) => `${pluginId}:${slot}`;
const notify = () => { for (const listener of [...listeners]) listener(); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

// Public contributions are scoped to a runtime lease. An old callback cannot
// invoke a controller belonging to a retired installation or account.
export function registerPluginContribution(pluginId, slot, { isCurrent, getSnapshot, subscribe: watch, actions = {} }) {
  const key = keyFor(pluginId, slot), lease = Symbol(key);
  entries.get(key)?.retire();
  const safeActions = Object.freeze(Object.fromEntries(Object.entries(actions).map(([name, action]) =>
    [name, (...args) => isCurrent() && entries.get(key)?.lease === lease ? action(...args) : false])));
  const entry = { lease, value: null, isCurrent, retire: () => {} };
  let ended = false;
  const publish = () => {
    if (ended) return;
    if (!isCurrent()) { retire(); return; }
    if (entries.get(key) !== entry) return;
    entry.value = Object.freeze({ ...getSnapshot(), actions: safeActions }); notify();
  };
  let unwatch = () => {};
  const retire = () => {
    if (ended) return; ended = true;
    unwatch();
    if (entries.get(key) === entry) { entries.delete(key); notify(); }
  };
  entry.retire = retire;
  entries.set(key, entry); unwatch = watch?.(publish) || unwatch; publish();
  return retire;
}

export const getPluginContribution = (pluginId, slot) => {
  const entry = entries.get(keyFor(pluginId, slot));
  return entry?.isCurrent() ? entry.value : undefined;
};

export function usePluginContribution(pluginId, slot, fallback) {
  return useSyncExternalStore(subscribe, () => getPluginContribution(pluginId, slot) || fallback,
    () => fallback);
}
