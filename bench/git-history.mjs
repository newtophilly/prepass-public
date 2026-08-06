#!/usr/bin/env node
/**
 * Build an evaluation corpus out of a repository's own git history.
 *
 *     node bench/git-history.mjs --repo <dir> [--limit 150] [--out corpus.json]
 *     node bench/swebench.mjs --repos <parent-dir> --data corpus.json
 *
 * ## Why this exists
 *
 * SWE-bench separates the graded fix (`patch`) from the tests that verify it
 * (`test_patch`), so **its answers are never test files** — verified across
 * three corpora: 0 of 300, 1 of 300, 0 of 407. That is a property of the
 * benchmark's construction, not of software repair: all 300 of those fixes
 * really did ship with test changes.
 *
 * The consequence is a trap. Anything that demotes test files scores better on
 * SWE-bench whether or not it helps a real user, and **a held-out SWE-bench
 * corpus does not protect you**, because every SWE-bench corpus shares the
 * split. Discounting tests measured +6 to +8 points of hit@1 across all three,
 * and the entire gain was the artifact.
 *
 * A commit is a different kind of label: a natural-language description written
 * by a developer, paired with exactly the files they changed — including tests,
 * because fixing a test is a real change. On sympy, **20% of the answers here
 * are test files**, which is what lets this corpus punish a change SWE-bench
 * would reward.
 *
 * Commit messages predict their files about as well as GitHub issues do —
 * hit@1 36.0% and MRR 0.455 here, against 34.3% and 0.468 on SWE-bench Lite —
 * so this is a fair proxy for the task, not a weaker one.
 *
 * ## What gets filtered, and why
 *
 * Most commits are unusable as labels. "Update mul.py", "Commit message", and
 * "Merge branch" say nothing a retriever could act on, and a commit touching 30
 * files has no single answer. Roughly 5% of history survives, which is still
 * hundreds of labelled examples in any mature repository — free, local, and in
 * the vocabulary that team actually uses.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const REPO = resolve(arg('--repo', ''));
const LIMIT = Number(arg('--limit', '150'));
const SCAN = Number(arg('--scan', '3000'));
const OUT = arg('--out', 'git-history-corpus.json');
/** Extensions counted as source. Anything else is ignored as a target. */
const CODE = /\.(py|js|ts|tsx|jsx|go|rs|java|rb|php|c|h|cc|cpp|swift|kt|scala|cs)$/i;

if (!arg('--repo', '')) {
  console.error('usage: node bench/git-history.mjs --repo <dir> [--limit 150] [--out file.json]');
  process.exit(2);
}

const git = (...a) =>
  execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const raw = git(
  'log', `-n`, String(SCAN), '--no-merges', '--format=@@@%H|%s|%b', '--name-only',
);

/** Messages that describe nothing a retriever could use. */
const USELESS = /^(update[sd]?|fix typo|typo|merge|bump|release|version|wip|cleanup|formatting|lint|style)\b/i;

const cases = [];
for (const chunk of raw.split('@@@').slice(1)) {
  const [head, ...rest] = chunk.trim().split('\n');
  const sep1 = head.indexOf('|');
  const sep2 = head.indexOf('|', sep1 + 1);
  if (sep1 < 0 || sep2 < 0) continue;
  const sha = head.slice(0, sep1);
  const subject = head.slice(sep1 + 1, sep2).trim();
  const body = head.slice(sep2 + 1);

  const files = rest.filter((f) => f.trim() && CODE.test(f));
  // One changed file, or the label is ambiguous.
  if (files.length !== 1) continue;
  const message = `${subject}\n${body}`.trim();
  // A message that is only a filename teaches a retriever to match filenames.
  if (message.length < 40) continue;
  if (USELESS.test(subject)) continue;
  if (/^\S+\.\w+$/.test(subject)) continue;

  cases.push({
    instance_id: `git__${sha.slice(0, 10)}`,
    repo: `local/${REPO.split('/').pop()}`,
    base_commit: `${sha}~1`,
    problem_statement: message,
    // Shaped like a SWE-bench patch so `swebench.mjs` scores it unmodified.
    patch: `diff --git a/${files[0]} b/${files[0]}\n`,
    test_patch: '',
  });
  if (cases.length >= LIMIT) break;
}

writeFileSync(OUT, JSON.stringify(cases, null, 1));

const isTest = (p) =>
  /(^|\/)(tests?|testing|spec|specs|__tests__)\/|(^|\/)test_[^/]*$|[._-]test\.[a-z]+$/i.test(p);
const tests = cases.filter((c) => isTest(/a\/(\S+)/.exec(c.patch)[1])).length;

console.log(`${cases.length} usable commits from ${SCAN} scanned  ->  ${OUT}`);
console.log(`${tests} of them (${Math.round((tests / cases.length) * 100)}%) have a TEST file as the answer.`);
console.log(
  tests === 0
    ? 'No test answers — this corpus cannot detect the SWE-bench test artifact. Scan deeper.'
    : 'Unlike SWE-bench, a change that demotes tests will be penalised here.',
);
