// Check: image weight and format, taking CDN content negotiation into account.
//
// Discovery groups URLs into responsive-image "groups" — a <picture> and
// all its <source>/<img> descendants, an <img> with a srcset, a <link
// rel="preload" as="image"> with imagesrcset, etc. For each group we
// pick exactly one URL to fetch: the largest by descriptor (Nw / Nx),
// falling back to the sole candidate when there is only one. That way
// the tool reports one download per responsive image — mirroring what a
// browser does — instead of summing all srcset variants.
//
// Each unique URL is fetched ONCE with a realistic browser Accept header
// (image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8) and
// browser-like image request headers (no Cache-Control override,
// Sec-Fetch-Dest: image, Referer) so the CDN's content negotiation kicks
// in. The format is classified from the RESPONSE Content-Type — not the
// URL extension — because CDNs commonly serve WebP/AVIF from a legacy
// .jpg/.png URL.
//
// Statuses:
//   pass — no images, or all served as modern formats (webp/avif/svg) AND
//          nothing above the very-heavy budget
//   warn — some legacy formats served, or heavy images (>200 KB) present,
//          or some fetches failed
//   fail — any very-heavy image (>500 KB) served, or legacy formats
//          account for a large share of total weight

import { parse as parseHtml } from 'node-html-parser';
import * as csstree from 'css-tree';
import { fetchResource } from '../lib/fetch.js';

const MAX_FETCHES = 40;
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 8000;

const HEAVY_BYTES = 200 * 1024;
const VERY_HEAVY_BYTES = 500 * 1024;
const IMAGE_ACCEPT =
  'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

const MODERN_FORMATS = new Set(['webp', 'avif', 'svg']);
const LEGACY_FORMATS = new Set(['jpeg', 'png', 'gif', 'bmp', 'ico']);

const FORMAT_BY_MIME = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
  'image/apng': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
};

const FORMAT_BY_EXT = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
  avif: 'avif',
  svg: 'svg',
  bmp: 'bmp',
  ico: 'ico'
};

function classifyMime(mime) {
  if (!mime) return 'unknown';
  const key = mime.toLowerCase().split(';')[0].trim();
  return FORMAT_BY_MIME[key] || 'unknown';
}

function classifyExtension(url) {
  if (!url) return 'unknown';
  const noQuery = url.split(/[?#]/)[0];
  const dot = noQuery.lastIndexOf('.');
  if (dot < 0) return 'unknown';
  const ext = noQuery.slice(dot + 1).toLowerCase();
  return FORMAT_BY_EXT[ext] || 'unknown';
}

function isDataUri(url) {
  return typeof url === 'string' && /^data:/i.test(url);
}

// Parse a srcset value into [{ url, w, x }]. `w` and `x` may be null when
// the entry has no descriptor (implicit 1x). Malformed entries are dropped.
function parseSrcset(srcset) {
  if (!srcset) return [];
  const out = [];
  for (const part of srcset.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Split into URL + optional descriptors (whitespace-separated).
    const tokens = trimmed.split(/\s+/);
    const url = tokens[0];
    if (!url) continue;
    let w = null;
    let x = null;
    for (const t of tokens.slice(1)) {
      const m = /^(\d+(?:\.\d+)?)(w|x)$/i.exec(t);
      if (!m) continue;
      if (m[2].toLowerCase() === 'w') w = Number(m[1]);
      else x = Number(m[1]);
    }
    out.push({ url, w, x });
  }
  return out;
}

// Given a list of {url, w, x} candidates, return the largest. Prefers
// `w` descriptors when any candidate has one (browsers do the same when
// `sizes` is present); otherwise picks max `x` (default 1 when missing).
function pickLargest(candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const withW = candidates.filter((c) => c.w != null);
  if (withW.length > 0) {
    return withW.reduce((a, b) => (b.w > a.w ? b : a));
  }
  const scored = candidates.map((c) => ({ ...c, _x: c.x == null ? 1 : c.x }));
  return scored.reduce((a, b) => (b._x > a._x ? b : a));
}

function inPicture(el) {
  let p = el.parentNode;
  while (p) {
    const tag = p.rawTagName ? p.rawTagName.toLowerCase() : null;
    if (tag === 'picture') return true;
    p = p.parentNode;
  }
  return false;
}

function walkAll(root, cb) {
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      cb(el);
      walk(el);
    }
  };
  walk(root);
}

// Collect groups from the HTML. A "group" represents one responsive-image
// slot: at most one URL will ultimately be fetched from it (the largest
// candidate). Each group knows all candidates so we can report the full
// srcset in the details.
function collectGroups(root) {
  const groups = [];

  walkAll(root, (el) => {
    const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
    if (!tag) return;
    const attrs = el.attributes || {};

    if (tag === 'picture') {
      // Collect every candidate from all <source> and <img> descendants.
      const candidates = [];
      const inner = (node) => {
        for (const child of node.childNodes || []) {
          if (!child) continue;
          const t = child.rawTagName ? child.rawTagName.toLowerCase() : null;
          const a = child.attributes || {};
          if (t === 'source') {
            const type = (a.type || '').toLowerCase();
            if (!type || type.startsWith('image/')) {
              if (a.src) candidates.push({ url: a.src, w: null, x: null, from: 'source[src]' });
              for (const c of parseSrcset(a.srcset)) candidates.push({ ...c, from: 'source[srcset]' });
            }
          } else if (t === 'img') {
            if (a.src) candidates.push({ url: a.src, w: null, x: null, from: 'img[src]' });
            for (const c of parseSrcset(a.srcset)) candidates.push({ ...c, from: 'img[srcset]' });
          }
          inner(child);
        }
      };
      inner(el);
      if (candidates.length > 0) groups.push({ kind: 'picture', candidates });
    } else if (tag === 'img') {
      // Standalone <img> — the <picture> branch handles nested imgs.
      if (inPicture(el)) return;
      const candidates = [];
      if (attrs.src) candidates.push({ url: attrs.src, w: null, x: null, from: 'img[src]' });
      for (const c of parseSrcset(attrs.srcset)) candidates.push({ ...c, from: 'img[srcset]' });
      if (candidates.length > 0) groups.push({ kind: 'img', candidates });
    } else if (tag === 'source') {
      // Only if NOT inside a <picture> (picture handles its own sources).
      // A <source> inside <video>/<audio> with an image type is unusual —
      // handle it as its own group for completeness.
      if (inPicture(el)) return;
      const type = (attrs.type || '').toLowerCase();
      if (type && !type.startsWith('image/')) return;
      const candidates = [];
      if (attrs.src) candidates.push({ url: attrs.src, w: null, x: null, from: 'source[src]' });
      for (const c of parseSrcset(attrs.srcset)) candidates.push({ ...c, from: 'source[srcset]' });
      if (candidates.length > 0) groups.push({ kind: 'source', candidates });
    } else if (tag === 'link') {
      const rel = (attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
      const asAttr = (attrs.as || '').toLowerCase();
      if (rel.includes('preload') && asAttr === 'image') {
        const candidates = [];
        if (attrs.href) candidates.push({ url: attrs.href, w: null, x: null, from: 'preload[href]' });
        for (const c of parseSrcset(attrs.imagesrcset)) candidates.push({ ...c, from: 'preload[imagesrcset]' });
        if (candidates.length > 0) groups.push({ kind: 'preload', candidates });
      }
    }

    // Inline style="" attribute — each url() is its own single-candidate group.
    if (attrs.style) {
      for (const u of extractCssUrls(attrs.style, 'declarations')) {
        groups.push({
          kind: 'inline-style',
          candidates: [{ url: u, w: null, x: null, from: `${tag}[style]` }]
        });
      }
    }
  });

  return groups;
}

const IMAGE_CSS_PROPS = new Set([
  'background',
  'background-image',
  'mask',
  'mask-image',
  '-webkit-mask',
  '-webkit-mask-image',
  'border-image',
  'border-image-source',
  'list-style',
  'list-style-image',
  'content',
  'cursor'
]);

// Pull url(...) references from CSS declarations known to accept images.
// `mode` is 'stylesheet' for <style> block contents and 'declarations' for
// inline style="" attribute values. csstree's declarationList context does
// not fail on unknown input (it returns Raw nodes), so we distinguish here.
function extractCssUrls(css, mode) {
  const urls = [];
  let ast;
  try {
    if (mode === 'declarations') {
      ast = csstree.parse(css, { positions: false, context: 'declarationList' });
    } else {
      ast = csstree.parse(css, { positions: false });
    }
  } catch {
    return urls;
  }
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(decl) {
      const prop = (decl.property || '').toLowerCase();
      if (!IMAGE_CSS_PROPS.has(prop)) return;
      if (!decl.value) return;
      csstree.walk(decl.value, {
        visit: 'Url',
        enter(node) {
          const raw = node.value || '';
          if (raw && !isDataUri(raw)) urls.push(raw);
        }
      });
    }
  });
  return urls;
}

function walkStyles(root, cb) {
  walkAll(root, (el) => {
    const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
    if (tag === 'style') cb(el.rawText || el.text || '');
  });
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

function describeDescriptor(c) {
  if (c.w != null) return `${c.w}w`;
  if (c.x != null) return `${c.x}x`;
  return '—';
}

export default {
  id: 'image-optimization',
  name: 'Image optimization',
  priority: 'high',
  async run(context) {
    const html = context.raw.html;
    const baseUrl = context.finalUrl || null;
    const root = parseHtml(html, {
      lowerCaseTagName: false,
      comment: true,
      blockTextElements: { script: true, style: true, svg: true, noscript: true }
    });

    // 1. Discovery — group-based.
    const groups = collectGroups(root);

    // <style> blocks contribute one single-candidate group per url().
    walkStyles(root, (cssText) => {
      for (const u of extractCssUrls(cssText, 'stylesheet')) {
        groups.push({
          kind: 'style-block',
          candidates: [{ url: u, w: null, x: null, from: 'style-block' }]
        });
      }
    });

    // Resolve URLs and drop data:/non-http candidates.
    const resolvedGroups = [];
    for (const g of groups) {
      const candidates = [];
      for (const c of g.candidates) {
        if (!c.url || isDataUri(c.url)) continue;
        const resolved = resolveHref(c.url, baseUrl);
        if (!/^https?:/i.test(resolved)) continue;
        candidates.push({ ...c, resolvedUrl: resolved });
      }
      if (candidates.length > 0) resolvedGroups.push({ ...g, candidates });
    }

    // Pick the largest candidate per group.
    const picks = resolvedGroups.map((g) => {
      const picked = pickLargest(g.candidates);
      return {
        kind: g.kind,
        picked,
        candidates: g.candidates,
        siblings: g.candidates.filter((c) => c.resolvedUrl !== picked.resolvedUrl)
      };
    });

    // Dedup by picked resolvedUrl — the same URL can be picked from
    // multiple groups (e.g. a hero image referenced in <picture> AND as
    // a preload). We keep one entry but remember every group source.
    const byUrl = new Map();
    for (const p of picks) {
      const key = p.picked.resolvedUrl;
      const existing = byUrl.get(key);
      if (existing) {
        for (const c of p.candidates) existing.candidates.push(c);
        for (const s of p.siblings) existing.siblings.push(s);
        existing.groupKinds.add(p.kind);
      } else {
        byUrl.set(key, {
          picked: p.picked,
          candidates: [...p.candidates],
          siblings: [...p.siblings],
          groupKinds: new Set([p.kind])
        });
      }
    }
    const allPicks = Array.from(byUrl.values());
    const toFetch = allPicks.slice(0, MAX_FETCHES);
    const skipped = allPicks.slice(MAX_FETCHES);

    // 2. Fetch each picked URL with browser-like image request headers.
    //    `asImage: true` + Referer is essential — CDN image optimizers
    //    (Cloudflare Polish, Cloudinary f_auto, Fastly IO) only serve
    //    their format-negotiated variant on real image-style requests;
    //    a Cache-Control: no-cache or Sec-Fetch-Dest: document header
    //    causes many of them to bypass optimization and return the origin.
    const results = await runWithConcurrency(toFetch, CONCURRENCY, async (p) => {
      const url = p.picked.resolvedUrl;
      const res = await fetchResource(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        binary: true,
        asImage: true,
        accept: IMAGE_ACCEPT,
        referer: baseUrl
      });
      const servedFormat = res.ok ? classifyMime(res.contentType) : 'unknown';
      const urlFormat = classifyExtension(p.picked.url);
      return {
        url: p.picked.url,
        resolvedUrl: url,
        descriptor: describeDescriptor(p.picked),
        variantCount: p.candidates.length,
        siblings: p.siblings.map((c) => ({
          resolvedUrl: c.resolvedUrl,
          descriptor: describeDescriptor(c),
          from: c.from
        })),
        sources: [...new Set(p.candidates.map((c) => c.from))],
        groupKinds: [...p.groupKinds],
        urlFormat,
        ok: res.ok,
        status: res.status,
        contentType: res.contentType,
        contentEncoding: res.contentEncoding || null,
        transferredBytes: res.transferredBytes ?? 0,
        sizeBytes: res.sizeBytes ?? 0,
        // servedFormat is our source of truth — reflects what the CDN
        // actually delivered given content negotiation.
        format: servedFormat,
        // cdnTransformed: URL suggested one format but CDN returned another.
        // Almost always a win (jpg → webp/avif).
        cdnTransformed:
          res.ok &&
          urlFormat !== 'unknown' &&
          servedFormat !== 'unknown' &&
          urlFormat !== servedFormat,
        error: res.error
      };
    });

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const totalVariantsInGroups = allPicks.reduce((a, p) => a + p.candidates.length, 0);

    // 3. Aggregate — totals count ONE download per group (the largest).
    const totals = {
      discovered: allPicks.length,
      variantsInGroups: totalVariantsInGroups,
      fetched: ok.length,
      failed: failed.length,
      skipped: skipped.length,
      totalWeight: ok.reduce((a, r) => a + (r.sizeBytes || 0), 0),
      transferredWeight: ok.reduce((a, r) => a + (r.transferredBytes || 0), 0),
      modern: ok.filter((r) => MODERN_FORMATS.has(r.format)).length,
      legacy: ok.filter((r) => LEGACY_FORMATS.has(r.format)).length,
      unknown: ok.filter((r) => r.format === 'unknown').length,
      legacyWeight: ok
        .filter((r) => LEGACY_FORMATS.has(r.format))
        .reduce((a, r) => a + (r.sizeBytes || 0), 0),
      heavy: ok.filter((r) => r.sizeBytes > HEAVY_BYTES && r.sizeBytes <= VERY_HEAVY_BYTES).length,
      veryHeavy: ok.filter((r) => r.sizeBytes > VERY_HEAVY_BYTES).length,
      cdnTransformed: ok.filter((r) => r.cdnTransformed).length
    };

    // 4. Status.
    let status;
    let summary;
    if (allPicks.length === 0) {
      status = 'pass';
      summary = 'no images on the page';
    } else if (totals.veryHeavy > 0) {
      status = 'fail';
      summary = `${totals.veryHeavy} image${totals.veryHeavy === 1 ? '' : 's'} over 500 KB — ${formatKB(totals.totalWeight)} total across ${totals.fetched}`;
    } else if (totals.legacy > 0 && totals.legacyWeight > 300 * 1024) {
      status = 'fail';
      summary = `${totals.legacy} legacy image${totals.legacy === 1 ? '' : 's'} (${formatKB(totals.legacyWeight)}) — CDN not serving webp/avif`;
    } else if (totals.legacy > 0 || totals.heavy > 0 || failed.length > 0 || skipped.length > 0) {
      status = 'warn';
      const bits = [];
      if (totals.legacy > 0) bits.push(`${totals.legacy} legacy`);
      if (totals.heavy > 0) bits.push(`${totals.heavy} heavy >200 KB`);
      if (failed.length > 0) bits.push(`${failed.length} fetch failure${failed.length === 1 ? '' : 's'}`);
      if (skipped.length > 0) bits.push(`${skipped.length} skipped past cap`);
      summary = `${formatKB(totals.totalWeight)} across ${totals.fetched} — ${bits.join(', ')}`;
    } else {
      status = 'pass';
      const cdnBit = totals.cdnTransformed > 0
        ? `, ${totals.cdnTransformed} auto-converted by CDN`
        : '';
      summary = `${formatKB(totals.totalWeight)} across ${totals.fetched} — all modern${cdnBit}`;
    }

    const details = [
      {
        type: 'image-optimization',
        title: 'Images (largest srcset variant per group)',
        totals,
        images: results.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0)),
        fetchIssues: failed.map((r) => ({
          url: r.resolvedUrl,
          status: r.status,
          error: r.error
        })),
        skippedUrls: skipped.map((s) => s.picked.resolvedUrl)
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        ...totals,
        images: results
      }
    };
  }
};
