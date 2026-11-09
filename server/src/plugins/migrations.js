import { AuthError } from '../auth/local/index.js';

const fail = (code, status = 409) => { throw new AuthError(code, status); };
export const migrationKey = pluginId => `plugin.migrations.${pluginId}`;
// IDs cannot contain underscores; a double separator prevents a plugin named
// "sample" from claiming tables owned by "sample-data".
export const pluginTablePrefix = pluginId => `plugin_${pluginId.replaceAll('-', '_')}__`;
export async function migrationChecksum(statements) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(statements)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// This intentionally small first grammar permits additive schema changes only.
// It is a framework contract for trusted bundled modules, not a SQL sandbox.
export function validateMigrationSql(pluginId, statement) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pluginId) || typeof statement !== 'string' || statement.length > 20000) fail('PLUGIN_MIGRATION_INVALID');
  const sql = statement.trim().replace(/;$/, '').trim();
  if (!sql || /;|--|\/\*|\*\/|["`\[\]\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sql)
    || /\b(?:SELECT|REFERENCES|PRAGMA|ATTACH|DETACH|TRIGGER|INSERT|UPDATE|DELETE|DROP|REPLACE|WITH|UNION)\b/i.test(sql)) fail('PLUGIN_MIGRATION_SCOPE');
  const prefix = pluginTablePrefix(pluginId);
  const own = name => name.startsWith(prefix) && /^[a-z][a-z0-9_]*$/.test(name) && name.length > prefix.length;
  const table = /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)\s*\(.+\)$/is.exec(sql);
  const alter = /^ALTER\s+TABLE\s+([a-z][a-z0-9_]*)\s+ADD(?:\s+COLUMN)?\s+[a-z][a-z0-9_]*\s+.+$/is.exec(sql);
  const index = /^CREATE(?:\s+UNIQUE)?\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)\s+ON\s+([a-z][a-z0-9_]*)\s*\(\s*[a-z][a-z0-9_]*(?:\s+(?:ASC|DESC))?(?:\s*,\s*[a-z][a-z0-9_]*(?:\s+(?:ASC|DESC))?)*\s*\)$/i.exec(sql);
  if (!(table && own(table[1])) && !(alter && own(alter[1])) && !(index && own(index[1]) && own(index[2]))) fail('PLUGIN_MIGRATION_SCOPE');
  return sql;
}

// The registry executes these statements in the SAME D1 transaction batch as
// its session/revision assertion and installation commit. A failed statement
// rolls back the ledger and install state along with that migration's DDL.
export async function preparePluginMigrations(env, pluginId, migrations = []) {
  if (!Array.isArray(migrations) || migrations.length > 32) fail('PLUGIN_MIGRATION_INVALID');
  const row = await env.DB.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(migrationKey(pluginId)).first();
  let completed = [];
  if (row) {
    try { completed = JSON.parse(row.value_json).completed; } catch { fail('PLUGIN_MIGRATION_LEDGER_INVALID'); }
    if (!Array.isArray(completed) || completed.length > migrations.length) fail('PLUGIN_DATA_VERSION_UNSUPPORTED');
  }
  const statements = [];
  const nextCompleted = [];
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index];
    if (!migration || migration.version !== index + 1 || !Array.isArray(migration.statements) || migration.statements.length === 0
      || migration.statements.length > 32 || !/^[a-f0-9]{64}$/.test(migration.checksum || '')) fail('PLUGIN_MIGRATION_INVALID');
    if (await migrationChecksum(migration.statements) !== migration.checksum) fail('PLUGIN_MIGRATION_CHECKSUM');
    const sql = migration.statements.map(statement => validateMigrationSql(pluginId, statement));
    const saved = completed[index];
    if (index < completed.length && (!saved || saved.version !== migration.version || saved.checksum !== migration.checksum)) fail('PLUGIN_MIGRATION_CHECKSUM');
    if (index >= completed.length) statements.push(...sql);
    nextCompleted.push({ version: migration.version, checksum: migration.checksum });
  }
  if (statements.length > 128) fail('PLUGIN_MIGRATION_INVALID');
  return { statements, completed: nextCompleted, changed: completed.length !== nextCompleted.length,
    revision: Number(row?.revision || 0), key: migrationKey(pluginId) };
}
