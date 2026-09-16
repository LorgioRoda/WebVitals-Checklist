// Terminal rendering: header, prioritized improvements list, per-check details.

import Table from 'cli-table3';
import pc from 'picocolors';

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const STATUS_ORDER = { fail: 0, warn: 1, pass: 2 };

const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS_LABEL = {
  pass: pc.green('✓ Pass'),
  warn: pc.yellow('⚠ Improve'),
  fail: pc.red('✗ Fail')
};

const KB = 1024;

export function formatKB(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  return `${(bytes / KB).toFixed(1)} KB`;
}

export function formatPct(pct) {
  if (pct == null || Number.isNaN(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

export function formatInt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.trunc(n).toLocaleString('en-US');
}

function colorStatusText(status, text) {
  if (status === 'pass') return pc.green(text);
  if (status === 'warn') return pc.yellow(text);
  if (status === 'fail') return pc.red(text);
  return text;
}

export function sortResults(results) {
  return results.slice().sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  });
}

export function renderReport(context, results, { color = true } = {}) {
  const lines = [];
  const c = color ? pc : passthrough();
  const statusColor = color
    ? STATUS_LABEL
    : {
        pass: '✓ Pass',
        warn: '⚠ Improve',
        fail: '✗ Fail'
      };

  lines.push('');
  lines.push(`${c.bold('URL:')}       ${context.url}`);
  lines.push(`${c.bold('Final URL:')} ${context.finalUrl}`);
  lines.push(`${c.bold('Status:')}    ${context.status}`);
  lines.push('');

  const sorted = sortResults(results);
  lines.push(c.bold(`PERFORMANCE IMPROVEMENTS — ${context.finalUrl}`));
  const summaryTable = new Table({
    head: ['#', 'Check', 'Priority', 'Status', 'Summary'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  sorted.forEach((r, i) => {
    summaryTable.push([
      String(i + 1),
      r.name,
      PRIORITY_LABEL[r.priority] || r.priority,
      statusColor[r.status] || r.status,
      color ? colorStatusText(r.status, r.summary) : r.summary
    ]);
  });
  lines.push(summaryTable.toString());
  lines.push('');

  sorted.forEach((r) => {
    lines.push(c.bold(`── ${r.name} ${'─'.repeat(Math.max(0, 60 - r.name.length))}`));
    lines.push(`Status: ${statusColor[r.status] || r.status}  —  ${r.summary}`);
    lines.push('');
    for (const section of r.details || []) {
      lines.push(renderDetail(section, { color }));
      lines.push('');
    }
  });

  return lines.join('\n');
}

function passthrough() {
  // Identity color helpers when color is disabled.
  const id = (s) => s;
  return new Proxy(
    {},
    {
      get: () => id
    }
  );
}

function renderDetail(section, { color }) {
  if (section.type === 'compression') return renderCompression(section, color);
  if (section.type === 'minification') return renderMinification(section, color);
  if (section.type === 'breakdown') return renderBreakdown(section, color);
  return '';
}

function tick(v, color) {
  if (v === null || v === undefined) return '—';
  const s = v ? '✓' : '✗';
  if (!color) return s;
  return v ? pc.green(s) : pc.red(s);
}

function renderCompression(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  const t = new Table({
    head: ['Encoding', 'Served?', 'Size', 'vs raw'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  for (const row of section.rows) {
    const sizeStr = `${formatKB(row.bytes)}${row.estimated ? '*' : ''}`;
    const pctStr = row.encoding === 'None' ? '—' : formatPct(row.pctOfRaw);
    const servedStr =
      row.served === null ? '—' : tick(row.served, color);
    t.push([row.encoding, servedStr, sizeStr, pctStr]);
  }
  lines.push(t.toString());
  if (section.footnote) lines.push(color ? pc.dim(section.footnote) : section.footnote);
  return lines.join('\n');
}

function renderMinification(section, color) {
  const lines = [];
  const header = section.minified
    ? (color ? pc.green('✓ Minified') : '✓ Minified')
    : (color ? pc.yellow('✗ Not minified') : '✗ Not minified');
  lines.push(`${color ? pc.bold(section.title) : section.title} — ${header}`);
  const t = new Table({
    head: ['Version', 'Lines', 'Raw', 'Brotli', 'Gzip'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  for (const row of section.rows) {
    t.push([
      row.version,
      formatInt(row.lines),
      formatKB(row.rawBytes),
      `${formatKB(row.brBytes)}${row.brEstimated ? '*' : ''}`,
      `${formatKB(row.gzipBytes)}${row.gzipEstimated ? '*' : ''}`
    ]);
  }
  lines.push(t.toString());
  lines.push(
    `Indentation: ${formatKB(section.indentBytes)} (${formatPct(section.indentPct)}) · ` +
      `Blank lines: ${formatInt(section.blankLines)} · ` +
      `HTML comments: ${formatInt(section.commentCount)}`
  );
  return lines.join('\n');
}

function renderBreakdown(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  const t = new Table({
    head: ['Part', 'Size', '%'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  for (const row of section.rows) {
    t.push([row.label, formatKB(row.bytes), formatPct(row.pct)]);
  }
  lines.push(t.toString());
  return lines.join('\n');
}
