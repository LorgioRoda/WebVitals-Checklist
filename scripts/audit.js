#!/usr/bin/env node
// Entry point. Usage:
//   node scripts/audit.js <url>          Pretty terminal report
//   node scripts/audit.js <url> --json   Machine-readable JSON with all numbers

import { fetchPage, FetchError } from './lib/fetch.js';
import { renderReport, sortResults } from './lib/render.js';
import { checks } from './checks/index.js';

function usage() {
  return (
    'Usage: node scripts/audit.js <url> [--json]\n\n' +
    'Fetches the URL once and reports a prioritized list of performance improvements.'
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let url = null;
  let json = false;
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') return { help: true };
    else if (!url) url = a;
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
  return { url, json };
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

  const { url, json } = parsed;
  let context;
  try {
    context = await fetchPage(url);
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

  const results = [];
  for (const check of checks) {
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
    return;
  }

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  process.stdout.write(renderReport(context, results, { color }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
  process.exit(1);
});
