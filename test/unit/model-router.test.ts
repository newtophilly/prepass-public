/**
 * Unit stubs for the model router.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeModel, bumpTier, tierRank } from '../../src/core/model-router.js';
import { configSchema } from '../../src/schemas/config.js';
import type { EscalationSignal, Taxonomy } from '../../src/types.js';

const config = configSchema.parse({});

const taxonomy: Taxonomy = {
  workload: 'bugfix',
  displayName: 'Bug Fix',
  keywords: [],
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

const calmSignal: EscalationSignal = { promptTokens: 100, fileCount: 1, confidence: 0.9 };

test('uses the base tier when no escalation trigger fires', () => {
  const decision = routeModel('bugfix', taxonomy, calmSignal, config);
  assert.equal(decision.tier, 'balanced');
  assert.equal(decision.escalated, false, 'no trigger fired, so nothing should escalate');
  assert.equal(decision.modelId, config.models.balanced, 'tier must resolve to the configured model id');
});

test('escalates on a large prompt', () => {
  const decision = routeModel('bugfix', taxonomy, { ...calmSignal, promptTokens: 999_999 }, config);
  assert.equal(decision.tier, 'premium');
  assert.equal(decision.escalated, true, 'escalation must be reported, not applied silently');
});

test('a forced tier overrides all heuristics', () => {
  const decision = routeModel('bugfix', taxonomy, { ...calmSignal, forcedTier: 'cheap' }, config);
  assert.equal(decision.tier, 'cheap');
  assert.equal(decision.escalated, false);
});

test('tier helpers are consistent', () => {
  assert.equal(bumpTier('cheap'), 'balanced');
  assert.equal(bumpTier('premium'), 'premium'); // saturates
  assert.ok(tierRank('premium') > tierRank('cheap'));
});

// TODO: cover allowEscalation=false and confidence-based escalation.
