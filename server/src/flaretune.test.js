import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from './flaretune.js';
import { KNOWN_MIGRATIONS } from './instance/schemaManifest.js';

function fixture({ schemaVersion = 2 } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (schemaVersion !== 0) sqlite.exec(readFileSync(new URL('../db/migrations-flaretune/0001_baseline.sql', import.meta.url), 'utf8'));
  if (schemaVersion === 2) {
    sqlite.exec(readFileSync(new URL('../db/migrations-flaretune/0002_expand_playlist_count.sql', import.meta.url), 'utf8'));
    for (const name of ['0003_upgrade_assistant_model.sql', '0004_remove_system_playlists.sql',
      '0005_collection_identity.sql', '0006_ai_model_profiles.sql',
      '0007_default_ai_guidance.sql', '0008_assistant_memory.sql']) {
      sqlite.exec(readFileSync(new URL(`../db/migrations-flaretune/${name}`, import.meta.url), 'utf8'));
    }
    const migration = KNOWN_MIGRATIONS.find(({ version }) => version === 2);
    const migratedAt = Date.now();
    sqlite.prepare(`INSERT INTO ft_migrations
      (version, name, checksum, stage, state, started_at, completed_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?)`).run(
      migration.version, migration.name, migration.checksum, migration.stage, migratedAt, migratedAt);
    sqlite.exec('UPDATE ft_instance SET schema_version = 2 WHERE id = 1');
  }
  const db = {
    prepare(sql) {
      const values = [];
      return {
        bind(...args) { values.push(...args); return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
        runSync() {
          const statement = sqlite.prepare(sql);
          return /^\s*SELECT\b/i.test(sql)
            ? { results: statement.all(...values) }
            : { meta: { changes: statement.run(...values).changes } };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.runSync());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, db };
}

test('v2 Worker exposes only instance state and blocks old business/auth routes', async () => {
  const { sqlite, db } = fixture();
  const env = { DB: db, ASSETS: { fetch: async () => new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }) } };
  const request = (path, method = 'GET') => worker.fetch(new Request(`https://example.test${path}`, { method }), env);
  const status = await request('/api/instance/status');
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { state: 'setup_required', schemaVersion: 2, targetVersion: 2 });
  for (const path of ['/api/init', '/auth/start', '/api/admin/songs', '/api/account/playlists',
    '/api/albums', '/api/artists']) {
    const response = await request(path);
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: 'setup_required' });
  }
  assert.match(await (await request('/')).text(), /html/);
  sqlite.close();
});

test('v1 baseline enters maintenance until the schema is migrated', async () => {
  const { sqlite, db } = fixture({ schemaVersion: 1 });
  try {
    const env = { DB: db };
    const status = await worker.fetch(new Request('https://example.test/api/instance/status'), env);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { state: 'maintenance', schemaVersion: 1, targetVersion: 2 });
    const setup = await worker.fetch(new Request('https://example.test/api/auth/setup', { method: 'POST' }), env);
    assert.equal(setup.status, 503);
    assert.deepEqual(await setup.json(), { error: 'maintenance' });
    const business = await worker.fetch(new Request('https://example.test/api/songs'), env);
    assert.equal(business.status, 503);
    assert.deepEqual(await business.json(), { error: 'maintenance' });
  } finally { sqlite.close(); }
});

test('empty D1 verifies the secret without writes, then initializes and claims once', async () => {
  const { sqlite, db } = fixture({ schemaVersion: 0 });
  const env = { DB: db, SETUP_SECRET: 'local-only-rehearsal-setup-secret-at-least-32-bytes' };
  const post = (path, body) => worker.fetch(new Request(`https://example.test${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: {
      'Content-Type': 'application/json', Origin: 'https://example.test', 'X-Requested-With': 'FlareTune',
      'CF-Connecting-IP': '192.0.2.1',
    },
  }), env);
  try {
    assert.deepEqual(await (await worker.fetch(new Request('https://example.test/api/instance/status'), env)).json(),
      { state: 'setup_required', schemaVersion: 0, targetVersion: 2 });
    assert.equal((await post('/api/auth/setup', { username: 'owner', password: 'a long private passphrase 2026' })).status, 403);
    assert.equal((await post('/api/auth/verify-setup', { setupSecret: 'incorrect' })).status, 403);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0);
    const verify = await post('/api/auth/verify-setup', { setupSecret: env.SETUP_SECRET });
    assert.equal(verify.status, 200);
    const { proof } = await verify.json();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0);
    const setup = await post('/api/auth/setup', { proof, username: 'owner', password: 'a long private passphrase 2026' });
    assert.equal(setup.status, 201);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'").get().n, 1);
    assert.equal((await post('/api/auth/setup', { proof, username: 'other', password: 'a long private passphrase 2026' })).status, 403);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'").get().n, 1);
    assert.equal((await (await worker.fetch(new Request('https://example.test/api/instance/status'), env)).json()).state, 'ready');
  } finally { sqlite.close(); }
});

test('missing control tables and future schema never expose business routes', async () => {
  const noDb = await worker.fetch(new Request('https://example.test/api/songs'), {});
  assert.equal(noDb.status, 503);
  assert.equal((await noDb.json()).error, 'recovery_required');
  const { sqlite, db } = fixture();
  sqlite.exec('UPDATE ft_instance SET schema_version = 3');
  const response = await worker.fetch(new Request('https://example.test/api/songs'), { DB: db });
  assert.equal(response.status, 503);
  sqlite.close();
});

test('HTTP setup, login, CSRF and logout use the new local account only', async () => {
  const { sqlite, db } = fixture();
  const mediaReads = [];
  const mediaObject = {
    body: 'audio', size: 5, range: { offset: 0, length: 2 },
    writeHttpMetadata(headers) {
      headers.set('Content-Type', 'audio/mpeg');
      headers.set('Cache-Control', 'public, max-age=86400');
    },
  };
  const env = { DB: db, SETUP_SECRET: 'local-only-rehearsal-setup-secret-at-least-32-bytes',
    MEDIA_PREFIX: 'media', MEDIA_BUCKET: {
      async get(key) { mediaReads.push(['get', key]); return mediaObject; },
      async head(key) { mediaReads.push(['head', key]); return mediaObject; },
    },
  };
  const post = (path, body, headers = {}) => worker.fetch(new Request(`https://example.test${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: {
      'Content-Type': 'application/json', Origin: 'https://example.test',
      'X-Requested-With': 'FlareTune', ...headers,
    },
  }), env);
  try {
    const mediaUrl = 'https://example.test/media/audio/song.mp3';
    assert.equal((await worker.fetch(new Request(mediaUrl), env)).status, 503);
    assert.deepEqual(mediaReads, []);
    const missingOrigin = await post('/api/auth/verify-setup', { setupSecret: env.SETUP_SECRET }, { Origin: 'https://other.test' });
    assert.equal(missingOrigin.status, 403);
    const wrongSecret = await post('/api/auth/verify-setup', { setupSecret: 'wrong' });
    assert.equal(wrongSecret.status, 403);
    const verified = await post('/api/auth/verify-setup', { setupSecret: env.SETUP_SECRET });
    assert.equal(verified.status, 200);
    const { proof } = await verified.json();
    const setup = await post('/api/auth/setup', { proof,
      username: 'owner', password: 'a long private passphrase 2026' });
    assert.equal(setup.status, 201);
    assert.deepEqual(await setup.json(), { ok: true });
    const ready = await worker.fetch(new Request('https://example.test/api/instance/status'), env);
    assert.deepEqual(await ready.json(), { state: 'ready', schemaVersion: 2, targetVersion: 2 });
    for (const headers of [{}, { Cookie: 'ft_session=legacy-token' },
      { Cookie: '__Host-ft_session=invalid' }]) {
      const response = await worker.fetch(new Request(mediaUrl, { headers }), env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    }
    assert.deepEqual(mediaReads, []);
    assert.equal((await post('/api/auth/setup', { proof })).status, 403);
    assert.equal((await post('/api/auth/recovery', { setupSecret: 'wrong', action: 'inspect' })).status, 404);
    const recoveryInspect = await post('/api/auth/recovery', { setupSecret: env.SETUP_SECRET, action: 'inspect' });
    assert.equal(recoveryInspect.status, 404);
    assert.equal(recoveryInspect.headers.get('Set-Cookie'), null);
    assert.deepEqual(await recoveryInspect.json(), { error: 'not_found' });
    const invalid = await post('/api/auth/login', { username: 'owner', password: 'wrong' });
    assert.equal(invalid.status, 401);
    const loggedIn = await post('/api/auth/login', { username: 'owner', password: 'a long private passphrase 2026' });
    assert.equal(loggedIn.status, 200);
    const cookie = loggedIn.headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-ft_session=/);
    assert.match(cookie, /Secure;?/);
    const originalPrepare = db.prepare;
    let schemaInspections = 0;
    db.prepare = (sql) => {
      if (sql.includes('FROM sqlite_master')) schemaInspections += 1;
      return originalPrepare(sql);
    };
    const session = await worker.fetch(new Request('https://example.test/api/auth/session', { headers: { Cookie: cookie } }), env);
    assert.equal(session.status, 200);
    assert.ok(schemaInspections <= 1, 'authenticated API does not duplicate schema inventory; session readiness remains checked');
    db.prepare = originalPrepare;
    const sessionBody = await session.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.user.username, 'owner');
    const profileRequest = (displayName, csrfToken = sessionBody.csrfToken) => worker.fetch(new Request('https://example.test/api/account/profile', {
      method: 'PATCH', body: JSON.stringify({ displayName }), headers: {
        Origin: 'https://example.test', 'X-Requested-With': 'FlareTune',
        'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken,
      },
    }), env);
    assert.equal((await profileRequest('新昵称', 'invalid')).status, 403);
    assert.equal((await profileRequest('坏\n昵称')).status, 400);
    assert.equal((await profileRequest('新昵称')).status, 200);
    assert.equal((await worker.fetch(new Request('https://example.test/api/auth/session',
      { headers: { Cookie: cookie } }), env).then((response) => response.json())).user.displayName, '新昵称');
    assert.equal((await profileRequest('')).status, 200);
    assert.equal((await worker.fetch(new Request('https://example.test/api/auth/session',
      { headers: { Cookie: cookie } }), env).then((response) => response.json())).user.displayName, '');
    const removedForAdmin = await post('/api/auth/recovery',
      { setupSecret: env.SETUP_SECRET, action: 'reset_admin', username: 'owner',
        temporaryPassword: 'another long private passphrase' }, { Cookie: cookie });
    assert.equal(removedForAdmin.status, 404);
    assert.equal((await worker.fetch(new Request('https://example.test/api/auth/session',
      { headers: { Cookie: cookie } }), env).then((response) => response.json())).authenticated, true);
    assert.equal(typeof sessionBody.csrfToken, 'string');
    schemaInspections = 0;
    let mediaSessionChecks = 0;
    db.prepare = (sql) => {
      if (sql.includes('FROM sqlite_master')) schemaInspections += 1;
      if (sql.includes('FROM account_sessions s')) mediaSessionChecks += 1;
      return originalPrepare(sql);
    };
    const media = await worker.fetch(new Request(mediaUrl, {
      headers: { Cookie: cookie, Range: 'bytes=0-1' },
    }), env);
    assert.equal(media.status, 206);
    assert.equal(schemaInspections, 0, 'media reuses the recent API schema inventory');
    assert.equal(mediaSessionChecks, 1, 'media still verifies the current session');
    db.prepare = originalPrepare;
    assert.equal(media.headers.get('Content-Range'), 'bytes 0-1/5');
    assert.equal(media.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(await media.text(), 'audio');
    const mediaHead = await worker.fetch(new Request(mediaUrl, {
      method: 'HEAD', headers: { Cookie: cookie },
    }), env);
    assert.equal(mediaHead.status, 200);
    assert.equal(mediaHead.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(mediaReads, [['get', 'media/audio/song.mp3'], ['head', 'media/audio/song.mp3']]);
    sqlite.exec('UPDATE account_sessions SET revoked_at = 1');
    assert.equal((await worker.fetch(new Request(mediaUrl, { headers: { Cookie: cookie } }), env)).status, 401);
    assert.equal(mediaReads.length, 2, 'warm metadata cannot authorize a revoked session or read R2');
    sqlite.exec('UPDATE account_sessions SET revoked_at = NULL');
    sqlite.exec(`UPDATE ft_migration_lock SET owner_token = '${'a'.repeat(32)}', lease_expires_at = ${Date.now() + 60_000}`);
    assert.equal((await worker.fetch(new Request(mediaUrl, { headers: { Cookie: cookie } }), env)).status, 503);
    assert.equal(mediaReads.length, 2, 'maintenance stops warm media before R2');
    sqlite.exec('UPDATE ft_migration_lock SET owner_token = NULL, lease_expires_at = 0');
    const emptyLibrary = await worker.fetch(new Request('https://example.test/api/init',
      { headers: { Cookie: cookie } }), env);
    assert.equal(emptyLibrary.status, 200);
    assert.deepEqual((await emptyLibrary.json()).data.default_playlist.songs, []);
    for (const path of ['/api/albums', '/api/artists']) {
      const read = await worker.fetch(new Request(`https://example.test${path}`, {
        headers: { Cookie: cookie },
      }), env);
      assert.equal(read.status, 200);
      assert.equal((await read.json()).data.total, 0);
      assert.equal((await worker.fetch(new Request(`https://example.test${path}`), env)).status, 401);
    }
    const accountList = await worker.fetch(new Request('https://example.test/api/admin/accounts',
      { headers: { Cookie: cookie } }), env);
    assert.equal(accountList.status, 200);
    const owner = (await accountList.json()).accounts[0];
    assert.equal(owner.role, 'admin');
    const memberCreated = await post('/api/admin/accounts', {
      username: 'member', role: 'member', temporaryPassword: 'temporary member password 2026',
    }, { Cookie: cookie, 'X-CSRF-Token': sessionBody.csrfToken });
    assert.equal(memberCreated.status, 201);
    const settings = await worker.fetch(new Request('https://example.test/api/admin/settings',
      { headers: { Cookie: cookie } }), env);
    assert.equal(settings.status, 200);
    assert.deepEqual((await settings.json()).settings['cors.allowed_origins'].value, []);
    const downgrade = await worker.fetch(new Request(`https://example.test/api/admin/accounts/${owner.accountId}`, {
      method: 'PATCH', body: JSON.stringify({ role: 'member', expectedUpdatedAt: owner.updatedAt }),
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.test',
        'X-Requested-With': 'FlareTune', 'X-CSRF-Token': sessionBody.csrfToken, Cookie: cookie },
    }), env);
    assert.equal(downgrade.status, 409);
    const memberLogin = await post('/api/auth/login', {
      username: 'member', password: 'temporary member password 2026',
    });
    assert.equal(memberLogin.status, 200);
    assert.equal((await memberLogin.json()).mustChangePassword, true);
    const throttled = await post('/api/auth/login', { username: 'owner', password: 'wrong' });
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get('Retry-After')) > 0);
    const memberCookie = memberLogin.headers.get('Set-Cookie');
    assert.equal((await worker.fetch(new Request(mediaUrl, { headers: { Cookie: memberCookie } }), env)).status, 403);
    assert.equal(mediaReads.length, 2);
    assert.equal((await worker.fetch(new Request('https://example.test/api/init',
      { headers: { Cookie: memberCookie } }), env)).status, 403);
    assert.equal((await worker.fetch(new Request('https://example.test/api/albums',
      { headers: { Cookie: memberCookie } }), env)).status, 403);
    assert.equal((await worker.fetch(new Request('https://example.test/api/admin/accounts',
      { headers: { Cookie: memberCookie } }), env)).status, 403);
    const anonymous = await worker.fetch(new Request('https://example.test/api/unknown'), env);
    assert.equal(anonymous.status, 401);
    assert.equal((await post('/api/auth/logout', {}, { Cookie: cookie })).status, 403);
    assert.equal((await post('/api/auth/logout', {}, { Cookie: cookie,
      'X-CSRF-Token': sessionBody.csrfToken })).status, 200);
    const after = await worker.fetch(new Request('https://example.test/api/auth/session', { headers: { Cookie: cookie } }), env);
    assert.deepEqual(await after.json(), { authenticated: false, mustChangePassword: false });
    assert.equal((await worker.fetch(new Request(mediaUrl, { headers: { Cookie: cookie } }), env)).status, 401);
    assert.equal(mediaReads.length, 2);
  } finally {
    sqlite.close();
  }
});
