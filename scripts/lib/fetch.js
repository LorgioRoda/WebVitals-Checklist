// Raw HTTP fetching with encoding probing and CDN bot-challenge detection.
// Uses node:https/node:http directly so response bytes arrive exactly as
// transferred (no automatic decompression by the client).

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { URL } from 'node:url';

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20000;

const CHROME_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

const CHALLENGE_MARKERS = [
  'access denied',
  'captcha',
  'challenge',
  '_abck',
  'bm-verify',
  'akamai',
  'cf-ray',
  'attention required'
];

export class FetchError extends Error {
  constructor(message, { code, status, finalUrl } = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
    this.finalUrl = finalUrl;
  }
}

function requestOnce(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      reject(new FetchError(`Invalid URL: ${targetUrl}`, { code: 'INVALID_URL' }));
      return;
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const options = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      headers: { Host: parsed.host, ...headers }
    };

    const req = client.request(options, (res) => {
      const chunks = [];
      let transferredBytes = 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        transferredBytes += chunk.length;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          transferredBytes
        });
      });
      res.on('error', reject);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new FetchError(`Request timed out after ${REQUEST_TIMEOUT_MS} ms`, { code: 'TIMEOUT' }));
    });
    req.on('error', (err) => {
      if (err instanceof FetchError) reject(err);
      else reject(new FetchError(err.message, { code: err.code || 'NETWORK_ERROR' }));
    });
    req.end();
  });
}

async function fetchFollowingRedirects(startUrl, acceptEncoding) {
  const headers = { ...CHROME_HEADERS, 'Accept-Encoding': acceptEncoding };
  let currentUrl = startUrl;
  let hops = 0;
  while (true) {
    const res = await requestOnce(currentUrl, headers);
    const { statusCode, headers: resHeaders } = res;
    if (statusCode >= 300 && statusCode < 400 && resHeaders.location && hops < MAX_REDIRECTS) {
      currentUrl = new URL(resHeaders.location, currentUrl).toString();
      hops++;
      continue;
    }
    return { ...res, finalUrl: currentUrl };
  }
}

function decompress(body, encoding) {
  if (!encoding || encoding === 'identity') return body;
  const enc = encoding.trim().toLowerCase();
  if (enc === 'gzip') return zlib.gunzipSync(body);
  if (enc === 'br') return zlib.brotliDecompressSync(body);
  if (enc === 'deflate') {
    // Some servers send raw deflate, some send zlib-wrapped; try both.
    try {
      return zlib.inflateSync(body);
    } catch {
      return zlib.inflateRawSync(body);
    }
  }
  throw new FetchError(`Unsupported content-encoding: ${encoding}`, { code: 'UNSUPPORTED_ENCODING' });
}

function detectChallenge({ statusCode, html }) {
  if (statusCode === 403 || statusCode === 429) return true;
  if (html.length < 5 * 1024) {
    const lower = html.toLowerCase();
    for (const marker of CHALLENGE_MARKERS) {
      if (lower.includes(marker)) return true;
    }
  }
  return false;
}

// Public API. Fetches the page three times to learn which encodings the
// server actually serves, and returns a shared context object that all
// checks receive.
export async function fetchPage(url) {
  const browserRes = await fetchFollowingRedirects(url, 'br, gzip, deflate');
  const browserEncoding = (browserRes.headers['content-encoding'] || '').toLowerCase() || null;
  const html = decompress(browserRes.body, browserEncoding).toString('utf8');

  if (detectChallenge({ statusCode: browserRes.statusCode, html })) {
    throw new FetchError(
      `The origin/CDN blocked the request (status ${browserRes.statusCode}). ` +
        'The response looks like a bot challenge, not the real page. Aborting.',
      { code: 'BOT_CHALLENGE', status: browserRes.statusCode, finalUrl: browserRes.finalUrl }
    );
  }

  // Probe br-only and gzip-only in parallel to see what the server serves.
  const [brRes, gzipRes] = await Promise.allSettled([
    fetchFollowingRedirects(browserRes.finalUrl, 'br'),
    fetchFollowingRedirects(browserRes.finalUrl, 'gzip')
  ]);

  const encodingOf = (r) =>
    r.status === 'fulfilled'
      ? (r.value.headers['content-encoding'] || '').toLowerCase() || null
      : null;

  const rawBytes = Buffer.byteLength(html, 'utf8');

  const brInfo =
    brRes.status === 'fulfilled' && encodingOf(brRes) === 'br'
      ? { encoding: 'br', transferredBytes: brRes.value.transferredBytes, served: true }
      : { encoding: encodingOf(brRes), transferredBytes: null, served: false };

  const gzipInfo =
    gzipRes.status === 'fulfilled' && encodingOf(gzipRes) === 'gzip'
      ? { encoding: 'gzip', transferredBytes: gzipRes.value.transferredBytes, served: true }
      : { encoding: encodingOf(gzipRes), transferredBytes: null, served: false };

  return {
    url,
    finalUrl: browserRes.finalUrl,
    status: browserRes.statusCode,
    responseHeaders: browserRes.headers,
    raw: { html, rawBytes },
    responses: {
      browser: { encoding: browserEncoding, transferredBytes: browserRes.transferredBytes },
      br: brInfo,
      gzip: gzipInfo
    }
  };
}
