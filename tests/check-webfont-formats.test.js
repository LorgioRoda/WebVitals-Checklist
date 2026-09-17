import { test } from 'node:test';
import assert from 'node:assert/strict';
import webfontFormats from '../scripts/checks/webfont-formats.js';
import { startFixtureServer } from './fixtures/server.js';

function ctxOf(html, finalUrl = null) {
  return { raw: { html }, finalUrl };
}

test('pass: no webfonts on the page', async () => {
  const html = `<!doctype html><html><body><p>hi</p></body></html>`;
  const result = await webfontFormats.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.total, 0);
  assert.match(result.summary, /no webfonts/);
});

test('pass: single inline @font-face with WOFF2 only', async () => {
  const html = `<!doctype html><html><head>
    <style>
      @font-face {
        font-family: 'Foo';
        src: url('/f/foo.woff2') format('woff2');
      }
    </style>
  </head><body></body></html>`;
  const result = await webfontFormats.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.woff2, 1);
  assert.equal(result.data.fonts[0].family, 'Foo');
});

test('warn: mixed WOFF2 + WOFF fallback in same @font-face', async () => {
  const html = `<!doctype html><html><head>
    <style>
      @font-face {
        font-family: 'Foo';
        src: url('/f/foo.woff2') format('woff2'),
             url('/f/foo.woff') format('woff');
      }
    </style>
  </head></html>`;
  const result = await webfontFormats.run(ctxOf(html));
  assert.equal(result.status, 'warn');
  assert.equal(result.data.woff2, 1);
  assert.equal(result.data.woff, 1);
});

test('fail: only legacy formats (WOFF, TTF)', async () => {
  const html = `<!doctype html><html><head>
    <style>
      @font-face { font-family: 'Bar'; src: url('/f/bar.woff') format('woff'); }
      @font-face { font-family: 'Baz'; src: url('/f/baz.ttf') format('truetype'); }
    </style>
  </head></html>`;
  const result = await webfontFormats.run(ctxOf(html));
  assert.equal(result.status, 'fail');
  assert.equal(result.data.woff2, 0);
  assert.equal(result.data.woff, 1);
  assert.equal(result.data.ttf, 1);
});

test('preload link: type attribute is honored over extension', async () => {
  const html = `<!doctype html><html><head>
    <link rel="preload" as="font" href="/f/noext" type="font/woff2" crossorigin>
  </head></html>`;
  const result = await webfontFormats.run(ctxOf(html));
  assert.equal(result.data.total, 1);
  assert.equal(result.data.fonts[0].format, 'woff2');
});

test('preload link: only rel=preload as=font is captured', async () => {
  const html = `<!doctype html><html><head>
    <link rel="preload" as="script" href="/x.js">
    <link rel="preload" as="font" href="/f/foo.woff2" type="font/woff2">
    <link rel="stylesheet" href="/main.css">
  </head></html>`;
  const result = await webfontFormats.run(ctxOf(html));
  assert.equal(result.data.preloads, 1);
});

test('URL classification: query strings are ignored when checking extension', async () => {
  const html = `<!doctype html><html><head>
    <style>@font-face { font-family: 'Q'; src: url('/f/q.woff2?ver=3'); }</style>
  </head></html>`;
  const result = await webfontFormats.run(ctxOf(html));
  assert.equal(result.data.fonts[0].format, 'woff2');
});

test('external stylesheet is fetched and its @font-face rules are scanned', async () => {
  const css = `
    @font-face { font-family: 'Ext'; src: url('/ext.woff2') format('woff2'); }
    @font-face { font-family: 'Old'; src: url('/old.ttf') format('truetype'); }
  `;
  const server = await startFixtureServer({
    html: '<!doctype html><html></html>',
    routes: { '/main.css': css }
  });
  try {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/main.css">
    </head></html>`;
    const result = await webfontFormats.run(ctxOf(html, server.url));
    assert.equal(result.data.externalStylesheetsScanned, 1);
    assert.equal(result.data.external, 2);
    assert.equal(result.data.woff2, 1);
    assert.equal(result.data.ttf, 1);
    // Font URLs from external CSS are resolved relative to the STYLESHEET.
    const extFont = result.data.fonts.find((f) => f.family === 'Ext');
    assert.ok(extFont.resolvedUrl.includes('/ext.woff2'));
  } finally {
    await server.close();
  }
});

test('external stylesheet failure surfaces in fetchIssues but does not fail the check', async () => {
  const server = await startFixtureServer({
    html: '<!doctype html><html></html>',
    routes: { '/broken.css': { status: 500, body: 'oops' } }
  });
  try {
    const html = `<link rel="stylesheet" href="/broken.css">`;
    const result = await webfontFormats.run(ctxOf(html, server.url));
    assert.equal(result.data.fetchIssues.length, 1);
    assert.equal(result.data.fetchIssues[0].status, 500);
    // No fonts detected at all → pass.
    assert.equal(result.status, 'pass');
  } finally {
    await server.close();
  }
});
