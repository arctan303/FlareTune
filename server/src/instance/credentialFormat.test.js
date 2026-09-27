import assert from 'node:assert/strict';
import test from 'node:test';
import { isUsableCredentialMaterial, PASSWORD_KDF, PASSWORD_KDF_MIN_ITERATIONS, PASSWORD_KDF_ROUNDS, PASSWORD_KDF_VERSION } from './credentialFormat.js';

const material = {
  kdf: PASSWORD_KDF,
  kdf_version: PASSWORD_KDF_VERSION,
  kdf_params_json: JSON.stringify({ iterations: PASSWORD_KDF_MIN_ITERATIONS, rounds: PASSWORD_KDF_ROUNDS }),
  salt: Buffer.alloc(16, 1).toString('base64url'),
  password_hash: Buffer.alloc(32, 2).toString('base64url'),
};

test('readiness accepts only a credential format the local verifier can support', () => {
  assert.equal(isUsableCredentialMaterial(material), true);
  for (const bad of [
    { kdf: 'unknown' },
    { kdf_version: 1 },
    { kdf_params_json: '{"iterations":1}' },
    { kdf_params_json: '{"iterations":100000,"rounds":5}' },
    { kdf_params_json: '{"iterations":100001,"rounds":6}' },
    { kdf_params_json: 'not-json' },
    { salt: '' },
    { salt: 'A'.repeat(22) + '!' },
    { password_hash: 'a' },
  ]) assert.equal(isUsableCredentialMaterial({ ...material, ...bad }), false);
});
