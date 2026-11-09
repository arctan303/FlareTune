import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginRuntime } from './runtime.js';
import { createPluginMenuContext } from './menu.js';
import { useOutputTargetStore, registerOutputTarget } from '../store/useOutputTargetStore.js';

function harness(start) {
  let state = { subject: 'member:A', role: 'member', loaded: false, rows: [] }, notify;
  const starts = [], stops = [];
  const runtime = createPluginRuntime({ plugins: ['one', 'two'].map(id => ({ id, version: '1.0.0', capabilityRoles: ['admin', 'member'],
    start(host) { starts.push(id); return start?.(host) || (() => stops.push(id)); } })),
    getState: () => state, subscribe: callback => { notify = callback; return () => { notify = null; }; },
    createHost: (plugin, signal) => ({ pluginId: plugin.id, signal }),
  });
  return { runtime, starts, stops, change(patch) { state = { ...state, ...patch }; notify?.(); } };
}
test('compiled plugins start only when installed and available, and retire independently', () => {
  const subject = harness();
  assert.deepEqual(subject.starts, []);
  subject.change({ loaded: true, rows: [{ id: 'one', installed: true, revision: 1 },
    { id: 'two', installed: true, revision: 1, availability: { available: false } }] });
  assert.deepEqual(subject.starts, ['one']);
  subject.change({ rows: [{ id: 'two', installed: true, revision: 1 }] });
  assert.deepEqual(subject.stops, ['one']); assert.deepEqual(subject.starts, ['one', 'two']);
  subject.change({ subject: 'member:B' });
  assert.deepEqual(subject.stops, ['one', 'two']);
  subject.runtime.dispose(); assert.deepEqual(subject.stops, ['one', 'two', 'two']);
});

test('runtime validates the actual role independently of management rows and retires on role changes', () => {
  let state = { subject: 'same-account', role: 'admin', loaded: true, rows: [{ id: 'members', installed: true, revision: 1 }] }, notify;
  let starts = 0, stops = 0;
  const runtime = createPluginRuntime({ plugins: [{ id: 'members', version: '1.0.0', pages: [
    { id: 'service', roles: ['member'] },
  ], entries: [], start() { starts++; return () => { stops++; }; } }],
  getState: () => state, subscribe: callback => { notify = callback; return () => {}; }, createHost: () => ({}) });
  assert.equal(starts, 0);
  assert.equal(state.rows.length, 1, 'management metadata remains available without starting the service');
  state = { ...state, role: 'member' }; notify();
  assert.equal(starts, 1);
  state = { ...state, role: 'admin' }; notify();
  assert.equal(stops, 1);
  state = { ...state, role: undefined }; notify();
  assert.equal(starts, 1, 'missing identity roles fail closed');
  runtime.dispose();
});
test('an asynchronous start retired while loading disposes its resources on resolution', async () => {
  let finish, signal, disposed = 0;
  const subject = harness(host => { signal = host.signal; return new Promise(resolve => { finish = resolve; }); });
  subject.change({ loaded: true, rows: [{ id: 'one', installed: true, revision: 1 }] });
  subject.runtime.dispose(); assert.equal(signal.aborted, true);
  finish(() => disposed++); await Promise.resolve();
  assert.equal(disposed, 1);
});
test('menu song and player contexts are distinct snapshots and do not expose output writers', () => {
  const clicked = { id: 'selected' }, current = { id: 'playing' }, queue = [current];
  const song = createPluginMenuContext('menu.song', { song: clicked, player: { currentSong: current, playlist: queue } });
  const player = createPluginMenuContext('menu.player', { song: clicked, player: { currentSong: current, playlist: queue },
    output: { id: 'device', pluginId: 'one', write() {} } });
  clicked.id = 'changed'; current.id = 'next'; queue.length = 0;
  assert.equal(song.song.id, 'selected'); assert.equal(song.playback, null);
  assert.equal(player.song, null); assert.equal(player.playback.currentSong.id, 'playing');
  assert.equal(player.playback.queue.length, 1); assert.equal(player.playback.output.write, undefined);
});
test('the host accepts one volume output lease and stale cleanup cannot remove a newer target', () => {
  const a = registerOutputTarget('one'), b = registerOutputTarget('two');
  assert.equal(a.publish({ id: 'a', volume: 0.4 }), true);
  assert.equal(b.canClaim(), false); assert.equal(b.publish({ id: 'b' }), false);
  a.dispose(); b.publish({ id: 'b' }); a.dispose();
  assert.equal(useOutputTargetStore.getState().target.id, 'b');
  b.dispose(); assert.equal(useOutputTargetStore.getState().target, null);
});
