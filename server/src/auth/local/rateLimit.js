import { normalizeUsername } from './crypto.js';

const WINDOW_MS = 15 * 60 * 1000;
const AUTH_ATTEMPT_ACTIONS = ['auth.attempt.setup', 'auth.attempt.login'];
const POLICIES = {
  setup: { perIp: 5, perUsername: null },
  login: { perIp: 10, perUsername: 8 },
};
const encoder = new TextEncoder();

export class RateLimitError extends Error {
  constructor() {
    super('service_unavailable');
    this.name = 'RateLimitError';
    this.code = 'service_unavailable';
    this.status = 503;
  }
}

const sha256 = async (value) => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

function clientIp(request) {
  // Never trust X-Forwarded-For or X-Real-IP as a fallback. Direct incoming
  // Cloudflare requests set CF-Connecting-IP; absent/invalid means one shared
  // conservative bucket for this auth endpoint.
  const raw = request?.headers?.get?.('CF-Connecting-IP')?.trim().toLowerCase();
  if (!raw || raw.length > 45 || raw.includes(',')) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    const octets = raw.split('.');
    return octets.every((octet) => Number(octet) <= 255)
      ? octets.map((octet) => String(Number(octet))).join('.') : null;
  }
  if (raw.includes(':') && /^[0-9a-f:]+$/.test(raw)) {
    const halves = raw.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const groups = [...left, ...right];
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
    if (halves.length === 1 && groups.length !== 8) return null;
    if (halves.length === 2 && groups.length >= 8) return null;
    const expanded = halves.length === 2
      ? [...left, ...Array(8 - groups.length).fill('0'), ...right] : groups;
    return expanded.map((group) => parseInt(group, 16).toString(16).padStart(4, '0')).join(':');
  }
  return null;
}

const firstRow = (result) => result?.results?.[0] ?? null;

export async function consumeAuthAttempt({ db, request, kind, username, now = Date.now() }) {
  const policy = POLICIES[kind];
  if (!policy || !Number.isSafeInteger(now) || now <= 0) throw new TypeError('Invalid rate-limit parameters');
  if (!db?.prepare || !db?.batch) throw new RateLimitError();

  const action = `auth.attempt.${kind}`;
  const ip = clientIp(request);
  const ipBucket = await sha256(`FlareTune auth limiter v1\0${kind}\0ip\0${ip ?? 'unknown'}`);
  const canonical = kind === 'login' ? normalizeUsername(username) : null;
  const usernameBucket = canonical
    ? await sha256(`FlareTune auth limiter v1\0login\0username\0${canonical}`) : null;
  const ipLimit = ip ? policy.perIp : Math.min(3, policy.perIp);
  const accountLimit = usernameBucket ? policy.perUsername : Number.MAX_SAFE_INTEGER;
  const cutoff = now - WINDOW_MS;

  try {
    // D1 batch is one transaction. A conditional insert caps stored attempts
    // per bucket, while the following read gives the reset time without a race.
    const results = await db.batch([
      db.prepare(`DELETE FROM audit_events
        WHERE action IN (?, ?) AND created_at <= ?`)
        .bind(...AUTH_ATTEMPT_ACTIONS, cutoff),
      db.prepare(`INSERT INTO audit_events
        (id, actor_account_id, action, target_type, target_id, result, detail_code, created_at)
        SELECT ?, NULL, ?, 'auth_rate_bucket', ?, 'success', ?, ?
        WHERE (SELECT COUNT(*) FROM audit_events
          WHERE action = ? AND target_id = ? AND created_at > ?) < ?
          AND (SELECT COUNT(*) FROM audit_events
            WHERE action = ? AND detail_code = ? AND created_at > ?) < ?`)
        .bind(crypto.randomUUID(), action, ipBucket, usernameBucket, now,
          action, ipBucket, cutoff, ipLimit,
          action, usernameBucket, cutoff, accountLimit),
      db.prepare(`SELECT
          (SELECT MIN(created_at) FROM audit_events
            WHERE action = ? AND target_id = ? AND created_at > ?) AS ip_first,
          (SELECT COUNT(*) FROM audit_events
            WHERE action = ? AND target_id = ? AND created_at > ?) AS ip_count,
          (SELECT MIN(created_at) FROM audit_events
            WHERE action = ? AND detail_code = ? AND created_at > ?) AS username_first,
          (SELECT COUNT(*) FROM audit_events
            WHERE action = ? AND detail_code = ? AND created_at > ?) AS username_count`)
        .bind(action, ipBucket, cutoff, action, ipBucket, cutoff,
          action, usernameBucket, cutoff, action, usernameBucket, cutoff),
    ]);
    if (!Array.isArray(results) || results.length !== 3
      || !Number.isSafeInteger(results[1]?.meta?.changes)
      || !firstRow(results[2])) throw new RateLimitError();
    if (results[1].meta.changes === 1) return { allowed: true, status: 200, retryAfterSeconds: 0 };
    const counts = firstRow(results[2]);
    const blockedUntil = Math.max(
      counts.ip_count >= ipLimit && Number.isSafeInteger(counts.ip_first) ? counts.ip_first + WINDOW_MS : now,
      usernameBucket && counts.username_count >= accountLimit && Number.isSafeInteger(counts.username_first)
        ? counts.username_first + WINDOW_MS : now,
    );
    return { allowed: false, status: 429,
      retryAfterSeconds: Math.max(1, Math.min(Math.ceil((blockedUntil - now) / 1000), WINDOW_MS / 1000)) };
  } catch {
    throw new RateLimitError();
  }
}
