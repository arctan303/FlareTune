const memoryStore = new Map();
globalThis.localStorage = {
  get length() { return memoryStore.size; },
  key: (index) => [...memoryStore.keys()][index] ?? null,
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
};
const windowListeners = new Map();
globalThis.window = {
  localStorage: globalThis.localStorage,
  addEventListener: (name, handler) => windowListeners.set(name, handler),
  dispatch: (name, event = {}) => windowListeners.get(name)?.(event),
};
const documentListeners = new Map();
globalThis.document = {
  documentElement: { classList: { contains: () => false } },
  visibilityState: 'visible',
  addEventListener: (name, handler) => documentListeners.set(name, handler),
  dispatch: (name) => documentListeners.get(name)?.(),
};

const { usePlayStatsStore, resetSyncBackoff } = await import('./usePlayStatsStore.js');
const { useUIStore } = await import('./useUIStore.js');

function resetStats(overrides = {}) {
  for (const key of [...memoryStore.keys()]) {
    if (key.startsWith('music-play-stats-pending-v1:')) memoryStore.delete(key);
  }
  globalThis.document.visibilityState = 'visible';
  resetSyncBackoff();
  usePlayStatsStore.setState({
    ownerSubject: null,
    identityReady: false,
    playCounts: {},
    pendingQueue: [],
    pendingBySubject: {},
    legacyMigrationComplete: true,
    songMetaMap: {},
    topSongs: [],
    listeningPreview: [],
    detailViewActive: false,
    totalPlays: 0,
    totalUniqueSongs: 0,
    isSyncing: false,
    lastSyncedAt: 0,
    ...overrides,
  });
  if (overrides.ownerSubject) {
    for (const event of overrides.pendingQueue || []) {
      memoryStore.set(`music-play-stats-pending-v1:${overrides.ownerSubject}:${event.event_id}`, JSON.stringify(event));
    }
  }
}


export { memoryStore, resetStats, usePlayStatsStore, useUIStore, resetSyncBackoff };
