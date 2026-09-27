import http from 'node:http';

const PORT = 8789;
const TARGET_ORIGIN = String(process.env.FLARETUNE_DEV_PROXY_TARGET || '').replace(/\/$/, '');

if (!TARGET_ORIGIN) {
  throw new Error('FLARETUNE_DEV_PROXY_TARGET is required; no production proxy target is assumed.');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*';

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-api-key, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    });
    res.end();
    return;
  }

  try {
    const targetUrl = `${TARGET_ORIGIN}${req.url}`;
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const headers = { ...req.headers, host: new URL(TARGET_ORIGIN).host };
    delete headers['connection'];
    delete headers['accept-encoding']; // 避免上游压缩导致解码头冲突

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });

    const resHeaders = {};
    for (const [key, value] of response.headers.entries()) {
      resHeaders[key] = value;
    }
    delete resHeaders['content-encoding'];
    delete resHeaders['content-length'];
    delete resHeaders['transfer-encoding'];

    resHeaders['access-control-allow-origin'] = origin;
    resHeaders['access-control-allow-credentials'] = 'true';

    // 支持 SSE 流式传输
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      res.writeHead(response.status, resHeaders);
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    res.writeHead(response.status, resHeaders);
    res.end(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('[Worker Dev Proxy Error]', err);
    res.writeHead(502, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin
    });
    res.end(JSON.stringify({ code: 502, message: 'Backend Proxy Error', error: String(err) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Worker Dev Server] Local backend listening on http://localhost:${PORT}`);
});
