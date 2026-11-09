import { installationKey, pluginRegistry } from './registry.js';
import { pluginFail as fail, requirePluginSession, sessionBindings, sessionPredicate } from './common.js';
import { canAccessPluginDeclaration, isPluginVisibleToRole } from '../../../shared/plugins/manifest.js';

const validKey = key => typeof key === 'string' && /^[a-z][a-z0-9.-]{0,127}$/.test(key);
const encodeOwner = owner => btoa(String.fromCharCode(...new TextEncoder().encode(owner)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// A narrow capability facade for trusted bundled modules. JSON configuration
// here is plaintext: credentials still require a purpose-specific encrypted
// adapter, such as Xiaomi's existing account store.
export async function createPluginContext({ env, session, pluginId, registry = pluginRegistry }) {
  const identity = await requirePluginSession(env, session);
  await registry.requirePluginRole(env, session, pluginId);
  const manifest = registry.manifests.find(item => item.id === pluginId);
  const allowedRoles = ['admin', 'member'].filter(role => isPluginVisibleToRole(manifest, role));
  if (!allowedRoles.length) fail('forbidden', 403);
  const installation = await registry.requirePluginInstalled(env, pluginId);
  const owner = session.account.accountId;
  const epoch = installation.epoch;
  async function assertCurrent() {
    const current = await registry.requirePluginRole(env, session, pluginId);
    await registry.requirePluginInstalled(env, pluginId, epoch);
    return current;
  }
  async function requireRoles(roles) {
    const current = await registry.requirePluginRole(env, session, pluginId);
    await registry.requirePluginInstalled(env, pluginId, epoch);
    if (!canAccessPluginDeclaration({ roles }, current.role)) fail('forbidden', 403);
    return current;
  }
  async function authorize(scope, key) {
    if (!['instance', 'account'].includes(scope) || !validKey(key)) fail('invalid_input', 400);
    await requirePluginSession(env, session, scope === 'instance');
    await registry.requirePluginRole(env, session, pluginId);
    await registry.requirePluginInstalled(env, pluginId, epoch);
    return `plugin.data.${pluginId}.${scope}.${scope === 'account' ? `${encodeOwner(owner)}.` : ''}${key}`;
  }
  async function get(scope, key) {
    const namespace = await authorize(scope, key);
    const row = await env.DB.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(namespace).first();
    await registry.requirePluginInstalled(env, pluginId, epoch);
    await requirePluginSession(env, session, scope === 'instance');
    await registry.requirePluginRole(env, session, pluginId);
    if (!row) return { value: null, revision: 0 };
    try { return { value: JSON.parse(row.value_json), revision: Number(row.revision) }; }
    catch { fail('PLUGIN_DATA_CORRUPT', 503); }
  }
  async function set(scope, key, value, { revision } = {}) {
    const namespace = await authorize(scope, key);
    let serialized;
    try { serialized = JSON.stringify(value); } catch { fail('invalid_input', 400); }
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > 16384
      || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(revision + 1)) fail('invalid_input', 400);
    const now = Date.now();
    const result = await env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      SELECT ?,?,1,?,? WHERE ${sessionPredicate}
        AND EXISTS(SELECT 1 FROM accounts storage_account WHERE storage_account.account_id=?
          AND storage_account.role IN (${allowedRoles.map(() => '?').join(',')}))
        AND EXISTS(SELECT 1 FROM instance_settings WHERE key=? AND json_extract(value_json,'$.installed')=1 AND json_extract(value_json,'$.epoch')=?)
        AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(namespace, serialized, now, owner, ...sessionBindings(session, now, scope === 'instance'),
        owner, ...allowedRoles, installationKey(pluginId), epoch, namespace, revision).run();
    if (Number(result?.meta?.changes) !== 1) {
      await registry.requirePluginInstalled(env, pluginId, epoch);
      const current = await registry.requirePluginRole(env, session, pluginId);
      if (scope === 'instance' && current.role !== 'admin') fail('forbidden', 403);
      fail('PLUGIN_DATA_REVISION_MISMATCH');
    }
    return { value: JSON.parse(serialized), revision: revision + 1 };
  }
  return Object.freeze({ plugin: Object.freeze({ id: pluginId, epoch }),
    identity: Object.freeze(identity), requireRoles, assertCurrent,
    storage: Object.freeze({ get, set }) });
}
