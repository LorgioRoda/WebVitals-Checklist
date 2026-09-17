// Check: CSS minification.
//
// Inline <style> blocks are extracted and compared against a heuristic
// minified version (comments stripped, whitespace collapsed, spaces around
// punctuation removed). External <link rel="stylesheet"> files are fetched
// (up to MAX_EXTERNAL_FETCHES) and analyzed the same way. Errors — CORS,
// timeout, 404, DNS, etc. — are surfaced in the details but do NOT fail the
// check.
//
// Statuses (based on inline + successfully fetched external savings):
//   pass — no CSS analyzed, or every analyzed block is already minified
//   warn — under 500 bytes of savings across all analyzed CSS
//   fail — 500 bytes or more of savings

import { parse as parseHtml } from 'node-html-parser';
import { fetchResource } from '../lib/fetch.js';

const MAX_EXTERNAL_FETCHES = 20;
const EXTERNAL_CONCURRENCY = 5;
const EXTERNAL_TIMEOUT_MS = 8000;

// Small heuristic CSS minifier. Not exact (does not preserve strings around
// punctuation, keyframe percentages, etc.), but accurate enough to measure
// order-of-magnitude savings from real minification.
export function minifyCssHeuristic(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>+~])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function collectStyles(root) {
  const items = [];
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      if (tag === 'style') {
        items.push({
          start: el.range ? el.range[0] : null,
          css: el.rawText || el.text || ''
        });
        continue;
      }
      walk(el);
    }
  };
  walk(root);
  return items;
}

function collectExternalStylesheets(root) {
  const items = [];
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      if (tag === 'link') {
        const attrs = el.attributes || {};
        const rel = (attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (rel.includes('stylesheet') && attrs.href) {
          items.push({ href: attrs.href, start: el.range ? el.range[0] : null });
        }
      }
      walk(el);
    }
  };
  walk(root);
  return items;
}

function makeLineIndex(html) {
  const offsets = [0];
  for (let i = 0; i < html.length; i++) if (html.charCodeAt(i) === 10) offsets.push(i + 1);
  return offsets;
}

function lineFor(offsets, pos) {
  if (pos == null) return null;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function resolveHref(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

async function fetchAllWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export default {
  id: 'css-minification',
  name: 'CSS minification',
  priority: 'high',
  async run(context) {
    const html = context.raw.html;
    const root = parseHtml(html, {
      lowerCaseTagName: false,
      comment: true,
      blockTextElements: { script: true, style: true, svg: true, noscript: true }
    });
    const lineOffsets = makeLineIndex(html);

    const rawStyles = collectStyles(root);
    const rawExternals = collectExternalStylesheets(root);

    // Inline analysis.
    const styles = rawStyles.map((s, i) => {
      const rawBytes = Buffer.byteLength(s.css, 'utf8');
      const min = minifyCssHeuristic(s.css);
      const minBytes = Buffer.byteLength(min, 'utf8');
      const savings = Math.max(0, rawBytes - minBytes);
      const ratio = rawBytes === 0 ? 1 : minBytes / rawBytes;
      return {
        index: i + 1,
        line: lineFor(lineOffsets, s.start),
        rawBytes,
        minBytes,
        savings,
        minified: ratio >= 0.95
      };
    });

    // External resolution + cap enforcement.
    const externalEntries = rawExternals.map((e, i) => ({
      index: i + 1,
      line: lineFor(lineOffsets, e.start),
      href: e.href,
      resolvedUrl: context.finalUrl ? resolveHref(e.href, context.finalUrl) : null
    }));
    const toFetch = externalEntries.slice(0, MAX_EXTERNAL_FETCHES);
    const skipped = externalEntries.slice(MAX_EXTERNAL_FETCHES);

    // Fetch in parallel with a small concurrency cap.
    const fetchResults = await fetchAllWithConcurrency(toFetch, EXTERNAL_CONCURRENCY, async (entry) => {
      if (!entry.resolvedUrl) {
        return {
          ...entry,
          ok: false,
          status: null,
          rawBytes: 0,
          minBytes: 0,
          savings: 0,
          minified: null,
          error: { code: 'INVALID_URL', message: `Could not resolve href against base URL` }
        };
      }
      const res = await fetchResource(entry.resolvedUrl, { timeoutMs: EXTERNAL_TIMEOUT_MS });
      if (!res.ok) {
        return {
          ...entry,
          ok: false,
          status: res.status,
          rawBytes: res.transferredBytes || 0,
          minBytes: 0,
          savings: 0,
          minified: null,
          error: res.error
        };
      }
      const rawBytes = Buffer.byteLength(res.body, 'utf8');
      const min = minifyCssHeuristic(res.body);
      const minBytes = Buffer.byteLength(min, 'utf8');
      const savings = Math.max(0, rawBytes - minBytes);
      const ratio = rawBytes === 0 ? 1 : minBytes / rawBytes;
      return {
        ...entry,
        ok: true,
        status: res.status,
        rawBytes,
        minBytes,
        savings,
        minified: ratio >= 0.95,
        error: null
      };
    });

    const externalOk = fetchResults.filter((r) => r.ok);

    // Totals across every analyzed stylesheet (informational).
    const inlineRaw = styles.reduce((a, s) => a + s.rawBytes, 0);
    const inlineMin = styles.reduce((a, s) => a + s.minBytes, 0);
    const externalRaw = externalOk.reduce((a, r) => a + r.rawBytes, 0);
    const externalMin = externalOk.reduce((a, r) => a + r.minBytes, 0);
    const totalRaw = inlineRaw + externalRaw;
    const totalMin = inlineMin + externalMin;
    const residualSavings = Math.max(0, totalRaw - totalMin);
    const analyzedCount = styles.length + externalOk.length;

    // Effective savings only counts files the per-file check marked as not
    // minified. This keeps the summary consistent with the per-row State
    // column: if every row says ✓ minified, savings should read as 0 and
    // the check should pass — even if there's residual whitespace across
    // many already-minified files.
    const notMinInline = styles.filter((s) => !s.minified);
    const notMinExternal = externalOk.filter((r) => !r.minified);
    const nonMinifiedCount = notMinInline.length + notMinExternal.length;
    const effectiveSavings =
      notMinInline.reduce((a, s) => a + s.savings, 0) +
      notMinExternal.reduce((a, r) => a + r.savings, 0);

    let status;
    let summary;
    if (analyzedCount === 0) {
      status = 'pass';
      summary = 'no CSS on the page';
    } else if (nonMinifiedCount === 0) {
      status = 'pass';
      summary = `all ${analyzedCount} stylesheet${analyzedCount === 1 ? '' : 's'} minified`;
    } else if (effectiveSavings < 500) {
      status = 'warn';
      summary = `${nonMinifiedCount}/${analyzedCount} stylesheet${analyzedCount === 1 ? '' : 's'} not minified · save ~${formatKB(effectiveSavings)}`;
    } else {
      status = 'fail';
      summary = `${nonMinifiedCount}/${analyzedCount} stylesheet${analyzedCount === 1 ? '' : 's'} not minified · save ~${formatKB(effectiveSavings)}`;
    }

    const details = [
      {
        type: 'css-minification',
        title: 'CSS minification',
        totals: {
          inlineCount: styles.length,
          externalCount: rawExternals.length,
          externalFetched: externalOk.length,
          externalFailed: fetchResults.length - externalOk.length,
          externalSkipped: skipped.length,
          rawBytes: totalRaw,
          minBytes: totalMin,
          savings: effectiveSavings,
          residualSavings
        },
        styles,
        externals: fetchResults,
        skipped: skipped.map((s) => ({ line: s.line, href: s.href }))
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        inlineCount: styles.length,
        externalCount: rawExternals.length,
        externalFetched: externalOk.length,
        externalFailed: fetchResults.length - externalOk.length,
        externalSkipped: skipped.length,
        totalRawBytes: totalRaw,
        totalMinBytes: totalMin,
        totalSavings: effectiveSavings,
        residualSavings,
        nonMinifiedCount,
        styles,
        externals: fetchResults
      }
    };
  }
};

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
