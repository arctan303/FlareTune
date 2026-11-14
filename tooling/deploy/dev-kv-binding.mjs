import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const cli = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kvId = /^[0-9a-f]{32}$/i;
function readMetadata(args) {
  // Use Wrangler's existing auth provider. Never extract, print or persist its
  // credentials or the complete version metadata (which may contain variables).
  const result = spawnSync(process.execPath, [cli, ...args, '--name', 'flaretune-dev', '--json'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('Cannot inspect development bindings; refusing to remove YTM_KV.');
  try { return JSON.parse(result.stdout); } catch { throw new Error('Invalid development binding metadata.'); }
}
export function developmentVersionId(deployments) {
  if (!Array.isArray(deployments) || !deployments.length) throw new Error('No development deployment found.');
  const latest = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  const active = (latest.versions || []).filter(value => value.percentage > 0);
  if (active.length !== 1 || active[0].percentage !== 100 || !uuid.test(active[0].version_id || '')) {
    throw new Error('Development rollout is ambiguous; set FLARETUNE_DEV_YTM_KV_ID explicitly.');
  }
  return active[0].version_id;
}
export function developmentKvBinding(version) {
  const bindings = (version?.resources?.bindings || []).filter(value => value.name === 'YTM_KV');
  if (bindings.length !== 1 || bindings[0].type !== 'kv_namespace' || !kvId.test(bindings[0].namespace_id || '')) {
    throw new Error('Development YTM_KV is not configured; bind it or set FLARETUNE_DEV_YTM_KV_ID.');
  }
  return bindings[0].namespace_id;
}
export function resolveDevelopmentKv({ configured = process.env.FLARETUNE_DEV_YTM_KV_ID, read = readMetadata } = {}) {
  if (configured !== undefined) {
    if (!kvId.test(configured)) throw new Error('Invalid FLARETUNE_DEV_YTM_KV_ID.');
    return configured;
  }
  const versionId = developmentVersionId(read(['deployments', 'list']));
  return developmentKvBinding(read(['versions', 'view', versionId]));
}
