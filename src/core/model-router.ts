/**
 * Model router: map a detected workload to a concrete model ID, with escalation.
 *
 * Base tier comes from the workload's taxonomy. The router then applies
 * escalation logic — large prompts, many files, or low classifier confidence
 * bump the request up a tier — bounded by global config (`allowEscalation` and
 * the escalate-above thresholds). An explicit `forcedTier` always wins.
 */
import type {
  EscalationSignal,
  ModelTier,
  RoutingDecision,
  Taxonomy,
  Workload,
} from '../types.js';
import type { SmartConfig } from '../schemas/config.js';

/** Tier ordering for "bump up one level" arithmetic. */
const TIER_ORDER: readonly ModelTier[] = ['cheap', 'balanced', 'premium'];

/**
 * Decide which model handles this request.
 *
 * @param workload   the detected workload class
 * @param taxonomy   the workload's taxonomy (source of the base tier); may be
 *                   undefined if the taxonomy failed to load — we fall back to
 *                   the config default workload's routing then.
 * @param signal     runtime signals that may justify escalation
 * @param config     resolved global configuration
 */
export function routeModel(
  workload: Workload,
  taxonomy: Taxonomy | undefined,
  signal: EscalationSignal,
  config: SmartConfig,
): RoutingDecision {
  // Explicit override short-circuits all heuristics.
  if (signal.forcedTier) {
    return decide(signal.forcedTier, false, `forced via --tier ${signal.forcedTier}`, config);
  }

  const baseTier = taxonomy?.routing.defaultTier ?? 'balanced';
  const escalateTier = taxonomy?.routing.escalateTier ?? bumpTier(baseTier);

  if (!config.routing.allowEscalation) {
    return decide(baseTier, false, `base tier for ${workload} (escalation disabled)`, config);
  }

  const trigger = escalationTrigger(signal, config);
  if (trigger && tierRank(escalateTier) > tierRank(baseTier)) {
    return decide(escalateTier, true, `escalated: ${trigger}`, config);
  }

  return decide(baseTier, false, `base tier for ${workload}`, config);
}

/** Return the first escalation reason that fires, or null if none do. */
function escalationTrigger(signal: EscalationSignal, config: SmartConfig): string | null {
  if (signal.promptTokens > config.routing.escalateAboveTokens) {
    return `prompt ${signal.promptTokens} tokens > ${config.routing.escalateAboveTokens}`;
  }
  if (signal.fileCount > config.routing.escalateAboveFiles) {
    return `${signal.fileCount} files > ${config.routing.escalateAboveFiles}`;
  }
  // Low confidence means the cheap-tier assumption is shaky — buy headroom.
  if (signal.confidence < config.routing.confidenceThreshold) {
    return `low confidence ${signal.confidence} < ${config.routing.confidenceThreshold}`;
  }
  return null;
}

function decide(
  tier: ModelTier,
  escalated: boolean,
  reason: string,
  config: SmartConfig,
): RoutingDecision {
  return { tier, escalated, reason, modelId: config.models[tier] };
}

export function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** Move up one tier, saturating at `premium`. */
export function bumpTier(tier: ModelTier): ModelTier {
  const next = TIER_ORDER[Math.min(tierRank(tier) + 1, TIER_ORDER.length - 1)];
  // `next` is always defined because the index is clamped in-bounds.
  return next ?? tier;
}
