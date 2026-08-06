/**
 * Unit stubs for the intent detector.
 *
 * These are scaffold-level tests: they exercise the public API and lock in the
 * core invariants (confidence bounds, anti-keyword penalties, default fallback).
 * Flesh out the assertions as the taxonomies stabilize.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, loadTaxonomies } from '../../src/core/intent-detector.js';
import { configSchema } from '../../src/schemas/config.js';
import type { Taxonomy, Workload } from '../../src/types.js';

const config = configSchema.parse({});

function fakeTaxonomy(workload: Workload, keywords: string[]): Taxonomy {
  return {
    workload,
    displayName: workload,
    keywords,
    weightedKeywords: {},
    antiKeywords: [],
    curationStrategy: {
      maxFiles: 5,
      includeGlobs: [],
      excludeGlobs: [],
      prioritySignals: [],
    },
    routing: { defaultTier: 'balanced', escalateTier: 'premium', escalateWhen: [] },
  };
}

test('classifies an obvious bugfix prompt', () => {
  const tax = new Map<Workload, Taxonomy>([
    ['bugfix', fakeTaxonomy('bugfix', ['bug', 'crash', 'error'])],
    ['feature', fakeTaxonomy('feature', ['add', 'implement'])],
  ]);
  const result = detectIntent('the app crashes with a null error', tax, config);
  assert.equal(result.workload, 'bugfix', 'an explicit bug report should not classify as anything else');
  assert.ok(
    result.confidence > 0 && result.confidence <= 1,
    'a matched workload must carry non-zero confidence',
  );
  assert.equal(result.fellBackToDefault, false, 'a confident match must not be reported as a fallback');
});

test('falls back to the default workload below threshold', () => {
  const tax = new Map<Workload, Taxonomy>([['bugfix', fakeTaxonomy('bugfix', ['bug'])]]);
  const result = detectIntent('completely unrelated text', tax, config);
  assert.equal(result.workload, config.routing.defaultWorkload);
  assert.equal(result.fellBackToDefault, true, 'below threshold the fallback must be visible to the caller');
  assert.equal(result.confidence, 0, 'a fallback must report zero confidence, not a fabricated score');
});

test('confidence is always within [0, 1]', () => {
  const tax = new Map<Workload, Taxonomy>([
    ['bugfix', fakeTaxonomy('bugfix', ['bug', 'error', 'crash', 'fails'])],
  ]);
  const result = detectIntent('bug error crash fails', tax, config);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

// TODO: cover weightedKeywords, antiKeyword penalties, and multi-word phrases.

/**
 * Regression: an install running outside this repo has no `taxonomies/` in the
 * user's cwd. Before the packaged-dir fallback, that produced zero taxonomies,
 * confidence 0, and — via the low-confidence escalation rule — routed every
 * request to the premium model. A cost-curation tool must not fail that way.
 */
test('falls back to packaged taxonomies when the configured dir is missing', () => {
  const cfg = configSchema.parse({
    taxonomies: { dir: '/nonexistent/definitely/not/here', custom: [] },
  });
  const loaded = loadTaxonomies(cfg);

  assert.equal(loaded.size, 5, 'all five built-in workloads should still load');
  for (const w of ['bugfix', 'feature', 'refactor', 'search', 'review']) {
    assert.ok(loaded.has(w as never), `missing taxonomy: ${w}`);
  }
});
