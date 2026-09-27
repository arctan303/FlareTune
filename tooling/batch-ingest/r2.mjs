import { randomBytes } from 'node:crypto';
import { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export function r2Settings(input) {
  const { accountId, bucket, prefix, accessKeyId, secretAccessKey, jurisdiction = 'default' } = input || {};
  if (!/^[0-9a-f]{32}$/i.test(accountId || '') || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket || '')
    || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,254}$/.test(prefix || '')
    || String(prefix).split('/').some((part) => !part || part === '.' || part === '..')
    || !accessKeyId || !secretAccessKey
    || !['default', 'eu', 'us', 'fedramp'].includes(jurisdiction)) {
    throw new Error('请填写有效的 R2 Account ID、bucket、前缀和 S3 密钥。');
  }
  const host = jurisdiction === 'default' ? accountId : `${accountId}.${jurisdiction}`;
  return {
    bucket, prefix,
    client: new S3Client({ region: 'auto', endpoint: `https://${host}.r2.cloudflarestorage.com`,
      forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } }),
  };
}

export async function verifyR2Target(config, remote) {
  const id = randomBytes(8).toString('hex');
  const Key = `${config.prefix}/audio/${id}.mp3`;
  const Body = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  let created = false;
  try {
    await config.client.send(new PutObjectCommand({ Bucket: config.bucket, Key, Body,
      ContentType: 'audio/mpeg', IfNoneMatch: '*' }));
    created = true;
    const response = await remote.mediaHead('audio', id, 'mp3');
    if (response.status !== 200 || Number(response.headers.get('content-length')) !== Body.length) {
      throw new Error('目标 bucket 或前缀与播放器实例不一致。');
    }
  } finally {
    if (created) await config.client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key }));
  }
  return config;
}

export async function uploadR2(config, { kind, id, extension, contentType, length, body },
  { MultipartUpload = Upload } = {}) {
  const Key = `${config.prefix}/${kind}/${id}.${extension}`;
  const params = { Bucket: config.bucket, Key, Body: body, ContentType: contentType };
  if (length <= 100_000_000) {
    await config.client.send(new PutObjectCommand({ ...params, ContentLength: length, IfNoneMatch: '*' }));
  } else {
    const existing = await config.client.send(new HeadObjectCommand({
      Bucket: config.bucket, Key,
    })).then(() => true, (error) => {
      if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return false;
      throw error;
    });
    if (existing) throw new Error('媒体对象已存在，请重新选择。');
    const tempKey = `${config.prefix}/_ingest_tmp/${randomBytes(16).toString('hex')}.part`;
    let uploadError = null;
    try {
      const upload = new MultipartUpload({ client: config.client, params: { ...params, Key: tempKey },
        queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false });
      await upload.done();
      const copy = new CopyObjectCommand({ Bucket: config.bucket, Key,
        CopySource: `${config.bucket}/${tempKey}`, MetadataDirective: 'COPY' });
      // R2's destination condition is a Cloudflare S3 extension. Add it before signing.
      copy.middlewareStack.add((next) => async (args) => {
        args.request.headers['cf-copy-destination-if-none-match'] = '*';
        return next(args);
      }, { name: 'r2DestinationMustBeAbsent', step: 'build' });
      await config.client.send(copy);
    } catch (error) {
      uploadError = error;
      throw error;
    } finally {
      try { await config.client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: tempKey })); }
      catch (cleanupError) {
        if (uploadError) throw new AggregateError([uploadError, cleanupError],
          `上传失败且临时对象清理失败：${uploadError.message}；${cleanupError.message}`);
        throw cleanupError;
      }
    }
  }
  return { path: `${kind}/${id}.${extension}`, url: `/media/${kind}/${id}.${extension}`, size: length };
}
