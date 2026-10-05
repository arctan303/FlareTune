import { MIGRATION_BUNDLE } from './migrationBundle.generated.js';
import { CURRENT_SCHEMA_VERSION, KNOWN_MIGRATIONS } from './schemaManifest.js';
import { resolveInstanceState } from './state.js';

export class BootstrapError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// This is an allowlist, not a general migration executor. The SQL bundle is
// generated from immutable repository migrations. D1 batch is one transaction:
// a failed statement cannot leave a partially claimed installation.
export async function initializeEmptyDatabase(db) {
  if (!db?.prepare || !db?.batch) throw new BootstrapError('service_unavailable');
  const before = await resolveInstanceState(db);
  if (before.state === 'setup_required' && before.schemaVersion === CURRENT_SCHEMA_VERSION) return;
  if (before.state !== 'setup_required' || before.schemaVersion !== 0) {
    throw new BootstrapError('invalid_state', 409);
  }
  const migration = KNOWN_MIGRATIONS.find((item) => item.version === CURRENT_SCHEMA_VERSION);
  if (!migration || MIGRATION_BUNDLE.length !== 13
    || MIGRATION_BUNDLE[0].name !== KNOWN_MIGRATIONS[0].name
    || MIGRATION_BUNDLE[1].sha256 !== migration.checksum) {
    throw new BootstrapError('migration_bundle_invalid');
  }
  const statements = MIGRATION_BUNDLE.flatMap((item) => item.statements.map((sql) => db.prepare(sql)));
  const now = Date.now();
  statements.push(db.prepare(`INSERT INTO ft_migrations
    (version, name, checksum, stage, state, started_at, completed_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?)`)
    .bind(migration.version, migration.name, migration.checksum, migration.stage, now, now));
  statements.push(db.prepare('UPDATE ft_instance SET schema_version = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND schema_version = 1')
    .bind(CURRENT_SCHEMA_VERSION, now));
  try {
    await db.batch(statements);
  } catch {
    // Concurrent setup may have won the transaction. It is safe to continue
    // only when the winner produced an unclaimed, fully validated instance.
    const after = await resolveInstanceState(db);
    if (after.state === 'setup_required' && after.schemaVersion === CURRENT_SCHEMA_VERSION) return;
    throw new BootstrapError('bootstrap_failed');
  }
  const after = await resolveInstanceState(db);
  if (after.state !== 'setup_required' || after.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new BootstrapError('bootstrap_failed');
  }
}
