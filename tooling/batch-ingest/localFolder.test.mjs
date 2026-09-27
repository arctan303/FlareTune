import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFolder } from './localFolder.mjs';

test('Node scans a local directory and rejects changed or stale file references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flaretune-scan-'));
  const zh = join(root, 'zh');
  const song = join(zh, 'sample.mp3');
  await mkdir(zh);
  await writeFile(song, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]));
  const folder = new LocalFolder();
  try {
    const scanned = await folder.scan(root);
    assert.equal(scanned.files.length, 1);
    assert.equal(scanned.files[0].path, `${root.split(/[\\/]/).at(-1)}/zh/sample.mp3`);
    const media = await folder.media(scanned.files[0].id, 'audio');
    const chunks = [];
    for await (const chunk of media.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).length, 35);
    await writeFile(song, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(36)]));
    await assert.rejects(() => folder.get(scanned.files[0].id), /已变化/);
    await folder.scan(root);
    await assert.rejects(() => folder.get(scanned.files[0].id), /已失效/);
    const rescanned = await folder.scan(root);
    await assert.rejects(() => folder.scan(join(root, 'missing')), /ENOENT/);
    await assert.rejects(() => folder.get(rescanned.files[0].id), /已失效/);
  } finally { await unlink(song); await rmdir(zh); await rmdir(root); }
});

test('embedded cover is available from the same scanned audio file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flaretune-cover-'));
  const song = join(root, 'cover.mp3');
  const picture = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const frameBody = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0'), Buffer.from([3, 0]), picture]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write('APIC', 0, 'ascii');
  frameHeader.writeUInt32BE(frameBody.length, 4);
  const tag = Buffer.concat([frameHeader, frameBody]);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, tag.length]);
  await writeFile(song, Buffer.concat([header, tag, Buffer.alloc(24)]));
  try {
    const folder = new LocalFolder();
    const scanned = await folder.scan(root);
    assert.equal(scanned.files[0].cover?.name, 'cover.jpeg');
    const cover = await folder.media(scanned.files[0].id, 'cover');
    assert.deepEqual(Buffer.from(cover.body), picture);
  } finally { await unlink(song); await rmdir(root); }
});
