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
  if (context.ua) lines.push(`${c.bold('UA:')}        ${context.ua}`);
  if (context.raw && context.raw.rawBytes != null) {
    lines.push(`${c.bold('HTML size:')} ${formatKB(context.raw.rawBytes)}`);
  }
  lines.push('');

  const sorted = sortResults(results);
  const actionable = sorted.filter((r) => r.status === 'fail' || r.status === 'warn');

  // Details first (so the eye-catching summary lands at the very bottom).
  if (actionable.length === 0) {
    lines.push(c.bold('ISSUE DETAILS'));
    lines.push(color ? pc.dim('No issues detected — see the summary below.') : 'No issues detected — see the summary below.');
    lines.push('');
  } else {
    lines.push(c.bold(`ISSUE DETAILS (${actionable.length} of ${sorted.length} checks)`));
    lines.push('');
    actionable.forEach((r) => {
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
  if (section.type === 'css-in-body') return renderCssInBody(section, color);
  if (section.type === 'webfont-formats') return renderWebfontFormats(section, color);
  if (section.type === 'webfont-size') return renderWebfontSize(section, color);
  if (section.type === 'image-optimization') return renderImageOptimization(section, color);
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

function renderCssInBody(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);

  // 1. Summary table.
  const s = section.summary;
  const totalBytes = section.blocks.reduce((a, b) => a + b.bytes, 0);
  const summaryTable = new Table({
    head: ['Blocks in body', 'Total bytes', 'High', 'Medium', 'Low', 'Ignored', '<link> in body'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  summaryTable.push([
    formatInt(s.total),
    formatKB(totalBytes),
    sevCell('high', s.high, color),
    sevCell('medium', s.medium, color),
    sevCell('low', s.low, color),
    formatInt(s.ignored),
    formatInt(s.bodyLinks)
  ]);
  lines.push(summaryTable.toString());

  // 2. Per-block detail table.
  if (section.blocks.length > 0) {
    const t = new Table({
      head: ['#', 'Line', '% pos', 'Component', 'Bytes', 'Rules', 'Broad', 'Layout props', 'At-rules', 'Severity + reason'],
      style: { head: color ? ['cyan'] : [], border: [] },
      colWidths: [4, 8, 8, 22, 8, 7, 7, 26, 14, 34],
      wordWrap: true
    });
    for (const b of section.blocks) {
      t.push([
        String(b.index),
        b.line == null ? '—' : `L${b.line}`,
        `${(b.pct * 100).toFixed(0)}%`,
        b.context || '—',
        formatKB(b.bytes),
        formatInt(b.rules),
        formatInt(b.broadSelectors),
        b.layoutProps.length ? b.layoutProps.join(', ') : '—',
        b.atRules.length ? b.atRules.map((a) => '@' + a).join(', ') : '—',
        `${sevLabel(b.severity, color)} — ${b.reasons.join('; ')}`
      ]);
    }
    lines.push(t.toString());
  }

  // 3. Preview for High/Medium blocks.
  const risky = section.blocks.filter((b) => b.severity === 'high' || b.severity === 'medium');
  if (risky.length > 0) {
    lines.push(color ? pc.bold('CSS previews (first ~5 lines)') : 'CSS previews (first ~5 lines)');
    for (const b of risky) {
      const header = `  #${b.index} L${b.line ?? '?'} (${b.severity})`;
      lines.push(color ? pc.yellow(header) : header);
      for (const line of b.cssPreview) {
        const rendered = `    ${line}`;
        lines.push(color ? pc.dim(rendered) : rendered);
      }
    }
  }

  // 4. Ignored blocks.
  if (section.ignored && section.ignored.length > 0) {
    lines.push(color ? pc.dim(`Ignored (${section.ignored.length}):`) : `Ignored (${section.ignored.length}):`);
    for (const ig of section.ignored) {
      const msg = `  L${ig.line ?? '?'}  ${ig.reason}${ig.context ? ' — near ' + ig.context : ''}`;
      lines.push(color ? pc.dim(msg) : msg);
    }
  }

  // 5. Body <link rel=stylesheet> (informational, never penalized).
  if (section.bodyLinks && section.bodyLinks.length > 0) {
    const info = `<link rel="stylesheet"> in <body> (informational, HTTP/2 pattern):`;
    lines.push(color ? pc.dim(info) : info);
    for (const l of section.bodyLinks) {
      const msg = `  L${l.line ?? '?'}  ${l.href || '(no href)'}`;
      lines.push(color ? pc.dim(msg) : msg);
    }
  }

  // 6. Verdict.
  const verdictLine = `Verdict: ${section.verdict}`;
  lines.push(color ? pc.bold(verdictLine) : verdictLine);

  // 7. Limitations.
  if (section.limitations && section.limitations.length > 0) {
    lines.push(color ? pc.dim('Limitations:') : 'Limitations:');
    for (const l of section.limitations) {
      const msg = `  • ${l}`;
      lines.push(color ? pc.dim(msg) : msg);
    }
  }

  return lines.join('\n');
}

function sevCell(sev, n, color) {
  const s = formatInt(n);
  if (!color || n === 0) return s;
  if (sev === 'high') return pc.red(s);
  if (sev === 'medium') return pc.yellow(s);
  return pc.green(s);
}

function sevLabel(sev, color) {
  const label = sev.toUpperCase();
  if (!color) return label;
  if (sev === 'high') return pc.red(label);
  if (sev === 'medium') return pc.yellow(label);
  return pc.green(label);
}

function renderWebfontFormats(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  const c = section.counts;
  lines.push(
    `Total: ${formatInt(c.total)} · WOFF2: ${formatInt(c.woff2)} · ` +
      `WOFF: ${formatInt(c.woff)} · TTF: ${formatInt(c.ttf)} · OTF: ${formatInt(c.otf)} · ` +
      `EOT: ${formatInt(c.eot)} · Unknown: ${formatInt(c.unknown)}`
  );
  lines.push(
    `Sources — preload: ${formatInt(c.preloads)} · inline @font-face: ${formatInt(c.inline)} · ` +
      `external @font-face: ${formatInt(c.external)} ` +
      `(stylesheets scanned ${formatInt(c.externalStylesheetsScanned)}, failed ${formatInt(c.externalStylesheetsFailed)}, ` +
      `skipped past cap ${formatInt(c.externalStylesheetsSkipped)})`
  );

  // Prominent list of non-WOFF2 URLs — the primary action.
  const nonWoff2 = section.fonts.filter((f) => f.format !== 'woff2');
  if (nonWoff2.length > 0) {
    const header = `Not WOFF2 — replace these (${nonWoff2.length}):`;
    lines.push(color ? pc.yellow(pc.bold(header)) : header);
    for (const f of nonWoff2) {
      const bullet = `  • [${f.format}] ${f.url}${f.family ? ' (' + f.family + ')' : ''}`;
      lines.push(color ? pc.yellow(bullet) : bullet);
    }
  }

  if (section.fonts.length > 0) {
    const t = new Table({
      head: ['#', 'Source', 'Family', 'URL', 'Format', 'State'],
      style: { head: color ? ['cyan'] : [], border: [] },
      colWidths: [4, 20, 22, 56, 10, 14],
      wordWrap: true
    });
    section.fonts.forEach((f, i) => {
      const state = f.format === 'woff2'
        ? (color ? pc.green('✓ WOFF2') : '✓ WOFF2')
        : f.format === 'unknown'
          ? (color ? pc.dim('? unknown') : '? unknown')
          : (color ? pc.yellow('✗ legacy') : '✗ legacy');
      t.push([
        String(i + 1),
        f.source,
        f.family || '—',
        f.url,
        f.format,
        state
      ]);
    });
    lines.push(t.toString());
  }

  if (section.fetchIssues && section.fetchIssues.length > 0) {
    lines.push(color ? pc.dim(`Stylesheets that failed to fetch (${section.fetchIssues.length}):`) : `Stylesheets that failed to fetch (${section.fetchIssues.length}):`);
    for (const f of section.fetchIssues.slice(0, 5)) {
      const reason = f.error ? `${f.error.code}${f.error.message ? ': ' + f.error.message : ''}` : 'error';
      const msg = `  ${f.status ?? '—'}  ${f.href}  — ${reason}`;
      lines.push(color ? pc.dim(msg) : msg);
    }
    if (section.fetchIssues.length > 5) {
      const more = `  (+${section.fetchIssues.length - 5} more)`;
      lines.push(color ? pc.dim(more) : more);
    }
  }

  if (section.skippedStylesheets && section.skippedStylesheets.length > 0) {
    const note = `Skipped past cap (${section.skippedStylesheets.length} stylesheets not fetched)`;
    lines.push(color ? pc.dim(note) : note);
  }

  return lines.join('\n');
}

function renderWebfontSize(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  const pct = section.budget > 0 ? (section.totalBytes / section.budget) * 100 : 0;
  const budgetLine =
    `Total: ${formatKB(section.totalBytes)} / ${formatKB(section.budget)} budget (${pct.toFixed(0)}%) · ` +
    `Fetched ${formatInt(section.counts.fetched)}/${formatInt(section.counts.discovered)} · ` +
    `Failed ${formatInt(section.counts.failed)} · Skipped past cap: fonts ${formatInt(section.counts.skippedFonts)}, stylesheets ${formatInt(section.counts.skippedStylesheets)}`;
  lines.push(budgetLine);

  const over = section.totalBytes - section.budget;
  if (over > 0) {
    const msg = `Over budget by ${formatKB(over)}`;
    lines.push(color ? pc.red(pc.bold(msg)) : msg);
  }

  if (section.fonts && section.fonts.length > 0) {
    const t = new Table({
      head: ['#', 'Family', 'URL', 'Sources', 'Size', 'Status', 'State'],
      style: { head: color ? ['cyan'] : [], border: [] },
      colWidths: [4, 20, 56, 22, 10, 8, 22],
      wordWrap: true
    });
    section.fonts.forEach((f, i) => {
      const sizeStr = f.ok ? formatKB(f.sizeBytes) : '—';
      const statusStr = f.status == null ? '—' : String(f.status);
      let state;
      if (!f.ok) {
        const reason = f.error ? `${f.error.code}` : 'error';
        state = color ? pc.red(reason) : reason;
      } else {
        state = color ? pc.green('✓ fetched') : '✓ fetched';
      }
      t.push([
        String(i + 1),
        f.family || '—',
        f.resolvedUrl,
        f.sources.join(', '),
        sizeStr,
        statusStr,
        state
      ]);
    });
    lines.push(t.toString());
  }

  if (section.stylesheetFailures && section.stylesheetFailures.length > 0) {
    const header = `Stylesheets that failed to fetch (${section.stylesheetFailures.length}):`;
    lines.push(color ? pc.dim(header) : header);
    for (const sf of section.stylesheetFailures.slice(0, 5)) {
      const reason = sf.error ? `${sf.error.code}${sf.error.message ? ': ' + sf.error.message : ''}` : 'error';
      const msg = `  ${sf.status ?? '—'}  ${sf.href}  — ${reason}`;
      lines.push(color ? pc.dim(msg) : msg);
    }
    if (section.stylesheetFailures.length > 5) {
      const more = `  (+${section.stylesheetFailures.length - 5} more)`;
      lines.push(color ? pc.dim(more) : more);
    }
  }

  if (section.skippedFonts && section.skippedFonts.length > 0) {
    const note = `Skipped past cap (${section.skippedFonts.length} font${section.skippedFonts.length === 1 ? '' : 's'} not measured)`;
    lines.push(color ? pc.dim(note) : note);
  }
  if (section.skippedStylesheets && section.skippedStylesheets.length > 0) {
    const note = `Skipped past cap (${section.skippedStylesheets.length} stylesheet${section.skippedStylesheets.length === 1 ? '' : 's'} not scanned for @font-face)`;
    lines.push(color ? pc.dim(note) : note);
  }

  return lines.join('\n');
}

function renderImageOptimization(section, color) {
  const lines = [];
  lines.push(color ? pc.bold(section.title) : section.title);
  const t = section.totals;
  const LEGACY_SET = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'ico']);

  // 1. Totals table only — no per-URL rows here.
  const totalsTable = new Table({
    head: ['Discovered', 'Fetched', 'Failed', 'Skipped', 'Total', 'Modern', 'Legacy', 'Legacy weight', 'Heavy >200 KB', 'Very heavy >500 KB'],
    style: { head: color ? ['cyan'] : [], border: [] }
  });
  totalsTable.push([
    formatInt(t.discovered),
    formatInt(t.fetched),
    formatInt(t.failed),
    formatInt(t.skipped),
    formatKB(t.totalWeight),
    formatInt(t.modern),
    formatInt(t.legacy),
    formatKB(t.legacyWeight),
    color && t.heavy > 0 ? pc.yellow(formatInt(t.heavy)) : formatInt(t.heavy),
    color && t.veryHeavy > 0 ? pc.red(formatInt(t.veryHeavy)) : formatInt(t.veryHeavy)
  ]);
  lines.push(totalsTable.toString());

  // 2. Second table: URLs that actually need optimizing (heavy or legacy).
  const priority = section.images
    .filter((r) => r.ok && (r.sizeBytes > 200 * 1024 || LEGACY_SET.has(r.format)))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  if (priority.length > 0) {
    const heading = `Images to optimize (${priority.length})`;
    lines.push(color ? pc.bold(heading) : heading);
    const tbl = new Table({
      head: ['#', 'Size', 'Format', 'Why', 'URL'],
      style: { head: color ? ['cyan'] : [], border: [] },
      colWidths: [4, 10, 8, 20, 74],
      wordWrap: true
    });
    priority.forEach((r, i) => {
      const tags = [];
      if (r.sizeBytes > 500 * 1024) tags.push('very heavy');
      else if (r.sizeBytes > 200 * 1024) tags.push('heavy');
      if (LEGACY_SET.has(r.format)) tags.push('legacy');
      const why = tags.join(' + ');
      const whyCell = color
        ? (r.sizeBytes > 500 * 1024 ? pc.red(why) : pc.yellow(why))
        : why;
      tbl.push([
        String(i + 1),
        formatKB(r.sizeBytes),
        r.format,
        whyCell,
        r.resolvedUrl
      ]);
    });
    lines.push(tbl.toString());
  }

  if (section.fetchIssues && section.fetchIssues.length > 0) {
    const header = `Failed to fetch (${section.fetchIssues.length}):`;
    lines.push(color ? pc.dim(header) : header);
    for (const f of section.fetchIssues.slice(0, 5)) {
      const reason = f.error ? `${f.error.code}${f.error.message ? ': ' + f.error.message : ''}` : 'error';
      const msg = `  ${f.status ?? '—'}  ${f.url}  — ${reason}`;
      lines.push(color ? pc.dim(msg) : msg);
    }
    if (section.fetchIssues.length > 5) {
      const more = `  (+${section.fetchIssues.length - 5} more)`;
      lines.push(color ? pc.dim(more) : more);
    }
  }

  if (section.skippedUrls && section.skippedUrls.length > 0) {
    const note = `Skipped past cap (${section.skippedUrls.length} image${section.skippedUrls.length === 1 ? '' : 's'} not fetched)`;
    lines.push(color ? pc.dim(note) : note);
  }

  return lines.join('\n');
}
