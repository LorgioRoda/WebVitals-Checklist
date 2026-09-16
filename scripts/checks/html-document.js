// Check: HTML document weight.
//
// Produces three tables:
//   1. Compression served vs raw (Brotli row first; estimates when missing)
//   2. Minification current vs minified (raw + compressed columns)
//   3. What weighs most in the HTML (disjoint byte breakdown)
//
// All numbers come from measurement — no estimation beyond compressed size
// simulation (zlib) when the origin does not serve a given encoding.

import zlib from 'node:zlib';
import { parse } from 'node-html-parser';
import { minify } from 'html-minifier-terser';

const BROTLI_QUALITY = 5;

// -------- Compression --------

function brotliSize(buf) {
  return zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY }
  }).length;
}

function gzipSize(buf) {
  return zlib.gzipSync(buf).length;
}

function buildCompressionTable(context) {
  const rawBuf = Buffer.from(context.raw.html, 'utf8');
  const rawBytes = rawBuf.length;
  const brServed = context.responses.br.served;
  const gzipServed = context.responses.gzip.served;
  const brBytes = brServed
    ? context.responses.br.transferredBytes
    : brotliSize(rawBuf);
  const gzipBytes = gzipServed
    ? context.responses.gzip.transferredBytes
    : gzipSize(rawBuf);
  return {
    rawBytes,
    brBytes,
    gzipBytes,
    brServed,
    gzipServed,
    brEstimated: !brServed,
    gzipEstimated: !gzipServed
  };
}

// -------- Minification --------

async function minifyHtml(html) {
  return minify(html, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: true,
    continueOnParseError: true
  });
}

function countLines(str) {
  if (str.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 10) count++;
  return count;
}

function indentationStats(html) {
  let bytes = 0;
  const regex = /^[ \t]+/gm;
  let m;
  while ((m = regex.exec(html)) !== null) {
    bytes += Buffer.byteLength(m[0], 'utf8');
  }
  const totalBytes = Buffer.byteLength(html, 'utf8');
  return { bytes, pct: totalBytes === 0 ? 0 : (bytes / totalBytes) * 100 };
}

function countBlankLines(html) {
  let count = 0;
  for (const line of html.split(/\r?\n/)) {
    if (line.trim().length === 0) count++;
  }
  return count;
}

function countHtmlComments(html) {
  let count = 0;
  const regex = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    if (!m[1].trimStart().startsWith('[if ')) count++;
  }
  return count;
}

function isMinified({ lines, rawBytes, indentPct, commentCount }) {
  if (indentPct >= 1) return false;
  if (commentCount > 0) return false;
  if (lines <= 5) return true;
  return rawBytes / lines > 500;
}

// -------- Breakdown --------

function computeBreakdown(html) {
  const n = html.length;
  const totalBytes = Buffer.byteLength(html, 'utf8');
  const consumed = new Uint8Array(n);

  function markAndSize(start, end) {
    // Marks [start, end) in the mask and returns the UTF-8 byte size of
    // characters that were not already consumed. Callers depend on this
    // exclusive accounting so all categories stay disjoint.
    let bytes = 0;
    let spanStart = -1;
    for (let i = start; i < end; i++) {
      if (!consumed[i]) {
        consumed[i] = 1;
        if (spanStart === -1) spanStart = i;
      } else if (spanStart !== -1) {
        bytes += Buffer.byteLength(html.slice(spanStart, i), 'utf8');
        spanStart = -1;
      }
    }
    if (spanStart !== -1) bytes += Buffer.byteLength(html.slice(spanStart, end), 'utf8');
    return bytes;
  }

  // 1. HTML comments (skip IE conditional comments).
  let htmlComments = 0;
  {
    const regex = /<!--([\s\S]*?)-->/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      if (m[1].trimStart().startsWith('[if ')) continue;
      htmlComments += markAndSize(m.index, m.index + m[0].length);
    }
  }

  // 2. Blob elements: <script>, <style>, outermost <svg>.
  const root = parse(html, {
    lowerCaseTagName: false,
    comment: true,
    blockTextElements: { script: true, style: true, svg: true, noscript: true }
  });

  let jsonScripts = 0;
  let inlineJs = 0;
  let inlineCss = 0;
  let inlineSvg = 0;

  const walk = (node) => {
    const children = node.childNodes || [];
    for (const el of children) {
      if (!el || !el.range) continue;
      const tag = el.rawTagName ? el.rawTagName.toLowerCase() : null;
      const [start, end] = el.range;
      if (tag === 'svg') {
        inlineSvg += markAndSize(start, end);
        continue;
      }
      if (tag === 'script') {
        const attrs = el.attributes || {};
        if (!attrs.src) {
          const type = (attrs.type || '').toLowerCase();
          if (
            type === 'application/ld+json' ||
            type === 'application/json' ||
            type.endsWith('/json') ||
            type === 'importmap'
          ) {
            jsonScripts += markAndSize(start, end);
          } else {
            inlineJs += markAndSize(start, end);
          }
        }
        continue;
      }
      if (tag === 'style') {
        inlineCss += markAndSize(start, end);
        continue;
      }
      walk(el);
    }
  };
  walk(root);

  // 3. Attribute scan (data-*, style, class) outside consumed regions.
  const attr = { data: 0, style: 0, class: 0 };
  {
    let i = 0;
    const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    const isName = (c) =>
      isAlpha(c) || (c >= '0' && c <= '9') || c === '-' || c === '_' || c === ':';
    const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    while (i < n) {
      if (consumed[i]) { i++; continue; }
      if (html[i] !== '<' || i + 1 >= n || !isAlpha(html[i + 1])) { i++; continue; }
      let j = i + 1;
      while (j < n && isName(html[j])) j++;
      while (j < n && html[j] !== '>') {
        if (consumed[j]) { j++; continue; }
        while (j < n && (isWs(html[j]) || html[j] === '/')) j++;
        if (j >= n || html[j] === '>') break;
        const nameStart = j;
        while (j < n && html[j] !== '=' && html[j] !== '>' && html[j] !== '/' && !isWs(html[j])) j++;
        const name = html.slice(nameStart, j).toLowerCase();
        let attrEnd = j;
        if (j < n && html[j] === '=') {
          j++;
          if (j < n && (html[j] === '"' || html[j] === "'")) {
            const quote = html[j];
            j++;
            while (j < n && html[j] !== quote) j++;
            if (j < n) j++;
          } else {
            while (j < n && !isWs(html[j]) && html[j] !== '>') j++;
          }
          attrEnd = j;
        }
        if (name.startsWith('data-')) {
          attr.data += markAndSize(nameStart, attrEnd);
        } else if (name === 'style') {
          attr.style += markAndSize(nameStart, attrEnd);
        } else if (name === 'class') {
          attr.class += markAndSize(nameStart, attrEnd);
        }
      }
      i = j < n ? j + 1 : j;
    }
  }

  // 4. Indentation whitespace on remaining bytes.
  let indentation = 0;
  {
    const regex = /^[ \t]+/gm;
    let m;
    while ((m = regex.exec(html)) !== null) {
      indentation += markAndSize(m.index, m.index + m[0].length);
    }
  }

  // 5. Rest = whatever is left in the mask.
  const categorized =
    htmlComments +
    jsonScripts +
    inlineJs +
    inlineCss +
    inlineSvg +
    attr.data +
    attr.style +
    attr.class +
    indentation;
  const rest = Math.max(0, totalBytes - categorized);

  const rows = [
    { label: 'JSON in <script>', bytes: jsonScripts },
    { label: 'Inline JavaScript', bytes: inlineJs },
    { label: 'Inline CSS <style>', bytes: inlineCss },
    { label: 'Inline SVG', bytes: inlineSvg },
    { label: 'HTML comments', bytes: htmlComments },
    { label: 'data-* attributes', bytes: attr.data },
    { label: 'style="" attributes', bytes: attr.style },
    { label: 'class="" attributes', bytes: attr.class },
    { label: 'Indentation whitespace', bytes: indentation },
    { label: 'Rest (markup & text)', bytes: rest }
  ].sort((a, b) => b.bytes - a.bytes);

  return { totalBytes, rows };
}

// -------- Status & summary --------

function pickStatusAndSummary({ brServed, gzipServed, browserEncoding, minified }) {
  const noCompression = !browserEncoding;
  const brotliServed = brServed;
  const minifyPart = minified ? 'minified' : 'not minified';

  if (noCompression) {
    return { status: 'fail', summary: `no compression, ${minifyPart}` };
  }
  if (brotliServed) {
    return {
      status: minified ? 'pass' : 'warn',
      summary: `Brotli, ${minifyPart}`
    };
  }
  // gzip or deflate only (not Brotli).
  const label = gzipServed || browserEncoding === 'gzip' ? 'gzip only' : `${browserEncoding} only`;
  return { status: 'warn', summary: `${label}, ${minifyPart}` };
}

// -------- Check module --------

export default {
  id: 'html-document',
  name: 'HTML document weight',
  priority: 'medium',
  async run(context) {
    const html = context.raw.html;
    const rawBuf = Buffer.from(html, 'utf8');

    const compression = buildCompressionTable(context);

    const minifiedHtml = await minifyHtml(html);
    const minifiedBuf = Buffer.from(minifiedHtml, 'utf8');
    const minifiedRawBytes = minifiedBuf.length;
    const minifiedBrBytes = brotliSize(minifiedBuf);
    const minifiedGzipBytes = gzipSize(minifiedBuf);

    const currentLines = countLines(html);
    const minifiedLines = countLines(minifiedHtml);
    const indent = indentationStats(html);
    const blank = countBlankLines(html);
    const comments = countHtmlComments(html);
    const minified = isMinified({
      lines: currentLines,
      rawBytes: rawBuf.length,
      indentPct: indent.pct,
      commentCount: comments
    });

    const breakdown = computeBreakdown(html);

    const { status, summary } = pickStatusAndSummary({
      brServed: context.responses.br.served,
      gzipServed: context.responses.gzip.served,
      browserEncoding: context.responses.browser.encoding,
      minified
    });

    const details = [
      {
        type: 'compression',
        title: 'Compression',
        rows: [
          {
            encoding: 'Brotli',
            served: compression.brServed,
            bytes: compression.brBytes,
            estimated: compression.brEstimated,
            pctOfRaw: (compression.brBytes / compression.rawBytes) * 100
          },
          {
            encoding: 'Gzip',
            served: compression.gzipServed,
            bytes: compression.gzipBytes,
            estimated: compression.gzipEstimated,
            pctOfRaw: (compression.gzipBytes / compression.rawBytes) * 100
          },
          {
            encoding: 'None',
            served: null,
            bytes: compression.rawBytes,
            estimated: false,
            pctOfRaw: 100
          }
        ],
        footnote:
          compression.brEstimated || compression.gzipEstimated
            ? "* estimated: the server doesn't serve this encoding"
            : null
      },
      {
        type: 'minification',
        title: 'Minification',
        minified,
        indentBytes: indent.bytes,
        indentPct: indent.pct,
        blankLines: blank,
        commentCount: comments,
        rows: [
          {
            version: 'Current',
            lines: currentLines,
            rawBytes: rawBuf.length,
            brBytes: compression.brBytes,
            gzipBytes: compression.gzipBytes,
            brEstimated: compression.brEstimated,
            gzipEstimated: compression.gzipEstimated
          },
          {
            version: 'Minified',
            lines: minifiedLines,
            rawBytes: minifiedRawBytes,
            brBytes: minifiedBrBytes,
            gzipBytes: minifiedGzipBytes,
            brEstimated: true,
            gzipEstimated: true
          },
          {
            version: 'Savings',
            lines: currentLines - minifiedLines,
            rawBytes: rawBuf.length - minifiedRawBytes,
            brBytes: compression.brBytes - minifiedBrBytes,
            gzipBytes: compression.gzipBytes - minifiedGzipBytes,
            brEstimated: compression.brEstimated,
            gzipEstimated: compression.gzipEstimated
          }
        ]
      },
      {
        type: 'breakdown',
        title: 'What weighs most in the HTML',
        totalBytes: breakdown.totalBytes,
        rows: breakdown.rows.map((r) => ({
          label: r.label,
          bytes: r.bytes,
          pct: breakdown.totalBytes === 0 ? 0 : (r.bytes / breakdown.totalBytes) * 100
        }))
      }
    ];

    return {
      status,
      summary,
      details,
      data: {
        rawBytes: rawBuf.length,
        compression,
        minification: {
          minified,
          currentLines,
          minifiedLines,
          indentBytes: indent.bytes,
          indentPct: indent.pct,
          blankLines: blank,
          commentCount: comments,
          minifiedRawBytes,
          minifiedBrBytes,
          minifiedGzipBytes
        },
        breakdown
      }
    };
  }
};
