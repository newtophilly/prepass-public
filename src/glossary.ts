/**
 * The glossary: a bridge between how you describe a problem and how the code
 * spells it.
 *
 * Keyword ranking can only find words that are actually in the file. But you
 * say *"arriving"* and CoreLocation says `didEnterRegion`; you say *"double"*
 * and the code says `dedup`. No amount of clever weighting crosses that gap —
 * the term simply is not there. So the mapping has to be written down.
 *
 * It lives in a plain JSON file you can open, read and correct, which is the
 * point: a learned mapping that drifts is invisible inside a model and obvious
 * inside a file. Entries carry their `source` and, when inferred, the
 * `evidence` line they came from, so a wrong one can be traced and deleted.
 *
 * Expansions are always a *boost*, never a filter — a term you actually typed
 * outranks one we inferred on your behalf. That rule is not stylistic: gating
 * on an inferred signal is the exact failure that made this tool return nothing
 * on every non-Node project.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { log } from './core/telemetry.js';

export const GLOSSARY_FILENAME = '.prepass/glossary.json';

/**
 * Where an entry came from, in ascending order of how much it should be
 * trusted to be *wrong*: a human wrote `manual`, so it is never overwritten and
 * may veto the others.
 */
export const glossarySourceSchema = z.enum(['manual', 'mined', 'observed']);
export type GlossarySource = z.infer<typeof glossarySourceSchema>;

export const glossaryEntrySchema = z.object({
  /** Code-side terms this word should also look for. */
  expands: z.array(z.string().min(1)).default([]),
  source: glossarySourceSchema.default('manual'),
  /** `file:line` an inferred entry was derived from, so it can be checked. */
  evidence: z.string().optional(),
  /** How many times an inferred entry has been observed. */
  seen: z.number().int().nonnegative().optional(),
  /** Set to true to suppress a term entirely — a human veto. */
  disabled: z.boolean().default(false),
});
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

export const glossarySchema = z.record(z.string(), glossaryEntrySchema);
export type Glossary = z.infer<typeof glossarySchema>;

/** Walk up from `startDir` looking for the glossary, like config does. */
export function findGlossaryFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = resolve(dir, GLOSSARY_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load the glossary, or an empty one. A malformed glossary degrades to empty
 * and logs — a typo in a dictionary is never a reason to fail someone's prompt.
 */
export function loadGlossary(startDir: string = process.cwd()): Glossary {
  const path = findGlossaryFile(startDir);
  if (!path) return {};
  try {
    const parsed = glossarySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    log('debug', 'glossary.loaded', { path, terms: Object.keys(parsed).length });
    return parsed;
  } catch (err) {
    log('warn', 'glossary.invalid', { path, error: String(err) });
    return {};
  }
}

/**
 * Add mined proposals to the glossary without ever touching a human's entries.
 *
 * A `manual` entry is the one thing here that was written by someone who knows
 * the answer, so it is never overwritten and never merged into — including when
 * it is `disabled`, which is how a human says "this bridge is wrong, stop
 * suggesting it".
 */
export function appendProposals(
  startDir: string,
  existing: Glossary,
  proposals: readonly { term: string; expands: string[]; evidence: string; seen: number }[],
): number {
  const path = findGlossaryFile(startDir) ?? resolve(startDir, GLOSSARY_FILENAME);
  const next: Glossary = { ...existing };
  let added = 0;

  for (const p of proposals) {
    const prior = next[p.term];
    if (prior?.source === 'manual' || prior?.disabled) continue;
    next[p.term] = {
      expands: p.expands,
      source: 'mined',
      evidence: p.evidence,
      seen: p.seen,
      disabled: false,
    };
    added++;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return added;
}

/**
 * A term the ranker should search for, and how much to trust it.
 *
 * Words you typed carry full weight. Words we inferred on your behalf carry
 * less, so an inferred match can lift a file that would otherwise be invisible
 * without ever outranking a file that matches what you actually said.
 */
export interface WeightedTerm {
  readonly term: string;
  readonly weight: number;
  /** The prompt word this came from, or undefined when you typed it yourself. */
  readonly via?: string;
}

/**
 * How much an inferred term counts relative to one you actually typed.
 *
 * **Open question, surfaced by `prepass explain --why` and deliberately not
 * acted on.** The weight applies uniformly across fields, so an inferred term
 * that happens to match a *filename* can dominate: on one real prompt
 * `savedplace` — inferred from "home" — scored +12.51 from a filename match
 * alone, more than every content match on the file that was actually the
 * answer. A rare term times the filename multiplier is a big number even at
 * 0.55.
 *
 * Whether inferred terms should be capped in the path fields is untested: the
 * SWE-bench harness runs without a glossary, so it cannot measure this, and one
 * anecdote is not grounds for changing a scoring rule. Needs a labelled set
 * that exercises glossaries before anyone touches it.
 */
export const EXPANSION_WEIGHT = 0.55;

/**
 * Expand prompt terms through the glossary.
 *
 * Never removes a term and never replaces one — the original always survives at
 * full weight, so a glossary can only ever add reach. Duplicates keep their
 * strongest weight, so a word that is both typed and inferred counts as typed.
 */
export function expandTerms(terms: readonly string[], glossary: Glossary): WeightedTerm[] {
  const out = new Map<string, WeightedTerm>();
  const put = (t: WeightedTerm) => {
    const key = t.term.toLowerCase();
    const existing = out.get(key);
    if (!existing || t.weight > existing.weight) out.set(key, { ...t, term: key });
  };

  for (const term of terms) put({ term, weight: 1 });

  for (const term of terms) {
    // `Object.hasOwn`, not a plain lookup: a prompt containing `constructor`,
    // `toString`, `valueOf` or `hasOwnProperty` otherwise resolves against
    // Object.prototype, yielding a truthy value with no `expands` and crashing
    // the hook. Found by SWE-bench, where real bug reports say "constructor"
    // constantly and an eleven-case hand-written set never did.
    const key = term.toLowerCase();
    if (!Object.hasOwn(glossary, key)) continue;
    const entry = glossary[key];
    if (!entry || !Array.isArray(entry.expands) || entry.disabled) continue;
    for (const expansion of entry.expands) {
      put({ term: expansion, weight: EXPANSION_WEIGHT, via: term });
    }
  }
  return [...out.values()];
}
