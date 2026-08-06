/**
 * Bake-off: local dense embeddings vs prepass's BM25F, on SWE-bench Lite.
 *
 * The claim under test, from an outside review: a small local embedding model
 * handles natural-language-to-code retrieval "out of the box" where a lexical
 * ranker needs a hand-maintained glossary, and the honest comparison is
 * "manual lexical glossary vs compact local vector matcher" rather than
 * "lexical vs a full chunked-code vector database".
 *
 * So this embeds only file PATHS — the reviewer's own suggestion — which keeps
 * the index tiny and updatable, and is the strongest cheap form of the idea.
 * Same 240 instances, same metrics, same k. Costs are reported honestly:
 * dependency size, one-off index time, and per-query latency, not just the
 * last of those.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@xenova/transformers';

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

// Resolve relative to this file so the bake-off runs from any clone.
// --work holds the model cache and the SWE-bench checkouts; it can be large.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = arg('--work', join(ROOT, '.bakeoff'));
env.cacheDir = join(S, 'bakeoff', 'models');
mkdirSync(env.cacheDir, { recursive: true });

const { loadConfig } = await import(join(ROOT, 'dist/config.js'));
const { loadTaxonomies, detectIntent } = await import(join(ROOT, 'dist/core/intent-detector.js'));
const { runHeuristicStage } = await import(join(ROOT, 'dist/core/context-curator.js'));
const { scanRepo } = await import(join(ROOT, 'dist/core/file-scanner.js'));

const K = 20;
const goldOf = (p) => [...new Set([...p.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[2]))];

console.error('loading all-MiniLM-L6-v2 …');
const t0 = Date.now();
const embed = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
console.error(`model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const vec = async (text) => {
  const o = await embed(text, { pooling: 'mean', normalize: true });
  return o.data;
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** A path is not a sentence; give the model words rather than punctuation. */
const pathToText = (p) =>
  p.replace(/[\/_\-.]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

const instances = JSON.parse(readFileSync(join(S, 'swebench-lite.json'), 'utf8'));
const pathCache = new Map();
let indexTimeMs = 0;
let embeddedPaths = 0;

const rows = [];
for (const inst of instances) {
  const dir = join(S, 'swebench-repos', inst.repo.split('/')[1]);
  if (!existsSync(dir)) continue;
  try {
    execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--force', inst.base_commit], {
      stdio: 'ignore', timeout: 120_000,
    });
  } catch { continue; }
  const gold = goldOf(inst.patch).filter((f) => existsSync(join(dir, f)));
  if (gold.length === 0) continue;

  const cfg = loadConfig(dir).config;
  const tax = loadTaxonomies(cfg);
  const intent = detectIntent(inst.problem_statement, tax, cfg);
  const taxonomy = {
    ...tax.get(intent.workload),
    curationStrategy: { ...tax.get(intent.workload).curationStrategy, maxFiles: K },
  };
  const candidates = scanRepo(dir, cfg).candidates;

  // ---- lexical ----
  const lt = Date.now();
  const lex = runHeuristicStage(
    { prompt: inst.problem_statement, candidates, taxonomy, rootDir: dir },
    { ...cfg, curation: { ...cfg.curation, minFiles: 0 } },
  ).map((r) => r.path);
  const lexMs = Date.now() - lt;

  // ---- dense over paths ----
  const it = Date.now();
  const missing = candidates.filter((c) => !pathCache.has(c.path));
  for (const c of missing) {
    pathCache.set(c.path, await vec(pathToText(c.path)));
    embeddedPaths++;
  }
  indexTimeMs += Date.now() - it;

  const qt = Date.now();
  // MiniLM truncates at 256 tokens; a GitHub issue is far longer, so give it
  // the opening, which is where the reporter states the problem.
  const q = await vec(inst.problem_statement.slice(0, 1200));
  const dense = candidates
    .map((c) => ({ path: c.path, s: dot(q, pathCache.get(c.path)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, K)
    .map((r) => r.path);
  const denseMs = Date.now() - qt;

  // ---- hybrid: reciprocal rank fusion ----
  const rrf = new Map();
  const add = (list, w) => list.forEach((p, i) => rrf.set(p, (rrf.get(p) ?? 0) + w / (60 + i + 1)));
  add(lex, 1); add(dense, 1);
  const hybrid = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map(([p]) => p);

  const rank = (list) => {
    const rs = gold.map((g) => list.indexOf(g) + 1).filter((r) => r > 0);
    return rs.length ? Math.min(...rs) : null;
  };
  rows.push({
    id: inst.instance_id, repo: inst.repo,
    lex: rank(lex), dense: rank(dense), hybrid: rank(hybrid),
    lexMs, denseMs,
  });
  if (rows.length % 20 === 0) console.error(`${rows.length} … (${embeddedPaths} paths embedded)`);
}

const n = rows.length;
const stat = (key) => {
  const at = (k) => rows.filter((r) => r[key] && r[key] <= k).length / n;
  return {
    h1: at(1), h5: at(5), h20: at(K),
    mrr: rows.reduce((s, r) => s + (r[key] ? 1 / r[key] : 0), 0) / n,
  };
};
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`\n${'='.repeat(72)}`);
console.log(`BAKE-OFF — ${n} SWE-bench Lite instances, k=${K}`);
console.log('='.repeat(72));
console.log(`  method            hit@1   hit@5  hit@20     MRR   median query`);
for (const [label, key, ms] of [
  ['BM25F (prepass)', 'lex', med(rows.map((r) => r.lexMs))],
  ['dense paths', 'dense', med(rows.map((r) => r.denseMs))],
  ['hybrid (RRF)', 'hybrid', med(rows.map((r) => r.lexMs + r.denseMs))],
]) {
  const s = stat(key);
  console.log(
    `  ${label.padEnd(18)}${(s.h1 * 100).toFixed(1).padStart(6)}%${(s.h5 * 100).toFixed(1).padStart(7)}%` +
      `${(s.h20 * 100).toFixed(1).padStart(7)}%${s.mrr.toFixed(3).padStart(8)}${(ms + 'ms').padStart(14)}`,
  );
}
console.log('='.repeat(72));
console.log(`\nCosts the query-latency column hides:`);
console.log(`  paths embedded            ${embeddedPaths}`);
console.log(`  one-off index time        ${(indexTimeMs / 1000).toFixed(1)}s  (${(indexTimeMs / Math.max(embeddedPaths, 1)).toFixed(1)}ms per path)`);
console.log(`  dependency                @xenova/transformers, 259 MB node_modules + model download`);
console.log(`  prepass today              3 runtime deps, no model, no index\n`);

writeFileSync(join(S, 'bakeoff', 'results.json'), JSON.stringify({ n, rows }, null, 2));
