import { resolveInstanceState } from '../instance/state.js';
import { isUsableCredentialMaterial } from '../instance/credentialFormat.js';

export class InstanceAdminError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'InstanceAdminError';
    this.code = code;
    this.status = status;
  }
}

export function requireDatabase(db) {
  if (!db?.prepare || typeof db.batch !== 'function') throw new InstanceAdminError('storage_unavailable', 503);
  return db;
}

export function statement(db, sql, ...values) {
  return db.prepare(sql).bind(...values);
}

export async function atomic(db, statements) {
  requireDatabase(db);
  const results = await db.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length || results.some((result) => result?.success === false)) {
    throw new InstanceAdminError('storage_unavailable', 503);
  }
  return results;
}

export function changed(result) {
  // D1 reports sqlite3_total_changes(), including writes performed by triggers.
  // Each caller's SQL limits its target and checks ownership/revision itself.
  const count = result?.meta?.changes;
  return Number.isSafeInteger(count) && count > 0;
}

export function validAccountId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function requireActiveAdmin(db, actorAccountId) {
  requireDatabase(db);
  if (!validAccountId(actorAccountId)) throw new InstanceAdminError('forbidden', 403);
  const instance = await resolveInstanceState(db);
  if (instance.state !== 'ready') throw new InstanceAdminError(instance.state, 503);
  const actor = await statement(db,
    `SELECT a.account_id, a.username, c.kdf, c.kdf_version, c.kdf_params_json, c.salt, c.password_hash
     FROM accounts a JOIN account_credentials c ON c.account_id = a.account_id
     WHERE a.account_id = ? AND a.role = 'admin' AND a.status = 'active'`,
    actorAccountId).first();
  if (!actor || !isUsableCredentialMaterial(actor)) throw new InstanceAdminError('forbidden', 403);
  return { account_id: actor.account_id, username: actor.username };
}

export function validUsername(username) {
  return typeof username === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{2,63}$/.test(username);
}

export function validateRevision(revision, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(revision) || revision < (allowZero ? 0 : 1)) {
    throw new InstanceAdminError('invalid_revision', 400);
  }
  return revision;
}

export function currentTime(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new InstanceAdminError('invalid_time', 400);
  return now;
}
