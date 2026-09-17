#!/usr/bin/env node
// Entry point. Usage:
//   node scripts/audit.js <url>                          Pretty terminal report
//   node scripts/audit.js <url> --json                   Machine-readable JSON
//   node scripts/audit.js <url> --only css-in-body       Run only one (or several, comma-separated) checks
//   node scripts/audit.js <url> --ua mobile              Fetch with a mobile User-Agent (default: desktop)
//
// Exit code:
//   0 — all checks passed or warned (no fails)
//   1 — one or more checks returned status 'fail'
//   2 — invalid arguments
//   1 — fetch failed (network/challenge)

import { fetchPage, FetchError } from './lib/fetch.js';
import { renderReport, sortResults } from './lib/render.js';
import { checks } from './checks/index.js';

function usage() {
  return (
    'Usage: node scripts/audit.js <url> [--json] [--only <id>[,<id>...]] [--ua desktop|mobile]\n\n' +
    'Fetches the URL once and reports a prioritized list of performance improvements.\n' +
    'Exit code 1 when any check status is "fail".'
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let url = null;
  let json = false;
  let only = null;
  let ua = 'desktop';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') return { help: true };
    else if (a === '--only') {
      const val = args[++i];
      if (!val) return { error: '--only requires a value' };
      only = val.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--only=')) {
      only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--ua') {
      const val = args[++i];
      if (val !== 'desktop' && val !== 'mobile') return { error: `--ua must be desktop or mobile (got ${val})` };
      ua = val;
    } else if (a.startsWith('--ua=')) {
      const val = a.slice('--ua='.length);
      if (val !== 'desktop' && val !== 'mobile') return { error: `--ua must be desktop or mobile (got ${val})` };
      ua = val;
    } else if (!url) url = a;
    else return { error: `Unexpected argument: ${a}` };
  }
  if (!url) return { error: 'Missing <url> argument.' };
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { error: `Only http and https URLs are supported (got ${u.protocol}).` };
    }
  } catch {
    return { error: `Invalid URL: ${url}` };
  }
  return { url, json, only, ua };
}

async function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n\n' + usage() + '\n');
    process.exit(2);
  }

  const { url, json, only, ua } = parsed;
  let context;
  try {
    context = await fetchPage(url, { ua });
  } catch (err) {
    if (err instanceof FetchError) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ error: err.message, code: err.code, status: err.status ?? null, url }, null, 2) +
            '\n'
        );
      } else {
        process.stderr.write(`Fetch failed: ${err.message}\n`);
      }
      process.exit(1);
    }
    throw err;
  }

  let toRun = checks;
  if (only) {
    const known = new Set(checks.map((c) => c.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      process.stderr.write(
        `Unknown check id(s): ${unknown.join(', ')}\n` +
          `Available: ${checks.map((c) => c.id).join(', ')}\n`
      );
      process.exit(2);
    }
    const allow = new Set(only);
    toRun = checks.filter((c) => allow.has(c.id));
  }

  const results = [];
  for (const check of toRun) {
    try {
      const out = await check.run(context);
      results.push({
        id: check.id,
        name: check.name,
        priority: check.priority,
        status: out.status,
        summary: out.summary,
        details: out.details,
        data: out.data
      });
    } catch (err) {
      results.push({
        id: check.id,
        name: check.name,
        priority: check.priority,
        status: 'fail',
        summary: `check failed: ${err.message}`,
        details: [],
        data: { error: err.message }
      });
    }
  }

  if (json) {
    const payload = {
      url: context.url,
      finalUrl: context.finalUrl,
      status: context.status,
      ua: context.ua,
      responses: context.responses,
      rawBytes: context.raw.rawBytes,
      checks: sortResults(results).map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        status: r.status,
        summary: r.summary,
        data: r.data
      }))
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    process.stdout.write(renderReport(context, results, { color }) + '\n');
  }

  const anyFail = results.some((r) => r.status === 'fail');
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});
