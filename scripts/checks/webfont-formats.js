// Check: webfont formats.
//
// Modern web fonts should be delivered as WOFF2 — 30% smaller than WOFF
// and supported by every current browser. This check enumerates every
// font URL referenced from the page and flags anything that isn't WOFF2.
//
// Sources scanned:
//   1. <link rel="preload" as="font"> in the HTML (href + type attribute).
//   2. @font-face rules inside inline <style> blocks (any src url).
//   3. @font-face rules inside external stylesheets — up to MAX_FETCHES
//      files are re-fetched with the shared helper. Errors surface in the
//      details but do not fail the check.
//
// Statuses:
//   pass — no fonts on the page, OR every discovered font URL is WOFF2
//   warn — mixed: WOFF2 is present but some legacy formats too
//   fail — no WOFF2 anywhere, and at least one legacy format found

import { parse as parseHtml } from 'node-html-parser';
import * as csstree from 'css-tree';
import { fetchResource } from '../lib/fetch.js';

const MAX_FETCHES = 20;
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 8000;

const FORMAT_BY_EXT = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'ttf',
  otf: 'otf',
  eot: 'eot',
  svg: 'svg'
};

const FORMAT_BY_MIME = {
  'font/woff2': 'woff2',
  'application/font-woff2': 'woff2',
  'font/woff': 'woff',
  'application/font-woff': 'woff',
  'application/x-font-woff': 'woff',
  'font/ttf': 'ttf',
  'application/x-font-ttf': 'ttf',
  'application/x-font-truetype': 'ttf',
  'font/otf': 'otf',
  'application/x-font-opentype': 'otf',
  'application/vnd.ms-fontobject': 'eot'
};

const FORMAT_HINT_NORMALIZE = {
  woff2: 'woff2',
  woff: 'woff',
  truetype: 'ttf',
  ttf: 'ttf',
  opentype: 'otf',
  otf: 'otf',
  eot: 'eot',
  'embedded-opentype': 'eot',
  svg: 'svg'
};

function classifyUrl(url, { formatHint = null, mime = null } = {}) {
  if (formatHint) {
    const key = formatHint.toLowerCase();
    if (FORMAT_HINT_NORMALIZE[key]) return FORMAT_HINT_NORMALIZE[key];
  }
  if (mime) {
    const key = mime.toLowerCase().split(';')[0].trim();
    if (FORMAT_BY_MIME[key]) return FORMAT_BY_MIME[key];
  }
  if (url) {
    // Strip query + fragment before looking at extension.
    const noQuery = url.split(/[?#]/)[0];
    const dot = noQuery.lastIndexOf('.');
    if (dot >= 0) {
      const ext = noQuery.slice(dot + 1).toLowerCase();
      if (FORMAT_BY_EXT[ext]) return FORMAT_BY_EXT[ext];
    }
  }
  return 'unknown';
}

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

function collectPreloadLinks(root) {
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
          links.push({
            href: attrs.href,
            type: (attrs.type || '') || null
          });
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
        if (rel.includes('stylesheet') && attrs.href) {
          items.push({ href: attrs.href });
        }
      }
      walk(el);
    }
  };
  walk(root);
  return items;
}

// Extract every (family, url, formatHint) triple from every @font-face
// rule in `css`. Silent on parse errors — a broken CSS file just yields no
// fonts.
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
            // src can be a list of url() [format('woff2')] entries separated
            // by commas. Walk children in order, remembering the last url().
            const kids = decl.value.children ? decl.value.children.toArray() : [];
            let pendingUrl = null;
            for (const child of kids) {
              if (!child) continue;
              if (child.type === 'Url') {
                if (pendingUrl) sources.push({ url: pendingUrl, formatHint: null });
                pendingUrl = child.value || null;
              } else if (child.type === 'Function' && (child.name || '').toLowerCase() === 'format') {
                const args = child.children ? child.children.toArray() : [];
                let hint = null;
                for (const a of args) {
                  if (a && (a.type === 'String' || a.type === 'Identifier')) {
                    hint = (a.value || a.name || '').replace(/^['"]|['"]$/g, '');
                    break;
                  }
                }
                if (pendingUrl) {
                  sources.push({ url: pendingUrl, formatHint: hint });
                  pendingUrl = null;
                }
              } else if (child.type === 'Operator' && child.value === ',') {
                if (pendingUrl) {
                  sources.push({ url: pendingUrl, formatHint: null });
                  pendingUrl = null;
                }
              }
            }
            if (pendingUrl) sources.push({ url: pendingUrl, formatHint: null });
          }
        }
      });

      for (const s of sources) {
        results.push({ family, url: s.url, formatHint: s.formatHint });
      }
    }
  });
  return results;
}

function resolveHref(href, baseUrl) {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
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
  id: 'webfont-formats',
  name: 'Webfont formats',
  priority: 'medium',
  async run(context) {
    const html = context.raw.html;
    const baseUrl = context.finalUrl || null;
    const root = parseHtml(html, {
      lowerCaseTagName: false,
      comment: true,
      blockTextElements: { script: true, style: true, svg: true, noscript: true }
    });

    // 1. Preload links.
    const preloads = collectPreloadLinks(root).map((p) => ({
      source: 'preload-link',
      family: null,
      url: p.href,
      resolvedUrl: resolveHref(p.href, baseUrl),
      formatHint: null,
      mime: p.type || null,
      format: classifyUrl(p.href, { mime: p.type || null })
    }));

    // 2. Inline @font-face rules.
    const inline = [];
    walkStyles(root, (cssText) => {
      for (const f of extractFontFaceSources(cssText)) {
        inline.push({
          source: 'inline-@font-face',
          family: f.family,
          url: f.url,
          resolvedUrl: resolveHref(f.url, baseUrl),
          formatHint: f.formatHint,
          mime: null,
          format: classifyUrl(f.url, { formatHint: f.formatHint })
        });
      }
    });

    // 3. External stylesheets — fetched and scanned for @font-face too.
    const externalRefs = collectExternalStylesheets(root);
    const toFetch = externalRefs.slice(0, MAX_FETCHES);
    const skippedStylesheets = externalRefs.slice(MAX_FETCHES);

    const fetched = await fetchAllWithConcurrency(toFetch, CONCURRENCY, async (entry) => {
      const url = resolveHref(entry.href, baseUrl);
      const res = await fetchResource(url, { timeoutMs: FETCH_TIMEOUT_MS });
      return { href: entry.href, url, res };
    });

    const external = [];
    const fetchIssues = [];
    for (const f of fetched) {
      if (!f.res.ok) {
        fetchIssues.push({
          href: f.href,
          url: f.url,
          status: f.res.status,
          error: f.res.error
        });
        continue;
      }
      const fonts = extractFontFaceSources(f.res.body);
      for (const font of fonts) {
        // Font URL is resolved against the STYLESHEET's URL, not the page.
        const resolvedFontUrl = resolveHref(font.url, f.url);
        external.push({
          source: 'external-@font-face',
          stylesheet: f.href,
          family: font.family,
          url: font.url,
          resolvedUrl: resolvedFontUrl,
          formatHint: font.formatHint,
          mime: null,
          format: classifyUrl(font.url, { formatHint: font.formatHint })
        });
      }
    }

    const all = [...preloads, ...inline, ...external];
    const counts = {
      total: all.length,
      preloads: preloads.length,
      inline: inline.length,
      external: external.length,
      woff2: all.filter((f) => f.format === 'woff2').length,
      woff: all.filter((f) => f.format === 'woff').length,
      ttf: all.filter((f) => f.format === 'ttf').length,
      otf: all.filter((f) => f.format === 'otf').length,
      eot: all.filter((f) => f.format === 'eot').length,
      svg: all.filter((f) => f.format === 'svg').length,
      unknown: all.filter((f) => f.format === 'unknown').length,
      externalStylesheetsScanned: fetched.length,
      externalStylesheetsFailed: fetchIssues.length,
      externalStylesheetsSkipped: skippedStylesheets.length
    };

    const nonWoff2 = counts.woff + counts.ttf + counts.otf + counts.eot + counts.svg;

    let status;
    let summary;
    if (counts.total === 0) {
      status = 'pass';
      summary = 'no webfonts on the page';
    } else if (nonWoff2 === 0 && counts.unknown === 0) {
      status = 'pass';
      summary = `all ${counts.total} font source${counts.total === 1 ? '' : 's'} use WOFF2`;
    } else if (counts.woff2 > 0 && nonWoff2 > 0) {
      status = 'warn';
      summary = `${counts.woff2} WOFF2 + ${nonWoff2} legacy font source${nonWoff2 === 1 ? '' : 's'} — drop legacy`;
    } else if (counts.woff2 === 0 && nonWoff2 > 0) {
      status = 'fail';
      summary = `no WOFF2 sources — ${nonWoff2} legacy font source${nonWoff2 === 1 ? '' : 's'} detected`;
    } else {
      // Only unknown-format sources present.
      status = 'warn';
      summary = `${counts.unknown} font source${counts.unknown === 1 ? '' : 's'} of unknown format`;
    }

    const details = [
      {
        type: 'webfont-formats',
        title: 'Webfont formats',
        counts,
        fonts: all,
        fetchIssues,
        skippedStylesheets: skippedStylesheets.map((s) => s.href)
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        ...counts,
        fonts: all,
        fetchIssues,
        skippedStylesheets
      }
    };
  }
};

