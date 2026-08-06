/**
 * Why did this file rank where it did?
 *
 * A ranker nobody can interrogate is a ranker nobody trusts, and the honest
 * answer to "why is this fourth?" should not require reading the source.
 *
 * This module used to re-implement `scoreBm25f` so the hot path would not have
 * to carry provenance. That duplication drifted twice: it kept an `if basename
 * else directory` branch the scorer had dropped, and it never applied the prose
 * discount at all — so on sympy it reported a `.rst` doc first at 59.67 while
 * the payload the agent actually received had it second at 29.83, exactly the
 * 0.5 prose weight. A command whose entire purpose is to be trusted was
 * describing a ranking the tool does not produce, and it shipped that way.
 *
 * Measured before removing the duplication: collecting provenance costs 2.1ms
 * across 2,000 files — about 2% of a 105ms run, and nothing at all when the
 * sink is omitted. The performance argument did not survive a stopwatch.
 *
 * There is now one implementation of the arithmetic. This file only arranges
 * its output for a human, which means `explain --why` cannot disagree with the
 * ranking again without the ranking itself being wrong.
 */
import type { ContextCandidate, Taxonomy } from '../types.js';
import type { SmartConfig } from '../schemas/config.js';
import {
  runHeuristicStage,
  tokenizeForExplain,
  type ScoreContribution,
} from './context-curator.js';
import { expandTerms, type Glossary } from '../glossary.js';

export interface TermContribution extends ScoreContribution {
  /** Set when the term came from the glossary rather than the prompt. */
  readonly via?: string;
}

export interface FileExplanation {
  readonly path: string;
  readonly rank: number;
  readonly score: number;
  readonly bytes: number;
  readonly contributions: TermContribution[];
}

export interface RankingExplanation {
  readonly poolSize: number;
  readonly terms: { term: string; typed: boolean; via?: string }[];
  readonly files: FileExplanation[];
  readonly ms: number;
}

/**
 * Rank exactly as the tool ranks, and keep the arithmetic instead of
 * discarding it.
 *
 * The order comes from `runHeuristicStage` — the same call the hook makes — so
 * what is shown is what the agent receives: prose discount, source-directory
 * hint, recency and all.
 */
export function explainRanking(
  prompt: string,
  candidates: readonly ContextCandidate[],
  config: SmartConfig,
  rootDir: string,
  glossary: Glossary = {},
  topN = 10,
  taxonomy?: Taxonomy,
): RankingExplanation {
  const started = Date.now();
  const typed = [...tokenizeForExplain(prompt)].filter((t) => t.length > 3);
  const weighted = expandTerms(typed, glossary);
  const typedSet = new Set(typed.map((t) => t.toLowerCase()));
  const via = new Map(
    weighted.filter((w) => w.via).map((w) => [w.term, w.via as string]),
  );

  const provenance = new Map<string, ScoreContribution[]>();
  const ranked = runHeuristicStage(
    {
      prompt,
      candidates,
      taxonomy: taxonomy ?? explainTaxonomy(candidates.length),
      rootDir,
      glossary,
    },
    config,
    provenance,
  );

  return {
    poolSize: candidates.length,
    terms: weighted.map((w) => ({
      term: w.term,
      typed: typedSet.has(w.term),
      ...(w.via ? { via: w.via } : {}),
    })),
    files: ranked.slice(0, topN).map((c, i) => ({
      path: c.path,
      rank: i + 1,
      score: c.score,
      bytes: c.bytes,
      contributions: (provenance.get(c.path) ?? [])
        .map((p) => ({ ...p, ...(via.has(p.term) ? { via: via.get(p.term) as string } : {}) }))
        .sort((a, b) => b.points - a.points),
    })),
    ms: Date.now() - started,
  };
}

/**
 * A taxonomy that excludes nothing and truncates nothing.
 *
 * `explain` answers "how did you rank these files", so it must not silently
 * drop candidates that a particular workload would have filtered — otherwise
 * the explanation answers a different question than the one asked.
 */
function explainTaxonomy(poolSize: number): Taxonomy {
  return {
    workload: 'search',
    displayName: 'Explain',
    keywords: [],
    weightedKeywords: {},
    antiKeywords: [],
    curationStrategy: {
      maxFiles: Math.max(poolSize, 1),
      includeGlobs: [],
      excludeGlobs: [],
      prioritySignals: [],
    },
    routing: { defaultTier: 'balanced', escalateTier: 'premium', escalateWhen: [] },
  };
}
