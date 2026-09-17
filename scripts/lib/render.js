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
  const failed = sorted.filter((r) => r.status === 'fail');

  // Details first (so the eye-catching summary lands at the very bottom).
  if (failed.length === 0) {
    lines.push(c.bold('FAIL DETAILS'));
    lines.push(color ? pc.dim('No failing checks — see the summary below.') : 'No failing checks — see the summary below.');
    lines.push('');
  } else {
    lines.push(c.bold(`FAIL DETAILS (${failed.length} of ${sorted.length} checks)`));
    lines.push('');
    failed.forEach((r) => {
      lines.push(c.bold(`── ${r.name} ${'─'.repeat(Math.max(0, 60 - r.name.length))}`));
      lines.push(`Status: ${statusColor[r.status] || r.status}  —  ${r.summary}`);
      lines.push('');
      for (const section of r.details || []) {
        lines.push(renderDetail(section, { color }));
        lines.push('');
      }
    });
  }

  // Improvements table + dashboard render last (they stay on screen when the
  // command finishes and the terminal is scrolled to the bottom).
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

  lines.push(renderDashboard(sorted, { color }));

  return lines.join('\n');
}

function renderDashboard(sorted, { color }) {
  const width = 72;
  const total = sorted.length;
  const counts = { pass: 0, warn: 0, fail: 0 };
  const priCounts = { high: 0, medium: 0, low: 0 };
  for (const r of sorted) {
    if (counts[r.status] !== undefined) counts[r.status]++;
    if (priCounts[r.priority] !== undefined) priCounts[r.priority]++;
  }

  const top = sorted.find((r) => r.status !== 'pass');
  const scoreLine = `Score: ${counts.pass}/${total} checks pass`;
  const priLine =
    `${dot('red', color)} ${priCounts.high} High   ` +
    `${dot('yellow', color)} ${priCounts.medium} Medium   ` +
    `${dot('cyan', color)} ${priCounts.low} Low`;
  const passLine = `${statusIcon('pass', color)} Pass    ${counts.pass}`;
  const warnLine = `${statusIcon('warn', color)} Improve ${counts.warn}`;
  const failLine = `${statusIcon('fail', color)} Fail    ${counts.fail}`;
  const rightColWidth = width - 7 - 34;
  const topLine = top
    ? truncateLine(`Top issue: ${top.name} (${PRIORITY_LABEL[top.priority] || top.priority})`, rightColWidth)
    : 'No issues detected';

  const title = ' PERFORMANCE DASHBOARD ';
  const dashes = '─'.repeat(Math.max(0, width - title.length - 2));
  const topBar = `┌${dashes.slice(0, Math.floor(dashes.length / 2))}${title}${dashes.slice(Math.floor(dashes.length / 2))}┐`;
  const bottomBar = `└${'─'.repeat(width - 2)}┘`;
  const sep = `├${'─'.repeat(width - 2)}┤`;

  const leftCol = 34;
  const rightCol = width - 7 - leftCol;

  const rows = [
    [scoreLine, priLine],
    [passLine, ''],
    [warnLine, topLine],
    [failLine, '']
  ];

  const vbar = color ? pc.cyan('│') : '│';
  const body = rows.map(
    ([l, r]) => `${vbar} ${padVisible(l, leftCol)} ${vbar} ${padVisible(r, rightCol)} ${vbar}`
  );

  const framed = [
    color ? pc.cyan(topBar) : topBar,
    ...body.slice(0, 1),
    color ? pc.cyan(sep) : sep,
    ...body.slice(1),
    color ? pc.cyan(bottomBar) : bottomBar
  ];
  return framed.join('\n');
}

// Length that ignores ANSI escape sequences.
function visibleLength(s) {
  return s.replace(/\[[0-9;]*m/g, '').length;
}

function padVisible(s, width) {
  const len = visibleLength(s);
  if (len >= width) return s;
  return s + ' '.repeat(width - len);
}

function truncateLine(s, width) {
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, width - 1) + '…';
}

function dot(colorName, color) {
  if (!color) return '●';
  if (colorName === 'red') return pc.red('●');
  if (colorName === 'yellow') return pc.yellow('●');
  if (colorName === 'cyan') return pc.cyan('●');
  return '●';
}

function statusIcon(status, color) {
  if (status === 'pass') return color ? pc.green('✓') : '✓';
  if (status === 'warn') return color ? pc.yellow('⚠') : '⚠';
  if (status === 'fail') return color ? pc.red('✗') : '✗';
  return '?';
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
  if (section.type === 'css-before-js') return renderCssBeforeJs(section, color);
  if (section.type === 'iframes') return renderIframes(section, color);
  if (section.type === 'css-minification') return renderCssMinification(section, color);
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

function renderCssBeforeJs(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  const { scripts, styles, offenders } = section.totals;
  lines.push(
    `Scripts: ${formatInt(scripts)} · Stylesheets: ${formatInt(styles)} · Offending scripts: ${formatInt(offenders)}`
  );
  if (offenders === 0) return lines.join('\n');
  const t = new Table({
    head: ['Line', 'Script', 'Blocking?', 'CSS after'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  for (const o of section.offenders) {
    const blocking = o.renderBlocking
      ? (color ? pc.red('yes') : 'yes')
      : (color ? pc.yellow('no') : 'no');
    const cssPreview = o.cssAfter
      .slice(0, 3)
      .map((c) => `L${c.line ?? '?'} ${c.label}`)
      .join('\n');
    const more = o.cssAfter.length > 3 ? `\n(+${o.cssAfter.length - 3} more)` : '';
    t.push([
      o.line == null ? '—' : `L${o.line}`,
      o.label,
      blocking,
      cssPreview + more
    ]);
  }
  lines.push(t.toString());
  return lines.join('\n');
}

function renderIframes(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  lines.push(`Total iframes: ${formatInt(section.count)}`);
  if (section.count === 0) return lines.join('\n');
  const t = new Table({
    head: ['#', 'Line', 'src', 'Flags'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  section.iframes.forEach((f, i) => {
    const flags = f.flags.length ? f.flags.join(', ') : '—';
    t.push([
      String(i + 1),
      f.line == null ? '—' : `L${f.line}`,
      f.label,
      flags
    ]);
  });
  lines.push(t.toString());
  return lines.join('\n');
}

function renderCssMinification(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  const t = section.totals;
  lines.push(
    `Inline: ${formatInt(t.inlineCount)} · External fetched: ${formatInt(t.externalFetched)}/${formatInt(t.externalCount)} · ` +
      `Raw ${formatKB(t.rawBytes)} → Min ${formatKB(t.minBytes)} · Savings ${formatKB(t.savings)}`
  );
  const residualExtra = (t.residualSavings ?? 0) - t.savings;
  if (residualExtra > 0) {
    const note = `  (plus ~${formatKB(residualExtra)} residual whitespace across already-minified files — not counted)`;
    lines.push(color ? pc.dim(note) : note);
  }

  // Prominent list of URLs that still need minification — this is the
  // primary actionable output for the user.
  const notMinInline = section.styles
    .filter((s) => !s.minified && s.savings > 0)
    .map((s) => ({ label: `inline @ L${s.line ?? '?'}`, savings: s.savings }));
  const notMinExternal = section.externals
    .filter((e) => e.ok && !e.minified && e.savings > 0)
    .map((e) => ({ label: e.href, savings: e.savings }));
  const notMin = [...notMinExternal, ...notMinInline].sort((a, b) => b.savings - a.savings);
  if (notMin.length > 0) {
    const header = `Not minified — fix these (${notMin.length}):`;
    lines.push(color ? pc.yellow(pc.bold(header)) : header);
    for (const n of notMin) {
      const bullet = `  • ${n.label}  — save ${formatKB(n.savings)}`;
      lines.push(color ? pc.yellow(bullet) : bullet);
    }
  }

  if (section.styles.length > 0) {
    lines.push(color ? pc.bold('Inline <style> blocks') : 'Inline <style> blocks');
    const tbl = new Table({
      head: ['#', 'Line', 'Raw', 'Min', 'Savings', 'State'],
      style: { head: color ? ['cyan'] : [], border: [] }
    });
    for (const s of section.styles) {
      const state = s.minified
        ? (color ? pc.green('✓ minified') : '✓ minified')
        : (color ? pc.yellow('✗ not minified') : '✗ not minified');
      tbl.push([
        String(s.index),
        s.line == null ? '—' : `L${s.line}`,
        formatKB(s.rawBytes),
        formatKB(s.minBytes),
        formatKB(s.savings),
        state
      ]);
    }
    lines.push(tbl.toString());
  }

  if (section.externals.length > 0) {
    lines.push(color ? pc.bold('External stylesheets') : 'External stylesheets');
    const tbl = new Table({
      head: ['#', 'URL', 'Status', 'Raw', 'Min', 'Savings', 'State'],
      style: { head: color ? ['cyan'] : [], border: [] },
      colWidths: [4, 80, 8, 9, 9, 10, 18],
      wordWrap: true
    });
    for (const e of section.externals) {
      const url = e.href;
      if (!e.ok) {
        const reason = e.error ? `${e.error.code}${e.error.message ? ': ' + e.error.message : ''}` : 'error';
        const state = color ? pc.red(truncateStr(reason, 40)) : truncateStr(reason, 40);
        tbl.push([
          String(e.index),
          url,
          e.status == null ? '—' : String(e.status),
          '—',
          '—',
          '—',
          state
        ]);
      } else {
        const state = e.minified
          ? (color ? pc.green('✓ minified') : '✓ minified')
          : (color ? pc.yellow('✗ not minified') : '✗ not minified');
        tbl.push([
          String(e.index),
          url,
          String(e.status),
          formatKB(e.rawBytes),
          formatKB(e.minBytes),
          formatKB(e.savings),
          state
        ]);
      }
    }
    lines.push(tbl.toString());
  }

  if (section.skipped && section.skipped.length > 0) {
    const note = `Skipped past cap of ${section.skipped.length + section.externals.length}: ${section.skipped.length} stylesheets not fetched.`;
    lines.push(color ? pc.dim(note) : note);
    for (const s of section.skipped.slice(0, 5)) {
      const line = s.line == null ? '—' : `L${s.line}`;
      const msg = `  ${line}  ${s.href}`;
      lines.push(color ? pc.dim(msg) : msg);
    }
    if (section.skipped.length > 5) {
      const more = `  (+${section.skipped.length - 5} more)`;
      lines.push(color ? pc.dim(more) : more);
    }
  }

  return lines.join('\n');
}

function truncateStr(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
