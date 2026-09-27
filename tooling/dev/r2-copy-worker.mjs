// Run locally only. Source reads and development writes are limited to the
// generated sample manifest and the fixed wallpaper poster.
import manifest from '../../server/dev/song-sample.json' with { type: 'json' };

if (manifest.source !== 'music-db' || manifest.destination !== 'flaretune-db-dev'
  || manifest.bucket !== 'flaretune-files-dev' || manifest.prefix !== 'dist_music'
  || !Array.isArray(manifest.songs) || manifest.songs.length !== 60
  || manifest.songs.some((song) => !/^[a-f0-9]{16}$/.test(song.id)
    || !new RegExp(`^audio/${song.id}\\.(?:mp3|flac)$`).test(song.audio_url)
    || !/^cover\/[a-f0-9]{16}\.jpg$/.test(song.cover_url))) {
  throw new Error('Unexpected development media manifest target');
}
const allowedKeys = new Set(manifest.songs.flatMap((song) => [
  `dist_music/${song.audio_url}`, `dist_music/${song.cover_url}`,
  `dist_music/lyrics/${song.id}.json`,
]));
for (const name of ['natural-scenery-poster.jpg']) {
  allowedKeys.add(`dist_music/background/${name}`);
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/copy' || request.method !== 'POST') {
      return json({ error: 'not_found' }, 404);
    }
    if (request.headers.has('Origin') || request.headers.get('Content-Type')?.split(';', 1)[0].trim() !== 'application/json') {
      return json({ error: 'forbidden_request' }, 403);
    }
    let input;
    try { input = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const { key, optional = false } = input ?? {};
    if (typeof key !== 'string' || !allowedKeys.has(key) || typeof optional !== 'boolean') {
      return json({ error: 'invalid_key' }, 400);
    }
    try {
      const sourceHead = await env.SOURCE_BUCKET.head(key);
      if (!sourceHead) return optional ? json({ status: 'missing_optional' }) : json({ error: 'source_missing' }, 404);
      const existing = await env.DEST_BUCKET.head(key);
      if (existing) {
        if (existing.size === sourceHead.size && existing.etag === sourceHead.etag) {
          return json({ status: 'already_present', size: existing.size });
        }
        return json({ error: 'destination_conflict' }, 409);
      }
      const source = await env.SOURCE_BUCKET.get(key);
      if (!source) return json({ error: 'source_disappeared' }, 409);
      await env.DEST_BUCKET.put(key, source.body, {
        httpMetadata: source.httpMetadata,
        customMetadata: source.customMetadata,
      });
      const destination = await env.DEST_BUCKET.head(key);
      if (!destination || destination.size !== sourceHead.size) {
        return json({ error: 'destination_readback_mismatch' }, 502);
      }
      return json({ status: 'copied', size: destination.size });
    } catch {
      return json({ error: 'copy_failed' }, 503);
    }
  },
};
