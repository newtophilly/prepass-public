#!/usr/bin/env node
/**
 * prepass against SWE-bench Lite — a benchmark nobody here wrote.
 *
 *     node bench/swebench.mjs --repos <dir> --data <file> [--limit N] [--json out]
 *
 * The labelled set in `eval-set.json` has an unavoidable flaw: the same person
 * wrote the queries, the ground-truth labels, and the glossary entries that hit
 * those labels. It is a regression test for one person's mental model. This is
 * the correction.
 *
 * Each SWE-bench instance supplies a real GitHub issue (`problem_statement`,
 * written by a stranger, in their own words) and the patch that actually fixed
 * it. The files that patch touches are the ground truth. Neither input nor
 * label is ours, and the repos are ones we have never opened.
 *
 * Retrieval only — no agent, no API calls, no cost. The question is narrow and
 * answerable: given a real bug report, does prepass's ranking put the file that
 * actually needed changing near the top?
 *
 * ⚠️ Checkout and rank happen together, per instance, on purpose. A faster
 * harness that prepares every instance first and ranks them all afterwards
 * produces wrong numbers: the candidate list is captured at the right commit,
 * but the ripgrep content pass reads the working tree *later*, when the repo
 * has moved on to whichever commit was prepared last. That bug made
 * scikit-learn look like it had collapsed from 78% to 39% when nothing had
 * happened to it. Do not "optimise" this loop by hoisting the checkouts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const { loadConfig } = await import(join(ROOT, 'dist/config.js'));
const { loadTaxonomies, detectIntent } = await import(join(ROOT, 'dist/core/intent-detector.js'));
const { runHeuristicStage } = await import(join(ROOT, 'dist/core/context-curator.js'));
const { scanRepo } = await import(join(ROOT, 'dist/core/file-scanner.js'));

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const REPOS = resolve(arg('--repos', ''));
const DATA = resolve(arg('--data', ''));
const LIMIT = Number(arg('--limit', '0')) || Infinity;
const OUT = arg('--json', '');
/** Emit this many candidates regardless of taxonomy, so recall@k is comparable. */
const K = Number(arg('--k', '20'));
/**
 * Override ranking constants without touching any config file.
 *
 * `loadConfig(dir)` reads `.prepass.json` from the *repository under test*, not
 * from this project — so a sweep that writes a config here silently changes
 * nothing and reports the default numbers eight times over. Ask me how I know.
 *
 *     --tune '{"dirWithBasename":0.5}'
 */
const TUNE = JSON.parse(arg('--tune', '{}'));

/** Files a gold patch touches — the ground truth, straight from the fix. */
function patchedFiles(patch) {
  const out = new Set();
  for (const m of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) out.add(m[2]);
  return [...out];
}

/**
 * Defaults only — deliberately loaded from a directory with no config in it, so
 * the run cannot inherit settings from whatever happens to be on this machine
 * or in the repositories being scored.
 */
const BASELINE = loadConfig(HERE);

const instances = JSON.parse(readFileSync(DATA, 'utf8'));
const localName = (repo) => repo.split('/')[1];

const results = [];
let skipped = 0;

for (const inst of instances) {
  if (results.length >= LIMIT) break;
  const dir = join(REPOS, localName(inst.repo));
  if (!existsSync(dir)) { skipped++; continue; }

  // The repo must be at the commit the issue was filed against, or the file
  // that needed fixing may not exist in the form the report describes.
  try {
    execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--force', inst.base_commit], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    skipped++;
    continue;
  }

  const gold = patchedFiles(inst.patch).filter((f) => existsSync(join(dir, f)));
  if (gold.length === 0) { skipped++; continue; }

  // Pin the configuration. `loadConfig(dir)` would read `.prepass.json` from
  // the repository *under test* — so a stray config in any checkout (someone
  // ran `prepass init` in it once) would silently change published numbers and
  // nothing would say so. A benchmark has to control its own inputs. `--tune`
  // is the only way to vary them, and it is recorded in the output.
  // --tune keys are routed to the right level: BM25 constants live under
  // curation.bm25, everything else (proseWeight, testWeight, recencyWeight)
  // directly on curation. Merging blindly into bm25 silently dropped
  // curation-level keys and reported the baseline once per configuration —
  // the second time that has cost a sweep.
  const BM25_KEYS = new Set(Object.keys(BASELINE.config.curation.bm25));
  const tuneBm25 = {}, tuneCuration = {};
  for (const [k, v] of Object.entries(TUNE)) {
    if (BM25_KEYS.has(k)) tuneBm25[k] = v;
    else if (k in BASELINE.config.curation) tuneCuration[k] = v;
    else throw new Error(`--tune: unknown key "${k}"`);
  }
  const config = {
    ...BASELINE.config,
    curation: {
      ...BASELINE.config.curation,
      minFiles: 0,
      ...tuneCuration,
      bm25: { ...BASELINE.config.curation.bm25, ...tuneBm25 },
    },
  };
  const taxonomies = loadTaxonomies(config);
  const intent = detectIntent(inst.problem_statement, taxonomies, config);
  const taxonomy = {
    ...taxonomies.get(intent.workload),
    curationStrategy: {
      ...taxonomies.get(intent.workload).curationStrategy,
      maxFiles: K,
    },
  };

  const scan = scanRepo(dir, config);
  const candidates = scan.candidates;
  // Separate "ranked it badly" from "never saw it": the pool is capped, so on a
  // repo larger than the cap a gold file can be dropped before scoring runs.
  const inPool = gold.filter((g) => candidates.some((c) => c.path === g)).length;
  const t0 = Date.now();
  // No glossary: these are repos we have never seen, which is the point.
  const ranked = runHeuristicStage(
    { prompt: inst.problem_statement, candidates, taxonomy, rootDir: dir },
    config,
  );
  const ms = Date.now() - t0;

  const paths = ranked.map((r) => r.path);
  const hits = gold.map((g) => ({ file: g, rank: paths.indexOf(g) + 1 || null }));
  const found = hits.filter((h) => h.rank !== null);
  const best = found.length ? Math.min(...found.map((h) => h.rank)) : null;

  results.push({
    id: inst.instance_id,
    repo: inst.repo,
    pool: candidates.length,
    workload: intent.workload,
    gold: gold.length,
    goldInPool: inPool,
    truncated: scan.truncated,
    foundInK: found.length,
    firstHit: best,
    ms,
    hits,
    // The whole shortlist, not just the parts that were right.
    //
    // The largest single gain this project ever made — discounting in-repo
    // prose, MRR 0.383 -> 0.475 — came from looking at what was *occupying*
    // the top 20 rather than at whether the answer was in it. Recording only
    // the gold ranks throws that evidence away every run.
    shortlist: paths.slice(0, K),
    goldPaths: gold,
  });
  process.stderr.write(
    `${results.length}. ${inst.instance_id} pool=${candidates.length} ` +
      `first=${best ?? 'MISS'} ${ms}ms\n`,
  );
}

const n = results.length;
const at = (k) => results.filter((r) => r.firstHit && r.firstHit <= k).length / n;
const mrr = results.reduce((s, r) => s + (r.firstHit ? 1 / r.firstHit : 0), 0) / n;
const recall = results.reduce((s, r) => s + r.foundInK / r.gold, 0) / n;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`\n${'='.repeat(64)}`);
console.log(`SWE-bench Lite — retrieval only, ${n} instances (${skipped} skipped), k=${K}`);
console.log('='.repeat(64));
console.log(`  hit@1      ${(at(1) * 100).toFixed(1)}%   the right file ranked first`);
console.log(`  hit@3      ${(at(3) * 100).toFixed(1)}%`);
console.log(`  hit@5      ${(at(5) * 100).toFixed(1)}%`);
console.log(`  hit@10     ${(at(10) * 100).toFixed(1)}%`);
console.log(`  hit@${String(K).padEnd(2)}     ${(at(K) * 100).toFixed(1)}%   found it anywhere in the shortlist`);
console.log(`  recall@${String(K).padEnd(2)}  ${(recall * 100).toFixed(1)}%   of all gold files, averaged per instance`);
console.log(`  MRR        ${mrr.toFixed(3)}`);
const poolOk = results.reduce((s, r) => s + r.goldInPool / r.gold, 0) / n;
const trunc = results.filter((r) => r.truncated).length;
console.log(`  gold in pool ${(poolOk * 100).toFixed(1)}%   (${trunc}/${n} repos hit the file cap — a miss below this line is a ranking failure, above it the file was never scored)`);
console.log(`  median     ${med(results.map((r) => r.ms))}ms   over a median pool of ${med(results.map((r) => r.pool))} files`);
console.log('='.repeat(64));

const byRepo = {};
for (const r of results) (byRepo[r.repo] ??= []).push(r);
console.log('\nby repo:');
for (const [repo, rs] of Object.entries(byRepo)) {
  const h1 = rs.filter((r) => r.firstHit === 1).length / rs.length;
  const hk = rs.filter((r) => r.firstHit).length / rs.length;
  console.log(
    `  ${repo.padEnd(26)} n=${String(rs.length).padStart(3)}  ` +
      `hit@1 ${(h1 * 100).toFixed(0).padStart(3)}%  hit@${K} ${(hk * 100).toFixed(0).padStart(3)}%`,
  );
}
console.log();

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ k: K, n, skipped, results }, null, 2));
  console.log(`raw → ${OUT}\n`);
}
