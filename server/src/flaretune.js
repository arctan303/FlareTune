import { handleApi, json } from './instance/httpRouter.js';
import { handleMediaRoute } from './routes/media.js';
import { deliveryPluginModules } from './plugins/delivery.generated.js';
import { deploymentGateAllows } from './deploymentGate.js';
import { systemUpdateRequestGate } from './systemUpdate/gate.js';
import { handleSubsonic } from './subsonic/router.js';
// Cloudflare binding identity stays stable. Only the selected package supplies
// executable source behavior; no actor/vendor implementation lives in the host.
export class YouTubeRuntime {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.runtime = null; }
  async fetch(request) {
    const create = deliveryPluginModules['youtube-music']?.createRuntime;
    if (typeof create !== 'function') return new Response(null, { status: 503,
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    this.runtime ||= Promise.resolve().then(() => create(this.ctx, this.env)).catch(error => { this.runtime = null; throw error; });
    return (await this.runtime).fetch(request);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (!await deploymentGateAllows(request, env)) {
      return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const path = new URL(request.url).pathname;
    const updateGate = await systemUpdateRequestGate(request, path, env, ctx, { handleApiImpl: handleApi });
    if (updateGate) return updateGate;
    if (path === '/speaker-media' || path.startsWith('/speaker-media/')) {
      const handle = deliveryPluginModules['xiaomi-speaker']?.handleOutputMedia;
      return handle ? handle(request, env, ctx) : new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    if (path === '/rest' || path.startsWith('/rest/')) return handleSubsonic(request, env, ctx);
    if (path.startsWith('/media/')) return handleMediaRoute(request, path, env, ctx);
    if (path === '/api' || path === '/auth') return json({ error: 'not_found' }, 404);
    if (path.startsWith('/api/') || path.startsWith('/auth/')) {
      return handleApi(request, env, path, ctx);
    }
    if (env?.ASSETS?.fetch) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  },
};
