import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { acquireMigrationLease, releaseMigrationLease } from './migrationControl.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  const d1 = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() { return { meta: { changes: statement.run(...values).changes } }; },
    };
  } };
  return { sqlite, d1 };
}

test('one concurrent migration runner obtains the lease', async () => {
  const { sqlite, d1 } = fixture();
  const results = await Promise.all([acquireMigrationLease(d1, 'a'.repeat(32), 100_000), acquireMigrationLease(d1, 'b'.repeat(32), 100_000)]);
  assert.deepEqual([...results].sort(), [false, true]);
  assert.equal(await releaseMigrationLease(d1, (results[0] ? 'a' : 'b').repeat(32), 100_001), true);
  sqlite.close();
});

test('expired lease is recoverable but an old owner cannot release a new owner', async () => {
  const { sqlite, d1 } = fixture();
  assert.equal(await acquireMigrationLease(d1, 'a'.repeat(32), 100_000, 10_000), true);
  assert.equal(await acquireMigrationLease(d1, 'b'.repeat(32), 109_999, 10_000), false);
  assert.equal(await acquireMigrationLease(d1, 'b'.repeat(32), 110_000, 10_000), true);
  assert.equal(await releaseMigrationLease(d1, 'a'.repeat(32), 110_001), false);
  assert.equal(await releaseMigrationLease(d1, 'b'.repeat(32), 110_001), true);
  sqlite.close();
});
