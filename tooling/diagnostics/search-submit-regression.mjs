import { build } from 'esbuild';
import { createServer } from 'node:http';
const bundle = await build({ entryPoints: ['tooling/diagnostics/search-submit-regression.jsx'], bundle: true,
  write: false, format: 'esm', loader: { '.jpg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === '/placeholder-album.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"/>'); }
  else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Search submit regression</title><style>body{font:14px system-ui}pre{white-space:pre-wrap}img{width:40px;height:40px}</style><button id="run">Run regression</button><pre id="report">Ready</pre><div id="fixture"></div><script type="module" src="/fixture.js"></script>'); }
}).listen(4189, '127.0.0.1', () => console.log('http://127.0.0.1:4189'));
