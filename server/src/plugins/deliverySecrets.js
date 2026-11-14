import { pluginFail } from './common.js';

const encoder = new TextEncoder();
const domain = encoder.encode('FlareTune plugin delivery credentials v1');
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

async function key(env) {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) pluginFail('PLUGIN_DELIVERY_SECRET_UNAVAILABLE', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.SETUP_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: domain, info: domain }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealDeliverySecrets(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: domain }, await key(env), encoder.encode(JSON.stringify(value)));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function openDeliverySecrets(env, value) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid');
    const [iv, cipher] = value.split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: domain }, await key(env), decode(cipher));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch { pluginFail('PLUGIN_DELIVERY_SECRET_UNAVAILABLE', 503); }
}
