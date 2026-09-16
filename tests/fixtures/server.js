// Tiny HTTP server used by the tests. It can be configured on a per-request
// basis to serve the response with a chosen Content-Encoding (honoring
// Accept-Encoding), and to serve a fake bot-challenge response.

import http from 'node:http';
import zlib from 'node:zlib';

export function startFixtureServer({ html, supported = ['br', 'gzip'], challenge = false } = {}) {
  const server = http.createServer((req, res) => {
    if (challenge) {
      const body =
        '<html><body>Access Denied. Reference: _abck challenge cf-ray</body></html>';
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }

    const accept = (req.headers['accept-encoding'] || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    let chosen = null;
    for (const enc of accept) {
      if (supported.includes(enc)) { chosen = enc; break; }
    }

    const body = Buffer.from(html, 'utf8');
    if (chosen === 'br') {
      const compressed = zlib.brotliCompressSync(body);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'br'
      });
      res.end(compressed);
      return;
    }
    if (chosen === 'gzip') {
      const compressed = zlib.gzipSync(body);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip'
      });
      res.end(compressed);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
