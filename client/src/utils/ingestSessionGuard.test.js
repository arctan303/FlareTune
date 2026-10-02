import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestSessionGuard } from './ingestSessionGuard.js';

const session = (id = 'A', token = 'token-A') => ({ authenticated: true,
  user: { accountId: id, role: 'admin' }, csrfToken: token });
test('same session continues through navigation, but changed identity rejects stale completion and later writes', async () => {
  let current = session();
  const guard = createIngestSessionGuard(current, () => current);
  assert.equal(await guard.run(async () => 'uploaded'), 'uploaded');
  let release;
  const pending = guard.run(() => new Promise((resolve) => { release = resolve; }));
  current = session('B', 'token-B');
  release('old result');
  await assert.rejects(pending, { name: 'AbortError' });
  let writes = 0;
  await assert.rejects(guard.run(async () => { writes += 1; }), { name: 'AbortError' });
  assert.equal(writes, 0);
});
test('logout, privilege loss, token change and unmount abort the captured session', async () => {
  for (const change of [null, { ...session(), user: { accountId: 'A', role: 'member' } }, session('A', 'new-token')]) {
    let current = session();
    const guard = createIngestSessionGuard(current, () => current);
    current = change;
    await assert.rejects(guard.run(async () => assert.fail('must not run')), { name: 'AbortError' });
    assert.equal(guard.signal.aborted, true);
  }
  const guard = createIngestSessionGuard(session(), session);
  guard.close();
  await assert.rejects(guard.run(async () => assert.fail('must not run')), { name: 'AbortError' });
});
