import { defineConfig, mergeConfig } from 'vite';
import base from '../client/vite.config.js';
import { fileURLToPath } from 'node:url';
import { namespaceDemoStorage } from './storageNamespace.js';
const path = file => fileURLToPath(new URL(file, import.meta.url));
const config = mergeConfig(base, {
  root: path('./'), publicDir: path('./public'), envDir: false,
  define: { 'import.meta.env.VITE_API_BASE_URL': '""' },
  css: { postcss: path('../client') },
  plugins: [{ name: 'demo-storage-namespace', enforce: 'pre', transform(code, id) {
    if (!id.replaceAll('\\','/').includes('/client/src/') || !/\.(?:js|jsx)(?:\?|$)/.test(id)) return null;
    let next = namespaceDemoStorage(code);
    if (id.replaceAll('\\','/').endsWith('/constants/wallpaperPresets.js')) {
      let index = 0;
      next = next.replace(/https:\/\/images\.unsplash\.com\/[^'"\s]+/g, () => `/media/demo-${String(Math.floor(index++ / 2) + 2).padStart(2,'0')}.svg`)
        .replaceAll("withBaseUrl('background/natural-scenery-poster.jpg')", "'/media/demo-01.svg'")
        .replace("name: '山野幽林'", "name: '专辑封面'").replace("name: '深邃星穹'", "name: '纯音乐'")
        .replace("name: '余晖晚霞'", "name: '今日精选'").replace("name: '云海群峰'", "name: '曲库'").replace("name: '暗调织物'", "name: '我的收藏'");
    }
    return next === code ? null : {code: next, map: null};
  }}],
  resolve: { alias: [
    { find: /^.*\bassets\/categories\/(?:zh|en|instrumental|ja|ko|other)\.jpg$/, replacement: path('./category.svg') },
    { find: /^.*\bruntimeFetch\.js$/, replacement: path('./transport.js') },
    { find: /^.*\bAccountSettings\.jsx$/, replacement: path('./AccountSettings.jsx') },
    { find: /^.*\b(?:AssistantView|IngestWorkspace|AdminView|LyricsManagementWorkspace)\.jsx$/, replacement: path('./Showcase.jsx') },
  ] },
  server: { port: 39183, strictPort: true, proxy: {} },
  build: { outDir: path('../dist-demo'), rollupOptions: { input: { main: path('./index.html') } } },
});
// mergeConfig merges objects; explicitly remove the normal API/media proxies.
config.server.proxy = {};
export default defineConfig(config);
