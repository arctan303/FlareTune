import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Runtime, resources, schema and build configuration are part of the host.
// Delivery output is excluded so choosing plugins cannot change host identity.
const roots = ['client/src', 'client/public', 'server/src', 'server/db/migrations-flaretune', 'shared',
  'tooling/build', 'tooling/plugins', 'tooling/verify', 'tooling/deploy'];
const configuration = ['package.json', 'package-lock.json', 'wrangler.toml', 'client/index.html',
  'client/vite.config.js', 'client/tailwind.config.js', 'client/postcss.config.js'];
const ignored = name => name.startsWith('.') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
  || /\.generated\.(?:[cm]?js|json)$/.test(name) || name.endsWith('.tmp');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function collectPluginHostSources(root) {
  const files = new Set();
  async function visit(path, optional = false) {
    let stat;
    try { stat = await lstat(resolve(root, path)); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('PLUGIN_HOST_SYMLINK_UNSUPPORTED');
    if (stat.isDirectory()) {
      for (const entry of await readdir(resolve(root, path))) if (!ignored(entry) && entry !== 'test' && entry !== 'node_modules') await visit(`${path}/${entry}`);
    } else if (stat.isFile()) files.add(path);
  }
  for (const path of roots) await visit(path, true);
  for (const path of configuration) await visit(path, path !== 'package.json');
  const sources = [];
  for (const path of [...files].sort()) sources.push({ path, sha256: sha256(await readFile(resolve(root, path))) });
  return sources;
}

export async function createPluginHostBuild(root) {
  const sources = await collectPluginHostSources(root);
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  return { version, sourceDigest: sha256(JSON.stringify(sources)) };
}
