import { test } from 'node:test';
import assert from 'node:assert/strict';
import webfontSize from '../scripts/checks/webfont-size.js';
import { startFixtureServer } from './fixtures/server.js';

function ctxOf(html, finalUrl = null) {
  return { raw: { html }, finalUrl };
}

// Build a fake "font" body of a given size — the check only cares about
// decompressed byte length, so any body works.
function fakeFont(bytes) {
  return { body: 'x'.repeat(bytes), contentType: 'font/woff2' };
}

test('pass: no webfonts on the page', async () => {
  const result = await webfontSize.run(ctxOf('<!doctype html><html><body></body></html>'));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.discovered, 0);
});

test('pass: total under 300 KB', async () => {
  const routes = {
    '/f/a.woff2': fakeFont(100 * 1024),
    '/f/b.woff2': fakeFont(120 * 1024)
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<!doctype html><html><head>
      <link rel="preload" as="font" href="/f/a.woff2" type="font/woff2">
      <style>@font-face { font-family: 'B'; src: url('/f/b.woff2'); }</style>
    </head></html>`;
    const result = await webfontSize.run(ctxOf(html, server.url));
    assert.equal(result.status, 'pass');
    assert.equal(result.data.fetched, 2);
    assert.equal(result.data.totalBytes, 220 * 1024);
  } finally {
    await server.close();
  }
});

test('fail: total over 300 KB', async () => {
  const routes = {
    '/f/big.woff2': fakeFont(400 * 1024)
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<link rel="preload" as="font" href="/f/big.woff2">`;
    const result = await webfontSize.run(ctxOf(html, server.url));
    assert.equal(result.status, 'fail');
    assert.equal(result.data.totalBytes, 400 * 1024);
    assert.equal(result.data.overBudgetBy, (400 - 300) * 1024);
  } finally {
    await server.close();
  }
});

test('warn: under budget but some fetches failed', async () => {
  const routes = {
    '/f/ok.woff2': fakeFont(50 * 1024),
    '/f/missing.woff2': { status: 404, body: 'nope' }
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<!doctype html><html><head>
      <link rel="preload" as="font" href="/f/ok.woff2">
      <link rel="preload" as="font" href="/f/missing.woff2">
    </head></html>`;
    const result = await webfontSize.run(ctxOf(html, server.url));
    assert.equal(result.status, 'warn');
    assert.equal(result.data.fetched, 1);
    assert.equal(result.data.failed, 1);
    assert.match(result.summary, /may exceed budget/);
  } finally {
    await server.close();
  }
});

test('dedup: same URL from preload and @font-face is counted once', async () => {
  const routes = { '/f/same.woff2': fakeFont(50 * 1024) };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<!doctype html><html><head>
      <link rel="preload" as="font" href="/f/same.woff2">
      <style>@font-face { font-family: 'Same'; src: url('/f/same.woff2'); }</style>
    </head></html>`;
    const result = await webfontSize.run(ctxOf(html, server.url));
    assert.equal(result.data.discovered, 1);
    assert.equal(result.data.fetched, 1);
    assert.equal(result.data.totalBytes, 50 * 1024);
    // The single font record retains both source labels.
    assert.deepEqual(
      new Set(result.data.fonts[0].sources),
      new Set(['preload-link', 'inline-@font-face'])
    );
  } finally {
    await server.close();
  }
});

test('external @font-face: font URL is resolved against the stylesheet URL', async () => {
  const routes = {
    '/nested/main.css': `@font-face { font-family: 'Ext'; src: url('./font.woff2'); }`,
    '/nested/font.woff2': fakeFont(80 * 1024)
  };
  const server = await startFixtureServer({ html: '', routes });
  try {
    const html = `<link rel="stylesheet" href="/nested/main.css">`;
    const result = await webfontSize.run(ctxOf(html, server.url));
    assert.equal(result.data.fetched, 1);
    assert.equal(result.data.totalBytes, 80 * 1024);
    assert.match(result.data.fonts[0].resolvedUrl, /\/nested\/font\.woff2$/);
  } finally {
    await server.close();
  }
});
