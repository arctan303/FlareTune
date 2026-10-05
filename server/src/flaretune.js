import { handleApi, json } from './instance/httpRouter.js';
import { handleMediaRoute } from './routes/media.js';
import { deploymentGateAllows } from './deploymentGate.js';
import { handleSubsonic } from './subsonic/router.js';

export default {
  async fetch(request, env, ctx) {
    if (!await deploymentGateAllows(request, env)) {
      return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const path = new URL(request.url).pathname;
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
