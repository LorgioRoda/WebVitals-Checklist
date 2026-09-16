---
name: perf-audit
description: Audit the runtime performance of a public web page. Trigger when the user asks to audit, analyze, review, check or profile the performance of a URL, or when they ask about HTML weight, minification, compression, Brotli/gzip, or page size for a given URL — even if they don't say "skill". Requires a URL. Not for local files or general performance advice with no URL attached.
---

# Web performance audit

Use this skill when the user gives you a URL and wants to know what to improve
about that page's performance.

The tool of record is `scripts/audit.js`. It fetches the page with three
different `Accept-Encoding` headers, measures compression, minification, and
what weighs most inside the HTML, and prints a prioritized improvements list.
All numbers in your response must come from this script — never estimate.

## How to run it

1. Pretty terminal output (this is what the user sees):

   ```
   node scripts/audit.js <url>
   ```

2. Machine-readable JSON with all raw numbers (use this to read exact values
   for your interpretation):

   ```
   node scripts/audit.js <url> --json
   ```

Run the pretty version first so the user sees the tables. Then, if you need
exact figures for your write-up, run `--json`.

## After the tool runs

Always include a **summary table** in your reply, followed by a short
interpretation (3–5 lines maximum). Focus on what the user should do first
and why. Use only numbers that appear in the script output.

### Summary table format

For a single URL, render a Markdown table with these rows (skip rows whose
value is 0 KB):

| Métrica | Valor |
|---|---|
| Status | <status> |
| Raw HTML | <size> |
| Gzip (servido/estimado) | <size> |
| Brotli (servido/estimado) | <size> |
| Minificado (ahorro comprimido) | <size> |
| Rest (markup & text) | <size> (<%>) |
| class="" | <size> (<%>) |
| Indentación | <size> (<%>) |
| data-* | <size> (<%>) |
| Inline JavaScript | <size> (<%>) |
| Inline SVG | <size> (<%>) |
| JSON in `<script>` | <size> (<%>) |
| Inline CSS `<style>` | <size> (<%>) |

For multiple URLs audited in the same turn, render one comparative table
with a column per URL (use the locale/path as the column header) instead of
one table per URL.

Match the language of the user's request for the column/row headers
(Spanish → "Métrica/Valor", English → "Metric/Value", etc.).

### Interpretation guidance

- If Brotli is not served (only gzip), recommend enabling Brotli first.
  Brotli usually compresses HTML more than gzip; the effort is usually a
  CDN toggle, and the impact is on every request.
- Judge minification savings on the **compressed** column (Brotli or gzip),
  not the raw column. If the compressed savings are only a few KB, say the
  impact is low — indentation and whitespace compress very well.
- If "Rest (markup & text)" dominates the breakdown, the weight is in the
  DOM structure itself, not inline assets. Say so, and suggest looking at
  DOM size separately (fewer nodes, less repeated markup).
- If inline `<script>` (JS or JSON blocks) or inline `<svg>` show up large,
  point them out with their share of the total.
- If the fetch is blocked by the CDN (the script exits with a bot-challenge
  message), report that plainly and stop. Do not speculate about the page.

Do not repeat the raw script tables in prose; the summary table above
already gives the user a compact view, and the full tables are visible in
the terminal output.
