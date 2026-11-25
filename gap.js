/**
 * Pure aggregation, filtering, diffing and formatting for PeekPanda's
 * GET /v1/aso/apps/{appId}/gap/{rivalStoreId} responses.
 * Zero dependencies; shared between the Node CLI and the static browser page.
 */

const ASCII_RE = /^[\x20-\x7E]+$/;

function normalizeQuery(query) {
  return String(query ?? '').trim().toLowerCase();
}

function asPosition(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Normalize a single GET /v1/aso/apps/{appId}/gap/{rivalStoreId} response.
 */
export function normalizeGapPayload(raw, fallbackMeta = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Gap payload must be a JSON object.');
  }

  const subjectStoreId = cleanText(raw.subjectStoreId ?? fallbackMeta.subjectStoreId);
  const rivalStoreId = cleanText(raw.rivalStoreId ?? fallbackMeta.rivalStoreId);
  const rivalName = cleanText(raw.rivalName ?? fallbackMeta.rivalName) || rivalStoreId || 'Unknown rival';

  if (!rivalStoreId) {
    throw new Error('Gap payload is missing rivalStoreId.');
  }

  const onlyRival = Array.isArray(raw.onlyRival)
    ? raw.onlyRival
        .map((row) => ({
          query: cleanText(row?.query),
          rivalPosition: asPosition(row?.rivalPosition),
        }))
        .filter((row) => row.query && row.rivalPosition !== null)
    : [];

  const onlySubject = Array.isArray(raw.onlySubject)
    ? raw.onlySubject
        .map((row) => ({
          query: cleanText(row?.query),
          subjectPosition: asPosition(row?.subjectPosition),
        }))
        .filter((row) => row.query && row.subjectPosition !== null)
    : [];

  const shared = Array.isArray(raw.shared)
    ? raw.shared
        .map((row) => ({
          query: cleanText(row?.query),
          subjectPosition: asPosition(row?.subjectPosition),
          rivalPosition: asPosition(row?.rivalPosition),
        }))
        .filter((row) => row.query && row.subjectPosition !== null && row.rivalPosition !== null)
    : [];

  return {
    subjectStoreId,
    subjectName: cleanText(raw.subjectName ?? fallbackMeta.subjectName) || null,
    rivalStoreId,
    rivalName,
    onlyRival,
    onlySubject,
    shared,
  };
}

/**
 * Extract one or more gap payloads from a single API response, an array of
 * responses, or a saved CLI run object ({ subject, raws }).
 */
export function extractPayloads(input) {
  if (Array.isArray(input)) {
    if (!input.length) throw new Error('Input array is empty.');
    return input.map((item) => normalizeGapPayload(item?.raw ?? item, item));
  }
  if (input && typeof input === 'object' && Array.isArray(input.raws)) {
    if (!input.raws.length) throw new Error('Saved run contains no gap responses.');
    return input.raws.map((item) =>
      normalizeGapPayload(item?.raw ?? item, {
        subjectStoreId: input.subject?.storeId,
        subjectName: input.subject?.name,
        ...(item || {}),
      }),
    );
  }
  return [normalizeGapPayload(input)];
}

/**
 * Aggregate 1..N rival gap responses for the same subject app.
 */
export function buildReport(payloads, options = {}) {
  const normalized = payloads.map((p) =>
    p && Array.isArray(p.onlyRival) && p.rivalStoreId ? p : normalizeGapPayload(p),
  );
  if (!normalized.length) {
    throw new Error('At least one rival gap payload is required.');
  }

  const maxRank =
    options.maxRank != null && Number.isFinite(Number(options.maxRank)) && Number(options.maxRank) > 0
      ? Math.trunc(Number(options.maxRank))
      : null;
  const minRivals =
    options.minRivals != null && Number.isFinite(Number(options.minRivals)) && Number(options.minRivals) >= 1
      ? Math.trunc(Number(options.minRivals))
      : 1;
  const asciiOnly = Boolean(options.asciiOnly);
  const searchFilter = normalizeQuery(options.search ?? '');
  const strikingGap = Number.isFinite(Number(options.strikingGap)) ? Math.trunc(Number(options.strikingGap)) : 10;
  const strikingCeiling = Number.isFinite(Number(options.strikingCeiling))
    ? Math.trunc(Number(options.strikingCeiling))
    : 20;

  const subjectStoreId = normalized.find((p) => p.subjectStoreId)?.subjectStoreId || '';
  const subjectName =
    cleanText(options.subjectName) || normalized.find((p) => p.subjectName)?.subjectName || null;

  const matchesTextFilters = (query) => {
    if (asciiOnly && !ASCII_RE.test(query)) return false;
    if (searchFilter && !normalizeQuery(query).includes(searchFilter)) return false;
    return true;
  };

  // Deduplicate rivals by storeId while preserving first-seen order
  const seenRivals = new Map();
  for (const p of normalized) {
    if (!seenRivals.has(p.rivalStoreId)) {
      seenRivals.set(p.rivalStoreId, p);
    }
  }
  const uniquePayloads = [...seenRivals.values()];

  const missedMap = new Map();
  const sharedMap = new Map();
  const subjectPosMap = new Map();
  const rivalPresenceOnSubjectQuery = new Set();

  const rivalSummaries = [];

  for (const p of uniquePayloads) {
    let sharedWins = 0;
    let sharedLosses = 0;
    let sharedTies = 0;
    let top10Missed = 0;

    for (const row of p.onlyRival) {
      const key = normalizeQuery(row.query);
      if (row.rivalPosition <= 10) top10Missed += 1;
      if (!missedMap.has(key)) {
        missedMap.set(key, { query: row.query, rivals: [] });
      }
      missedMap.get(key).rivals.push({
        storeId: p.rivalStoreId,
        name: p.rivalName,
        position: row.rivalPosition,
      });
    }

    for (const row of p.shared) {
      const key = normalizeQuery(row.query);
      rivalPresenceOnSubjectQuery.add(key);
      if (!subjectPosMap.has(key)) {
        subjectPosMap.set(key, { query: row.query, subjectPosition: row.subjectPosition });
      }
      if (row.subjectPosition < row.rivalPosition) sharedWins += 1;
      else if (row.subjectPosition > row.rivalPosition) sharedLosses += 1;
      else sharedTies += 1;

      if (!sharedMap.has(key)) {
        sharedMap.set(key, {
          query: row.query,
          subjectPosition: row.subjectPosition,
          rivals: [],
        });
      }
      sharedMap.get(key).rivals.push({
        storeId: p.rivalStoreId,
        name: p.rivalName,
        position: row.rivalPosition,
      });
    }

    for (const row of p.onlySubject) {
      const key = normalizeQuery(row.query);
      if (!subjectPosMap.has(key)) {
        subjectPosMap.set(key, { query: row.query, subjectPosition: row.subjectPosition });
      }
    }

    rivalSummaries.push({
      storeId: p.rivalStoreId,
      name: p.rivalName,
      onlyRivalCount: p.onlyRival.length,
      top10Missed,
      sharedCount: p.shared.length,
      sharedWins,
      sharedLosses,
      sharedTies,
      onlySubjectCount: p.onlySubject.length,
    });
  }

  // If a query appears in shared for at least one rival, it is NOT absent for the subject app.
  for (const key of sharedMap.keys()) {
    missedMap.delete(key);
  }

  const missed = [];
  for (const entry of missedMap.values()) {
    if (!matchesTextFilters(entry.query)) continue;
    const rivalsSorted = [...entry.rivals].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const filteredRivals = maxRank ? rivalsSorted.filter((r) => r.position <= maxRank) : rivalsSorted;
    if (filteredRivals.length < minRivals) continue;

    const bestRivalPosition = filteredRivals[0].position;
    const avgRivalPosition = Number(
      (filteredRivals.reduce((sum, r) => sum + r.position, 0) / filteredRivals.length).toFixed(1),
    );
    missed.push({
      query: entry.query,
      rivalCount: filteredRivals.length,
      bestRivalPosition,
      avgRivalPosition,
      rivals: filteredRivals,
    });
  }

  missed.sort(
    (a, b) =>
      b.rivalCount - a.rivalCount ||
      a.bestRivalPosition - b.bestRivalPosition ||
      a.avgRivalPosition - b.avgRivalPosition ||
      a.query.localeCompare(b.query),
  );

  const shared = [];
  for (const entry of sharedMap.values()) {
    if (!matchesTextFilters(entry.query)) continue;
    const rivalsSorted = [...entry.rivals].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const bestRivalPosition = rivalsSorted[0].position;
    if (maxRank && Math.min(entry.subjectPosition, bestRivalPosition) > maxRank) continue;

    const delta = entry.subjectPosition - bestRivalPosition; // >0 means trailing best rival
    const status = delta > 0 ? 'trailing' : delta < 0 ? 'leading' : 'tied';
    const strikingDistance =
      status === 'trailing' && delta <= strikingGap && bestRivalPosition <= strikingCeiling;

    shared.push({
      query: entry.query,
      subjectPosition: entry.subjectPosition,
      rivalCount: rivalsSorted.length,
      bestRivalPosition,
      delta,
      status,
      strikingDistance,
      rivals: rivalsSorted,
    });
  }

  shared.sort(
    (a, b) =>
      Number(b.strikingDistance) - Number(a.strikingDistance) ||
      b.delta - a.delta ||
      a.bestRivalPosition - b.bestRivalPosition ||
      a.query.localeCompare(b.query),
  );

  const moat = [];
  for (const [key, entry] of subjectPosMap.entries()) {
    if (rivalPresenceOnSubjectQuery.has(key)) continue;
    if (!matchesTextFilters(entry.query)) continue;
    if (maxRank && entry.subjectPosition > maxRank) continue;
    moat.push({
      query: entry.query,
      subjectPosition: entry.subjectPosition,
    });
  }
  moat.sort((a, b) => a.subjectPosition - b.subjectPosition || a.query.localeCompare(b.query));

  return {
    subject: {
      storeId: subjectStoreId,
      name: subjectName,
    },
    filters: {
      maxRank,
      minRivals,
      asciiOnly,
      search: searchFilter || null,
    },
    rivals: rivalSummaries,
    summary: {
      rivalCount: rivalSummaries.length,
      missedCount: missed.length,
      consensusMissedCount: missed.filter((row) => row.rivalCount >= 2).length,
      top10MissedCount: missed.filter((row) => row.bestRivalPosition <= 10).length,
      sharedCount: shared.length,
      strikingDistanceCount: shared.filter((row) => row.strikingDistance).length,
      trailingCount: shared.filter((row) => row.status === 'trailing').length,
      leadingCount: shared.filter((row) => row.status === 'leading').length,
      moatCount: moat.length,
    },
    missed,
    shared,
    moat,
  };
}

/**
 * Diff two reports built from earlier and current snapshots.
 */
export function diffReports(previous, current, options = {}) {
  const minMove = Number.isFinite(Number(options.minMove)) ? Math.trunc(Number(options.minMove)) : 3;

  const prevMissed = new Map(previous.missed.map((r) => [normalizeQuery(r.query), r]));
  const currMissed = new Map(current.missed.map((r) => [normalizeQuery(r.query), r]));
  const prevShared = new Map(previous.shared.map((r) => [normalizeQuery(r.query), r]));
  const currShared = new Map(current.shared.map((r) => [normalizeQuery(r.query), r]));
  const prevMoat = new Map(previous.moat.map((r) => [normalizeQuery(r.query), r]));
  const currMoat = new Map(current.moat.map((r) => [normalizeQuery(r.query), r]));

  const newMissed = [];
  const expandedMissed = [];
  for (const [key, row] of currMissed.entries()) {
    const old = prevMissed.get(key);
    if (!old) {
      newMissed.push(row);
    } else if (row.rivalCount > old.rivalCount) {
      expandedMissed.push({
        query: row.query,
        previousRivalCount: old.rivalCount,
        rivalCount: row.rivalCount,
        bestRivalPosition: row.bestRivalPosition,
      });
    }
  }

  const closedGaps = [];
  for (const [key, old] of prevMissed.entries()) {
    if (currShared.has(key)) {
      const now = currShared.get(key);
      closedGaps.push({
        query: now.query,
        previousBestRival: old.bestRivalPosition,
        subjectPosition: now.subjectPosition,
        destination: 'shared',
      });
    } else if (currMoat.has(key)) {
      const now = currMoat.get(key);
      closedGaps.push({
        query: now.query,
        previousBestRival: old.bestRivalPosition,
        subjectPosition: now.subjectPosition,
        destination: 'moat',
      });
    }
  }

  const rankMoves = [];
  for (const [key, now] of currShared.entries()) {
    const old = prevShared.get(key);
    if (!old) continue;
    const change = old.subjectPosition - now.subjectPosition; // positive = improved (moved closer to #1)
    if (Math.abs(change) >= minMove) {
      rankMoves.push({
        query: now.query,
        previousPosition: old.subjectPosition,
        currentPosition: now.subjectPosition,
        change,
        bestRivalPosition: now.bestRivalPosition,
      });
    }
  }
  rankMoves.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.query.localeCompare(b.query));

  const lostMoat = [];
  for (const [key, old] of prevMoat.entries()) {
    if (!currMoat.has(key)) {
      lostMoat.push({
        query: old.query,
        previousPosition: old.subjectPosition,
        nowIn: currShared.has(key) ? 'shared' : currMissed.has(key) ? 'missed' : 'absent',
      });
    }
  }

  const lines = [];
  for (const g of closedGaps) {
    lines.push(`Gap closed: "${g.query}" — now #${g.subjectPosition} (${g.destination}, rival was #${g.previousBestRival})`);
  }
  for (const m of newMissed.slice(0, 15)) {
    lines.push(
      `New gap: "${m.query}" — ${m.rivalCount} rival${m.rivalCount === 1 ? '' : 's'} (best #${m.bestRivalPosition})`,
    );
  }
  if (newMissed.length > 15) {
    lines.push(`...and ${newMissed.length - 15} more new gap queries`);
  }
  for (const e of expandedMissed.slice(0, 10)) {
    lines.push(
      `More rivals on "${e.query}": ${e.previousRivalCount} -> ${e.rivalCount} rivals (best #${e.bestRivalPosition})`,
    );
  }
  for (const r of rankMoves.slice(0, 15)) {
    const dir = r.change > 0 ? `+${r.change}` : `${r.change}`;
    lines.push(
      `Shared move on "${r.query}": #${r.previousPosition} -> #${r.currentPosition} (${dir}; best rival #${r.bestRivalPosition})`,
    );
  }
  for (const l of lostMoat.slice(0, 10)) {
    lines.push(`Left your moat: "${l.query}" (was #${l.previousPosition}, now ${l.nowIn})`);
  }

  return {
    newMissed,
    expandedMissed,
    closedGaps,
    rankMoves,
    lostMoat,
    lines,
  };
}

function formatRivalsList(rivals) {
  return rivals.map((r) => `${r.name} (#${r.position})`).join(', ');
}

export function toMarkdown(report, changes = null, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.trunc(Number(options.limit)) : 25;
  const title = report.subject.name
    ? `${report.subject.name} (${report.subject.storeId})`
    : report.subject.storeId || 'Subject app';

  const lines = [];
  lines.push(`# ASO Keyword Gap Audit — ${title}`);
  lines.push('');
  lines.push(
    `Compared against **${report.summary.rivalCount}** rival${report.summary.rivalCount === 1 ? '' : 's'} on stored US English App Store search observations.`,
  );
  const filterNotes = [];
  if (report.filters.maxRank) filterNotes.push(`rank <= #${report.filters.maxRank}`);
  if (report.filters.minRivals > 1) filterNotes.push(`min ${report.filters.minRivals} rivals`);
  if (report.filters.asciiOnly) filterNotes.push('ASCII queries only');
  if (report.filters.search) filterNotes.push(`matching "${report.filters.search}"`);
  if (filterNotes.length) {
    lines.push(`Filters: ${filterNotes.join(' · ')}.`);
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Missed queries (only rivals): **${report.summary.missedCount}** (${report.summary.top10MissedCount} in top 10, ${report.summary.consensusMissedCount} held by 2+ rivals)`);
  lines.push(`- Shared queries (both): **${report.summary.sharedCount}** (${report.summary.strikingDistanceCount} striking-distance, ${report.summary.leadingCount} leading, ${report.summary.trailingCount} trailing)`);
  lines.push(`- Your moat (only this app): **${report.summary.moatCount}**`);
  lines.push('');

  lines.push('## Rivals compared');
  lines.push('');
  lines.push('| Rival | Store ID | Only rival | Top-10 gaps | Shared (W/L/T) | Only this app |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const r of report.rivals) {
    lines.push(
      `| ${r.name} | ${r.storeId} | ${r.onlyRivalCount} | ${r.top10Missed} | ${r.sharedCount} (${r.sharedWins}/${r.sharedLosses}/${r.sharedTies}) | ${r.onlySubjectCount} |`,
    );
  }
  lines.push('');

  if (changes) {
    lines.push('## Changes since earlier run');
    lines.push('');
    if (!changes.lines.length) {
      lines.push('- Nothing changed in the filtered stored observations.');
    } else {
      for (const line of changes.lines) {
        lines.push(`- ${line}`);
      }
    }
    lines.push('');
  }

  lines.push('## Missed keywords (only rivals)');
  lines.push('');
  if (!report.missed.length) {
    lines.push('Nothing they rank for that this app misses under the current filters.');
  } else {
    lines.push('| Query | Rivals | Best rival | Avg rival | Observed on |');
    lines.push('|---|---:|---:|---:|---|');
    for (const row of report.missed.slice(0, limit)) {
      lines.push(
        `| ${row.query} | ${row.rivalCount} | #${row.bestRivalPosition} | #${row.avgRivalPosition} | ${formatRivalsList(row.rivals)} |`,
      );
    }
    if (report.missed.length > limit) {
      lines.push('');
      lines.push(`Showing top ${limit} of ${report.missed.length} missed queries.`);
    }
  }
  lines.push('');

  lines.push('## Head-to-head (shared keywords)');
  lines.push('');
  if (!report.shared.length) {
    lines.push('No shared keywords under the current filters.');
  } else {
    lines.push('| Query | You | Best rival | Gap | Status | Rivals |');
    lines.push('|---|---:|---:|---:|---|---|');
    for (const row of report.shared.slice(0, limit)) {
      const gapText = row.delta > 0 ? `-${row.delta}` : row.delta < 0 ? `+${Math.abs(row.delta)}` : '0';
      const statusText = row.strikingDistance ? 'striking distance' : row.status;
      lines.push(
        `| ${row.query} | #${row.subjectPosition} | #${row.bestRivalPosition} | ${gapText} | ${statusText} | ${formatRivalsList(row.rivals)} |`,
      );
    }
    if (report.shared.length > limit) {
      lines.push('');
      lines.push(`Showing top ${limit} of ${report.shared.length} shared queries.`);
    }
  }
  lines.push('');

  lines.push('## Your moat (only this app)');
  lines.push('');
  if (!report.moat.length) {
    lines.push('Nothing this app ranks for alone under the current filters.');
  } else {
    lines.push('| Query | Your position |');
    lines.push('|---|---:|');
    for (const row of report.moat.slice(0, limit)) {
      lines.push(`| ${row.query} | #${row.subjectPosition} |`);
    }
    if (report.moat.length > limit) {
      lines.push('');
      lines.push(`Showing top ${limit} of ${report.moat.length} moat queries.`);
    }
  }
  lines.push('');
  lines.push(
    '_Source: stored US English App Store search observations from PeekPanda (https://peekpanda.com). Positions are observed search positions, not native App Store ranks or search volume._',
  );
  return lines.join('\n');
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(report) {
  const rows = [
    ['bucket', 'query', 'subject_position', 'rival_count', 'best_rival_position', 'delta', 'status', 'rivals'],
  ];

  for (const r of report.missed) {
    rows.push([
      'only_rival',
      r.query,
      '',
      r.rivalCount,
      r.bestRivalPosition,
      '',
      r.rivalCount >= 2 ? 'consensus_gap' : 'gap',
      formatRivalsList(r.rivals),
    ]);
  }

  for (const r of report.shared) {
    rows.push([
      'shared',
      r.query,
      r.subjectPosition,
      r.rivalCount,
      r.bestRivalPosition,
      r.delta,
      r.strikingDistance ? 'striking_distance' : r.status,
      formatRivalsList(r.rivals),
    ]);
  }

  for (const r of report.moat) {
    rows.push(['only_subject', r.query, r.subjectPosition, 0, '', '', 'moat', '']);
  }

  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function toWebhookText(report, changes = null) {
  const title = report.subject.name
    ? `${report.subject.name} (${report.subject.storeId})`
    : report.subject.storeId || 'Subject app';
  const lines = [
    `ASO Keyword Gap Audit — ${title}`,
    `${report.summary.rivalCount} rivals · ${report.summary.missedCount} missed (${report.summary.top10MissedCount} top-10, ${report.summary.consensusMissedCount} consensus) · ${report.summary.strikingDistanceCount} striking-distance · ${report.summary.moatCount} moat`,
  ];

  if (report.missed.length) {
    lines.push('');
    lines.push('Top missed gaps:');
    for (const row of report.missed.slice(0, 5)) {
      lines.push(`• "${row.query}" — ${row.rivalCount} rival(s), best #${row.bestRivalPosition}`);
    }
  }

  if (changes && changes.lines.length) {
    lines.push('');
    lines.push('Changes since last run:');
    for (const line of changes.lines.slice(0, 6)) {
      lines.push(`• ${line}`);
    }
  }

  return lines.join('\n');
}
