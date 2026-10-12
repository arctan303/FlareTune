import catalog from './catalog.json' with { type: 'json' };

const media = new Map(catalog.map(song => [song.audio_url, song]));
function rangeOf(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first > last || first >= size
    || (!match[1] && Number(match[2]) <= 0)) return null;
  return [first, last];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const song = media.get(url.pathname);
    if (!song) {
      if (url.pathname.startsWith('/media/')) return new Response('Not found', { status: 404 });
      return env.ASSETS.fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const etag = `"${song.sha256}"`;
    const headers = new Headers({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes',
      'ETag': etag, 'Cache-Control': 'public, max-age=0, must-revalidate, no-transform',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    const rangeHeader = request.headers.get('Range');
    const ifRange = request.headers.get('If-Range');
    const useRange = request.method === 'GET' && rangeHeader && (!ifRange || ifRange === etag);
    const range = useRange ? rangeOf(rangeHeader, song.bytes) : [0, song.bytes - 1];
    if (!range) {
      headers.set('Content-Range', `bytes */${song.bytes}`);
      return new Response(null, { status: 416, headers });
    }
    if (!useRange && request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
    const [first, last] = range;
    headers.set('Content-Length', String(last - first + 1));
    if (useRange) headers.set('Content-Range', `bytes ${first}-${last}/${song.bytes}`);
    if (request.method === 'HEAD') return new Response(null, { headers });
    // Only packaged, integrity-checked media is readable. Never proxy a URL or
    // pass caller credentials/range/conditional headers into the assets binding.
    const asset = await env.ASSETS.fetch(new Request(`${url.origin}${song.audio_url}`, { headers: { 'Accept-Encoding': 'identity' } }));
    if (!asset.ok) return new Response('Media unavailable', { status: 503 });
    const bytes = await asset.arrayBuffer();
    if (bytes.byteLength !== song.bytes) return new Response('Media unavailable', { status: 503 });
    return new Response(useRange ? bytes.slice(first, last + 1) : bytes, { status: useRange ? 206 : 200, headers });
  },
};
