import { test } from 'node:test';
import assert from 'node:assert/strict';
import cssInBody from '../scripts/checks/css-in-body.js';
import { cssInBodyHtml } from './fixtures/pages.js';

function ctxOf(html) {
  return { raw: { html, rawBytes: Buffer.byteLength(html, 'utf8') } };
}

test('pass: no <style> in body', async () => {
  const html = `<!doctype html><html><head><style>body{margin:0}</style></head><body><p>hi</p></body></html>`;
  const result = await cssInBody.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.total, 0);
  assert.match(result.summary, /no <style>/);
});

test('fixture: <style> in head is NOT reported', async () => {
  const result = await cssInBody.run(ctxOf(cssInBodyHtml));
  const inHead = result.data.blocks.find((b) => b.context && b.context.includes('head'));
  assert.equal(inHead, undefined);
  // 3 real body blocks (early height, @import, footer color) + 0 head + 1 ignored
  assert.equal(result.data.total, 3);
});

test('fixture: early <style> with height is severity high (layout in first 30%)', async () => {
  const result = await cssInBody.run(ctxOf(cssInBodyHtml));
  const early = result.data.blocks[0];
  assert.equal(early.severity, 'high');
  assert.ok(early.layoutProps.includes('height'));
  assert.ok(early.layoutProps.includes('width'));
  assert.ok(early.reasons.some((r) => /first 30/.test(r)));
});

test('fixture: <style> with @import is severity high', async () => {
  const result = await cssInBody.run(ctxOf(cssInBodyHtml));
  const importBlock = result.data.blocks.find((b) => b.atRules.includes('import'));
  assert.ok(importBlock, 'expected a block with @import');
  assert.equal(importBlock.severity, 'high');
  assert.ok(importBlock.reasons.some((r) => /@import/.test(r)));
});

test('fixture: late color-only <style> is severity low', async () => {
  const result = await cssInBody.run(ctxOf(cssInBodyHtml));
  const footerBlock = result.data.blocks.find((b) => b.context && b.context.includes('site-footer'));
  assert.ok(footerBlock, 'expected the footer block');
  assert.equal(footerBlock.severity, 'low');
  assert.equal(footerBlock.layoutProps.length, 0);
});

test('fixture: <style> inside <template> is ignored (not analyzed)', async () => {
  const result = await cssInBody.run(ctxOf(cssInBodyHtml));
  assert.equal(result.data.ignored.length, 1);
  assert.match(result.data.ignored[0].reason, /template/);
});

test('fixture: <link rel=stylesheet> in body captured as informational', async () => {
  const result = await cssInBody.run(ctxOf(cssInBodyHtml));
  assert.equal(result.data.bodyLinks.length, 1);
});

test('fixture: aggregate status is fail (two high blocks)', async () => {
  const result = await cssInBody.run(ctxOf(cssInBodyHtml));
  assert.equal(result.status, 'fail');
  assert.equal(result.data.high, 2);
  assert.equal(result.data.low, 1);
});

test('block position % is derived from byte offset', async () => {
  const html = `<!doctype html><html><body><p>xxx</p><style>.a{color:red}</style>${'z'.repeat(2000)}</body></html>`;
  const result = await cssInBody.run(ctxOf(html));
  assert.equal(result.data.total, 1);
  const b = result.data.blocks[0];
  assert.ok(b.pct > 0 && b.pct < 0.5, `pct should be < 0.5, got ${b.pct}`);
});

test('nearest ancestor with class or id is surfaced as context', async () => {
  const html = `<!doctype html><html><body>
    <section id="hero"><div class="cmp-inner"><style>.a{color:red}</style></div></section>
  </body></html>`;
  const result = await cssInBody.run(ctxOf(html));
  assert.equal(result.data.blocks[0].context, '.cmp-inner');
});

test('broad selector (bare tag) without layout is medium', async () => {
  const html = `<!doctype html><html><body>
    ${'<p>x</p>'.repeat(200)}
    <style>p { color: red; }</style>
  </body></html>`;
  const result = await cssInBody.run(ctxOf(html));
  assert.equal(result.data.blocks[0].severity, 'medium');
});
