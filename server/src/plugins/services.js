import { pluginRegistry, installationKey } from './registry.js';
import { pluginFail, requirePluginSession, sessionPredicate, sessionBindings } from './common.js';
import { isPluginVisibleToRole, satisfiesPluginVersion } from '../../../shared/plugins/manifest.js';
import { isUsableCredentialMaterial } from '../instance/credentialFormat.js';

const rawStatement = Symbol('pluginServiceStatement');
const guardedOwner = Symbol('pluginServiceOwner');
const serviceLeases = new WeakSet();
export const isPluginServiceLease = value => serviceLeases.has(value);
const credentialPredicate = `EXISTS(SELECT 1 FROM account_credentials credential WHERE credential.account_id=?
  AND credential.kdf='pbkdf2-sha256-chain' AND credential.kdf_version=2
  AND json_valid(credential.kdf_params_json) AND json_extract(credential.kdf_params_json,'$.iterations')=100000
  AND json_extract(credential.kdf_params_json,'$.rounds')=6
  AND length(credential.salt)=22 AND credential.salt NOT GLOB '*[^A-Za-z0-9_-]*'
  AND length(credential.password_hash)=43 AND credential.password_hash NOT GLOB '*[^A-Za-z0-9_-]*')`;

async function requireInstallations(env, registry, ids) {
  if (registry.requirePluginsInstalled) return registry.requirePluginsInstalled(env, ids);
  // Compatibility for trusted registry adapters implementing the original API.
  const installations = new Map();
  const visit = async id => {
    if (installations.has(id)) return;
    installations.set(id, await registry.requirePluginInstalled(env, id));
    const manifest = registry.manifests.find(item => item.id === id);
    for (const dependency of Object.keys(manifest.dependencies || {})) await visit(dependency);
  };
  for (const id of ids) await visit(id);
  return installations;
}
function assertContext(session, context, pluginId) {
  if (!context) return;
  if (context.plugin?.id !== pluginId || context.identity?.accountId !== session?.account?.accountId) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  if (session?.mode !== 'normal' || !['admin', 'member'].includes(session.account?.role)) pluginFail('forbidden', 403);
}
function expectedEpochs(installations, context) {
  if (context && installations.get(context.plugin.id)?.epoch !== context.plugin.epoch) pluginFail('PLUGIN_NOT_INSTALLED');
  return new Map([...installations].map(([id, installation]) => [id, installation.epoch]));
}
async function diagnoseLease(env, registry, session, manifest, epochs, admin) {
  const identity = await requirePluginSession(env, session, admin);
  if (!isPluginVisibleToRole(manifest, identity.role)) pluginFail('forbidden', 403);
  const current = await requireInstallations(env, registry, [...epochs.keys()]);
  for (const [id, epoch] of epochs) if (current.get(id)?.epoch !== epoch) pluginFail('PLUGIN_NOT_INSTALLED');
}

function createLease({ env, session, identity, installations, roles, diagnose }) {
  const epochSql = [...installations].map(() => `EXISTS(SELECT 1 FROM instance_settings WHERE key=?
    AND json_extract(value_json,'$.installed')=1 AND json_extract(value_json,'$.epoch')=?)`).join(' AND ');
  const epochs = [...installations].flatMap(([id, epoch]) => [installationKey(id), epoch]);
  const predicate = `${sessionPredicate} AND a.role IN (${roles.map(() => '?').join(',')}) AND ${epochSql}`;
  const bindings = () => [...sessionBindings(session, Date.now()), ...roles, ...epochs];
  const owner = {};
  const databases = new WeakMap();
  async function assertCurrent() {
    const row = await env.DB.prepare(`SELECT c.*,a.role AS current_role FROM account_credentials c
      JOIN accounts a ON a.account_id=c.account_id WHERE c.account_id=? AND ${predicate}`)
      .bind(identity.accountId, ...bindings()).first();
    if (row && isUsableCredentialMaterial(row)) return;
    await diagnose();
    pluginFail('PLUGIN_SERVICE_RETIRED', 409);
  }
  function guardedDb(db = env.DB) {
    if (db[guardedOwner] === owner) return db;
    if (databases.has(db)) return databases.get(db);
    const guard = () => db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM accounts a WHERE a.account_id=?
      AND ${predicate}) AND ${credentialPredicate} THEN 1 ELSE json('plugin_service_retired') END AS plugin_service_guard`)
      .bind(identity.accountId, ...bindings(), identity.accountId);
    const batch = async statements => {
      // One D1 binding call includes authorization and all business SQL. A
      // rejected guard rolls back writes in the same transaction.
      const result = await db.batch([guard(), ...statements.map(statement => statement[rawStatement] || statement), guard()]);
      return result.slice(1, -1);
    };
    const wrapped = Object.freeze({ [guardedOwner]: owner, prepare(sql) {
      let statement = db.prepare(sql);
      const wrapper = { get [rawStatement]() { return statement; }, bind(...values) { statement = statement.bind(...values); return wrapper; },
        first: async column => { const result = (await batch([wrapper]))[0]; const row = result?.results?.[0] ?? null; return column ? row?.[column] ?? null : row; },
        all: async () => (await batch([wrapper]))[0], run: async () => (await batch([wrapper]))[0] };
      return wrapper;
    }, batch });
    databases.set(db, wrapped); return wrapped;
  }
  return { assertCurrent, guardedDb };
}

export async function createPluginOperationLease({ env, session, pluginId, context, registry = pluginRegistry, admin = false }) {
  assertContext(session, context, pluginId);
  const identity = context?.identity || await requirePluginSession(env, session, admin);
  if (admin && identity.role !== 'admin') pluginFail('forbidden', 403);
  const manifest = registry.manifests.find(item => item.id === pluginId);
  if (manifest && !isPluginVisibleToRole(manifest, identity.role)) pluginFail('forbidden', 403);
  const installations = expectedEpochs(await requireInstallations(env, registry, [pluginId]), context);
  const roles = ['admin', 'member'].filter(role => (!admin || role === 'admin') && isPluginVisibleToRole(manifest, role));
  const lease = createLease({ env, session, identity, installations, roles,
    diagnose: () => diagnoseLease(env, registry, session, manifest, installations, admin) });
  await lease.assertCurrent();
  return Object.freeze({ identity, ...lease });
}

// Only trusted compiled consumers choose this capability. Page roles on the
// provider do not prevent an authorized member from using a declared service.
export async function createPluginServiceLease({ env, session, consumerId, providerId,
  consumerContext, registry = pluginRegistry, admin = false }) {
  const consumer = registry.manifests.find(item => item.id === consumerId);
  const provider = registry.manifests.find(item => item.id === providerId);
  if (!consumer || !provider || consumerId === providerId
    || (!Object.hasOwn(consumer.dependencies || {}, providerId) && !Object.hasOwn(consumer.optionalDependencies || {}, providerId))) pluginFail('PLUGIN_SERVICE_UNDECLARED', 403);
  const declaration = consumer.dependencies?.[providerId] || consumer.optionalDependencies[providerId];
  if (declaration.apiVersion !== provider.apiVersion || (declaration.version && !satisfiesPluginVersion(provider.version, declaration.version))) pluginFail('PLUGIN_SERVICE_INCOMPATIBLE', 409);
  assertContext(session, consumerContext, consumerId);
  const identity = consumerContext?.identity || await requirePluginSession(env, session, admin);
  if (admin && identity.role !== 'admin') pluginFail('forbidden', 403);
  if (!isPluginVisibleToRole(consumer, identity.role)) pluginFail('forbidden', 403);
  const snapshot = await requireInstallations(env, registry, [consumerId, providerId]);
  const installations = expectedEpochs(snapshot, consumerContext);
  const consumerInstallation = snapshot.get(consumerId), providerInstallation = snapshot.get(providerId);
  const roles = ['admin', 'member'].filter(role => (!admin || role === 'admin') && isPluginVisibleToRole(consumer, role));
  const lease = createLease({ env, session, identity, installations,
    roles, diagnose: () => diagnoseLease(env, registry, session, consumer, installations, admin) });
  await lease.assertCurrent();
  const service = Object.freeze({ identity: Object.freeze({ ...identity }),
    consumer: Object.freeze({ id: consumerId, epoch: consumerInstallation.epoch }),
    provider: Object.freeze({ id: providerId, epoch: providerInstallation.epoch }), ...lease });
  serviceLeases.add(service); return service;
}
