/**
 * What the session already knows.
 *
 * ## The gap this closes
 *
 * The hook opens the session transcript — it has to, to recover the prompt at
 * all — and then reads exactly one message out of it. Everything else is thrown
 * away: what you asked two turns ago, and every file the agent has already
 * opened.
 *
 * That is fine for a pasted GitHub issue (median 1,043 characters, 54 distinct
 * terms) and wrong for how people actually work (**204 characters, 17 terms**).
 * The prompts that defeat ranking are the ones with no referent of their own:
 *
 *     "okay lets do it"
 *     "I actually like take 2 better. not take 3"
 *     "top is great, the bottom needs pushed down further"
 *
 * No ranker can answer those from their own text. All of them are trivial given
 * the turn before, and the answer is usually a file this session already opened.
 *
 * ## Measured
 *
 * 121 turns replayed in order, prior state only, on real agent history:
 *
 *     prompt only        hit@20 79.3%   MRR 0.422
 *     + prior words             81.8%       0.464
 *     + touched files           82.6%       0.491
 *     + both                    85.1%       0.535
 *     + SHUFFLED words          81.0%       0.393   <- placebo
 *
 * **The placebo is why the touched-file signal is weighted higher.** Unrelated
 * text from another repository still gained +1.7 points of hit@20, because more
 * terms means more matches — so roughly two thirds of the prior-words gain is a
 * query-length artifact rather than context. MRR separates them honestly:
 * relevant text +0.042, irrelevant text **−0.029**. Touched files add no text at
 * all and therefore cannot have that confound.
 *
 * ## The cost, stated plainly
 *
 * The benefit is not uniform. Split by whether the answer lived where the
 * session had already been:
 *
 *     same area  (82% of turns)   82.8% -> 90.9%   MRR 0.463 -> 0.606
 *     NEW area   (18% of turns)   63.6% -> 59.1%   MRR 0.236 -> 0.216
 *
 * On-topic this is the largest accuracy gain ever measured in this project —
 * bigger than the prose multiplier. On a subject change it makes an already-weak
 * case worse. **Sweeping the bonus does not fix it**: new-area hit@20 is 59.1%
 * at every level including zero, so that harm comes from the words rather than
 * the file boost. Recency decay was tried too and *cost* same-area accuracy
 * (90.9% -> 87.9%) without helping. The trade is structural, so the default is
 * a conservative middle rather than the maximum.
 *
 * Deliberately NOT built: a topic-switch detector. Five separate attempts to
 * infer intent from a prompt measured at chance in one evening
 * (`creation-intent.ts` documents them). This is not that problem again.
 */
import { readFileSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';

export interface SessionContext {
  /** Text of the previous user turns, most recent last. Empty when unavailable. */
  readonly priorText: string;
  /** Repo-relative paths this session has already read or edited. */
  readonly touched: ReadonlySet<string>;
}

const EMPTY: SessionContext = { priorText: '', touched: new Set() };

/** Tools whose target the agent has demonstrably looked at. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

/**
 * Records that arrive in a user-shaped slot but that no human typed. Including
 * these would feed tool output back into the query, which is the pseudo-relevance
 * feedback that measured worse in all seven configurations.
 */
const NOISE =
  /^\s*(<command-name>|<local-command-stdout>|<command-message>|<system-reminder>|<task-notification>|Caveat: The messages below|\[Request interrupted)/i;

interface Entry {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  toolUseResult?: unknown;
  cwd?: string;
  message?: { content?: unknown };
}

/**
 * Read prior turns and touched files from a session transcript.
 *
 * Bounded tail read, like `lastUserMessage` — a long session's transcript can be
 * tens of megabytes and this runs on every prompt. Anything unreadable degrades
 * to "no context" rather than throwing: a hook that fails is worse than a hook
 * that adds nothing.
 *
 * @param currentPrompt the turn being ranked, excluded from the prior text
 * @param lookback      how many previous user turns to include
 */
export function readSessionContext(
  transcriptPath: string,
  rootDir: string,
  currentPrompt: string,
  lookback = 2,
  tailBytes = 512 * 1024,
): SessionContext {
  let text: string;
  try {
    text = readFileSync(transcriptPath, 'utf8').slice(-tailBytes);
  } catch {
    return EMPTY;
  }

  const prompts: string[] = [];
  const touched = new Set<string>();
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(trimmed) as Entry;
    } catch {
      continue; // a truncated first line from the tail read
    }

    const content = entry.message?.content;

    if (entry.type === 'user') {
      if (entry.toolUseResult != null || entry.isMeta || entry.isCompactSummary) continue;
      let body = '';
      if (typeof content === 'string') body = content;
      else if (Array.isArray(content)) {
        if (content.some((c) => (c as { type?: string })?.type === 'tool_result')) continue;
        body = content
          .filter((c) => (c as { type?: string })?.type === 'text')
          .map((c) => (c as { text?: string }).text ?? '')
          .join(' ');
      }
      body = body.trim();
      if (body && !NOISE.test(body)) prompts.push(body);
    }

    if (Array.isArray(content)) {
      for (const c of content as { type?: string; name?: string; input?: { file_path?: string } }[]) {
        if (c?.type !== 'tool_use' || !c.name || !FILE_TOOLS.has(c.name)) continue;
        const fp = c.input?.file_path;
        if (!fp) continue;
        // Store repo-relative so it can be matched against candidate paths.
        const rel = isAbsolute(fp) ? relative(rootDir, fp) : fp;
        if (rel && !rel.startsWith('..')) touched.add(rel);
      }
    }
  }

  // The current turn is already in the transcript by the time the hook runs;
  // including it would duplicate the query into its own context.
  while (prompts.length && prompts[prompts.length - 1] === currentPrompt.trim()) prompts.pop();

  // `slice(-0)` is `slice(0)` — the whole array — so a lookback of 0 would have
  // folded in EVERY prior turn instead of disabling the words entirely.
  const prior = lookback > 0 ? prompts.slice(-lookback) : [];
  return { priorText: prior.join('\n'), touched };
}

/**
 * Score bonus for a file this session already opened, as a fraction of the top
 * score so it stays scale-free across repositories.
 *
 * Additive rather than a re-ordering. Inserting a list into a ranked list is a
 * zero-sum swap — twenty slots, so every addition removes something — and that
 * shape failed repeatedly here: co-commit neighbours rescued 6 and displaced 6,
 * an exact wash. Fusing into the score lets a weak lexical match with strong
 * session evidence rise without evicting a strong one.
 */
export function touchedBonus(topScore: number, weight: number): number {
  return topScore * weight;
}
