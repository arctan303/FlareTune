import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAccount, listAccounts, resetAccountPassword, updateAccount } from './accounts.js';
import { getAdminSettings, updateAdminSetting, updateAssistantConfig } from './settings.js';
import { DEFAULT_LYRIC_AI_CONFIG } from '../utils/lyricAiConfig.js';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';

const baseline = readFileSync(new URL('../../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8');
const secondMigration = readFileSync(new URL('../../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8');
const salt = Buffer.alloc(16, 1).toString('base64url');
const hash = Buffer.alloc(32, 2).toString('base64url');
const now = 1_800_000_000_000;
const password = 'a long private password!';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(baseline);
  sqlite.exec(secondMigration);
  for (const name of ['0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
    '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
    '0007_default_ai_guidance.sql', '0008_assistant_memory.sql', '0009_ai_protocols.sql']) {
    sqlite.exec(readFileSync(new URL(`../../db/migrations-flaretune/${name}`, import.meta.url), 'utf8'));
  }
  const migration = KNOWN_MIGRATIONS.find(({ version }) => version === 2);
  const migratedAt = Date.now();
  sqlite.prepare(`INSERT INTO ft_migrations
    (version, name, checksum, stage, state, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?)`).run(
    migration.version, migration.name, migration.checksum, migration.stage, migratedAt, migratedAt);
  sqlite.exec('UPDATE ft_instance SET schema_version = 2 WHERE id = 1');
  sqlite.prepare(`INSERT INTO accounts
    (account_id, username, display_name, role, status, created_at, updated_at)
    VALUES ('a1', 'owner', 'Owner', 'admin', 'active', 1, 1)`).run();
  sqlite.prepare(`INSERT INTO account_credentials
    (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, must_change_password, updated_at)
    VALUES ('a1', 'pbkdf2-sha256-chain', 2, '{"iterations":100000,"rounds":6}', ?, ?, 0, 1)`).run(salt, hash);
  sqlite.exec('UPDATE ft_instance SET initialized_at = 1 WHERE id = 1');
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
        _run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((entry) => entry._run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, db, close: () => sqlite.close() };
}

async function rejectsCode(callback, code) {
  await assert.rejects(callback, (error) => error?.code === code);
}

test('admin boundary rechecks active role; member and disabled admin cannot manage accounts', async () => {
  const { sqlite, db, close } = fixture();
  try {
    assert.equal((await listAccounts({ db, actorAccountId: 'a1' })).accounts.length, 1);
    await rejectsCode(() => listAccounts({ db, actorAccountId: 'unknown' }), 'forbidden');
    sqlite.exec("UPDATE accounts SET status = 'disabled' WHERE account_id = 'a1'");
    await rejectsCode(() => listAccounts({ db, actorAccountId: 'a1' }), 'recovery_required');
  } finally { close(); }
});

test('administrator creates local account with temporary credential, no plaintext, and audit', async () => {
  const { sqlite, db, close } = fixture();
  try {
    const result = await createAccount({ db, actorAccountId: 'a1', username: 'Member_1',
      role: 'member', temporaryPassword: password, now });
    assert.equal(result.account.username, 'member_1');
    const credential = sqlite.prepare('SELECT password_hash, must_change_password FROM account_credentials WHERE account_id = ?').get(result.account.accountId);
    assert.equal(credential.must_change_password, 1);
    assert.notEqual(credential.password_hash, password);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='account.create'").get().n, 1);
    await rejectsCode(() => createAccount({ db, actorAccountId: 'a1', username: 'Member_1',
      role: 'member', temporaryPassword: password, now }), 'username_taken');
  } finally { close(); }
});

test('last active administrator cannot be disabled or demoted; changing another account revokes sessions', async () => {
  const { sqlite, db, close } = fixture();
  try {
    await rejectsCode(() => updateAccount({ db, actorAccountId: 'a1', accountId: 'a1',
      status: 'disabled', expectedUpdatedAt: 1, now }), 'last_admin_required');
    assert.equal(sqlite.prepare("SELECT status FROM accounts WHERE account_id='a1'").get().status, 'active');
    const second = await createAccount({ db, actorAccountId: 'a1', username: 'second', role: 'admin',
      temporaryPassword: password, now });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND status='active'").get().n, 2);
    assert.equal(sqlite.prepare("SELECT updated_at FROM accounts WHERE username='second'").get().updated_at, now);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE account_id = ? AND updated_at = ?
      AND (NOT (role = 'admin' AND status = 'active' AND (? != 'admin' OR ? != 'active'))
        OR (SELECT COUNT(*) FROM accounts WHERE role = 'admin' AND status = 'active') > 1)`).get(second.account.accountId, now, 'member', 'active').n, 1);
    sqlite.prepare(`INSERT INTO account_sessions (token_hash, account_id, mode, created_at, expires_at)
      VALUES ('token', ?, 'normal', 1, ?)`).run(second.account.accountId, now + 10);
    await updateAccount({ db, actorAccountId: 'a1', accountId: second.account.accountId,
      role: 'member', expectedUpdatedAt: now, now: now + 1 });
    assert.notEqual(sqlite.prepare("SELECT revoked_at FROM account_sessions WHERE token_hash='token'").get().revoked_at, null);
    assert.equal(sqlite.prepare("SELECT role FROM accounts WHERE username='second'").get().role, 'member');
    assert.equal(sqlite.prepare("SELECT display_name FROM accounts WHERE username='second'").get().display_name, 'second');
  } finally { close(); }
});

test('concurrent disable requests cannot eliminate both administrators', async () => {
  const { sqlite, db, close } = fixture();
  try {
    const second = await createAccount({ db, actorAccountId: 'a1', username: 'second', role: 'admin',
      temporaryPassword: password, now });
    const outcomes = await Promise.allSettled([
      updateAccount({ db, actorAccountId: 'a1', accountId: 'a1', status: 'disabled', expectedUpdatedAt: 1, now: now + 1 }),
      updateAccount({ db, actorAccountId: second.account.accountId, accountId: second.account.accountId,
        status: 'disabled', expectedUpdatedAt: now, now: now + 1 }),
    ]);
    assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND status='active'").get().n, 1);
  } finally { close(); }
});

test('an active administrator with corrupt credential cannot satisfy the last-admin guard', async () => {
  const { sqlite, db, close } = fixture();
  try {
    const second = await createAccount({ db, actorAccountId: 'a1', username: 'second', role: 'admin',
      temporaryPassword: password, now });
    sqlite.prepare("UPDATE account_credentials SET salt='invalid' WHERE account_id=?").run(second.account.accountId);
    await rejectsCode(() => updateAccount({ db, actorAccountId: 'a1', accountId: 'a1',
      status: 'disabled', expectedUpdatedAt: 1, now: now + 1 }), 'last_admin_required');
    assert.equal(sqlite.prepare("SELECT status FROM accounts WHERE account_id='a1'").get().status, 'active');
  } finally { close(); }
});

test('an administrator revoked between preflight and transaction cannot create an account', async () => {
  const { sqlite, db, close } = fixture();
  try {
    await createAccount({ db, actorAccountId: 'a1', username: 'second', role: 'admin',
      temporaryPassword: password, now });
    const previousBatch = db.batch.bind(db);
    db.batch = async (statements) => {
      sqlite.exec("UPDATE accounts SET status='disabled' WHERE account_id='a1'");
      return previousBatch(statements);
    };
    await rejectsCode(() => createAccount({ db, actorAccountId: 'a1', username: 'lateuser',
      temporaryPassword: password, now: now + 1 }), 'forbidden');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE username='lateuser'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='account.create'").get().n, 1);
  } finally { close(); }
});

test('settings enforce exact HTTPS origins, compare revisions and audit successful mutation only', async () => {
  const { sqlite, db, close } = fixture();
  try {
    await rejectsCode(() => updateAdminSetting(db, 'a1', 'cors.allowed_origins', ['*'], 0, now), 'invalid_setting');
    await rejectsCode(() => updateAdminSetting(db, 'a1', 'cors.allowed_origins', ['https://example.com/path'], 0, now), 'invalid_setting');
    await rejectsCode(() => updateAdminSetting(db, 'a1', 'ai.compatible_api_url', 'https://api.example/v1?key=secret', 0, now), 'invalid_setting');
    const saved = await updateAdminSetting(db, 'a1', 'cors.allowed_origins', ['https://example.com'], 0, now);
    assert.equal(saved.revision, 1);
    await rejectsCode(() => updateAdminSetting(db, 'a1', 'cors.allowed_origins', [], 0, now + 1), 'revision_conflict');
    const view = await getAdminSettings(db, 'a1');
    assert.deepEqual(view.settings['cors.allowed_origins'], { value: ['https://example.com'], revision: 1 });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='setting.update'").get().n, 1);
  } finally { close(); }
});

test('only an administrator can change the instance-wide lyric AI language and rules', async () => {
  const { db, close } = fixture();
  try {
    const next = { ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'en', referenceExistingTranslation: true };
    await rejectsCode(() => updateAdminSetting(db, 'm1', 'lyrics.ai', next, 0, now), 'forbidden');
    const saved = await updateAdminSetting(db, 'a1', 'lyrics.ai', next, 0, now);
    assert.equal(saved.revision, 1);
    assert.deepEqual((await getAdminSettings(db, 'a1')).settings['lyrics.ai'], { value: next, revision: 1 });
    await rejectsCode(() => updateAdminSetting(db, 'a1', 'lyrics.ai', next, 0, now + 1), 'revision_conflict');
    await rejectsCode(() => updateAdminSetting(db, 'a1', 'lyrics.ai', {
      ...next, cleanDirtyLyrics: false, translateLyrics: false, detectLanguage: false,
    }, 1, now + 1), 'invalid_setting');
  } finally { close(); }
});

test('stored lyric AI settings from before the switches keep completion enabled', async () => {
  const { sqlite, db, close } = fixture();
  try {
    const previous = { ...DEFAULT_LYRIC_AI_CONFIG };
    delete previous.completionEnabled;
    delete previous.automaticCompletionEnabled;
    sqlite.prepare(`INSERT INTO instance_settings (key, value_json, revision, updated_at, updated_by)
      VALUES ('lyrics.ai', ?, 1, ?, 'a1')`).run(JSON.stringify(previous), now);
    const setting = (await getAdminSettings(db, 'a1')).settings['lyrics.ai'];
    assert.equal(setting.value.completionEnabled, true);
    assert.equal(setting.value.automaticCompletionEnabled, true);
    assert.equal(setting.revision, 1);
  } finally { close(); }
});

test('assistant updates use a fixed field set and CAS revision', async () => {
  const { sqlite, db, close } = fixture();
  try {
    const before = await getAdminSettings(db, 'a1');
    const next = await updateAssistantConfig(db, 'a1', { name: 'Nova' }, before.assistant.revision, now);
    assert.equal(next.name, 'Nova');
    assert.equal(next.revision, before.assistant.revision + 1);
    await rejectsCode(() => updateAssistantConfig(db, 'a1', { system_rules: 'changed' }, before.assistant.revision, now + 1), 'revision_conflict');
    await rejectsCode(() => updateAssistantConfig(db, 'a1', { api_key: 'secret' }, next.revision, now + 2), 'invalid_assistant_setting');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='assistant.update'").get().n, 1);
  } finally { close(); }
});

test('administrator password reset is temporary, revokes target sessions and stays atomic on audit failure', async () => {
  const { sqlite, db, close } = fixture();
  try {
    sqlite.exec(`INSERT INTO account_sessions (token_hash, account_id, mode, created_at, expires_at)
      VALUES ('first', 'a1', 'normal', 1, 100000000000000)`);
    await resetAccountPassword({ db, actorAccountId: 'a1', accountId: 'a1', temporaryPassword: password, now });
    assert.equal(sqlite.prepare("SELECT must_change_password FROM account_credentials WHERE account_id='a1'").get().must_change_password, 1);
    assert.equal(sqlite.prepare("SELECT revoked_at FROM account_sessions WHERE token_hash='first'").get().revoked_at, now);
    const oldHash = sqlite.prepare("SELECT password_hash FROM account_credentials WHERE account_id='a1'").get().password_hash;
    sqlite.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    await rejectsCode(() => resetAccountPassword({ db, actorAccountId: 'a1', accountId: 'a1',
      temporaryPassword: password + '2', now: now + 1 }), 'storage_unavailable');
    assert.equal(sqlite.prepare("SELECT password_hash FROM account_credentials WHERE account_id='a1'").get().password_hash, oldHash);
  } finally { close(); }
});
