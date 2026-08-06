/**
 * `prepass doctor` — why isn't it doing anything?
 *
 * Every check here exists because it silently went wrong for somebody. prepass
 * has no UI: when it is misconfigured it does not error, it simply contributes
 * nothing, which is indistinguishable from working and finding little. That
 * failure mode has now cost a two-week-long bug, an afternoon of testing hooks
 * that were being skipped for want of trust, and a session that scanned a
 * folder one level above the repo its owner was actually editing.
 *
 * So this reports what prepass can actually see, and says plainly when the
 * answer is "not the thing you meant".
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SmartConfig } from '../schemas/config.js';
import { scanRepo } from './file-scanner.js';
import { loadGlossary, findGlossaryFile } from '../glossary.js';

export type Level = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly level: Level;
  readonly name: string;
  readonly detail: string;
  /** What to actually do about it. */
  readonly fix?: string;
}

/** Is ripgrep reachable? Without it, scoring silently reads file heads only. */
function checkRipgrep(): Check {
  try {
    const v = execFileSync('rg', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { level: 'ok', name: 'ripgrep', detail: (v.split('\n')[0] ?? 'found').trim() };
  } catch {
    return {
      level: 'warn',
      name: 'ripgrep',
      detail: 'not on PATH — scoring falls back to reading the first 16 KB of each file',
      fix: 'brew install ripgrep (or your package manager). Ranking is measurably worse without it.',
    };
  }
}

/**
 * Does this directory hold the code you mean?
 *
 * prepass scans wherever the agent session started, which is not always where
 * the work is. Two shapes go wrong: a session started in a home-ish directory
 * while the project lives elsewhere, and a container folder whose real
 * repository is one level down. The second is detectable; the first can only be
 * pointed at.
 */
function checkLocation(rootDir: string, candidates: number, minFiles: number): Check[] {
  const out: Check[] = [];

  // The tell is not "a child has more files" — a container directory often
  // looks larger, because walking it picks up editor state and stray folders
  // that git would have ignored. On one real project the container walked to
  // 379 candidates while the actual repository inside it tracked 309, so a
  // size comparison stayed silent on exactly the case it was written for.
  //
  // The real signal is structural: this directory is not a repository and
  // something directly inside it is.
  const selfIsRepo = existsSync(join(rootDir, '.git'));
  let biggestChild: { name: string; count: number } | null = null;
  try {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = join(rootDir, entry.name);
      if (!existsSync(join(child, '.git'))) continue;
      try {
        const n = execFileSync('git', ['-C', child, 'ls-files'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
        }).split('\n').filter(Boolean).length;
        const worthPointingAt = !selfIsRepo || n > candidates;
        if (worthPointingAt && (!biggestChild || n > biggestChild.count)) {
          biggestChild = { name: entry.name, count: n };
        }
      } catch { /* not a usable repo */ }
    }
  } catch { /* unreadable */ }

  if (biggestChild) {
    out.push({
      level: 'warn',
      name: 'location',
      detail: selfIsRepo
        ? `this is a repository, but ./${biggestChild.name} inside it tracks more files ` +
          `(${biggestChild.count} vs ${candidates} here)`
        : `this is not a git repository, but ./${biggestChild.name} is — ` +
          `${biggestChild.count} tracked files`,
      fix:
        `prepass scans where the session starts, so it is currently ranking this folder ` +
        `and everything loose in it. Start your agent in ./${biggestChild.name} instead: ` +
        `it will use git ls-files and skip whatever your .gitignore already excludes.`,
    });
  } else if (candidates < minFiles) {
    out.push({
      level: 'warn',
      name: 'location',
      detail: `only ${candidates} candidate files here`,
      fix:
        'prepass will stand aside below ' + minFiles + ' files. If your code lives somewhere ' +
        'else, start the agent there — prepass scans the session directory, not the repository ' +
        'you have open in an editor.',
    });
  }
  return out;
}

/** Where the candidate pool came from, and what it is made of. */
function checkPool(rootDir: string, config: SmartConfig): Check[] {
  const scan = scanRepo(rootDir, config);
  const n = scan.candidates.length;
  const out: Check[] = [
    scan.source === 'git'
      ? { level: 'ok', name: 'project', detail: `git repository, ${n} candidate files — .gitignore is honoured` }
      : {
          level: 'warn',
          name: 'project',
          detail: `not a git repository, ${n} candidate files found by walking`,
          fix: 'git init would let prepass use git ls-files, which skips build output and anything ignored.',
        },
  ];

  if (scan.truncated) {
    out.push({
      level: 'warn', name: 'pool',
      detail: `hit the ${config.discovery.maxFiles}-file cap, so some files were never scored`,
      fix: 'raise discovery.maxFiles in .prepass.json if the repository is genuinely larger.',
    });
  }

  const prose = scan.candidates.filter((c) =>
    /(?:^|\/)(?:docs?|documentation|guides?|manual|examples?)\//i.test(c.path) ||
    /\.(?:md|mdx|rst|txt|adoc|org|tex)$/i.test(c.path),
  ).length;
  if (n > 0 && prose / n > 0.25) {
    out.push({
      level: 'warn', name: 'composition',
      detail: `${Math.round((prose / n) * 100)}% of candidates are prose (docs, guides, notes)`,
      fix:
        'They are already discounted, but a repository that ships its own manual will rank ' +
        'noisier than one that does not. Lower curation.proseWeight if it still crowds results.',
    });
  }
  return out;
}

/** Is prepass actually wired into anything? */
function checkWiring(rootDir: string): Check[] {
  const out: Check[] = [];
  const seen: string[] = [];

  for (const [file, label] of [
    ['.claude/settings.json', 'Claude Code hook'],
    ['.codex/hooks.json', 'Codex hook'],
  ] as const) {
    const p = join(rootDir, file);
    if (!existsSync(p)) continue;
    try {
      const s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      const hooks = (s.hooks ?? {}) as Record<string, unknown>;
      const list = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
      const cmds = list.flatMap((e: { hooks?: { command?: string }[] }) =>
        (e?.hooks ?? []).map((h) => h?.command ?? ''));
      const mine = cmds.filter((c) => c.includes('prepass'));
      if (mine.length === 0) continue;
      seen.push(label);
      // An absolute path that no longer resolves is the quiet way this dies.
      for (const c of mine) {
        const bin = c.split(' ')[0] ?? '';
        if (bin.startsWith('/') && !existsSync(bin)) {
          out.push({
            level: 'fail', name: label,
            detail: `registered as ${bin}, which does not exist`,
            fix: 'Re-run prepass init, or point it at `prepass hook` and let PATH resolve it.',
          });
        }
      }
      if (mine.length > 1) {
        out.push({
          level: 'warn', name: label,
          detail: `registered ${mine.length} times — it will run ${mine.length}× per prompt`,
          fix: `Remove the duplicates from ${file}.`,
        });
      }
    } catch {
      out.push({
        level: 'fail', name: label, detail: `${file} is not valid JSON`,
        fix: 'Fix the syntax; prepass init refuses to touch a file it cannot parse.',
      });
    }
  }

  const skills = ['.claude/skills/prepass/SKILL.md', '.codex/skills/prepass/SKILL.md']
    .filter((f) => existsSync(join(rootDir, f)));
  if (skills.length > 0) seen.push(`skill (${skills.length})`);

  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const p = join(rootDir, f);
    if (existsSync(p) && readFileSync(p, 'utf8').includes('<!-- prepass -->')) seen.push(f);
  }

  out.unshift(
    seen.length > 0
      ? { level: 'ok', name: 'wiring', detail: seen.join(', ') }
      : {
          level: 'fail', name: 'wiring',
          detail: 'nothing is registered — no agent will ever call prepass here',
          fix: 'Run: prepass init',
        },
  );
  return out;
}

function checkGlossary(rootDir: string): Check {
  const path = findGlossaryFile(rootDir);
  if (!path) {
    return {
      level: 'ok', name: 'glossary',
      detail: 'none — ranking uses only the words you type',
    };
  }
  const n = Object.keys(loadGlossary(rootDir)).length;
  return n === 0
    ? { level: 'warn', name: 'glossary', detail: `${path} has no usable entries`, fix: 'Check it parses as JSON.' }
    : { level: 'ok', name: 'glossary', detail: `${n} term${n === 1 ? '' : 's'}` };
}

/** Does it actually work here, right now? */
function checkSmoke(run: () => { files: number; ms: number }): Check {
  try {
    const { files, ms } = run();
    if (files === 0) {
      return {
        level: 'warn', name: 'smoke test', detail: 'a sample query returned no files',
        fix: 'Expected on a small project (prepass stands aside). Otherwise check the taxonomy excludeGlobs.',
      };
    }
    return { level: 'ok', name: 'smoke test', detail: `ranked ${files} files in ${ms}ms` };
  } catch (err) {
    return { level: 'fail', name: 'smoke test', detail: String(err).slice(0, 120) };
  }
}

export function diagnose(
  rootDir: string,
  config: SmartConfig,
  smoke: () => { files: number; ms: number },
): Check[] {
  const scan = scanRepo(rootDir, config);
  return [
    checkRipgrep(),
    ...checkPool(rootDir, config),
    ...checkLocation(rootDir, scan.candidates.length, config.curation.minFiles),
    ...checkWiring(rootDir),
    checkGlossary(rootDir),
    checkSmoke(smoke),
  ];
}

/** Statistics used to explain what prepass is looking at. */
export function poolSummary(rootDir: string, config: SmartConfig): string {
  const scan = scanRepo(rootDir, config);
  const bytes = scan.candidates.reduce((s, c) => s + c.bytes, 0);
  const biggest = [...scan.candidates].sort((a, b) => b.bytes - a.bytes)[0];
  return (
    `${scan.candidates.length} files, ${(bytes / 1_048_576).toFixed(1)} MB` +
    (biggest ? `, largest ${biggest.path} (${Math.round(biggest.bytes / 1024)} KB)` : '')
  );
}
