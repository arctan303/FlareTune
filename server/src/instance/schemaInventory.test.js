import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';
import { createInvocationDatabase } from '../services/invocationDatabase.js';
import { readSchemaInventory, invalidateSchemaInventory } from './schemaInventory.js';
import { resolveInstanceState } from './state.js';

test('lyric request wrappers reuse only schema metadata for the same database', async t => {
  const f = await fixture(); t.after(f.close);
  const queries = [], original = f.db.prepare.bind(f.db);
  f.db.prepare = sql => { queries.push(sql); return original(sql); };
  const first = createInvocationDatabase(f.db), second = createInvocationDatabase(f.db);
  invalidateSchemaInventory(first);
  const now = Date.now();
  const a = await readSchemaInventory(first, now, true);
  await a.playlistColumns();
  const b = await readSchemaInventory(second, now + 1, true);
  await b.playlistColumns();
  assert.equal(queries.filter(sql => sql.includes('sqlite_master')).length, 1);
  assert.equal(queries.filter(sql => sql.includes('PRAGMA table_info')).length, 1);
  invalidateSchemaInventory(second);
  await readSchemaInventory(first, now + 2, true);
  assert.equal(queries.filter(sql => sql.includes('sqlite_master')).length, 2);
});

test('sharing schema metadata never shares owner credential validity between lyric requests', async t => {
  const f = await fixture(); t.after(f.close);
  const now = Date.now();
  const first = createInvocationDatabase(f.db), second = createInvocationDatabase(f.db);
  assert.equal((await resolveInstanceState(first, now, { cacheSchema: true })).state, 'ready');
  f.sqlite.prepare("UPDATE account_credentials SET password_hash='invalid' WHERE account_id IN (SELECT account_id FROM accounts WHERE role='admin')").run();
  assert.equal((await resolveInstanceState(second, now + 1, { cacheSchema: true })).state, 'recovery_required');
});

test('schema reuse remains isolated across distinct database bindings', async t => {
  const one = await fixture(), two = await fixture(); t.after(one.close); t.after(two.close);
  const a = await readSchemaInventory(createInvocationDatabase(one.db), Date.now(), true);
  const b = await readSchemaInventory(createInvocationDatabase(two.db), Date.now(), true);
  assert.notEqual(a, b);
});

test('lazy shared columns use the current request budget, never a completed request', async t => {
  const f = await fixture(); t.after(f.close);
  const first = createInvocationDatabase(f.db, undefined, { limit: 1 });
  const second = createInvocationDatabase(f.db, undefined, { limit: 1 });
  invalidateSchemaInventory(first);
  const now = Date.now();
  await readSchemaInventory(first, now, true);
  const inventory = await readSchemaInventory(second, now + 1, true);
  const columns = await inventory.playlistColumns();
  assert.ok(columns.results.some(row => row.name === 'id'));
});
