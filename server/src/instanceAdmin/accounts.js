import { hashPassword, normalizeUsername, validatePassword } from '../auth/local/crypto.js';
import { isUsableCredentialMaterial } from '../instance/credentialFormat.js';
import {
  InstanceAdminError, atomic, changed, currentTime, requireActiveAdmin, statement, validAccountId,
} from './common.js';

const publicAccount = (row) => ({
  accountId: row.account_id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function validateRole(role) {
  if (role !== 'admin' && role !== 'member') throw new InstanceAdminError('invalid_role', 400);
  return role;
}

function validateStatus(status) {
  if (status !== 'active' && status !== 'disabled') throw new InstanceAdminError('invalid_status', 400);
  return status;
}

function validateDisplayName(displayName, username) {
  const result = displayName === undefined ? username : displayName;
  if (typeof result !== 'string' || result.length > 80) throw new InstanceAdminError('invalid_display_name', 400);
  return result;
}

function validateTemporaryPassword(password) {
  if (!validatePassword(password)) throw new InstanceAdminError('invalid_password', 400);
  return password;
}

export async function listAccounts({ db, actorAccountId }) {
  await requireActiveAdmin(db, actorAccountId);
  const rows = await db.prepare(`SELECT account_id, username, display_name, role, status, created_at, updated_at
    FROM accounts ORDER BY created_at, account_id`).all();
  return { accounts: (rows?.results ?? []).map(publicAccount) };
}

export async function createAccount({ db, actorAccountId, username, displayName, role = 'member', temporaryPassword, now = Date.now() }) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  const canonical = normalizeUsername(username);
  if (!canonical) throw new InstanceAdminError('invalid_username', 400);
  validateRole(role);
  validateTemporaryPassword(temporaryPassword);
  const safeDisplayName = validateDisplayName(displayName, canonical);
  currentTime(now);
  const credential = await hashPassword(temporaryPassword);
  const accountId = crypto.randomUUID();
  try {
    const results = await atomic(db, [
      statement(db, `INSERT INTO accounts
        (account_id, username, display_name, role, status, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'active', ?, ? WHERE EXISTS
          (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
      accountId, canonical, safeDisplayName, role, now, now, actor.account_id),
      statement(db, `INSERT INTO account_credentials
        (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, must_change_password, updated_at)
        SELECT account_id, ?, ?, ?, ?, ?, 1, ? FROM accounts WHERE account_id = ?`,
      credential.kdf, credential.kdf_version, credential.kdf_params_json, credential.salt,
      credential.password_hash, now, accountId),
      statement(db, `INSERT INTO audit_events
        (id, actor_account_id, action, target_type, target_id, result, created_at)
        SELECT ?, ?, 'account.create', 'account', ?, 'success', ? WHERE EXISTS
          (SELECT 1 FROM accounts WHERE account_id = ?)`, crypto.randomUUID(), actor.account_id, accountId, now, accountId),
    ]);
    if (!changed(results[0])) throw new InstanceAdminError('forbidden', 403);
  } catch (error) {
    if (error instanceof InstanceAdminError) throw error;
    if (String(error?.message ?? '').includes('UNIQUE')) throw new InstanceAdminError('username_taken', 409);
    throw new InstanceAdminError('storage_unavailable', 503);
  }
  return { account: { accountId, username: canonical, displayName: safeDisplayName, role,
    status: 'active', createdAt: now, updatedAt: now } };
}

export async function updateAccount({ db, actorAccountId, accountId, role, status, displayName, expectedUpdatedAt, now = Date.now() }) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  if (!validAccountId(accountId) || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0) {
    throw new InstanceAdminError('invalid_input', 400);
  }
  currentTime(now);
  const target = await statement(db, `SELECT account_id, username, display_name, role, status, updated_at
    FROM accounts WHERE account_id = ?`, accountId).first();
  if (!target) throw new InstanceAdminError('account_not_found', 404);
  const nextRole = validateRole(role ?? target.role);
  const nextStatus = validateStatus(status ?? target.status);
  const nextName = validateDisplayName(displayName, target.display_name);
  const wouldRemoveUsableAdmin = target.role === 'admin' && target.status === 'active'
    && (nextRole !== 'admin' || nextStatus !== 'active');
  if (wouldRemoveUsableAdmin) {
    const alternatives = await statement(db, `SELECT c.kdf, c.kdf_version, c.kdf_params_json, c.salt, c.password_hash
      FROM accounts a JOIN account_credentials c ON c.account_id = a.account_id
      WHERE a.account_id != ? AND a.role = 'admin' AND a.status = 'active'`, accountId).all();
    if (!(alternatives?.results ?? []).some(isUsableCredentialMaterial)) {
      throw new InstanceAdminError('last_admin_required', 409);
    }
  }
  const results = await atomic(db, [
    statement(db, `UPDATE accounts SET role = ?, status = ?, display_name = ?,
      disabled_at = CASE WHEN ? = 'disabled' THEN COALESCE(disabled_at, ?) ELSE NULL END,
      updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
      WHERE account_id = ? AND updated_at = ?
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
      AND (NOT (role = 'admin' AND status = 'active' AND (? != 'admin' OR ? != 'active'))
        OR EXISTS (SELECT 1 FROM accounts a JOIN account_credentials c ON c.account_id = a.account_id
          WHERE a.account_id != ? AND a.role = 'admin' AND a.status = 'active'
            AND c.kdf = 'pbkdf2-sha256-chain' AND c.kdf_version = 2
            AND json_type(c.kdf_params_json, '$.iterations') = 'integer'
            AND json_extract(c.kdf_params_json, '$.iterations') = 100000
            AND json_type(c.kdf_params_json, '$.rounds') = 'integer'
            AND json_extract(c.kdf_params_json, '$.rounds') = 6
            AND length(c.salt) = 22 AND c.salt NOT GLOB '*[^A-Za-z0-9_-]*'
            AND length(c.password_hash) = 43 AND c.password_hash NOT GLOB '*[^A-Za-z0-9_-]*'))`,
    nextRole, nextStatus, nextName, nextStatus, now, now, now, accountId, expectedUpdatedAt,
    actor.account_id, nextRole, nextStatus, accountId),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'account.update', 'account', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, accountId, now),
    statement(db, `UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND (status = 'disabled' OR role != ?))
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    now, accountId, accountId, target.role, actor.account_id),
  ]);
  if (!changed(results[0])) {
    const stillAdmin = await statement(db, `SELECT 1 FROM accounts WHERE account_id = ?
      AND role = 'admin' AND status = 'active'`, actor.account_id).first();
    if (!stillAdmin) throw new InstanceAdminError('forbidden', 403);
    if (wouldRemoveUsableAdmin) {
      const count = await db.prepare("SELECT COUNT(*) AS total FROM accounts WHERE role = 'admin' AND status = 'active'").first();
      if (count?.total <= 1) throw new InstanceAdminError('last_admin_required', 409);
    }
    throw new InstanceAdminError('revision_conflict', 409);
  }
  const saved = await statement(db, `SELECT account_id, username, display_name, role, status, created_at, updated_at
    FROM accounts WHERE account_id = ?`, accountId).first();
  return { account: publicAccount(saved) };
}

export async function resetAccountPassword({ db, actorAccountId, accountId, temporaryPassword, now = Date.now() }) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  if (!validAccountId(accountId)) throw new InstanceAdminError('invalid_input', 400);
  validateTemporaryPassword(temporaryPassword);
  currentTime(now);
  const credential = await hashPassword(temporaryPassword);
  let results;
  try { results = await atomic(db, [
    statement(db, `INSERT INTO account_credentials
      (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, must_change_password, updated_at)
      SELECT account_id, ?, ?, ?, ?, ?, 1, ? FROM accounts WHERE account_id = ?
        AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
      ON CONFLICT(account_id) DO UPDATE SET kdf = excluded.kdf, kdf_version = excluded.kdf_version,
        kdf_params_json = excluded.kdf_params_json, salt = excluded.salt,
        password_hash = excluded.password_hash, must_change_password = 1, updated_at = excluded.updated_at`,
    credential.kdf, credential.kdf_version, credential.kdf_params_json, credential.salt,
    credential.password_hash, now, accountId, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'account.password_reset', 'account', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, accountId, now),
    statement(db, `UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    now, accountId, actor.account_id),
    statement(db, `UPDATE instance_settings SET value_json = '{"enabled":false}',
      revision = revision + 1, updated_at = ? WHERE key = ?
      AND EXISTS (SELECT 1 FROM account_credentials WHERE account_id = ? AND salt = ?)
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    now, `account.subsonic.${accountId}`, accountId, credential.salt, actor.account_id),
  ]); } catch {
    throw new InstanceAdminError('storage_unavailable', 503);
  }
  if (!changed(results[0])) {
    const stillAdmin = await statement(db, `SELECT 1 FROM accounts WHERE account_id = ?
      AND role = 'admin' AND status = 'active'`, actor.account_id).first();
    throw new InstanceAdminError(stillAdmin ? 'account_not_found' : 'forbidden', stillAdmin ? 404 : 403);
  }
  return { ok: true, accountId, mustChangePassword: true };
}
