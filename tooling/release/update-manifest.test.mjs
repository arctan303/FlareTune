import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildUpdateManifest, createUpdateManifest, verifyExistingUpdateAssets } from './update-manifest.mjs';
import { validateRelease } from '../../server/src/systemUpdate/releases.js';

const input = () => ({ version: '1.3.0', commit: 'a'.repeat(40), host: { version: '1.3.0', sourceDigest: 'b'.repeat(64) },
  sourceSha256: 'c'.repeat(64), notes: { zh: '后台系统更新', en: 'System updates' } });
test('release publisher output is consumable by the real update discovery contract', () => {
  const manifest = createUpdateManifest(input()); assert.deepEqual(validateRelease(manifest), manifest);
  assert.equal(manifest.source.url, 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-source.tar.gz');
});
test('candidate is explicit and cannot masquerade as a stable release', () => {
  const manifest = createUpdateManifest({ ...input(), channel: 'candidate' });
  assert.deepEqual(validateRelease(manifest, { channel: 'candidate' }), manifest);
  assert.equal(manifest.source.url, 'https://codeload.github.com/arctan303/FlareTune/tar.gz/' + 'a'.repeat(40));
  assert.throws(() => validateRelease(manifest));
  assert.throws(() => validateRelease({ ...manifest, channel: 'stable' }));
  assert.throws(() => validateRelease({ ...createUpdateManifest(input()), channel: 'candidate' }, { channel: 'candidate' }));
});
test('publisher refuses floating refs, mismatched host versions and incomplete bilingual notes', () => {
  for (const changed of [{ commit: 'main' }, { host: { version: '1.2.1', sourceDigest: 'b'.repeat(64) } }, { sourceSha256: 'latest' }, { notes: { zh: '只有中文' } }]) {
    assert.throws(() => createUpdateManifest({ ...input(), ...changed }));
  }
});

test('archive and host metadata must come from the same clean Git commit', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'flaretune-update-release-'));
  const directory = join(temporary, 'checkout'), assetDirectory = join(temporary, 'assets');
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(assetDirectory, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true }).trim();
  await mkdir(join(directory, 'server/src'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '1.3.0' }));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ version: '1.3.0', packages: { '': { version: '1.3.0' } } }));
  await writeFile(join(directory, 'CHANGELOG.md'), '# 更新日志\n\n## 1.3.0 — 2026-11-14\n\n系统更新。\n');
  await writeFile(join(directory, 'CHANGELOG.en.md'), '# Changelog\n\n## 1.3.0 — 2026-11-14\n\nSystem updates.\n');
  await writeFile(join(directory, 'server/src/host.js'), 'export const version = 1;\n');
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('add', '.');
  git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.com', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD'), options = { directory, commit, sourceBytes: Buffer.from('archive') };
  const archiveOutput = join(assetDirectory, 'flaretune-source.tar.gz');
  const manifest = await buildUpdateManifest({ ...options, archiveOutput });
  assert.equal(manifest.commit, commit);
  assert.deepEqual(await readFile(archiveOutput), options.sourceBytes);
  const manifestPath = join(assetDirectory, 'flaretune-update.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Recovery must reuse the published source bytes'));
  assert.deepEqual(await verifyExistingUpdateAssets({ directory, commit, assetDirectory }), manifest);
  await assert.rejects(buildUpdateManifest({ ...options, archiveOutput }), { code: 'EEXIST' });
  await writeFile(archiveOutput, 'different compression bytes');
  await assert.rejects(verifyExistingUpdateAssets({ directory, commit, assetDirectory }), /differ from the release commit/);
  await writeFile(archiveOutput, options.sourceBytes);
  for (const modified of [{ ...manifest, commit: 'b'.repeat(40) }, { ...manifest, notes: { zh: 'other', en: 'other' } },
    { ...manifest, source: { ...manifest.source, url: manifest.source.url + '?floating' } }]) {
    await writeFile(manifestPath, JSON.stringify(modified));
    await assert.rejects(verifyExistingUpdateAssets({ directory, commit, assetDirectory }), /differ from the release commit/);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(directory, 'server/src/host.js'), 'export const version = 2;\n');
  await assert.rejects(buildUpdateManifest(options), /clean checkout/);
  git('add', '.');
  await assert.rejects(buildUpdateManifest(options), /clean checkout/);
  git('reset', '--hard', '-q', 'HEAD');
  await rm(join(directory, 'server/src/host.js'));
  await assert.rejects(buildUpdateManifest(options), /clean checkout/);
  git('restore', '.');
  await writeFile(join(directory, 'server/src/new.js'), 'export const extra = 1;\n');
  await assert.rejects(buildUpdateManifest(options), /clean checkout/);
});
