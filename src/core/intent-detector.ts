/**
 * Intent detection: classify a prompt into a `Workload` via weighted keyword
 * matching against the loaded taxonomies, with a normalized confidence score.
 *
 * The detector is intentionally deterministic and dependency-free (no LLM call)
 * so it is fast, testable, and cheap to run on every invocation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { IntentResult, Taxonomy, Workload, WorkloadScore } from '../types.js';
import type { SmartConfig } from '../schemas/config.js';
import { log } from './telemetry.js';

const WORKLOADS: readonly Workload[] = ['bugfix', 'feature', 'refactor', 'search', 'review'];

/** Runtime validation for taxonomy files — malformed files fail loudly. */
const taxonomySchema = z.object({
  workload: z.enum(['bugfix', 'feature', 'refactor', 'search', 'review']),
  displayName: z.string(),
  keywords: z.array(z.string()).default([]),
  weightedKeywords: z.record(z.string(), z.number()).default({}),
  antiKeywords: z.array(z.string()).default([]),
  curationStrategy: z.object({
    maxFiles: z.number().int().positive(),
    includeGlobs: z.array(z.string()).default([]),
    excludeGlobs: z.array(z.string()).default([]),
    prioritySignals: z.array(z.string()).default([]),
  }),
  routing: z.object({
    defaultTier: z.enum(['cheap', 'balanced', 'premium']),
    escalateTier: z.enum(['cheap', 'balanced', 'premium']),
    escalateWhen: z.array(z.string()).default([]),
  }),
});

/**
 * Load every built-in taxonomy plus any custom ones. Missing or malformed files
 * are logged and skipped rather than aborting the run — a broken custom
 * taxonomy shouldn't disable the whole tool.
 */
export function loadTaxonomies(config: SmartConfig): Map<Workload, Taxonomy> {
  const map = new Map<Workload, Taxonomy>();

  const readInto = (dir: string): void => {
    for (const w of WORKLOADS) {
      if (map.has(w)) continue;
      const tax = tryReadTaxonomy(join(dir, `${w}.json`));
      if (tax) map.set(tax.workload, tax);
    }
  };

  readInto(config.taxonomies.dir);

  // Fall back to the taxonomies shipped inside the package. Without this, any
  // install running outside this repo finds nothing, classifies everything as
  // the default workload at confidence 0, and — because low confidence trips
  // the escalation rule — routes every request to the *premium* model. A
  // cost-curation tool must never fail that direction.
  const packaged = packagedTaxonomiesDir();
  if (map.size < WORKLOADS.length && packaged && packaged !== config.taxonomies.dir) {
    readInto(packaged);
  }

  for (const path of config.taxonomies.custom) {
    const tax = tryReadTaxonomy(path);
    if (tax) map.set(tax.workload, tax); // custom overrides built-in
  }

  if (map.size === 0) {
    log('warn', 'intent.no_taxonomies', { dir: config.taxonomies.dir, packaged });
  }
  return map;
}

/**
 * The `taxonomies/` directory bundled with the installed package, located
 * relative to this module rather than the user's cwd.
 *
 * Walks up to the nearest ancestor holding a `package.json` rather than
 * assuming a fixed depth, so it resolves correctly from `dist/core/` when
 * installed and from `dist-test/src/core/` under test.
 */
function packagedTaxonomiesDir(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      if (existsSync(join(dir, 'package.json'))) return resolve(dir, 'taxonomies');
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

function tryReadTaxonomy(path: string): Taxonomy | null {
  try {
    const parsed = taxonomySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      log('warn', 'intent.taxonomy_invalid', { path, issues: parsed.error.issues.length });
      return null;
    }
    return parsed.data as Taxonomy;
  } catch (err) {
    log('debug', 'intent.taxonomy_skipped', { path, error: String(err) });
    return null;
  }
}

/**
 * Score a prompt against every taxonomy and pick the strongest workload.
 * Confidence is the winner's share of total score, so a runaway leader scores
 * near 1.0 and an even split scores near 1/N.
 */
export function detectIntent(
  prompt: string,
  taxonomies: Map<Workload, Taxonomy>,
  config: SmartConfig,
): IntentResult {
  const haystack = tokenize(prompt);
  const matched = new Set<string>();

  const scored: WorkloadScore[] = [];
  for (const [workload, tax] of taxonomies) {
    const { score, hits } = scoreTaxonomy(haystack, tax);
    for (const h of hits) matched.add(h);
    scored.push({ workload, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const total = scored.reduce((sum, s) => sum + Math.max(0, s.score), 0);
  const top = scored[0];
  const rawConfidence = top && total > 0 ? Math.max(0, top.score) / total : 0;

  // `top &&` re-narrows for the compiler: a bare `meetsThreshold` boolean does
  // not carry the `top !== undefined` fact into `top.workload` below.
  const meetsThreshold = top !== undefined && rawConfidence >= config.routing.confidenceThreshold;
  const workload = meetsThreshold && top ? top.workload : config.routing.defaultWorkload;

  return {
    workload,
    confidence: round(rawConfidence),
    ranked: scored,
    matchedKeywords: [...matched],
    fellBackToDefault: !meetsThreshold,
  };
}

/** Score one taxonomy: weighted keyword hits minus anti-keyword penalties. */
function scoreTaxonomy(
  tokens: ReadonlySet<string>,
  tax: Taxonomy,
): { score: number; hits: string[] } {
  const hits: string[] = [];
  let score = 0;

  for (const kw of tax.keywords) {
    if (containsPhrase(tokens, kw)) {
      score += 1;
      hits.push(kw);
    }
  }
  for (const [kw, weight] of Object.entries(tax.weightedKeywords)) {
    if (containsPhrase(tokens, kw)) {
      score += weight;
      hits.push(kw);
    }
  }
  for (const kw of tax.antiKeywords) {
    if (containsPhrase(tokens, kw)) score -= 1.5;
  }

  return { score, hits };
}

/** Lowercase word set — cheap containment checks without regex per keyword. */
function tokenize(prompt: string): Set<string> {
  return new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** Match single words directly; multi-word phrases require all parts present. */
function containsPhrase(tokens: ReadonlySet<string>, keyword: string): boolean {
  const parts = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => tokens.has(p));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
