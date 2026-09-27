// Local-only, manifest-scoped copy of the two requested artists' media.
import manifest from '../../server/dev/artist-showcase.json' with { type: 'json' };

if (manifest.source !== 'music-db' || manifest.destination !== 'flaretune-db-dev'
  || manifest.sourceBucket !== 'files' || manifest.destinationBucket !== 'flaretune-files-dev'
  || manifest.prefix !== 'dist_music' || manifest.songs?.length !== 32) {
  throw new Error('Unexpected artist media manifest');
}
const jobs = new Map();
for (const song of manifest.songs) {
  if (!['周杰伦', '凤凰传奇'].includes(song.artist)
    || !/^[a-f0-9]{16}$/u.test(song.id)
    || !new RegExp(`^audio/${song.id}\\.(?:mp3|flac)$`, 'u').test(song.audio_url)
    || song.cover_url !== `cover/${song.id}.jpg`) {
    throw new Error('Unexpected artist song media path');
  }
  jobs.set(`dist_music/${song.audio_url}`, false);
  jobs.set(`dist_music/${song.cover_url}`, false);
  jobs.set(`dist_music/lyrics/${song.id}.json`, true);
}
if (jobs.size !== 96) throw new Error('Artist media keys are not unique');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const summary = (object) => object ? { size: object.size, etag: object.etag } : null;

async function sameContent(sourceBucket, destinationBucket, key) {
  const [source, destination] = await Promise.all([
    sourceBucket.get(key), destinationBucket.get(key),
  ]);
  if (!source || !destination || source.size !== destination.size) return false;
  const left = source.body.getReader();
  const right = destination.body.getReader();
  let a = new Uint8Array();
  let b = new Uint8Array();
  let ai = 0;
  let bi = 0;
  try {
    while (true) {
      if (ai === a.length) {
        const next = await left.read();
        if (next.done) {
          const last = await right.read();
          return bi === b.length && last.done;
        }
        a = next.value;
        ai = 0;
      }
      if (bi === b.length) {
        const next = await right.read();
        if (next.done) return false;
        b = next.value;
        bi = 0;
      }
      const count = Math.min(a.length - ai, b.length - bi);
      for (let offset = 0; offset < count; offset += 1) {
        if (a[ai + offset] !== b[bi + offset]) return false;
      }
      ai += count;
      bi += count;
    }
  } finally {
    await Promise.all([left.cancel().catch(() => {}), right.cancel().catch(() => {})]);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1' || !['/inspect', '/copy'].includes(url.pathname)
      || request.method !== 'POST') return json({ error: 'not_found' }, 404);
    if (request.headers.has('Origin')
      || request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/json') {
      return json({ error: 'forbidden_request' }, 403);
    }
    let input;
    try { input = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const key = input?.key;
    if (typeof key !== 'string' || !jobs.has(key)) return json({ error: 'invalid_key' }, 400);
    const optional = jobs.get(key);
    try {
      const [sourceHead, destinationHead] = await Promise.all([
        env.SOURCE_BUCKET.head(key), env.DEST_BUCKET.head(key),
      ]);
      const bothPresent = Boolean(sourceHead && destinationHead);
      const sameSize = bothPresent && sourceHead.size === destinationHead.size;
      const etagMatched = sameSize && sourceHead.etag === destinationHead.etag;
      const contentMatched = sameSize && (etagMatched
        || await sameContent(env.SOURCE_BUCKET, env.DEST_BUCKET, key));
      if (url.pathname === '/inspect') {
        return json({ key, optional, source: summary(sourceHead), destination: summary(destinationHead),
          contentMatched: bothPresent ? contentMatched : null });
      }
      if (!sourceHead) return optional ? json({ status: 'missing_optional' }) : json({ error: 'source_missing' }, 404);
      if (destinationHead) {
        if (contentMatched) {
          return json({ status: 'already_present', size: destinationHead.size });
        }
        return json({ error: 'destination_conflict' }, 409);
      }
      const object = await env.SOURCE_BUCKET.get(key);
      if (!object) return json({ error: 'source_disappeared' }, 409);
      await env.DEST_BUCKET.put(key, object.body, {
        httpMetadata: object.httpMetadata, customMetadata: object.customMetadata,
      });
      const readback = await env.DEST_BUCKET.head(key);
      if (!readback || readback.size !== sourceHead.size) {
        return json({ error: 'destination_readback_mismatch' }, 502);
      }
      const copiedEtagMatched = readback.etag === sourceHead.etag;
      if (!copiedEtagMatched && !await sameContent(env.SOURCE_BUCKET, env.DEST_BUCKET, key)) {
        return json({ error: 'destination_content_mismatch' }, 502);
      }
      return json({ status: 'copied', size: readback.size, etagMatched: copiedEtagMatched });
    } catch {
      return json({ error: 'copy_failed' }, 503);
    }
  },
};
