import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('.', import.meta.url));
const repositoryRoot = resolve(clientRoot, '..');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workerProxyTarget = process.env.FLARETUNE_DEV_WORKER_ORIGIN || 'http://127.0.0.1:8789';
const workerProxyOrigin = new URL(workerProxyTarget).origin;
const localWebOrigin = process.env.FLARETUNE_LOCAL_WEB_ORIGIN || 'http://127.0.0.1:3000';

const localApiProxy = () => ({
  target: workerProxyTarget,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (proxyRequest, browserRequest) => {
      // A browser's same-origin POST reaches Worker through Vite in development.
      // Translate only that known origin; never bless an arbitrary Origin header.
      if (browserRequest.headers.origin === localWebOrigin) {
        proxyRequest.setHeader('Origin', workerProxyOrigin);
      }
    });
  },
});

export default defineConfig({
  root: clientRoot,
  envDir: repositoryRoot,
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    open: false,
    headers: {
      'Cache-Control': 'no-store',
    },
    proxy: {
      '/api': localApiProxy(),
      '/auth': localApiProxy(),
      '/media': {
        target: workerProxyTarget,
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: resolve(repositoryRoot, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(clientRoot, 'index.html'),
      },
    },
  }
});
