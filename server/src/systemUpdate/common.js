import { AuthError } from '../auth/local/index.js';
import { isUsableCredentialMaterial } from '../instance/credentialFormat.js';

export const fail = (code, status = 409) => { throw new AuthError(code, status); };
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
export const revision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && value.split('.').every(part => Number.isSafeInteger(Number(part)));
export const compareVersions = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};
export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const sessionPredicate = `EXISTS (SELECT 1 FROM account_sessions s JOIN accounts a ON a.account_id=s.account_id
  JOIN account_credentials c ON c.account_id=a.account_id WHERE s.token_hash=? AND s.account_id=? AND s.mode='normal'
  AND s.revoked_at IS NULL AND s.expires_at>? AND a.status='active' AND a.role='admin' AND c.must_change_password=0)`;
export const sessionBindings = session => [session.tokenHash, session.account.accountId, Date.now()];
export async function requireAdmin(env, session) {
  if (session?.mode !== 'normal' || session.account?.role !== 'admin') fail('forbidden', 403);
  const row = await env.DB.prepare(`SELECT c.* FROM account_credentials c WHERE c.account_id=? AND ${sessionPredicate}`)
    .bind(session.account.accountId, ...sessionBindings(session)).first();
  if (!row || !isUsableCredentialMaterial(row)) fail('forbidden', 403);
}

const encoder = new TextEncoder(), domain = encoder.encode('FlareTune system update credentials v1');
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
async function secretKey(env) {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) fail('SYSTEM_UPDATE_SECRET_UNAVAILABLE', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.SETUP_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: domain, info: domain }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: domain }, await secretKey(env), encoder.encode(JSON.stringify(value)));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function open(env, value) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const [iv, encrypted] = value.split('.');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: domain }, await secretKey(env), decode(encrypted));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('SYSTEM_UPDATE_SECRET_UNAVAILABLE', 503); }
}
export async function matchesToken(token, expected) {
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) return false;
  const left = await sha256(token), right = await sha256(expected);
  let delta = 0; for (let index = 0; index < left.length; index++) delta |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return delta === 0;
}
