import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { consumeAuthAttempt, RateLimitError } from './rateLimit.js';

const baseline = readFileSync(new URL('../../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const now = Date.now();
const request = (ip, other = {}) => new Request('https://example.test/api/auth/login', {
  headers: { ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...other },
});

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(baseline);
  let failAt = -1;
  const db = {
    prepare(sql) {
      const values = [];
      return {
        bind(...args) { values.push(...args); return this; },
        runSync() {
          const statement = sqlite.prepare(sql);
          if (/^\s*SELECT\b/i.test(sql)) return { results: statement.all(...values) };
          return { meta: { changes: statement.run(...values).changes } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement, index) => {
          if (index === failAt) throw new Error('injected failure');
          return statement.runSync();
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, db, failAt(index) { failAt = index; }, close() { sqlite.close(); } };
}

test('login attempts cap an IP bucket and return a safe retry interval', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i += 1) {
      const outcome = await consumeAuthAttempt({ db: f.db, request: request('203.0.113.10'),
        kind: 'login', username: `owner${i}`, now });
      assert.deepEqual(outcome, { allowed: true, status: 200, retryAfterSeconds: 0 });
    }
    const blocked = await consumeAuthAttempt({ db: f.db, request: request('203.0.113.10'),
      kind: 'login', username: 'another', now: now + 1 });
    assert.deepEqual(blocked, { allowed: false, status: 429, retryAfterSeconds: 900 });
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'auth.attempt.login'").get().total, 10);
    assert.equal((await consumeAuthAttempt({ db: f.db, request: request('203.0.113.10'),
      kind: 'login', username: 'owner', now: now + 900_001 })).allowed, true);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'auth.attempt.login'").get().total, 1);
  } finally { f.close(); }
});

test('login username bucket spans IPs without writing raw identity data', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await consumeAuthAttempt({ db: f.db, request: request(`198.51.100.${i + 1}`),
        kind: 'login', username: 'OWNER', now })).allowed, true);
    }
    assert.equal((await consumeAuthAttempt({ db: f.db, request: request('198.51.100.100'),
      kind: 'login', username: 'owner', now })).status, 429);
    const rows = f.sqlite.prepare("SELECT action, target_id, detail_code FROM audit_events WHERE action = 'auth.attempt.login'").all();
    assert.equal(rows.length, 8);
    for (const row of rows) {
      assert.match(row.target_id, /^[a-f0-9]{64}$/);
      assert.match(row.detail_code, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(row).includes('198.51.100'), false);
      assert.equal(JSON.stringify(row).includes('owner'), false);
    }
  } finally { f.close(); }
});

test('missing or invalid Cloudflare IP is one conservative bucket, not spoofable X-Forwarded-For', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = await consumeAuthAttempt({ db: f.db,
        request: request(null, { 'X-Forwarded-For': `192.0.2.${i + 1}` }), kind: 'setup', now });
      assert.equal(result.allowed, true);
    }
    assert.equal((await consumeAuthAttempt({ db: f.db, request: request('not-an-ip'),
      kind: 'setup', now })).status, 429);
    assert.equal((await consumeAuthAttempt({ db: f.db, request: request('2001:db8::1'),
      kind: 'setup', now })).allowed, true);
    assert.equal((await consumeAuthAttempt({ db: f.db, request: request('2001:0db8:0:0:0:0:0:1'),
      kind: 'setup', now })).allowed, true);
    assert.equal((await consumeAuthAttempt({ db: f.db, request: request(':::'),
      kind: 'setup', now })).status, 429);
  } finally { f.close(); }
});

test('rate-limit pruning leaves unrelated audit records intact and failure rolls back', async () => {
  const f = fixture();
  try {
    f.sqlite.prepare(`INSERT INTO audit_events (id, action, result, created_at)
      VALUES ('regular-audit', 'account.password.change', 'success', ?)`).run(now - 2_000_000);
    await consumeAuthAttempt({ db: f.db, request: request('203.0.113.20'), kind: 'setup', now: now - 1_000_000 });
    f.failAt(2);
    await assert.rejects(consumeAuthAttempt({ db: f.db, request: request('203.0.113.20'),
      kind: 'setup', now }), (error) => error instanceof RateLimitError && error.status === 503);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM audit_events').get().total, 2);
    f.failAt(-1);
    await consumeAuthAttempt({ db: f.db, request: request('203.0.113.20'), kind: 'setup', now });
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM audit_events').get().total, 2);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'account.password.change'").get().total, 1);
  } finally { f.close(); }
});

test('unknown limiter kind cannot be used as an audit action', async () => {
  const f = fixture();
  try {
    await assert.rejects(consumeAuthAttempt({ db: f.db, request: request('203.0.113.2'),
      kind: 'arbitrary', now }), TypeError);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM audit_events').get().total, 0);
  } finally { f.close(); }
});

test('concurrent setup attempts cannot overfill a rate bucket', async () => {
  const f = fixture();
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeAuthAttempt({
      db: f.db, request: request('203.0.113.99'), kind: 'setup', now,
    })));
    assert.equal(results.filter((entry) => entry.allowed).length, 5);
    assert.equal(results.filter((entry) => entry.status === 429).length, 15);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'auth.attempt.setup'").get().total, 5);
  } finally { f.close(); }
});
