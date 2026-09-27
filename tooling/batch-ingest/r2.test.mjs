import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { r2Settings, verifyR2Target, uploadR2 } from './r2.mjs';

test('R2 configuration rejects invalid targets before any write', () => {
  const valid = { accountId: 'a'.repeat(32), bucket: 'my-music', prefix: 'media',
    accessKeyId: 'key', secretAccessKey: 'secret' };
  assert.throws(() => r2Settings({ ...valid, prefix: '../media' }));
  assert.throws(() => r2Settings({ ...valid, bucket: 'invalid/bucket' }));
  assert.throws(() => r2Settings({ ...valid, accountId: 'invalid' }));
  const config = r2Settings(valid);
  assert.equal(config.bucket, 'my-music');
  config.client.destroy();
});

test('R2 probe checks instance media route and removes its temporary object', async () => {
  const commands = [];
  const config = { bucket: 'my-music', prefix: 'media', client: { send: async (command) => {
    commands.push(command);
    return {};
  } } };
  const remote = { mediaHead: async (kind, id, extension) => {
    assert.equal(kind, 'audio');
    assert.equal(extension, 'mp3');
    assert.match(id, /^[0-9a-f]{16}$/);
    return new Response(null, { status: 200, headers: { 'Content-Length': '10' } });
  } };
  await verifyR2Target(config, remote);
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.ok(commands[1] instanceof DeleteObjectCommand);
  assert.equal(commands[0].input.Key, commands[1].input.Key);
  assert.match(commands[0].input.Key, /^media\/audio\/[0-9a-f]{16}\.mp3$/);
  assert.equal(commands[0].input.IfNoneMatch, '*');

  commands.length = 0;
  await assert.rejects(() => verifyR2Target(config, { mediaHead: async () =>
    new Response(null, { status: 404 }) }), /不一致/);
  assert.ok(commands[1] instanceof DeleteObjectCommand);
});

test('direct small upload uses the player media key and conditional create', async () => {
  const commands = [];
  const config = { bucket: 'my-music', prefix: 'media', client: { send: async (command) => {
    commands.push(command);
    return {};
  } } };
  const body = Readable.from(Buffer.from('ID3-test-audio'));
  const result = await uploadR2(config, { kind: 'audio', id: '0123456789abcdef',
    extension: 'mp3', contentType: 'audio/mpeg', length: 14, body });
  assert.deepEqual(result, { path: 'audio/0123456789abcdef.mp3',
    url: '/media/audio/0123456789abcdef.mp3', size: 14 });
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.equal(commands[0].input.Key, 'media/audio/0123456789abcdef.mp3');
  assert.equal(commands[0].input.IfNoneMatch, '*');
});

test('multipart uploads to a temporary key and conditionally copies to the media key', async () => {
  const commands = [];
  let tempKey = '';
  class FakeMultipartUpload {
    constructor(options) {
      tempKey = options.params.Key;
      assert.equal(options.params.Bucket, 'my-music');
      assert.equal(options.leavePartsOnError, false);
    }
    async done() { return {}; }
  }
  const config = { bucket: 'my-music', prefix: 'media', client: { send: async (command) => {
    commands.push(command);
    if (command instanceof HeadObjectCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' });
    return {};
  } } };
  await uploadR2(config, { kind: 'audio', id: '0123456789abcdef', extension: 'mp3',
    contentType: 'audio/mpeg', length: 100_000_001, body: Readable.from([]) },
  { MultipartUpload: FakeMultipartUpload });
  assert.match(tempKey, /^media\/_ingest_tmp\/[0-9a-f]{32}\.part$/);
  assert.ok(commands[1] instanceof CopyObjectCommand);
  assert.equal(commands[1].input.Key, 'media/audio/0123456789abcdef.mp3');
  assert.equal(commands[1].input.CopySource, `my-music/${tempKey}`);
  const handler = commands[1].middlewareStack.resolve(async ({ request }) =>
    ({ response: {}, output: request.headers }), {});
  const signedHeaders = (await handler({ request: { headers: {} }, input: {} })).output;
  assert.equal(signedHeaders['cf-copy-destination-if-none-match'], '*');
  assert.ok(commands[2] instanceof DeleteObjectCommand);
  assert.equal(commands[2].input.Key, tempKey);
});

test('multipart failure still removes a possibly completed temporary object', async () => {
  const commands = [];
  class LostReplyUpload {
    async done() { throw new Error('upload reply lost'); }
  }
  const config = { bucket: 'my-music', prefix: 'media', client: { send: async (command) => {
    commands.push(command);
    if (command instanceof HeadObjectCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' });
    return {};
  } } };
  await assert.rejects(() => uploadR2(config, { kind: 'audio', id: '0123456789abcdef', extension: 'mp3',
    contentType: 'audio/mpeg', length: 100_000_001, body: Readable.from([]) },
  { MultipartUpload: LostReplyUpload }), /upload reply lost/);
  assert.ok(commands[1] instanceof DeleteObjectCommand);
  assert.match(commands[1].input.Key, /^media\/_ingest_tmp\/[0-9a-f]{32}\.part$/);
});
