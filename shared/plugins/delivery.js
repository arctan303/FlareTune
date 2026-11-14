import { canonicalPluginManifest, validatePluginManifests } from './manifest.js';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
export const OFFICIAL_PLUGIN_SOURCE = Object.freeze({ id: 'official', name: 'FlareTune',
  url: 'https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/main/repository.json', official: true });
export const ACTIVE_PLUGIN_BUILDS = new Set(['triggering', 'queued', 'building', 'deploying', 'rolling_back', 'activation_pending']);
export const PLUGIN_BUILD_TIMEOUT = 30 * 60 * 1000;

export function canonicalPluginPlan({ host, plugins }) {
  return JSON.stringify({ host: JSON.parse(canonicalPluginManifest(host)), plugins: [...plugins].sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, version, manifest, source }) => ({ id, version,
      manifest: JSON.parse(canonicalPluginManifest(manifest)), source: JSON.parse(canonicalPluginManifest(source)) })) });
}

// Sources contain public package metadata. Local hosts, literal addresses,
// credentials and redirects are deliberately outside this protocol.
export function validatePublicHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) fail('PLUGIN_URL_INVALID');
  let url;
  try { url = new URL(value); } catch { fail('PLUGIN_URL_INVALID'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || !host.includes('.') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
    || host.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)
    || /^\d+(?:\.\d+)*$/.test(host) || /(?:^|\.)(?:nip\.io|sslip\.io|localtest\.me|lvh\.me)$/.test(host)) fail('PLUGIN_URL_INVALID');
  return url.href;
}

export function validateDeployHookUrl(value) {
  const normalized = validatePublicHttpsUrl(value);
  const url = new URL(normalized);
  if (url.origin !== 'https://api.cloudflare.com' || url.search
    || !/^\/client\/v4\/workers\/builds\/deploy_hooks\/[a-zA-Z0-9_-]{16,160}$/.test(url.pathname)) fail('PLUGIN_DEPLOY_HOOK_INVALID');
  return normalized;
}

export function validatePluginDirectory(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.id !== 'string'
    || !/^[a-z][a-z0-9-]{0,79}$/.test(value.id) || typeof value.name !== 'string'
    || !value.name.trim() || value.name.length > 120 || !Array.isArray(value.plugins) || value.plugins.length > 128) fail('PLUGIN_SOURCE_INVALID');
  const identities = new Set();
  const plugins = value.plugins.map(entry => {
    try { validatePluginManifests([entry?.manifest]); } catch { fail('PLUGIN_SOURCE_INVALID'); }
    const key = `${entry.manifest.id}@${entry.manifest.version}`;
    if (identities.has(key) || !entry.artifact || !/^[a-f0-9]{64}$/.test(entry.artifact.sha256 || '')) fail('PLUGIN_SOURCE_INVALID');
    identities.add(key);
    return { manifest: JSON.parse(JSON.stringify(entry.manifest)), artifact: {
      url: validatePublicHttpsUrl(entry.artifact.url), sha256: entry.artifact.sha256,
    } };
  });
  return { schemaVersion: 1, id: value.id, name: value.name.trim(), plugins };
}

export function pluginSelectionChanges(running, desired) {
  const previous = new Map(running.map(row => [row.id, row]));
  const next = new Map(desired.map(row => [row.id, row]));
  return [...new Set([...previous.keys(), ...next.keys()])].sort().flatMap(id => {
    const from = previous.get(id), to = next.get(id);
    if (from && to && from.version === to.version && JSON.stringify(from.source) === JSON.stringify(to.source)) return [];
    return [{ id, operation: !from ? 'install' : !to ? 'uninstall' : 'update',
      fromVersion: from?.version || null, toVersion: to?.version || null }];
  });
}
