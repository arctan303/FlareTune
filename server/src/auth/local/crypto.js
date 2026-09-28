import {
  isUsableCredentialMaterial,
  PASSWORD_KDF,
  PASSWORD_KDF_MIN_ITERATIONS,
  PASSWORD_KDF_ROUNDS,
  PASSWORD_KDF_VERSION,
} from '../../instance/credentialFormat.js';

const encoder = new TextEncoder();
const MAX_PASSWORD_BYTES = 1024;
const MIN_PASSWORD_CODE_POINTS = 8;
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const bytesToBase64Url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlToBytes = (value) => Uint8Array.from(
  atob(value.replace(/-/g, '+').replace(/_/g, '/')),
  (char) => char.charCodeAt(0),
);

const constantTimeBytesEqual = (left, right) => {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
};

export function validatePassword(password) {
  if (typeof password !== 'string') return false;
  const bytes = encoder.encode(password);
  return [...password].length >= MIN_PASSWORD_CODE_POINTS && bytes.length <= MAX_PASSWORD_BYTES;
}

export function normalizeUsername(username) {
  if (typeof username !== 'string') return null;
  const normalized = username.toLowerCase();
  return /^[a-z0-9_.-]{3,64}$/.test(normalized) ? normalized : null;
}

async function derivePassword(password, salt, iterations, rounds) {
  // Workers limits each PBKDF2 invocation to 100,000 iterations. Every round
  // derives a new input and uses a separately domain-separated salt.
  const domain = encoder.encode('FlareTune password KDF v2');
  const roundSalt = new Uint8Array(domain.length + salt.length + 1);
  roundSalt.set(domain);
  roundSalt.set(salt, domain.length);
  let material = encoder.encode(password);
  for (let round = 0; round < rounds; round += 1) {
    roundSalt[roundSalt.length - 1] = round;
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    material = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', salt: roundSalt, iterations,
    }, key, 256));
  }
  return material;
}

export async function hashPassword(password) {
  if (!validatePassword(password)) throw new TypeError('Invalid password');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, PASSWORD_KDF_MIN_ITERATIONS, PASSWORD_KDF_ROUNDS);
  return {
    kdf: PASSWORD_KDF,
    kdf_version: PASSWORD_KDF_VERSION,
    kdf_params_json: JSON.stringify({ iterations: PASSWORD_KDF_MIN_ITERATIONS, rounds: PASSWORD_KDF_ROUNDS }),
    salt: bytesToBase64Url(salt),
    password_hash: bytesToBase64Url(hash),
  };
}

export async function verifyPassword(password, material) {
  const usable = isUsableCredentialMaterial(material);
  const candidate = usable ? material : {
    kdf: PASSWORD_KDF,
    kdf_version: PASSWORD_KDF_VERSION,
    kdf_params_json: JSON.stringify({ iterations: PASSWORD_KDF_MIN_ITERATIONS, rounds: PASSWORD_KDF_ROUNDS }),
    salt: DUMMY_SALT,
    password_hash: DUMMY_HASH,
  };
  // Unknown users and damaged credentials still pay the normal KDF cost.
  const input = typeof password === 'string' && encoder.encode(password).length <= MAX_PASSWORD_BYTES ? password : '';
  const { iterations, rounds } = JSON.parse(candidate.kdf_params_json);
  const actual = await derivePassword(input, base64UrlToBytes(candidate.salt), iterations, rounds);
  return usable && typeof password === 'string'
    && constantTimeBytesEqual(actual, base64UrlToBytes(candidate.password_hash));
}

export async function setupSecretMatches(configured, submitted) {
  if (typeof configured !== 'string' || configured.length < 32 || typeof submitted !== 'string') return false;
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(configured)),
    crypto.subtle.digest('SHA-256', encoder.encode(submitted)),
  ]);
  return constantTimeBytesEqual(new Uint8Array(left), new Uint8Array(right));
}

export function randomSessionToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function tokenDigest(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`FlareTune session v1:${token}`));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function csrfTokenForSession(token) {
  const digest = await tokenDigest(token);
  if (!digest) return null;
  const csrf = await crypto.subtle.digest('SHA-256', encoder.encode(`FlareTune csrf v1:${token}`));
  return bytesToBase64Url(new Uint8Array(csrf));
}

export async function verifyCsrfToken(token, submitted) {
  const expected = await csrfTokenForSession(token);
  if (!expected || typeof submitted !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(submitted)) return false;
  return constantTimeBytesEqual(encoder.encode(expected), encoder.encode(submitted));
}
