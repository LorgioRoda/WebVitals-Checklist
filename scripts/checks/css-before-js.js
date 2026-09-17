// Check: CSS tags must appear before JavaScript tags — scoped to <head>.
//
// A stylesheet declared after a <script> in <head> forces the browser to
// re-do layout (and, for render-blocking scripts, delays paint until CSS
// arrives *after* the script has already blocked the parser). Only the
// <head> is inspected — scripts at the end of <body> are conventional and
// not a violation.
//
// Statuses:
//   pass — no CSS appears after any script inside <head>
//   warn — CSS appears after a non-blocking script only (async / defer / module)
//   fail — CSS appears after a render-blocking script (inline, or classic src)

import { parse } from 'node-html-parser';

const JSON_SCRIPT_TYPES = new Set(['application/ld+json', 'application/json', 'importmap']);

function isJsonScript(attrs) {
  const type = (attrs.type || '').toLowerCase();
  if (!type) return false;
  return JSON_SCRIPT_TYPES.has(type) || type.endsWith('/json');
}

function isStylesheetLink(attrs) {
  const rel = (attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
  return rel.includes('stylesheet');
}

function isRenderBlockingScript(attrs) {
  // Inline scripts always block the parser at their position.
  if (!attrs.src) return true;
  if ('async' in attrs) return false;
  if ('defer' in attrs) return false;
  const type = (attrs.type || '').toLowerCase();
  if (type === 'module') return false;
  return true;
}

function scriptLabel(attrs) {
  const parts = [];
  if (attrs.src) parts.push(`src="${truncate(attrs.src, 60)}"`);
  else parts.push('inline');
  if ('async' in attrs) parts.push('async');
  if ('defer' in attrs) parts.push('defer');
  const type = (attrs.type || '').toLowerCase();
  if (type === 'module') parts.push('module');
  return parts.join(' · ');
}

function cssLabel(tag, attrs) {
  if (tag === 'link') return `<link rel="stylesheet" href="${truncate(attrs.href || '', 60)}">`;
  return '<style>';
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function findHead(root) {
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      if (tag === 'head') return el;
      const found = walk(el);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

function collect(head) {
  const items = [];
  if (!head) return items;
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      const attrs = el.attributes || {};
      const start = el.range ? el.range[0] : null;
      if (tag === 'script') {
        if (!isJsonScript(attrs)) {
          items.push({
            kind: 'js',
            tag: 'script',
            attrs,
            start,
            renderBlocking: isRenderBlockingScript(attrs),
            label: scriptLabel(attrs)
          });
        }
      } else if (tag === 'style') {
        items.push({ kind: 'css', tag: 'style', attrs, start, label: cssLabel('style', attrs) });
      } else if (tag === 'link' && isStylesheetLink(attrs)) {
        items.push({ kind: 'css', tag: 'link', attrs, start, label: cssLabel('link', attrs) });
      }
      walk(el);
    }
  };
  walk(head);
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

export default {
  id: 'css-before-js',
  name: 'CSS before JavaScript',
  priority: 'high',
  async run(context) {
    const html = context.raw.html;
    const root = parse(html, {
      lowerCaseTagName: false,
      comment: true,
      blockTextElements: { script: true, style: true, svg: true, noscript: true }
    });

    const head = findHead(root);
    const items = collect(head);
    const lineOffsets = makeLineIndex(html);

    const scripts = items.filter((i) => i.kind === 'js');
    const styles = items.filter((i) => i.kind === 'css');

    const offenders = [];
    let worstBlocking = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'js') continue;
      const cssAfter = items.slice(i + 1).filter((x) => x.kind === 'css');
      if (cssAfter.length === 0) continue;
      if (it.renderBlocking) worstBlocking = true;
      offenders.push({
        line: lineFor(lineOffsets, it.start),
        label: it.label,
        renderBlocking: it.renderBlocking,
        cssAfter: cssAfter.map((c) => ({
          line: lineFor(lineOffsets, c.start),
          label: c.label
        }))
      });
    }

    let status;
    let summary;
    if (!head) {
      status = 'pass';
      summary = 'no <head> found';
    } else if (offenders.length === 0) {
      status = 'pass';
      summary =
        scripts.length === 0 || styles.length === 0
          ? 'no ordering issues in <head>'
          : `CSS before all ${scripts.length} <head> script${scripts.length === 1 ? '' : 's'}`;
    } else if (worstBlocking) {
      status = 'fail';
      summary = `CSS after ${offenders.length} render-blocking <head> script${offenders.length === 1 ? '' : 's'}`;
    } else {
      status = 'warn';
      summary = `CSS after ${offenders.length} non-blocking <head> script${offenders.length === 1 ? '' : 's'}`;
    }

    const details = [
      {
        type: 'css-before-js',
        title: 'CSS / JS ordering in <head>',
        totals: {
          scripts: scripts.length,
          styles: styles.length,
          offenders: offenders.length
        },
        offenders
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        scripts: scripts.length,
        styles: styles.length,
        offenders: offenders.length,
        worstBlocking,
        items: offenders
      }
    };
  }
};
