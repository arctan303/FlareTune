import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runNpm } from '../ingest-agent/npm-cli.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function publishIngest({ artifact, releaseTag, fetchImpl = fetch,
  readbackAttempts = 61, waitForVisibility = () => delay(15_000),
  publishImpl = (path) => runNpm(['publish', path, '--access', 'public', '--tag', 'latest', '--ignore-scripts',
    '--registry=https://registry.npmjs.org/', '--cache', join(root, '.tmp/npm-ingest-cache')]) }) {
  const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.match(releaseTag, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(releaseTag, app.version, 'Release tag must match the application version');
  assert.ok(Number.isInteger(readbackAttempts) && readbackAttempts >= 1 && readbackAttempts <= 61);
  const receipt = JSON.parse(await readFile(artifact + '.json', 'utf8'));
  assert.equal(receipt.name, 'flaretune-ingest');
  assert.equal(receipt.version, releaseTag);
  const integrity = 'sha512-' + createHash('sha512').update(await readFile(artifact)).digest('base64');
  assert.equal(receipt.integrity, integrity, 'The tarball changed after packing');
  const url = `https://registry.npmjs.org/flaretune-ingest/${releaseTag}`;
  const readPublished = async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'error', cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`npm registry lookup failed (${response.status}); publication stopped.`);
    const metadata = await response.json();
    assert.equal(metadata.name, receipt.name);
    assert.equal(metadata.version, releaseTag);
    assert.equal(metadata.dist?.integrity, integrity, 'This npm version already contains a different artifact; never overwrite it.');
    return metadata;
  };
  if (await readPublished()) return { version: releaseTag, status: 'already-published', integrity };
  await publishImpl(artifact);
  // npm scans new uploads before making them installable. A successful upload may initially read as 404.
  for (let attempt = 0; attempt < readbackAttempts; attempt += 1) {
    if (await readPublished()) return { version: releaseTag, status: 'published', integrity };
    if (attempt + 1 < readbackAttempts) await waitForVisibility();
  }
  throw new Error('npm accepted the upload but the version is not readable within the bounded wait; rerun recovery to verify it.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Stable publication runs only in the release workflow.');
  assert.equal(process.env.GITHUB_REPOSITORY, 'arctan303/FlareTune');
  assert.ok(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    || (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF_TYPE === 'tag'));
  const version = runNpm(['--version']).trim().split('.').map(Number);
  assert.ok(version[0] > 11 || (version[0] === 11 && (version[1] > 5 || (version[1] === 5 && version[2] >= 1))),
    'npm 11.5.1+ is required for trusted publishing.');
  const releaseTag = process.env.RELEASE_TAG;
  const artifact = join(root, `output/npm/flaretune-ingest-${releaseTag}.tgz`);
  console.log(JSON.stringify(await publishIngest({ artifact, releaseTag })));
}
