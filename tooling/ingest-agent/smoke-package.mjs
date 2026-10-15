import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNpm } from './npm-cli.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function smokePackage(artifact) {
  const temp = await mkdtemp(join(tmpdir(), 'flaretune-ingest-smoke-'));
  try {
    await writeFile(join(temp, 'package.json'), '{"private":true,"type":"module"}\n');
    await writeFile(join(temp, 'empty.npmrc'), '');
    await mkdir(join(temp, 'config'));
    const env = { ...process.env, APPDATA: join(temp, 'config'), XDG_CONFIG_HOME: join(temp, 'config'),
      NODE_AUTH_TOKEN: '', NPM_TOKEN: '', NPM_CONFIG_USERCONFIG: join(temp, 'empty.npmrc') };
    runNpm(['install', resolve(artifact), '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', '--cache', join(root, '.tmp/npm-ingest-cache')], { cwd: temp, env });
    const directory = join(temp, 'node_modules/flaretune-ingest');
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const cli = join(directory, manifest.bin['flaretune-ingest']);
    const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd: temp, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(run(['--version']).trim(), manifest.version);
    assert.equal(runNpm(['exec', '--offline', '--', 'flaretune-ingest', '--version'], { cwd: temp, env }).trim(), manifest.version);
    assert.match(run(['--help']), /flaretune-ingest.*configure/s);
    const invalid = spawnSync(process.execPath, [cli, 'not-a-command'], { cwd: temp, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Usage:/);
    if (process.platform !== 'darwin') {
      const missing = spawnSync(process.execPath, [cli, 'start'], { cwd: temp, env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /configure/);
    }
    const probe = `import { DatabaseSync } from 'node:sqlite';
      import { parseBuffer } from 'music-metadata';
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE smoke (id INTEGER); INSERT INTO smoke VALUES (1)');
      if (db.prepare('SELECT id FROM smoke').get().id !== 1) throw Error('SQLite failure');
      db.close();
      const wav = Buffer.alloc(48); wav.write('RIFF'); wav.writeUInt32LE(40,4); wav.write('WAVEfmt ',8);
      wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24);
      wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
      wav.write('data',36); wav.writeUInt32LE(4,40);
      const metadata = await parseBuffer(wav, { mimeType: 'audio/wav' });
      if (metadata.format.sampleRate !== 8000) throw Error('Audio metadata failure');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: temp, env, encoding: 'utf8', timeout: 15_000 });
    return { name: manifest.name, version: manifest.version, installed: true, sqlite: true, audioMetadata: true };
  } finally {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith('flaretune-ingest-smoke-'));
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const artifact = process.argv[2] || join(root, `output/npm/flaretune-ingest-${app.version}.tgz`);
  console.log(JSON.stringify(await smokePackage(artifact)));
}
