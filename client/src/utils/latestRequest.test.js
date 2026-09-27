import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestRequest } from './latestRequest.js';

test('older async responses cannot replace newer list or editor state', async () => {
  const requests = createLatestRequest();
  const state = [];
  let finishOld;
  const old = new Promise((resolve) => { finishOld = resolve; });
  const firstIsCurrent = requests.begin();
  const first = old.then((value) => { if (firstIsCurrent()) state.push(value); });
  const secondIsCurrent = requests.begin();
  if (secondIsCurrent()) state.push('new');
  finishOld('old');
  await first;
  assert.deepEqual(state, ['new']);
  requests.invalidate();
  assert.equal(secondIsCurrent(), false);
});
