import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  AuthError,
  changePassword,
  claimInstance,
  clearSessionCookie,
  getSession,
  hashPassword,
  login,
  logout,
  sessionCookie,
  tokenFromCookie,
  validatePassword,
  verifyCsrfToken,
  verifyPassword,
} from './index.js';
import { resolveInstanceState } from '../../instance/state.js';
import { KNOWN_MIGRATIONS } from '../../instance/schemaManifest.js';

const baseline = readFileSync(new URL('../../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const secondMigration = readFileSync(new URL('../../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8');
const secret = 'local-only-rehearsal-setup-secret-at-least-32-bytes';
const password = 'a long private passphrase 2026';
const newPassword = 'another long private passphrase 2026';
const now = Date.now();

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(baseline);
  sqlite.exec(secondMigration);
  for (const name of ['0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
    '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
    '0007_default_ai_guidance.sql', '0008_assistant_memory.sql']) {
    sqlite.exec(readFileSync(new URL(`../../../db/migrations-flaretune/${name}`, import.meta.url), 'utf8'));
  }
  const migration = KNOWN_MIGRATIONS.find(({ version }) => version === 2);
  const migratedAt = Date.now();
  sqlite.prepare(`INSERT INTO ft_migrations
    (version, name, checksum, stage, state, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?)`).run(
    migration.version, migration.name, migration.checksum, migration.stage, migratedAt, migratedAt);
  sqlite.exec('UPDATE ft_instance SET schema_version = 2 WHERE id = 1');
  let failAt = -1;
  const db = {
    prepare(sql) {
      const values = [];
      return {
        bind(...args) { values.push(...args); return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
        runSync() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((statement, index) => {
          if (index === failAt) throw new Error('injected database failure');
          return statement.runSync();
        });
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, db, failAt(index) { failAt = index; }, close() { sqlite.close(); } };
}

const claim = (db, overrides = {}) => claimInstance({
  db, setupSecret: secret, suppliedSecret: secret, username: 'Owner', password, now,
  ...overrides,
});

test('password format uses supported PBKDF2 material and enforces length without composition rule', async () => {
  assert.equal(validatePassword('short'), false);
  assert.equal(validatePassword('1234567'), false);
  assert.equal(validatePassword('12345678'), true);
  assert.equal(validatePassword('🔒'.repeat(7)), false);
  assert.equal(validatePassword('🔒'.repeat(8)), true);
  assert.equal(validatePassword('🔒'.repeat(257)), false);
  assert.equal(validatePassword(password), true);
  await assert.rejects(hashPassword('1234567'), TypeError);
  const material = await hashPassword('12345678');
  assert.equal(material.kdf, 'pbkdf2-sha256-chain');
  assert.equal(material.kdf_version, 2);
  assert.deepEqual(JSON.parse(material.kdf_params_json), { iterations: 100_000, rounds: 6 });
  assert.equal(await verifyPassword('12345678', material), true);
  assert.equal(await verifyPassword('wrong password', material), false);
  assert.equal(await verifyPassword('12345678', { ...material, kdf_version: 1 }), false);
});

test('password hashing and verification stay within the Cloudflare per-call PBKDF2 limit', async () => {
  const subtle = crypto.subtle;
  const original = subtle.deriveBits;
  const calls = [];
  subtle.deriveBits = async function (algorithm, ...args) {
    if (algorithm.name === 'PBKDF2') {
      if (algorithm.iterations > 100_000) throw new Error('Cloudflare PBKDF2 limit exceeded');
      calls.push({ iterations: algorithm.iterations,
        salt: Buffer.from(algorithm.salt).toString('hex') });
    }
    return original.call(this, algorithm, ...args);
  };
  try {
    const material = await hashPassword(password);
    assert.equal(await verifyPassword(password, material), true);
    assert.equal(calls.length, 12);
    assert.deepEqual(calls.map(({ iterations }) => iterations), Array(12).fill(100_000));
    const salts = calls.slice(0, 6).map(({ salt }) => salt);
    assert.equal(new Set(salts).size, 6);
    assert.deepEqual(calls.slice(6).map(({ salt }) => salt), salts);
  } finally {
    subtle.deriveBits = original;
  }
});

test('claim is atomic, creates defaults, and permanently closes setup', async () => {
  const f = fixture();
  try {
    await assert.rejects(claim(f.db, { suppliedSecret: 'wrong' }), (error) => error instanceof AuthError && error.code === 'invalid_setup');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM accounts').get().total, 0);
    await assert.rejects(claim(f.db, { password: 'short' }), (error) => error.code === 'invalid_input');
    assert.equal(f.sqlite.prepare('SELECT initialized_at FROM ft_instance').get().initialized_at, null);
    const { accountId } = await claim(f.db);
    assert.equal((await resolveInstanceState(f.db, now)).state, 'ready');
    assert.equal(f.sqlite.prepare('SELECT role FROM accounts WHERE account_id = ?').get(accountId).role, 'admin');
    assert.deepEqual(f.sqlite.prepare('SELECT key FROM instance_settings ORDER BY key').all().map((x) => x.key),
      ['cors.allowed_origins', 'instance.name']);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'instance.claim'").get().total, 1);
    await assert.rejects(claim(f.db), (error) => error.code === 'invalid_state');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM accounts').get().total, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM account_sessions').get().total, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action LIKE '%secret%'").get().total, 0);
  } finally { f.close(); }
});

test('claim storage failure rolls back account, settings, audit, and marker', async () => {
  const f = fixture();
  try {
    f.failAt(4);
    await assert.rejects(claim(f.db), (error) => error.code === 'claim_failed');
    for (const table of ['accounts', 'account_credentials', 'instance_settings', 'audit_events']) {
      assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total, 0);
    }
    assert.equal(f.sqlite.prepare('SELECT initialized_at FROM ft_instance').get().initialized_at, null);
    f.failAt(-1);
    await claim(f.db);
  } finally { f.close(); }
});

test('two concurrent first-admin claims produce exactly one administrator', async () => {
  const f = fixture();
  try {
    const outcome = await Promise.allSettled([claim(f.db), claim(f.db, { username: 'another' })]);
    assert.deepEqual(outcome.map((item) => item.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM accounts').get().total, 1);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM audit_events').get().total, 1);
    assert.equal((await resolveInstanceState(f.db, now)).state, 'ready');
  } finally { f.close(); }
});

test('login gives only a hashed, revocable cookie session with separate CSRF token', async () => {
  const f = fixture();
  try {
    await claim(f.db);
    await assert.rejects(login({ db: f.db, username: 'unknown', password, now }), (e) => e.code === 'invalid_credentials');
    await assert.rejects(login({ db: f.db, username: 'owner', password: 'wrong', now }), (e) => e.code === 'invalid_credentials');
    const signedIn = await login({ db: f.db, username: 'OWNER', password, now });
    assert.equal(signedIn.mode, 'normal');
    assert.equal(signedIn.account.role, 'admin');
    assert.notEqual(signedIn.token, signedIn.csrfToken);
    const stored = f.sqlite.prepare('SELECT token_hash, mode FROM account_sessions').get();
    assert.notEqual(stored.token_hash, signedIn.token);
    assert.equal(stored.mode, 'normal');
    assert.equal(await verifyCsrfToken(signedIn.token, signedIn.csrfToken), true);
    assert.equal(await verifyCsrfToken(signedIn.token, 'bad'), false);
    assert.equal((await getSession({ db: f.db, token: signedIn.token, now })).account.username, 'owner');
    assert.equal(await getSession({ db: f.db, token: signedIn.token, now: now + 8 * 24 * 60 * 60 * 1000 }), null);
    assert.match(sessionCookie(signedIn.token), /; Secure/);
    assert.match(sessionCookie(signedIn.token), /; HttpOnly; SameSite=Strict/);
    assert.match(sessionCookie(signedIn.token, { mode: 'must_change_password' }), /Max-Age=900/);
    assert.equal(tokenFromCookie(`oauth_session=legacy; ${sessionCookie(signedIn.token)}`), signedIn.token);
    assert.equal(tokenFromCookie(`oauth_session=legacy`), null);
    assert.equal(tokenFromCookie(`${sessionCookie(signedIn.token)}; ${sessionCookie(signedIn.token)}`), null);
    assert.match(clearSessionCookie(), /Max-Age=0; Secure/);
    assert.deepEqual(await logout({ db: f.db, token: signedIn.token, now }), { revoked: true });
    assert.equal(await getSession({ db: f.db, token: signedIn.token, now }), null);
  } finally { f.close(); }
});

test('temporary credential signs in only to change-password mode and change revokes every session', async () => {
  const f = fixture();
  try {
    const { accountId } = await claim(f.db);
    f.sqlite.prepare('UPDATE account_credentials SET must_change_password = 1 WHERE account_id = ?').run(accountId);
    const signedIn = await login({ db: f.db, username: 'owner', password, now });
    assert.equal(signedIn.mode, 'must_change_password');
    const session = await getSession({ db: f.db, token: signedIn.token, now });
    assert.equal(session.mode, 'must_change_password');
    assert.deepEqual(await changePassword({ db: f.db, session, newPassword, now }), { changed: true });
    assert.equal(f.sqlite.prepare('SELECT must_change_password FROM account_credentials').get().must_change_password, 0);
    assert.equal(await getSession({ db: f.db, token: signedIn.token, now }), null);
    await assert.rejects(login({ db: f.db, username: 'owner', password, now }), (e) => e.code === 'invalid_credentials');
    const normal = await login({ db: f.db, username: 'owner', password: newPassword, now });
    assert.equal(normal.mode, 'normal');
    const normalSession = await getSession({ db: f.db, token: normal.token, now });
    await assert.rejects(changePassword({ db: f.db, session: normalSession, newPassword: password, now }),
      (e) => e.code === 'invalid_credentials');
    assert.deepEqual(await changePassword({ db: f.db, session: normalSession,
      currentPassword: newPassword, newPassword: password, now }), { changed: true });
    assert.equal(await getSession({ db: f.db, token: normal.token, now }), null);
    assert.equal((await login({ db: f.db, username: 'owner', password, now })).mode, 'normal');
  } finally { f.close(); }
});

test('normal account accepts an eight-character new password and revokes old sessions', async () => {
  const f = fixture();
  try {
    await claim(f.db);
    const signedIn = await login({ db: f.db, username: 'owner', password, now });
    const session = await getSession({ db: f.db, token: signedIn.token, now });
    await assert.rejects(changePassword({ db: f.db, session, currentPassword: password,
      newPassword: '1234567', now }), (error) => error.code === 'invalid_input');
    assert.notEqual(await getSession({ db: f.db, token: signedIn.token, now }), null);
    assert.deepEqual(await changePassword({ db: f.db, session, currentPassword: password,
      newPassword: 'safe2026', now }), { changed: true });
    assert.equal(await getSession({ db: f.db, token: signedIn.token, now }), null);
    await assert.rejects(login({ db: f.db, username: 'owner', password, now }),
      (error) => error.code === 'invalid_credentials');
    assert.equal((await login({ db: f.db, username: 'owner', password: 'safe2026', now })).mode, 'normal');
  } finally { f.close(); }
});

test('password-change batch failure preserves old credential and session', async () => {
  const f = fixture();
  try {
    await claim(f.db);
    const signedIn = await login({ db: f.db, username: 'owner', password, now });
    const session = await getSession({ db: f.db, token: signedIn.token, now });
    f.failAt(2);
    await assert.rejects(changePassword({ db: f.db, session, currentPassword: password,
      newPassword, now }), (e) => e.code === 'password_change_failed');
    assert.notEqual(await getSession({ db: f.db, token: signedIn.token, now }), null);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'account.password.change'").get().total, 0);
    f.failAt(-1);
    assert.deepEqual(await changePassword({ db: f.db, session, currentPassword: password,
      newPassword, now }), { changed: true });
  } finally { f.close(); }
});

test('disabled account cannot log in or reuse a previous session', async () => {
  const f = fixture();
  try {
    await claim(f.db);
    const signedIn = await login({ db: f.db, username: 'owner', password, now });
    f.sqlite.exec("UPDATE accounts SET status = 'disabled' WHERE username = 'owner'");
    await assert.rejects(login({ db: f.db, username: 'owner', password, now }), (e) => e.code === 'service_unavailable');
    await assert.rejects(getSession({ db: f.db, token: signedIn.token, now }), (e) => e.code === 'service_unavailable');
  } finally { f.close(); }
});
