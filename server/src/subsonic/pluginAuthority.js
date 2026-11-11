import { subsonicAuthorityForPrincipal } from './credentials.js';
import { pluginRegistry, installationKey } from '../plugins/registry.js';
import { pluginFail } from '../plugins/common.js';
import { isPluginVisibleToRole, satisfiesPluginVersion } from '../../../shared/plugins/manifest.js';
import { databaseIdentity, registerDatabaseWrapper } from '../services/databaseIdentity.js';

const leases = new WeakMap();
const leaseOwners = new WeakMap();
export const isSubsonicPluginServiceLeaseForPrincipal = (lease, principal, env, registry = pluginRegistry) => {
  const owner = leaseOwners.get(lease);
  if (!owner || owner.principal !== principal || owner.database !== env?.DB || owner.registry !== registry) return false;
  subsonicAuthorityForPrincipal(principal, env);
  return true;
};
const rawStatement = Symbol('subsonicPluginStatement');
const guardedOwner = Symbol('subsonicPluginOwner');

// A fixed internal bridge for playback lyric AI. It grants neither browser
// sessions nor administrator/configuration APIs, and never accepts account IDs.
export async function createSubsonicPluginServiceLease({ env, principal, consumerId, providerId,
  registry = pluginRegistry }) {
  if (consumerId !== 'lyrics-workbench' || providerId !== 'ai-gateway') pluginFail('PLUGIN_SERVICE_FEATURE_FORBIDDEN', 403);
  const authority = subsonicAuthorityForPrincipal(principal, env);
  const cached = leases.get(principal)?.get(registry);
  if (cached) { await cached.assertCurrent(); return cached; }
  const consumer = registry.manifests.find(item => item.id === consumerId);
  const provider = registry.manifests.find(item => item.id === providerId);
  const declaration = consumer?.dependencies?.[providerId] || consumer?.optionalDependencies?.[providerId];
  if (!consumer || !provider || !declaration || !isPluginVisibleToRole(consumer, authority.identity.role)) pluginFail('PLUGIN_SERVICE_UNDECLARED', 403);
  if (declaration.apiVersion !== provider.apiVersion
    || declaration.version && !satisfiesPluginVersion(provider.version, declaration.version)) pluginFail('PLUGIN_SERVICE_INCOMPATIBLE', 409);
  const installations = registry.requirePluginsInstalled
    ? new Map([...(await registry.requirePluginsInstalled(env, [consumerId, providerId]))].map(([id, installed]) => [id, installed.epoch]))
    : new Map();
  const visit = async id => {
    if (installations.has(id)) return;
    const installed = await registry.requirePluginInstalled(env, id);
    installations.set(id, installed.epoch);
    const manifest = registry.manifests.find(item => item.id === id);
    for (const dependency of Object.keys(manifest.dependencies || {})) await visit(dependency);
  };
  if (!registry.requirePluginsInstalled) { await visit(consumerId); await visit(providerId); }
  const epochPredicate = [...installations].map(() => `EXISTS(SELECT 1 FROM instance_settings
    WHERE key=? AND json_extract(value_json,'$.installed')=1 AND json_extract(value_json,'$.epoch')=?)`).join(' AND ');
  const epochs = [...installations].flatMap(([id, epoch]) => [installationKey(id), epoch]);
  const predicate = `${authority.predicate} AND ${epochPredicate}`;
  const bindings = () => [...authority.bindings(), ...epochs];
  const owner = {}, databases = new WeakMap();
  const assertCurrent = async () => {
    subsonicAuthorityForPrincipal(principal, env);
    const row = await env.DB.prepare(`SELECT 1 AS allowed WHERE ${predicate}`).bind(...bindings()).first();
    if (!row) pluginFail('PLUGIN_SERVICE_RETIRED', 409);
  };
  const guardedDb = (db = env.DB) => {
    if (databaseIdentity(db) !== databaseIdentity(env.DB)) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
    if (db[guardedOwner] === owner) return db;
    if (databases.has(db)) return databases.get(db);
    const guard = () => {
      subsonicAuthorityForPrincipal(principal, env);
      return db.prepare(`SELECT CASE WHEN ${predicate} THEN 1 ELSE json('subsonic_plugin_service_retired') END AS plugin_service_guard`)
        .bind(...bindings());
    };
    const batch = async statements => {
      const result = await db.batch([guard(), ...statements.map(statement => statement[rawStatement] || statement), guard()]);
      return result.slice(1, -1);
    };
    const wrapper = Object.freeze({ [guardedOwner]: owner, prepare(sql) {
      let statement = db.prepare(sql);
      const wrapped = { get [rawStatement]() { return statement; }, bind(...values) { statement = statement.bind(...values); return wrapped; },
        first: async column => { const result = (await batch([wrapped]))[0]; const row = result?.results?.[0] ?? null; return column ? row?.[column] ?? null : row; },
        all: async () => (await batch([wrapped]))[0], run: async () => (await batch([wrapped]))[0] };
      return wrapped;
    }, batch });
    registerDatabaseWrapper(wrapper, db);
    databases.set(db, wrapper); return wrapper;
  };
  const lease = Object.freeze({ identity: authority.identity,
    consumer: Object.freeze({ id: consumerId, epoch: installations.get(consumerId) }),
    provider: Object.freeze({ id: providerId, epoch: installations.get(providerId) }), assertCurrent, guardedDb });
  await assertCurrent();
  if (!leases.has(principal)) leases.set(principal, new WeakMap());
  leases.get(principal).set(registry, lease);
  leaseOwners.set(lease, { principal, database: env.DB, registry });
  return lease;
}
