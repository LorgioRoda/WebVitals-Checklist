// Check: minimize the number of iframes.
//
// Iframes create a whole new browsing context per instance: extra network
// requests, extra parsing/layout, and (often) third-party scripts that
// block main-thread work. Rule of thumb: use an iframe only when there is
// no other technical option.
//
// Statuses:
//   pass — 0 iframes
//   warn — 1 iframe (often unavoidable: embed, payment widget, etc.)
//   fail — 2 or more iframes

import { parse } from 'node-html-parser';

function truncate(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function attrFlags(attrs) {
  const flags = [];
  if ('sandbox' in attrs) flags.push('sandbox');
  const loading = (attrs.loading || '').toLowerCase();
  if (loading === 'lazy') flags.push('loading=lazy');
  else if (loading === 'eager') flags.push('loading=eager');
  if ('hidden' in attrs) flags.push('hidden');
  return flags;
}

function iframeSrcLabel(attrs) {
  if (attrs.src) return truncate(attrs.src, 80);
  if ('srcdoc' in attrs) return '(inline srcdoc)';
  return '(no src)';
}

function collectIframes(root) {
  const items = [];
  const walk = (node) => {
    for (const el of node.childNodes || []) {
      if (!el) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      if (tag === 'iframe') {
        const attrs = el.attributes || {};
        items.push({
          start: el.range ? el.range[0] : null,
          src: attrs.src || null,
          hasSrcdoc: 'srcdoc' in attrs,
          label: iframeSrcLabel(attrs),
          flags: attrFlags(attrs),
          title: attrs.title || null
        });
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

export default {
  id: 'iframes',
  name: 'Minimize iframes',
  priority: 'high',
  async run(context) {
    const html = context.raw.html;
    const root = parse(html, {
      lowerCaseTagName: false,
      comment: true,
      blockTextElements: { script: true, style: true, svg: true, noscript: true }
    });

    const raw = collectIframes(root);
    const lineOffsets = makeLineIndex(html);
    const iframes = raw.map((it) => ({
      line: lineFor(lineOffsets, it.start),
      src: it.src,
      hasSrcdoc: it.hasSrcdoc,
      label: it.label,
      flags: it.flags,
      title: it.title
    }));

    let status;
    let summary;
    if (iframes.length === 0) {
      status = 'pass';
      summary = 'no iframes';
    } else if (iframes.length === 1) {
      status = 'warn';
      summary = '1 iframe — avoid unless strictly needed';
    } else {
      status = 'fail';
      summary = `${iframes.length} iframes — reduce if possible`;
    }

    const details = [
      {
        type: 'iframes',
        title: 'Iframes on the page',
        count: iframes.length,
        iframes
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        count: iframes.length,
        iframes
      }
    };
  }
};
