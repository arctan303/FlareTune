import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { runPlaylistCountMigration } from '../../server/src/instance/playlistCountMigration.js';
import { hashPassword } from '../../server/src/auth/local/crypto.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = resolve(root, '.tmp');
const target = process.argv[2] && resolve(process.argv[2]);
const accountId = process.argv[3] || 'local-rehearsal-admin';
const relativeTarget = target && relative(tempRoot, target);
if (!target || !relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`)) {
  throw new Error('Target must be an explicit child of the local .tmp directory.');
}
if (existsSync(target)) throw new Error('Target already exists; refusing to overwrite local data.');
if (!/^[a-zA-Z0-9_-]{3,64}$/.test(accountId)) throw new Error('Invalid rehearsal account ID.');

mkdirSync(dirname(target), { recursive: true });
const database = new DatabaseSync(target);
try {
  database.exec(readFileSync(resolve(root, 'server/db/migrations-flaretune/0001_baseline.sql'), 'utf8'));
  database.exec(readFileSync(resolve(root, 'server/db/migrations-flaretune/0002_expand_playlist_count.sql'), 'utf8'));
  const d1 = {
    prepare(sql) {
      const statement = database.prepare(sql);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return { meta: { changes: statement.run(...values).changes } }; },
      };
    },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
  let migration;
  for (let step = 0; step < 4; step += 1) {
    migration = await runPlaylistCountMigration(d1, { ownerToken: randomBytes(32).toString('hex') });
    if (migration.status === 'completed') break;
  }
  if (migration.status !== 'completed') throw new Error('Empty local target failed to reach v2 schema.');
  const now = Date.now();
  const throwawayPassword = randomBytes(32).toString('base64url');
  const credential = await hashPassword(throwawayPassword);
  database.prepare('INSERT INTO accounts (account_id, username, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(accountId, 'rehearsal_admin', 'Local Migration Rehearsal', 'admin', 'active', now, now);
  database.prepare('INSERT INTO account_credentials (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(accountId, credential.kdf, credential.kdf_version, credential.kdf_params_json,
      credential.salt, credential.password_hash, now);
  database.prepare('UPDATE ft_instance SET initialized_at = ?, updated_at = ?, revision = revision + 1 WHERE id = 1').run(now, now);
  process.stdout.write(`${JSON.stringify({ target, accountId, schemaVersion: 2, credential: 'random throwaway; not printed' })}\n`);
} finally {
  database.close();
}
