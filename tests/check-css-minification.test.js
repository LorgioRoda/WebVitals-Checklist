import { test } from 'node:test';
import assert from 'node:assert/strict';
import cssMinification, { minifyCssHeuristic } from '../scripts/checks/css-minification.js';
import { startFixtureServer } from './fixtures/server.js';

function ctxOfHtml(html, finalUrl = null) {
  return { raw: { html }, finalUrl };
}

test('pass: no CSS on the page at all', async () => {
  const html = `<!doctype html><html><body><p>hi</p></body></html>`;
  const result = await cssMinification.run(ctxOfHtml(html));
  assert.equal(result.status, 'pass');
  assert.match(result.summary, /no CSS/);
});

test('pass: single already-minified inline style', async () => {
  const html = `<!doctype html><html><head>
    <style>body{margin:0;padding:0}h1{color:red}</style>
  </head><body></body></html>`;
  const result = await cssMinification.run(ctxOfHtml(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.styles.length, 1);
  assert.equal(result.data.styles[0].minified, true);
});

test('warn: small savings (under 500 bytes)', async () => {
  const html = `<!doctype html><html><head>
    <style>
      body { color: red; }
    </style>
  </head><body></body></html>`;
  const result = await cssMinification.run(ctxOfHtml(html));
  assert.equal(result.status, 'warn');
  assert.ok(result.data.totalSavings > 0);
  assert.ok(result.data.totalSavings < 500);
});

test('fail: significant savings from inline (>= 500 bytes)', async () => {
  const rule = `
      .item-XXX {
        color: red;
        background-color: white;
        padding: 10px;
        margin: 10px;
      }
`;
  const bulk = Array.from({ length: 60 }, (_, i) => rule.replace('XXX', String(i))).join('\n');
  const html = `<!doctype html><html><head><style>${bulk}</style></head><body></body></html>`;
  const result = await cssMinification.run(ctxOfHtml(html));
  assert.equal(result.status, 'fail');
  assert.ok(result.data.totalSavings >= 500);
});

test('minifyCssHeuristic: strips /* comments */', () => {
  assert.equal(minifyCssHeuristic('body { /* red */ color: red; }'), 'body{color:red}');
});

test('minifyCssHeuristic: collapses whitespace and drops trailing semicolons', () => {
  const out = minifyCssHeuristic(`
    .a  ,  .b {
      color:  red  ;
      margin: 0  ;
    }
  `);
  assert.equal(out, '.a,.b{color:red;margin:0}');
});

test('link rel="preload" as="style" is NOT treated as a stylesheet', async () => {
  const html = `<!doctype html><html><head>
    <link rel="preload" as="style" href="/a.css">
  </head><body></body></html>`;
  const result = await cssMinification.run(ctxOfHtml(html));
  assert.equal(result.data.externalCount, 0);
});

test('external CSS: fetched, analyzed, savings computed', async () => {
  const bulk =
    Array.from({ length: 40 }, (_, i) => `.item-${i} {\n  color: red;\n  padding: 10px;\n}`).join('\n\n');
  const server = await startFixtureServer({
    html: '<!doctype html><html><head></head></html>',
    routes: { '/bulk.css': bulk, '/mini.css': 'body{color:red}' }
  });
  try {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/bulk.css">
      <link rel="stylesheet" href="/mini.css">
    </head></html>`;
    const result = await cssMinification.run(ctxOfHtml(html, server.url));
    assert.equal(result.data.externalFetched, 2);
    assert.equal(result.data.externalFailed, 0);
    const bulkResult = result.data.externals.find((e) => e.href === '/bulk.css');
    const miniResult = result.data.externals.find((e) => e.href === '/mini.css');
    assert.equal(bulkResult.ok, true);
    assert.equal(bulkResult.minified, false);
    assert.ok(bulkResult.savings > 0);
    assert.equal(miniResult.ok, true);
    assert.equal(miniResult.minified, true);
  } finally {
    await server.close();
  }
});

test('external CSS: 404 is surfaced as an unreachable row (does not fail check)', async () => {
  const server = await startFixtureServer({
    html: '<!doctype html><html><head></head></html>',
    routes: { '/missing.css': { status: 404, body: 'not found' } }
  });
  try {
    const html = `<link rel="stylesheet" href="/missing.css">`;
    const result = await cssMinification.run(ctxOfHtml(html, server.url));
    assert.equal(result.data.externalFetched, 0);
    assert.equal(result.data.externalFailed, 1);
    const [ext] = result.data.externals;
    assert.equal(ext.ok, false);
    assert.equal(ext.status, 404);
    assert.equal(ext.error.code, 'HTTP_ERROR');
    // No inline savings, no external savings that count → pass.
    assert.equal(result.status, 'pass');
  } finally {
    await server.close();
  }
});

test('external CSS: fetch respects the cap of 20', async () => {
  const routes = {};
  const links = [];
  for (let i = 0; i < 25; i++) {
    routes[`/s-${i}.css`] = 'body{color:red}';
    links.push(`<link rel="stylesheet" href="/s-${i}.css">`);
  }
  const server = await startFixtureServer({
    html: '<!doctype html><html><head></head></html>',
    routes
  });
  try {
    const html = `<!doctype html><html><head>${links.join('\n')}</head></html>`;
    const result = await cssMinification.run(ctxOfHtml(html, server.url));
    assert.equal(result.data.externalCount, 25);
    assert.equal(result.data.externalFetched, 20);
    assert.equal(result.data.externalSkipped, 5);
  } finally {
    await server.close();
  }
});
