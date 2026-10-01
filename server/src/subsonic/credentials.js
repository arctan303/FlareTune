import { verifyPassword } from '../auth/local/crypto.js';
import { AuthError } from '../auth/local/index.js';
import { md5 } from './md5.js';
import { reject } from './response.js';

const encoder = new TextEncoder();
export const settingKey = (accountId) => `account.subsonic.${accountId}`;
const encode = (bytes) => btoa(String.fromCharCode(...bytes));
const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const equal = (a, b) => {
  let delta = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) delta |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return delta === 0;
};
async function key(env) {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) throw new AuthError('service_unavailable', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.SETUP_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('FlareTune subsonic v1'), info: encoder.encode('account password encryption') },
  material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const aad = (row) => encoder.encode(JSON.stringify(['subsonic-v1', row.account_id, row.salt]));
async function decrypt(row, env) {
  const saved = JSON.parse(row.value_json || '{}');
  if (!saved.enabled || saved.salt !== row.salt || row.status !== 'active' || row.must_change_password !== 0) return null;
  return new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM',
    iv: decode(saved.iv), additionalData: aad(row) }, await key(env), decode(saved.encrypted)));
}
const SELECT = `SELECT a.account_id, a.username, a.status, a.role, c.kdf, c.kdf_version,
  c.kdf_params_json, c.password_hash, c.salt, c.must_change_password,
  s.value_json, COALESCE(s.revision, 0) AS revision FROM accounts a
  JOIN account_credentials c ON c.account_id = a.account_id
  LEFT JOIN instance_settings s ON s.key = 'account.subsonic.' || a.account_id`;

export async function ownStatus(db, accountId, env) {
  const row = await db.prepare(`${SELECT} WHERE a.account_id = ?`).bind(accountId).first();
  let enabled = false;
  if (row) { try { enabled = Boolean(await decrypt(row, env)); } catch { /* Rotation/corruption fails closed. */ } }
  return { enabled, revision: Number(row?.revision || 0) };
}

export async function setEnabled(db, session, input, env, now = Date.now()) {
  if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0) throw new AuthError('invalid_input', 400);
  const id = session.account.accountId;
  const row = await db.prepare(`${SELECT} WHERE a.account_id = ?`).bind(id).first();
  if (!row || row.status !== 'active' || row.must_change_password !== 0) throw new AuthError('authentication_required', 401);
  if (Number(row.revision) !== input.expectedRevision) throw new AuthError('revision_conflict', 409);
  let value = { enabled: false };
  if (input.enabled) {
    if (!await verifyPassword(input.currentPassword, row)) throw new AuthError('invalid_credentials', 401);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(row) },
      await key(env), encoder.encode(input.currentPassword));
    value = { enabled: true, salt: row.salt, iv: encode(iv), encrypted: encode(new Uint8Array(encrypted)) };
  }
  // CAS covers concurrent enable/disable. Session and credential revalidation
  // prevents a slow password check from resurrecting access after a reset.
  const result = await db.prepare(`INSERT INTO instance_settings (key, value_json, revision, updated_at, updated_by)
    SELECT ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM accounts a
      JOIN account_credentials c ON c.account_id = a.account_id
      JOIN account_sessions t ON t.account_id = a.account_id
      WHERE a.account_id = ? AND a.status = 'active' AND c.salt = ? AND c.password_hash = ?
        AND c.must_change_password = 0 AND t.token_hash = ? AND t.mode = 'normal'
        AND t.revoked_at IS NULL AND t.expires_at > ?)
      AND COALESCE((SELECT revision FROM instance_settings WHERE key = ?), 0) = ?
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
      revision = instance_settings.revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(settingKey(id), JSON.stringify(value), now, id, id, row.salt, row.password_hash,
      session.tokenHash, now, settingKey(id), input.expectedRevision).run();
  if (Number(result?.meta?.changes) !== 1) throw new AuthError('revision_conflict', 409);
  return { enabled: input.enabled, revision: input.expectedRevision + 1 };
}

export async function authenticate(db, params, env) {
  if (params.has('p') || params.has('apiKey')) reject(params.has('t') || params.has('s') ? 43 : 42,
    'Use username, token and salt authentication');
  const username = params.get('u'); const token = params.get('t'); const salt = params.get('s');
  if (!username || !token || !salt) reject(10, 'Missing u, t or s');
  if (!/^[a-z0-9_.-]{3,64}$/i.test(username) || !/^[a-f0-9]{32}$/i.test(token)
    || salt.length < 6 || salt.length > 256) reject(40, 'Wrong username or password');
  const row = await db.prepare(`${SELECT} WHERE a.username = ?`).bind(username.toLowerCase()).first();
  let password = null;
  if (row) { try { password = await decrypt(row, env); } catch { /* Never reveal encryption errors. */ } }
  const matches = equal(md5(`${password || 'disabled'}${salt}`), token.toLowerCase());
  if (!password || !matches) reject(40, 'Wrong username or password');
  return { accountId: row.account_id, username: row.username };
}
