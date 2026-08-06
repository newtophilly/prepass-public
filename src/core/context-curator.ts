/**
 * Context curation: turn a pile of candidate files into a lean XML payload.
 *
 * Drop candidates the workload excludes, score the rest by relevance to the
 * prompt (file names, a nudge for living where source usually lives, plus a
 * bounded read of their contents), and keep the top `maxFiles`. Entirely
 * deterministic and offline.
 *
 * The final payload is a compact XML document safe to prepend to the user's
 * prompt.
 */
import type { ContextCandidate, CurationResult, Taxonomy } from '../types.js';
import { closeSync, openSync, readSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import type { SmartConfig } from '../schemas/config.js';
import { log } from './telemetry.js';
import { estimateTokens } from '../tokens.js';
import { expandTerms, type Glossary, type WeightedTerm } from '../glossary.js';

export interface CurateInput {
  readonly prompt: string;
  readonly candidates: readonly ContextCandidate[];
  readonly taxonomy: Taxonomy;
  /** Base for resolving relative candidate paths during the content pass. */
  readonly rootDir?: string;
  /** Term bridges between the prompt's vocabulary and the code's. */
  readonly glossary?: Glossary;
  /** Facts about the project the agent would otherwise spend a turn asking for. */
  readonly repo?: RepoFacts;
}

/**
 * Rank the candidates and build the payload. Deterministic and offline — no
 * network call, no credentials, no per-invocation cost.
 */
export function curate(input: CurateInput, config: SmartConfig): CurationResult {
  const { taxonomy } = input;

  // Below the threshold, say nothing at all. Emitting "here are 6 files, but
  // I'm not confident" still costs tokens and still pollutes the window; the
  // honest move on a repo the agent can simply read is to get out of the way.
  if (input.candidates.length < config.curation.minFiles) {
    log('info', 'curation.skipped_small_repo', {
      candidates: input.candidates.length,
      minFiles: config.curation.minFiles,
    });
    return buildResult(taxonomy.workload, [], 'heuristic', config, 'repo-too-small', input.repo);
  }

  const selected = runHeuristicStage(input, config);

  // Selecting nothing from a non-empty pool is always a defect — a bad glob, a
  // layout we mis-handle — and it is invisible otherwise: the hook exits 0 and
  // contributes an empty payload, which reads exactly like success. Say so.
  if (selected.length === 0 && input.candidates.length > 0) {
    log('warn', 'curation.empty', {
      workload: taxonomy.workload,
      candidates: input.candidates.length,
      excludeGlobs: taxonomy.curationStrategy.excludeGlobs,
      hint: 'every candidate was excluded — check the taxonomy excludeGlobs',
    });
  }

  return buildResult(
    taxonomy.workload,
    selected,
    'heuristic',
    config,
    config.curation.enabled ? undefined : 'disabled',
    input.repo,
  );
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — heuristic filter + score                                          */
/* -------------------------------------------------------------------------- */

/** Exported for unit testing in isolation. */
export function runHeuristicStage(
  input: CurateInput,
  config?: SmartConfig,
  /** When supplied, records where each file's points came from — see `explainRanking`. */
  provenance?: Map<string, ScoreContribution[]>,
): ContextCandidate[] {
  const { candidates, taxonomy, prompt } = input;
  const strat = taxonomy.curationStrategy;
  const promptTokens = tokenize(prompt);

  const eligible = candidates.filter((c) => !matchesAnyGlob(c.path, strat.excludeGlobs));
  const typed = [...promptTokens].filter((t) => t.length > 3);
  // Glossary expansions ride alongside the words you typed at reduced weight —
  // they can lift a file that keyword matching could never reach, but never
  // outrank a file matching what you actually said.
  const weighted = expandTerms(typed, input.glossary ?? {});
  const terms = weighted.map((w) => w.term);

  // How often each term occurs inside each file. Empty when content scanning is
  // off or there is no root to scan — BM25 then runs on the path fields alone.
  const bodyTf =
    config?.curation.contentScan && input.rootDir
      ? termFrequencies(terms, eligible, input.rootDir, config)
      : new Map<string, Map<string, number>>();

  const recency = recencyBoosts(eligible, config?.curation.recencyWeight ?? RECENCY_WEIGHT);
  const focused = mostDiscriminating(weighted, bodyTf, eligible.length, config?.curation.maxQueryTerms ?? MAX_QUERY_TERMS);

  const prose = config?.curation.proseWeight ?? 1;
  const testW = config?.curation.testWeight ?? 1;
  const rank = (t: readonly WeightedTerm[], tf: ReadonlyMap<string, ReadonlyMap<string, number>>) =>
    scoreBm25f(eligible, t, tf, config?.curation.bm25, provenance)
      .map((c) => ({
        ...c,
        score:
          c.score * proseFactor(c.path, prose, testW) +
          sourceHintBoost(c.path, strat.includeGlobs) +
          (recency.get(c.path) ?? 0),
      }))
      .sort((a, b) => b.score - a.score);

  let ranked = rank(focused, bodyTf);

  // Second pass: let the code's own vocabulary join the query.
  const prf = config?.curation.feedback;
  if (prf && prf.docs > 0 && prf.terms > 0 && input.rootDir && config?.curation.contentScan) {
    const learned = feedbackTerms(ranked.slice(0, prf.docs), input.rootDir, focused, prf);
    if (learned.length > 0) {
      const combined = [...focused, ...learned];
      const withFeedback = termFrequencies(
        combined.map((t) => t.term),
        eligible,
        input.rootDir,
        config,
      );
      ranked = rank(combined, withFeedback);
    }
  }

  return ranked.slice(0, strat.maxFiles);
}

/* -------------------------------------------------------------------------- */
/* Ranking — BM25F                                                             */
/* -------------------------------------------------------------------------- */

/**
 * BM25 tuning constants. These are the textbook defaults and are deliberately
 * not hand-tuned: this project has no labelled set yet, so any value picked by
 * eye would be fitted to whichever prompt was last looked at.
 */
const BM25_DEFAULTS = {
  k1: 1.2,
  b: 0.5,
  basenameWeight: 4,
  dirnameWeight: 4,
  /** Both off by default: the shipped behaviour is the measured one. */
  dirWithBasename: 0,
  collisionAdapt: 0,
} as const;

/**
 * Prose that lives in the repo — documentation, guides, release notes.
 *
 * A bug report is prose describing a feature. A project's own docs are prose
 * describing that same feature, in the same vocabulary, at length. So on a
 * natural-language query the docs beat the source on lexical match every time:
 * they are the better answer to the question *as asked*, and the wrong file to
 * change. Measured on Django, which ships its manual in-tree, documentation is
 * 8% of the repository and took **60%** of the shortlist, while `django/` —
 * where every gold patch lands — got 21%.
 *
 * Extensions alone miss it: Django's docs are `.txt`, which is also how plenty
 * of fixtures and data files are named. The directory is the reliable signal.
 */
const DOC_DIR = /(?:^|\/)(?:docs?|documentation|guides?|manual|examples?)\//i;

/**
 * Tests: the largest measured occupant of the shortlist that is almost never
 * the file you need to change.
 *
 * Measured across 300 SWE-bench Lite issues: test files were **27.2% of every
 * top-20 and 25.9% of the top-5**. They rank because they are written about the
 * same feature, in the same vocabulary, at length — the identical mechanism
 * that made in-repo documentation crowd the list.
 *
 * ⚠️ The benchmark cannot justify discounting them. SWE-bench separates the
 * graded fix (`patch`) from its tests (`test_patch`) *by construction*, so gold
 * is never a test there — while in reality all 300 of those fixes did come with
 * test changes. Tuning on that number would be fitting to an artifact.
 *
 * The justification is redundancy instead: a test's path is derivable from the
 * source path by convention — `printing/mathematica.py` implies
 * `printing/tests/test_mathematica.py`. A slot spent on a file the agent can
 * name for itself is a slot wasted, whether or not it eventually edits it.
 * Hence a discount rather than an exclusion, and configurable, because a prompt
 * that is genuinely *about* a failing test wants them back.
 */
const TEST_PATH =
  /(?:^|\/)(?:tests?|testing|spec|specs|__tests__)\/|(?:^|\/)test_[^/]*$|[._-]test\.[a-z]+$|[._-]spec\.[a-z]+$|(?:^|\/)conftest\.py$/i;
const DOC_EXT = /\.(?:md|mdx|rst|txt|adoc|asciidoc|org|tex)$/i;

/**
 * Superseded copies: `.bak`, `.bak6`, `.orig`, `.old`, `file~`.
 *
 * Extension only, never the filename. A tempting rule is to discount names
 * ending " 2" as Finder duplicates — and on a real project that rule would have
 * demoted `SettingsView 2.swift`, which its author is actively editing. The
 * suffix means nothing; the extension is a convention.
 */
const SUPERSEDED_EXT = /(?:\.(?:bak\d*|orig|old|save|swp|rej)|~)$/i;

function isProse(path: string): boolean {
  return DOC_DIR.test(path) || DOC_EXT.test(path);
}

/**
 * Discount prose rather than removing it.
 *
 * Removing files was tried on Django's 2,285 translation catalogues and made
 * things measurably *worse* (MRR 0.383 → 0.347): the pool is the corpus IDF is
 * computed from, so pruning it shifts every term's rarity. A multiplier keeps
 * the statistics intact and only changes where a file lands.
 *
 * 1 disables the discount; 0 is equivalent to exclusion.
 */
export function proseFactor(path: string, weight: number, testWeight = 1): number {
  const superseded = SUPERSEDED_EXT.test(path) ? weight : 1;
  const tests = TEST_PATH.test(path) ? testWeight : 1;
  return (isProse(path) ? weight : 1) * superseded * tests;
}

/**
 * How many query terms actually get to vote.
 *
 * A short prompt has a handful; a pasted GitHub issue with a stack trace and
 * three code blocks can produce hundreds, most of them boilerplate that appears
 * in half the repo. BM25 sums over every one, so a long query drowns its own
 * signal in terms that match everything.
 */
const MAX_QUERY_TERMS = 15;

/**
 * Keep the terms that actually distinguish files, drop the ones that match
 * everything.
 *
 * Rarity is measured against this repo, not a general word list: `render` is
 * noise in a template engine and signal in a physics library.
 *
 * A term no file contains is worthless, not specific — it cannot match anything
 * and simply occupies a slot. Ranking those first cost 13 points of hit@20 on
 * SWE-bench before the mistake was caught, so they now sort last.
 */
function mostDiscriminating(
  terms: readonly WeightedTerm[],
  bodyTf: ReadonlyMap<string, ReadonlyMap<string, number>>,
  poolSize: number,
  limit: number,
): WeightedTerm[] {
  if (terms.length <= limit) return [...terms];

  const df = new Map<string, number>();
  for (const row of bodyTf.values()) {
    for (const [t, f] of row) if (f > 0) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // A term matching more than this share of the repo tells us nothing.
  const ubiquitous = poolSize * 0.25;

  return [...terms]
    .sort((a, b) => {
      const da = df.get(a.term) ?? 0;
      const db = df.get(b.term) ?? 0;
      // Rarest first among terms that actually occur. Terms matching nothing
      // (df 0) or nearly everything sort to the back — both are dead weight.
      const rank = (d: number) => (d === 0 || d > ubiquitous ? Infinity : d);
      const diff = rank(da) - rank(db);
      return diff !== 0 ? diff : b.weight - a.weight;
    })
    .slice(0, limit);
}

/**
 * Rank candidates by BM25F — the standard document-ranking function, applied
 * over two fields: the file's path and its contents.
 *
 * It replaces a hand-rolled scheme that got all three of BM25's jobs wrong:
 *   - **Rarity.** Every matched term scored the same +0.75. On a 2,260-file iOS app, `departing`
 *     occurs in 1 file of 441 and `double` in 104 (it is Swift's numeric type),
 *     and they counted equally — so a near-unique pointer was drowned out by a
 *     language keyword. BM25 weights each term by how rare it is (IDF).
 *   - **Saturation.** The old boost capped at four distinct terms and ignored
 *     counts entirely, so dozens of files tied at the ceiling and the *filename*
 *     silently became the tiebreaker. BM25 curves off smoothly instead.
 *   - **Length.** A flat −0.15 byte penalty punished large files, which is where
 *     core logic usually lives. BM25 normalises against mean length properly.
 */
/**
 * Where a file's points came from. Collected only when a sink is supplied, so
 * `explain --why` and the ranking itself cannot drift apart — there is one
 * implementation of the arithmetic, not two.
 */
export interface ScoreContribution {
  readonly term: string;
  readonly field: 'filename' | 'directory' | 'contents';
  readonly count: number;
  readonly docFreq: number;
  readonly points: number;
}

export function scoreBm25f(
  candidates: readonly ContextCandidate[],
  terms: readonly WeightedTerm[],
  bodyTf: ReadonlyMap<string, ReadonlyMap<string, number>>,
  tuning: SmartConfig['curation']['bm25'] = BM25_DEFAULTS,
  /**
   * Optional: filled with a per-file breakdown of the score.
   *
   * This used to be a second copy of the whole function in `explain-ranking.ts`,
   * on the theory that provenance would slow the hot path. Measured: 2.1ms
   * across 2,000 files, ~2% of a 105ms run, and zero when this is undefined.
   * The duplication drifted twice — once shipping a version of `explain --why`
   * that reported a ranking the tool did not use.
   */
  provenance?: Map<string, ScoreContribution[]>,
): ContextCandidate[] {
  const {
    k1: K1,
    b: B,
    basenameWeight: BASENAME_WEIGHT,
    dirnameWeight: DIRNAME_WEIGHT,
    dirWithBasename: DIR_WITH_BASENAME = 0,
    collisionAdapt: COLLISION_ADAPT = 0,
  } = tuning;
  if (terms.length === 0 || candidates.length === 0) {
    return candidates.map((c) => ({ ...c, score: 0 }));
  }

  // Body term frequencies only. Path hits are scored separately below rather
  // than folded in here: BM25 deliberately saturates term frequency, so adding
  // a large constant for a filename match is invisible — a swept comparison of
  // basename weights 8 through 40 produced byte-identical rankings. Saturation
  // is right for "this file mentions X a lot"; it is wrong for "this file is
  // NAMED X", which is a different kind of evidence and needs its own term.

  const n = candidates.length;

  // Rarity is computed per field, not once from the body.
  //
  // A filename match used to be weighted by how rare the term was *in file
  // contents*, which is the wrong question to ask about a filename. Django has
  // 6,712 files of which 66% share a basename with another — 628 `__init__.py`,
  // 209 `tests.py`, 194 `models.py` — so "matched the filename" carries almost
  // no information there, while in sympy (18% shared) it carries a lot. Judging
  // both by body frequency gave Django's ambiguous basenames the same credit as
  // sympy's distinctive ones, and Django is where ranking was worst: hit@1 11%
  // against sympy's 35%.
  //
  // Each field now knows how common a term is *within that field*, so a
  // basename shared by hundreds of files stops being treated as evidence.
  const bodyDf = new Map<string, number>();
  const baseDf = new Map<string, number>();
  const dirDf = new Map<string, number>();
  const fields = new Map<string, { base: Set<string>; dir: Set<string> }>();

  for (const c of candidates) {
    const slash = Math.max(c.path.lastIndexOf('/'), c.path.lastIndexOf('\\'));
    const base = tokenize(c.path.slice(slash + 1));
    const dir = tokenize(c.path.slice(0, Math.max(slash, 0)));
    fields.set(c.path, { base, dir });
    for (const t of terms) {
      if ((bodyTf.get(c.path)?.get(t.term) ?? 0) > 0) {
        bodyDf.set(t.term, (bodyDf.get(t.term) ?? 0) + 1);
      }
      if (base.has(t.term)) baseDf.set(t.term, (baseDf.get(t.term) ?? 0) + 1);
      if (dir.has(t.term)) dirDf.set(t.term, (dirDf.get(t.term) ?? 0) + 1);
    }
  }

  const idfOf = (df: Map<string, number>, t: string) => {
    const d = df.get(t) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };
  const avgLen = candidates.reduce((sum, c) => sum + Math.max(c.bytes, 1), 0) / Math.max(n, 1);

  // How much is a filename worth *in this repository*?
  //
  // Per-field IDF already discounts an individual common term. This asks the
  // other question: in a tree where 83% of files share a name with some other
  // file — measured on JS/TS, against 13% for PHP — is the basename field
  // worth trusting at all? hit@1 tracked that ratio across nine languages
  // (20.9% against 41.9%), which is what this is trying to answer.
  //
  // Off by default. Whether it beats per-field IDF alone is an open question:
  // reweighting cannot manufacture signal that generic names do not carry.
  let effBasenameWeight = BASENAME_WEIGHT;
  if (COLLISION_ADAPT > 0 && n > 0) {
    const seen = new Map<string, number>();
    for (const c of candidates) {
      const slash = Math.max(c.path.lastIndexOf('/'), c.path.lastIndexOf('\\'));
      const bn = c.path.slice(slash + 1).toLowerCase();
      seen.set(bn, (seen.get(bn) ?? 0) + 1);
    }
    let shared = 0;
    for (const count of seen.values()) if (count > 1) shared += count;
    const distinctiveness = 1 - shared / n; // 1.0 = every name unique
    effBasenameWeight = BASENAME_WEIGHT * (1 - COLLISION_ADAPT + COLLISION_ADAPT * distinctiveness);
  }

  return candidates.map((c) => {
    const { base: baseTokens, dir: dirTokens } = fields.get(c.path) ?? {
      base: new Set<string>(),
      dir: new Set<string>(),
    };
    const len = Math.max(c.bytes, 1);
    let score = 0;
    const note = provenance ? ([] as ScoreContribution[]) : undefined;
    if (note) provenance?.set(c.path, note);

    for (const { term, weight } of terms) {
      const f = bodyTf.get(c.path)?.get(term) ?? 0;
      if (f > 0) {
        const idf = idfOf(bodyDf, term);
        const pts = weight * ((idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / avgLen)));
        score += pts;
        note?.push({ term, field: 'contents', count: f, docFreq: bodyDf.get(term) ?? 0, points: pts });
      }
      // A filename is short and chosen on purpose, so a match there is evidence
      // of a different order from a mention buried in a large file — but only
      // when the name actually distinguishes it from its neighbours.
      //
      // When the directory agrees with the filename, that agreement is itself
      // evidence: `billing/payments/RetryHandler.swift` matching "payment" in
      // both places is a better answer than either signal alone. The old code
      // was `if basename else directory`, which discarded the weaker half of
      // exactly the cases where confidence should be highest.
      const inBase = baseTokens.has(term);
      const inDir = dirTokens.has(term);
      if (inBase) {
        const pts = weight * idfOf(baseDf, term) * effBasenameWeight;
        score += pts;
        note?.push({ term, field: 'filename', count: 1, docFreq: baseDf.get(term) ?? 0, points: pts });
      }
      if (inDir && (!inBase || DIR_WITH_BASENAME > 0)) {
        const pts =
          weight * idfOf(dirDf, term) * DIRNAME_WEIGHT * (inBase ? DIR_WITH_BASENAME : 1);
        score += pts;
        note?.push({ term, field: 'directory', count: 1, docFreq: dirDf.get(term) ?? 0, points: pts });
      }
    }
    return { ...c, score };
  });
}

/**
 * How much the newest file in the pool gains over the oldest.
 *
 * This is the signal an agent is reaching for when it runs `git status` before
 * doing anything else: what is in flux right now is overwhelmingly likely to be
 * what the question is about. Reading it from file mtimes rather than git means
 * it also works in a directory that was never a repository — which is exactly
 * where an agent's `git status` fails and costs a wasted round trip.
 *
 * Deliberately modest, and a boost rather than a filter. Recency is a prior,
 * not evidence: the file you edited last is often relevant and sometimes has
 * nothing to do with anything.
 */
const RECENCY_WEIGHT = 0;

/**
 * Rank candidates by age and spread `weight` across them, newest first.
 *
 * Ranks rather than raw timestamps on purpose: absolute ages are wildly
 * repo-dependent — a freshly cloned tree has every file within a second of
 * every other — whereas "newer than most of its neighbours" means the same
 * thing everywhere.
 */
function recencyBoosts(
  candidates: readonly ContextCandidate[],
  weight: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const dated = candidates.filter((c) => typeof c.mtimeMs === 'number');
  if (dated.length < 2 || weight <= 0) return out;

  const byNewest = [...dated].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  const n = byNewest.length;
  byNewest.forEach((c, i) => {
    // Front-loaded: the handful of genuinely recent files get most of it, and
    // the long tail of untouched files is left alone rather than penalised.
    out.set(c.path, weight * (1 - i / (n - 1)) ** 3);
  });
  return out;
}

/**
 * Harvest vocabulary from the files the first pass liked best.
 *
 * This is the discipline's own answer to the vocabulary gap, and it needs no
 * model, no index and no download. You say *"notifications fire twice"*; the
 * code says `dedup`, `debounce`, `didEnterRegion`. Lexical matching cannot
 * cross that on its own — the words are simply not in the file. But the files
 * that *did* match your words are written in the code's dialect, so reading
 * them and adding their distinctive terms to the query lets a second pass reach
 * files the first could never see.
 *
 * Known as pseudo-relevance feedback: it assumes the top results are roughly
 * relevant and mines them for better query terms. The assumption is sometimes
 * wrong, which is why expansion terms carry reduced weight and never displace
 * what the user actually typed — the same rule the glossary follows.
 *
 * No rarity filtering is applied here on purpose. The second BM25 pass computes
 * IDF over these terms anyway, so a term common to the whole repo earns a low
 * weight by itself rather than needing to be guessed at in advance.
 */
function feedbackTerms(
  top: readonly ContextCandidate[],
  rootDir: string,
  existing: readonly WeightedTerm[],
  cfg: { docs: number; terms: number; weight: number; bytes: number },
): WeightedTerm[] {
  const seen = new Set(existing.map((t) => t.term));
  const counts = new Map<string, number>();

  for (const c of top) {
    let head: string;
    try {
      const fd = openSync(isAbsolute(c.path) ? c.path : join(rootDir, c.path), 'r');
      try {
        const buf = Buffer.alloc(Math.min(cfg.bytes, c.bytes || cfg.bytes));
        const read = readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, read).toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    // Count each term once per file: a token repeated three hundred times in
    // one file is a property of that file, not evidence about the query.
    for (const t of tokenize(head)) {
      if (t.length <= 3 || seen.has(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cfg.terms)
    .map(([term]) => ({ term, weight: cfg.weight }));
}

/**
 * Split text into lowercase identifier-ish tokens, breaking camelCase,
 * snake_case, kebab-case and dotted paths alike. `evaluateUnit` yields
 * `evaluate` and `unit` (plus the whole token), so a prompt naming a symbol can
 * match a file that defines it.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length > 2 && !STOP_WORDS.has(lower)) out.add(lower);
    // camelCase / PascalCase -> parts
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const p = part.toLowerCase();
      if (p.length > 2 && !STOP_WORDS.has(p)) out.add(p);
    }
  }
  return out;
}

/**
 * Words that appear in nearly every prompt and every path. Matching on them is
 * noise that drowns out the signal.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'where', 'when',
  'what', 'why', 'how', 'add', 'fix', 'get', 'set', 'use', 'run', 'new', 'all',
  'not', 'but', 'are', 'was', 'has', 'had', 'can', 'its', 'out', 'src', 'lib',
  'app', 'index', 'main', 'test', 'tests', 'ts', 'js', 'tsx', 'jsx', 'json',
]);

/**
 * How much a file gains for sitting where the workload expects source to live.
 *
 * `includeGlobs` used to be a hard gate, which quietly broke every project that
 * doesn't use `src/`, `lib/` or `app/` at the root: an iOS app (`AppName/Core/…`),
 * a Go service (`cmd/`, `internal/`), a Python package — every candidate was
 * filtered out and curation returned nothing at all, successfully. The globs
 * really encode "source usually lives here", which is a ranking hint, so that
 * is what they now are.
 *
 * Kept small on purpose: it should separate files that BM25 could not tell
 * apart, never outrank a real term match.
 */
const SOURCE_HINT_BOOST = 0.3;

export function sourceHintBoost(path: string, include: readonly string[]): number {
  if (include.length === 0) return 0;
  return matchesAnyGlob(path, include) ? SOURCE_HINT_BOOST : 0;
}

function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * How many times each prompt term occurs in each file.
 *
 * Prefers one ripgrep pass over the whole tree, falling back to reading each
 * candidate's head when `rg` isn't installed. The fallback is the weaker of the
 * two: it only ever sees the first `contentScanBytes` of a file, so logic
 * buried deep in a large one is invisible to scoring. Measured on a 2,260-file
 * Swift repo, that window ended at line 329 of a 233 KB file whose first
 * relevant mention was at line 387 — so the file that actually answered the
 * prompt scored zero and went uncurated.
 */
export function termFrequencies(
  terms: readonly string[],
  candidates: readonly ContextCandidate[],
  rootDir: string,
  config: SmartConfig,
): Map<string, Map<string, number>> {
  if (terms.length === 0) return new Map();
  return grepTermFrequencies(terms, rootDir) ?? headScanTermFrequencies(terms, candidates, rootDir, config);
}

/** Per-file, per-term match counts from one `rg` pass, or null if rg is unusable. */
function grepTermFrequencies(
  terms: readonly string[],
  rootDir: string,
): Map<string, Map<string, number>> | null {
  const args = ['--only-matching', '--no-heading', '--with-filename', '--fixed-strings',
    '--ignore-case', '--no-messages'];
  for (const t of terms) args.push('--regexp', t);
  args.push('.');

  let out: string;
  try {
    out = execFileSync('rg', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5_000,
    });
  } catch (err) {
    // Exit 1 just means "no file matched" — a real answer, not a failure. Any
    // other outcome (rg absent, timeout, output too large) falls back.
    const e = err as { status?: number };
    if (e.status === 1) return new Map();
    return null;
  }

  const tf = new Map<string, Map<string, number>>();
  for (const line of out.split('\n')) {
    const sep = line.lastIndexOf(':');
    if (sep <= 0) continue;
    const path = normalizeRel(line.slice(0, sep));
    const term = line.slice(sep + 1).toLowerCase();
    let row = tf.get(path);
    if (!row) tf.set(path, (row = new Map()));
    row.set(term, (row.get(term) ?? 0) + 1);
  }
  return tf;
}

/** `rg .` prefixes paths with `./`; candidate paths never do. */
function normalizeRel(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * Fallback for machines without ripgrep: count occurrences in a bounded head of
 * each file. Sees only the first `contentScanBytes`, so it under-counts large
 * files badly — which is exactly why `rg` is preferred.
 */
function headScanTermFrequencies(
  terms: readonly string[],
  candidates: readonly ContextCandidate[],
  rootDir: string,
  config: SmartConfig,
): Map<string, Map<string, number>> {
  const limit = config.curation.contentScanMaxFiles;
  const headBytes = config.curation.contentScanBytes;
  const tf = new Map<string, Map<string, number>>();

  candidates.slice(0, limit).forEach((c) => {
    let head: string;
    try {
      const fd = openSync(isAbsolute(c.path) ? c.path : join(rootDir, c.path), 'r');
      try {
        const buf = Buffer.alloc(Math.min(headBytes, c.bytes || headBytes));
        const read = readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, read).toString('utf8').toLowerCase();
      } finally {
        closeSync(fd);
      }
    } catch {
      return; // unreadable: no content signal, path fields still count
    }
    const row = new Map<string, number>();
    for (const term of terms) {
      let count = 0;
      for (let i = head.indexOf(term); i !== -1; i = head.indexOf(term, i + term.length)) count++;
      if (count > 0) row.set(term, count);
    }
    if (row.size > 0) tf.set(c.path, row);
  });
  return tf;
}

/** Very small glob matcher: supports `**`, `*`, and literal segments. */
export function matchesGlobs(
  path: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const included = include.length === 0 || include.some((g) => globToRegExp(g).test(path));
  const excluded = exclude.some((g) => globToRegExp(g).test(path));
  return included && !excluded;
}

/**
 * Compile a glob, scanning left to right so `**` always expands before `*`.
 *
 * The subtle case is a leading `**\/`, which must match *zero* directories as
 * well as many: `**\/*.md` means "any .md anywhere", including `README.md` at
 * the root. Expanding it to `.*\/` instead — as a naive split on `**` does —
 * silently requires at least one directory, so root-level files slip past every
 * exclude rule. That is how `**\/node_modules\/**` came to miss a root-level
 * `node_modules`.
 *
 * Matching is case-insensitive: the macOS and Windows filesystems this runs on
 * are, so `MASTER.MD` and `master.md` have to be the same file to a rule.
 */
function globToRegExp(glob: string): RegExp {
  let body = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      body += '(?:.*/)?'; // any number of leading directories, including none
      i += 3;
    } else if (glob.startsWith('**', i)) {
      body += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      body += '[^/]*';
      i += 1;
    } else {
      body += escapeRegExp(glob[i] as string);
      i += 1;
    }
  }
  return new RegExp(`^${body}$`, 'i');
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* -------------------------------------------------------------------------- */
/* Payload assembly                                                            */
/* -------------------------------------------------------------------------- */

function buildResult(
  workload: CurationResult['workload'],
  selected: readonly ContextCandidate[],
  stage: CurationResult['stage'],
  config: SmartConfig,
  degraded?: CurationResult['degraded'],
  repo?: RepoFacts,
): CurationResult {
  const trimmed = trimToTokenBudget(selected, config.curation.maxTokens);
  const payload = buildXmlPayload(trimmed, repo, degraded);
  return {
    workload,
    selected: trimmed,
    stage,
    payload,
    estimatedTokens: estimateTokens(payload),
    ...(degraded ? { degraded } : {}),
  };
}

/** Keep adding files until the estimated token budget is exhausted. */
function trimToTokenBudget(
  selected: readonly ContextCandidate[],
  maxTokens: number,
): ContextCandidate[] {
  const kept: ContextCandidate[] = [];
  let running = 0;
  for (const c of selected) {
    const cost = estimateTokens(c.content ?? c.path);
    if (running + cost > maxTokens && kept.length > 0) break;
    kept.push(c);
    running += cost;
  }
  return kept;
}

/**
 * How sure the ranker is that this selection is the right one.
 *
 * Derived from the *shape* of the score distribution, not absolute values, so
 * it survives a change of scoring function. If the selected files are all
 * bunched together the ranker could not tell them apart and essentially picked
 * arbitrarily — which is precisely when the caller should not trust it.
 *
 * The thresholds are provisional: they are honest about the distribution but
 * have not been validated against a labelled set. Revisit once one exists.
 */
export function confidenceOf(selected: readonly ContextCandidate[]): 'low' | 'medium' | 'high' {
  const top = selected[0]?.score ?? 0;
  const last = selected[selected.length - 1]?.score ?? 0;
  if (selected.length < 2) return top > 0 ? 'medium' : 'low';
  if (top <= 0) return 'low'; // nothing matched the prompt at all
  const spread = (top - last) / top;
  if (spread < 0.15) return 'low';
  return spread >= 0.4 ? 'high' : 'medium';
}

/**
 * Assemble the selection as a compact, well-formed XML document.
 *
 * The wording is deliberate. This used to be emitted as `<curated-context>`,
 * which asserts that these files *are* the relevant ones — a claim a keyword
 * heuristic has not earned, and one that is actively dangerous on a prompt that
 * can edit: a plausible-but-wrong file (the notification *preferences* screen
 * when the bug is in the geofence handler) gets patched, compiles, and fixes
 * nothing. So it says candidates, states that they are guesses, and tells the
 * reader to verify before editing. Paths only — never contents by default —
 * because opening a file to use it is also what disproves a bad suggestion.
 */
export function buildXmlPayload(
  selected: readonly ContextCandidate[],
  repo?: RepoFacts,
  degraded?: CurationResult['degraded'],
): string {
  const files = selected
    .map(
      (c) =>
        `  <file path="${escapeXml(c.path)}" bytes="${c.bytes}" score="${c.score.toFixed(3)}">` +
        (c.content ? `\n${escapeXml(c.content)}\n  ` : '') +
        `</file>`,
    )
    .join('\n');
  const confidence = confidenceOf(selected);
  const note =
    selected.length === 0
      ? degraded === 'repo-too-small'
        ? 'Project is small enough to read directly — no shortlist offered. Search as you normally would.'
        : 'No candidates found — search as you normally would.'
      : `Ranked guesses from a keyword heuristic, most likely first — not a verified answer.` +
        ` Confidence ${confidence}.` +
        (confidence === 'low'
          ? ' These scored almost identically, so the order means little — search if none fit.'
          : '') +
        ' Open them to confirm before relying on or editing any of them.';
  return (
    `<candidate-files count="${selected.length}" confidence="${confidence}">\n` +
    `  <note>${escapeXml(note)}</note>\n` +
    repoLine(repo) +
    (files ? `${files}\n` : '') +
    `</candidate-files>`
  );
}

/** What we can tell the agent about the project without it having to ask. */
export interface RepoFacts {
  /** True when the candidate pool came from `git ls-files`. */
  readonly isGitRepo: boolean;
  /** Most recently modified candidates, newest first. */
  readonly recentlyChanged: readonly string[];
}

/**
 * One line answering the question every agent asks first.
 *
 * Both Claude Code and Codex reach for `git status` before doing anything else,
 * and they are right to: it is one cheap call that says what is in flux, which
 * is overwhelmingly what the question is about. But in a directory that was
 * never a repository it returns `fatal: not a git repository` — observed three
 * times across two real sessions on one project — and each failure is a full
 * round trip that teaches nothing and stays in the context window forever.
 *
 * So answer it in advance. `git="no"` stops the attempt, and the recent-file
 * list supplies the signal `git status` would have given, read from mtimes,
 * which works whether or not the directory is a repository.
 *
 * This is information, not ranking. Recency as a *scoring* boost was built,
 * swept against the labelled set and turned off — it never helped there. The
 * agent can weigh it; we should not pretend we have measured that it deserves
 * weight.
 */
function repoLine(repo?: RepoFacts): string {
  if (!repo) return '';
  const recent = repo.recentlyChanged.slice(0, 5);
  const attrs = [`git="${repo.isGitRepo ? 'yes' : 'no'}"`];
  if (recent.length > 0) attrs.push(`recently-changed="${escapeXml(recent.join(', '))}"`);
  return `  <repo ${attrs.join(' ')} />\n`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Aliases for the ranking explainer, which mirrors the scorer's arithmetic to
 * attribute a score rather than just produce one. Named exports so the
 * dependency is obvious: change the scorer, change the explainer.
 */
export { tokenize as tokenizeForExplain, termFrequencies as termFrequenciesForExplain };
