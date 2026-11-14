import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';
import { pluginDeployment } from '../../../shared/plugins/delivery.generated.js';
import { deliveryPluginModules } from './delivery.generated.js';
import { canonicalPluginManifest, getRequiredDependents, resolvePluginAvailability, validatePluginManifests, isPluginVisibleToRole, normalizePluginUiLanguage } from '../../../shared/plugins/manifest.js';
import { pluginFail as fail, requirePluginSession, sessionBindings, sessionPredicate, sha256 } from './common.js';
import { preparePluginMigrations } from './migrations.js';

export const XIAOMI_PLUGIN_ID = 'xiaomi-speaker';
export const installationKey = pluginId => `plugin.installation.${pluginId}`;
export const INSTALLATION_KEY = installationKey(XIAOMI_PLUGIN_ID);
export const REGISTRY_KEY = 'plugin.registry';
const validEpoch = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const readValue = row => {
  let value;
  try { value = JSON.parse(row?.value_json || '{}'); } catch { /* Corrupt settings fail closed. */ }
  const installed = value?.installed === true && validEpoch(value.epoch);
  return { installed, revision: Number(row?.revision || 0), epoch: installed ? value.epoch : null,
    ...(typeof value?.uiLanguage === 'string' ? { uiLanguage: normalizePluginUiLanguage(value.uiLanguage) } : {}) };
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export function createPluginRegistry({ manifests = compiledPluginManifests, modules = {}, builds = [], deployment = pluginDeployment } = {}) {
  const catalog = freeze(JSON.parse(JSON.stringify(validatePluginManifests(manifests))));
  const byId = new Map(catalog.map(manifest => [manifest.id, manifest]));
  const buildDigests = new Map(builds.map(build => {
    if (!byId.has(build.id) || !/^[a-f0-9]{64}$/.test(build.sourceDigest || '')) fail('PLUGIN_BUILD_INVALID', 503);
    return [build.id, build.sourceDigest];
  }));
  const snapshotMigrations = source => new Map(catalog.map(manifest => [manifest.id,
    freeze(JSON.parse(JSON.stringify(source[manifest.id]?.migrations || [])))]));
  // Explicit module objects retain their construction-time snapshot contract.
  // The generated default modules are read after the server ESM graph has
  // initialized, since package SDK imports can lead back into this registry.
  let migrationsById = typeof modules === 'function' ? null : snapshotMigrations(modules);
  const migrationsFor = pluginId => {
    migrationsById ||= snapshotMigrations(modules());
    return migrationsById.get(pluginId);
  };
  const known = pluginId => { const manifest = byId.get(pluginId); if (!manifest) fail('PLUGIN_NOT_FOUND', 404); return manifest; };
  const getBuildDigest = pluginId => { known(pluginId); return buildDigests.get(pluginId) || null; };
  const digestCache = new Map();
  async function digest(manifest) {
    if (!digestCache.has(manifest.id)) digestCache.set(manifest.id, sha256(canonicalPluginManifest(manifest)));
    return digestCache.get(manifest.id);
  }
  // All writers share this generation, so a dependency snapshot cannot race a
  // dependency uninstall and still commit its consumer installation.
  async function snapshot(env) {
    const coordinator = await env.DB.prepare('SELECT revision FROM instance_settings WHERE key=?').bind(REGISTRY_KEY).first();
    const rows = (await env.DB.prepare("SELECT key,value_json,revision FROM instance_settings WHERE key LIKE 'plugin.installation.%' OR key LIKE 'plugin.migrations.%'").all()).results || [];
    const installations = new Map(rows.filter(row => row.key.startsWith('plugin.installation.')).map(row => [row.key.slice('plugin.installation.'.length), readValue(row)]));
    const migrationLedgers = new Map(rows.filter(row => row.key.startsWith('plugin.migrations.')).map(row => {
      let completed;
      try { completed = JSON.parse(row.value_json).completed; } catch { /* Invalid ledger blocks business access. */ }
      return [row.key.slice('plugin.migrations.'.length), completed];
    }));
    const installedIds = catalog.filter(manifest => installations.get(manifest.id)?.installed).map(manifest => manifest.id);
    let delivery = null;
    if (deployment?.buildId) {
      const row = await env.DB.prepare("SELECT value_json FROM instance_settings WHERE key='plugin.delivery.v1'").first();
      try { delivery = JSON.parse(row?.value_json || 'null'); } catch { /* An unconfirmed deployment fails closed. */ }
    }
    return { revision: Number(coordinator?.revision || 0), installations, installedIds, migrationLedgers, delivery };
  }
  async function readInstallation(env, pluginId = XIAOMI_PLUGIN_ID) {
    known(pluginId);
    const row = await env.DB.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(installationKey(pluginId)).first();
    return readValue(row);
  }
  function availabilityFor(state, pluginId, includeOptional = true) {
    const availability = resolvePluginAvailability(catalog, state.installedIds, pluginId);
    if (!availability.available) return availability;
    const manifest = known(pluginId); const migrations = migrationsFor(pluginId);
    const committed = state.delivery?.activeDeployment;
    if (deployment?.buildId && (committed?.buildId !== deployment.buildId || committed?.planDigest !== deployment.planDigest)) {
      const proposed = deployment.plugins?.find(row => row.id === pluginId);
      const previous = state.delivery?.running?.find(row => row.id === pluginId);
      const unchanged = proposed && previous && canonicalPluginManifest(previous.manifest) === canonicalPluginManifest(manifest)
        && canonicalPluginManifest(previous.source) === canonicalPluginManifest(proposed.source);
      if (proposed && !unchanged) return { ...availability, available: false, reason: 'deployment_pending',
        issues: [...availability.issues, { code: 'deployment_pending', pluginId }] };
    }
    const expected = manifest.dataVersion ?? migrations.length;
    const completed = state.migrationLedgers.has(pluginId) ? state.migrationLedgers.get(pluginId) : [];
    const incompatible = expected !== migrations.length || !Array.isArray(completed) || completed.length > expected
      || (Array.isArray(completed) && completed.some((saved, index) => !saved || saved.version !== index + 1 || saved.checksum !== migrations[index]?.checksum));
    const reason = incompatible ? 'data_version_incompatible' : completed.length < expected ? 'data_migration_required' : null;
    if (reason) return { ...availability, available: false, reason, issues: [...availability.issues, { code: reason, pluginId }] };
    for (const dependencyId of Object.keys(manifest.dependencies || {})) {
      const dependency = availabilityFor(state, dependencyId, false);
      if (!dependency.available) return { ...availability, available: false, reason: 'dependency_unavailable',
        issues: [{ code: 'dependency_unavailable', pluginId, dependencyId }, ...dependency.issues] };
    }
    if (includeOptional) for (const feature of Object.values(availability.optionalFeatures)) {
      if (!feature.available) continue;
      const dependency = availabilityFor(state, feature.dependencyId, false);
      if (!dependency.available) { feature.available = false; feature.reason = dependency.reason; }
    }
    return availability;
  }
  async function publicPlugin(manifest, installation, state) {
    return { id: manifest.id, version: manifest.version, installed: installation.installed, revision: installation.revision,
      manifestDigest: await digest(manifest), buildDigest: getBuildDigest(manifest.id),
      availability: availabilityFor(state, manifest.id) };
  }
  async function listPlugins(env, session, admin = false) {
    const identity = await requirePluginSession(env, session, admin);
    const state = await snapshot(env);
    const visible = catalog.filter(manifest => admin || (state.installations.get(manifest.id)?.installed && isPluginVisibleToRole(manifest, identity.role)));
    const visibleIds = new Set(visible.map(manifest => manifest.id));
    const dependencies = new Set();
    const visit = manifest => {
      for (const id of [...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.optionalDependencies || {})]) {
        if (dependencies.has(id)) continue;
        dependencies.add(id);
        if (byId.has(id)) visit(byId.get(id));
      }
    };
    visible.forEach(visit);
    const dependencyInstalledIds = state.installedIds.filter(id => !visibleIds.has(id) && dependencies.has(id));
    return { plugins: await Promise.all(visible.map(manifest => publicPlugin(manifest, state.installations.get(manifest.id) || readValue(null), state))),
      ...(dependencyInstalledIds.length ? { dependencyInstalledIds } : {}) };
  }
  async function requirePluginRole(env, session, pluginId) {
    const identity = await requirePluginSession(env, session);
    if (!isPluginVisibleToRole(known(pluginId), identity.role)) fail('forbidden', 403);
    return identity;
  }
  async function requirePluginInstalled(env, pluginId, expectedEpoch) {
    known(pluginId);
    const state = await snapshot(env);
    const installation = state.installations.get(pluginId) || readValue(null);
    if (!installation.installed || (expectedEpoch !== undefined && installation.epoch !== expectedEpoch)) fail('PLUGIN_NOT_INSTALLED');
    const availability = availabilityFor(state, pluginId);
    if (!availability.available) fail('PLUGIN_UNAVAILABLE', 409, { availability });
    return installation;
  }
  async function requirePluginsInstalled(env, pluginIds) {
    if (!Array.isArray(pluginIds) || !pluginIds.length) fail('invalid_input', 400);
    pluginIds.forEach(known);
    // Consumers of several services need one coherent read, including the
    // migration/delivery gates. Installation writers retain their existing CAS.
    const rows = (await env.DB.prepare(`SELECT key,value_json,revision FROM instance_settings
      WHERE key IN ('plugin.registry','plugin.delivery.v1')
        OR key LIKE 'plugin.installation.%' OR key LIKE 'plugin.migrations.%'`).all()).results || [];
    const installations = new Map(rows.filter(row => row.key.startsWith('plugin.installation.'))
      .map(row => [row.key.slice('plugin.installation.'.length), readValue(row)]));
    const migrationLedgers = new Map(rows.filter(row => row.key.startsWith('plugin.migrations.')).map(row => {
      let completed;
      try { completed = JSON.parse(row.value_json).completed; } catch { /* Invalid ledgers fail the same availability gate. */ }
      return [row.key.slice('plugin.migrations.'.length), completed];
    }));
    let delivery = null;
    try { delivery = JSON.parse(rows.find(row => row.key === 'plugin.delivery.v1')?.value_json || 'null'); } catch { /* Fail closed. */ }
    const state = { revision: Number(rows.find(row => row.key === REGISTRY_KEY)?.revision || 0), installations,
      installedIds: catalog.filter(manifest => installations.get(manifest.id)?.installed).map(manifest => manifest.id), migrationLedgers, delivery };
    const result = new Map();
    const visit = id => {
      if (result.has(id)) return;
      const manifest = known(id), installation = installations.get(id) || readValue(null);
      if (!installation.installed) fail('PLUGIN_NOT_INSTALLED');
      const availability = availabilityFor(state, id);
      if (!availability.available) fail('PLUGIN_UNAVAILABLE', 409, { availability });
      result.set(id, installation);
      for (const dependencyId of Object.keys(manifest.dependencies || {})) visit(dependencyId);
    };
    pluginIds.forEach(visit);
    return result;
  }
  async function setInstalled(env, session, pluginId, input, { uiLanguage } = {}) {
    await requirePluginSession(env, session, true);
    const manifest = known(pluginId);
    if (!input || typeof input.installed !== 'boolean' || !Number.isSafeInteger(input.revision) || input.revision < 0
      || !Number.isSafeInteger(input.revision + 1) || Object.keys(input).some(key => !['installed', 'revision'].includes(key))) fail('invalid_input', 400);
    const state = await snapshot(env);
    const current = state.installations.get(pluginId) || readValue(null);
    if (current.revision !== input.revision) fail('PLUGIN_REVISION_MISMATCH');
    const dependents = getRequiredDependents(catalog, state.installedIds, pluginId);
    if (!input.installed && dependents.length) fail('PLUGIN_REQUIRED_BY', 409, { dependents });
    const installedIds = input.installed ? [...new Set([...state.installedIds, pluginId])] : state.installedIds.filter(id => id !== pluginId);
    if (input.installed) {
      const availability = resolvePluginAvailability(catalog, installedIds, pluginId);
      if (!availability.available) {
        const code = availability.issues.some(issue => issue.code === 'dependency_cycle') ? 'PLUGIN_DEPENDENCY_CYCLE'
          : availability.reason === 'host_incompatible' ? 'PLUGIN_HOST_INCOMPATIBLE'
            : availability.issues.some(issue => issue.code === 'incompatible_dependency') ? 'PLUGIN_DEPENDENCY_INCOMPATIBLE' : 'PLUGIN_DEPENDENCY_MISSING';
        fail(code, 409, { availability });
      }
      for (const dependencyId of Object.keys(manifest.dependencies || {})) {
        const dependency = availabilityFor(state, dependencyId);
        if (!dependency.available) fail('PLUGIN_DEPENDENCY_UNAVAILABLE', 409, { availability: dependency });
      }
      for (const dependent of dependents) {
        const availability = resolvePluginAvailability(catalog, installedIds, dependent);
        if (!availability.available) fail('PLUGIN_DEPENDENCY_INCOMPATIBLE', 409, { dependents: [dependent], availability });
      }
    }
    if (input.installed && manifest.dataVersion !== undefined && manifest.dataVersion !== migrationsFor(pluginId).length) fail('PLUGIN_DATA_VERSION_UNSUPPORTED');
    const plan = input.installed ? await preparePluginMigrations(env, pluginId, migrationsFor(pluginId))
      : { key: `plugin.migrations.${pluginId}`, revision: Number((await env.DB.prepare('SELECT revision FROM instance_settings WHERE key=?').bind(`plugin.migrations.${pluginId}`).first())?.revision || 0), statements: [], changed: false };
    const epoch = input.installed && current.installed ? current.epoch : crypto.randomUUID();
    const now = Date.now(); const owner = session.account.accountId; const operationId = crypto.randomUUID();
    const coordinatorValue = JSON.stringify({ operationId });
    const statements = [env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      SELECT ?,?,1,?,? WHERE ${sessionPredicate}
        AND NOT EXISTS (SELECT 1 FROM instance_settings u WHERE u.key='system.update.v1'
          AND json_extract(u.value_json,'$.job.status') IS NOT NULL
          AND (json_extract(u.value_json,'$.job.status') NOT IN ('deployed','rolled_back','failed')
            OR (json_extract(u.value_json,'$.job.receipt.migrationStarted')=1
              AND json_extract(u.value_json,'$.job.status')<>'deployed')))
        AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
        AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
        AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(REGISTRY_KEY, coordinatorValue, now, owner, ...sessionBindings(session, now, true), REGISTRY_KEY, state.revision,
        installationKey(pluginId), input.revision, plan.key, plan.revision),
    // CASE is lazy in SQLite. An invalid guard aborts the entire D1 batch before
    // DDL can execute; zero changed rows alone would not guard following SQL.
    env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM instance_settings WHERE key=? AND value_json=?)
      THEN 1 ELSE json_extract('invalid', '$.plugin_guard') END AS guarded`).bind(REGISTRY_KEY, coordinatorValue),
    ...plan.statements.map(sql => env.DB.prepare(sql))];
    if (plan.changed) statements.push(env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(plan.key, JSON.stringify({ completed: plan.completed }), now, owner));
    statements.push(env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(installationKey(pluginId), JSON.stringify({ installed: input.installed, epoch,
        ...((input.installed && !current.installed && uiLanguage !== undefined) || current.uiLanguage
          ? { uiLanguage: input.installed && !current.installed && uiLanguage !== undefined ? normalizePluginUiLanguage(uiLanguage) : current.uiLanguage } : {}) }), now, owner));
    try { await env.DB.batch(statements); }
    catch {
      await requirePluginSession(env, session, true);
      const latest = await snapshot(env);
      if (latest.revision !== state.revision || (latest.installations.get(pluginId)?.revision || 0) !== input.revision) fail('PLUGIN_REVISION_MISMATCH');
      fail('PLUGIN_MIGRATION_FAILED');
    }
    const migrationLedgers = new Map(state.migrationLedgers);
    if (plan.changed) migrationLedgers.set(pluginId, plan.completed);
    return { plugin: await publicPlugin(manifest, { installed: input.installed, revision: input.revision + 1 }, { ...state, installedIds, migrationLedgers }) };
  }
  const getMigrations = pluginId => { known(pluginId); return migrationsFor(pluginId); };
  return Object.freeze({ manifests: catalog, listPlugins, setInstalled, readInstallation, requirePluginInstalled, requirePluginsInstalled, requirePluginRole, getBuildDigest, getMigrations });
}

export const pluginRegistry = createPluginRegistry({ builds: pluginBuilds, modules: () => deliveryPluginModules });
export const readInstallation = (env, pluginId = XIAOMI_PLUGIN_ID) => pluginRegistry.readInstallation(env, pluginId);
export const requirePluginInstalled = (env, pluginId, expectedEpoch) => pluginRegistry.requirePluginInstalled(env, pluginId, expectedEpoch);
export const requireInstalled = (env, expectedEpoch) => requirePluginInstalled(env, XIAOMI_PLUGIN_ID, expectedEpoch);
export const listPlugins = (...args) => pluginRegistry.listPlugins(...args);
export const setInstalled = (...args) => pluginRegistry.setInstalled(...args);
