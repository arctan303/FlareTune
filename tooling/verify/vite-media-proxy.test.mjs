import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { createServer as createViteServer } from 'vite';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});

test('Vite development entry proxies /media requests to the configured local Worker', async () => {
  const worker = createHttpServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'X-FlareTune-Proxy-Probe': 'worker',
    });
    response.end(JSON.stringify({ url: request.url }));
  });
  const workerAddress = await listen(worker);
  const previousTarget = process.env.FLARETUNE_DEV_WORKER_ORIGIN;
  process.env.FLARETUNE_DEV_WORKER_ORIGIN = `http://127.0.0.1:${workerAddress.port}`;

  let vite;
  try {
    const { default: baseConfig } = await import(`../../client/vite.config.js?proxy-test=${Date.now()}`);
    vite = await createViteServer({
      ...baseConfig,
      configFile: false,
      logLevel: 'silent',
      server: {
        ...baseConfig.server,
        port: 0,
        strictPort: false,
      },
    });
    await vite.listen();
    const viteAddress = vite.httpServer.address();
    const response = await fetch(`http://127.0.0.1:${viteAddress.port}/media/proxy-probe?range=1`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-flaretune-proxy-probe'), 'worker');
    assert.deepEqual(await response.json(), { url: '/media/proxy-probe?range=1' });
  } finally {
    if (vite) await vite.close();
    await close(worker);
    if (previousTarget === undefined) delete process.env.FLARETUNE_DEV_WORKER_ORIGIN;
    else process.env.FLARETUNE_DEV_WORKER_ORIGIN = previousTarget;
  }
});
