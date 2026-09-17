// Check: <style> blocks in <body>.
//
// Locates every <style> whose ancestor chain includes <body> (spec-parsed
// with parse5, so implicit <body> insertion is handled correctly). For each
// block: computes position, DOM elements parsed before it, nearest
// class/id-carrying ancestor, size in bytes and rule count, broad vs scoped
// selector counts, layout-affecting property list, and at-rules.
//
// Severity → check status:
//   high   → check 'fail'
//   medium → check 'warn'
//   low    → check 'pass' (single block is not enough to fail the whole check)
//   none   → check 'pass'
//
// Static analysis only. Styles injected at runtime by JS are not seen.
// See LIMITATIONS at the bottom of the details section.

import * as parse5 from 'parse5';
import * as csstree from 'css-tree';

// Layout-affecting CSS properties. Presence of any of these triggers the
// "layout risk" bit that feeds severity.
const LAYOUT_PROPS = new Set([
  'width', 'height',
  'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block', 'margin-inline',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-inline',
  'display', 'position',
  'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline',
  'float', 'clear',
  'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'flex-direction', 'flex-wrap', 'flex-flow', 'order',
  'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self',
  'grid', 'grid-template', 'grid-template-rows', 'grid-template-columns', 'grid-template-areas',
  'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow',
  'grid-row', 'grid-column', 'grid-area', 'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  'gap', 'row-gap', 'column-gap',
  'font-size', 'font-family', 'font-weight', 'line-height',
  'aspect-ratio',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'box-sizing', 'transform', 'writing-mode', 'direction'
]);

// Elements whose descendant <style> blocks are inert for the main document.
const IGNORE_ANCESTORS = new Set(['template', 'noscript', 'svg']);

function walkTree(root, visit) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    visit(node);
    const kids = node.childNodes;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

function textContentOf(el) {
  let out = '';
  const kids = el.childNodes || [];
  for (const c of kids) {
    if (c.nodeName === '#text') out += c.value || '';
  }
  return out;
}

function attrOf(el, name) {
  const attrs = el.attrs || [];
  for (const a of attrs) if (a.name === name) return a.value;
  return null;
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

// Walk from `body` down, collecting (styleEl, ancestorChainTags).
// parse5 stores <template> children under `.content` (a DocumentFragment),
// not `.childNodes` — so we descend into both.
function collectFromBody(body) {
  const styles = [];
  const bodyLinks = [];
  const visitKids = (kids, ancestors) => {
    for (const child of kids) {
      if (!child.tagName) continue;
      const tag = child.tagName.toLowerCase();
      const nextAncestors = [...ancestors, tag];
      if (tag === 'style') {
        const ignored = ancestors.find((t) => IGNORE_ANCESTORS.has(t)) || null;
        styles.push({ el: child, ancestors: nextAncestors, ignoredBecause: ignored });
        continue;
      }
      if (tag === 'link') {
        const rel = (attrOf(child, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (rel.includes('stylesheet')) {
          bodyLinks.push({ el: child });
        }
      }
      // Normal children.
      if (child.childNodes) visitKids(child.childNodes, nextAncestors);
      // <template>: content is a DocumentFragment under .content.
      if (tag === 'template' && child.content && child.content.childNodes) {
        visitKids(child.content.childNodes, nextAncestors);
      }
    }
  };
  visitKids(body.childNodes || [], ['body']);
  return { styles, bodyLinks };
}

// Given the body element, count element nodes whose location.startOffset < target.
function countElementsBefore(body, targetOffset) {
  let n = 0;
  walkTree(body, (node) => {
    if (!node.tagName) return;
    const loc = node.sourceCodeLocation;
    if (loc && typeof loc.startOffset === 'number' && loc.startOffset < targetOffset) n++;
  });
  return n;
}

// Nearest ancestor of the <style> element that carries a class or id.
// Returns a short label like ".cmp-teaser" / "#hero" / "div.foo", or null.
function nearestContext(bodyRoot, styleEl) {
  // parse5 gives us parentNode chain — walk up until body.
  let n = styleEl.parentNode;
  while (n && n !== bodyRoot && n.nodeName !== '#document') {
    if (n.tagName) {
      const id = attrOf(n, 'id');
      const cls = attrOf(n, 'class');
      if (id) return `#${id.split(/\s+/)[0]}`;
      if (cls) {
        const first = cls.trim().split(/\s+/)[0];
        if (first) return `.${first}`;
      }
    }
    n = n.parentNode;
  }
  return null;
}

// Parse CSS with css-tree. Returns { rules, broadCount, scopedCount,
// layoutProps: Set, atRules: Set, parseError }.
function analyzeCss(cssText) {
  let ast;
  try {
    ast = csstree.parse(cssText, { positions: false, parseCustomProperty: true });
  } catch (err) {
    return {
      rules: 0,
      broadCount: 0,
      scopedCount: 0,
      layoutProps: new Set(),
      atRules: new Set(),
      parseError: err.message
    };
  }
  let rules = 0;
  let broadCount = 0;
  let scopedCount = 0;
  const layoutProps = new Set();
  const atRules = new Set();

  csstree.walk(ast, {
    enter(node) {
      if (node.type === 'Rule') {
        rules++;
        // Inspect each selector in the prelude.
        csstree.walk(node.prelude, {
          visit: 'Selector',
          enter(sel) {
            // A "broad" selector is one made only of broad primitives:
            //   TypeSelector (bare tag), universal *, or html/body/:root
            let hasScoped = false;
            let hasBroadPrim = false;
            const kids = sel.children ? sel.children.toArray() : [];
            for (const part of kids) {
              if (!part) continue;
              const t = part.type;
              if (t === 'ClassSelector' || t === 'IdSelector' || t === 'AttributeSelector') {
                hasScoped = true;
              } else if (t === 'TypeSelector') {
                const name = (part.name || '').toLowerCase();
                if (name === 'html' || name === 'body' || name === '*') hasBroadPrim = true;
                else hasBroadPrim = true;
              } else if (t === 'PseudoClassSelector') {
                const name = (part.name || '').toLowerCase();
                if (name === 'root') hasBroadPrim = true;
              } else if (t === 'NestingSelector') {
                // & — inherits scope; ignore.
              } else if (t === 'Combinator' || t === 'WhiteSpace') {
                // ignore
              }
            }
            if (hasScoped) scopedCount++;
            else if (hasBroadPrim) broadCount++;
          }
        });
      } else if (node.type === 'Declaration') {
        const prop = (node.property || '').toLowerCase();
        if (LAYOUT_PROPS.has(prop)) layoutProps.add(prop);
      } else if (node.type === 'Atrule') {
        const name = (node.name || '').toLowerCase();
        if (name) atRules.add(name);
      }
    }
  });

  return { rules, broadCount, scopedCount, layoutProps, atRules, parseError: null };
}

function classifySeverity({ pct, broadCount, layoutProps, atRules }) {
  const hasLayout = layoutProps.size > 0;
  const hasBroad = broadCount > 0;
  const hasImport = atRules.has('import');
  const reasons = [];

  if (hasImport) reasons.push('@import discovered late (extra blocking request)');
  if (hasLayout && pct < 0.30) reasons.push(`layout-affecting props in first 30% of doc (pos ${(pct * 100).toFixed(0)}%)`);
  if (hasBroad && hasLayout) reasons.push('broad selectors + layout-affecting props');
  if (reasons.length > 0) return { severity: 'high', reasons };

  const mediumReasons = [];
  if (hasLayout) mediumReasons.push(`layout-affecting props later in doc (pos ${(pct * 100).toFixed(0)}%)`);
  if (hasBroad && !hasLayout) mediumReasons.push('broad selectors (visual only)');
  if (mediumReasons.length > 0) return { severity: 'medium', reasons: mediumReasons };

  return { severity: 'low', reasons: ['only visual properties with scoped selectors'] };
}

function findElement(doc, tagName) {
  let found = null;
  walkTree(doc, (n) => {
    if (!found && n.tagName === tagName) found = n;
  });
  return found;
}

export default {
  id: 'css-in-body',
  name: 'CSS in <body>',
  priority: 'high',
  async run(context) {
    const html = context.raw.html;
    const totalBytes = Buffer.byteLength(html, 'utf8');
    const lineOffsets = makeLineIndex(html);

    const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
    const body = findElement(doc, 'body');

    if (!body) {
      return {
        status: 'pass',
        summary: 'no <body> element parsed',
        details: [
          {
            type: 'css-in-body',
            title: 'CSS in <body>',
            totalBytes,
            summary: { total: 0, high: 0, medium: 0, low: 0, ignored: 0, bodyLinks: 0 },
            blocks: [],
            ignored: [],
            bodyLinks: [],
            verdict: 'no <body> element parsed'
          }
        ],
        data: { total: 0, high: 0, medium: 0, low: 0, ignored: 0, bodyLinks: 0, blocks: [] }
      };
    }

    const { styles, bodyLinks } = collectFromBody(body);

    const analyzed = [];
    const ignored = [];

    for (let i = 0; i < styles.length; i++) {
      const { el, ancestors, ignoredBecause } = styles[i];
      const loc = el.sourceCodeLocation || {};
      const startOffset = typeof loc.startOffset === 'number' ? loc.startOffset : null;
      const line = lineFor(lineOffsets, startOffset);
      const css = textContentOf(el);
      const bytes = Buffer.byteLength(css, 'utf8');
      const pct = totalBytes === 0 ? 0 : (startOffset ?? 0) / totalBytes;
      const context = nearestContext(body, el);

      if (ignoredBecause) {
        ignored.push({
          index: i + 1,
          line,
          startOffset,
          bytes,
          context,
          ancestors,
          reason: `inside <${ignoredBecause}>`
        });
        continue;
      }

      const elementsBefore = startOffset != null ? countElementsBefore(body, startOffset) : null;
      const analysis = analyzeCss(css);
      const { severity, reasons } = classifySeverity({
        pct,
        broadCount: analysis.broadCount,
        layoutProps: analysis.layoutProps,
        atRules: analysis.atRules
      });

      analyzed.push({
        index: i + 1,
        line,
        startOffset,
        pct,
        elementsBefore,
        context,
        bytes,
        rules: analysis.rules,
        broadSelectors: analysis.broadCount,
        scopedSelectors: analysis.scopedCount,
        layoutProps: [...analysis.layoutProps].sort(),
        atRules: [...analysis.atRules].sort(),
        severity,
        reasons,
        cssPreview: previewLines(css, 5),
        parseError: analysis.parseError
      });
    }

    const counts = {
      total: analyzed.length,
      high: analyzed.filter((b) => b.severity === 'high').length,
      medium: analyzed.filter((b) => b.severity === 'medium').length,
      low: analyzed.filter((b) => b.severity === 'low').length,
      ignored: ignored.length,
      bodyLinks: bodyLinks.length
    };

    let status;
    let summary;
    let verdict;
    if (counts.total === 0) {
      status = 'pass';
      summary = 'no <style> in body';
      verdict = 'No <style> in body: nothing to fix';
    } else if (counts.high > 0) {
      status = 'fail';
      summary = `${counts.high} high, ${counts.medium} medium, ${counts.low} low`;
      verdict = `${counts.high} high-risk block${counts.high === 1 ? '' : 's'}: move to head or to a component clientlib`;
    } else if (counts.medium > 0) {
      status = 'warn';
      summary = `${counts.medium} medium, ${counts.low} low`;
      verdict = `${counts.medium} medium-risk block${counts.medium === 1 ? '' : 's'}: consider moving to head`;
    } else {
      status = 'pass';
      summary = `${counts.low} low-risk block${counts.low === 1 ? '' : 's'}`;
      verdict = 'Only low-risk blocks (visual, scoped): safe to leave';
    }

    const details = [
      {
        type: 'css-in-body',
        title: 'CSS in <body>',
        totalBytes,
        summary: counts,
        blocks: analyzed,
        ignored,
        bodyLinks: bodyLinks.map((l) => ({
          href: attrOf(l.el, 'href'),
          line: lineFor(lineOffsets, l.el.sourceCodeLocation?.startOffset)
        })),
        verdict,
        limitations: [
          'Static analysis only: styles injected at runtime by JS (web components, tag managers) are not detected.',
          'Confirm dynamic behavior with a Performance trace ("Recalculate Style" / layout shifts).',
          'Severity is a heuristic. Actual CLS depends on whether affected elements are already painted in the viewport.'
        ]
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        ...counts,
        totalBytes,
        blocks: analyzed,
        ignored,
        bodyLinks
      }
    };
  }
};

function previewLines(text, maxLines) {
  const lines = text.split(/\r?\n/);
  // Trim leading empty lines.
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  const slice = lines.slice(start, start + maxLines);
  return slice.map((l) => l.length > 120 ? l.slice(0, 119) + '…' : l);
}
