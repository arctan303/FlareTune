import test from 'node:test';
import assert from 'node:assert/strict';
import { useUIStore } from '../store/useUIStore.js';
import { runDeviceJob, getDeviceManifest } from './ingestDeviceApi.js';
import { createIngestSessionGuard } from '../utils/ingestSessionGuard.js';

test('captured device rescan rejects a delayed result after identity change and cannot poll or refresh as the new account', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const session = (id) => ({ authenticated: true, initialized: true,
    user: { accountId: id, role: 'admin' }, csrfToken: `csrf-${id}` });
  useUIStore.getState().setAuthSession(session('A'));
  const guard = createIngestSessionGuard(useUIStore.getState().authSession,
    () => useUIStore.getState().authSession);
  const unsubscribe = useUIStore.subscribe(() => { try { guard.assertCurrent(); } catch {} });
  const calls = [];
  let release;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, account: init.headers['X-FlareTune-Expected-Account'] });
    return new Promise((resolve) => { release = () => resolve(Response.json({ ok: true, data: {
      job: { id: 'job-A', status: 'queued', kind: 'refresh' },
    } })); });
  };
  try {
    const pending = guard.run((signal) => runDeviceJob('device-A', { kind: 'refresh' }, { signal }));
    assert.equal(calls.length, 1);
    useUIStore.getState().setAuthSession(session('B'));
    release();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(guard.run(() => getDeviceManifest('device-A')), { name: 'AbortError' });
    assert.deepEqual(calls.map((call) => call.account), ['A']);
  } finally {
    unsubscribe(); guard.close(); globalThis.fetch = originalFetch;
    useUIStore.getState().setAuthSession({ initialized: true, authenticated: false, user: null });
    globalThis.localStorage = originalStorage;
  }
});
