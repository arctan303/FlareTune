import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPluginHostBuild } from '../plugins/host-identity.mjs';
import { HOST_PLUGIN_API_VERSION } from '../../shared/plugins/manifest.js';
import { createReleaseNotes } from './prepare-notes.mjs';

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
    source: { url: `https://codeload.github.com/arctan303/FlareTune/tar.gz/${commit}`, sha256: sourceSha256 },
    migration: { compatible: true }, channel };
}
export async function buildUpdateManifest({ directory = root, commit, channel = 'stable', sourceBytes, fetchImpl = fetch } = {}) {
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
  return createUpdateManifest({ version: packageJson.version, commit, host: await createPluginHostBuild(directory),
    sourceSha256: hash(bytes), notes, channel });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  try {
    const output = argument('--output'); if (!output) throw Error('An output file is required');
    const manifest = await buildUpdateManifest({ commit: argument('--commit'), channel: argument('--channel') || 'stable' });
    await writeFile(resolve(output), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ id: manifest.id, host: manifest.host, channel: manifest.channel }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
