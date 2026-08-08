/**
 * When the prompt asks for something that does not exist yet.
 *
 * ## The failure this fixes
 *
 * prepass ranks files that are on disk. "build the doctor command" names a file
 * that is not — so ranking it is a category error, not a near miss, and no
 * amount of scoring fixes it. Measured on 162 real prompts from agent history:
 * **13% ask for a file that did not exist**, and they account for **46% of all
 * failures**. On one project (a greenfield iOS app) every single prompt was a
 * creation request and prepass scored 0 for 5, while emitting a confident
 * shortlist each time. Across ten projects the correlation between "share of
 * creation prompts" and "hit@20" is **r = -0.82**.
 *
 * ## What is actually findable
 *
 * The new file is not, but something else is. Of 122 creation turns in that
 * history, **71% also edited a file that already existed** — and it is almost
 * always the thing that wires the new one up:
 *
 *     created Branding.tsx        -> also edited Root.tsx      (the registry)
 *     created compare-table.tsx   -> also edited page.tsx      (the caller)
 *     created trial.ts            -> also edited pricing.ts    (the sibling)
 *
 * So the useful answer to "add an episode" is not a guess at `Episode008.tsx`.
 * It is `EpisodeTemplate.tsx` to copy from and `Root.tsx` to register it in.
 *
 * ## How it finds them
 *
 *   1. ordinary ranking locates the neighbourhood
 *   2. the directories of the strongest hits give the siblings — what to copy
 *   3. whatever mentions those siblings by name is the registry — what to edit
 *
 * Step 3 is one ripgrep for the sibling basenames, the same mechanism the
 * ranker already uses for term frequencies.
 *
 * ## Measured
 *
 * On the 38 creation turns that also edited an existing file, scored against
 * the file the agent really changed:
 *
 *     ranking as it ships     73.7% in top 20    34.2% in top 5
 *     creation mode           84.2% in top 20    42.1% in top 5
 *
 * The dose matters. Putting six registries first scored 81.6/31.6 — it found
 * more and buried the good hits. Inserting after the top 3 keeps the strongest
 * ordinary match in place, which is why that is what ships.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { ContextCandidate } from '../types.js';

/**
 * Verbs that introduce something new, anchored to the start of a clause so
 * "I added a log line to debug the crash" does not read as creation.
 *
 * `add` and `make` are the ambiguous ones — "add a rate limiter" is creation,
 * "add a null check" is not. They only count alongside a noun that implies a
 * new artefact, which is what NEW_THING is for.
 */
const CREATE_VERB =
  /(?:^|[.;!?\n]\s*|\b(?:then|also|and|please|now|next)\s+)(create|build|scaffold|generate|implement|introduce|set\s+up|start)\b/i;

/** Nouns that mean "a new unit of code", not "a change to an existing one". */
const NEW_THING =
  /\b(new\s+\w+|component|page|screen|view|route|endpoint|module|service|command|helper|hook|model|migration|worker|job|script|layer|provider|adapter|class|struct|file)\b/i;

/** A literal filename in the prompt is the strongest signal there is. */
const NAMED_FILE = /\b[\w-]+\.(ts|tsx|js|jsx|swift|kt|py|go|rs|rb|java|php|cs|c|h|cpp|m|mm|vue|svelte)\b/i;

export interface CreationSignal {
  readonly creating: boolean;
  /** Filenames the prompt named explicitly, if any. */
  readonly named: readonly string[];
}

/**
 * Does this prompt ask for something that does not exist yet?
 *
 * Deliberately conservative: a false positive reorders a shortlist that was
 * probably fine, which is a small cost, but firing on every "add a null check"
 * would reorder most bug reports and that is a large one. Requires a creation
 * verb AND either a new-artefact noun or an explicit filename.
 */
export function detectCreationIntent(prompt: string): CreationSignal {
  const named = [...prompt.matchAll(new RegExp(NAMED_FILE, 'gi'))].map((m) => m[0]);
  const verb = CREATE_VERB.test(prompt);
  const thing = NEW_THING.test(prompt);
  return { creating: verb && (thing || named.length > 0), named };
}

/** Source files worth offering as a sibling to copy from. */
const CODE = /\.(py|js|ts|tsx|jsx|go|rs|java|rb|php|c|h|cc|cpp|swift|kt|scala|cs|m|mm|vue|svelte)$/i;

/** Every code file sitting beside the strongest hits. */
function siblingsOf(rootDir: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(join(rootDir, d));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (CODE.test(f)) out.push(d === '.' ? f : `${d}/${f}`);
    }
  }
  return out;
}

/**
 * Files that mention these names — the registry, barrel or caller that will have
 * to change. `Root.tsx` imports `Episode001`, `Episode002`, so searching for the
 * siblings' basenames finds it without knowing anything about the framework.
 */
function registriesOf(rootDir: string, names: readonly string[], skip: ReadonlySet<string>): string[] {
  if (names.length === 0) return [];
  try {
    const pattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const out = execFileSync('rg', ['-l', '--no-messages', '--max-filesize', '2M', '-e', pattern, '.'], {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((p) => (p.startsWith('./') ? p.slice(2) : p))
      .filter((p) => !skip.has(p));
  } catch {
    // No ripgrep, or nothing matched. Siblings alone still beat the status quo.
    return [];
  }
}

/** How many registries to surface, and where. Both swept, not chosen by eye. */
const REGISTRY_COUNT = 4;
const INSERT_AFTER = 3;

/**
 * Reorder a ranked shortlist for a creation request.
 *
 * The first `INSERT_AFTER` files keep their positions — when ordinary ranking is
 * right it is usually right at the very top, and displacing that cost 2.6 points
 * of top-5 accuracy in the sweep. Registries go next, then the rest of the
 * ranking, then siblings as material to copy.
 */
export function applyCreationMode(
  ranked: readonly ContextCandidate[],
  rootDir: string,
  limit: number,
): ContextCandidate[] {
  if (ranked.length === 0) return [...ranked];

  const dirs = [...new Set(ranked.slice(0, 6).map((c) => dirname(c.path)))];
  const siblings = siblingsOf(rootDir, dirs);
  if (siblings.length === 0) return [...ranked];

  const known = new Set(ranked.map((c) => c.path));
  const sibNames = [
    ...new Set(siblings.map((s) => basename(s).replace(/\.[a-z]+$/i, ''))),
  ].slice(0, 40);
  const registries = registriesOf(rootDir, sibNames, new Set(siblings)).slice(0, REGISTRY_COUNT);

  // Surfaced files carry no BM25 score of their own; they are here on structure,
  // not on lexical match, and `score: 0` says so rather than inventing a number.
  const asCandidate = (path: string, why: 'registry' | 'sibling'): ContextCandidate => ({
    path,
    bytes: 0,
    score: 0,
    ...(known.has(path) ? {} : { reason: why }),
  });

  const merged: ContextCandidate[] = [
    ...ranked.slice(0, INSERT_AFTER),
    ...registries.map((p) => asCandidate(p, 'registry')),
    ...ranked.slice(INSERT_AFTER),
    ...siblings.map((p) => asCandidate(p, 'sibling')),
  ];

  const seen = new Set<string>();
  const out: ContextCandidate[] = [];
  for (const c of merged) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
