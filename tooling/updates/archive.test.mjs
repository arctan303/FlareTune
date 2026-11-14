import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inspectSourceArchive, extractSourceArchive, downloadSource, SOURCE_LIMITS } from './archive.mjs';

const COMMIT = 'a'.repeat(40), PREFIX = `FlareTune-${COMMIT}/`;
function releaseTarget(bytes, channel = 'candidate') {
  return { schemaVersion: 1, id: `1.3.0:${COMMIT}`, version: '1.3.0', commit: COMMIT, host: { version: '1.3.0', sourceDigest: 'b'.repeat(64) },
    hostApiVersion: 5, minVersion: '1.3.0', notes: { zh: '更新', en: 'Update' }, migration: { compatible: true }, channel,
    source: { url: channel === 'stable' ? 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-source.tar.gz'
      : `https://codeload.github.com/arctan303/FlareTune/tar.gz/${COMMIT}`, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || ''), header = Buffer.alloc(512);
    header.write(entry.path, 0, 100); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header[156] = (entry.type || '0').charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257); header.write('00', 263);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const base = extra => tar([{ path: `${PREFIX}package.json`, data: '{"version":"1.3.0"}' }, ...extra]);
function pax(key, value) {
  const body = ` ${key}=${value}\n`; let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${length}${body}`;
}
test('a bounded official archive is inspected then extracted without retaining its wrapper directory', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'flaretune-archive-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = base([{ path: `${PREFIX}client/`, type: '5' }, { path: `${PREFIX}client/app.js`, data: 'export const value=42;' }]);
  assert.equal(inspectSourceArchive(bytes, COMMIT).length, 3);
  await extractSourceArchive(bytes, COMMIT, directory);
  assert.equal(await readFile(resolve(directory, 'client/app.js'), 'utf8'), 'export const value=42;');
  assert.equal((await readdir(directory)).includes(`FlareTune-${COMMIT}`), false);
  await assert.rejects(extractSourceArchive(bytes, COMMIT, directory), { code: 'SYSTEM_UPDATE_EXTRACTION_NOT_EMPTY' });
});
test('archive traversal, absolute, Windows aliases, foreign wrappers and duplicate files are rejected before any write', () => {
  for (const path of [`${PREFIX}../escape`, '/absolute', `${PREFIX}client\\escape`, `${PREFIX}C:escape`, `${PREFIX}a./x`,
    `${PREFIX}NUL.txt`, 'Other-repo/package.json', `${PREFIX}package.json`, `${PREFIX}PACKAGE.JSON`]) {
    assert.throws(() => inspectSourceArchive(base([{ path, data: 'bad' }]), COMMIT), { code: 'SYSTEM_UPDATE_ARCHIVE_PATH_INVALID' });
  }
});
test('symlinks, hard links and device entries cannot escape or replace source files', () => {
  for (const type of ['1', '2', '3', '4', '6', 'S', 'L']) assert.throws(() => inspectSourceArchive(base([
    { path: `${PREFIX}unsafe`, type, link: '../../escape' },
  ]), COMMIT), { code: 'SYSTEM_UPDATE_ARCHIVE_LINK_UNSUPPORTED' });
});
test('PAX long paths are supported while linkpath and traversal metadata fail closed', () => {
  const path = `${PREFIX}${'a'.repeat(110)}/index.js`;
  const entries = inspectSourceArchive(base([{ path: 'pax', type: 'x', data: pax('path', path) }, { path: `${PREFIX}short`, data: 'ok' }]), COMMIT);
  assert.equal(entries[1].path, `${'a'.repeat(110)}/index.js`);
  assert.throws(() => inspectSourceArchive(base([{ path: 'pax', type: 'x', data: pax('path', `${PREFIX}../escape`) },
    { path: `${PREFIX}short`, data: 'bad' }]), COMMIT), { code: 'SYSTEM_UPDATE_ARCHIVE_PATH_INVALID' });
  assert.throws(() => inspectSourceArchive(base([{ path: 'pax', type: 'x', data: pax('linkpath', '/etc/passwd') }]), COMMIT), { code: 'SYSTEM_UPDATE_ARCHIVE_INVALID' });
});
test('checksum corruption, compressed bombs, excessive entries and file-parent collisions fail', () => {
  const bytes = base([{ path: `${PREFIX}a`, data: 'parent' }, { path: `${PREFIX}a/b`, data: 'child' }]);
  assert.throws(() => inspectSourceArchive(bytes, COMMIT), { code: 'SYSTEM_UPDATE_ARCHIVE_PATH_INVALID' });
  assert.throws(() => inspectSourceArchive(base([]), COMMIT, { ...SOURCE_LIMITS, expanded: 1024 }), { code: 'SYSTEM_UPDATE_ARCHIVE_TOO_LARGE_OR_INVALID' });
  assert.throws(() => inspectSourceArchive(base([{ path: `${PREFIX}a`, data: 'x' }]), COMMIT, { ...SOURCE_LIMITS, entries: 1 }), { code: 'SYSTEM_UPDATE_ARCHIVE_PATH_INVALID' });
  assert.throws(() => inspectSourceArchive(base([{ path: `${PREFIX}a`, data: 'long' }]), COMMIT, { ...SOURCE_LIMITS, file: 1 }), { code: 'SYSTEM_UPDATE_ARCHIVE_TOO_LARGE_OR_INVALID' });
});
test('source download uses only the approved complete commit URL and enforces byte hash', async () => {
  const bytes = base([]), target = releaseTarget(bytes);
  let calls = 0;
  const fetchImpl = async (url, init) => { calls++; assert.equal(url, target.source.url); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined); return new Response(bytes); };
  assert.deepEqual(await downloadSource(target, { fetchImpl }), bytes);
  await assert.rejects(downloadSource({ ...target, source: { ...target.source, url: target.source.url.replace(COMMIT, 'main') } }, { fetchImpl }), { code: 'SYSTEM_UPDATE_SOURCE_INVALID' });
  assert.equal(calls, 1);
  await assert.rejects(downloadSource({ ...target, source: { ...target.source, sha256: 'b'.repeat(64) } }, { fetchImpl }), { code: 'SYSTEM_UPDATE_SOURCE_DIGEST_MISMATCH' });
});
test('stable source uses the exact published asset and follows only the official release CDN without credentials', async () => {
  const bytes = base([]), target = releaseTarget(bytes, 'stable'), calls = [];
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/source?sp=r&sig=synthetic-public-fixture';
  const result = await downloadSource(target, { fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { Accept: 'application/gzip' });
    return url === target.source.url ? new Response(null, { status: 302, headers: { Location: cdn } }) : new Response(bytes);
  } });
  assert.deepEqual(result, bytes); assert.deepEqual(calls, [target.source.url, cdn]);
  await assert.rejects(downloadSource({ ...target, source: { ...target.source, url: target.source.url.replace('/1.3.0/', '/latest/') } }), { code: 'SYSTEM_UPDATE_SOURCE_INVALID' });
  await assert.rejects(downloadSource({ ...target, channel: 'candidate' }), { code: 'SYSTEM_UPDATE_SOURCE_INVALID' });
});
test('stable source rejects nonofficial redirects, credentials, unsafe protocols and redirect loops', async () => {
  const target = releaseTarget(base([]), 'stable');
  for (const location of ['https://attacker.example.net/source', 'https://release-assets.githubusercontent.com.attacker.example.net/source',
    'https://objects.githubusercontent.com/source', 'https://user:secret@release-assets.githubusercontent.com/source',
    'http://release-assets.githubusercontent.com/source', 'https://release-assets.githubusercontent.com:8443/source',
    'https://release-assets.githubusercontent.com/source#fragment', 'https://release-assets.githubusercontent.com\\@attacker.example.net/source']) {
    let calls = 0;
    await assert.rejects(downloadSource(target, { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { Location: location } }); } }),
      { code: 'SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID' });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(downloadSource(target, { fetchImpl: async () => { calls++;
    return new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/loop' } });
  } }), { code: 'SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID' });
  assert.equal(calls, 4);
});
test('candidate redirects stay forbidden and stable final bytes still require the published hash and size bound', async () => {
  const bytes = base([]), candidate = releaseTarget(bytes), stable = releaseTarget(bytes, 'stable');
  await assert.rejects(downloadSource(candidate, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error'); return new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/source' } });
  } }), { code: 'SYSTEM_UPDATE_SOURCE_REDIRECT_INVALID' });
  await assert.rejects(downloadSource(stable, { fetchImpl: async url => url === stable.source.url
    ? new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/source' } })
    : new Response(Buffer.from('changed bytes')) }), { code: 'SYSTEM_UPDATE_SOURCE_DIGEST_MISMATCH' });
  await assert.rejects(downloadSource(stable, { limits: { ...SOURCE_LIMITS, compressed: 4 }, fetchImpl: async () => new Response(bytes) }));
});
