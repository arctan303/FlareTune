import { handleLyricsWorkbenchRoute } from '../plugins/lyrics-workbench/workspace.js';
  import { makeSongDb, makeSong, createMemoryLyricStore } from './lyricAssetFixtures.js';
  const db = makeSongDb([makeSong({ title:'Song', artist:'Artist', duration:180, album:'' })]);
  const session = { mode:'normal', account:{accountId:'worker-fixture',role:'admin'} };
  export default { async fetch(request, env, ctx) {
    const input = new URL(request.url);
    if (input.pathname === '/warmup') return new Response('ready');
    let waitUntilCalls = 0;
    const operationContext = { waitUntil(task) { waitUntilCalls++; ctx.waitUntil(task); } };
    const controller = new AbortController();
    const abortAfter = Number(input.searchParams.get('abortAfter'));
    let timer;
    if (abortAfter > 0) timer = setTimeout(() => controller.abort(), abortAfter);
    const title = input.searchParams.get('title') || 'Song';
    const action = input.searchParams.get('action') || 'candidates';
    let target = 'https://app.test/api/lyrics/workspace/song-1';
    let method = 'GET', body;
    if (action === 'inspect') {
      target += '/candidates/inspect'; method = 'POST';
      body = { candidates:[{source:'lrclib',providerLyricId:'1'}], searchTitle:title };
    } else if (action === 'import') {
      method = 'PUT'; body = { source:'lrclib', providerLyricId:'1', etag:null, searchTitle:title };
    } else target += '/candidates?source=lrclib&title=' + encodeURIComponent(title);
    const routed = new Request(target, { method, signal:controller.signal,
      ...(body ? { headers:{'Content-Type':'application/json'},body:JSON.stringify(body) } : {}) });
    try {
      const response = await handleLyricsWorkbenchRoute(routed, new URL(target), db, {}, session, {},
        { context:{requireRoles:async()=>{}}, aiAvailable:async()=>false, ctx:operationContext, store:createMemoryLyricStore() });
      response.headers.set('X-Registered-Tasks', String(waitUntilCalls));
      return response;
    } finally { clearTimeout(timer); }
  } };
