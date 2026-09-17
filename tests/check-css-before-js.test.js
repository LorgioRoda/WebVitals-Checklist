import { test } from 'node:test';
import assert from 'node:assert/strict';
import cssBeforeJs from '../scripts/checks/css-before-js.js';

function ctxOf(html) {
  return { raw: { html } };
}

test('pass: CSS in <head> then script at end of body', async () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/a.css">
    <style>body{color:red}</style>
  </head><body>
    <script src="/app.js"></script>
  </body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.offenders, 0);
});

test('fail: render-blocking script in <head> before <link rel=stylesheet>', async () => {
  const html = `<!doctype html><html><head>
    <script src="/app.js"></script>
    <link rel="stylesheet" href="/a.css">
  </head><body></body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'fail');
  assert.equal(result.data.offenders, 1);
  assert.equal(result.data.worstBlocking, true);
  assert.match(result.summary, /render-blocking/);
});

test('scope: script in <body> after <head> CSS is ignored', async () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/a.css">
  </head><body>
    <script src="/app.js"></script>
    <link rel="stylesheet" href="/late.css">
  </body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.scripts, 0);
  assert.equal(result.data.styles, 1);
});

test('scope: no <head> at all => pass with dedicated summary', async () => {
  const html = `<!doctype html><html><body>
    <script src="/app.js"></script>
    <link rel="stylesheet" href="/a.css">
  </body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.match(result.summary, /no <head>/);
});

test('fail: inline script counts as render-blocking', async () => {
  const html = `<!doctype html><html><head>
    <script>window.x = 1;</script>
    <style>body{color:red}</style>
  </head><body></body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'fail');
  assert.equal(result.data.offenders, 1);
});

test('warn: defer script before CSS => non-blocking', async () => {
  const html = `<!doctype html><html><head>
    <script defer src="/app.js"></script>
    <link rel="stylesheet" href="/a.css">
  </head><body></body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'warn');
  assert.equal(result.data.offenders, 1);
  assert.equal(result.data.worstBlocking, false);
});

test('warn: async script before CSS => non-blocking', async () => {
  const html = `<!doctype html><html><head>
    <script async src="/app.js"></script>
    <style>body{color:red}</style>
  </head><body></body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'warn');
});

test('warn: type=module script before CSS => non-blocking', async () => {
  const html = `<!doctype html><html><head>
    <script type="module" src="/app.js"></script>
    <style>body{color:red}</style>
  </head><body></body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'warn');
});

test('pass: JSON-LD script is ignored', async () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">{"@context":"https://schema.org"}</script>
    <link rel="stylesheet" href="/a.css">
  </head><body></body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.offenders, 0);
});

test('pass: <link rel="preload" as="style"> is not a stylesheet', async () => {
  const html = `<!doctype html><html><head>
    <script src="/app.js"></script>
    <link rel="preload" as="style" href="/a.css">
  </head><body></body></html>`;
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'pass');
});

test('offender records include line numbers and following-CSS list', async () => {
  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <script src="/app.js"></script>',
    '  <link rel="stylesheet" href="/a.css">',
    '  <style>body{}</style>',
    '</head>',
    '<body></body>',
    '</html>'
  ].join('\n');
  const result = await cssBeforeJs.run(ctxOf(html));
  assert.equal(result.status, 'fail');
  const section = result.details[0];
  assert.equal(section.type, 'css-before-js');
  assert.equal(section.offenders.length, 1);
  const [o] = section.offenders;
  assert.equal(o.line, 4);
  assert.equal(o.renderBlocking, true);
  assert.equal(o.cssAfter.length, 2);
  assert.equal(o.cssAfter[0].line, 5);
  assert.equal(o.cssAfter[1].line, 6);
});
