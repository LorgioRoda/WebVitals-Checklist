import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage, FetchError } from '../scripts/lib/fetch.js';
import { startFixtureServer } from './fixtures/server.js';
import { nonMinifiedHtml } from './fixtures/pages.js';

test('fetch: gzip-only server reports gzip served and Brotli not served', async () => {
  const s = await startFixtureServer({ html: nonMinifiedHtml, supported: ['gzip'] });
  try {
    const ctx = await fetchPage(s.url);
    assert.equal(ctx.responses.browser.encoding, 'gzip');
    assert.equal(ctx.responses.gzip.served, true);
    assert.equal(ctx.responses.br.served, false);
    assert.equal(ctx.raw.html, nonMinifiedHtml);
  } finally {
    await s.close();
  }
});

test('fetch: brotli-capable server reports Brotli served (browser sent br first)', async () => {
  const s = await startFixtureServer({ html: nonMinifiedHtml, supported: ['br', 'gzip'] });
  try {
    const ctx = await fetchPage(s.url);
    assert.equal(ctx.responses.browser.encoding, 'br');
    assert.equal(ctx.responses.br.served, true);
    assert.equal(ctx.responses.gzip.served, true);
    assert.equal(ctx.raw.html, nonMinifiedHtml);
  } finally {
    await s.close();
  }
});

test('fetch: identity-only server reports no compression', async () => {
  const s = await startFixtureServer({ html: nonMinifiedHtml, supported: [] });
  try {
    const ctx = await fetchPage(s.url);
    assert.equal(ctx.responses.browser.encoding, null);
    assert.equal(ctx.responses.br.served, false);
    assert.equal(ctx.responses.gzip.served, false);
  } finally {
    await s.close();
  }
});

test('fetch: bot-challenge response is detected and aborts', async () => {
  const s = await startFixtureServer({ html: nonMinifiedHtml, challenge: true });
  try {
    await assert.rejects(
      () => fetchPage(s.url),
      (err) => err instanceof FetchError && err.code === 'BOT_CHALLENGE'
    );
  } finally {
    await s.close();
  }
});
