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

test('renderReport: details section lists failing AND warn checks (not pass)', () => {
  const ctx = { url: 'http://x/', finalUrl: 'http://x/', status: 200 };
  const results = [
    {
      id: 'pass-check',
      name: 'Passing thing',
      priority: 'medium',
      status: 'pass',
      summary: 'all good',
      details: [{ type: 'iframes', title: 'PASS_DETAIL_MARKER', count: 0, iframes: [] }]
    },
    {
      id: 'warn-check',
      name: 'Warn thing',
      priority: 'medium',
      status: 'warn',
      summary: 'could be better',
      details: [{ type: 'iframes', title: 'WARN_DETAIL_MARKER', count: 1, iframes: [{ line: 1, label: '/x', flags: [] }] }]
    },
    {
      id: 'fail-check',
      name: 'Failing thing',
      priority: 'high',
      status: 'fail',
      summary: 'oh no',
      details: [{ type: 'iframes', title: 'FAIL_DETAIL_MARKER', count: 3, iframes: [{ line: 1, label: '/a', flags: [] }] }]
    }
  ];
  const output = renderReport(ctx, results, { color: false });
  // The improvements table still lists every check.
  assert.match(output, /Passing thing/);
  assert.match(output, /Warn thing/);
  assert.match(output, /Failing thing/);
  // Fail + warn contribute details; pass is skipped.
  assert.match(output, /ISSUE DETAILS \(2 of 3 checks\)/);
  assert.match(output, /FAIL_DETAIL_MARKER/);
  assert.match(output, /WARN_DETAIL_MARKER/);
  assert.doesNotMatch(output, /PASS_DETAIL_MARKER/);
});

test('renderReport: shows a friendly line when no checks fail or warn', () => {
  const ctx = { url: 'http://x/', finalUrl: 'http://x/', status: 200 };
  const results = [
    { id: 'a', name: 'A', priority: 'low', status: 'pass', summary: 'ok', details: [] },
    { id: 'b', name: 'B', priority: 'low', status: 'pass', summary: 'ok', details: [] }
  ];
  const output = renderReport(ctx, results, { color: false });
  assert.match(output, /No issues detected/);
});

test('renderReport: summary (improvements table + dashboard) is rendered last', () => {
  const ctx = { url: 'http://x/', finalUrl: 'http://x/', status: 200 };
  const results = [
    {
      id: 'fail-check',
      name: 'Failing thing',
      priority: 'high',
      status: 'fail',
      summary: 'oh no',
      details: [{ type: 'iframes', title: 'FAIL_DETAIL_MARKER', count: 3, iframes: [{ line: 1, label: '/a', flags: [] }] }]
    }
  ];
  const output = renderReport(ctx, results, { color: false });
  const failIdx = output.indexOf('ISSUE DETAILS');
  const tableIdx = output.indexOf('PERFORMANCE IMPROVEMENTS');
  const dashIdx = output.indexOf('PERFORMANCE DASHBOARD');
  assert.ok(failIdx >= 0 && tableIdx >= 0 && dashIdx >= 0);
  assert.ok(failIdx < tableIdx, 'details should come before improvements table');
  assert.ok(tableIdx < dashIdx, 'improvements table should come before the dashboard');
});
