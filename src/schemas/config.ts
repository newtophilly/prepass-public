/**
 * Zod schema for `.prepass.json`.
 *
 * The schema is the single source of truth: `SmartConfig` (the runtime type)
 * is inferred from it, so validation and typing can never drift apart.
 */
import { z } from 'zod';

const modelTier = z.enum(['cheap', 'balanced', 'premium']);
const workload = z.enum(['bugfix', 'feature', 'refactor', 'search', 'review']);

export const configSchema = z
  .object({
    /** Schema version — lets us migrate config shapes without guessing. */
    version: z.literal(1).default(1),

    /**
     * Logical tier -> concrete model ID. Defaults track the current Anthropic
     * lineup (see README); override per-project for OpenAI or pinned versions.
     */
    models: z
      .object({
        cheap: z.string().min(1).default('claude-haiku-4-5'),
        balanced: z.string().min(1).default('claude-sonnet-5'),
        premium: z.string().min(1).default('claude-opus-5'),
      })
      .default({}),

    curation: z
      .object({
        enabled: z.boolean().default(true),
        /** Soft ceiling on the curated payload; the builder trims to fit. */
        maxTokens: z.number().int().positive().max(200_000).default(8_000),
        /**
         * Read the head of each candidate and boost files that mention the
         * prompt's identifiers. Without it, path names are the only signal and
         * ranking collapses to "smallest file first".
         */
        contentScan: z.boolean().default(true),
        /** Cap on files opened during the content pass (latency bound). */
        /**
         * Stay out of the way below this many candidate files.
         *
         * prepass earns its keep by saving the agent a search. On a repo small
         * enough to hold in one head there is no search to save, and the
         * payload is pure overhead — measured at **+27% cost** on a 51-file
         * project, where it also made the context window *worse*. Detecting
         * that is strictly better than documenting it: a README caveat is a
         * thing users read once and a config file is a thing they forget.
         *
         * Set to 0 to always curate.
         */
        minFiles: z.number().int().min(0).default(100),

        /**
         * Cap on how many query terms may vote. Effectively off, and that is a
         * measured decision.
         *
         * The intuition — a pasted GitHub issue yields hundreds of terms, most
         * matching half the repo, drowning the signal — is wrong, and BM25 is
         * why: IDF already weights each term by how much it distinguishes, so a
         * common term contributes little rather than contributing noise.
         * Swept on SWE-bench Lite, capping is monotonically harmful:
         * 15 terms → MRR 0.238, 30 → 0.296, 60 → 0.328, 120 → 0.346,
         * unlimited → 0.347. Left configurable, defaulted out of the way.
         */
        maxQueryTerms: z.number().int().positive().default(100_000),

        /**
         * Pseudo-relevance feedback: rank once, read the winners, and let the
         * code's own vocabulary join the query for a second pass.
         *
         * **Off by default because it measured worse — every time.** This is
         * the discipline's own answer to the vocabulary gap and the reason to
         * hope a keyless tool could close it: you say "notifications fire
         * twice", the top hits are written in the code's dialect, so borrowing
         * their terms should reach files your words never could.
         *
         * Swept on SWE-bench Lite across docs 3–10, terms 8–30 and weight
         * 0.2–0.5, **all seven configurations lost to the no-feedback
         * baseline** (MRR 0.383 → 0.348–0.361), and the extra pass doubled
         * latency to 230ms. The likely cause is the textbook failure mode:
         * feedback assumes the top results are roughly right, and at hit@1 of
         * 27% they frequently are not, so the second pass amplifies the first
         * pass's mistakes. Query drift, measured.
         *
         * Kept, configurable, and documented — this is worth retrying if
         * first-pass precision ever improves substantially.
         */
        feedback: z
          .object({
            /** Top-ranked files to mine for vocabulary. 0 disables. */
            docs: z.number().int().min(0).default(0),
            /** Terms to borrow from them. */
            terms: z.number().int().min(0).default(12),
            /** Weight of a borrowed term against one the user typed. */
            weight: z.number().min(0).max(1).default(0.35),
            /** Bytes read per feedback file. */
            bytes: z.number().int().positive().default(24_000),
          })
          .default({}),

        /**
         * Score multiplier for in-repo prose — docs, guides, release notes.
         *
         * A bug report is prose describing a feature; a project's own manual is
         * prose describing the same feature in the same words, at length. On a
         * natural-language query the docs therefore beat the source every time.
         * Measured on Django, which ships its manual in-tree: documentation is
         * **8% of the repository and took 60% of the shortlist**, while the
         * source directory where every gold patch lands got 21%.
         *
         * A multiplier rather than an exclusion, deliberately. Removing files
         * was tried on Django's 2,285 translation catalogues and measured
         * *worse* (MRR 0.383 → 0.347), because the candidate pool is the corpus
         * IDF is computed from and pruning it shifts every term's rarity. This
         * changes only where a file lands.
         *
         * 0.5 rather than something harsher because the metric saturates: 0.5,
         * 0.3 and 0.15 score identically, since once prose falls below rank 20
         * further discounting changes nothing. Take the mildest setting that
         * gets the whole benefit, so a genuinely dominant doc can still win.
         *
         * 1 disables it; 0 is equivalent to excluding documentation.
         */
        proseWeight: z.number().min(0).max(1).default(0.5),

        /**
         * Score multiplier for test files.
         *
         * Tests are the largest measured occupant of the shortlist that is
         * almost never the file to change: **27.2% of the top-20 and 25.9% of
         * the top-5** across 300 SWE-bench Lite issues. They match for the same
         * reason documentation did — written about the same feature, in the
         * same words, at length.
         *
         * ⚠️ **Do not read the benchmark gain as the justification.** SWE-bench
         * separates the graded fix from its tests by construction, so gold is
         * never a test there, while all 300 of those fixes really did ship with
         * test changes. The defensible argument is redundancy: a test path is
         * derivable from the source path by convention, so a slot spent on one
         * is a slot the agent did not need help with.
         *
         * 1 disables it. Raise it toward 1 if you often ask about failing tests.
         */
        testWeight: z.number().min(0).max(1).default(1),

        contentScanMaxFiles: z.number().int().positive().default(400),

        /**
         * How much the most-recently-modified file gains over the oldest.
         *
         * Off by default, and that is a measured decision rather than caution:
         * swept against the labelled set at 0, 1, 2, 4, 8 and 16, it never
         * improved anything and degraded MRR from 0.841 to 0.773 at the high
         * end. Recency is plainly a real signal in a live session — the file
         * you touched an hour ago usually is the one you are asking about —
         * but the labelled cases were built from content relevance, so they
         * cannot show it. Turn it on if it helps you; do not ship it on
         * evidence we do not have.
         */
        recencyWeight: z.number().min(0).default(0),

        /**
         * BM25F ranking constants. Exposed so they can be swept against the
         * labelled set in `bench/eval-set.json` rather than picked by eye.
         */
        bm25: z
          .object({
            /** How fast repeated mentions stop adding value. */
            k1: z.number().positive().default(1.2),
            /**
             * How hard to normalise for file length. Textbook BM25 uses 0.75
             * for prose of broadly similar size. Source files differ: a 233 KB
             * module genuinely *does* cover more ground than a 3 KB one, so
             * normalising that away costs recall. Swept against the labelled
             * set, lower values win consistently.
             */
            b: z.number().min(0).max(1).default(0.5),
            /**
             * Multipliers on a path match's rarity weight, swept against
             * SWE-bench Lite — 240 real GitHub issues on repos nobody here
             * wrote — rather than against the hand-written set.
             *
             * The directory was worth **0.4** against the basename's 4.0, on
             * the assumption that a filename is the deliberate, informative
             * part of a path. That is true in a small repo and wrong in a large
             * one: Django has 628 files named `__init__.py` and 209 named
             * `tests.py`, so `django/db/models/` says far more than `base.py`
             * does. Raising it to parity moved MRR 0.314 → 0.359 and hit@1
             * 20.4% → 25.0%, improving monotonically at every basename weight,
             * which is the signature of a real effect rather than noise.
             *
             * Both sit mid-plateau (base 3–4, dir 4–6 all score 0.354–0.363)
             * instead of at the measured peak, because 240 instances cannot
             * justify chasing an exact optimum.
             */
            basenameWeight: z.number().positive().default(4),
            dirnameWeight: z.number().positive().default(4),
            /**
             * How much directory credit survives when the basename *also*
             * matches the same term.
             *
             * Scoring used to be `if basename else directory`, so a term that
             * appeared in both was counted once. But `billing/payments/` and
             * `RetryHandler.swift` agreeing on "payment" is stronger evidence
             * than either alone — that agreement was being discarded. 0 keeps
             * the old either/or behaviour, 1 counts both at full weight.
             */
            dirWithBasename: z.number().min(0).max(1).default(0),
            /**
             * Scale the basename weight by how informative filenames are in
             * *this* repository.
             *
             * Measured on SWE-bench Multilingual: 83% of JS/TS files share a
             * basename with another file (`index.ts`, `types.ts`) against 13%
             * in PHP — and hit@1 tracks it, 20.9% against 41.9%. Per-field IDF
             * already discounts an individual common term; this asks the
             * separate question of whether the field is worth trusting at all
             * in this tree. 0 disables the adjustment.
             *
             * Swept on Lite and Multilingual, then **validated on 407 held-out
             * SWE-bench Verified instances that had no part in choosing it**,
             * across six repositories never scored before. 0.25 improved every
             * metric there (hit@20 81.33 → 82.06, MRR 0.4483 → 0.4519); 0.5
             * looked better on the swept corpora but went flat on the holdout,
             * which is what selection bias looks like from the inside.
             *
             * The effect is real and small: roughly +0.7 to +1.3 points of
             * hit@20. Quote the held-out figure, not the swept one.
             */
            collisionAdapt: z.number().min(0).max(1).default(0.25),
          })
          .default({}),
        /** Bytes read from the head of each scanned file. */
        contentScanBytes: z.number().int().positive().default(16_000),
      })
      .default({}),

    routing: z
      .object({
        defaultWorkload: workload.default('feature'),
        /** Below this, intent detection falls back to `defaultWorkload`. */
        confidenceThreshold: z.number().min(0).max(1).default(0.4),
        allowEscalation: z.boolean().default(true),
        /** Prompt-token count above which the router considers escalating. */
        escalateAboveTokens: z.number().int().positive().default(30_000),
        /** File count above which the router considers escalating. */
        escalateAboveFiles: z.number().int().positive().default(20),
      })
      .default({}),

    telemetry: z
      .object({
        enabled: z.boolean().default(true),
        dbPath: z.string().min(1).default('.prepass/telemetry.db'),
      })
      .default({}),

    /**
     * File discovery — how the candidate pool is built before curation ranks
     * it. Disable to consider only explicitly-named files (`--file`, or the
     * target of the tool call in hook mode).
     */
    discovery: z
      .object({
        enabled: z.boolean().default(true),
        /** Safety cap on pool size; discovery stops once reached. */
        maxFiles: z.number().int().positive().max(100_000).default(5_000),
        /** Files larger than this are dropped — they crowd out the budget. */
        maxFileBytes: z.number().int().positive().default(512_000),
      })
      .default({}),

    taxonomies: z
      .object({
        /** Directory of `<workload>.json` files, resolved from config dir. */
        dir: z.string().min(1).default('taxonomies'),
        /** Extra taxonomy file paths merged on top of the built-in set. */
        custom: z.array(z.string()).default([]),
      })
      .default({}),
  })
  .strict();

/** Fully-resolved, defaulted configuration. */
export type SmartConfig = z.infer<typeof configSchema>;

export { modelTier as modelTierSchema, workload as workloadSchema };
