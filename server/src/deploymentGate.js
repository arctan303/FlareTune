const encoder = new TextEncoder();

export async function deploymentGateAllows(request, env) {
  if (env?.MIGRATION_GATE_ACTIVE !== 'true') return true;
  const expected = env?.MIGRATION_GATE_SECRET;
  const supplied = request.headers.get('X-FlareTune-Migration-Gate');
  if (typeof expected !== 'string' || expected.length < 32 || typeof supplied !== 'string' || supplied.length > 512) {
    return false;
  }
  const [left, right] = await Promise.all([expected, supplied].map(async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))));
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}
