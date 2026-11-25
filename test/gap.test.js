import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildReport,
  diffReports,
  extractPayloads,
  normalizeGapPayload,
  toCsv,
  toMarkdown,
  toWebhookText,
} from '../gap.js';

const loadJson = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), 'utf8'));

test('normalizeGapPayload validates required fields and strips malformed rows', () => {
  assert.throws(() => normalizeGapPayload(null), /JSON object/);
  assert.throws(() => normalizeGapPayload({}), /rivalStoreId/);

  const out = normalizeGapPayload({
    subjectStoreId: '100',
    rivalStoreId: '200',
    rivalName: 'Rival One',
    onlyRival: [
      { query: 'meal planner', rivalPosition: 3 },
      { query: '', rivalPosition: 1 },
      { query: 'bad rank', rivalPosition: 0 },
    ],
    onlySubject: [{ query: 'my niche', subjectPosition: 2 }],
    shared: [{ query: 'recipe app', subjectPosition: 9, rivalPosition: 4 }],
  });

  assert.equal(out.onlyRival.length, 1);
  assert.equal(out.onlySubject.length, 1);
  assert.equal(out.shared.length, 1);
});

test('buildReport aggregates multi-rival consensus gaps, shared striking distance, and moat', async () => {
  const run = await loadJson('../examples/run.json');
  const payloads = extractPayloads(run);
  const report = buildReport(payloads, { maxRank: 25, subjectName: run.subject.name });

  assert.equal(report.summary.rivalCount, 2);
  // meal planner and grocery list are held by both rivals
  assert.equal(report.summary.consensusMissedCount, 2);
  assert.equal(report.missed[0].query, 'meal planner');
  assert.equal(report.missed[0].rivalCount, 2);
  assert.equal(report.missed[0].bestRivalPosition, 3);
  assert.equal(report.missed[0].avgRivalPosition, 4.5);

  // batch cooking (#38) is filtered out by maxRank: 25
  assert.equal(
    report.missed.some((r) => r.query === 'batch cooking'),
    false,
  );

  // recipe keeper (#8 vs #2 -> delta 6) and dinner ideas (#11 vs #6 -> delta 5) are striking distance
  const striking = report.shared.filter((r) => r.strikingDistance).map((r) => r.query);
  assert.deepEqual(striking, ['recipe keeper', 'dinner ideas']);

  // cooking organizer (#5 vs #12) is leading
  const leading = report.shared.find((r) => r.query === 'cooking organizer');
  assert.equal(leading.status, 'leading');
  assert.equal(leading.delta, -7);

  // moat contains queries present only on subject across all rivals
  assert.deepEqual(
    report.moat.map((r) => r.query),
    ['leftover recipe finder', 'fridge to meal'],
  );
});

test('buildReport respects minRivals, asciiOnly, and search filters', () => {
  const report = buildReport(
    [
      {
        subjectStoreId: '100',
        rivalStoreId: '200',
        rivalName: 'Rival A',
        onlyRival: [
          { query: 'meal prep', rivalPosition: 4 },
          { query: '한식 레시피', rivalPosition: 5 },
        ],
        onlySubject: [],
        shared: [],
      },
      {
        subjectStoreId: '100',
        rivalStoreId: '201',
        rivalName: 'Rival B',
        onlyRival: [{ query: 'meal prep', rivalPosition: 9 }],
        onlySubject: [],
        shared: [],
      },
    ],
    { minRivals: 2, asciiOnly: true, search: 'meal' },
  );

  assert.equal(report.missed.length, 1);
  assert.equal(report.missed[0].query, 'meal prep');
});

test('diffReports detects closed gaps, new gaps, expanded consensus, rank moves, and lost moat', async () => {
  const prev = await loadJson('../examples/previous-run.json');
  const curr = await loadJson('../examples/run.json');

  const prevReport = buildReport(extractPayloads(prev), { maxRank: 25, subjectName: prev.subject.name });
  const currReport = buildReport(extractPayloads(curr), { maxRank: 25, subjectName: curr.subject.name });
  const changes = diffReports(prevReport, currReport, { minMove: 3 });

  // cooking organizer moved from onlyRival to shared
  assert.equal(
    changes.closedGaps.some((g) => g.query === 'cooking organizer' && g.destination === 'shared'),
    true,
  );
  // weekly meal prep and healthy dinner recipes are new missed gaps
  assert.equal(
    changes.newMissed.some((g) => g.query === 'weekly meal prep'),
    true,
  );
  // meal planner grew from 1 rival to 2 rivals
  assert.equal(
    changes.expandedMissed.some((e) => e.query === 'meal planner' && e.previousRivalCount === 1 && e.rivalCount === 2),
    true,
  );
  // recipe keeper jumped from #14 to #8 (+6)
  assert.equal(
    changes.rankMoves.some((m) => m.query === 'recipe keeper' && m.change === 6),
    true,
  );
  // zero waste recipes left the moat
  assert.equal(
    changes.lostMoat.some((l) => l.query === 'zero waste recipes'),
    true,
  );
});

test('formatters emit valid Markdown, CSV, and webhook summary', async () => {
  const prev = await loadJson('../examples/previous-run.json');
  const curr = await loadJson('../examples/run.json');
  const prevReport = buildReport(extractPayloads(prev), { maxRank: 25, subjectName: prev.subject.name });
  const currReport = buildReport(extractPayloads(curr), { maxRank: 25, subjectName: curr.subject.name });
  const changes = diffReports(prevReport, currReport);

  const md = toMarkdown(currReport, changes);
  assert.match(md, /# ASO Keyword Gap Audit — Example Meal Prep/);
  assert.match(md, /Gap closed: "cooking organizer"/);
  assert.match(md, /https:\/\/peekpanda\.com/);

  const csv = toCsv(currReport);
  assert.match(csv, /^bucket,query,subject_position,rival_count,best_rival_position,delta,status,rivals/m);
  assert.match(csv, /only_rival,meal planner,,2,3,,consensus_gap/);

  const hook = toWebhookText(currReport, changes);
  assert.match(hook, /ASO Keyword Gap Audit/);
  assert.match(hook, /Top missed gaps:/);
});
