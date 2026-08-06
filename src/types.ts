/**
 * Shared domain types for prepass.
 *
 * Kept dependency-free (no imports) so every module — core, providers,
 * entrypoints, and tests — can share one vocabulary without creating cycles.
 */

/** The five workload classes prepass knows how to curate for. */
export type Workload = 'bugfix' | 'feature' | 'refactor' | 'search' | 'review';

/** Logical model tiers. Mapped to concrete model IDs in `.prepass.json`. */
export type ModelTier = 'cheap' | 'balanced' | 'premium';

/** Supported upstream providers. */
export type ProviderName = 'anthropic' | 'openai';

/** A taxonomy file (`taxonomies/<workload>.json`) parsed into memory. */
export interface Taxonomy {
  readonly workload: Workload;
  readonly displayName: string;
  /** Plain keywords, each contributing a base weight of 1.0. */
  readonly keywords: readonly string[];
  /** Keywords with an explicit weight override (strong signals score higher). */
  readonly weightedKeywords: Readonly<Record<string, number>>;
  /** Keywords whose presence subtracts confidence (disambiguators). */
  readonly antiKeywords: readonly string[];
  readonly curationStrategy: CurationStrategy;
  readonly routing: TaxonomyRouting;
}

/** How the curator should assemble context for a given workload. */
export interface CurationStrategy {
  readonly maxFiles: number;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  /** Free-text hints handed to the Haiku refinement stage. */
  readonly prioritySignals: readonly string[];
  /** When false, the second (Haiku) curation stage is skipped entirely. */
}

/** Per-workload routing preferences, overridable by global config. */
export interface TaxonomyRouting {
  readonly defaultTier: ModelTier;
  readonly escalateTier: ModelTier;
  /** Signal names (see EscalationSignal) that justify escalation. */
  readonly escalateWhen: readonly string[];
}

/** Output of the intent detector. */
export interface IntentResult {
  readonly workload: Workload;
  /** 0..1 — normalized confidence in `workload`. */
  readonly confidence: number;
  /** All workloads scored, highest first, for explainability. */
  readonly ranked: readonly WorkloadScore[];
  /** Keywords that fired, for the `explain` command. */
  readonly matchedKeywords: readonly string[];
  /** True when confidence fell below the configured threshold. */
  readonly fellBackToDefault: boolean;
}

export interface WorkloadScore {
  readonly workload: Workload;
  readonly score: number;
}

/** A single candidate context item before/after curation. */
export interface ContextCandidate {
  readonly path: string;
  readonly bytes: number;
  /** Heuristic relevance score (0..1) assigned in stage one. */
  readonly score: number;
  /**
   * Last-modified time, ms since epoch. A file you touched an hour ago is far
   * more likely to be the one you are asking about than one untouched for a
   * year — the same prior an agent reaches for when it runs `git status`.
   */
  readonly mtimeMs?: number;
  /** Populated lazily; the payload builder reads this. */
  readonly content?: string;
}

/** Output of the context curator. */
export interface CurationResult {
  readonly workload: Workload;
  readonly selected: readonly ContextCandidate[];
  /** Which of the two stages actually ran. */
  readonly stage: 'heuristic';
  /** The assembled XML payload ready to prepend to the user prompt. */
  readonly payload: string;
  readonly estimatedTokens: number;
  /** Set when the Haiku stage was requested but degraded to heuristic-only. */
  readonly degraded?: DegradationReason;
}

export type DegradationReason = 'disabled' | 'repo-too-small';

/** Output of the model router. */
export interface RoutingDecision {
  readonly tier: ModelTier;
  readonly modelId: string;
  readonly escalated: boolean;
  readonly reason: string;
}

/** Signals the router weighs when deciding whether to escalate a tier. */
export interface EscalationSignal {
  readonly promptTokens: number;
  readonly fileCount: number;
  readonly confidence: number;
  /** Explicit user override, e.g. `--tier premium`. */
  readonly forcedTier?: ModelTier;
}

/** A structured, JSON-friendly telemetry record (one row per invocation). */
export interface TelemetryEvent {
  readonly ts: number;
  readonly entrypoint: 'cli' | 'hook';
  readonly workload: Workload;
  readonly confidence: number;
  readonly tier: ModelTier;
  readonly modelId: string;
  readonly escalated: boolean;
  readonly curationStage: CurationResult['stage'];
  readonly estimatedTokens: number;
  readonly latencyMs: number;
  readonly degraded?: DegradationReason;
}
