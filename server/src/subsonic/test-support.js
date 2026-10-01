import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { KNOWN_MIGRATIONS } from '../instance/schemaManifest.js';
import { claimInstance, login, getSessionAfterReadyCheck, sessionCookie, hashPassword } from '../auth/local/index.js';
import worker from '../flaretune.js';
import { md5 } from './md5.js';

export const PASSWORD = 'test-original-password-2026';
export async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../../db/migrations-flaretune/', import.meta.url);
  for (const file of readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const now = Date.now(); const m = KNOWN_MIGRATIONS[1];
  sqlite.prepare(`INSERT INTO ft_migrations (version,name,checksum,stage,state,started_at,completed_at)
    VALUES (?,?,?,?, 'completed',?,?)`).run(m.version, m.name, m.checksum, m.stage, now, now);
  sqlite.exec('UPDATE ft_instance SET schema_version=2 WHERE id=1');
  const db = {
    rowsRead: 0, queries: [], fail: null, beforeWrite: null,
    prepare(sql) {
      const values = [];
      const run = () => {
        db.beforeWrite?.(sql);
        if (db.fail?.test(sql)) throw new Error('injected failure');
        db.queries.push(sql);
        if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { results: sqlite.prepare(sql).all(...values) };
        return { meta: { changes: sqlite.prepare(sql).run(...values).changes } };
      };
      return { bind(...args) { values.push(...args); return this; },
        async first() { db.queries.push(sql); const row = sqlite.prepare(sql).get(...values) || null; db.rowsRead += Number(Boolean(row)); return row; },
        async all() { db.queries.push(sql); const rows = sqlite.prepare(sql).all(...values); db.rowsRead += rows.length; return { results: rows }; },
        async run() { return run(); }, runSync: run };
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = statements.map((s) => s.runSync()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const env = { DB: db, SETUP_SECRET: 'test-only-setup-secret-at-least-32-characters', MEDIA_PREFIX: 'media' };
  await claimInstance({ db, setupSecret: env.SETUP_SECRET, suppliedSecret: env.SETUP_SECRET, username: 'owner', password: PASSWORD });
  const owner = sqlite.prepare("SELECT account_id FROM accounts WHERE username='owner'").get().account_id;
  const c = await hashPassword(PASSWORD);
  sqlite.prepare(`INSERT INTO accounts (account_id,username,role,created_at,updated_at) VALUES ('member','member','member',?,?)`).run(now, now);
  sqlite.prepare(`INSERT INTO account_credentials (account_id,kdf,kdf_version,kdf_params_json,salt,password_hash,must_change_password,updated_at)
    VALUES ('member',?,?,?,?,?,0,?)`).run(c.kdf,c.kdf_version,c.kdf_params_json,c.salt,c.password_hash,now);
  sqlite.exec(`INSERT INTO Songs (id,title,artist,album,duration,audio_url,cover_url,created_at) VALUES
    ('s1','One & <two>','Artist','Album',15,'/media/audio/one.mp3','/media/cover/one.png',10),
    ('s2','Night Flight','Artist','Album',30,'/media/audio/two.flac',NULL,20),
    ('s3','第三首','歌手','另一个专辑',60,'/media/audio/three.mp3',NULL,30);`);
  const objects = new Map([
    ['media/audio/one.mp3', { bytes: new Uint8Array([1,2,3,4,5]), type: 'audio/mpeg' }],
    ['media/cover/one.png', { bytes: new Uint8Array([6,7,8]), type: 'image/png' }],
  ]);
  let reads = 0;
  env.MEDIA_BUCKET = {
    async get(key, options) {
      reads++; const object = objects.get(key); if (!object) return null;
      const size = object.bytes.length; const match = /^bytes=(\d+)-(\d+)$/.exec(options?.range?.get('Range') || '');
      const range = match ? { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 } : null;
      return { body: range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes,
        size, range, httpEtag: '"test-etag"', etag: 'test-etag', text: async () => new TextDecoder().decode(object.bytes),
        writeHttpMetadata(headers) { headers.set('Content-Type', object.type); } };
    },
    async head(key) { const object = await this.get(key); return object; },
  };
  async function signIn(username = 'owner', password = PASSWORD) {
    const logged = await login({ db, username, password });
    return { session: await getSessionAfterReadyCheck({ db, token: logged.token }), cookie: sessionCookie(logged.token).split(';')[0] };
  }
  const signed = await signIn();
  async function api(input, method = 'GET', body, auth = signed, extra = {}) {
    return worker.fetch(new Request(`https://test.example/api/${input}`, { method,
      headers: { Cookie: auth.cookie, Origin: 'https://test.example', 'X-Requested-With': 'FlareTune',
        'X-CSRF-Token': auth.session.csrfToken, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.22', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  }
  async function enable(auth = signed, password = PASSWORD) {
    const status = await (await api('account/subsonic', 'GET', undefined, auth)).json();
    return api('account/subsonic', 'PUT', { enabled: true, currentPassword: password, expectedRevision: status.revision }, auth);
  }
  async function rest(method, params = {}, options = {}) {
    const p = new URLSearchParams({ u: options.username || 'owner', t: md5(`${options.password || PASSWORD}test-salt`), s: 'test-salt', v: '1.16.1', c: 'test', f: 'json' });
    for (const [key, value] of Object.entries(params)) {
      p.delete(key);
      if (value !== null) for (const item of Array.isArray(value) ? value : [value]) p.append(key, String(item));
    }
    return worker.fetch(new Request(`${options.origin || 'https://test.example'}/rest/${method}?${p}`, {
      method: options.method || 'GET', headers: { 'CF-Connecting-IP': '192.0.2.23', ...options.headers },
    }), options.env || env);
  }
  return { sqlite, db, env, owner, signed, signIn, api, enable, rest, objects, mediaReads: () => reads, close: () => sqlite.close() };
}
