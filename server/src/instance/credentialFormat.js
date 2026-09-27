// This format is shared by instance readiness and the local password verifier.
// Future KDF versions must add an explicit verifier before they can count as usable.
export const PASSWORD_KDF = 'pbkdf2-sha256-chain';
export const PASSWORD_KDF_VERSION = 2;
export const PASSWORD_KDF_MIN_ITERATIONS = 100_000;
export const PASSWORD_KDF_ROUNDS = 6;

const base64UrlBytes = (value, expectedLength) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return bytes.length === expectedLength;
  } catch {
    return false;
  }
};

export function isUsableCredentialMaterial(row) {
  if (row?.kdf !== PASSWORD_KDF || row.kdf_version !== PASSWORD_KDF_VERSION
    || !base64UrlBytes(row.salt, 16) || !base64UrlBytes(row.password_hash, 32)) return false;
  try {
    const params = JSON.parse(row.kdf_params_json);
    return params?.iterations === PASSWORD_KDF_MIN_ITERATIONS
      && params?.rounds === PASSWORD_KDF_ROUNDS;
  } catch {
    return false;
  }
}
