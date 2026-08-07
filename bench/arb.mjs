#!/usr/bin/env node
/**
 * prepass on Agent Retrieval Bench — an external benchmark this project had no
 * hand in building.
 *
 *     ARB_ROOT=/path/to/arb node bench/arb.mjs [--task trace2code] [--limit N]
 *
 * Results: bench/arb-2026-08-06.md
 *
 * ## Why this is worth running
 *
 * Every other number in bench/ comes from a harness written here, against
 * SWE-bench, whose task is "find the file the fix edits". ARB asks three
 * different questions, ships hand-picked hard negatives, and publishes
 * baselines for a lexical retriever, RepoMap and five embedding models up to
 * 8B parameters — so the scoreboard is someone else's.
 *
 *   trace2code       failing test output  -> root-cause source   (prepass: 1st of 8)
 *   comment2context  review comment       -> supporting context  (prepass: 4th of 8)
 *   code2test        code change          -> the tests to update (prepass: 7th of 8)
 *
 * ## Fairness
 *
 * Candidates come from the benchmark's own corpus snapshots rather than repos
 * cloned here, so prepass ranks exactly the file set their baselines ranked.
 * Ranking goes through the real `runHeuristicStage` — the same code path the
 * hook uses — rather than a reimplementation that might flatter us.
 *
 * Their metric is Recall@k, not hit@k, because gold averages 1.45 files.
 * Reported both ways so nothing is cherry-picked.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const { loadConfig } = await import(join(ROOT, 'dist/config.js'));
const { runHeuristicStage } = await import(join(ROOT, 'dist/core/context-curator.js'));

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ARB = resolve(arg('--root', process.env.ARB_ROOT ?? ''));
const ONLY = arg('--task', '');
const LIMIT = Number(arg('--limit', '0')) || Infinity;
const K = 20;

if (!arg('--root', process.env.ARB_ROOT ?? '')) {
  console.error('usage: ARB_ROOT=<extracted ARB release> node bench/arb.mjs [--task T] [--limit N]');
  process.exit(2);
}

const BENCH = join(ARB, 'benchmark/agent_retrieval_bench/samples.jsonl');
const CORPUS = join(ARB, 'corpus/agent_retrieval_bench');
const samples = readFileSync(BENCH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** Their corpus is chunked; rebuild whole-file text so a file ranker sees files. */
function snapshotFiles(repo, commit) {
  const path = join(CORPUS, repo.replace('/', '__'), `${commit}.chunks.jsonl`);
  if (!existsSync(path)) return null;
  const byPath = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const c = JSON.parse(line);
    if (!c.path) continue;
    const cur = byPath.get(c.path);
    // `kind: file` chunks hold the whole file; otherwise stitch symbol chunks.
    if (c.kind === 'file') byPath.set(c.path, c.text ?? '');
    else byPath.set(c.path, (cur ?? '') + '\n' + (c.text ?? ''));
  }
  return byPath;
}

/** The query text an agent would actually be holding, per task. */
function queryText(s) {
  const q = s.query;
  if (s.task_type === 'code2test')
    return [q.pr_title, q.pr_body, q.changed_file].filter(Boolean).join('\n');
  if (s.task_type === 'comment2context')
    return [q.pr_title, q.review_comment, q.diff_hunk_context, q.given_file].filter(Boolean).join('\n');
  if (s.task_type === 'trace2code')
    return [q.command, q.failure_excerpt].filter(Boolean).join('\n');
  return JSON.stringify(q);
}

/**
 * Gold comes from the benchmark's OWN published eval details, keyed by sample
 * id — the identical answer key their baselines were scored against.
 *
 * Deriving it from `gold_blocks` instead looked right and was wrong on 22 of
 * 287 samples: blocks are a SUBSET of `gold_files`, so recall was computed
 * against an incomplete key and came out inflated. Never re-derive a label the
 * benchmark already publishes.
 */
const GOLD = new Map();
for (const line of readFileSync(
  join(ARB, 'eval/agent_retrieval_bench/lexical_all_files_details.jsonl'), 'utf8',
).split('\n')) {
  if (!line) continue;
  const d = JSON.parse(line);
  GOLD.set(d.sample_id, [...new Set(d.gold_files ?? [])]);
}

const work = join(tmpdir(), 'arb-prepass');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const { config } = loadConfig(ROOT);
const taxonomy = {
  workload: 'search',
  displayName: 'ARB',
  keywords: [], weightedKeywords: {}, antiKeywords: [],
  curationStrategy: { maxFiles: K, includeGlobs: [], excludeGlobs: [], prioritySignals: [] },
  routing: { defaultTier: 'balanced', escalateTier: 'premium', escalateWhen: [] },
};

const results = [];
let skipped = 0;
let lastKey = '';
let lastDir = '';

for (const s of samples) {
  if (ONLY && s.task_type !== ONLY) continue;
  if (results.length >= LIMIT) break;

  const gold = GOLD.get(s.id) ?? [];
  if (gold.length === 0) { skipped++; continue; }

  // Samples are grouped by snapshot, so materialise each repo@commit once.
  const key = `${s.repo}@${s.base_commit}`;
  if (key !== lastKey) {
    const files = snapshotFiles(s.repo, s.base_commit);
    if (!files) { skipped++; continue; }
    rmSync(lastDir, { recursive: true, force: true });
    lastDir = join(work, String(results.length));
    for (const [p, text] of files) {
      const abs = join(lastDir, p);
      try { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text ?? ''); } catch {}
    }
    lastKey = key;
  }

  const candidates = [];
  const walk = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else { try { candidates.push({ path: r, bytes: readFileSync(p).length, score: 0 }); } catch {} }
    }
  };
  walk(lastDir);
  if (candidates.length === 0) { skipped++; continue; }

  const t0 = Date.now();
  const ranked = runHeuristicStage(
    { prompt: queryText(s), candidates, taxonomy, rootDir: lastDir, glossary: {} },
    { ...config, curation: { ...config.curation, minFiles: 0 } },
  );
  const ms = Date.now() - t0;

  const paths = ranked.map((c) => c.path);
  const ranks = gold.map((g) => paths.indexOf(g) + 1 || null).filter(Boolean);
  results.push({
    id: s.id, repo: s.repo, task: s.task_type,
    pool: candidates.length, gold: gold.length,
    firstHit: ranks.length ? Math.min(...ranks) : null,
    foundAt: { 5: ranks.filter((r) => r <= 5).length, 10: ranks.filter((r) => r <= 10).length, 20: ranks.length },
    ms,
  });
  if (results.length % 20 === 0) process.stderr.write(`  ${results.length} scored\n`);
}
rmSync(work, { recursive: true, force: true });

function report(rows, label) {
  if (!rows.length) return;
  const n = rows.length;
  const recall = (k) => rows.reduce((s, r) => s + r.foundAt[k] / r.gold, 0) / n;
  const hit = (k) => rows.filter((r) => r.firstHit && r.firstHit <= k).length / n;
  const mrr = rows.reduce((s, r) => s + (r.firstHit ? 1 / r.firstHit : 0), 0) / n;
  const med = rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(n / 2)];
  console.log(
    `  ${label.padEnd(18)} n=${String(n).padStart(3)}  ` +
    `Recall@5 ${recall(5).toFixed(3)}  Recall@10 ${recall(10).toFixed(3)}  Recall@20 ${recall(20).toFixed(3)}  ` +
    `MRR ${mrr.toFixed(3)}  hit@20 ${(hit(20) * 100).toFixed(1)}%  ${med}ms`,
  );
}

console.log(`\nprepass on Agent Retrieval Bench  (${results.length} scored, ${skipped} skipped)\n`);
for (const t of ['code2test', 'comment2context', 'trace2code'])
  report(results.filter((r) => r.task === t), t);
report(results, 'ALL');
writeFileSync(join(HERE, 'arb-results.json'), JSON.stringify({ results }, null, 1));
console.log(`\nraw -> bench/arb-results.json`);
