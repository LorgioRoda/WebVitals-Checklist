import { test } from 'node:test';
import assert from 'node:assert/strict';
import htmlDocument from '../scripts/checks/html-document.js';
import { fetchPage } from '../scripts/lib/fetch.js';
import { startFixtureServer } from './fixtures/server.js';
import { nonMinifiedHtml, minifiedHtml } from './fixtures/pages.js';

async function auditWith({ html, supported }) {
  const s = await startFixtureServer({ html, supported });
  try {
    const ctx = await fetchPage(s.url);
    const result = await htmlDocument.run(ctx);
    return { ctx, result };
  } finally {
    await s.close();
  }
}

test('compression table: Brotli row is first', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['gzip'] });
  const compression = result.details.find((d) => d.type === 'compression');
  assert.equal(compression.rows[0].encoding, 'Brotli');
  assert.equal(compression.rows[1].encoding, 'Gzip');
  assert.equal(compression.rows[2].encoding, 'None');
});

test('compression table: gzip-only server reports gzip real, Brotli estimated', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['gzip'] });
  const compression = result.details.find((d) => d.type === 'compression');
  const brRow = compression.rows.find((r) => r.encoding === 'Brotli');
  const gzipRow = compression.rows.find((r) => r.encoding === 'Gzip');
  assert.equal(brRow.estimated, true);
  assert.equal(brRow.served, false);
  assert.equal(gzipRow.estimated, false);
  assert.equal(gzipRow.served, true);
  assert.ok(compression.footnote && compression.footnote.startsWith('*'));
});

test('compression table: brotli-capable server reports both real', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['br', 'gzip'] });
  const compression = result.details.find((d) => d.type === 'compression');
  assert.equal(compression.rows[0].estimated, false);
  assert.equal(compression.rows[1].estimated, false);
  assert.equal(compression.footnote, null);
});

test('status/summary: gzip only + not minified => warn', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['gzip'] });
  assert.equal(result.status, 'warn');
  assert.match(result.summary, /gzip only/);
  assert.match(result.summary, /not minified/);
});

test('status/summary: Brotli + minified => pass', async () => {
  const { result } = await auditWith({ html: minifiedHtml, supported: ['br', 'gzip'] });
  assert.equal(result.status, 'pass');
  assert.match(result.summary, /Brotli/);
  assert.match(result.summary, /^Brotli, minified/);
});

test('status/summary: no compression => fail', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: [] });
  assert.equal(result.status, 'fail');
  assert.match(result.summary, /no compression/);
});

test('minification detection: non-minified fixture', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['gzip'] });
  const min = result.details.find((d) => d.type === 'minification');
  assert.equal(min.minified, false);
  assert.ok(min.commentCount >= 1);
  assert.ok(min.indentPct > 1);
});

test('minification detection: minified fixture', async () => {
  const { result } = await auditWith({ html: minifiedHtml, supported: ['br', 'gzip'] });
  const min = result.details.find((d) => d.type === 'minification');
  assert.equal(min.minified, true);
  assert.equal(min.commentCount, 0);
  assert.ok(min.indentPct < 1);
});

test('breakdown: percentages sum to 100%', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['gzip'] });
  const b = result.details.find((d) => d.type === 'breakdown');
  const totalPct = b.rows.reduce((a, r) => a + r.pct, 0);
  assert.ok(Math.abs(totalPct - 100) < 0.01, `expected 100%, got ${totalPct}`);
  const totalBytes = b.rows.reduce((a, r) => a + r.bytes, 0);
  assert.equal(totalBytes, b.totalBytes);
});

test('breakdown: is sorted heaviest first', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['gzip'] });
  const b = result.details.find((d) => d.type === 'breakdown');
  for (let i = 1; i < b.rows.length; i++) {
    assert.ok(b.rows[i - 1].bytes >= b.rows[i].bytes, 'rows should descend');
  }
});

test('breakdown: JSON script, inline JS, inline CSS, SVG, comments all detected', async () => {
  const { result } = await auditWith({ html: nonMinifiedHtml, supported: ['gzip'] });
  const b = result.details.find((d) => d.type === 'breakdown');
  const byLabel = Object.fromEntries(b.rows.map((r) => [r.label, r.bytes]));
  assert.ok(byLabel['JSON in <script>'] > 0);
  assert.ok(byLabel['Inline JavaScript'] > 0);
  assert.ok(byLabel['Inline CSS <style>'] > 0);
  assert.ok(byLabel['Inline SVG'] > 0);
  assert.ok(byLabel['HTML comments'] > 0);
  assert.ok(byLabel['class="" attributes'] > 0);
  assert.ok(byLabel['data-* attributes'] > 0);
  assert.ok(byLabel['style="" attributes'] > 0);
  assert.ok(byLabel['Indentation whitespace'] > 0);
});
