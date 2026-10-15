import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runNpm } from './npm-cli.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const packageFiles = ['LICENSE', 'README.md', 'dist/cli.mjs', 'package.json'];

export async function packIngest({ bootstrap = false, outputDirectory = join(root, 'output/npm') } = {}) {
  const app = await json(join(root, 'package.json'));
  const lock = await json(join(root, 'package-lock.json'));
  assert.match(app.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(lock.version, app.version);
  assert.equal(lock.packages[''].version, app.version);
  const template = await json(join(root, 'tooling/ingest-agent/package.template.json'));
  const manifest = { ...template, version: app.version + (bootstrap ? '-bootstrap.0' : ''),
    engines: app.engines, dependencies: { 'music-metadata': lock.packages['node_modules/music-metadata'].version } };
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), 'flaretune-ingest-pack-'));
  try {
    await mkdir(join(staging, 'dist'));
    const result = await build({
      absWorkingDir: root, entryPoints: ['tooling/ingest-agent/cli.mjs'],
      outfile: join(staging, 'dist/cli.mjs'), bundle: true, platform: 'node',
      format: 'esm', target: 'node22.18', packages: 'external', metafile: true,
      define: { __FLARETUNE_INGEST_VERSION__: JSON.stringify(manifest.version) },
    });
    for (const entry of Object.values(result.metafile.outputs)) {
      for (const dependency of entry.imports) {
        assert.ok(dependency.external && (dependency.path.startsWith('node:') || dependency.path === 'music-metadata'),
          `Unexpected package import: ${dependency.path}`);
      }
    }
    await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(staging, 'LICENSE'), await readFile(join(root, 'LICENSE')));
    await writeFile(join(staging, 'README.md'), await readFile(join(root, 'tooling/ingest-agent/npm-README.md')));
    const packed = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', output,
      '--cache', join(root, '.tmp/npm-ingest-cache')], { cwd: staging }))[0];
    assert.deepEqual(packed.files.map((file) => file.path).sort(), packageFiles);
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, manifest.version);
    const receipt = { ...packed, artifact: join(output, packed.filename) };
    await writeFile(join(output, packed.filename + '.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally {
    assert.equal(dirname(resolve(staging)), resolve(tmpdir()));
    assert.ok(basename(staging).startsWith('flaretune-ingest-pack-'));
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(2).every((arg) => arg === '--bootstrap'), 'Usage: npm run ingest:pack [-- --bootstrap]');
  const receipt = await packIngest({ bootstrap: process.argv.includes('--bootstrap') });
  console.log(JSON.stringify(receipt, null, 2));
}
