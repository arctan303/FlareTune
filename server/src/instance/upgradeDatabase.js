import { MIGRATION_BUNDLE } from './migrationBundle.generated.js';
import { requireExpandedSchema, requirePlaylistMigrationPreflight,
  runPlaylistCountMigration } from './playlistCountMigration.js';
import { resolveInstanceState } from './state.js';

export class DatabaseUpgradeError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const resultRows = (result) => Array.isArray(result?.results) ? result.results : [];
const bundled = (index) => MIGRATION_BUNDLE[index]?.statements ?? [];

async function objectExists(db, name) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name).first());
}

async function pairStatus(db, first, second) {
  const [left, right] = await Promise.all([objectExists(db, first), objectExists(db, second)]);
  if (left !== right) throw new DatabaseUpgradeError('migration_schema_inconsistent');
  return left;
}

async function googleAddonReady(db) {
  const tables = await Promise.all(['google_login_config', 'account_google_bindings', 'google_login_transactions'].map(name => objectExists(db, name)));
  if (tables.some(Boolean) && !tables.every(Boolean)) throw new DatabaseUpgradeError('migration_schema_inconsistent');
  return tables.every(Boolean);
}

async function ensureExpanded(db) {
  const columns = resultRows(await db.prepare('PRAGMA table_info(Member_Playlists)').all());
  if (!columns.length) throw new DatabaseUpgradeError('migration_schema_inconsistent');
  if (columns.some((column) => column.name === 'cached_song_count')) {
    await requireExpandedSchema(db);
    return;
  }
  const progress = await objectExists(db, 'ft_migration_progress');
  if (progress) throw new DatabaseUpgradeError('migration_schema_inconsistent');
  try { await db.batch(bundled(1).map((sql) => db.prepare(sql))); }
  catch {
    const retryColumns = resultRows(await db.prepare('PRAGMA table_info(Member_Playlists)').all());
    if (!retryColumns.some((column) => column.name === 'cached_song_count')) {
      throw new DatabaseUpgradeError('migration_expand_failed');
    }
  }
  await requireExpandedSchema(db);
}

async function ensureSupplemental(db, allowDestructive) {
  const hasLegacyPlaylists = await pairStatus(db, 'Playlists', 'Playlist_Songs');
  if (hasLegacyPlaylists) {
    const count = await db.prepare('SELECT COUNT(*) AS total FROM Playlists').first();
    const songs = await db.prepare('SELECT COUNT(*) AS total FROM Playlist_Songs').first();
    if ((!Number.isSafeInteger(count?.total) || !Number.isSafeInteger(songs?.total))) {
      throw new DatabaseUpgradeError('migration_schema_inconsistent');
    }
    if ((count.total > 0 || songs.total > 0) && !allowDestructive) {
      throw new DatabaseUpgradeError('backup_required', 409);
    }
  }
  const hasProfiles = await pairStatus(db, 'ai_model_profiles', 'ai_feature_assignments');
  const hasMemory = await pairStatus(db, 'assistant_memory_settings', 'assistant_memories');
  const scripts = [3, 4, 5, 7];
  if (!hasProfiles) scripts.push(6);
  if (!hasMemory) scripts.push(8);
  if (!await objectExists(db, 'ai_profile_protocols')) scripts.push(9);
  if (!await pairStatus(db, 'user_images', 'user_image_refs')) scripts.push(10);
  if (!await objectExists(db, 'ai_feature_models')) scripts.push(11);
  if (!await googleAddonReady(db)) scripts.push(12);
  scripts.sort((a, b) => a - b);
  try {
    await db.batch(scripts.flatMap((number) => bundled(number - 1).map((sql) => db.prepare(sql))));
  } catch { throw new DatabaseUpgradeError('migration_supplemental_failed'); }
}

export async function runKnownDatabaseUpgrade(db, { allowDestructive = false } = {}) {
  if (!db?.prepare || !db?.batch) throw new DatabaseUpgradeError('service_unavailable');
  let before = await resolveInstanceState(db);
  if (before.state === 'maintenance' && before.reason === 'migration_lock_held') {
    return { status: 'lease_busy', processed: 0, schemaVersion: before.schemaVersion };
  }
  if (before.state === 'maintenance' && before.reason === 'migration_lock_stale') {
    const lock = await db.prepare('SELECT owner_token, lease_expires_at FROM ft_migration_lock WHERE id = 1').first();
    const now = Date.now();
    if (!lock?.owner_token || lock.lease_expires_at > now) {
      return { status: 'lease_busy', processed: 0, schemaVersion: before.schemaVersion };
    }
    const cleared = await db.prepare(`UPDATE ft_migration_lock SET owner_token = NULL,
      lease_expires_at = 0, updated_at = ? WHERE id = 1 AND owner_token = ? AND lease_expires_at <= ?`)
      .bind(now, lock.owner_token, now).run();
    if (cleared?.meta?.changes !== 1) {
      return { status: 'lease_busy', processed: 0, schemaVersion: before.schemaVersion };
    }
    before = await resolveInstanceState(db);
  }
  if (before.schemaVersion === 2 && ['ready', 'setup_required'].includes(before.state)) {
    if (!await googleAddonReady(db)) {
      try { await db.batch(bundled(11).map((sql) => db.prepare(sql))); }
      catch { throw new DatabaseUpgradeError('migration_supplemental_failed'); }
    }
    if (!await objectExists(db, 'ai_profile_protocols')) {
      try { await db.batch(bundled(8).map((sql) => db.prepare(sql))); }
      catch { throw new DatabaseUpgradeError('migration_supplemental_failed'); }
    }
    if (!await pairStatus(db, 'user_images', 'user_image_refs')) {
      try { await db.batch(bundled(9).map((sql) => db.prepare(sql))); }
      catch { throw new DatabaseUpgradeError('migration_supplemental_failed'); }
    }
    if (!await objectExists(db, 'ai_feature_models')) {
      try { await db.batch(bundled(10).map((sql) => db.prepare(sql))); }
      catch { throw new DatabaseUpgradeError('migration_supplemental_failed'); }
    }
    return { status: 'current', schemaVersion: 2 };
  }
  const eligible = (before.state === 'ready' && before.reason === 'migration_available')
    || (before.state === 'maintenance' && ['migration_pending', 'migration_interrupted',
      'migration_running', 'migration_retryable'].includes(before.reason));
  if (!eligible || before.schemaVersion !== 1) {
    throw new DatabaseUpgradeError('invalid_state', 409);
  }
  try {
    await ensureExpanded(db);
    await requirePlaylistMigrationPreflight(db,
      { verifyPrefix: await objectExists(db, 'Playlists') });
    await ensureSupplemental(db, allowDestructive);
    const ownerToken = crypto.randomUUID().replaceAll('-', '');
    const step = await runPlaylistCountMigration(db, { ownerToken });
    return { ...step, schemaVersion: (await resolveInstanceState(db)).schemaVersion };
  } catch (error) {
    if (error instanceof DatabaseUpgradeError) throw error;
    // The runner only accepts built-in v2 and protects its own lease/ledger.
    throw new DatabaseUpgradeError('migration_step_failed');
  }
}
