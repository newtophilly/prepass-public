#!/usr/bin/env node
/**
 * Would a hint fired at the moment of file creation have been right?
 *
 *     node bench/post-write.mjs [--archive <transcripts dir>] [--top 3]
 *
 * ## Why this harness is different
 *
 * Every other measurement here asks "given the prompt, which file matters?" —
 * a question answered before the work starts. This one asks a question that can
 * only be answered *during* the work: the agent has just written a new file, so
 * what does it have to edit next to wire that file up?
 *
 * That difference matters because three separate attempts to predict creation
 * intent from a prompt all failed — a verb/noun regex fires on 2.5% of real
 * prompts, the score distribution separates the classes at AUC 0.50, and
 * "does the name already exist" at 0.49. The intent is not in the prompt. But
 * `PostToolUse` does not have to infer it: the file is on disk, so the event
 * *is* the signal.
 *
 * Both agents can carry it. Codex aliases `apply_patch` to `Write`/`Edit`
 * (`codex-rs/core/src/tools/hook_names.rs`), so one matcher serves both.
 *
 * ## What is scored
 *
 * Strictly in tool-call order within a turn. A registry edit that happened
 * BEFORE the file was created is not something a post-write hint could have
 * helped with, and counting it would flatter the design.
 *
 *     write Episode008.tsx        <- the hint fires here
 *     edit  Root.tsx              <- did the hint name this file?
 *
 * Three numbers decide whether the feature is worth building:
 *
 *   coverage   how often a creation is followed by an edit to an existing file.
 *              When it is not, the right behaviour is silence.
 *   hit@k      of those, how often the suggestion names the right file. `k` is
 *              small on purpose — an injected line can name 3 files, not 20.
 *   noise      how often a suggestion is offered when nothing needed editing.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, resolve } from 'node:path';
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
const TOP = Number(arg('--top', '3'));
const VERBOSE = args.includes('--verbose');

const CODE = /\.(py|js|ts|tsx|jsx|go|rs|java|rb|php|c|h|cc|cpp|swift|kt|scala|cs|m|mm|vue|svelte)$/i;

/**
 * Ordered tool events per turn: { kind: 'write' | 'edit', path }.
 * Order is the whole point, so these are appended as encountered, never grouped.
 */
function claudeTurns(root) {
  const turns = [];
  if (!existsSync(root)) return turns;
  for (const slug of readdirSync(root)) {
    if (/scratchpad|swebench|-private-tmp/.test(slug)) continue;
    const dir = join(root, slug);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      let cur = null, cwd = null;
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (typeof rec.cwd === 'string') cwd = rec.cwd;
        const msg = rec.message ?? {};
        if (rec.type === 'user' && rec.toolUseResult == null && !rec.isMeta) {
          if (cur?.events.length) turns.push(cur);
          cur = { cwd, events: [] };
        }
        if (Array.isArray(msg.content) && cur) {
          for (const c of msg.content) {
            if (c?.type !== 'tool_use') continue;
            const fp = c.input?.file_path;
            if (!fp || !CODE.test(fp)) continue;
            if (c.name === 'Write') cur.events.push({ kind: 'write', path: fp });
            else if (c.name === 'Edit' || c.name === 'NotebookEdit') cur.events.push({ kind: 'edit', path: fp });
          }
        }
      }
      if (cur?.events.length) turns.push(cur);
    }
  }
  return turns;
}

/** Codex: one apply_patch can add and update several files; the patch text says which. */
function codexTurns(root) {
  const turns = [];
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
  for (const f of walk(root)) {
    let cur = null, cwd = null;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      const p = rec.payload ?? {};
      if (rec.type === 'session_meta') cwd = p.cwd ?? cwd;
      if (rec.type === 'turn_context' && !cwd) cwd = p.cwd ?? cwd;
      if (rec.type === 'event_msg' && p.type === 'user_message') {
        if (cur?.events.length) turns.push(cur);
        cur = { cwd, events: [] };
      }
      if (cur) {
        const s = JSON.stringify(p);
        if (!s.includes('apply_patch')) continue;
        // Preserve order within the patch: Add and Update interleave meaningfully.
        for (const m of s.matchAll(/\*\*\* (Add|Update) File: (.+?)\\n/g)) {
          if (!CODE.test(m[2])) continue;
          cur.events.push({ kind: m[1] === 'Add' ? 'write' : 'edit', path: m[2] });
        }
      }
    }
    if (cur?.events.length) turns.push(cur);
  }
  return turns;
}

/** What prepass would suggest, given only the path just written. */
function suggest(repo, createdRel) {
  const dir = dirname(createdRel);
  let sibs = [];
  try {
    sibs = readdirSync(join(repo, dir))
      .filter((f) => CODE.test(f) && f !== basename(createdRel))
      .map((f) => (dir === '.' ? f : `${dir}/${f}`));
  } catch { return { registries: [], siblings: [] }; }
  if (!sibs.length) return { registries: [], siblings: [] };

  const names = [...new Set(sibs.map((s) => basename(s).replace(/\.[a-z]+$/i, '')))].slice(0, 40);
  let registries = [];
  try {
    const pattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    registries = execFileSync('rg', ['-l', '--no-messages', '--max-filesize', '2M', '-e', pattern, '.'],
      { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      .split('\n').filter(Boolean)
      .map((p) => (p.startsWith('./') ? p.slice(2) : p))
      .filter((p) => p !== createdRel && !sibs.includes(p));
  } catch { /* no ripgrep, or nothing matched */ }
  return { registries, siblings: sibs };
}

const repoCache = new Map();
const repoOf = (cwd) => {
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let r = null;
  try {
    r = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { /* not a repo */ }
  repoCache.set(cwd, r);
  return r;
};

const turns = [
  ...claudeTurns(existsSync(join(ARCHIVE, 'claude-code')) ? join(ARCHIVE, 'claude-code') : ARCHIVE),
  ...codexTurns(join(ARCHIVE, 'codex')),
];

let creations = 0, followed = 0, silent = 0, noSuggestion = 0;
let hitTop = 0, hitAny = 0, ranks = [];
const examples = [], misses = [];

for (const t of turns) {
  if (!t.cwd) continue;
  const repo = repoOf(t.cwd);
  if (!repo) continue;
  const rel = (p) => (p.startsWith('/') ? p.replace(repo + '/', '') : p);

  t.events.forEach((ev, i) => {
    if (ev.kind !== 'write') return;
    const created = rel(ev.path);
    if (created.startsWith('/')) return;
    creations++;

    // Only what happened AFTER this write, in this turn.
    const after = t.events.slice(i + 1).filter((e) => e.kind === 'edit').map((e) => rel(e.path));
    const gold = [...new Set(after)].filter((p) => p !== created && !p.startsWith('/'));

    const { registries, siblings } = suggest(repo, created);
    const offered = [...registries.slice(0, TOP)];

    if (!gold.length) {
      silent++;
      if (offered.length) noSuggestion++;   // we would have spoken with nothing to say
      return;
    }
    followed++;
    if (!offered.length) { misses.push({ created, gold: gold[0], why: 'no registry found' }); return; }
    const idx = offered.findIndex((p) => gold.includes(p));
    const anyIdx = registries.findIndex((p) => gold.includes(p));
    if (idx >= 0) { hitTop++; ranks.push(idx + 1); }
    if (anyIdx >= 0) hitAny++;
    if (idx >= 0 && examples.length < 5) examples.push({ created, named: offered[idx], at: idx + 1 });
    if (idx < 0 && misses.length < 5) misses.push({ created, gold: gold[0], offered: offered.slice(0, 2), why: 'wrong file suggested' });
  });
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');
console.log(`\n  ${turns.length} turns · ${creations} file creations across both agents\n`);
console.log(`  COVERAGE  an existing file was edited after the write : ${followed}/${creations}  (${pct(followed, creations)}%)`);
console.log(`            nothing followed — correct behaviour is silence : ${silent}`);
console.log();
console.log(`  ACCURACY  of the ${followed} that needed a follow-up edit:`);
console.log(`            the right file was in the top ${TOP}          : ${hitTop}  (${pct(hitTop, followed)}%)`);
console.log(`            the right file was anywhere in the list  : ${hitAny}  (${pct(hitAny, followed)}%)`);
if (ranks.length) {
  ranks.sort((a, b) => a - b);
  console.log(`            median rank when found                   : ${ranks[ranks.length >> 1]}`);
}
console.log();
console.log(`  NOISE     would have spoken with nothing to fix        : ${noSuggestion}/${silent}  (${pct(noSuggestion, silent)}% of silent cases)`);

if (VERBOSE) {
  if (examples.length) {
    console.log(`\n  correct hints:`);
    for (const e of examples) console.log(`    wrote ${e.created}\n       -> named ${e.named}  (position ${e.at})`);
  }
  if (misses.length) {
    console.log(`\n  misses:`);
    for (const m of misses) console.log(`    wrote ${m.created}\n       needed ${m.gold}  [${m.why}]`);
  }
}
