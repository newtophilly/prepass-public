/**
 * The end-to-end curation pipeline, shared by the cli and hook entrypoints.
 *
 * Keeping the orchestration here means both entrypoints stay thin adapters that
 * only translate their transport (argv, hook JSON) into a `PipelineInput` and
 * render the `PipelineOutput` back out.
 */
import type {
  ContextCandidate,
  IntentResult,
  ModelTier,
  RoutingDecision,
  CurationResult,
  TelemetryEvent,
} from './types.js';
import { loadConfig, type LoadedConfig } from './config.js';
import { detectIntent, loadTaxonomies } from './core/intent-detector.js';
import { routeModel } from './core/model-router.js';
import { curate, buildXmlPayload } from './core/context-curator.js';
import { scanRepo, mergeCandidates } from './core/file-scanner.js';
import { Telemetry } from './core/telemetry.js';
import { estimateTokens } from './tokens.js';
import { loadGlossary } from './glossary.js';

export interface PipelineInput {
  readonly prompt: string;
  readonly candidates: readonly ContextCandidate[];
  readonly entrypoint: TelemetryEvent['entrypoint'];
  /** Explicit tier override (e.g. from `--tier`). */
  readonly forcedTier?: ModelTier;
  /**
   * Scan the project for candidate files and merge them with `candidates`.
   * Defaults to true: without discovery the curator can only rank files the
   * caller already named, which is not curation. Set false when the caller
   * means "consider exactly these files and nothing else".
   */
  readonly discover?: boolean;
  /** Reuse a pre-loaded config (tests, or an already-resolved project root). */
  readonly loaded?: LoadedConfig;
}

export interface PipelineOutput {
  readonly intent: IntentResult;
  readonly routing: RoutingDecision;
  readonly curation: CurationResult;
  readonly latencyMs: number;
}

/**
 * Run detection -> routing -> curation, record telemetry, and return the
 * decisions. Curation degradation is handled inside `curate`, so this function
 * only throws on genuinely fatal errors (e.g. invalid config).
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const started = Date.now();
  const loaded = input.loaded ?? loadConfig();
  const { config } = loaded;

  const taxonomies = loadTaxonomies(config);
  const intent = detectIntent(input.prompt, taxonomies, config);
  const taxonomy = taxonomies.get(intent.workload);

  // Discovery runs before routing so `fileCount` reflects the real pool size —
  // it feeds the escalation rule, and the caller's explicit list is not it.
  const scan =
    (input.discover ?? true) && config.discovery.enabled
      ? scanRepo(loaded.rootDir, config)
      : null;
  const candidates = scan
    ? mergeCandidates(input.candidates, scan.candidates)
    : [...input.candidates];

  // Answer the question every agent asks first, so it never has to run
  // `git status` to find out — in a non-repository that call simply fails and
  // costs a round trip.
  const repo = scan
    ? {
        isGitRepo: scan.source === 'git',
        recentlyChanged: [...scan.candidates]
          .filter((c) => typeof c.mtimeMs === 'number')
          // Dotfiles dominate "most recent" without ever being the answer:
          // .DS_Store, editor state, and the agent's own settings file are all
          // touched constantly. The point of this list is source that moved.
          .filter((c) => !c.path.split('/').some((seg) => seg.startsWith('.')))
          .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
          .slice(0, 5)
          .map((c) => c.path),
      }
    : undefined;

  const curation = taxonomy
    ? curate(
        {
          prompt: input.prompt,
          candidates,
          taxonomy,
          rootDir: loaded.rootDir,
          glossary: loadGlossary(loaded.rootDir),
          ...(repo ? { repo } : {}),
        },
        config,
      )
    : emptyCuration(intent);

  // Route *after* curation so `fileCount` is what will actually be sent, not
  // the size of the discovered pool. Judging the pool would escalate every
  // repo with more than `escalateAboveFiles` files in it — which is all of
  // them — turning a cost-curation tool into a premium-model dispatcher.
  const promptTokens = estimateTokens(input.prompt);
  const routing = routeModel(
    intent.workload,
    taxonomy,
    {
      promptTokens,
      fileCount: curation.selected.length,
      confidence: intent.confidence,
      ...(input.forcedTier ? { forcedTier: input.forcedTier } : {}),
    },
    config,
  );

  const latencyMs = Date.now() - started;

  await recordTelemetry(loaded, input.entrypoint, intent, routing, curation, latencyMs);

  return { intent, routing, curation, latencyMs };
}

async function recordTelemetry(
  loaded: LoadedConfig,
  entrypoint: TelemetryEvent['entrypoint'],
  intent: IntentResult,
  routing: RoutingDecision,
  curation: CurationResult,
  latencyMs: number,
): Promise<void> {
  const telemetry = await Telemetry.open(loaded.config.telemetry.dbPath, loaded.config.telemetry.enabled);
  telemetry.record({
    ts: Date.now(),
    entrypoint,
    workload: intent.workload,
    confidence: intent.confidence,
    tier: routing.tier,
    modelId: routing.modelId,
    escalated: routing.escalated,
    curationStage: curation.stage,
    estimatedTokens: curation.estimatedTokens,
    latencyMs,
    ...(curation.degraded ? { degraded: curation.degraded } : {}),
  });
  telemetry.close();
}

/** Fallback curation when the workload's taxonomy failed to load. */
function emptyCuration(intent: IntentResult): CurationResult {
  return {
    workload: intent.workload,
    selected: [],
    stage: 'heuristic',
    payload: buildXmlPayload([]),
    estimatedTokens: 0,
    degraded: 'disabled',
  };
}
