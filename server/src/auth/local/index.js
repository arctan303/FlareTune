import { resolveInstanceState } from '../../instance/state.js';
import { isUsableCredentialMaterial } from '../../instance/credentialFormat.js';
import { CURRENT_SCHEMA_VERSION } from '../../instance/schemaManifest.js';
import {
  csrfTokenForSession,
  hashPassword,
  normalizeUsername,
  randomSessionToken,
  setupSecretMatches,
  tokenDigest,
  validatePassword,
  verifyCsrfToken,
  verifyPassword,
} from './crypto.js';

export { csrfTokenForSession, hashPassword, normalizeUsername, setupSecretMatches, validatePassword, verifyCsrfToken, verifyPassword } from './crypto.js';

const NORMAL_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const LIMITED_SESSION_MS = 15 * 60 * 1000;
export const SESSION_COOKIE = '__Host-ft_session';

export class AuthError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

const invalidInput = () => new AuthError('invalid_input', 400);
const invalidCredentials = () => new AuthError('invalid_credentials', 401);
const unavailable = () => new AuthError('service_unavailable', 503);
const nowOrThrow = (now) => {
  if (!Number.isSafeInteger(now) || now <= 0) throw invalidInput();
  return now;
};

const isDatabase = (db) => Boolean(db?.prepare && db?.batch);

async function requireState(db, expected, now) {
  if (!db?.prepare) throw unavailable();
  const state = await resolveInstanceState(db, now);
  if ((Array.isArray(expected) ? expected : [expected]).includes(state.state)) return;
  if (state.state === 'setup_required' || state.state === 'ready') throw new AuthError('invalid_state', 409);
  throw unavailable();
}

const publicAccount = (row) => ({
  accountId: row.account_id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
});

export function sessionCookie(token, { secure = true, mode = 'normal', sameSite = 'Strict', expiresAt, now = Date.now() } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidInput();
  if (mode !== 'normal' && mode !== 'must_change_password') throw invalidInput();
  if (!['Strict', 'None'].includes(sameSite) || (sameSite === 'None' && !secure)) throw invalidInput();
  const lifetime = mode === 'normal' ? NORMAL_SESSION_MS : LIMITED_SESSION_MS;
  const remaining = Number.isSafeInteger(expiresAt) ? Math.min(lifetime, Math.max(0, expiresAt - now)) : lifetime;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(remaining / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = true } = {}) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function tokenFromCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  const tokens = cookieHeader.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (tokens.length !== 1) return null;
  const token = tokens[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function claimInstance({ db, setupSecret, suppliedSecret, username, password, now = Date.now() }) {
  nowOrThrow(now);
  if (!isDatabase(db) || typeof setupSecret !== 'string' || setupSecret.length < 32) throw unavailable();
  const canonical = normalizeUsername(username);
  if (!canonical || !validatePassword(password)) throw invalidInput();
  await requireState(db, 'setup_required', now);
  if (!await setupSecretMatches(setupSecret, suppliedSecret)) throw new AuthError('invalid_setup', 403);

  const credential = await hashPassword(password);
  const accountId = crypto.randomUUID();
  try {
    // D1 batch is a transaction. The NOT NULL guard is re-evaluated inside that
    // transaction, so a concurrent claim cannot create a second first admin.
    await db.batch([
      db.prepare(`INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, result, created_at)
        VALUES (?, NULL, CASE WHEN
          (SELECT initialized_at IS NULL AND schema_version = ? FROM ft_instance WHERE id = 1)
          AND NOT EXISTS (SELECT 1 FROM accounts)
          AND EXISTS (SELECT 1 FROM ft_migration_lock WHERE id = 1 AND owner_token IS NULL)
          AND EXISTS (SELECT 1 FROM ft_migrations WHERE version = ? AND state = 'completed')
          THEN 'instance.claim' ELSE NULL END, 'instance', '1', 'success', ?)`)
        .bind(crypto.randomUUID(), CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION, now),
      db.prepare(`INSERT INTO accounts (account_id, username, display_name, role, status, created_at, updated_at)
        VALUES (?, ?, ?, 'admin', 'active', ?, ?)`)
        .bind(accountId, canonical, canonical, now, now),
      db.prepare(`INSERT INTO account_credentials
        (account_id, kdf, kdf_version, kdf_params_json, salt, password_hash, must_change_password, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
        .bind(accountId, credential.kdf, credential.kdf_version, credential.kdf_params_json,
          credential.salt, credential.password_hash, now),
      db.prepare(`INSERT INTO instance_settings (key, value_json, revision, updated_at, updated_by)
        VALUES ('instance.name', ?, 1, ?, ?)`)
        .bind(JSON.stringify('FlareTune'), now, accountId),
      db.prepare(`INSERT INTO instance_settings (key, value_json, revision, updated_at, updated_by)
        VALUES ('cors.allowed_origins', '[]', 1, ?, ?)`)
        .bind(now, accountId),
      db.prepare(`UPDATE ft_instance SET initialized_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = 1 AND initialized_at IS NULL`)
        .bind(now, now),
    ]);
  } catch {
    throw new AuthError('claim_failed', 409);
  }
  return { accountId };
}

export async function login({ db, username, password, now = Date.now() }) {
  nowOrThrow(now);
  await requireState(db, ['ready'], now);
  const canonical = normalizeUsername(username);
  let row = null;
  try {
    if (canonical) row = await db.prepare(`SELECT a.account_id, a.username, a.display_name, a.role, a.status,
      c.kdf, c.kdf_version, c.kdf_params_json, c.salt, c.password_hash, c.must_change_password
      FROM accounts a JOIN account_credentials c ON c.account_id = a.account_id
      WHERE a.username = ?`).bind(canonical).first();
  } catch {
    throw unavailable();
  }
  if (!await verifyPassword(password, row)) throw invalidCredentials();
  if (!row || row.status !== 'active') throw invalidCredentials();
  const mode = row.must_change_password === 1 ? 'must_change_password' : 'normal';
  const token = randomSessionToken();
  const tokenHash = await tokenDigest(token);
  const expiresAt = now + (mode === 'normal' ? NORMAL_SESSION_MS : LIMITED_SESSION_MS);
  try {
    const result = await db.prepare(`INSERT INTO account_sessions (token_hash, account_id, mode, created_at, expires_at)
      SELECT ?, a.account_id, ?, ?, ? FROM accounts a JOIN account_credentials c ON c.account_id = a.account_id
      WHERE a.account_id = ? AND a.status = 'active' AND c.password_hash = ? AND c.salt = ?
        AND c.must_change_password = ?`)
      .bind(tokenHash, mode, now, expiresAt, row.account_id, row.password_hash, row.salt,
        row.must_change_password).run();
    if (result?.meta?.changes !== 1) throw invalidCredentials();
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw unavailable();
  }
  return { token, mode, account: publicAccount(row), expiresAt,
    csrfToken: await csrfTokenForSession(token) };
}

export async function getSession({ db, token, now = Date.now() }) {
  nowOrThrow(now);
  const tokenHash = await tokenDigest(token);
  if (!tokenHash) return null;
  await requireState(db, ['ready'], now);
  return loadSession({ db, token, tokenHash, now });
}

// Only call after this request has already resolved the same DB to `ready`.
// Standalone auth callers retain the full readiness check in getSession().
export async function getSessionAfterReadyCheck({ db, token, now = Date.now() }) {
  nowOrThrow(now);
  const tokenHash = await tokenDigest(token);
  if (!tokenHash) return null;
  return loadSession({ db, token, tokenHash, now });
}

async function loadSession({ db, token, tokenHash, now }) {
  try {
    const row = await db.prepare(`SELECT s.token_hash, s.mode, s.expires_at, a.account_id, a.username,
      a.display_name, a.role, c.kdf, c.kdf_version, c.kdf_params_json, c.salt, c.password_hash,
      c.must_change_password FROM account_sessions s
      JOIN accounts a ON a.account_id = s.account_id
      JOIN account_credentials c ON c.account_id = a.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.status = 'active'`)
      .bind(tokenHash, now).first();
    if (!row || !((row.mode === 'normal' && row.must_change_password === 0)
      || (row.mode === 'must_change_password' && row.must_change_password === 1))) return null;
    // Readiness verifies that at least one admin is usable; individual damaged
    // credentials must not retain an otherwise-valid session.
    if (!isUsableCredentialMaterial(row)) return null;
    return { tokenHash, mode: row.mode, account: publicAccount(row), expiresAt: row.expires_at,
      csrfToken: await csrfTokenForSession(token) };
  } catch {
    throw unavailable();
  }
}

export async function logout({ db, token, now = Date.now() }) {
  nowOrThrow(now);
  const hash = await tokenDigest(token);
  if (!hash) return { revoked: false };
  if (!db?.prepare) throw unavailable();
  try {
    const result = await db.prepare(`UPDATE account_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL`).bind(now, hash).run();
    return { revoked: result?.meta?.changes === 1 };
  } catch {
    throw unavailable();
  }
}

export async function changePassword({ db, session, currentPassword, newPassword, now = Date.now() }) {
  nowOrThrow(now);
  if (!isDatabase(db)) throw unavailable();
  if (!session?.tokenHash || !session?.account?.accountId
    || !['normal', 'must_change_password'].includes(session.mode)) throw invalidCredentials();
  if (!validatePassword(newPassword)) throw invalidInput();
  await requireState(db, 'ready', now);
  let old;
  try {
    old = await db.prepare(`SELECT c.kdf, c.kdf_version, c.kdf_params_json, c.salt, c.password_hash,
      c.must_change_password FROM account_credentials c WHERE c.account_id = ?`)
      .bind(session.account.accountId).first();
  } catch {
    throw unavailable();
  }
  if (!old || (session.mode === 'normal' && !await verifyPassword(currentPassword, old))) {
    throw invalidCredentials();
  }
  if (session.mode === 'must_change_password' && old.must_change_password !== 1) throw invalidCredentials();
  if (await verifyPassword(newPassword, old)) throw invalidInput();
  const replacement = await hashPassword(newPassword);
  try {
    await db.batch([
      db.prepare(`INSERT INTO audit_events (id, actor_account_id, action, target_type, target_id, result, created_at)
        VALUES (?, ?, CASE WHEN EXISTS (
          SELECT 1 FROM account_sessions s JOIN accounts a ON a.account_id = s.account_id
          JOIN account_credentials c ON c.account_id = a.account_id
          WHERE s.token_hash = ? AND s.account_id = ? AND s.mode = ? AND s.revoked_at IS NULL
            AND s.expires_at > ? AND a.status = 'active' AND c.password_hash = ? AND c.salt = ?
            AND c.must_change_password = ?
        ) THEN 'account.password.change' ELSE NULL END, 'account', ?, 'success', ?)`)
        .bind(crypto.randomUUID(), session.account.accountId, session.tokenHash,
          session.account.accountId, session.mode, now, old.password_hash, old.salt,
          old.must_change_password, session.account.accountId, now),
      db.prepare(`UPDATE account_credentials SET kdf = ?, kdf_version = ?, kdf_params_json = ?,
        salt = ?, password_hash = ?, must_change_password = 0, updated_at = ?
        WHERE account_id = ? AND password_hash = ? AND salt = ?`)
        .bind(replacement.kdf, replacement.kdf_version, replacement.kdf_params_json,
          replacement.salt, replacement.password_hash, now, session.account.accountId,
          old.password_hash, old.salt),
      db.prepare(`UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`)
        .bind(now, session.account.accountId),
      db.prepare(`UPDATE instance_settings SET value_json = '{"enabled":false}',
        revision = revision + 1, updated_at = ? WHERE key = ?`)
        .bind(now, `account.subsonic.${session.account.accountId}`),
    ]);
  } catch {
    throw new AuthError('password_change_failed', 409);
  }
  return { changed: true };
}
