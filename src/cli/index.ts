/**
 * Commander CLI wiring for `prepass`.
 *
 * Subcommands are thin: they parse flags and delegate to entrypoint functions.
 * All heavy lifting lives in the pipeline so the same behavior is reachable from
 * the hook surface too.
 */
import { createRequire } from 'node:module';
import { Command } from 'commander';
import type { ModelTier } from '../types.js';
import { runProxy } from '../entrypoints/cli.js';
import { runHook } from '../entrypoints/hook.js';
import { runPipeline } from '../pipeline.js';
import { loadConfig } from '../config.js';
import { loadGlossary, appendProposals, GLOSSARY_FILENAME } from '../glossary.js';
import { mineGlossary, buildLearnPrompt } from '../core/glossary-miner.js';
import { TARGETS, registerIn, sizeAdvice, installSkill, installInstructions, type Agent } from '../core/install.js';
import { explainRanking, type RankingExplanation } from '../core/explain-ranking.js';
import { diagnose, poolSummary, type Check } from '../core/doctor.js';
import { loadTaxonomies, detectIntent } from '../core/intent-detector.js';
import { runHeuristicStage } from '../core/context-curator.js';
import { loadGlossary as loadGloss } from '../glossary.js';
import { scanRepo } from '../core/file-scanner.js';
import { Telemetry } from '../core/telemetry.js';

const VALID_TIERS: readonly ModelTier[] = ['cheap', 'balanced', 'premium'];

/**
 * Read the version from package.json rather than repeating it here. It was
 * hardcoded, so `npm version patch` bumped the package while the CLI kept
 * reporting the previous number — the kind of drift nobody notices until a bug
 * report cites a version that was never shipped.
 */
const VERSION: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

export function buildCli(): Command {
  const program = new Command();

  program
    .name('prepass')
    .description('Ranks your repo against a prompt and hands your agent a shortlist of file paths')
    .version(VERSION);

  // ── prompt ──────────────────────────────────────────────────────────────
  program
    .command('prompt')
    .description('Curate context for a prompt and print the payload')
    .argument('<prompt>', 'the task prompt')
    .option('-f, --file <path...>', 'candidate file(s) to consider', [])
    .option('--with-content', 'inline file contents into the payload', false)
    .option('--tier <tier>', 'force a model tier (cheap|balanced|premium)')
    .option('--no-discover', 'consider only --file paths; skip scanning the project')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (prompt: string, opts: PromptOpts) => {
      const code = await runProxy(prompt, {
        files: opts.file,
        withContent: opts.withContent,
        json: opts.json,
        discover: opts.discover,
        ...(opts.tier ? { tier: parseTier(opts.tier) } : {}),
      });
      process.exitCode = code;
    });

  // ── hook ────────────────────────────────────────────────────────────────
  program
    .command('hook')
    .description('Run as a Claude Code hook (reads event JSON on stdin)')
    .action(async () => {
      process.exitCode = await runHook();
    });

  // ── explain ─────────────────────────────────────────────────────────────
  program
    .command('explain')
    .description('Show how a prompt is classified and which files it ranks (no payload)')
    .argument('<prompt>', 'the task prompt')
    .option('-f, --file <path...>', 'candidate file(s) to consider', [])
    .option('--no-discover', 'consider only --file paths; skip scanning the project')
    .option('--why', 'show per-file score breakdowns', false)
    .option('-n, --top <n>', 'how many files to break down', '5')
    .action(async (prompt: string, opts: { file: string[]; discover: boolean; why: boolean; top: string }) => {
      const result = await runPipeline({
        prompt,
        candidates: opts.file.map((path) => ({ path, bytes: 0, score: 0.5 })),
        entrypoint: 'cli',
        discover: opts.discover,
      });
      printExplanation(prompt, result);
      if (!opts.why) {
        process.stdout.write(`\n(pass --why to see why each file scored what it did)\n`);
        return;
      }
      const { rootDir, config } = loadConfig();
      const candidates = scanRepo(rootDir, config).candidates;
      printWhy(
        explainRanking(prompt, candidates, config, rootDir, loadGlossary(rootDir), Number(opts.top) || 5),
      );
    });

  // ── stats ───────────────────────────────────────────────────────────────
  program
    .command('stats')
    .description('Summarize recorded telemetry')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts: { json: boolean }) => {
      const { config } = loadConfig();
      const telemetry = await Telemetry.open(config.telemetry.dbPath, config.telemetry.enabled);
      const summary = telemetry.aggregate();
      telemetry.close();
      if (opts.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
        return;
      }
      printStats(summary.totalEvents, summary);
    });

  // ── init ────────────────────────────────────────────────────────────────
  program
    .command('init')
    .description('Register the hook in this project (merges; never overwrites)')
    .option('--claude', 'only Claude Code', false)
    .option('--codex', 'only Codex CLI', false)
    .action((opts: { claude: boolean; codex: boolean }) => {
      const { rootDir, config } = loadConfig();
      const only: Agent[] = [
        ...(opts.claude ? (['claude'] as const) : []),
        ...(opts.codex ? (['codex'] as const) : []),
      ];
      const targets = only.length > 0 ? TARGETS.filter((t) => only.includes(t.agent)) : TARGETS;

      for (const target of targets) {
        const r = registerIn(rootDir, target);
        const rel = target.file;
        if (r.outcome === 'added') process.stdout.write(`  ✓ ${target.label.padEnd(12)} ${rel}\n`);
        else if (r.outcome === 'already-present')
          process.stdout.write(`  · ${target.label.padEnd(12)} ${rel} (already registered)\n`);
        else
          process.stdout.write(
            `  ! ${target.label.padEnd(12)} ${rel} could not be parsed, so it was left alone.\n` +
              `    Add this to its "hooks" yourself:\n` +
              `      "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "prepass hook" }] }]\n`,
          );
      }

      // The skill goes in regardless of agent: it is the only route that works
      // in the Codex desktop app, where hooks are read, trusted and then never run.
      process.stdout.write(`\n  skill (works everywhere, including Codex desktop):\n`);
      for (const s of installSkill(rootDir, only)) {
        const mark = s.outcome === 'installed' ? '✓' : s.outcome === 'already-present' ? '·' : '!';
        const note =
          s.outcome === 'already-present' ? ' (already there)' :
          s.outcome === 'source-missing' ? ' — skill file missing from the package' : '';
        process.stdout.write(`  ${mark} ${s.label.padEnd(20)} ${s.path.replace(rootDir + '/', '')}${note}\n`);
      }

      const instr = installInstructions(rootDir).filter((i) => i.outcome !== 'skipped-absent');
      if (instr.length > 0) {
        process.stdout.write(`\n  instructions (reaches any agent that can run a command):\n`);
        for (const i of instr) {
          process.stdout.write(
            `  ${i.outcome === 'appended' ? '✓' : '·'} ${i.file}${i.outcome === 'already-present' ? ' (already there)' : ''}\n`,
          );
        }
      }

      const advice = sizeAdvice(scanRepo(rootDir, config).candidates.length, config.curation.minFiles);
      process.stdout.write(advice ? `\n  ${advice}\n` : `\n  Done. Start your agent in this directory.\n`);
    });

  // ── doctor ──────────────────────────────────────────────────────────────
  program
    .command('doctor')
    .description('Check whether prepass will actually do anything here')
    .action(() => {
      const { rootDir, config, configPath } = loadConfig();
      const w = process.stdout.write.bind(process.stdout);

      const smoke = () => {
        const t0 = Date.now();
        const tax = loadTaxonomies(config);
        const prompt = 'fix the bug where the request handler drops an error';
        const intent = detectIntent(prompt, tax, config);
        const files = runHeuristicStage(
          {
            prompt,
            candidates: scanRepo(rootDir, config).candidates,
            taxonomy: tax.get(intent.workload)!,
            rootDir,
            glossary: loadGloss(rootDir),
          },
          { ...config, curation: { ...config.curation, minFiles: 0 } },
        ).length;
        return { files, ms: Date.now() - t0 };
      };

      w(`\nprepass in ${rootDir}\n`);
      w(`  ${poolSummary(rootDir, config)}\n`);
      w(`  config: ${configPath ?? 'defaults (no .prepass.json)'}\n\n`);

      const checks: Check[] = diagnose(rootDir, config, smoke);
      const mark = { ok: '✓', warn: '!', fail: '✗' } as const;
      for (const c of checks) {
        w(`  ${mark[c.level]} ${c.name.padEnd(13)} ${c.detail}\n`);
        if (c.fix) w(`      → ${c.fix}\n`);
      }

      const bad = checks.filter((c) => c.level === 'fail').length;
      const warn = checks.filter((c) => c.level === 'warn').length;
      w(
        bad > 0
          ? `\n  ${bad} problem${bad === 1 ? '' : 's'} that will stop prepass working here.\n\n`
          : warn > 0
            ? `\n  Workable, with ${warn} thing${warn === 1 ? '' : 's'} worth knowing.\n\n`
            : `\n  All good.\n\n`,
      );
      process.exitCode = bad > 0 ? 1 : 0;
    });

  // ── learn ───────────────────────────────────────────────────────────────
  program
    .command('learn')
    .description("Propose glossary entries mined from the codebase's own comments")
    .option('--write', 'append accepted proposals to the glossary', false)
    .option('--ask', "print a prompt for Claude to refine the proposals", false)
    .option('--min-seen <n>', 'lines that must support a pairing', '2')
    .option('--limit <n>', 'maximum proposals', '40')
    .option('--json', 'emit machine-readable JSON', false)
    .action(async (opts: LearnOpts) => {
      const { rootDir } = loadConfig();
      const existing = loadGlossary(rootDir);
      const proposals = mineGlossary(rootDir, existing, {
        minSeen: Number(opts.minSeen) || 2,
        limit: Number(opts.limit) || 40,
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(proposals, null, 2) + '\n');
        return;
      }
      if (proposals.length === 0) {
        process.stdout.write(
          'No new bridges found. Comments are where humans write both vocabularies in one\n' +
            'sentence; a codebase with few of them has little to mine. Add entries by hand in\n' +
            `${GLOSSARY_FILENAME}.\n`,
        );
        return;
      }
      if (opts.ask) {
        process.stdout.write(buildLearnPrompt(proposals, rootDir) + '\n');
        return;
      }

      process.stdout.write(
        `${proposals.length} proposed bridge${proposals.length === 1 ? '' : 's'} ` +
          `(mined from comment lines, not applied):\n\n`,
      );
      for (const p of proposals) {
        process.stdout.write(
          `  ${p.term} → ${p.expands.join(', ')}\n` +
            `      ${p.seen}× · ${p.evidence}\n`,
        );
      }
      if (!opts.write) {
        process.stdout.write(
          `\nNothing was written. Review these, then re-run with --write to keep them\n` +
            `(as source "mined"), or --ask to have Claude filter them first.\n`,
        );
        return;
      }
      const added = appendProposals(rootDir, existing, proposals);
      process.stdout.write(`\nWrote ${added} entr${added === 1 ? 'y' : 'ies'} to ${GLOSSARY_FILENAME}.\n`);
    });

  return program;
}

interface LearnOpts {
  write: boolean;
  ask: boolean;
  minSeen: string;
  limit: string;
  json: boolean;
}

interface PromptOpts {
  file: string[];
  withContent: boolean;
  tier?: string;
  json: boolean;
  /** Commander sets this false when `--no-discover` is passed. */
  discover: boolean;
}

function parseTier(value: string): ModelTier {
  if (!VALID_TIERS.includes(value as ModelTier)) {
    throw new Error(`invalid --tier "${value}" (expected one of: ${VALID_TIERS.join(', ')})`);
  }
  return value as ModelTier;
}

/**
 * What prepass decided, in the order a reader cares about.
 *
 * Deliberately says nothing about models or tiers. `model-router.ts` still
 * computes an advisory tier, but a hook cannot select a model — no field in the
 * hook output contract does that — so printing `model: claude-opus-5 [tier:
 * premium]` announced a capability the tool does not have. Reported by a user
 * reading the output of a freshly published build. The router stays for now
 * because the pipeline type depends on it; its output is simply not shown.
 */
function printExplanation(prompt: string, result: Awaited<ReturnType<typeof runPipeline>>): void {
  const { intent, curation } = result;
  const lines = [
    `prompt: ${truncate(prompt, 80)}`,
    ``,
    `workload:   ${intent.workload}  (confidence ${intent.confidence}${intent.fellBackToDefault ? ', fell back to default' : ''})`,
    `ranking:    ${intent.ranked.map((r) => `${r.workload}=${r.score.toFixed(2)}`).join('  ')}`,
    `keywords:   ${intent.matchedKeywords.join(', ') || '(none matched)'}`,
    ``,
    `curation:   ${curation.stage}, ${curation.selected.length} file(s), ~${curation.estimatedTokens} tokens` +
      (curation.degraded ? `  (degraded: ${curation.degraded})` : ''),
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * The score, itemised. A ranker nobody can interrogate is a ranker nobody
 * trusts, and "why is this fourth?" should not require reading the source.
 */
function printWhy(x: RankingExplanation): void {
  const w = process.stdout.write.bind(process.stdout);
  const typed = x.terms.filter((t) => t.typed).map((t) => t.term);
  const inferred = x.terms.filter((t) => !t.typed);

  w(`\nsearched ${x.poolSize} files in ${x.ms}ms\n`);
  w(`  your words:  ${typed.join(', ') || '(none over 3 characters)'}\n`);
  if (inferred.length > 0) {
    w(`  glossary:    ${inferred.map((t) => `${t.term} (via "${t.via}")`).join(', ')}\n`);
  }

  for (const f of x.files) {
    w(`\n  ${f.rank}. ${f.path}  ${f.score.toFixed(2)}\n`);
    if (f.contributions.length === 0) {
      w(`       nothing matched — ranked on the absence of better options\n`);
      continue;
    }
    for (const c of f.contributions.slice(0, 6)) {
      const where =
        c.field === 'contents' ? `in contents ×${c.count}` : `in ${c.field}`;
      // Document frequency is the interesting part: a term in 3 files of 2,000
      // is evidence, the same term in 900 of them is not.
      w(
        `       +${c.points.toFixed(2).padStart(5)}  ${c.term.padEnd(18)} ${where.padEnd(18)}` +
          ` ${c.docFreq}/${x.poolSize} files${c.via ? `  ← "${c.via}"` : ''}\n`,
      );
    }
    const rest = f.contributions.length - 6;
    if (rest > 0) w(`       …and ${rest} smaller\n`);
  }
  w(`\n`);
}

function printStats(total: number, s: ReturnType<Telemetry['aggregate']>): void {
  if (total === 0) {
    process.stdout.write('No telemetry recorded yet.\n');
    return;
  }
  const workloads = Object.entries(s.byWorkload)
    .map(([w, n]) => `  ${w.padEnd(10)} ${n}`)
    .join('\n');
  process.stdout.write(
    [
      `Total invocations:   ${s.totalEvents}`,
      `Escalation rate:     ${pct(s.escalationRate)}`,
      `Degraded rate:       ${pct(s.degradedRate)}`,
      `Avg latency:         ${Math.round(s.avgLatencyMs)} ms`,
      `Avg payload tokens:  ${Math.round(s.avgEstimatedTokens)}`,
      `By workload:`,
      workloads,
    ].join('\n') + '\n',
  );
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Entry called by bin/index.js. */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = buildCli();
  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    process.stderr.write(`prepass: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
