import { InstanceAdminError, atomic, changed, currentTime, requireActiveAdmin, statement, validateRevision } from './common.js';

function validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function exactHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && parsed.pathname === '/' && parsed.origin === value;
  } catch { return false; }
}
export const DEFAULT_SETTINGS = Object.freeze({ 'instance.name': 'FlareTune', 'cors.allowed_origins': [] });
export function validateSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new InstanceAdminError('unknown_setting', 400);
  if (key === 'instance.name' && validText(value, 80)) return value.trim();
  if (key === 'cors.allowed_origins' && Array.isArray(value) && value.length <= 32
    && value.every(exactHttpsOrigin) && new Set(value).size === value.length) return value;
  throw new InstanceAdminError('invalid_setting', 400);
}
const definitions = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => [key,
  Object.freeze({ defaultValue: fallback, validate: value => validateSetting(key, value) })]));

// Definitions belong to the caller. The host owns storage, live admin checks,
// revisions and audit transactions; optional feature policy stays in its pack.
export async function readDefinedSettings(db, actorAccountId, definitions) {
  await requireActiveAdmin(db, actorAccountId);
  const keys = Object.keys(definitions);
  const settings = Object.fromEntries(keys.map(key => [key, { value: definitions[key].defaultValue, revision: 0 }]));
  if (!keys.length) return settings;
  const rows = await db.prepare(`SELECT key, value_json, revision FROM instance_settings WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  for (const row of rows?.results ?? []) {
    if (!Object.hasOwn(definitions, row.key)) continue;
    try { settings[row.key] = { value: (definitions[row.key].read || definitions[row.key].validate)(JSON.parse(row.value_json)), revision: row.revision }; }
    catch { throw new InstanceAdminError('setting_corrupt', 503); }
  }
  return settings;
}

export async function updateDefinedSetting(db, actorAccountId, key, value, expectedRevision, definition, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision, { allowZero: true });
  if (!definition || typeof definition.validate !== 'function') throw new InstanceAdminError('unknown_setting', 400);
  const safeValue = definition.validate(value);
  if (definition.validatePrevious && expectedRevision > 0) {
    const row = await db.prepare('SELECT value_json, revision FROM instance_settings WHERE key = ?').bind(key).first();
    if (!row || row.revision !== expectedRevision) throw new InstanceAdminError('revision_conflict', 409);
    let previous;
    try { previous = (definition.read || definition.validate)(JSON.parse(row.value_json)); }
    catch { throw new InstanceAdminError('setting_corrupt', 503); }
    definition.validatePrevious(safeValue, previous);
  }
  currentTime(now);
  const json = JSON.stringify(safeValue);
  const mutation = expectedRevision === 0
    ? statement(db, `INSERT INTO instance_settings (key, value_json, revision, updated_at, updated_by)
        SELECT ?, ?, 1, ?, ? WHERE EXISTS
          (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
        ON CONFLICT(key) DO NOTHING`, key, json, now, actor.account_id, actor.account_id)
    : statement(db, `UPDATE instance_settings SET value_json = ?, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE key = ? AND revision = ?
        AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    json, now, actor.account_id, key, expectedRevision, actor.account_id);
  const [result] = await atomic(db, [mutation,
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'setting.update', 'setting', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, key, now)]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { key, value: safeValue, revision: expectedRevision + 1 };
}
export async function getAdminSettings(db, actorAccountId, { aiApiKeyConfigured = null } = {}) {
  return { settings: await readDefinedSettings(db, actorAccountId, definitions), defaults: {}, secrets: { aiApiKeyConfigured } };
}
export const updateAdminSetting = (db, actorAccountId, key, value, expectedRevision, now) =>
  updateDefinedSetting(db, actorAccountId, key, value, expectedRevision, definitions[key], now);
