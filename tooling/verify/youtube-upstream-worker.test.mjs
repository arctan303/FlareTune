import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { bundleWorkerModules } from '../dev/bundle-worker-modules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const credentials = { clientId: 'workerd-oauth-test-client', clientSecret: 'workerd-oauth-test-secret', refreshToken: 'workerd-oauth-test-refresh' };
async function withWorker(outboundService, run) {
  const temporaryRoot = resolve(root, '.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(resolve(temporaryRoot, 'youtube-upstream-worker-'));
  const entryPoint = resolve(directory, 'worker.mjs');
  const upstream = relative(directory, resolve(root, 'server/src/plugins/youtube/upstream.mjs')).split(sep).join('/');
  let mf;
  try {
    await writeFile(entryPoint, `import {createSessionManager,upstreamFetch} from ${JSON.stringify(upstream)};
// Observe the actual workerd fetch mode while delegating to its real fetch.
// The Node outbound bridge creates a new Request and cannot preserve this
// client-side policy as an HTTP property at the synthetic upstream server.
const nativeFetch=globalThis.fetch;const redirectModes=[];
globalThis.fetch=(input,init)=>{redirectModes.push(init?.redirect);return nativeFetch(input,init);};
export default {async fetch(request,env,ctx){try{
  if(new URL(request.url).pathname==='/direct'){
    await upstreamFetch('https://www.youtube.com/o/oauth2/token',{method:'POST',body:'synthetic-body'});
    return Response.json({accepted:true,redirectModes});
  }
  const manager=createSessionManager({env,ctx,credentials:${JSON.stringify(credentials)},epoch:'workerd-oauth-fixture'});
  const yt=await manager.tv();return Response.json({connected:yt.session.logged_in===true,redirectModes});
}catch(error){return Response.json({error:error.code||'UNEXPECTED_ERROR',redirectModes},{status:error.status||503});}}};`);
    const bundled = await bundleWorkerModules({ esbuild, entryPoint });
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'youtube-upstream-test', ...bundled,
      compatibilityDate: '2026-09-23', kvNamespaces: ['YTM_KV'], outboundService }] }));
    await run(mf);
  } finally {
    if (mf) await mf.dispose();
    assert.equal(dirname(directory), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  }
}

test('real workerd native TV OAuth refresh reaches its fixed upstream with manual redirects', async () => {
  let requests = 0;
  await withWorker(async request => {
    requests++;
    assert.equal(request.url, 'https://www.youtube.com/o/oauth2/token');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.has('Cookie'), false); assert.equal(request.headers.has('Authorization'), false);
    const body = await request.json();
    assert.deepEqual(body, { client_id: credentials.clientId, client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken, grant_type: 'refresh_token' });
    return Response.json({ access_token: 'workerd-oauth-fixture-access', expires_in: 3600, token_type: 'Bearer' });
  }, async mf => {
    const response = await mf.dispatchFetch('https://upstream-worker.test/refresh');
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ body, outboundRequests: requests }));
    assert.deepEqual(body, { connected: true, redirectModes: ['manual'] }); assert.equal(requests, 1);
  });
});

test('real workerd refuses OAuth and direct upstream redirects without reaching the second destination', async () => {
  let requests = 0, secondDestinationRequests = 0;
  await withWorker(async request => {
    if (new URL(request.url).hostname !== 'www.youtube.com') { secondDestinationRequests++; throw new Error('TEST_SECOND_DESTINATION_BLOCKED'); }
    requests++;
    return new Response('synthetic redirect', { status: 302, headers: { Location: 'https://second-destination.test/credential-target' } });
  }, async mf => {
    const oauth = await mf.dispatchFetch('https://upstream-worker.test/refresh');
    const oauthBody = await oauth.json();
    assert.equal(oauth.status, 503);
    assert.equal(oauthBody.error, 'YOUTUBE_UPSTREAM_REDIRECT');
    assert.deepEqual(oauthBody.redirectModes, ['manual']);
    const direct = await mf.dispatchFetch('https://upstream-worker.test/direct');
    assert.equal(direct.status, 503);
    assert.deepEqual(await direct.json(), { error: 'YOUTUBE_UPSTREAM_REDIRECT', redirectModes: ['manual', 'manual'] });
    assert.equal(requests, 2); assert.equal(secondDestinationRequests, 0);
  });
});
