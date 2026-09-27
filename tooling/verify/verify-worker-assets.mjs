import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, lstat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const extensions = new Set(['.html', '.js', '.css', '.json', '.txt', '.xml', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.webmanifest']);
const metadata = new Set(['.assetsignore', '_headers', '_redirects']);
const publicFiles = new Set(['index.html', '404.html', 'manifest.json', 'robots.txt', 'placeholder-album.svg', 'collection-star.svg', 'favicon.svg', 'favicon.png', 'favicon.ico', 'arc.png']);
export async function verifyWorkerAssets(directory = resolve(root, 'dist')) {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const absolute = resolve(folder, entry.name);
      const name = relative(directory, absolute).replaceAll('\\', '/');
      assert.ok(!(await lstat(absolute)).isSymbolicLink(), `Asset symlink forbidden: ${name}`);
      assert.doesNotMatch(name, /(?:^|\/)(?:_worker\.js(?:\.|$)|server|worker|node_modules|\.git|\.env[^/]*|\.dev\.vars[^/]*)|\.(?:sql|toml|map|pem|key|bak)$/i, `Private asset forbidden: ${name}`);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      assert.ok(metadata.has(name) || extensions.has(extname(name)), `Unclassified asset: ${name}`);
      assert.ok(metadata.has(name) || publicFiles.has(name) || /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(name), `Unclassified public path: ${name}`);
      const size = (await stat(absolute)).size;
      assert.ok(size <= 25 * 1024 * 1024, `Asset exceeds 25 MiB: ${name}`);
      files.push({ path: name, size, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
    }
  }
  await visit(directory);
  for (const required of ['index.html', '404.html', '.assetsignore', '_headers']) assert.ok(files.some(f => f.path === required), `Missing ${required}`);
  assert.ok(files.length <= 20000, 'Assets exceed conservative free-plan file limit');
  files.sort((a,b) => a.path.localeCompare(b.path));
  return files;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = await verifyWorkerAssets();
  console.log(JSON.stringify({ assets: files, total: files.length }, null, 2));
}
