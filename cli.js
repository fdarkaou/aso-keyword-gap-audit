#!/usr/bin/env node
/**
 * CLI for comparing a tracked iOS app's stored US App Store search positions
 * against one or more rivals via PeekPanda's ASO keyword gap API.
 *
 * Node 18+, zero runtime dependencies.
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  buildReport,
  diffReports,
  extractPayloads,
  normalizeGapPayload,
  toCsv,
  toMarkdown,
  toWebhookText,
} from './gap.js';

const DEFAULT_API_BASE = 'https://api.peekpanda.com';
const MAX_RETRIES = 3;

function printHelp() {
  console.log(`aso-keyword-gap-audit — Multi-rival iOS ASO keyword gap report (PeekPanda API)

Usage:
  aso-keyword-gap-audit --auto [options]
  aso-keyword-gap-audit --app <asoAppUuid> --rivals <storeId,storeId,...> [options]
  aso-keyword-gap-audit --input <gap.json> [options]

Inputs (choose one):
  --auto                     Discover your 'mine' app and 'competitor' rivals via GET /v1/aso/apps
  --app <uuid>               Tracked ASO app UUID (from GET /v1/aso/apps)
  --rivals <ids>             Comma-separated rival App Store IDs (numeric)
  --input <path>             Read local JSON (single gap response, array, or --save file); no API call

Filters:
  --max-rank <n>             Keep rows where best position <= n (e.g. 25)
  --min-rivals <n>           Require at least n rivals on a missed query (default: 1)
  --ascii-only               Keep printable ASCII queries only
  --search <text>            Substring filter on queries
  --limit <n>                Max rows per table in Markdown output (default: 25)

Diffing & Output:
  --save <path>              Save raw responses + metadata for future --prev diffs
  --prev <path>              Compare against an earlier --save file or raw JSON
  --min-move <n>             Minimum rank swing to report in shared diff (default: 3)
  --format <md|csv|json>     Output format (default: md)
  --webhook <url>            Post a concise digest to a Slack or Discord webhook URL
  --fail-on-new-top-gaps <n> Exit with code 2 if >= n new top-10 missed gaps appeared (requires --prev)

API options:
  --tenancy <value>          x-genviral-tenancy header (default: $PEEKPANDA_TENANCY or 'personal')
  --api-base <url>           Override API base URL (default: $PEEKPANDA_API_URL or https://api.peekpanda.com)

Environment:
  PEEKPANDA_TOKEN            Bearer API credential (also checks PEEKPANDA_API_KEY)
  PEEKPANDA_TENANCY          Optional tenancy header (default: personal)
`);
}

function parseArgs(argv) {
  const opts = {
    auto: false,
    app: null,
    rivals: [],
    input: null,
    maxRank: null,
    minRivals: 1,
    asciiOnly: false,
    search: null,
    limit: 25,
    save: null,
    prev: null,
    minMove: 3,
    format: 'md',
    webhook: null,
    failOnNewTopGaps: null,
    tenancy: process.env.PEEKPANDA_TENANCY || 'personal',
    apiBase: process.env.PEEKPANDA_API_URL || DEFAULT_API_BASE,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--auto':
        opts.auto = true;
        break;
      case '--app':
        opts.app = next();
        break;
      case '--rivals':
        opts.rivals.push(
          ...next()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case '--input':
        opts.input = next();
        break;
      case '--max-rank':
        opts.maxRank = Number(next());
        break;
      case '--min-rivals':
        opts.minRivals = Number(next());
        break;
      case '--ascii-only':
        opts.asciiOnly = true;
        break;
      case '--search':
        opts.search = next();
        break;
      case '--limit':
        opts.limit = Number(next());
        break;
      case '--save':
        opts.save = next();
        break;
      case '--prev':
        opts.prev = next();
        break;
      case '--min-move':
        opts.minMove = Number(next());
        break;
      case '--format':
        opts.format = next().toLowerCase();
        break;
      case '--webhook':
        opts.webhook = next();
        break;
      case '--fail-on-new-top-gaps':
        opts.failOnNewTopGaps = Number(next());
        break;
      case '--tenancy':
        opts.tenancy = next();
        break;
      case '--api-base':
        opts.apiBase = next();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['md', 'csv', 'json'].includes(opts.format)) {
    throw new Error(`Unsupported --format "${opts.format}". Use md, csv, or json.`);
  }
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(url, { token, tenancy }) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-genviral-tenancy': tenancy,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (res.ok && body && !body.error) {
      return body;
    }

    const retryable =
      res.status === 429 ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504 ||
      Boolean(body?.error?.retryable);

    if (retryable && attempt < MAX_RETRIES) {
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      const retryAfterBody = Number(body?.error?.retryAfterSeconds);
      const waitSec =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader
          : Number.isFinite(retryAfterBody) && retryAfterBody > 0
            ? retryAfterBody
            : 2 * (attempt + 1);
      await sleep(Math.min(waitSec, 30) * 1000);
      continue;
    }

    const code = body?.error?.code || `http_${res.status}`;
    const msg = body?.error?.message || text.slice(0, 200) || res.statusText;
    throw new Error(`PeekPanda API error (${res.status} ${code}): ${msg}`);
  }
  throw new Error('PeekPanda API request failed after retries.');
}

async function postWebhook(webhookUrl, text) {
  const isDiscord = /discord(?:app)?\.com\/api\/webhooks\//i.test(webhookUrl);
  const payload = isDiscord ? { content: text.slice(0, 1950) } : { text };
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Webhook POST failed with HTTP ${res.status}`);
  }
}

async function fetchLivePayloads(opts) {
  const token = (process.env.PEEKPANDA_TOKEN || process.env.PEEKPANDA_API_KEY || '').trim();
  if (!token) {
    throw new Error('Set PEEKPANDA_TOKEN (or PEEKPANDA_API_KEY) to query the PeekPanda API, or use --input <file>.');
  }

  const base = opts.apiBase.replace(/\/+$/, '');
  const auth = { token, tenancy: opts.tenancy };

  let appId = opts.app;
  let subjectName = null;
  let subjectStoreId = null;
  let rivalIds = [...opts.rivals];

  if (opts.auto || !appId || !rivalIds.length) {
    const appsRes = await apiGet(`${base}/v1/aso/apps`, auth);
    const apps = Array.isArray(appsRes?.data) ? appsRes.data : [];

    if (!appId) {
      const mine = apps.find((a) => a.role === 'mine' && a.kind === 'apple') || apps.find((a) => a.kind === 'apple');
      if (!mine) {
        throw new Error('No tracked iOS apps found in GET /v1/aso/apps. Track an app first or pass --app and --rivals.');
      }
      appId = mine.id;
      subjectName = mine.name || null;
      subjectStoreId = mine.storeId || null;
    } else {
      const match = apps.find((a) => a.id === appId);
      if (match) {
        subjectName = match.name || null;
        subjectStoreId = match.storeId || null;
      }
    }

    if (!rivalIds.length) {
      rivalIds = apps
        .filter((a) => a.id !== appId && a.kind === 'apple' && a.storeId)
        .map((a) => String(a.storeId));
      if (!rivalIds.length) {
        throw new Error('No competitor apps found in GET /v1/aso/apps. Pass --rivals <storeId,...>.');
      }
    }
  }

  const uniqueRivals = [...new Set(rivalIds)];
  const raws = [];
  const errors = [];

  for (const rivalStoreId of uniqueRivals) {
    if (!/^\d+$/.test(rivalStoreId)) {
      throw new Error(`Invalid numeric rival storeId: "${rivalStoreId}"`);
    }
    try {
      const data = await apiGet(
        `${base}/v1/aso/apps/${encodeURIComponent(appId)}/gap/${encodeURIComponent(rivalStoreId)}`,
        auth,
      );
      raws.push(data);
    } catch (err) {
      errors.push({ rivalStoreId, message: err.message });
    }
  }

  if (!raws.length) {
    const detail = errors.map((e) => `${e.rivalStoreId}: ${e.message}`).join('; ');
    throw new Error(`All gap requests failed (${detail})`);
  }

  if (errors.length) {
    for (const e of errors) {
      process.stderr.write(`Warning: skipped rival ${e.rivalStoreId} (${e.message})\n`);
    }
  }

  return {
    subject: {
      appId,
      storeId: subjectStoreId || raws[0]?.subjectStoreId || '',
      name: subjectName,
    },
    raws,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  let savedBundle;
  let payloads;

  if (opts.input) {
    const rawJson = JSON.parse(await readFile(opts.input, 'utf8'));
    payloads = extractPayloads(rawJson);
    savedBundle = {
      generatedAt: new Date().toISOString(),
      subject: {
        storeId: payloads[0]?.subjectStoreId || '',
        name: payloads[0]?.subjectName || null,
      },
      raws: Array.isArray(rawJson?.raws) ? rawJson.raws : Array.isArray(rawJson) ? rawJson : [rawJson],
    };
  } else if (opts.auto || (opts.app && opts.rivals.length)) {
    const live = await fetchLivePayloads(opts);
    savedBundle = {
      generatedAt: new Date().toISOString(),
      subject: live.subject,
      raws: live.raws,
    };
    payloads = live.raws.map((raw) =>
      normalizeGapPayload(raw, {
        subjectStoreId: live.subject.storeId,
        subjectName: live.subject.name,
      }),
    );
  } else {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const filterOpts = {
    maxRank: opts.maxRank,
    minRivals: opts.minRivals,
    asciiOnly: opts.asciiOnly,
    search: opts.search,
    subjectName: savedBundle.subject?.name,
  };

  const report = buildReport(payloads, filterOpts);

  let changes = null;
  if (opts.prev) {
    const prevJson = JSON.parse(await readFile(opts.prev, 'utf8'));
    const prevPayloads = extractPayloads(prevJson);
    const prevReport = buildReport(prevPayloads, {
      ...filterOpts,
      subjectName: prevJson?.subject?.name ?? filterOpts.subjectName,
    });
    changes = diffReports(prevReport, report, { minMove: opts.minMove });
  }

  if (opts.save) {
    await writeFile(opts.save, JSON.stringify(savedBundle, null, 2) + '\n', 'utf8');
  }

  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify({ report, changes }, null, 2) + '\n');
  } else if (opts.format === 'csv') {
    process.stdout.write(toCsv(report));
  } else {
    process.stdout.write(toMarkdown(report, changes, { limit: opts.limit }) + '\n');
  }

  if (opts.webhook) {
    await postWebhook(opts.webhook, toWebhookText(report, changes));
  }

  if (opts.failOnNewTopGaps != null && changes) {
    const newTop10 = changes.newMissed.filter((row) => row.bestRivalPosition <= 10).length;
    if (newTop10 >= opts.failOnNewTopGaps) {
      process.stderr.write(`Threshold hit: ${newTop10} new top-10 missed gap(s) (limit ${opts.failOnNewTopGaps}).\n`);
      process.exitCode = 2;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
