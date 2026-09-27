import { setupSecretMatches } from '../auth/local/crypto.js';

const encoder = new TextEncoder();
const PROOF_MS = 10 * 60 * 1000;
const ATTEMPT_MS = 15 * 60 * 1000;
const attempts = new Map();
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromBase64 = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')),
  (char) => char.charCodeAt(0));

async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) return null;
  return crypto.subtle.importKey('raw', encoder.encode(`FlareTune setup proof v1:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Verification cannot write to a new D1. This isolate-local limiter is a
// secondary throttle; the high-entropy secret is the primary protection.
export function consumeSetupVerificationAttempt(request, now = Date.now()) {
  if (attempts.size > 4096) {
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    if (attempts.size > 4096) attempts.clear();
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = ip.length <= 45 && !ip.includes(',') ? ip : 'unknown';
  const entry = attempts.get(key);
  const next = entry && entry.until > now ? entry : { count: 0, until: now + ATTEMPT_MS };
  next.count += 1;
  attempts.set(key, next);
  return { allowed: next.count <= (key === 'unknown' ? 3 : 5),
    retryAfterSeconds: Math.max(1, Math.ceil((next.until - now) / 1000)) };
}

export async function issuePurposeProof(secret, supplied, origin, purpose, now = Date.now()) {
  const key = await signingKey(secret);
  if (!key || !await setupSecretMatches(secret, supplied)) return null;
  if (typeof origin !== 'string' || !origin || !['setup', 'maintenance'].includes(purpose)
    || !Number.isSafeInteger(now)) return null;
  const payload = toBase64(encoder.encode(JSON.stringify({
    purpose, origin, issued: now, nonce: toBase64(crypto.getRandomValues(new Uint8Array(16))),
  })));
  const signature = toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
  return `${payload}.${signature}`;
}

export async function verifyPurposeProof(secret, proof, origin, purpose, now = Date.now()) {
  const key = await signingKey(secret);
  if (!key || typeof proof !== 'string' || proof.length > 1024 || !Number.isSafeInteger(now)) return false;
  const parts = proof.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const valid = await crypto.subtle.verify('HMAC', key, fromBase64(parts[1]), encoder.encode(parts[0]));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64(parts[0])));
    return payload.purpose === purpose && payload.origin === origin
      && Number.isSafeInteger(payload.issued) && payload.issued <= now
      && now - payload.issued <= PROOF_MS
      && typeof payload.nonce === 'string' && /^[A-Za-z0-9_-]{22}$/.test(payload.nonce);
  } catch {
    return false;
  }
}

export const issueSetupProof = (secret, supplied, origin, now) => issuePurposeProof(secret, supplied, origin, 'setup', now);
export const verifySetupProof = (secret, proof, origin, now) => verifyPurposeProof(secret, proof, origin, 'setup', now);
