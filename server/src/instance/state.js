import { CURRENT_SCHEMA_VERSION, KNOWN_MIGRATIONS, MIN_SUPPORTED_SCHEMA_VERSION } from './schemaManifest.js';
import { isUsableCredentialMaterial } from './credentialFormat.js';
import { invalidateSchemaInventory, readSchemaInventory } from './schemaInventory.js';

const state = (name, reason = null) => ({ state: name, reason, schemaVersion: null });
const validTime = (value) => Number.isSafeInteger(value) && value > 0;
const REQUIRED_TABLES = ['ft_instance', 'ft_migrations', 'ft_migration_lock', 'ft_recovery_audit',
  'accounts', 'account_credentials', 'account_sessions', 'instance_settings', 'audit_events',
  'Songs', 'Member_Playlists', 'Member_Playlist_Songs', 'Member_Playlist_Shelf',
  'Member_Song_Plays', 'Member_Play_Events', 'Lyric_Translations', 'AI_Daily_Usage',
  'music_chat_threads', 'music_chat_thread_messages', 'music_chat_turns',
  'music_assistant_configs', 'AI_Assistants', 'Artist_Photos'];

async function hasCompatibleServingSchema(inventory, names, triggers, executionContext) {
  if (names.has('Playlists') || names.has('Playlist_Songs')) return false;
  for (const name of ['ft_migration_progress', 'ai_model_profiles', 'ai_feature_assignments',
    'assistant_memory_settings', 'assistant_memories']) if (!names.has(name)) return false;
  const columns = await inventory.playlistColumns(executionContext);
  if (!columns?.results?.some((row) => row.name === 'cached_song_count'
    && String(row.type).toUpperCase() === 'INTEGER' && Number(row.notnull) === 1)) return false;
  return ['ft_member_playlist_songs_insert_count', 'ft_member_playlist_songs_delete_count',
    'ft_member_playlist_songs_move_count', 'ft_member_playlist_owner_count']
    .every((name) => triggers.has(name));
}

async function inspectInstanceState(db, now, cacheSchema, executionContext) {
  if (!db?.prepare) return state('recovery_required', 'database_unavailable');

  const inventory = await readSchemaInventory(db, now, cacheSchema, executionContext);
  const { schema } = inventory;
  if (!Array.isArray(schema?.results)) return state('recovery_required', 'control_plane_unavailable');
  const names = new Set(schema.results.filter((row) => row.type === 'table' && row.name !== '_cf_METADATA')
    .map((row) => row.name));
  const triggers = new Set(schema.results.filter((row) => row.type === 'trigger').map((row) => row.name));
  if (!names.has('ft_instance')) {
    // An empty provisioned D1 has no application schema. Never infer an empty
    // instance from a missing control table if unrelated data already exists.
    if (names.size === 0) return { state: 'setup_required', reason: null, schemaVersion: 0 };
    if (names.size === 1 && names.has('d1_migrations')) {
      const ledger = await db.prepare('SELECT COUNT(*) AS total FROM d1_migrations').first();
      if (ledger?.total === 0) return { state: 'setup_required', reason: null, schemaVersion: 0 };
    }
    return state('recovery_required', 'control_plane_missing');
  }

  // One database snapshot and one binding round trip. Only control-plane tables
  // are read here; business credentials are still read after validation below.
  const instance = await db.prepare(`SELECT schema_version, min_worker_schema, initialized_at, revision,
    (SELECT json_group_array(json_object('version',version,'name',name,'checksum',checksum,
      'stage',stage,'state',state,'started_at',started_at,'completed_at',completed_at,'error_code',error_code))
      FROM (SELECT * FROM ft_migrations ORDER BY version)) AS migration_rows,
    (SELECT json_object('owner_token',owner_token,'lease_expires_at',lease_expires_at)
      FROM ft_migration_lock WHERE id=1) AS migration_lock
    FROM ft_instance WHERE id = 1`).first();
    const migrations = { results: instance ? JSON.parse(instance.migration_rows) : null };
    const lock = instance ? JSON.parse(instance.migration_lock) : null;
    if (!instance || !lock || !Array.isArray(migrations?.results)) return state('recovery_required', 'control_plane_missing');

    const version = instance.schema_version;
    const minimum = instance.min_worker_schema;
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(minimum)
      || version < MIN_SUPPORTED_SCHEMA_VERSION || minimum < 1 || minimum > version
      || !Number.isSafeInteger(instance.revision) || instance.revision < 0) {
      return state('recovery_required', 'instance_metadata_invalid');
    }
    if (version > CURRENT_SCHEMA_VERSION || minimum > CURRENT_SCHEMA_VERSION) {
      return state('recovery_required', 'schema_version_unknown');
    }
    if (!REQUIRED_TABLES.every((name) => names.has(name))) {
      return state('recovery_required', 'schema_structure_invalid');
    }
    if (version === 1 && names.has('Playlists') !== names.has('Playlist_Songs')) {
      return state('recovery_required', 'migration_schema_inconsistent');
    }

    const knownByVersion = new Map(KNOWN_MIGRATIONS.map((migration) => [migration.version, migration]));
    let running = false;
    let runningVersion = null;
    let retryableFailure = false;
    let highestCompleted = 0;
    for (const row of migrations.results) {
      const known = knownByVersion.get(row.version);
      if (!known || row.name !== known.name || row.checksum !== known.checksum || row.stage !== known.stage) {
        return state('recovery_required', 'migration_mismatch');
      }
      if (!validTime(row.started_at)) return state('recovery_required', 'migration_state_invalid');
      if (row.state === 'failed') {
        if (row.version === 2 && row.error_code === 'PLAYLIST_COUNT_STEP_FAILED'
          && row.completed_at === null) retryableFailure = true;
        else return state('recovery_required', 'migration_failed');
        continue;
      }
      if (row.state === 'running') {
        if (row.completed_at !== null || row.error_code !== null) return state('recovery_required', 'migration_state_invalid');
        running = true;
        runningVersion = row.version;
      } else if (row.state !== 'completed' || !validTime(row.completed_at)
        || row.completed_at < row.started_at || row.error_code !== null) {
        return state('recovery_required', 'migration_state_invalid');
      } else {
        highestCompleted = Math.max(highestCompleted, row.version);
      }
    }

    if (!Number.isSafeInteger(lock.lease_expires_at) || lock.lease_expires_at < 0
      || (lock.owner_token === null && lock.lease_expires_at !== 0)
      || (lock.owner_token !== null && (typeof lock.owner_token !== 'string'
        || lock.owner_token.length < 32))) {
      return state('recovery_required', 'migration_lock_invalid');
    }
    const activeLock = lock.owner_token !== null && lock.lease_expires_at > now;
    // A resumable v2 row never substitutes for the completed v1 baseline.
    // Validate the ledger before exposing any path that can apply SQL.
    for (const known of KNOWN_MIGRATIONS) {
      if (known.version > version) continue;
      if (!migrations.results.some((row) => row.version === known.version && row.state === 'completed')) {
        return state('recovery_required', 'migration_ledger_incomplete');
      }
    }
    if (highestCompleted !== version) return state('recovery_required', 'migration_ledger_inconsistent');
    if (running) {
      if (!activeLock && runningVersion !== 2) return state('recovery_required', 'migration_interrupted');
      return { state: 'maintenance', reason: activeLock ? 'migration_running' : 'migration_interrupted', schemaVersion: version };
    }
    if (retryableFailure) return { state: 'maintenance', reason: 'migration_retryable', schemaVersion: version };
    if (version === CURRENT_SCHEMA_VERSION && !await hasCompatibleServingSchema(inventory, names, triggers, executionContext)) {
      return state('recovery_required', 'schema_structure_invalid');
    }
    if (lock.owner_token !== null) return { state: 'maintenance',
      reason: activeLock ? 'migration_lock_held' : 'migration_lock_stale', schemaVersion: version };
    if (version === 1 && !names.has('Playlists')) {
      const columns = await inventory.playlistColumns(executionContext);
      if (!columns?.results?.some((row) => row.name === 'cached_song_count')) {
        return state('recovery_required', 'migration_schema_inconsistent');
      }
    }
    const compatibleOldWorker = version === 1 && await hasCompatibleServingSchema(inventory, names, triggers, executionContext);
    if (version < CURRENT_SCHEMA_VERSION && !compatibleOldWorker) {
      return { state: 'maintenance', reason: 'migration_pending', schemaVersion: version };
    }

    // Business tables are not touched before the control plane is proven current.
    const initialized = validTime(instance.initialized_at);
    if (instance.initialized_at !== null && !initialized) return state('recovery_required', 'instance_metadata_invalid');
    if (!initialized) {
      const accounts = await db.prepare('SELECT COUNT(*) AS total FROM accounts').first();
      if (!Number.isSafeInteger(accounts?.total) || accounts.total < 0) return state('recovery_required', 'admin_state_invalid');
      if (accounts.total === 0) return version === CURRENT_SCHEMA_VERSION
        ? { state: 'setup_required', reason: null, schemaVersion: version }
        : { state: 'maintenance', reason: 'migration_pending', schemaVersion: version };
      return state('recovery_required', 'claim_state_inconsistent');
    }
    const admins = await db.prepare("SELECT c.kdf, c.kdf_version, c.kdf_params_json, c.salt, c.password_hash FROM accounts a INNER JOIN account_credentials c ON c.account_id = a.account_id WHERE a.role = 'admin' AND a.status = 'active'").all();
    if (!Array.isArray(admins?.results)) return state('recovery_required', 'admin_state_invalid');
    const usableAdmin = admins.results.some(isUsableCredentialMaterial);
    if (usableAdmin) return { state: 'ready', reason: compatibleOldWorker ? 'migration_available' : null, schemaVersion: version };
    return state('recovery_required', 'claim_state_inconsistent');
}

export async function resolveInstanceState(db, now = Date.now(), { cacheSchema = false, executionContext } = {}) {
  // Explicit health checks, writes and upgrade flows always inspect fresh
  // metadata and discard any serving snapshot. No background timer is used.
  if (!cacheSchema) invalidateSchemaInventory(db);
  // Only thrown storage failures are retried. A valid migration/recovery state
  // is returned immediately, so this cannot turn a failed ledger into ready.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await inspectInstanceState(db, now, cacheSchema, executionContext);
      if (result.state !== 'ready') invalidateSchemaInventory(db);
      return result;
    }
    catch {
      invalidateSchemaInventory(db);
      if (attempt === 1) return state('recovery_required', 'control_plane_unavailable');
    }
  }
}
