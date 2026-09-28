// Local-only React regression; no Worker or real account is contacted.
// Run this file, open http://127.0.0.1:4188, then click Run regression.
import { build } from 'esbuild';
import { createServer } from 'node:http';
const bundle = await build({ entryPoints: ['tooling/diagnostics/play-stats-preview-regression.jsx'],
  bundle: true, write: false, format: 'esm', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' });
const html = '<!doctype html><meta charset="utf-8"><title>Play stats preview regression</title><style>body{font:16px system-ui;margin:24px}pre{white-space:pre-wrap}.track-row{display:flex;margin:12px}.track-row img{width:64px;height:64px}button{margin:4px;padding:8px}</style><button id="run">Run regression</button><pre id="report">Ready — synthetic local data only</pre><div id="fixture"></div><script type="module" src="/fixture.js"></script>';
createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === '/placeholder-album.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>'); }
  else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
}).listen(4188, '127.0.0.1', () => console.log('Fixture ready at http://127.0.0.1:4188'));
