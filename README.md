# perf-audit

A tiny CLI that fetches a URL over HTTPS and prints a prioritized list of
performance improvements for it. No headless browser — just raw HTTP requests
and byte-level measurement of the returned HTML. Meant to be driven from
Claude Code through the bundled skill, but also usable directly.

For now it ships with a single check ("HTML document weight"). The
architecture is designed so that adding new checks (images, JS, fonts,
caching, etc.) is a matter of creating one file — see below.

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

The pretty report always begins with the improvements list (sorted high →
medium → low priority, then fail → warn → pass), followed by a detail
section per check.

## What the HTML document check measures

- **Compression** — the page is fetched three times with different
  `Accept-Encoding` headers to learn what the origin actually serves.
  Brotli is listed first; if the origin does not serve an encoding, the
  size is estimated locally with `zlib` and marked with `*`.
- **Minification** — the returned HTML is compared to a locally minified
  version. Savings are shown for raw and compressed sizes so you can judge
  the real network impact.
- **Byte breakdown** — the HTML is decomposed into disjoint categories
  (JSON in `<script>`, inline JavaScript, inline CSS, inline SVG, HTML
  comments, `data-*`/`style`/`class` attributes, indentation whitespace,
  and the remainder as "Rest") so you can see where the weight lives.

If the origin/CDN returns a bot-challenge response (403/429 or a tiny
challenge page with markers like `_abck` or `bm-verify`), the script
aborts with a clear error. It will never report numbers taken from a
challenge page.

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

The `context` argument is shared across all checks and includes the raw
HTML, the final URL after redirects, and per-encoding transferred sizes.
The page is fetched once — do not fetch again from inside a check.

## Tests

```
npm test
```

Tests use a tiny local HTTP fixture server (no external network) and cover
encoding detection, ordering, minification detection, breakdown totals, the
list sort order, and bot-challenge abort.

## Claude Code skill

The repository ships a skill at `.claude/skills/perf-audit/SKILL.md`. When
launched from the project root, Claude Code will pick it up automatically
whenever the user asks to audit / analyze / review the performance of a
URL. The skill runs the pretty report first, then reads `--json` if it
needs exact numbers, then adds a short interpretation grounded only in the
script output.
