# perf-audit

A tiny CLI that fetches a URL over HTTPS and prints a prioritized list of
performance improvements for it. No headless browser — just raw HTTP requests
and byte-level measurement. Meant to be driven from Claude Code through the
bundled skill, but also usable directly.

## Install

```
npm install
```

Requires Node 18 or newer.

## Usage

Pretty terminal report:

```
node scripts/audit.js https://www.example.com/
```

Machine-readable JSON with every raw number the script measured:

```
node scripts/audit.js https://www.example.com/ --json
```

Run only a subset of checks (comma-separated ids):

```
node scripts/audit.js https://www.example.com/ --only image-optimization,webfont-size
```

Fetch as a mobile browser instead of desktop (affects User-Agent):

```
node scripts/audit.js https://www.example.com/ --ua mobile
```

The pretty report begins with per-check details (fail/warn only), followed
by the improvements table sorted high → medium → low priority, then
fail → warn → pass, followed by a compact performance dashboard.

Exit codes: `0` = all checks passed or warned, `1` = at least one check
failed (or the fetch itself failed), `2` = invalid arguments.

If the origin/CDN returns a bot-challenge response (403/429 or a tiny
challenge page with markers like `_abck` or `bm-verify`), the script
aborts with a clear error. It will never report numbers taken from a
challenge page.

## Checks

Every check ships as its own module in `scripts/checks/` and produces a
`{ status, summary, details, data }` result. `status` is `pass`, `warn`,
or `fail`; `priority` is `high`, `medium`, or `low` and drives sort
order.

| ID | Name | Priority |
|---|---|---|
| `html-document` | HTML document weight | medium |
| `css-before-js` | CSS before JavaScript | high |
| `iframes` | Minimize iframes | high |
| `css-minification` | CSS minification | high |
| `css-in-body` | CSS in `<body>` | high |
| `webfont-formats` | Webfont formats | medium |
| `webfont-size` | Webfont size (300 KB budget) | medium |
| `image-optimization` | Image optimization | high |

### `html-document` — HTML document weight

- **Compression** — the page is fetched three times with different
  `Accept-Encoding` headers to learn what the origin actually serves.
  Brotli is listed first; if the origin does not serve an encoding, the
  size is estimated locally with `zlib` and marked with `*`.
- **Minification** — the returned HTML is compared to a locally minified
  version (`html-minifier-terser`). Savings shown for raw and compressed
  sizes so you can judge the real network impact.
- **Byte breakdown** — the HTML is decomposed into disjoint categories
  (JSON in `<script>`, inline JavaScript, inline CSS, inline SVG, HTML
  comments, `data-*`/`style`/`class` attributes, indentation whitespace,
  and the remainder as "Rest") to show where the weight lives.

### `css-before-js` — CSS before JavaScript

Scoped to `<head>` only (scripts at the end of `<body>` are conventional
and not a violation). A stylesheet declared after a `<script>` in
`<head>` forces re-layout when the CSS arrives, and for render-blocking
scripts it delays paint even further.

- **pass** — no CSS appears after any script inside `<head>`.
- **warn** — CSS appears after a non-blocking script only (`async`,
  `defer`, or `type="module"`).
- **fail** — CSS appears after a render-blocking script (inline, or
  classic `src`).

### `iframes` — Minimize iframes

Iframes create a whole new browsing context per instance: extra network
requests, extra parsing/layout, and (often) third-party scripts that
block main-thread work.

- **pass** — 0 iframes.
- **warn** — 1 iframe (often unavoidable: embed, payment widget, etc.).
- **fail** — 2 or more iframes.

### `css-minification` — CSS minification

Inline `<style>` blocks are extracted and compared against a heuristic
minifier (comments stripped, whitespace collapsed, spaces around
punctuation removed). External `<link rel="stylesheet">` files are
fetched (up to 20, concurrency 5, 8 s timeout each) and analyzed the
same way. Fetch failures — CORS, timeout, 404, DNS — are surfaced in
the details but do NOT fail the check.

- **pass** — no CSS analyzed, or every analyzed block is already
  minified.
- **warn** — under 500 bytes of savings across all analyzed CSS.
- **fail** — 500 bytes or more of savings available.

### `css-in-body` — CSS in `<body>`

Parses the document with `parse5` (so implicit `<body>` insertion is
handled correctly) and locates every `<style>` block inside `<body>`.
For each block: position, DOM elements before it, nearest
class/id-carrying ancestor, size in bytes and rule count, broad vs
scoped selector counts, layout-affecting property list, and at-rules.

Severity per block feeds the check status: `high` → `fail`, `medium` →
`warn`, `low`/`none` → `pass`. Static analysis only — styles injected
at runtime by JS are not seen.

### `webfont-formats` — Webfont formats

Modern web fonts should be delivered as WOFF2 (≈30 % smaller than WOFF,
supported by every current browser). Sources scanned:

1. `<link rel="preload" as="font">` in the HTML (`href` + `type`).
2. `@font-face` rules inside inline `<style>` blocks.
3. `@font-face` rules inside external stylesheets — up to 20
   files are re-fetched. Errors surface in the details but do not
   fail the check.

- **pass** — no fonts, or every discovered font URL is WOFF2.
- **warn** — mixed: WOFF2 is present but some legacy formats too.
- **fail** — no WOFF2 anywhere, and at least one legacy format found.

### `webfont-size` — Webfont size (300 KB budget)

Discovers every font URL referenced from the page (inline `@font-face`,
external `@font-face` inside `<link rel="stylesheet">`, and
`<link rel="preload" as="font">`), fetches each once (dedup by resolved
URL, capped at 20 fonts and 20 stylesheets, concurrency 5, 8 s timeout)
and sums the decompressed bytes.

- **pass** — 0 fonts or confirmed total ≤ 300 KB.
- **warn** — confirmed total ≤ 300 KB but some fetches failed or were
  capped, so the real total may exceed the budget.
- **fail** — confirmed total > 300 KB.

### `image-optimization` — Image optimization

**Group-based discovery.** Each `<picture>`, `<img>` (with or without
srcset), `<link rel="preload" as="image">` (with or without
`imagesrcset`), and each `url(...)` in `<style>` or inline `style=""`
becomes a **group**. Sources scanned:

- `<img src>` / `<img srcset>`
- `<source src>` / `<source srcset>` inside `<picture>`
- `<link rel="preload" as="image" href imagesrcset>`
- `background-image`, `mask-image`, `border-image`, `content`,
  `cursor`, `list-style-image` (both `<style>` blocks and inline
  `style=""` attributes)

**One fetch per group — the largest variant.** For each group we pick
the largest candidate by srcset descriptor (`Nw` first, then `Nx`,
falling back to document order) and fetch only that URL. The other
variants are recorded as siblings in the JSON output but not fetched.
This mirrors what a browser downloads instead of summing all srcset
variants and inflating the total.

**CDN-aware fetch.** Each URL is fetched with browser-like image
request headers — realistic `Accept`
(`image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8`),
`Sec-Fetch-Dest: image`, a `Referer` pointing at the page, and no
`Cache-Control: no-cache` override. Those aggressive headers cause CDN
image optimizers (Cloudflare Polish, Cloudinary `f_auto`, Fastly Image
Optimizer) to bypass optimization and return the origin bytes; the
image request path avoids that.

**Format classified from `Content-Type`.** A `.jpg` URL that the CDN
returns as `image/webp` is counted as modern — the `Content-Type` is
the source of truth. When the URL extension differs from the served
format, the image is flagged as **CDN-converted** in the output.

**Wire vs decoded weight.** Transferred bytes and decoded bytes are
tracked separately so gzip/brotli on SVG shows up.

Cap: 40 groups per page, concurrency 5, 8 s timeout each.

- **pass** — no images, or all served in modern formats and nothing
  above the very-heavy budget.
- **warn** — some legacy formats served, or heavy images (> 200 KB)
  present, or some fetches failed.
- **fail** — any image > 500 KB, or legacy formats exceed 300 KB of
  combined weight.

## Adding a new check

1. Create `scripts/checks/<your-check>.js` exporting a default object:

   ```js
   export default {
     id: 'your-check',
     name: 'Your check',
     priority: 'high', // 'high' | 'medium' | 'low'
     async run(context) {
       return {
         status: 'warn',           // 'pass' | 'warn' | 'fail'
         summary: 'short line for the list',
         details: [ /* renderable sections */ ],
         data: { /* raw numbers */ }
       };
     }
   };
   ```

2. Register it in `scripts/checks/index.js` by importing the module and
   adding it to the exported `checks` array.

3. If the check emits a new `details[].type`, add a renderer for it in
   `scripts/lib/render.js` (see the existing `renderXxx` functions).

The `context` argument is shared across all checks and includes the raw
HTML, the final URL after redirects, and per-encoding transferred sizes.
The page is fetched once — do not fetch again from inside a check. For
auxiliary resources (CSS, fonts, images), use `fetchResource()` from
`scripts/lib/fetch.js`.

## Tests

```
npm test
```

Tests use a tiny local HTTP fixture server (no external network) and
cover encoding detection, minification detection, breakdown totals, the
list sort order, bot-challenge abort, CSS/font/image discovery,
srcset grouping, and CDN content-negotiation detection.

## Claude Code skill

The repository ships a skill at `.claude/skills/perf-audit/SKILL.md`.
When launched from the project root, Claude Code picks it up
automatically whenever the user asks to audit / analyze / review the
performance of a URL. The skill runs the pretty report first, then
reads `--json` if it needs exact numbers, then adds a short
interpretation grounded only in the script output.
