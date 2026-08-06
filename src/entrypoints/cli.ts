/**
 * Standalone proxy entrypoint: `prepass prompt "..."`.
 *
 * Runs the full pipeline and writes the curated payload + original prompt to
 * stdout (so it can be piped into another tool), while decisions and diagnostics
 * go to stderr. This is the "look what prepass would send" mode.
 */
import { readFileSync, statSync } from 'node:fs';
import type { ContextCandidate, ModelTier } from '../types.js';
import { runPipeline } from '../pipeline.js';
import { log } from '../core/telemetry.js';

export interface ProxyOptions {
  /** Candidate file paths to consider for curation. */
  readonly files?: readonly string[];
  /** Load file contents into the payload (default: paths only). */
  readonly withContent?: boolean;
  readonly tier?: ModelTier;
  /** Emit machine-readable JSON instead of the human-facing payload. */
  readonly json?: boolean;
  /** Scan the project for candidates (default). False = only `files`. */
  readonly discover?: boolean;
}

export async function runProxy(prompt: string, options: ProxyOptions = {}): Promise<number> {
  if (!prompt.trim()) {
    process.stderr.write('prepass: empty prompt\n');
    return 2;
  }

  const candidates = gatherCandidates(options.files ?? [], options.withContent ?? false);

  const result = await runPipeline({
    prompt,
    candidates,
    entrypoint: 'cli',
    ...(options.tier ? { forcedTier: options.tier } : {}),
    ...(options.discover === false ? { discover: false } : {}),
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  // Human/pipe mode: decisions to stderr, payload+prompt to stdout.
  //
  // Deliberately reports no model or tier. `model-router` still computes an
  // advisory one for telemetry, but a hook cannot select a model — no field in
  // the hook contract does that — so printing `model: claude-opus-5` announced
  // a capability the tool does not have. The same line was removed from
  // `explain` after a user read it and reasonably assumed routing worked.
  log('info', 'proxy.decision', {
    workload: result.intent.workload,
    confidence: result.intent.confidence,
    stage: result.curation.stage,
    tokens: result.curation.estimatedTokens,
  });
  process.stdout.write(result.curation.payload + '\n\n' + prompt + '\n');
  return 0;
}

/**
 * Turn file paths into candidates. Unreadable paths are skipped with a warning
 * rather than aborting — a stale path shouldn't kill the whole run.
 */
function gatherCandidates(files: readonly string[], withContent: boolean): ContextCandidate[] {
  const out: ContextCandidate[] = [];
  for (const path of files) {
    try {
      const bytes = statSync(path).size;
      out.push({
        path,
        bytes,
        // Prior above a discovered file's 0: the caller named this one.
        score: 0.5,
        ...(withContent ? { content: readFileSync(path, 'utf8') } : {}),
      });
    } catch (err) {
      log('warn', 'proxy.file_skipped', { path, error: String(err) });
    }
  }
  return out;
}
