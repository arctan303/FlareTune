import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvocationDatabase, invocationBudget } from './invocationDatabase.js';
import { guardStoreAuthority, storeAuthorityGuard } from './storeAuthority.js';

const database = () => {
  const raw = { calls: 0, prepare() { return { bind() { return this; }, first() { raw.calls++; return null; },
    all() { raw.calls++; return { results: [] }; }, run() { raw.calls++; return {}; } }; },
  batch(statements) { raw.calls++; return statements; } };
  return raw;
};
test('one invocation keeps five settlement calls after the AI budget is depleted', async () => {
  const raw = database(), db = createInvocationDatabase(raw), budget = invocationBudget(db);
  for (let i = 0; i < 43; i++) db.prepare('read').first();
  await budget.executeAi(async () => {
    db.prepare('check').first(); db.prepare('check').first();
    assert.throws(() => db.prepare('excess').first(), { code: 'INVOCATION_BUDGET_EXHAUSTED' });
  });
  assert.equal(raw.calls, 45); assert.equal(budget.depleted, true);
  budget.settle(); assert.equal(budget.signal.aborted, true);
  for (let i = 0; i < 5; i++) db.prepare('settle').run();
  assert.equal(raw.calls, 50);
  assert.throws(() => db.prepare('excess').first(), { code: 'INVOCATION_BUDGET_EXHAUSTED' });
  await assert.rejects(budget.executeAi(async () => assert.fail('settled AI restarted')));
});
test('a batch is one binding call and settlement room is checked before provider work', () => {
  const raw = database(), db = createInvocationDatabase(raw), budget = invocationBudget(db);
  db.batch([db.prepare('one').bind(1), db.prepare('two').bind(2)]);
  assert.equal(raw.calls, 1);
  for (let i = 0; i < 38; i++) db.prepare('read').first();
  assert.throws(() => budget.requireSettlementRoom(), { code: 'INVOCATION_BUDGET_EXHAUSTED' });
});
test('composed authority is checked after asynchronous preparation and before storage', async () => {
  let active = true, writes = 0, release;
  const ready = new Promise(resolve => { release = resolve; });
  const raw = { key: id => id, async put() { writes++; } };
  const compose = store => {
    const wrapper = { key: raw.key, async put(...args) { await ready; return store.put(...args); } };
    Object.defineProperty(wrapper, storeAuthorityGuard, { value: current => compose(guardStoreAuthority(store, current)) });
    return wrapper;
  };
  const current = async () => { if (!active) throw new Error('revoked'); };
  const store = guardStoreAuthority(compose(raw), current), work = store.put('id');
  active = false; release(); await assert.rejects(work, /revoked/); assert.equal(writes, 0);
  const direct = guardStoreAuthority(raw, current);
  assert.equal(guardStoreAuthority(direct, current), direct);
});
