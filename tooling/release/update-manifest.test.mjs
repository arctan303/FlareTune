import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildUpdateManifest, createUpdateManifest } from './update-manifest.mjs';
import { validateRelease } from '../../server/src/systemUpdate/releases.js';

const input = () => ({ version: '1.3.0', commit: 'a'.repeat(40), host: { version: '1.3.0', sourceDigest: 'b'.repeat(64) },
  sourceSha256: 'c'.repeat(64), notes: { zh: '后台系统更新', en: 'System updates' } });
test('release publisher output is consumable by the real update discovery contract', () => {
  const manifest = createUpdateManifest(input()); assert.deepEqual(validateRelease(manifest), manifest);
  assert.equal(manifest.source.url, 'https://codeload.github.com/arctan303/FlareTune/tar.gz/' + 'a'.repeat(40));
});
test('candidate is explicit and cannot masquerade as a stable release', () => {
  const manifest = createUpdateManifest({ ...input(), channel: 'candidate' });
  assert.deepEqual(validateRelease(manifest, { channel: 'candidate' }), manifest);
  assert.throws(() => validateRelease(manifest));
});
test('publisher refuses floating refs, mismatched host versions and incomplete bilingual notes', () => {
  for (const changed of [{ commit: 'main' }, { host: { version: '1.2.1', sourceDigest: 'b'.repeat(64) } }, { sourceSha256: 'latest' }, { notes: { zh: '只有中文' } }]) {
    assert.throws(() => createUpdateManifest({ ...input(), ...changed }));
  }
});

test('archive and host metadata must come from the same clean Git commit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-update-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true }).trim();
  await mkdir(join(directory, 'server/src'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '1.3.0' }));
  await writeFile(join(directory, 'package-lock.json'), JSON.stringify({ version: '1.3.0', packages: { '': { version: '1.3.0' } } }));
  await writeFile(join(directory, 'CHANGELOG.md'), '# 更新日志\n\n## 1.3.0 — 2026-11-14\n\n系统更新。\n');
  await writeFile(join(directory, 'CHANGELOG.en.md'), '# Changelog\n\n## 1.3.0 — 2026-11-14\n\nSystem updates.\n');
  await writeFile(join(directory, 'server/src/host.js'), 'export const version = 1;\n');
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.com', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD'), options = { directory, commit, sourceBytes: Buffer.from('archive') };
  assert.equal((await buildUpdateManifest(options)).commit, commit);
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
