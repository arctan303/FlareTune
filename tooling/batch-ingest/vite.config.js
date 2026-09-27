import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  base: '/',
  build: { outDir: fileURLToPath(new URL('../../output/batch-ingest/', import.meta.url)), emptyOutDir: true },
});
