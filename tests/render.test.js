import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortResults, renderReport } from '../scripts/lib/render.js';

test('sortResults: high before medium before low', () => {
  const input = [
    { priority: 'low', status: 'pass' },
    { priority: 'high', status: 'warn' },
    { priority: 'medium', status: 'fail' }
  ];
  const sorted = sortResults(input);
  assert.equal(sorted[0].priority, 'high');
  assert.equal(sorted[1].priority, 'medium');
  assert.equal(sorted[2].priority, 'low');
});

test('sortResults: within same priority, fail before warn before pass', () => {
  const input = [
    { priority: 'medium', status: 'pass' },
    { priority: 'medium', status: 'fail' },
    { priority: 'medium', status: 'warn' }
  ];
  const sorted = sortResults(input);
  assert.deepEqual(sorted.map((r) => r.status), ['fail', 'warn', 'pass']);
});

test('renderReport: outputs a plain-text report without colors', () => {
  const ctx = { url: 'http://x/', finalUrl: 'http://x/', status: 200 };
  const results = [
    {
      id: 'test',
      name: 'Test check',
      priority: 'medium',
      status: 'warn',
      summary: 'sample summary',
      details: []
    }
  ];
  const output = renderReport(ctx, results, { color: false });
  assert.match(output, /PERFORMANCE IMPROVEMENTS/);
  assert.match(output, /Test check/);
  assert.match(output, /sample summary/);
});
