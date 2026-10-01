import { AuthError, clearSessionCookie, sessionCookie, verifyPassword } from './local/index.js';
import { randomSessionToken, tokenDigest } from './local/crypto.js';
import { isUsableCredentialMaterial } from '../instance/credentialFormat.js';
import { requireActiveAdmin } from '../instanceAdmin/common.js';
import { consumeAuthAttempt } from './local/rateLimit.js';
import { readBoundedJson } from '../instance/httpSecurity.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const CALLBACK = '/auth/google/callback';
const TTL = 10 * 60 * 1000;
const encoder = new TextEncoder();
const fail = (code = 'google_failed', status = 400) => { throw new AuthError(code, status); };
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
let keysCache = null;

export async function googleSchemaReady(db) {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('google_login_config','account_google_bindings','google_login_transactions')").all();
  return result.results?.length === 3;
}

async function key(env) {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) fail('google_secret_unavailable', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.SETUP_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('FlareTune Google credentials v1'), info: encoder.encode('Google client secret AES-GCM') },
  material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function readConfig(env) {
  if (!await googleSchemaReady(env.DB)) return null;
  return env.DB.prepare('SELECT * FROM google_login_config WHERE id = 1').first();
}

async function secretFor(config, env) {
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(config.secret_iv) },
      await key(env), decode(config.encrypted_secret)));
  } catch { fail('google_secret_unavailable', 503); }
}

function originFor(raw) {
  if (typeof raw !== 'string' || raw.length > 255) fail('invalid_input');
  let url;
  try { url = new URL(raw); } catch { fail('invalid_input'); }
  if (url.origin !== raw || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) fail('invalid_input');
  return url.origin;
}

async function publicConfig(config, env) {
  let secretReady = false;
  if (config?.encrypted_secret) {
    try { secretReady = Boolean(await secretFor(config, env)); } catch { /* Rotated secret fails closed. */ }
  }
  return { ready: Boolean(config), enabled: config?.enabled === 1, clientId: config?.client_id || '',
    callbackOrigin: config?.callback_origin || '', secretConfigured: Boolean(config?.encrypted_secret),
    secretReady, revision: config?.revision ?? 0,
    callbackUrl: config?.callback_origin ? config.callback_origin + CALLBACK : '' };
}

async function rateLimit(request, env, username) {
  const limit = await consumeAuthAttempt({ db: env.DB, request, kind: 'login', username });
  if (!limit.allowed) fail('rate_limited', 429);
}

async function verifyOwnerPassword(env, session, password) {
  if (session?.mode !== 'normal') fail('forbidden', 403);
  const row = await stmt(env.DB, `SELECT c.* FROM account_credentials c JOIN accounts a ON a.account_id=c.account_id
    JOIN account_sessions s ON s.account_id=a.account_id WHERE a.account_id=? AND a.status='active'
    AND c.must_change_password=0 AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.mode='normal'`,
  session.account.accountId, session.tokenHash, Date.now()).first();
  if (!row || !await verifyPassword(password, row)) fail('invalid_credentials', 401);
  return row;
}

function cookieName(request) { return new URL(request.url).protocol === 'https:' ? '__Host-ft_google_transaction' : 'ft_google_transaction_dev'; }
function transactionCookie(request, value) {
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? TTL / 1000 : 0}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function browserCookie(request) {
  const parts = (request.headers.get('Cookie') || '').split(';').map(p => p.trim()).filter(p => p.startsWith(cookieName(request) + '='));
  const value = parts.length === 1 ? parts[0].slice(cookieName(request).length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

async function start(request, env, config, session, purpose, body, json) {
  if (!config || !config.client_id || !config.encrypted_secret || (purpose === 'login' && config.enabled !== 1)) fail('google_unavailable', 409);
  if (new URL(request.url).origin !== config.callback_origin) fail('google_origin_mismatch', 409);
  await secretFor(config, env);
  await rateLimit(request, env, session?.account.username);
  const credential = purpose === 'bind' ? await verifyOwnerPassword(env, session, body.currentPassword) : null;
  const now = Date.now(), state = randomSessionToken(), browser = randomSessionToken(), nonce = randomSessionToken(), verifier = randomSessionToken();
  await env.DB.batch([
    stmt(env.DB, 'DELETE FROM google_login_transactions WHERE expires_at<=?', now),
    stmt(env.DB, `INSERT INTO google_login_transactions
      (state_hash,browser_hash,nonce,verifier,purpose,config_revision,auth_epoch,account_id,session_hash,password_hash,salt,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, await tokenDigest(state), await tokenDigest(browser), nonce, verifier, purpose,
    config.revision, config.auth_epoch, credential ? session.account.accountId : null, credential ? session.tokenHash : null,
    credential?.password_hash ?? null, credential?.salt ?? null, now + TTL),
  ]);
  const params = new URLSearchParams({ client_id: config.client_id, redirect_uri: config.callback_origin + CALLBACK,
    response_type: 'code', scope: 'openid email', state, nonce, access_type: 'online', prompt: 'select_account',
    code_challenge: encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))), code_challenge_method: 'S256' });
  return json({ url: AUTH_URL + '?' + params }, 200, { 'Set-Cookie': transactionCookie(request, browser) });
}

async function limitedJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (!response.ok || !response.body) fail('google_failed', 502);
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > 65536) fail('google_failed', 502); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('google_failed', 502); }
}

export async function verifyGoogleIdToken(idToken, clientId, nonce, fetchImpl = fetch) {
  if (typeof idToken !== 'string' || idToken.length > 16384) fail();
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) fail();
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(decode(parts[0]))); payload = JSON.parse(new TextDecoder().decode(decode(parts[1]))); } catch { fail(); }
  const now = Math.floor(Date.now() / 1000);
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256
    || !['https://accounts.google.com', 'accounts.google.com'].includes(payload?.iss)
    || payload.aud !== clientId || (payload.azp !== undefined && payload.azp !== clientId)
    || !Number.isInteger(payload.exp) || payload.exp <= now || !Number.isInteger(payload.iat) || payload.iat > now + 60
    || payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255
    || (payload.email !== undefined && (typeof payload.email !== 'string' || payload.email.length > 320 || payload.email_verified !== true))) fail();
  if (!keysCache || keysCache.expires <= Date.now() || keysCache.fetchImpl !== fetchImpl) {
    keysCache = { data: await limitedJson(JWKS_URL, {}, fetchImpl), expires: Date.now() + 3600000, fetchImpl };
  }
  let jwk = keysCache.data.keys?.find(k => k.kid === header.kid);
  if (!jwk) {
    keysCache = { data: await limitedJson(JWKS_URL, {}, fetchImpl), expires: Date.now() + 3600000, fetchImpl };
    jwk = keysCache.data.keys?.find(k => k.kid === header.kid);
  }
  if (!jwk || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) fail();
  const signingKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', signingKey, decode(parts[2]), encoder.encode(parts[0] + '.' + parts[1]))) fail();
  return { sub: payload.sub, email: payload.email || '' };
}

// Every final write rechecks configuration, credential and session within D1's transaction.
const OWNER_GUARD = `EXISTS (SELECT 1 FROM accounts a JOIN account_credentials c ON c.account_id=a.account_id
  JOIN account_sessions s ON s.account_id=a.account_id WHERE a.account_id=? AND a.status='active'
  AND c.must_change_password=0 AND c.password_hash=? AND c.salt=? AND s.token_hash=?
  AND s.mode='normal' AND s.revoked_at IS NULL AND s.expires_at>?)`;

async function callback(request, env, config, fetchImpl) {
  let purpose = 'login';
  const redirect = (tag, cookie = '') => {
    const headers = new Headers({ Location: (purpose === 'bind' ? '/settings/personal' : '/') + (tag ? '?google=' + tag : ''),
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': transactionCookie(request, '') });
    if (cookie) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 303, headers });
  };
  try {
    if (!config || new URL(request.url).origin !== config.callback_origin) fail();
    const url = new URL(request.url);
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1) fail();
    const state = url.searchParams.get('state');
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !browserCookie(request)) fail();
    const hash = await tokenDigest(state), now = Date.now();
    const record = await stmt(env.DB, `SELECT * FROM google_login_transactions WHERE state_hash=? AND browser_hash=?
      AND used_at IS NULL AND expires_at>?`, hash, await tokenDigest(browserCookie(request)), now).first();
    if (!record) fail();
    purpose = record.purpose;
    const consumed = await stmt(env.DB, 'UPDATE google_login_transactions SET used_at=? WHERE state_hash=? AND used_at IS NULL AND expires_at>?', now, hash, now).run();
    if (consumed.meta?.changes !== 1 || record.config_revision !== config.revision) fail();
    if (purpose === 'login' && (config.enabled !== 1 || record.auth_epoch !== config.auth_epoch)) fail();
    if (url.searchParams.has('error')) return redirect('cancelled');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) fail();
    const token = await limitedJson(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.client_id,
        client_secret: await secretFor(config, env), redirect_uri: config.callback_origin + CALLBACK, code, code_verifier: record.verifier }) }, fetchImpl);
    const identity = await verifyGoogleIdToken(token.id_token, config.client_id, record.nonce, fetchImpl);
    if (purpose === 'bind') {
      const args = [record.account_id, record.password_hash, record.salt, record.session_hash, Date.now()];
      try {
        await env.DB.batch([
          stmt(env.DB, `INSERT INTO audit_events (id,actor_account_id,action,result,created_at)
            VALUES (?,?,CASE WHEN ${OWNER_GUARD} AND EXISTS (SELECT 1 FROM google_login_config WHERE id=1 AND revision=?)
              AND NOT EXISTS (SELECT 1 FROM account_google_bindings WHERE account_id=? AND google_sub<>?)
              THEN 'google.bind' ELSE NULL END,'success',?)`, crypto.randomUUID(), record.account_id,
          ...args, config.revision, record.account_id, identity.sub, Date.now()),
          stmt(env.DB, `INSERT INTO account_google_bindings (account_id,binding_id,google_sub,email,created_at) VALUES (?,?,?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET email=excluded.email`, record.account_id, crypto.randomUUID(), identity.sub, identity.email, Date.now()),
        ]);
      } catch { return redirect('binding_failed'); }
      return redirect('bound');
    }
    const account = await stmt(env.DB, `SELECT a.*,c.*,g.binding_id FROM account_google_bindings g JOIN accounts a ON a.account_id=g.account_id
      JOIN account_credentials c ON c.account_id=a.account_id WHERE g.google_sub=? AND a.status='active' AND c.must_change_password=0`, identity.sub).first();
    if (!account || !isUsableCredentialMaterial(account)) return redirect('unbound');
    const sessionToken = randomSessionToken(), expiresAt = Date.now() + 7 * 24 * 3600000;
    const inserted = await stmt(env.DB, `INSERT INTO account_sessions (token_hash,account_id,mode,created_at,expires_at)
      SELECT ?,a.account_id,'normal',?,? FROM accounts a JOIN account_credentials c ON c.account_id=a.account_id
      JOIN account_google_bindings g ON g.account_id=a.account_id WHERE a.account_id=? AND a.status='active'
      AND c.must_change_password=0 AND c.password_hash=? AND c.salt=? AND g.google_sub=? AND g.binding_id=?
      AND EXISTS (SELECT 1 FROM google_login_config WHERE id=1 AND revision=? AND enabled=1 AND auth_epoch=?)`,
    await tokenDigest(sessionToken), Date.now(), expiresAt, account.account_id, account.password_hash, account.salt, identity.sub,
    account.binding_id,
    config.revision, record.auth_epoch).run();
    if (inserted.meta?.changes !== 1) fail();
    return redirect('', sessionCookie(sessionToken, { expiresAt }));
  } catch { return redirect('failed'); }
}

export async function handleGoogleRequest(request, env, path, session, json, fetchImpl = fetch) {
  if (![ '/api/auth/google/status', '/api/auth/google/start', CALLBACK, '/api/account/google',
    '/api/account/google/bind', '/api/account/google/unbind', '/api/admin/google' ].includes(path)) return null;
  const config = await readConfig(env);
  if (path === '/api/auth/google/status' && request.method === 'GET') {
    const status = await publicConfig(config, env);
    return json({ enabled: status.enabled && status.secretReady && config.callback_origin === new URL(request.url).origin });
  }
  if (path === CALLBACK && request.method === 'GET') return callback(request, env, config, fetchImpl);
  if (path === '/api/auth/google/start' && request.method === 'POST') return start(request, env, config, session, 'login', {}, json);
  if (!session || session.mode !== 'normal') fail('forbidden', 403);
  if (path === '/api/account/google' && request.method === 'GET') {
    const binding = config ? await stmt(env.DB, 'SELECT email FROM account_google_bindings WHERE account_id=?', session.account.accountId).first() : null;
    const status = await publicConfig(config, env);
    return json({ ready: status.ready, configured: status.secretReady && Boolean(config.client_id) && config.callback_origin === new URL(request.url).origin,
      bound: Boolean(binding), email: binding?.email || '' });
  }
  if (path === '/api/account/google/bind' && request.method === 'POST') return start(request, env, config, session, 'bind', await readBoundedJson(request), json);
  if (path === '/api/account/google/unbind' && request.method === 'POST') {
    if (!config) fail('google_unavailable', 409);
    await rateLimit(request, env, session.account.username);
    const body = await readBoundedJson(request), credential = await verifyOwnerPassword(env, session, body.currentPassword), now = Date.now();
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO audit_events (id,actor_account_id,action,result,created_at) VALUES
        (?,?,CASE WHEN ${OWNER_GUARD} THEN 'google.unbind' ELSE NULL END,'success',?)`, crypto.randomUUID(), session.account.accountId,
      session.account.accountId, credential.password_hash, credential.salt, session.tokenHash, now, now),
      stmt(env.DB, 'DELETE FROM account_google_bindings WHERE account_id=?', session.account.accountId),
      stmt(env.DB, 'UPDATE account_sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL', now, session.account.accountId),
      stmt(env.DB, 'DELETE FROM google_login_transactions WHERE account_id=?', session.account.accountId),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }
  if (path === '/api/admin/google') {
    await requireActiveAdmin(env.DB, session.account.accountId);
    if (request.method === 'GET') return json(await publicConfig(config, env));
    if (request.method === 'PUT') {
      if (!config) fail('google_upgrade_required', 409);
      const body = await readBoundedJson(request);
      if (Object.keys(body).some(k => !['enabled','clientId','clientSecret','callbackOrigin','revision'].includes(k))
        || typeof body.enabled !== 'boolean' || !Number.isSafeInteger(body.revision) || body.revision < 0
        || typeof body.clientId !== 'string' || body.clientId.length > 255 || (body.clientId !== '' && !/^[A-Za-z0-9_.-]{1,255}\.apps\.googleusercontent\.com$/.test(body.clientId))
        || typeof body.clientSecret !== 'string' || body.clientSecret.length > 512 || /\s/.test(body.clientSecret)) fail('invalid_input');
      const origin = originFor(body.callbackOrigin);
      let encrypted = config.encrypted_secret, iv = config.secret_iv;
      if (body.clientSecret) {
        const bytes = crypto.getRandomValues(new Uint8Array(12)); iv = encode(bytes);
        encrypted = encode(new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: bytes }, await key(env), encoder.encode(body.clientSecret))));
      } else if (body.clientId !== config.client_id) fail('google_secret_required');
      if (body.enabled && (!body.clientId || !encrypted || !await secretFor({ encrypted_secret: encrypted, secret_iv: iv }, env))) fail('google_secret_required');
      const results = await env.DB.batch([
        stmt(env.DB, `UPDATE google_login_config SET enabled=?,client_id=?,callback_origin=?,encrypted_secret=?,secret_iv=?,revision=revision+1
        WHERE id=1 AND revision=? AND EXISTS (SELECT 1 FROM accounts a JOIN account_credentials c ON c.account_id=a.account_id
          JOIN account_sessions s ON s.account_id=a.account_id WHERE a.account_id=? AND a.role='admin' AND a.status='active'
          AND c.must_change_password=0 AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?)`,
        body.enabled ? 1 : 0, body.clientId, origin, encrypted, iv, body.revision, session.account.accountId, session.tokenHash, Date.now()),
        stmt(env.DB, `INSERT INTO audit_events (id,actor_account_id,action,target_type,target_id,result,created_at)
          SELECT ?,?,'google.configure','setting','google_login_config','success',? WHERE changes()=1`,
        crypto.randomUUID(), session.account.accountId, Date.now()),
      ]);
      if (results[0]?.meta?.changes !== 1) fail('configuration_changed', 409);
      return json(await publicConfig(await readConfig(env), env));
    }
  }
  return json({ error: 'not_found' }, 404);
}
