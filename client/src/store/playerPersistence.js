import { createJSONStorage } from 'zustand/middleware';

const samePersistedState = (previous, next) => {
  if (!previous || previous.version !== next.version) return false;
  const previousState = previous.state;
  const nextState = next.state;
  if (!previousState || !nextState) return previousState === nextState;
  const keys = Object.keys(nextState);
  return keys.length === Object.keys(previousState).length
    && keys.every((key) => Object.hasOwn(previousState, key) && Object.is(previousState[key], nextState[key]));
};

/**
 * Deduplicate the partialized player snapshot before JSON serialization.
 * Queue/song and preference updates use immutable replacements. Continuation
 * authorization belongs to a runtime registration and is never persisted.
 * The supplied string storage still owns write throttling and removal.
 */
export function createPlayerPersistenceStorage(getStorage) {
  const storage = createJSONStorage(getStorage);
  if (!storage) return storage;
  const lastSnapshots = new Map();
  return {
    getItem(name) {
      // Rehydration may read data changed elsewhere. Never let a previous
      // in-memory write suppress the first snapshot after that read.
      lastSnapshots.delete(name);
      return storage.getItem(name);
    },
    setItem(name, snapshot) {
      if (samePersistedState(lastSnapshots.get(name), snapshot)) return;
      const result = storage.setItem(name, snapshot);
      lastSnapshots.set(name, snapshot);
      return result;
    },
    removeItem(name) {
      lastSnapshots.delete(name);
      return storage.removeItem(name);
    },
  };
}
