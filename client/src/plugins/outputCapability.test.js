import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputCapability } from './outputCapability.js';
import { useOutputTargetStore } from '../store/useOutputTargetStore.js';

function fixture() {
  useOutputTargetStore.setState({ target: null });
  let current = true;
  const events = new Map(), subscribers = new Set(), log = [];
  const audio = { src: 'one.mp3', paused: false, muted: false,
    pause() { this.paused = true; log.push('pause'); },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); } };
  const state = { audioRef: { current: audio }, currentSong: { id: 'one' }, playbackOwnershipGeneration: 1,
    cancelPendingPlayback() { log.push('cancel'); } };
  const playerStore = { getState: () => state, subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); } };
  const target = createOutputCapability({ pluginId: 'fixture', playerStore, isCurrent: () => current,
    assertCurrent() { if (!current) throw new DOMException('Ended', 'AbortError'); } }).register();
  return { target, audio, state, log, events, subscribers, retire() { current = false; },
    notify() { for (const fn of subscribers) fn(); }, load() { for (const fn of events.get('loadstart') || []) fn(); } };
}
test('output clock is read-only and quiet retirement cancels pending playback before unmuting', () => {
  const f = fixture();
  assert.equal(f.target.clock.src, undefined); assert.equal(f.target.clock.play, undefined);
  assert.equal(f.target.muteLocal(), true); assert.equal(f.audio.muted, true);
  f.retire(); f.target.dispose();
  assert.deepEqual(f.log, ['cancel', 'pause']); assert.equal(f.audio.muted, false);
  assert.equal(f.subscribers.size, 0); assert.equal(f.events.get('loadstart').size, 0);
  assert.throws(() => f.target.muteLocal(), { name: 'AbortError' });
});
test('output cleanup follows owned track changes but cannot pause a new account reusing the same song/source', () => {
  const f = fixture(); f.target.muteLocal();
  f.state.currentSong = { id: 'two' }; f.state.playbackOwnershipGeneration++; f.notify(); f.audio.src = 'two.mp3'; f.load();
  f.retire(); f.target.dispose(); assert.deepEqual(f.log, ['cancel', 'pause']);
  const next = fixture(); next.target.muteLocal(); next.retire();
  next.state.playbackOwnershipGeneration++; next.notify(); next.target.dispose();
  assert.deepEqual(next.log, []); assert.equal(next.audio.paused, false); assert.equal(next.audio.muted, false);
});

test('retired output callbacks cannot control a replacement lease or reveal the native audio element', () => {
  const f = fixture(); let calls = 0, clockEvent;
  f.target.publish({ id: 'device', volume: 0.5, write: () => calls++ });
  const staleWrite = useOutputTargetStore.getState().target.write;
  f.target.clock.addEventListener('play', event => { clockEvent = event; });
  for (const callback of f.events.get('play')) callback({ target: f.audio });
  assert.deepEqual(clockEvent, { type: 'play' }); assert.equal(clockEvent.target, undefined);
  staleWrite(0.4); assert.equal(calls, 1);
  f.retire(); staleWrite(0.7); assert.equal(calls, 1);
  f.target.dispose(); assert.equal(f.events.get('play').size, 0); assert.equal(staleWrite(0.9), false);
});

test('quiet output retirement preserves the real persisted local volume', async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key),
  } });
  const { usePlayerStore } = await import('../store/usePlayerStore.js');
  const before = usePlayerStore.getState(); let target;
  const audio = { src: 'same.mp3', paused: false, muted: false, volume: 0.67,
    pause() { this.paused = true; }, addEventListener() {}, removeEventListener() {} };
  try {
    usePlayerStore.setState({ currentSong: { id: 'same', audio_url: 'same.mp3' }, audioRef: { current: audio }, volume: 0.67 });
    target = createOutputCapability({ pluginId: 'fixture', playerStore: usePlayerStore, isCurrent: () => true, assertCurrent() {} }).register();
    target.muteLocal(); assert.equal(audio.muted, true); target.dispose();
    assert.equal(audio.paused, true); assert.equal(audio.muted, false); assert.equal(audio.volume, 0.67);
    assert.equal(usePlayerStore.persist.getOptions().partialize(usePlayerStore.getState()).volume, 0.67);
  } finally {
    target?.dispose(); usePlayerStore.setState(before);
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage;
  }
});
