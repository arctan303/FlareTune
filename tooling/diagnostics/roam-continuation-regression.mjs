import { build } from 'esbuild';
import { createServer } from 'node:http';
const bundle = await build({ entryPoints: ['tooling/diagnostics/roam-continuation-regression.jsx'], bundle: true,
  write: false, format: 'esm', define: { 'process.env.NODE_ENV': '"development"' } });
createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Roam continuation regression</title><style>body{font:14px system-ui}pre{white-space:pre-wrap}</style><button id="run">Run regression</button><pre id="report">Ready</pre><div id="fixture"></div><script type="module" src="/fixture.js"></script>'); }
}).listen(4190, '127.0.0.1', () => console.log('http://127.0.0.1:4190'));
