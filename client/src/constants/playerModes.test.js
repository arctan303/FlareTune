import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_MODE_STORAGE_KEY,
  PLAYER_MODES,
  DEFAULT_PLAYER_MODE,
  AVAILABLE_PLAYER_MODES,
  readStoredPlayerMode,
  getInitialPlayerMode,
  isPlayerMode,
  writeStoredPlayerMode,
} from './playerModes.js';

function installStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  return map;
}

test('readStoredPlayerMode returns only known modes', () => {
  installStorage({ [PLAYER_MODE_STORAGE_KEY]: 'cinematic' });
  assert.equal(readStoredPlayerMode(), 'cinematic');

  installStorage({ [PLAYER_MODE_STORAGE_KEY]: 'unknown-mode' });
  assert.equal(readStoredPlayerMode(), null);

  installStorage({ [PLAYER_MODE_STORAGE_KEY]: 'portrait' });
  assert.equal(readStoredPlayerMode(), null);

  installStorage({});
  assert.equal(readStoredPlayerMode(), null);
});

test('getInitialPlayerMode returns stored mode or default mode', () => {
  installStorage({ [PLAYER_MODE_STORAGE_KEY]: 'cinematic' });
  assert.equal(getInitialPlayerMode(), 'cinematic');

  installStorage({});
  assert.equal(getInitialPlayerMode(), DEFAULT_PLAYER_MODE);
});

test('writeStoredPlayerMode persists valid modes and ignores invalid ones', () => {
  const storage = installStorage({});
  writeStoredPlayerMode('cinematic');
  assert.equal(storage.get(PLAYER_MODE_STORAGE_KEY), 'cinematic');

  writeStoredPlayerMode('bogus');
  assert.equal(storage.get(PLAYER_MODE_STORAGE_KEY), 'cinematic');

  writeStoredPlayerMode('portrait');
  assert.equal(storage.get(PLAYER_MODE_STORAGE_KEY), 'cinematic');
});

test('mode metadata is consistent with PLAYER_MODES contract', () => {
  assert.equal(DEFAULT_PLAYER_MODE, PLAYER_MODES.CLASSIC);
  assert.deepEqual(AVAILABLE_PLAYER_MODES, [PLAYER_MODES.CLASSIC, PLAYER_MODES.CINEMATIC]);
  assert.equal('PORTRAIT' in PLAYER_MODES, false);
  assert.equal(isPlayerMode('classic'), true);
  assert.equal(isPlayerMode('cinematic'), true);
  assert.equal(isPlayerMode('portrait'), false);
});
