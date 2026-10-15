import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { publishIngest } from './publish-ingest.mjs';

const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'flaretune-npm-publish-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith('flaretune-npm-publish-test-'));
    await rm(temp, { recursive: true, force: true });
  });
  const artifact = join(temp, 'candidate.tgz');
  const bytes = Buffer.from('isolated publication fixture');
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const metadata = { name: 'flaretune-ingest', version, dist: { integrity } };
  await writeFile(artifact, bytes);
  await writeFile(artifact + '.json', JSON.stringify({ ...metadata, integrity }));
  return { artifact, releaseTag: version, metadata };
}

test('new npm version publishes once and reads back the exact artifact', async (t) => {
  const candidate = await fixture(t);
  let published = false;
  const result = await publishIngest({ ...candidate,
    fetchImpl: async () => published ? Response.json(candidate.metadata) : new Response('', { status: 404 }),
    publishImpl: async (path) => { assert.equal(path, candidate.artifact); published = true; },
  });
  assert.equal(result.status, 'published');
});

test('same-version recovery accepts only identical registry integrity without another publish', async (t) => {
  const candidate = await fixture(t);
  const result = await publishIngest({ ...candidate, fetchImpl: async () => Response.json(candidate.metadata),
    publishImpl: () => assert.fail('must not publish again') });
  assert.equal(result.status, 'already-published');
  await assert.rejects(publishIngest({ ...candidate,
    fetchImpl: async () => Response.json({ ...candidate.metadata, dist: { integrity: 'different' } }),
    publishImpl: () => assert.fail('must not replace an existing version') }), /different artifact/);
});

test('registry errors, tampered tarballs and mismatched versions stop before publication', async (t) => {
  const candidate = await fixture(t);
  for (const status of [401, 429, 500]) {
    await assert.rejects(publishIngest({ ...candidate, fetchImpl: async () => new Response('', { status }),
      publishImpl: () => assert.fail('failed lookup must not publish') }), /lookup failed/);
  }
  await assert.rejects(publishIngest({ ...candidate, releaseTag: version + '-bootstrap.0' }), /match/);
  await writeFile(candidate.artifact, 'tampered');
  await assert.rejects(publishIngest({ ...candidate, publishImpl: () => assert.fail('tampered artifact') }), /changed after packing/);
});

test('successful publish with missing registry readback remains a recoverable failure', async (t) => {
  const candidate = await fixture(t);
  let attempts = 0;
  await assert.rejects(publishIngest({ ...candidate, fetchImpl: async () => new Response('', { status: 404 }),
    readbackAttempts: 3, waitForVisibility: async () => {},
    publishImpl: () => { attempts += 1; } }), /not readable/);
  assert.equal(attempts, 1);
});

test('npm scan delay waits for visibility and validates the eventual artifact without publishing twice', async (t) => {
  const candidate = await fixture(t);
  let published = 0, reads = 0, waits = 0;
  const result = await publishIngest({ ...candidate, readbackAttempts: 4,
    fetchImpl: async () => {
      reads += 1;
      return reads < 4 ? new Response('', { status: 404 }) : Response.json(candidate.metadata);
    },
    waitForVisibility: async () => { waits += 1; }, publishImpl: () => { published += 1; } });
  assert.equal(result.status, 'published');
  assert.equal(published, 1);
  assert.equal(waits, 2);
});
