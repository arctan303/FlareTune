import { acquireMigrationLease, releaseMigrationLease } from './migrationControl.js';
import { KNOWN_MIGRATIONS } from './schemaManifest.js';

const VERSION = 2;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const RETRYABLE_ERROR_CODE = 'PLAYLIST_COUNT_STEP_FAILED';
const TRIGGERS = [
  'ft_member_playlist_songs_insert_count',
  'ft_member_playlist_songs_delete_count',
  'ft_member_playlist_songs_move_count',
  'ft_member_playlist_owner_count',
];

export class PlaylistCountMigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PlaylistCountMigrationError';
    this.code = code;
  }
}

const fail = (code) => { throw new PlaylistCountMigrationError(code); };
const validTime = (value) => Number.isSafeInteger(value) && value > 0;
const validToken = (value) => typeof value === 'string' && /^[a-f0-9]{32,128}$/i.test(value);
const validChecksum = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const rows = (result) => Array.isArray(result?.results) ? result.results : [];

function requireMigration() {
  const migration = KNOWN_MIGRATIONS.find((item) => item.version === VERSION);
  if (!migration || migration.stage !== 'migrate' || !validChecksum(migration.checksum)
    || typeof migration.name !== 'string' || !migration.name) fail('migration_not_built_in');
  return migration;
}

export async function requireExpandedSchema(db) {
  const [columns, progressColumns, triggers] = await Promise.all([
    db.prepare('PRAGMA table_info(Member_Playlists)').all(),
    db.prepare('PRAGMA table_info(ft_migration_progress)').all(),
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'ft_member_playlist_%'").all(),
  ]);
  const playlistCount = rows(columns).find((item) => item.name === 'cached_song_count');
  const progress = new Set(rows(progressColumns).map((item) => item.name));
  const foundTriggers = new Set(rows(triggers).map((item) => item.name));
  if (!playlistCount || String(playlistCount.type).toUpperCase() !== 'INTEGER'
    || Number(playlistCount.notnull) !== 1
    || !['version', 'phase', 'cursor', 'updated_at'].every((column) => progress.has(column))
    || !TRIGGERS.every((name) => foundTriggers.has(name))) fail('migration_expand_missing');
}

async function readControlPlane(db, migration) {
  const [instance, baseline, current] = await Promise.all([
    db.prepare('SELECT schema_version FROM ft_instance WHERE id = 1').first(),
    db.prepare('SELECT version, name, checksum, stage, state, completed_at FROM ft_migrations WHERE version = 1').first(),
    db.prepare('SELECT version, name, checksum, stage, state, started_at, completed_at, error_code FROM ft_migrations WHERE version = ?').bind(VERSION).first(),
  ]);
  const expectedBaseline = KNOWN_MIGRATIONS.find((item) => item.version === 1);
  if (!instance || !Number.isSafeInteger(instance.schema_version) || instance.schema_version > VERSION) {
    fail('migration_version_unknown');
  }
  if (instance.schema_version < 1 || !expectedBaseline || !baseline
    || baseline.version !== 1 || baseline.name !== expectedBaseline.name
    || baseline.checksum !== expectedBaseline.checksum || baseline.stage !== expectedBaseline.stage
    || baseline.state !== 'completed' || !validTime(baseline.completed_at)) fail('migration_baseline_invalid');
  if (current && (current.version !== VERSION || current.name !== migration.name
    || current.checksum !== migration.checksum || current.stage !== migration.stage
    || !validTime(current.started_at)
    || !['running', 'failed', 'completed'].includes(current.state)
    || (current.state === 'running' && (current.completed_at !== null || current.error_code !== null))
    || (current.state === 'failed' && (current.completed_at !== null || current.error_code !== RETRYABLE_ERROR_CODE))
    || (current.state === 'completed' && (!validTime(current.completed_at) || current.error_code !== null)))) {
    fail('migration_ledger_mismatch');
  }
  if (instance.schema_version === VERSION && current?.state === 'completed') return 'already_completed';
  if (instance.schema_version !== 1 || current?.state === 'completed') fail('migration_ledger_mismatch');
  return 'pending';
}

const countMismatch = `cached_song_count !=
  (SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = Member_Playlists.id)`;

async function validateProgress(db, verifyPrefix = false) {
  const progress = await db.prepare('SELECT phase, cursor FROM ft_migration_progress WHERE version = 2').first();
  if (!progress) return null;
  if (!['backfill', 'verify'].includes(progress.phase) || (progress.cursor !== null
    && (typeof progress.cursor !== 'string' || !progress.cursor))) {
    fail('migration_progress_invalid');
  }
  if (progress.cursor !== null) {
    const playlist = await db.prepare('SELECT id FROM Member_Playlists WHERE id = ?')
      .bind(progress.cursor).first();
    if (!playlist) fail('migration_progress_invalid');
    if (verifyPrefix) {
      const mismatch = await db.prepare(`SELECT 1 AS mismatch FROM Member_Playlists
        WHERE id <= ? AND ${countMismatch} LIMIT 1`).bind(progress.cursor).first();
      if (mismatch) fail('migration_progress_invalid');
    }
  }
  return progress;
}

// Used before supplemental SQL can remove the legacy shared playlists.
export async function requirePlaylistMigrationPreflight(db, { verifyPrefix = true } = {}) {
  const migration = requireMigration();
  await requireExpandedSchema(db);
  await readControlPlane(db, migration);
  await validateProgress(db, verifyPrefix);
}

// A D1 batch is one SQLite transaction. A missing/expired/different owner
// inserts the already-existing lock id and aborts the entire batch before any
// playlist, cursor, ledger or instance write can commit.
const ownerFence = (db, ownerToken, now, leaseMs) => db.prepare(`INSERT INTO ft_migration_lock
  (id, owner_token, lease_expires_at, updated_at)
  SELECT 1, ?, ?, ? WHERE NOT EXISTS (
    SELECT 1 FROM ft_migration_lock WHERE id = 1
      AND owner_token = ? AND lease_expires_at > ?
      AND lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  )`).bind(ownerToken, now + leaseMs, now, ownerToken, now);

const renewLease = (db, ownerToken, now, leaseMs) => db.prepare(`UPDATE ft_migration_lock
  SET lease_expires_at = MAX(lease_expires_at, ?), updated_at = ? WHERE id = 1 AND owner_token = ?
    AND lease_expires_at > ?
    AND lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`)
  .bind(now + leaseMs, now, ownerToken, now);

const controlFence = (db, migration) => db.prepare(`INSERT INTO ft_migration_lock
  (id, owner_token, lease_expires_at, updated_at)
  SELECT 1, NULL, 0, 0 WHERE NOT EXISTS (
    SELECT 1 FROM ft_instance WHERE id = 1 AND schema_version = 1
  ) OR NOT EXISTS (
    SELECT 1 FROM ft_migrations WHERE version = 2 AND name = ? AND checksum = ?
      AND stage = 'migrate' AND state = 'running' AND completed_at IS NULL AND error_code IS NULL
  )`).bind(migration.name, migration.checksum);

const cursorFence = (db, phase, cursor) => db.prepare(`INSERT INTO ft_migration_progress
  (version, phase, cursor, updated_at)
  SELECT 2, 'backfill', NULL, 0 WHERE NOT EXISTS (
    SELECT 1 FROM ft_migration_progress WHERE version = 2 AND phase = ? AND cursor IS ?
  )`).bind(phase, cursor);

async function startOrResume(db, migration, ownerToken, now, leaseMs) {
  await db.batch([
    ownerFence(db, ownerToken, now, leaseMs),
    renewLease(db, ownerToken, now, leaseMs),
    db.prepare(`INSERT OR IGNORE INTO ft_migrations
      (version, name, checksum, stage, state, started_at)
      VALUES (2, ?, ?, 'migrate', 'running', ?)`).bind(migration.name, migration.checksum, now),
    db.prepare(`UPDATE ft_migrations SET state = 'running', error_code = NULL
      WHERE version = 2 AND name = ? AND checksum = ? AND stage = 'migrate'
        AND state = 'failed' AND error_code = ?`)
      .bind(migration.name, migration.checksum, RETRYABLE_ERROR_CODE),
    db.prepare(`INSERT OR IGNORE INTO ft_migration_progress (version, phase, cursor, updated_at)
      VALUES (2, 'backfill', NULL, ?)`).bind(now),
  ]);
  // INSERT OR IGNORE must never hide a mismatched existing ledger row.
  await readControlPlane(db, migration);
  const progress = await validateProgress(db);
  if (!progress) fail('migration_progress_invalid');
  return progress;
}

async function advanceBatch(db, migration, ownerToken, now, leaseMs, phase, cursor, ids) {
  const lastId = ids.at(-1);
  await db.batch([
    ownerFence(db, ownerToken, now, leaseMs),
    renewLease(db, ownerToken, now, leaseMs),
    controlFence(db, migration),
    cursorFence(db, phase, cursor),
    db.prepare(`UPDATE Member_Playlists SET cached_song_count =
      (SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = Member_Playlists.id)
      WHERE id IN (${ids.map(() => '?').join(', ')}) AND cached_song_count !=
      (SELECT COUNT(*) FROM Member_Playlist_Songs WHERE playlist_id = Member_Playlists.id)`).bind(...ids),
    db.prepare(`UPDATE ft_migration_progress SET cursor = ?, updated_at = ?
      WHERE version = 2 AND phase = ? AND cursor IS ?`).bind(lastId, now, phase, cursor),
  ]);
  return { status: 'in_progress', phase, processed: ids.length, cursor: lastId };
}

async function finishPhase(db, migration, ownerToken, now, leaseMs, phase, cursor) {
  if (phase === 'backfill') {
    await db.batch([
      ownerFence(db, ownerToken, now, leaseMs),
      renewLease(db, ownerToken, now, leaseMs),
      controlFence(db, migration),
      cursorFence(db, phase, cursor),
      db.prepare(`UPDATE ft_migration_progress SET phase = 'verify', cursor = NULL, updated_at = ?
        WHERE version = 2 AND phase = 'backfill' AND cursor IS ?`).bind(now, cursor),
    ]);
    return { status: 'in_progress', phase: 'verify', processed: 0, cursor: null };
  }
  // A valid-looking saved cursor is not proof that earlier rows were verified.
  // This bounded-result integrity query catches skipped rows before v2 commits.
  const mismatch = await db.prepare(`SELECT 1 AS mismatch FROM Member_Playlists
    WHERE ${countMismatch} LIMIT 1`).first();
  if (mismatch) {
    await db.batch([
      ownerFence(db, ownerToken, now, leaseMs),
      renewLease(db, ownerToken, now, leaseMs),
      controlFence(db, migration),
      cursorFence(db, phase, cursor),
      db.prepare(`UPDATE ft_migration_progress SET phase = 'verify', cursor = NULL,
        updated_at = ? WHERE version = 2 AND phase = 'verify' AND cursor IS ?`).bind(now, cursor),
    ]);
    return { status: 'in_progress', phase: 'verify', processed: 0, cursor: null };
  }
  const ledger = await db.prepare('SELECT started_at FROM ft_migrations WHERE version = 2').first();
  if (!validTime(ledger?.started_at)) fail('migration_ledger_mismatch');
  const completedAt = Math.max(now, ledger.started_at);
  await db.batch([
    ownerFence(db, ownerToken, now, leaseMs),
    renewLease(db, ownerToken, now, leaseMs),
    controlFence(db, migration),
    cursorFence(db, phase, cursor),
    db.prepare(`INSERT INTO ft_migration_progress (version, phase, cursor, updated_at)
      SELECT 2, 'verify', NULL, 0 WHERE EXISTS (
        SELECT 1 FROM Member_Playlists WHERE ${countMismatch} LIMIT 1)`),
    // The control-plane version and migration ledger become visible together.
    db.prepare(`UPDATE ft_migrations SET state = 'completed', completed_at = ?, error_code = NULL
      WHERE version = 2 AND state = 'running'`).bind(completedAt),
    db.prepare('UPDATE ft_instance SET schema_version = 2, revision = revision + 1, updated_at = ? WHERE id = 1 AND schema_version = 1')
      .bind(completedAt),
  ]);
  return { status: 'completed', phase, processed: 0, cursor };
}

async function markRetryableFailure(db, migration, ownerToken, now, leaseMs) {
  await db.batch([
    ownerFence(db, ownerToken, now, leaseMs),
    renewLease(db, ownerToken, now, leaseMs),
    controlFence(db, migration),
    db.prepare(`UPDATE ft_migrations SET state = 'failed', error_code = ?
      WHERE version = 2 AND state = 'running'`).bind(RETRYABLE_ERROR_CODE),
  ]);
}

// One call does at most one bounded playlist batch. Recovery may call this
// repeatedly; reruns recompute exact counts, never increment cached values.
export async function runPlaylistCountMigration(db, {
  ownerToken,
  now = Date.now,
  batchSize = DEFAULT_BATCH_SIZE,
  leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  if (!db?.prepare || !db?.batch || !validToken(ownerToken) || typeof now !== 'function'
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE
    || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 300_000) {
    fail('migration_invalid_parameters');
  }
  const tick = () => {
    const value = now();
    if (!validTime(value)) fail('migration_invalid_parameters');
    return value;
  };
  const migration = requireMigration();
  let acquired = false;
  try {
    const before = await readControlPlane(db, migration);
    if (before === 'already_completed') {
      await requireExpandedSchema(db);
      // A finalization commit can succeed even if the subsequent lease release
      // fails. Reacquire only an unheld/expired lease, then release it in finally
      // so Secret recovery can clear that stale lock without replaying data.
      acquired = await acquireMigrationLease(db, ownerToken, tick(), leaseMs);
      if (!acquired) return { status: 'lease_busy', processed: 0, cursor: null };
      return { status: 'already_completed', processed: 0, cursor: null };
    }
    acquired = await acquireMigrationLease(db, ownerToken, tick(), leaseMs);
    if (!acquired) return { status: 'lease_busy', processed: 0, cursor: null };
    await requireExpandedSchema(db);
    const underLease = await readControlPlane(db, migration);
    if (underLease === 'already_completed') return { status: 'already_completed', processed: 0, cursor: null };
    const progress = await startOrResume(db, migration, ownerToken, tick(), leaseMs);
    const { phase, cursor } = progress;
    const selected = await db.prepare(`SELECT id FROM Member_Playlists
      WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT ?`).bind(cursor, cursor, batchSize).all();
    const ids = rows(selected).map((item) => item.id);
    if (ids.length) return await advanceBatch(db, migration, ownerToken, tick(), leaseMs, phase, cursor, ids);
    return await finishPhase(db, migration, ownerToken, tick(), leaseMs, phase, cursor);
  } catch (error) {
    if (acquired) {
      try {
        await markRetryableFailure(db, migration, ownerToken, tick(), leaseMs);
      } catch {
        // Lost ownership or unavailable storage: leave the running row as an
        // interrupted migration rather than writing a failure as stale owner.
      }
    }
    if (error instanceof PlaylistCountMigrationError) throw error;
    // SQL, binding details and storage error text must not reach HTTP callers.
    fail('migration_storage_unavailable');
  } finally {
    if (acquired) {
      try {
        // A stolen lease is owned by a different runner; release returns false.
        await releaseMigrationLease(db, ownerToken, tick());
      } catch {
        fail('migration_storage_unavailable');
      }
    }
  }
}
