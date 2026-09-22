import { test } from 'node:test';
import assert from 'node:assert/strict';
import imageOptimization from '../scripts/checks/image-optimization.js';
import { startFixtureServer } from './fixtures/server.js';

function ctxOf(html, finalUrl = null) {
  return { raw: { html }, finalUrl };
}

function bytesOfSize(n) { return 'x'.repeat(n); }

test('pass: no images on the page', async () => {
  const result = await imageOptimization.run(ctxOf('<!doctype html><html><body></body></html>'));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.discovered, 0);
});

test('pass: all modern formats served, no heavy images', async () => {
  const routes = {
    '/img/a.webp': { body: bytesOfSize(10 * 1024), contentType: 'image/webp' },
    '/img/b.avif': { body: bytesOfSize(20 * 1024), contentType: 'image/avif' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `
      <img src="/img/a.webp">
      <img src="/img/b.avif">
    `;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.status, 'pass');
    assert.equal(result.data.fetched, 2);
    assert.equal(result.data.modern, 2);
    assert.equal(result.data.legacy, 0);
  } finally {
    await server.close();
  }
});

test('fail: a single very-heavy (>500 KB) image trips fail', async () => {
  const routes = {
    '/img/big.jpg': { body: bytesOfSize(600 * 1024), contentType: 'image/jpeg' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<img src="/img/big.jpg">`;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.status, 'fail');
    assert.equal(result.data.veryHeavy, 1);
  } finally {
    await server.close();
  }
});

test('CDN content negotiation: .jpg URL served as image/webp counts as modern', async () => {
  const routes = {
    '/img/photo.jpg': (req) => {
      const accept = (req.headers['accept'] || '').toLowerCase();
      if (accept.includes('image/webp')) {
        return { body: bytesOfSize(50 * 1024), contentType: 'image/webp' };
      }
      return { body: bytesOfSize(150 * 1024), contentType: 'image/jpeg' };
    }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<img src="/img/photo.jpg">`;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.status, 'pass', `expected pass, got ${result.status} (${result.summary})`);
    assert.equal(result.data.modern, 1);
    assert.equal(result.data.legacy, 0);
    assert.equal(result.data.cdnTransformed, 1);
    assert.equal(result.data.images[0].format, 'webp');
    assert.equal(result.data.images[0].urlFormat, 'jpeg');
    assert.equal(result.data.images[0].cdnTransformed, true);
  } finally {
    await server.close();
  }
});

test('warn: legacy served format triggers warn (not fail) under 300 KB legacy weight', async () => {
  const routes = {
    '/img/legacy.png': { body: bytesOfSize(50 * 1024), contentType: 'image/png' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<img src="/img/legacy.png">`;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.status, 'warn');
    assert.equal(result.data.legacy, 1);
    assert.equal(result.data.modern, 0);
  } finally {
    await server.close();
  }
});

test('discovery: srcset, source, preload, style, and background-image are all found', async () => {
  const routes = {
    '/a.webp': { body: bytesOfSize(2 * 1024), contentType: 'image/webp' },
    '/b.webp': { body: bytesOfSize(2 * 1024), contentType: 'image/webp' },
    '/c.webp': { body: bytesOfSize(2 * 1024), contentType: 'image/webp' },
    '/d.webp': { body: bytesOfSize(2 * 1024), contentType: 'image/webp' },
    '/e.webp': { body: bytesOfSize(2 * 1024), contentType: 'image/webp' },
    '/f.webp': { body: bytesOfSize(2 * 1024), contentType: 'image/webp' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `
      <link rel="preload" as="image" href="/a.webp">
      <link rel="preload" as="image" imagesrcset="/b.webp 1x">
      <style>.hero { background-image: url('/c.webp'); }</style>
      <picture>
        <source srcset="/d.webp" type="image/webp">
        <img src="/e.webp">
      </picture>
      <div style="background: url(/f.webp) no-repeat"></div>
    `;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    // 5 groups: two preloads, style-block, one <picture> (collapses
    // /d.webp + /e.webp into one), inline style. The <picture> group
    // sees 2 variants but only fetches the largest — here neither has a
    // descriptor so the first source wins.
    assert.equal(result.data.discovered, 5);
    assert.equal(result.data.fetched, 5);
    assert.equal(result.data.variantsInGroups, 6);
  } finally {
    await server.close();
  }
});

test('srcset: only the largest w descriptor is fetched', async () => {
  const routes = {
    '/small.webp': { body: bytesOfSize(10 * 1024), contentType: 'image/webp' },
    '/medium.webp': { body: bytesOfSize(50 * 1024), contentType: 'image/webp' },
    '/large.webp': { body: bytesOfSize(200 * 1024), contentType: 'image/webp' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<img srcset="/small.webp 320w, /medium.webp 768w, /large.webp 1600w" src="/small.webp">`;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.data.discovered, 1);
    assert.equal(result.data.fetched, 1);
    assert.equal(result.data.variantsInGroups, 4); // src + 3 srcset entries
    const img = result.data.images[0];
    assert.match(img.resolvedUrl, /\/large\.webp$/);
    assert.equal(img.descriptor, '1600w');
    assert.equal(img.variantCount, 4);
  } finally {
    await server.close();
  }
});

test('<picture>: largest across all <source> srcsets is picked', async () => {
  const routes = {
    '/small.webp': { body: bytesOfSize(10 * 1024), contentType: 'image/webp' },
    '/large.avif': { body: bytesOfSize(50 * 1024), contentType: 'image/avif' },
    '/fallback.jpg': { body: bytesOfSize(30 * 1024), contentType: 'image/jpeg' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `
      <picture>
        <source srcset="/small.webp 320w, /large.avif 1600w" type="image/avif">
        <img src="/fallback.jpg">
      </picture>
    `;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.data.discovered, 1);
    assert.equal(result.data.fetched, 1);
    const img = result.data.images[0];
    assert.match(img.resolvedUrl, /\/large\.avif$/);
    assert.equal(img.descriptor, '1600w');
  } finally {
    await server.close();
  }
});

test('dedup: the same URL discovered from multiple sources is fetched once', async () => {
  const routes = {
    '/same.webp': { body: bytesOfSize(5 * 1024), contentType: 'image/webp' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `
      <link rel="preload" as="image" href="/same.webp">
      <img src="/same.webp">
      <div style="background-image: url('/same.webp')"></div>
    `;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.data.discovered, 1);
    assert.equal(result.data.fetched, 1);
    assert.ok(result.data.images[0].sources.length >= 3);
  } finally {
    await server.close();
  }
});

test('data: URIs are ignored', async () => {
  const html = `<img src="data:image/png;base64,iVBORw0KGgo=">`;
  const result = await imageOptimization.run(ctxOf(html, 'http://example.test/'));
  assert.equal(result.data.discovered, 0);
});

test('warn: fetch failure surfaces as warn with error listed', async () => {
  const routes = {
    '/missing.webp': { status: 404, body: 'nope' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<img src="/missing.webp">`;
    const result = await imageOptimization.run(ctxOf(html, server.url));
    assert.equal(result.status, 'warn');
    assert.equal(result.data.failed, 1);
  } finally {
    await server.close();
  }
});
