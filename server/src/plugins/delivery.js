import { pluginRegistry, REGISTRY_KEY, installationKey } from './registry.js';
import * as buildMetadata from '../../../shared/plugins/build.generated.js';
import * as deliveryMetadata from '../../../shared/plugins/delivery.generated.js';
import { canonicalPluginManifest, comparePluginVersions, resolvePluginAvailability, normalizePluginUiLanguage } from '../../../shared/plugins/manifest.js';
import { ACTIVE_PLUGIN_BUILDS, OFFICIAL_PLUGIN_SOURCE, PLUGIN_BUILD_TIMEOUT, canonicalPluginPlan, pluginSelectionChanges,
  validateDeployHookUrl, validatePluginDirectory, validatePublicHttpsUrl } from '../../../shared/plugins/delivery.js';
import { pluginFail as fail, requirePluginSession, sessionBindings, sessionPredicate, sha256 } from './common.js';
import { openDeliverySecrets, sealDeliverySecrets } from './deliverySecrets.js';
import { preparePluginMigrations } from './migrations.js';

export const PLUGIN_DELIVERY_KEY = 'plugin.delivery.v1';
const clone = value => JSON.parse(JSON.stringify(value));
const validRevision = value => Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value + 1);
const snapshotPlugin = ({ id, version, manifest, source }) => ({ id, version, manifest, source });
const samePluginTarget = (a, b) => Boolean(a && b
  && canonicalPluginManifest(snapshotPlugin(a)) === canonicalPluginManifest(snapshotPlugin(b)));
const initialState = () => ({ mode: 'manual', secrets: null, sources: [{ ...OFFICIAL_PLUGIN_SOURCE,
  status: 'unpublished', error: null, updatedAt: null, catalog: [] }], desired: null, running: [], build: null });
const knownKeys = (input, keys) => input && typeof input === 'object' && !Array.isArray(input)
  && Object.keys(input).every(key => keys.includes(key));
const timedOut = build => build && ACTIVE_PLUGIN_BUILDS.has(build.status) && Date.now() - build.updatedAt > PLUGIN_BUILD_TIMEOUT;
const active = build => build && ACTIVE_PLUGIN_BUILDS.has(build.status) && !timedOut(build) && !build.resultUnknown;
const validHost = value => knownKeys(value, ['version', 'sourceDigest'])
  && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version || '')
  && value.version.split('.').every(part => Number.isSafeInteger(Number(part)))
  && /^[a-f0-9]{64}$/.test(value.sourceDigest || '');
const compareHostVersion = (a, b) => {
  const previous = b.split('.').map(Number), next = a.split('.').map(Number);
  return next[0] - previous[0] || next[1] - previous[1] || next[2] - previous[2];
};

async function boundedJson(response, maxBytes = 524288) {
  if (Number(response.headers.get('Content-Length')) > maxBytes) fail('PLUGIN_SOURCE_TOO_LARGE', 400);
  const reader = response.body?.getReader();
  if (!reader) fail('PLUGIN_SOURCE_INVALID', 400);
  let bytes = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); fail('PLUGIN_SOURCE_TOO_LARGE', 400); }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error?.code === 'PLUGIN_SOURCE_TOO_LARGE') throw error;
    fail('PLUGIN_SOURCE_INVALID', 400);
  } finally { reader.releaseLock(); }
}

export function createPluginDelivery({ registry = pluginRegistry, host = buildMetadata.pluginHostBuild,
  deployment = deliveryMetadata.pluginDeployment, sources = deliveryMetadata.compiledPluginSources || {},
  fetchImpl = (...args) => fetch(...args) } = {}) {
  async function read(env) {
    const row = await env.DB.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(PLUGIN_DELIVERY_KEY).first();
    if (!row) return { revision: 0, value: initialState() };
    try {
      const value = JSON.parse(row.value_json);
      if (!['manual', 'auto'].includes(value.mode) || !Array.isArray(value.sources) || !Array.isArray(value.running)
        || !(value.desired === null || Array.isArray(value.desired))) throw new Error('invalid');
      return { revision: Number(row.revision), value };
    } catch { fail('PLUGIN_DELIVERY_STATE_INVALID', 503); }
  }
  async function save(env, record, value, { session, actor = 'plugin-build', registryRevision } = {}) {
    const now = Date.now();
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > 1000000) fail('PLUGIN_SOURCE_TOO_LARGE', 400);
    const result = await env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
      SELECT ?,?,1,?,? WHERE COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
      ${registryRevision !== undefined ? 'AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?' : ''}
      ${session ? `AND ${sessionPredicate}` : ''}
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(PLUGIN_DELIVERY_KEY, serialized, now, session?.account.accountId || actor, PLUGIN_DELIVERY_KEY, record.revision,
        ...(registryRevision !== undefined ? [REGISTRY_KEY, registryRevision] : []),
        ...(session ? sessionBindings(session, now, true) : [])).run();
    if (Number(result?.meta?.changes) !== 1) {
      if (session) await requirePluginSession(env, session, true);
      fail('PLUGIN_DELIVERY_CHANGED');
    }
    return { revision: record.revision + 1, value };
  }
  async function administrator(env, session, input, keys) {
    await requirePluginSession(env, session, true);
    if (!knownKeys(input, ['revision', ...keys]) || !validRevision(input.revision)) fail('invalid_input', 400);
    const record = await read(env);
    if (record.revision !== input.revision) fail('PLUGIN_DELIVERY_CHANGED');
    return record;
  }
  function assertEditable(record) {
    if (active(record.value.build)) fail('PLUGIN_BUILD_IN_PROGRESS');
    // A timed-out provider job may still be alive. Retry the identical frozen
    // plan until it reports a known result; never let an old job apply a new plan.
    if (timedOut(record.value.build) || record.value.build?.resultUnknown) fail('PLUGIN_BUILD_RESULT_UNKNOWN');
  }
  function compiledRows() {
    return registry.manifests.map(manifest => {
      const source = sources[manifest.id] || { type: 'workspace', id: 'workspace', sourceDigest: registry.getBuildDigest(manifest.id) };
      return { id: manifest.id, version: manifest.version, manifest, sourceId: source.id,
        sourceName: source.id === 'official' ? OFFICIAL_PLUGIN_SOURCE.name : source.type === 'workspace' ? 'Current deployment' : source.id,
        source: clone(source) };
    });
  }
  const workspaceRows = () => compiledRows().filter(row => row.source.type === 'workspace');
  function catalogFor(record) {
    const catalog = record.value.sources.flatMap(source => (source.catalog || []).map(entry => ({
      id: entry.manifest.id, version: entry.manifest.version, manifest: entry.manifest, sourceId: source.id, sourceName: source.name,
      source: { type: 'artifact', id: source.id, url: entry.artifact.url, sha256: entry.artifact.sha256 },
    })));
    return [...compiledRows().filter(row => !catalog.some(candidate => candidate.id === row.id
      && candidate.version === row.version && candidate.sourceId === row.sourceId)), ...catalog];
  }
  async function runningFor(env, record) {
    const installed = [];
    const compiled = compiledRows();
    for (const id of new Set([...compiled.map(row => row.id), ...record.value.running.map(row => row.id)])) {
      let enabled = false;
      if (compiled.some(row => row.id === id)) enabled = (await registry.readInstallation(env, id)).installed;
      else {
        const row = await env.DB.prepare('SELECT value_json FROM instance_settings WHERE key=?').bind(installationKey(id)).first();
        try { enabled = JSON.parse(row?.value_json || '{}').installed === true; } catch { /* Invalid retained state is unavailable. */ }
      }
      if (!enabled) continue;
      const saved = record.value.running.find(item => item.id === id);
      const current = compiled.find(row => row.id === id);
      // An explicit host bootstrap carries honest package provenance while
      // retaining administrator installation flags and epochs. A real delivery
      // keeps the previous running plan until its activation is confirmed.
      installed.push(!deployment?.buildId && current?.source.type === 'artifact' ? current : saved || current);
    }
    return installed;
  }
  async function publicState(env, record) {
    let secrets = {}; let needsReconnect = false;
    try { secrets = record.value.secrets ? await openDeliverySecrets(env, record.value.secrets) : {}; }
    catch { needsReconnect = true; }
    const running = await runningFor(env, record); const desired = record.value.desired ?? running;
    const build = record.value.build;
    return { revision: record.revision, settings: { mode: record.value.mode, hookConfigured: Boolean(secrets.deployHookUrl),
      buildTokenConfigured: Boolean(secrets.buildToken), ...(needsReconnect ? { needsReconnect: true } : {}) }, sources: record.value.sources.map(({ catalog, ...source }) => source),
    catalog: catalogFor(record), running, desired, pending: pluginSelectionChanges(running, desired),
    build: build ? { id: build.id, planDigest: build.planDigest, status: timedOut(build) ? 'failed' : build.status,
      createdAt: build.createdAt, updatedAt: build.updatedAt, error: timedOut(build) ? 'PLUGIN_BUILD_RESULT_UNKNOWN' : build.error,
      resultUnknown: Boolean(timedOut(build) || build.resultUnknown), deploymentStarted: Boolean(build.deploymentStarted), providerBuildId: build.providerBuildId || null } : null };
  }
  async function get(env, session) {
    await requirePluginSession(env, session, true);
    return publicState(env, await read(env));
  }
  async function configure(env, session, input) {
    const record = await administrator(env, session, input, ['mode', 'deployHookUrl', 'buildToken']);
    assertEditable(record);
    const value = clone(record.value);
    // Supplying both write-only fields explicitly also repairs credentials after
    // a SETUP_SECRET rotation, without needing the old decryption key.
    const replacingSecrets = input.deployHookUrl !== undefined && input.buildToken !== undefined;
    const secrets = value.secrets && !replacingSecrets ? await openDeliverySecrets(env, value.secrets) : {};
    if (input.mode !== undefined && !['manual', 'auto'].includes(input.mode)) fail('invalid_input', 400);
    if (input.deployHookUrl !== undefined) {
      if (input.deployHookUrl !== '') {
        try { secrets.deployHookUrl = validateDeployHookUrl(input.deployHookUrl); } catch { fail('PLUGIN_DEPLOY_HOOK_INVALID', 400); }
      } else delete secrets.deployHookUrl;
    }
    if (input.buildToken !== undefined) {
      if (input.buildToken === '') delete secrets.buildToken;
      else if (typeof input.buildToken === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(input.buildToken)) secrets.buildToken = input.buildToken;
      else fail('invalid_input', 400);
    }
    value.mode = input.mode ?? value.mode;
    if (value.mode === 'auto' && (!secrets.deployHookUrl || !secrets.buildToken)) fail('PLUGIN_BUILD_NOT_CONFIGURED', 400);
    value.secrets = Object.keys(secrets).length ? await sealDeliverySecrets(env, secrets) : null;
    return publicState(env, await save(env, record, value, { session }));
  }
  async function fetchDirectory(url) {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail(response.status === 404 ? 'PLUGIN_SOURCE_UNPUBLISHED' : 'PLUGIN_SOURCE_UNAVAILABLE', 502);
    try { return validatePluginDirectory(await boundedJson(response)); }
    catch (error) { if (error?.status) throw error; fail('PLUGIN_SOURCE_INVALID', 400); }
  }
  async function addSource(env, session, input) {
    const record = await administrator(env, session, input, ['url']); assertEditable(record);
    let url;
    try { url = validatePublicHttpsUrl(input.url); } catch { fail('PLUGIN_URL_INVALID', 400); }
    if (record.value.sources.some(source => source.url === url)) fail('PLUGIN_SOURCE_EXISTS');
    if (record.value.sources.length >= 16) fail('PLUGIN_SOURCE_LIMIT', 400);
    let directory;
    try { directory = await fetchDirectory(url); } catch (error) { if (error?.code) throw error; fail('PLUGIN_SOURCE_UNAVAILABLE', 502); }
    const value = clone(record.value);
    value.sources.push({ id: `source-${(await sha256(url)).slice(0, 24)}`, name: directory.name, url, official: false,
      status: 'ready', error: null, updatedAt: Date.now(), catalog: directory.plugins });
    return publicState(env, await save(env, record, value, { session }));
  }
  async function refreshSource(env, session, sourceId, input) {
    const record = await administrator(env, session, input, []); assertEditable(record);
    const value = clone(record.value); const source = value.sources.find(item => item.id === sourceId);
    if (!source) fail('PLUGIN_SOURCE_NOT_FOUND', 404);
    try {
      const directory = await fetchDirectory(validatePublicHttpsUrl(source.url));
      source.name = directory.name; source.catalog = directory.plugins; source.status = 'ready'; source.error = null;
    } catch (error) {
      source.status = source.official && error?.code === 'PLUGIN_SOURCE_UNPUBLISHED' ? 'unpublished' : 'error';
      source.error = source.status === 'unpublished' ? null : 'PLUGIN_SOURCE_UNAVAILABLE';
    }
    source.updatedAt = Date.now();
    return publicState(env, await save(env, record, value, { session }));
  }
  async function removeSource(env, session, sourceId, input) {
    const record = await administrator(env, session, input, []); assertEditable(record);
    const source = record.value.sources.find(item => item.id === sourceId);
    if (!source) fail('PLUGIN_SOURCE_NOT_FOUND', 404);
    if (source.official) fail('PLUGIN_OFFICIAL_SOURCE_REQUIRED');
    const value = clone(record.value); value.sources = value.sources.filter(item => item.id !== sourceId);
    return publicState(env, await save(env, record, value, { session }));
  }
  function validateSelection(desired) {
    if (desired.length > 32) fail('PLUGIN_SELECTION_LIMIT', 400);
    for (const row of desired) {
      const availability = resolvePluginAvailability(desired.map(item => item.manifest), desired.map(item => item.id), row.id);
      if (!availability.available) fail('PLUGIN_SELECTION_INCOMPATIBLE', 409, { availability });
    }
  }
  async function select(env, session, input, { uiLanguage = 'en' } = {}) {
    const record = await administrator(env, session, input, ['pluginId', 'installed', 'sourceId', 'version', 'trustCode']);
    assertEditable(record);
    if (typeof input.pluginId !== 'string' || typeof input.installed !== 'boolean') fail('invalid_input', 400);
    const running = await runningFor(env, record);
    const desired = clone(record.value.desired ?? running);
    const current = desired.find(row => row.id === input.pluginId);
    const installed = running.find(row => row.id === input.pluginId);
    if (input.installed) {
      const candidate = catalogFor(record).find(row => row.id === input.pluginId
        && row.sourceId === (input.sourceId || current?.sourceId || compiledRows().find(row => row.id === input.pluginId)?.sourceId || 'workspace')
        && (!input.version || row.version === input.version));
      if (!candidate) fail('PLUGIN_NOT_FOUND', 404);
      const workspaceOwned = workspaceRows().some(row => row.id === input.pluginId)
        && !deployment?.plugins?.some(entry => entry.id === input.pluginId && entry.source.type === 'artifact');
      if ([current, installed].some(owner => owner && owner.sourceId !== candidate.sourceId)
        || (workspaceOwned && candidate.source.type === 'artifact')) fail('PLUGIN_SOURCE_CONFLICT');
      if (candidate.source.type === 'artifact' && input.trustCode !== true) fail('PLUGIN_CODE_TRUST_REQUIRED', 400);
      // A pending install is also a locked target: changing the button label to
      // "install" must not permit an older or republished same-version package.
      for (const baseline of [installed, current].filter(Boolean)) {
        const comparison = comparePluginVersions(candidate.version, baseline.version);
        if (comparison < 0 || (comparison === 0 && !samePluginTarget(candidate, baseline))) fail('PLUGIN_VERSION_NOT_NEWER');
      }
      if (samePluginTarget(candidate, current)) {
        validateSelection(desired);
        return publicState(env, record);
      }
      const index = desired.findIndex(row => row.id === input.pluginId);
      if (index >= 0) desired[index] = candidate; else desired.push(candidate);
    } else {
      const index = desired.findIndex(row => row.id === input.pluginId);
      if (index < 0) fail('PLUGIN_NOT_SELECTED', 404);
      desired.splice(index, 1);
    }
    desired.sort((a, b) => a.id.localeCompare(b.id)); validateSelection(desired);
    const value = clone(record.value); value.desired = desired;
    if (input.installed && !running.some(row => row.id === input.pluginId)) {
      value.installationLanguages = { ...value.installationLanguages, [input.pluginId]: normalizePluginUiLanguage(uiLanguage) };
    }
    const saved = await save(env, record, value, { session });
    if (value.mode === 'auto' && pluginSelectionChanges(running, desired).length) return startBuild(env, session, { revision: saved.revision });
    return publicState(env, saved);
  }
  async function discard(env, session, input) {
    const record = await administrator(env, session, input, []); assertEditable(record);
    const value = clone(record.value); value.desired = null;
    return publicState(env, await save(env, record, value, { session }));
  }
  async function resolveBuild(env, session, input) {
    const record = await administrator(env, session, input, ['confirmedStopped']);
    if (record.value.build?.deploymentStarted) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    if (input.confirmedStopped !== true || !(timedOut(record.value.build) || record.value.build?.resultUnknown)) fail('PLUGIN_BUILD_RESOLUTION_REQUIRED', 400);
    const value = clone(record.value);
    value.build.status = 'cancelled'; value.build.error = null; value.build.resultUnknown = false; value.build.updatedAt = Date.now();
    return publicState(env, await save(env, record, value, { session }));
  }
  async function startBuild(env, session, input) {
    let record = await administrator(env, session, input, []);
    if (record.value.build?.deploymentStarted && record.value.build?.status !== 'deployed' && record.value.build?.resultUnknown) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    if (record.value.build?.deploymentStarted && timedOut(record.value.build)) fail('PLUGIN_DEPLOYMENT_UNCONFIRMED');
    if (active(record.value.build)) fail('PLUGIN_BUILD_IN_PROGRESS');
    const running = await runningFor(env, record); const desired = record.value.desired ?? running;
    if (!pluginSelectionChanges(running, desired).length) fail('PLUGIN_NO_PENDING_CHANGES');
    validateSelection(desired);
    if (!host || typeof host.version !== 'string' || !/^[a-f0-9]{64}$/.test(host.sourceDigest || '')) fail('PLUGIN_BUILD_HOST_UNKNOWN', 503);
    const secrets = record.value.secrets ? await openDeliverySecrets(env, record.value.secrets) : {};
    const now = Date.now(); const buildId = crypto.randomUUID();
    const plugins = desired.map(snapshotPlugin); const planDigest = await sha256(canonicalPluginPlan({ host, plugins }));
    if ((timedOut(record.value.build) || record.value.build?.resultUnknown) && record.value.build.planDigest !== planDigest) fail('PLUGIN_BUILD_RESULT_UNKNOWN');
    const registryRevision = Number((await env.DB.prepare('SELECT revision FROM instance_settings WHERE key=?').bind(REGISTRY_KEY).first())?.revision || 0);
    const value = clone(record.value); value.running = running;
    value.build = { id: buildId, planDigest, status: 'triggering', createdAt: now, updatedAt: now, error: null,
      installationLanguages: clone(value.installationLanguages || {}),
      registryRevision, previousDeployment: deployment, previousBuilds: registry.manifests.map(row => ({ id: row.id, sourceDigest: registry.getBuildDigest(row.id) })),
      snapshot: { schemaVersion: 1, buildId, planDigest, host, plugins } };
    if (!secrets.deployHookUrl || !secrets.buildToken) {
      value.build.status = 'failed'; value.build.error = 'PLUGIN_BUILD_NOT_CONFIGURED';
      return publicState(env, await save(env, record, value, { session }));
    }
    record = await save(env, record, value, { session });
    let providerBuildId = null; let workerName = null; let triggerError = null;
    try {
      await requirePluginSession(env, session, true);
      const response = await fetchImpl(validateDeployHookUrl(secrets.deployHookUrl), { method: 'POST', redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const body = await boundedJson(response, 32768);
      if (!response.ok || body.success !== true || typeof body.result?.build_uuid !== 'string'
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.result.build_uuid)) throw new Error('trigger_failed');
      providerBuildId = body.result.build_uuid;
      if (typeof body.result.worker === 'string' && /^[a-zA-Z0-9_-]{1,63}$/.test(body.result.worker)) workerName = body.result.worker;
    } catch (error) { triggerError = error?.code === 'forbidden' ? 'forbidden' : 'PLUGIN_BUILD_TRIGGER_FAILED'; }
    // A fast build may have already reported progress while the hook request was
    // returning. Never overwrite that newer state with an old queued response.
    const latest = await read(env);
    if (latest.value.build?.id !== buildId) return publicState(env, latest);
    const next = clone(latest.value);
    if (next.build.status === 'triggering') {
      next.build.status = triggerError ? 'failed' : 'queued'; next.build.error = triggerError; next.build.updatedAt = Date.now();
      // Network errors cannot prove the provider did not start a job.
      next.build.resultUnknown = Boolean(triggerError && triggerError !== 'forbidden');
    }
    if (providerBuildId) next.build.providerBuildId = providerBuildId;
    if (workerName) next.build.workerName = workerName;
    return publicState(env, await save(env, latest, next));
  }
  async function pipeline(env, request) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('Authorization') || '');
    if (!match) fail('forbidden', 403);
    const record = await read(env);
    const secrets = record.value.secrets ? await openDeliverySecrets(env, record.value.secrets) : {};
    if (!secrets.buildToken) fail('forbidden', 403);
    const submitted = await sha256(match[1]); const expected = await sha256(secrets.buildToken);
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ submitted.charCodeAt(index);
    if (difference) fail('forbidden', 403);
    return record;
  }
  async function snapshot(env, request) {
    const record = await pipeline(env, request);
    if (!record.value.build || (!ACTIVE_PLUGIN_BUILDS.has(record.value.build.status) && record.value.build.status !== 'deployed')) fail('PLUGIN_BUILD_NOT_ACTIVE');
    const build = record.value.build;
    return { ...clone(build.snapshot), buildStatus: build.status, baseDeployment: build.previousDeployment?.buildId
      ? { buildId: build.previousDeployment.buildId, planDigest: build.previousDeployment.planDigest } : null,
    ...(build.workerName ? { target: { workerName: build.workerName } } : {}) };
  }
  async function upgradeState(env, record) {
    if (!validHost(host)) fail('PLUGIN_BUILD_HOST_UNKNOWN', 503);
    const registryRevision = Number((await env.DB.prepare('SELECT revision FROM instance_settings WHERE key=?').bind(REGISTRY_KEY).first())?.revision || 0);
    const plugins = (await runningFor(env, record)).map(snapshotPlugin);
    const after = Number((await env.DB.prepare('SELECT revision FROM instance_settings WHERE key=?').bind(REGISTRY_KEY).first())?.revision || 0);
    if (after !== registryRevision) fail('PLUGIN_DELIVERY_CHANGED');
    return { schemaVersion: 1, revision: record.revision, registryRevision, host, plugins,
      runningDigest: await sha256(canonicalPluginPlan({ host, plugins })),
      pending: record.value.desired !== null
        && canonicalPluginPlan({ host, plugins: record.value.desired.map(snapshotPlugin) }) !== canonicalPluginPlan({ host, plugins }),
      build: record.value.build ? { id: record.value.build.id, planDigest: record.value.build.planDigest,
        status: record.value.build.status, host: record.value.build.snapshot?.host,
        resultUnknown: Boolean(timedOut(record.value.build) || record.value.build.resultUnknown) } : null };
  }
  async function upgrade(env, request, input) {
    const record = await pipeline(env, request);
    const state = await upgradeState(env, record);
    if (input === undefined) return state;
    if (!knownKeys(input, ['revision', 'registryRevision', 'fromHost', 'runningDigest', 'host'])
      || !validRevision(input.revision) || !validRevision(input.registryRevision)
      || !validHost(input.fromHost) || !validHost(input.host)
      || !/^[a-f0-9]{64}$/.test(input.runningDigest || '')) fail('invalid_input', 400);
    if (input.revision !== state.revision || input.registryRevision !== state.registryRevision
      || canonicalPluginManifest(input.fromHost) !== canonicalPluginManifest(host)
      || input.runningDigest !== state.runningDigest) fail('PLUGIN_DELIVERY_CHANGED');
    assertEditable(record);
    if (state.pending) fail('PLUGIN_UPGRADE_PENDING_CHANGES');
    if (canonicalPluginManifest(input.host) === canonicalPluginManifest(host)) fail('PLUGIN_HOST_UNCHANGED');
    if (compareHostVersion(input.host.version, host.version) < 0) fail('PLUGIN_HOST_DOWNGRADE_UNSUPPORTED');
    if (state.plugins.some(row => row.source.type !== 'artifact')) fail('PLUGIN_UPGRADE_ARTIFACT_REQUIRED');
    validateSelection(state.plugins);
    const now = Date.now(), buildId = crypto.randomUUID();
    const planDigest = await sha256(canonicalPluginPlan({ host: input.host, plugins: state.plugins }));
    const value = clone(record.value);
    value.running = await runningFor(env, record);
    value.desired = clone(value.running);
    value.build = { id: buildId, planDigest, kind: 'host-upgrade', status: 'queued', createdAt: now, updatedAt: now, error: null,
      registryRevision: state.registryRevision, previousHost: clone(host), previousDeployment: deployment,
      previousBuilds: registry.manifests.map(row => ({ id: row.id, sourceDigest: registry.getBuildDigest(row.id) })),
      snapshot: { schemaVersion: 1, buildId, planDigest, host: clone(input.host), plugins: state.plugins } };
    await save(env, record, value, { registryRevision: state.registryRevision });
    return snapshot(env, request);
  }
  async function report(env, request, input) {
    const record = await pipeline(env, request); const build = record.value.build;
    if (!knownKeys(input, ['buildId', 'planDigest', 'status']) || !['building', 'deploying', 'rolling_back', 'activation_pending', 'failed', 'rolled_back', 'deployed'].includes(input.status)
      || !build || input.buildId !== build.id || input.planDigest !== build.planDigest) fail('PLUGIN_BUILD_CHANGED');
    if (build.status === 'cancelled') fail('PLUGIN_BUILD_CHANGED');
    if (build.status === 'deployed') {
      if (input.status !== 'deployed') fail('PLUGIN_BUILD_CHANGED');
      assertDeployedBuild(build.snapshot);
      return { ok: true, status: 'deployed' };
    }
    if (!ACTIVE_PLUGIN_BUILDS.has(build.status)) fail('PLUGIN_BUILD_NOT_ACTIVE');
    // Claiming rollback and activating the plan share the same revision guard.
    // Once rollback wins, no executor may commit new data against old code.
    if (build.rollbackStarted && !['rolling_back', 'rolled_back', 'activation_pending', 'failed'].includes(input.status)) fail('PLUGIN_BUILD_CHANGED');
    if (input.status === 'deployed') return activate(env, record);
    const value = clone(record.value);
    if (['deploying', 'rolling_back', 'activation_pending'].includes(input.status)) value.build.deploymentStarted = true;
    if (input.status === 'rolling_back') {
      value.build.rollbackStarted = true; value.build.status = 'rolling_back'; value.build.error = null; value.build.resultUnknown = false;
    } else if (input.status === 'rolled_back') {
      if (!build.rollbackStarted) fail('PLUGIN_BUILD_CHANGED');
      if (canonicalPluginManifest(deployment) !== canonicalPluginManifest(build.previousDeployment)
        || canonicalPluginManifest(host) !== canonicalPluginManifest(build.previousHost || build.snapshot.host)
        || canonicalPluginManifest(registry.manifests.map(row => ({ id: row.id, sourceDigest: registry.getBuildDigest(row.id) }))) !== canonicalPluginManifest(build.previousBuilds)) fail('PLUGIN_ROLLBACK_NOT_CONFIRMED');
      value.build.status = 'failed'; value.build.error = 'PLUGIN_BUILD_ROLLED_BACK'; value.build.resultUnknown = false;
    } else if (input.status === 'activation_pending' || (input.status === 'failed' && ['deploying', 'rolling_back', 'activation_pending'].includes(build.status))) {
      value.build.status = 'activation_pending'; value.build.error = 'PLUGIN_DEPLOYMENT_UNCONFIRMED'; value.build.resultUnknown = true;
    } else {
      // Reports may advance progress but cannot pretend a deployment is merely
      // building again, which would erase its uncertainty boundary.
      if (['deploying', 'activation_pending'].includes(build.status) && input.status === 'building') fail('PLUGIN_BUILD_CHANGED');
      value.build.status = input.status; value.build.error = input.status === 'failed' ? 'PLUGIN_BUILD_FAILED' : null; value.build.resultUnknown = false;
    }
    value.build.updatedAt = Date.now();
    await save(env, record, value);
    return { ok: true, status: input.status };
  }
  function assertDeployedBuild(snapshot) {
    if (!deployment || deployment.buildId !== snapshot.buildId || deployment.planDigest !== snapshot.planDigest
      || canonicalPluginManifest(host) !== canonicalPluginManifest(snapshot.host)
      || canonicalPluginManifest(deployment.host) !== canonicalPluginManifest(snapshot.host)
      || canonicalPluginManifest(deployment.plugins) !== canonicalPluginManifest(snapshot.plugins.map(({ id, version, source }) => ({ id, version, source })))) fail('PLUGIN_DEPLOYMENT_NOT_READY');
    for (const row of snapshot.plugins) {
      const compiled = registry.manifests.find(manifest => manifest.id === row.id);
      if (!compiled || canonicalPluginManifest(compiled) !== canonicalPluginManifest(row.manifest)
        || (row.source.type === 'workspace' && registry.getBuildDigest(row.id) !== row.source.sourceDigest)) fail('PLUGIN_DEPLOYMENT_NOT_READY');
    }
  }
  async function activate(env, record) {
    const snapshot = record.value.build.snapshot;
    if (!ACTIVE_PLUGIN_BUILDS.has(record.value.build.status) || !Array.isArray(record.value.desired)
      || canonicalPluginPlan({ host: snapshot.host, plugins: record.value.desired.map(snapshotPlugin) }) !== canonicalPluginPlan(snapshot)) fail('PLUGIN_BUILD_CHANGED');
    assertDeployedBuild(snapshot);
    validateSelection(snapshot.plugins);
    const coordinator = await env.DB.prepare('SELECT revision FROM instance_settings WHERE key=?').bind(REGISTRY_KEY).first();
    if (Number(coordinator?.revision || 0) !== record.value.build.registryRevision) fail('PLUGIN_DELIVERY_CHANGED');
    const installations = (await env.DB.prepare("SELECT key,value_json,revision FROM instance_settings WHERE key LIKE 'plugin.installation.%'").all()).results || [];
    const migrations = [];
    for (const row of snapshot.plugins) {
      const definitions = registry.getMigrations(row.id);
      if ((row.manifest.dataVersion ?? definitions.length) !== definitions.length) fail('PLUGIN_DATA_VERSION_UNSUPPORTED');
      migrations.push(await preparePluginMigrations(env, row.id, definitions));
    }
    const value = clone(record.value);
    value.running = snapshot.plugins.map(row => ({ ...clone(row), sourceId: row.source.id,
      sourceName: record.value.desired.find(item => item.id === row.id)?.sourceName || row.source.id }));
    value.desired = null;
    value.activeDeployment = { buildId: snapshot.buildId, planDigest: snapshot.planDigest };
    value.build.status = 'deployed'; value.build.updatedAt = Date.now(); value.build.error = null; value.build.resultUnknown = false;
    const now = Date.now(); const operation = JSON.stringify({ operationId: crypto.randomUUID() });
    const statements = [env.DB.prepare(`UPDATE instance_settings SET value_json=?,revision=revision+1,updated_at=?,updated_by='plugin-build'
      WHERE key=? AND revision=? AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?`)
      .bind(JSON.stringify(value), now, PLUGIN_DELIVERY_KEY, record.revision, REGISTRY_KEY, Number(coordinator?.revision || 0)),
    env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM instance_settings WHERE key=? AND revision=? AND value_json=?)
      THEN 1 ELSE json_extract('invalid', '$.plugin_delivery_guard') END AS guarded`).bind(PLUGIN_DELIVERY_KEY, record.revision + 1, JSON.stringify(value)),
    env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,'plugin-build')
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(REGISTRY_KEY, operation, now)];
    for (const migration of migrations) {
      statements.push(env.DB.prepare(`SELECT CASE WHEN COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
        THEN 1 ELSE json_extract('invalid', '$.plugin_delivery_migration_guard') END AS guarded`).bind(migration.key, migration.revision));
      statements.push(...migration.statements.map(sql => env.DB.prepare(sql)));
      if (migration.changed) statements.push(env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,'plugin-build')
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .bind(migration.key, JSON.stringify({ completed: migration.completed }), now));
    }
    const desired = new Set(snapshot.plugins.map(row => row.id));
    const ids = new Set([...installations.map(row => row.key.slice('plugin.installation.'.length)), ...desired]);
    for (const id of ids) {
      const previous = installations.find(row => row.key === installationKey(id));
      let saved = {};
      try { saved = JSON.parse(previous?.value_json || '{}'); } catch { /* Invalid state receives a new epoch. */ }
      const installed = desired.has(id);
      // Host upgrades inherit installation records as well as package bytes.
      // Registry/build fingerprints already invalidate old invocations; there
      // is no install/uninstall operation that should rotate an epoch here.
      if (record.value.build.kind === 'host-upgrade') {
        if (installed !== (saved.installed === true)) fail('PLUGIN_DELIVERY_CHANGED');
        continue;
      }
      const epoch = installed && saved.installed && /^[0-9a-f-]{36}$/.test(saved.epoch || '') ? saved.epoch : crypto.randomUUID();
      if (!installed && saved.installed !== true) continue;
      statements.push(env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,'plugin-build')
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .bind(installationKey(id), JSON.stringify({ installed, epoch,
          ...(installed && !saved.installed
            ? { uiLanguage: normalizePluginUiLanguage(record.value.build.installationLanguages?.[id] || saved.uiLanguage) }
            : saved.uiLanguage ? { uiLanguage: normalizePluginUiLanguage(saved.uiLanguage) } : {}) }), now));
    }
    try { await env.DB.batch(statements); } catch { fail('PLUGIN_BUILD_APPLY_FAILED'); }
    return { ok: true, status: 'deployed' };
  }
  return Object.freeze({ get, configure, addSource, refreshSource, removeSource, select, discard, resolveBuild, startBuild, snapshot, upgrade, report });
}

export const pluginDelivery = createPluginDelivery();
