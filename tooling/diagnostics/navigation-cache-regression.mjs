// Run with node tooling/diagnostics/navigation-cache-regression.mjs, then open
// http://127.0.0.1:4187 and click Run. No live account or Worker is used.
import { build } from 'esbuild';
import { createServer } from 'node:http';
const bundle = await build({ entryPoints: ['tooling/diagnostics/navigation-cache-regression.jsx'], bundle: true, write: false, format: 'esm', loader: { '.jpg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' });
const html = '<!doctype html><meta charset="utf-8"><title>Navigation cache regression</title><style>body{font:14px system-ui;margin:20px}pre{white-space:pre-wrap}#player{display:flex;gap:12px}.lazy-image{position:relative}.lazy-image img{width:80px;height:80px}#search img{width:40px;height:40px}</style><button id="run">Run regression</button><pre id="report">Ready — synthetic local data only</pre><div id="fixture"></div><script type="module" src="/fixture.js"></script>';
createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === '/placeholder-album.svg') { res.setHeader('Content-Type', 'image/svg+xml'); setTimeout(() => res.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"/>'), 2000); }
  else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
}).listen(4187, '127.0.0.1', () => console.log('Fixture ready at http://127.0.0.1:4187'));
