// Check: total webfont weight.
//
// Discovers every font URL referenced from the page (inline @font-face,
// external @font-face inside <link rel="stylesheet"> files, and
// <link rel="preload" as="font">), fetches each once (dedup by resolved
// URL), and sums the decompressed bytes. Compared against a 300 KB budget.
//
// Statuses:
//   pass — 0 fonts or confirmed total <= 300 KB
//   warn — some fetches failed, confirmed total <= 300 KB but real total
//          may exceed it
//   fail — confirmed total > 300 KB

import { parse as parseHtml } from 'node-html-parser';
import * as csstree from 'css-tree';
import { fetchResource } from '../lib/fetch.js';

const BUDGET_BYTES = 300 * 1024;
const MAX_FETCHES_STYLESHEETS = 20;
const MAX_FETCHES_FONTS = 20;
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 8000;

function walkStyles(root, cb) {
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      if (tag === 'style') {
        cb(el.rawText || el.text || '', el);
      } else {
        walk(el);
      }
    }
  };
  walk(root);
}

function collectPreloadFontLinks(root) {
  const links = [];
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      if (tag === 'link') {
        const attrs = el.attributes || {};
        const rel = (attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
        const asAttr = (attrs.as || '').toLowerCase();
        if (rel.includes('preload') && asAttr === 'font' && attrs.href) {
          links.push({ href: attrs.href });
        }
      }
      walk(el);
    }
  };
  walk(root);
  return links;
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
        if (rel.includes('stylesheet') && attrs.href) items.push({ href: attrs.href });
      }
      walk(el);
    }
  };
  walk(root);
  return items;
}

function extractFontFaceSources(css) {
  const results = [];
  let ast;
  try {
    ast = csstree.parse(css, { positions: false });
  } catch {
    return results;
  }
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      if ((node.name || '').toLowerCase() !== 'font-face') return;
      if (!node.block) return;
      let family = null;
      const sources = [];
      csstree.walk(node.block, {
        visit: 'Declaration',
        enter(decl) {
          const prop = (decl.property || '').toLowerCase();
          if (prop === 'font-family' && decl.value) {
            const s = csstree.generate(decl.value).trim();
            family = s.replace(/^['"]|['"]$/g, '');
          } else if (prop === 'src' && decl.value) {
            const kids = decl.value.children ? decl.value.children.toArray() : [];
            let pending = null;
            for (const child of kids) {
              if (!child) continue;
              if (child.type === 'Url') {
                if (pending) sources.push(pending);
                pending = child.value || null;
              } else if (child.type === 'Function' && (child.name || '').toLowerCase() === 'format') {
                if (pending) { sources.push(pending); pending = null; }
              } else if (child.type === 'Operator' && child.value === ',') {
                if (pending) { sources.push(pending); pending = null; }
              }
            }
            if (pending) sources.push(pending);
          }
        }
      });
      for (const url of sources) results.push({ family, url });
    }
  });
  return results;
}

function resolveHref(href, baseUrl) {
  if (!baseUrl) return href;
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

async function runWithConcurrency(items, concurrency, worker) {
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

function formatKB(bytes) { return `${(bytes / 1024).toFixed(1)} KB`; }

export default {
  id: 'webfont-size',
  name: 'Webfont size (300 KB budget)',
  priority: 'medium',
  async run(context) {
    const html = context.raw.html;
    const baseUrl = context.finalUrl || null;
    const root = parseHtml(html, {
      lowerCaseTagName: false,
      comment: true,
      blockTextElements: { script: true, style: true, svg: true, noscript: true }
    });

    // Discovery.
    const discovered = new Map(); // resolvedUrl -> { url, resolvedUrl, family, sources: Set<string> }
    const record = (url, family, source, base) => {
      if (!url) return;
      const resolved = resolveHref(url, base);
      const existing = discovered.get(resolved);
      if (existing) {
        existing.sources.add(source);
        if (!existing.family && family) existing.family = family;
      } else {
        discovered.set(resolved, { url, resolvedUrl: resolved, family, sources: new Set([source]) });
      }
    };

    // 1. Preload links.
    for (const l of collectPreloadFontLinks(root)) record(l.href, null, 'preload-link', baseUrl);

    // 2. Inline @font-face.
    walkStyles(root, (cssText) => {
      for (const f of extractFontFaceSources(cssText)) record(f.url, f.family, 'inline-@font-face', baseUrl);
    });

    // 3. External stylesheets.
    const externalRefs = collectExternalStylesheets(root);
    const stylesheetsToFetch = externalRefs.slice(0, MAX_FETCHES_STYLESHEETS);
    const skippedStylesheets = externalRefs.slice(MAX_FETCHES_STYLESHEETS);
    const cssFetches = await runWithConcurrency(stylesheetsToFetch, CONCURRENCY, async (entry) => {
      const url = resolveHref(entry.href, baseUrl);
      const res = await fetchResource(url, { timeoutMs: FETCH_TIMEOUT_MS });
      return { href: entry.href, url, res };
    });
    const stylesheetFailures = [];
    for (const cf of cssFetches) {
      if (!cf.res.ok) {
        stylesheetFailures.push({ href: cf.href, url: cf.url, status: cf.res.status, error: cf.res.error });
        continue;
      }
      for (const f of extractFontFaceSources(cf.res.body)) {
        record(f.url, f.family, 'external-@font-face', cf.url);
      }
    }

    // Fetch fonts (cap + concurrency).
    const allFonts = Array.from(discovered.values());
    const toFetchFonts = allFonts.slice(0, MAX_FETCHES_FONTS);
    const skippedFonts = allFonts.slice(MAX_FETCHES_FONTS);

    const fontResults = await runWithConcurrency(toFetchFonts, CONCURRENCY, async (font) => {
      const res = await fetchResource(font.resolvedUrl, { timeoutMs: FETCH_TIMEOUT_MS, binary: true });
      return {
        url: font.url,
        resolvedUrl: font.resolvedUrl,
        family: font.family,
        sources: [...font.sources],
        ok: res.ok,
        sizeBytes: res.sizeBytes ?? 0,
        transferredBytes: res.transferredBytes ?? 0,
        status: res.status,
        error: res.error
      };
    });

    const ok = fontResults.filter((f) => f.ok);
    const failed = fontResults.filter((f) => !f.ok);

    const totalBytes = ok.reduce((a, f) => a + f.sizeBytes, 0);
    const overBudget = totalBytes > BUDGET_BYTES;
    const undercount = failed.length > 0 || skippedFonts.length > 0 || skippedStylesheets.length > 0;

    let status;
    let summary;
    if (allFonts.length === 0) {
      status = 'pass';
      summary = 'no webfonts on the page';
    } else if (overBudget) {
      status = 'fail';
      summary = `${formatKB(totalBytes)} total across ${ok.length} font${ok.length === 1 ? '' : 's'} — over 300 KB budget by ${formatKB(totalBytes - BUDGET_BYTES)}`;
    } else if (undercount) {
      status = 'warn';
      const bits = [];
      if (failed.length) bits.push(`${failed.length} fetch failure${failed.length === 1 ? '' : 's'}`);
      if (skippedFonts.length) bits.push(`${skippedFonts.length} fonts skipped past cap`);
      if (skippedStylesheets.length) bits.push(`${skippedStylesheets.length} stylesheets skipped past cap`);
      summary = `${formatKB(totalBytes)} confirmed across ${ok.length} font${ok.length === 1 ? '' : 's'}, under 300 KB — but ${bits.join(', ')}, real total may exceed budget`;
    } else {
      status = 'pass';
      summary = `${formatKB(totalBytes)} total across ${ok.length} font${ok.length === 1 ? '' : 's'} — within 300 KB budget`;
    }

    const details = [
      {
        type: 'webfont-size',
        title: 'Webfont size',
        budget: BUDGET_BYTES,
        totalBytes,
        counts: {
          discovered: allFonts.length,
          fetched: ok.length,
          failed: failed.length,
          skippedFonts: skippedFonts.length,
          skippedStylesheets: skippedStylesheets.length
        },
        fonts: fontResults.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0)),
        stylesheetFailures,
        skippedFonts: skippedFonts.map((f) => f.resolvedUrl),
        skippedStylesheets: skippedStylesheets.map((s) => s.href)
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        totalBytes,
        budget: BUDGET_BYTES,
        overBudgetBy: overBudget ? totalBytes - BUDGET_BYTES : 0,
        discovered: allFonts.length,
        fetched: ok.length,
        failed: failed.length,
        skippedFonts: skippedFonts.length,
        skippedStylesheets: skippedStylesheets.length,
        fonts: fontResults
      }
    };
  }
};
