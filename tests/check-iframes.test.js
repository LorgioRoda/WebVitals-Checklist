import { test } from 'node:test';
import assert from 'node:assert/strict';
import iframes from '../scripts/checks/iframes.js';

function ctxOf(html) {
  return { raw: { html } };
}

test('pass: no iframes on the page', async () => {
  const html = `<!doctype html><html><body><p>hi</p></body></html>`;
  const result = await iframes.run(ctxOf(html));
  assert.equal(result.status, 'pass');
  assert.equal(result.data.count, 0);
  assert.match(result.summary, /no iframes/);
});

test('warn: exactly one iframe', async () => {
  const html = `<!doctype html><html><body>
    <iframe src="https://www.youtube.com/embed/abc123" title="video"></iframe>
  </body></html>`;
  const result = await iframes.run(ctxOf(html));
  assert.equal(result.status, 'warn');
  assert.equal(result.data.count, 1);
  assert.equal(result.data.iframes[0].src, 'https://www.youtube.com/embed/abc123');
});

test('fail: two or more iframes', async () => {
  const html = `<!doctype html><html><body>
    <iframe src="https://a.example/one"></iframe>
    <iframe src="https://b.example/two"></iframe>
    <iframe src="https://c.example/three"></iframe>
  </body></html>`;
  const result = await iframes.run(ctxOf(html));
  assert.equal(result.status, 'fail');
  assert.equal(result.data.count, 3);
  assert.match(result.summary, /3 iframes/);
});

test('iframes without src are captured (srcdoc)', async () => {
  const html = `<!doctype html><html><body>
    <iframe srcdoc="<p>hello</p>"></iframe>
  </body></html>`;
  const result = await iframes.run(ctxOf(html));
  assert.equal(result.status, 'warn');
  assert.equal(result.data.iframes[0].src, null);
  assert.equal(result.data.iframes[0].hasSrcdoc, true);
  assert.equal(result.data.iframes[0].label, '(inline srcdoc)');
});

test('iframe attributes are surfaced as flags', async () => {
  const html = `<!doctype html><html><body>
    <iframe src="/x" sandbox loading="lazy" hidden></iframe>
  </body></html>`;
  const result = await iframes.run(ctxOf(html));
  const [f] = result.data.iframes;
  assert.ok(f.flags.includes('sandbox'));
  assert.ok(f.flags.includes('loading=lazy'));
  assert.ok(f.flags.includes('hidden'));
});

test('line numbers point to each iframe', async () => {
  const html = [
    '<!doctype html>',
    '<html>',
    '<body>',
    '  <iframe src="/a"></iframe>',
    '  <p>text</p>',
    '  <iframe src="/b"></iframe>',
    '</body>',
    '</html>'
  ].join('\n');
  const result = await iframes.run(ctxOf(html));
  assert.equal(result.data.iframes[0].line, 4);
  assert.equal(result.data.iframes[1].line, 6);
});

test('details section is populated with the URL list', async () => {
  const html = `<iframe src="https://example.com/embed"></iframe>`;
  const result = await iframes.run(ctxOf(html));
  const section = result.details[0];
  assert.equal(section.type, 'iframes');
  assert.equal(section.count, 1);
  assert.equal(section.iframes[0].label, 'https://example.com/embed');
});
