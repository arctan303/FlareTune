import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createPluginHostBuild } from '../plugins/host-identity.mjs';
import { HOST_PLUGIN_API_VERSION } from '../../shared/plugins/manifest.js';
import { createReleaseNotes } from './prepare-notes.mjs';
import { releaseSourceUrl, SOURCE_ARCHIVE_NAME, RELEASE_MANIFEST_NAME } from '../../server/src/systemUpdate/releases.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function createUpdateManifest({ version, commit, host, sourceSha256, notes, channel = 'stable', minVersion = '1.2.1', hostApiVersion = HOST_PLUGIN_API_VERSION }) {
  const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!versionPattern.test(version || '') || !versionPattern.test(minVersion || '') || !/^[a-f0-9]{40}$/.test(commit || '')
    || host?.version !== version || !/^[a-f0-9]{64}$/.test(host.sourceDigest || '') || !/^[a-f0-9]{64}$/.test(sourceSha256 || '')
    || !['stable', 'candidate'].includes(channel) || !Number.isSafeInteger(hostApiVersion) || hostApiVersion < 1
    || !notes || !['zh', 'en'].every(key => typeof notes[key] === 'string' && notes[key].length > 0 && notes[key].length <= 16000)) {
    throw Error('Invalid immutable system update manifest input');
  }
  return { schemaVersion: 1, id: `${version}:${commit}`, version, commit, host, hostApiVersion, minVersion, notes,
    source: { url: releaseSourceUrl(version, commit, channel), sha256: sourceSha256 },
    migration: { compatible: true }, channel };
}
async function immutableInputs(directory, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Error('An exact commit is required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8', windowsHide: true }).trim();
  if (head !== commit) throw Error('Update manifest must describe the checked-out immutable commit');
  const changes = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: directory, encoding: 'utf8', windowsHide: true });
  if (changes) throw Error('Update manifest requires a clean checkout of the immutable commit');
  const packageJson = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(resolve(directory, 'package-lock.json'), 'utf8'));
  const chinese = await readFile(resolve(directory, 'CHANGELOG.md'), 'utf8');
  const english = await readFile(resolve(directory, 'CHANGELOG.en.md'), 'utf8');
  const fullNotes = createReleaseNotes({ tag: packageJson.version, packageJson, lockfile, chinese, english });
  const notes = { zh: fullNotes.split('## 简体中文\n\n')[1].split('\n\n---\n\n## English\n\n')[0],
    en: fullNotes.split('\n\n---\n\n## English\n\n')[1].trim() };
  return { version: packageJson.version, commit, host: await createPluginHostBuild(directory), notes };
}
export async function buildUpdateManifest({ directory = root, commit, channel = 'stable', sourceBytes, archiveOutput, fetchImpl = fetch } = {}) {
  const inputs = await immutableInputs(directory, commit);
  let bytes = sourceBytes;
  if (!bytes) {
    const response = await fetchImpl(`https://codeload.github.com/arctan303/FlareTune/tar.gz/${commit}`, {
      redirect: 'error', signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'FlareTune-Release' },
    });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 64 * 1024 * 1024) throw Error('Source archive unavailable');
    const parts = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 64 * 1024 * 1024) throw Error('Source archive too large'); parts.push(part); }
    bytes = Buffer.concat(parts);
  }
  if (!bytes?.length || bytes.length > 64 * 1024 * 1024) throw Error('Source archive has an invalid size');
  const manifest = createUpdateManifest({ ...inputs, sourceSha256: hash(bytes), channel });
  if (archiveOutput) await writeFile(resolve(archiveOutput), bytes, { flag: 'wx' });
  return manifest;
}
export async function verifyExistingUpdateAssets({ directory = root, commit, assetDirectory } = {}) {
  const inputs = await immutableInputs(directory, commit);
  const manifestBytes = await readFile(resolve(assetDirectory, RELEASE_MANIFEST_NAME));
  const sourceBytes = await readFile(resolve(assetDirectory, SOURCE_ARCHIVE_NAME));
  if (manifestBytes.length > 65536 || !sourceBytes.length || sourceBytes.length > 64 * 1024 * 1024) throw Error('Existing update assets have an invalid size');
  const expected = createUpdateManifest({ ...inputs, sourceSha256: hash(sourceBytes) });
  if (!isDeepStrictEqual(JSON.parse(manifestBytes.toString('utf8')), expected)) throw Error('Existing immutable update assets differ from the release commit');
  return expected;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  try {
    const existing = argument('--verify-existing');
    if (existing) {
      const manifest = await verifyExistingUpdateAssets({ commit: argument('--commit'), assetDirectory: existing });
      console.log(JSON.stringify({ id: manifest.id, status: 'existing-assets-verified' }));
    } else {
      const output = argument('--output'); if (!output) throw Error('An output file is required');
      const channel = argument('--channel') || 'stable', archiveOutput = argument('--archive-output');
      if (channel === 'stable' && !archiveOutput) throw Error('Stable releases require a source archive output');
      const manifest = await buildUpdateManifest({ commit: argument('--commit'), channel, archiveOutput });
      await writeFile(resolve(output), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ id: manifest.id, host: manifest.host, channel: manifest.channel }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
