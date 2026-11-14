import { pluginRegistry, installationKey } from './registry.js';
import { pluginFail } from './common.js';
import { createPluginOperationLease, isPluginServiceLeaseForSession } from './services.js';
import { isSubsonicPluginServiceLeaseForPrincipal } from '../subsonic/pluginAuthority.js';
import { pluginTablePrefix } from './migrations.js';
import { registerDatabaseWrapper } from '../services/databaseIdentity.js';

const mutations = new WeakMap(), guards = new WeakMap(), configurationAssertions = new WeakMap();
// Internal provenance only: public SDK callers can receive an assertion, but
// cannot label an arbitrary function as a stronger gate for a service lease.
export const isServiceConfigurationAssertionForLease = (assertion, lease) =>
  typeof assertion === 'function' && Boolean(lease) && configurationAssertions.get(assertion) === lease;
const rawStatement = Symbol('serviceConfigStatement');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(value);
const scalar = value => value === null || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.length <= 16384;
const revisionValue = value => Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value + 1);
const changed = () => pluginFail('PLUGIN_SERVICE_CONFIGURATION_CHANGED', 409);
const ownerKey = (consumer, slot) => `plugin.data.${consumer}.instance.${slot}`;
const useKey = (provider, consumer, slot) => `plugin.service-use.${provider}.${consumer}.${slot}`;
const escapeSql = id => `"${id}"`;

function normalize(request) {
  return { ...request, context: request.context || request.consumerContext, registry: request.registry || pluginRegistry };
}
function authority(request) {
  const r = normalize(request), lease = r.serviceLease;
  const normal = isPluginServiceLeaseForSession(lease, r.session, r.env?.DB, r.registry);
  const subsonic = !normal && isSubsonicPluginServiceLeaseForPrincipal(lease, r.principal, r.env, r.registry);
  if ((!normal && !subsonic) || lease.consumer.id !== r.consumerId) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  if (r.context && (r.context.plugin?.id !== r.consumerId || r.context.plugin.epoch !== lease.consumer.epoch
    || r.context.identity?.accountId !== lease.identity.accountId)) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  return { ...r, lease, providerId: lease.provider.id, subsonic };
}
function checkSlot(a, slot) {
  const manifest = a.registry.manifests.find(item => item.id === a.consumerId);
  if (!manifest?.serviceConfigurations?.[a.providerId]?.includes(slot)) pluginFail('PLUGIN_SERVICE_CONFIG_UNDECLARED', 403);
  return ownerKey(a.consumerId, slot);
}
function sameAuthority(a, b) {
  return a.lease === b.lease && a.env.DB === b.env.DB && a.registry === b.registry
    && a.consumerId === b.consumerId && a.providerId === b.providerId;
}
async function adminLease(a) {
  if (a.subsonic || a.lease.identity.role !== 'admin') pluginFail('forbidden', 403);
  return createPluginOperationLease({ ...a, pluginId: a.consumerId, admin: true });
}
async function resolveAuthority(request) {
  let r = normalize(request);
  if (!r.serviceLease) {
    // Settings access without a service lease is an administrator operation.
    const admin = await createPluginOperationLease({ ...r, pluginId: r.consumerId, admin: true });
    const providers = Object.keys(r.registry.manifests.find(item => item.id === r.consumerId)?.serviceConfigurations || {});
    if (providers.length !== 1) pluginFail('PLUGIN_SERVICE_CONFIG_UNDECLARED', 403);
    return { ...r, lease: admin, providerId: providers[0], readOnly: true };
  }
  return authority(r);
}
function guardedDatabase(base, predicates) {
  // D1 caps each statement at 100 bindings, including statements in batch.
  const groups = [[]]; let bindings = 0;
  for (const predicate of predicates) {
    if (predicate.values.length > 90) pluginFail('invalid_input', 400);
    if (bindings + predicate.values.length > 90) { groups.push([]); bindings = 0; }
    groups.at(-1).push(predicate); bindings += predicate.values.length;
  }
  const makeGuards = () => groups.map(group => base.prepare(`SELECT CASE WHEN ${group.map(p => `(${p.sql})`).join(' AND ') || '1'}
    THEN 1 ELSE json('service_configuration_changed') END AS service_configuration_guard`)
    .bind(...group.flatMap(p => p.values)));
  const batch = async statements => {
    const before = makeGuards(), after = makeGuards();
    const result = await base.batch([...before, ...statements.map(s => s[rawStatement] || s), ...after]);
    return result.slice(before.length, -after.length);
  };
  return registerDatabaseWrapper(Object.freeze({ prepare(sql) {
    let statement = base.prepare(sql);
    const wrapped = { get [rawStatement]() { return statement; },
      bind(...values) { statement = statement.bind(...values); return wrapped; },
      first: async column => { const result = (await batch([wrapped]))[0], row = result?.results?.[0] ?? null; return column ? row?.[column] ?? null : row; },
      all: async () => (await batch([wrapped]))[0], run: async () => (await batch([wrapped]))[0] };
    return wrapped;
  }, batch }), base);
}
const configPredicate = (key, revision) => ({ sql: 'COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?', values: [key, revision] });
function guardData(a, guard) {
  if (guard === undefined || guard === null) return [];
  const record = guards.get(guard);
  if (!record || !sameAuthority(a, record.authority)) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  return record.predicates;
}

export async function createServiceConfigStore(request) {
  const a = await resolveAuthority(request);
  return Object.freeze({
    async read(slot = 'ai-model') {
      const key = checkSlot(a, slot);
      const row = await a.lease.guardedDb().prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(key).first();
      if (!row) return { value: null, revision: 0 };
      try { return { value: JSON.parse(row.value_json), revision: Number(row.revision) }; }
      catch { pluginFail('PLUGIN_DATA_CORRUPT', 503); }
    },
    async prepare({ slot = 'ai-model', value, expectedRevision }) {
      if (a.readOnly) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
      const key = checkSlot(a, slot);
      if (!revisionValue(expectedRevision)) pluginFail('invalid_input', 400);
      let serialized;
      try { serialized = JSON.stringify(value); } catch { pluginFail('invalid_input', 400); }
      if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > 16384) pluginFail('invalid_input', 400);
      await adminLease(a);
      const token = Object.freeze({});
      mutations.set(token, { authority: a, slot, key, serialized, expectedRevision });
      return token;
    },
  });
}

export function createServiceConfigGuard(request, { constraints = [] } = {}) {
  const a = authority(request);
  if (!Array.isArray(constraints) || constraints.length > 32) pluginFail('invalid_input', 400);
  const predicates = constraints.map(constraint => {
    if (!plain(constraint) || !identifier(constraint.table) || !plain(constraint.where)
      || !Object.keys(constraint.where).length || Object.keys(constraint.where).length > 16
      || !(constraint.expected === null || plain(constraint.expected))) pluginFail('invalid_input', 400);
    const { table, where, expected } = constraint;
    const legacy = a.providerId === 'ai-gateway' && ['ai_model_profiles','ai_profile_protocols','ai_feature_assignments','ai_feature_models'].includes(table);
    const legacySetting = a.providerId === 'ai-gateway' && table === 'instance_settings'
      && Object.keys(where).length === 1 && typeof where.key === 'string'
      && (where.key === 'ai.compatible_api_url' || /^ai\.images\.[0-9a-f-]{36}$/i.test(where.key))
      && (expected === null || Object.keys(expected).every(key => ['value_json','revision'].includes(key)));
    const consumerLegacy = a.providerId === 'ai-gateway' && Object.keys(where).length === 1 && (
      a.consumerId === 'assistant' && table === 'music_assistant_configs' && where.id === 'xiaoa'
      || a.consumerId === 'lyrics-workbench' && (table === 'AI_Assistants' && where.id === 'lyric_translator'
        || table === 'instance_settings' && where.key === 'lyrics.ai'
          && (expected === null || Object.keys(expected).every(key => ['value_json','revision'].includes(key)))));
    if (!table.startsWith(pluginTablePrefix(a.providerId)) && !table.startsWith(pluginTablePrefix(a.consumerId))
      && !legacy && !legacySetting && !consumerLegacy) pluginFail('PLUGIN_SERVICE_CONFIG_SCOPE', 403);
    const fields = [...Object.entries(where), ...Object.entries(expected || {})];
    if (fields.length > 32 || fields.some(([column, value]) => !identifier(column) || !scalar(value))) pluginFail('invalid_input', 400);
    const whereSql = Object.keys(where).map(column => `${escapeSql(column)} IS ?`).join(' AND ');
    const expectedSql = Object.keys(expected || {}).map(column => `${escapeSql(column)} IS ?`).join(' AND ');
    return { sql: `${expected === null ? 'NOT ' : ''}EXISTS(SELECT 1 FROM ${escapeSql(table)} WHERE ${whereSql}${expectedSql ? ` AND ${expectedSql}` : ''})`,
      values: fields.map(([, value]) => typeof value === 'boolean' ? Number(value) : value) };
  });
  const token = Object.freeze({}); guards.set(token, { authority: a, predicates }); return token;
}

export async function commitServiceConfiguration(request, { mutation, guard, resourceId }) {
  const a = authority(request), prepared = mutations.get(mutation);
  if (!prepared || !sameAuthority(a, prepared.authority)) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  if (!(resourceId === null || typeof resourceId === 'string' && resourceId.length > 0 && resourceId.length <= 256)) pluginFail('invalid_input', 400);
  const operation = await adminLease(a), { key, slot, serialized, expectedRevision } = prepared;
  const now = Date.now(), next = expectedRevision + 1;
  const value = { consumerId: a.consumerId, slot, configKey: key, configRevision: next, resourceId };
  // Revision CAS is guarded before the write. It intentionally changes after
  // the owner update, so the final guard uses source/resource snapshots only.
  const base = operation.guardedDb(a.lease.guardedDb());
  const sourceDb = guardedDatabase(base, guardData(a, guard));
  const targetGuard = sourceDb.prepare(`SELECT CASE WHEN COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
    THEN 1 ELSE json('service_configuration_changed') END`).bind(key, expectedRevision);
  const put = (target, content, revision) => sourceDb.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,
    updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(target, content, revision, now, a.lease.identity.accountId);
  try {
    await sourceDb.batch([targetGuard, put(key, serialized, next),
      sourceDb.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('service_configuration_changed') END"),
      put(useKey(a.providerId, a.consumerId, slot), JSON.stringify(value), next)]);
  } catch (error) {
    await operation.assertCurrent(); await a.lease.assertCurrent();
    if (/malformed JSON|service_configuration_changed/i.test(error.message || '')) changed();
    throw error;
  }
  mutations.delete(mutation);
  return { value: JSON.parse(serialized), revision: next };
}

export function bindServiceConfiguration(request, { slot = 'ai-model', revision, guard }) {
  const a = authority(request), key = checkSlot(a, slot);
  if (!revisionValue(revision) || revision === 0) pluginFail('invalid_input', 400);
  const predicates = [configPredicate(key, revision), ...guardData(a, guard)];
  const dbs = new WeakMap();
  const guardedDb = (db = a.env.DB) => {
    if (!dbs.has(db)) dbs.set(db, guardedDatabase(a.lease.guardedDb(db), predicates));
    return dbs.get(db);
  };
  const assertCurrent = async () => {
    try { await guardedDb().prepare('SELECT 1').first(); }
    catch (error) {
      if (/malformed JSON|service_configuration_changed/i.test(error.message || '')) {
        await a.lease.assertCurrent(); changed();
      }
      throw error;
    }
  };
  configurationAssertions.set(assertCurrent, a.lease);
  return Object.freeze({ guardedDb, assertCurrent });
}

function resourceEntries(registry, providerId) {
  return registry.manifests.flatMap(manifest => (manifest.serviceConfigurations?.[providerId] || []).map(slot => ({
    consumerId: manifest.id, name: manifest.name, slot, configKey: ownerKey(manifest.id, slot),
    key: useKey(providerId, manifest.id, slot), installation: installationKey(manifest.id),
  })));
}
function usagePredicate(entry, resourceId) {
  return { sql: `EXISTS(SELECT 1 FROM instance_settings service_use JOIN instance_settings config ON config.key=?
    JOIN instance_settings installed ON installed.key=? WHERE service_use.key=?
      AND json_extract(installed.value_json,'$.installed')=1
      AND json_extract(service_use.value_json,'$.consumerId')=? AND json_extract(service_use.value_json,'$.slot')=?
      AND json_extract(service_use.value_json,'$.configKey')=?
      AND json_extract(service_use.value_json,'$.configRevision')=config.revision
      AND json_extract(service_use.value_json,'$.resourceId')=?)`,
  values: [entry.configKey, entry.installation, entry.key, entry.consumerId, entry.slot, entry.configKey, resourceId] };
}
async function providerAuthority(request) {
  const r = normalize(request);
  if (!r.providerId || r.context?.plugin?.id !== r.providerId
    || typeof r.resourceId !== 'string' || !r.resourceId.length || r.resourceId.length > 256) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  return { ...r, operation: await createPluginOperationLease({ ...r, pluginId: r.providerId, admin: true }) };
}
export async function listServiceResourceUses(request) {
  const a = await providerAuthority(request), db = a.operation.guardedDb();
  const entries = resourceEntries(a.registry, a.providerId);
  if (!entries.length) return [];
  const results = await db.batch(entries.map(entry => {
    const predicate = usagePredicate(entry, a.resourceId);
    return db.prepare(`SELECT revision FROM instance_settings WHERE key=? AND ${predicate.sql}`).bind(entry.configKey, ...predicate.values);
  }));
  return entries.flatMap((entry, i) => results[i]?.results?.length
    ? [{ consumerId: entry.consumerId, name: entry.name, slot: entry.slot, revision: Number(results[i].results[0].revision) }] : []);
}
export async function createServiceResourceDeletionStore(request) {
  const a = await providerAuthority(request), entries = resourceEntries(a.registry, a.providerId);
  const used = entries.map(entry => usagePredicate(entry, a.resourceId));
  const db = guardedDatabase(a.operation.guardedDb(), used.map(predicate => ({ sql: `NOT (${predicate.sql})`, values: predicate.values })));
  return Object.freeze({ prepare: db.prepare, batch: db.batch, guardedDb: () => db,
    assertCurrent: async () => { await db.prepare('SELECT 1').first(); } });
}
