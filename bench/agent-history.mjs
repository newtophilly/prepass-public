#!/usr/bin/env node
/**
 * Build an evaluation corpus from your OWN coding-agent sessions.
 *
 *     node bench/agent-history.mjs [--archive <transcripts dir>] [--out corpus.json]
 *     node bench/swebench.mjs --repos <parent-dir> --data corpus.json
 *
 * ## Why this exists
 *
 * Every public corpus is written by strangers: strangers' words, strangers'
 * repositories, strangers' layouts. SWE-bench is 100% Python monorepos with no
 * `src/` directory, which is why four different workload taxonomies produce
 * byte-identical rankings on it — the instrument is blind to half of prepass.
 *
 * Your agent sessions are not. Every one records the thing a retrieval
 * benchmark needs and nobody thought to keep:
 *
 *     what you typed          ->      the files that turned out to matter
 *
 * That is a labelled retrieval example, in your vocabulary, on your repositories,
 * in your languages. And unlike a commit message — which is written *after* the
 * work, by someone who already knows the answer — a prompt is written *before*.
 * It is the real task, not a reconstruction of it.
 *
 * ## Where the data lives
 *
 *   Claude Code   ~/.claude/projects/<slug>/*.jsonl   type=user + Edit/Write tool_use
 *   Codex         ~/.codex/sessions/**\/*.jsonl        user_message + apply_patch
 *
 * Prefer an archive directory over the live ones: Claude Code deletes sessions
 * older than `cleanupPeriodDays` (default 30) at startup, and has been reported
 * to do so even when that key is set high.
 *
 * ## What gets thrown away, and why
 *
 * Most turns are unusable as labels, and keeping them would inflate every number:
 *
 *   - **Contaminated sessions.** If prepass was already registered in that repo
 *     when the session ran, prepass suggested the files the agent then opened.
 *     Scoring against them is grading your own homework. Dropped by date.
 *   - **Follow-ups.** "yes", "continue", "now fix the test" carry no retrieval
 *     signal — the context is in the preceding turn, not the prompt.
 *   - **Multi-file edits.** Same ambiguity `git-history.mjs` avoids: with six
 *     files touched there is no single right answer.
 *   - **Tool results and hook injections**, which Claude Code stores in
 *     user-shaped records and which are not things a human typed.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
/**
 * Where session transcripts live. Defaults to the real Claude Code directory so
 * this works on any machine; point `--archive` at a backup if you keep one,
 * since Claude Code deletes sessions older than `cleanupPeriodDays` (30 by
 * default) at startup.
 *
 * Two layouts are accepted: `<dir>/<project-slug>/*.jsonl` (live) and
 * `<dir>/claude-code/...` plus `<dir>/codex/...` (archived).
 */
const ARCHIVE = resolve(arg('--archive', join(homedir(), '.claude', 'projects')));
const OUT = arg('--out', 'agent-history-corpus.json');
const MIN_LEN = Number(arg('--min-len', '40'));
/** Max gold files. ARB averages 1.45; beyond a few the label stops meaning anything. */
const MAX_GOLD = Number(arg('--max-gold', '3'));
const VERBOSE = args.includes('--verbose');
/**
 * Clone every referenced repository here and point the corpus at the copies.
 *
 * The scorer runs `git checkout --force` on whatever it is handed. Against your
 * real working repositories that detaches them and discards uncommitted tracked
 * edits — it happened, to 13 of them. Guarding after the fact is weaker than not
 * handing it a live repo at all, so this makes the corpus reference disposable
 * clones by construction.
 */
const CLONE_TO = arg('--clone-to', '');

/** Extensions counted as source. Anything else is not a retrieval target. */
const CODE = /\.(py|js|ts|tsx|jsx|go|rs|java|rb|php|c|h|cc|cpp|swift|kt|scala|cs|m|mm)$/i;

/**
 * Records that arrive in a user-shaped slot but that no human typed.
 * Without this the prompt count roughly doubles and every one is noise.
 */
const NOISE =
  /^\s*(<command-name>|<local-command-stdout>|<command-message>|<system-reminder>|<task-notification>|<function_results>|Caveat: The messages below|\[Request interrupted)/i;

/**
 * A retrieval query has to describe something. These carry no referent of their
 * own — "I actually like take 2 better" means nothing without the previous turn,
 * so pairing it with a file teaches noise. Measured: 22% of the first corpus was
 * this, and it dragged hit@20 from 71.6% down to 66.7%.
 */
const CONTENT_STOP = new Set(
  ('the and for with this that from have will been were them they there when what which then than ' +
   'else true false null none self return import export const class function def var let not but ' +
   'out into your you use used using file files line lines test tests code just like make made ' +
   'want need should would could really okay well now some more only very much take dont cant its')
    .split(' '),
);
const contentTerms = (s) =>
  new Set((s.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []).filter((w) => !CONTENT_STOP.has(w)));

/**
 * Prompts that describe nothing a retriever could act on. A follow-up refers to
 * context in the previous turn, so pairing it with a file teaches noise.
 */
const FOLLOWUP =
  /^\s*(y(es)?|no|ok(ay)?|sure|thanks?|continue|go|do it|fix it|try again|again|next|yep|nope|k)\b[\s.!?]*$/i;

const stats = {
  sessions: 0, records: 0, prompts: 0,
  dropNoise: 0, dropFollowup: 0, dropShort: 0,
  dropNoEdit: 0, dropMultiFile: 0, dropNonCode: 0, dropContaminated: 0, dropThin: 0,
  kept: 0,
};

/**
 * Repositories where prepass was already registered, and from when. A session
 * in one of these after that date has a label prepass helped produce.
 */
function contaminationDates() {
  const out = new Map();
  const roots = [join(homedir(), 'Downloads'), join(homedir(), 'Desktop'), join(homedir(), 'Projects')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      for (const marker of ['.claude/settings.json', '.codex/hooks.json', 'CLAUDE.md', 'AGENTS.md']) {
        const p = join(root, name, marker);
        if (!existsSync(p)) continue;
        try {
          if (!/prepass|claude-smart/.test(readFileSync(p, 'utf8'))) continue;
          const when = statSync(p).mtime;
          const dir = join(root, name);
          if (!out.has(dir) || when < out.get(dir)) out.set(dir, when);
        } catch {}
      }
    }
  }
  return out;
}
const CONTAMINATED = contaminationDates();
const isContaminated = (cwd, when) => {
  if (!cwd || !when) return false;
  for (const [dir, since] of CONTAMINATED) if (cwd.startsWith(dir) && when >= since) return true;
  return false;
};

/**
 * The directory slug is NOT decodable: Claude Code replaces both path separators
 * and literal hyphens with `-`, so `-Users-nathan-Desktop-work-website` could be
 * `.../work/website` or `.../work-website` and there is no way to tell. Guessing
 * silently produced ZERO usable Claude Code examples, because most real project
 * names contain a hyphen. Every record carries `cwd` verbatim — use that.
 */
const dirOf = (rec) => (typeof rec?.cwd === 'string' && rec.cwd.startsWith('/') ? rec.cwd : null);

/** The commit the repo was at when the prompt was typed — the state prepass would have seen. */
const commitCache = new Map();
function commitAt(repo, iso) {
  const key = `${repo}@${iso}`;
  if (commitCache.has(key)) return commitCache.get(key);
  let sha = null;
  try {
    sha = execFileSync('git', ['-C', repo, 'rev-list', '-1', `--before=${iso}`, 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {}
  commitCache.set(key, sha);
  return sha;
}

const cases = [];
/** One labelled example, if the turn survives every filter. */
function emit(prompt, files, repoPath, iso, agent, id) {
  if (!prompt || prompt.length < MIN_LEN) { stats.dropShort++; return; }
  if (NOISE.test(prompt)) { stats.dropNoise++; return; }
  if (FOLLOWUP.test(prompt)) { stats.dropFollowup++; return; }
  if (contentTerms(prompt).size < 6) { stats.dropThin++; return; }
  if (!files.length) { stats.dropNoEdit++; return; }
  const code = [...new Set(files)].filter((f) => CODE.test(f));
  if (!code.length) { stats.dropNonCode++; return; }
  if (code.length > MAX_GOLD) { stats.dropMultiFile++; return; }
  if (!repoPath) return;
  if (isContaminated(repoPath, new Date(iso))) { stats.dropContaminated++; return; }

  // Store repo-relative, the way a ranker sees it.
  const rels = code
    .map((f) => (f.startsWith(repoPath) ? f.slice(repoPath.length + 1) : f))
    .filter((f) => !f.startsWith('/'));
  if (!rels.length) return;
  const sha = commitAt(repoPath, iso);
  if (!sha) return;

  cases.push({
    instance_id: `${agent}__${id}`,
    repo: `local/${repoPath.split('/').pop()}`,
    repo_path: repoPath,
    base_commit: sha,
    problem_statement: prompt.slice(0, 4000),
    // Shaped like a SWE-bench patch so bench/swebench.mjs scores it unmodified.
    patch: rels.map((r) => `diff --git a/${r} b/${r}`).join('\n') + '\n',
    test_patch: '',
    agent,
    at: iso,
  });
  stats.kept++;
}

// ---------------------------------------------------------------- Claude Code
// live layout has project slugs directly under ARCHIVE; archived layout nests them
const ccRoot = existsSync(join(ARCHIVE, 'claude-code')) ? join(ARCHIVE, 'claude-code') : ARCHIVE;
if (existsSync(ccRoot)) {
  for (const slug of readdirSync(ccRoot)) {
    if (/scratchpad|swebench|-private-tmp/.test(slug)) continue;   // my own harness runs
    const dir = join(ccRoot, slug);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      stats.sessions++;
      let pending = null;   // the prompt awaiting the edits it caused
      let repoPath = null;  // from the record's own cwd, refreshed per record
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        stats.records++;
        repoPath = dirOf(rec) ?? repoPath;
        const msg = rec.message ?? {};
        if (rec.type === 'user') {
          // Tool results and hook injections arrive here too; none were typed.
          if (rec.toolUseResult != null || rec.isMeta || rec.isCompactSummary) continue;
          const c = msg.content;
          let text = null;
          if (typeof c === 'string') text = c;
          else if (Array.isArray(c)) {
            if (c.some((x) => x?.type === 'tool_result')) continue;
            text = c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ');
          }
          if (!text?.trim()) continue;
          if (pending) emit(pending.text, pending.files, repoPath, pending.iso, 'cc', pending.id);
          stats.prompts++;
          pending = { text: text.trim(), files: [], iso: rec.timestamp, id: `${f.slice(0, 8)}-${stats.prompts}` };
        }
        if (Array.isArray(msg.content) && pending) {
          for (const c of msg.content) {
            if (c?.type === 'tool_use' && ['Edit', 'Write', 'NotebookEdit'].includes(c.name)) {
              const fp = c.input?.file_path;
              if (fp) pending.files.push(fp);
            }
          }
        }
      }
      if (pending) emit(pending.text, pending.files, repoPath, pending.iso, 'cc', pending.id);
    }
  }
}

// ---------------------------------------------------------------------- Codex
const cxRoot = join(ARCHIVE, 'codex');
const walk = (d) => {
  const out = [];
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
};
for (const f of walk(cxRoot)) {
  stats.sessions++;
  let cwd = null, pending = null, n = 0;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    stats.records++;
    const p = rec.payload ?? {};
    if (rec.type === 'session_meta') cwd = p.cwd ?? cwd;
    if (rec.type === 'turn_context' && !cwd) cwd = p.cwd ?? null;
    if (rec.type === 'event_msg' && p.type === 'user_message') {
      const msg = p.message ?? '';
      if (!msg.trim() || msg.startsWith('<environment_context>') || msg.startsWith('<user_instructions>')) continue;
      if (pending) emit(pending.text, pending.files, cwd, pending.iso, 'codex', pending.id);
      stats.prompts++; n++;
      pending = { text: msg.trim(), files: [], iso: rec.timestamp, id: `${n}-${f.slice(-12, -6)}` };
    }
    if (pending) {
      const s = JSON.stringify(p);
      if (s.includes('apply_patch')) {
        for (const m of s.matchAll(/\*\*\* (?:Update|Add) File: (.+?)\\n/g)) {
          pending.files.push(m[1].startsWith('/') ? m[1] : join(cwd ?? '', m[1]));
        }
      }
    }
  }
  if (pending) emit(pending.text, pending.files, cwd, pending.iso, 'codex', pending.id);
}

if (CLONE_TO) {
  const root = resolve(CLONE_TO.replace(/^~/, homedir()));
  mkdirSync(root, { recursive: true });

  /** Sessions often run in a SUBDIRECTORY of a repo; git clone needs the root. */
  const topOf = (dir) => {
    try {
      return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { return null; }
  };

  const cloned = new Map();   // repo root -> clone path (or null if it failed)
  for (const c of cases) {
    const top = topOf(c.repo_path);
    if (!top) { c.repo_path = null; continue; }
    if (!cloned.has(top)) {
      const name = top.split('/').filter(Boolean).slice(-2).join('__').replace(/[^\w.-]/g, '_');
      const dest = join(root, name);
      if (!existsSync(dest)) {
        process.stderr.write(`  cloning ${top.replace(homedir(), '~')}\n`);
        try {
          // --no-hardlinks so the copy shares no object files with the source.
          execFileSync('git', ['clone', '--quiet', '--no-hardlinks', top, dest],
            { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) { process.stderr.write(`    FAILED ${String(e).slice(0, 80)}\n`); }
      }
      cloned.set(top, existsSync(dest) ? dest : null);
    }
    const clone = cloned.get(top);
    // Preserve the subdirectory the session actually ran in.
    c.repo_path = clone ? join(clone, c.repo_path.slice(top.length).replace(/^\//, '')) : null;
  }

  // Fail closed: an example that still names a real path is dropped, not shipped.
  const before = cases.length;
  for (let i = cases.length - 1; i >= 0; i--) {
    const rp = cases[i].repo_path;
    if (!rp || !rp.startsWith(root) || !existsSync(rp)) cases.splice(i, 1);
  }
  const ok = [...cloned.values()].filter(Boolean).length;
  console.log(`\n  cloned ${ok}/${cloned.size} repositories to ${root.replace(homedir(), '~')}`);
  console.log(`  dropped ${before - cases.length} examples whose clone failed — no real path ships`);
  console.log('  the corpus points only at clones; the scorer can never reach your working repos');
}

writeFileSync(OUT, JSON.stringify(cases, null, 1));

const byRepo = {}, byAgent = {};
for (const c of cases) { byRepo[c.repo] = (byRepo[c.repo] ?? 0) + 1; byAgent[c.agent] = (byAgent[c.agent] ?? 0) + 1; }
const goldOf = (c) => [...c.patch.matchAll(/a\/(\S+) b\//g)].map((m) => m[1]);
const meanGold = cases.length ? cases.reduce((s, c) => s + goldOf(c).length, 0) / cases.length : 0;
const isTest = (p) => /(^|\/)(tests?|__tests__|spec)\/|test_[^/]*$|[._-](test|spec)\.[a-z]+$/i.test(p);
const tests = cases.filter((c) => goldOf(c).some(isTest)).length;

console.log(`\n  sessions read      ${stats.sessions}`);
console.log(`  human prompts      ${stats.prompts}`);
console.log(`  usable examples    ${stats.kept}   ->  ${OUT}\n`);
console.log(`  dropped:  no edit ${stats.dropNoEdit}   multi-file ${stats.dropMultiFile}   ` +
            `too short ${stats.dropShort}   follow-up ${stats.dropFollowup}   ` +
            `non-code ${stats.dropNonCode}   contaminated ${stats.dropContaminated}   ` +
            `thin/conversational ${stats.dropThin}`);
if (CONTAMINATED.size) {
  console.log(`\n  prepass was already registered in these repos (sessions after that date excluded):`);
  for (const [d, when] of CONTAMINATED) console.log(`    ${d}  since ${when.toISOString().slice(0, 10)}`);
}
console.log(`\n  by agent: ${JSON.stringify(byAgent)}`);
console.log(`  repositories: ${Object.keys(byRepo).length}   mean gold files: ${meanGold.toFixed(2)}`);
for (const [r, n] of Object.entries(byRepo).sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`    ${String(n).padStart(4)}  ${r}`);
console.log(`\n  ${tests} of ${cases.length} answers (${Math.round((tests / Math.max(1, cases.length)) * 100)}%) are TEST files` +
            (tests ? ' — unlike SWE-bench, this corpus can penalise demoting tests.' : ''));
if (VERBOSE) for (const c of cases.slice(0, 5))
  console.log(`\n  "${c.problem_statement.slice(0, 90).replace(/\n/g, ' ')}"\n     -> ${goldOf(c).join(', ')}`);
