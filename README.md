# prepass

**Stops your coding agent searching from zero.**

When you ask Claude Code or Codex about a codebase it doesn't know, it goes hunting — grep, glob, sometimes a whole search subagent — before it can start on your actual question. `prepass` runs the instant you hit enter, ranks the files most likely to matter, and hands the agent a shortlist of paths.

No API key. No network call. No index. No daemon. Nothing to sign up for.
**~20ms on a typical project**, and it scales with repository size — see below.

```
› why do arrival notifications fire twice

⏺ prepass · bugfix · 12 files · high confidence · 36ms

  Read NotificationManager.swift, LocationProvider.swift
```

That second line is the agent reading the two files prepass ranked first — instead of grepping 2,260 of them to work out where to look.

## Install

```bash
npm install -g @nharing/prepass
```

The command is `prepass`; only the package name is scoped, because npm considers the bare name
too close to an existing package. Node.js ≥ 22. Three runtime dependencies. The one native dependency ships prebuilt binaries, so there is no compiler step.

Then, in the project you want it on:

```bash
prepass init
```

That registers the hook for whichever agents you use. It **merges** into your existing settings
rather than replacing them, does nothing if it is already there, and refuses to touch a settings
file it cannot parse. It also tells you if the project is too small to benefit.

It works on an existing codebase immediately — nothing to build, no warm-up run.

### Updating

```bash
npm update -g @nharing/prepass      # or: npm install -g @nharing/prepass@latest
prepass --version
```

prepass will never tell you an update exists, and that is deliberate. Checking would mean a
tool that reads your source code also making outbound network calls — on the hook path, that
is every prompt you type. `No network call` is a promise worth more without an asterisk than
with one. `prepass doctor` reports the version you are running if you want to check by hand.

## Turn it on by hand

If you would rather not run `init`:

**Claude Code** — `.claude/settings.json`:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "prepass hook" }] }
    ]
  }
}
```

**Codex CLI** — `.codex/hooks.json`:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "prepass hook" }] }
    ]
  }
}
```

Both agents ship the same hook contract, so one binary serves both. Codex asks you to trust the hook the first time.

## Agents without hooks — including Codex desktop

A hook is the best mechanism where it exists, because it fires *before* the agent can decide
to start grepping. Not every agent has one, so `init` installs two more routes:

**A skill.** `init` writes `.claude/skills/prepass/SKILL.md` and `.codex/skills/prepass/SKILL.md`.
The agent reads the description and calls prepass when it judges the request needs orienting.
This is what makes **Codex desktop** work, which has no hook execution — verified: given a
symptom-shaped question on a 2,000-file repo, it reached for the skill unprompted, said why,
ran it, and treated the result as a starting point rather than an answer.

**An instructions file.** `init` appends a `<!-- prepass -->` block to `AGENTS.md` (or
`CLAUDE.md`) telling the agent to run `prepass prompt "<request>"` first. Three lines, no
integration — enough for Cursor, Cline, Windsurf, Zed, Aider, Gemini CLI and anything else
that can shell out.

| route | reaches the agent | works in |
|---|---|---|
| hook | automatically, the instant you hit enter | Claude Code, Codex CLI |
| skill | the agent chooses to call it | Claude Code, Codex CLI, **Codex desktop** |
| instructions | three lines in `AGENTS.md` | anything that can run a command |

Gate them if you want just one: `prepass init --claude` or `prepass init --codex`.

> **What cannot work:** ChatGPT, Claude or Gemini in a browser or phone app. No filesystem and
> no shell means there is nothing for a local file-ranker to rank.

## When nothing seems to happen

prepass has no UI, and it degrades quietly rather than erroring — so a misconfiguration looks
exactly like "it ran and found little". That is what `doctor` is for:

```bash
prepass doctor
```

It reports whether `ripgrep` is on PATH, whether anything is actually registered, how big the
candidate pool is and what it is made of, whether you are **in the directory you think you
are** (a session started one level above the repo is the single most common cause), and it
runs a live smoke query.

> **Per project, not globally.** prepass earns its keep by saving the agent a search. Where there is no search to save it is pure overhead — measured at **+27% cost** on a 51-file project. It detects that case and stands aside below 100 files, but a global hook still means running it where it will never help.

> **Start the agent in the directory you want scanned.** `cd` inside a session does not move it.

## Does it actually help?

Entirely depends on whether the agent would have had to search. That one rule explains every measurement:

| your situation | search needed? | effect |
|---|---|---|
| big repo, you describe a symptom | a lot | **~47% cheaper, ~half the wall clock** |
| big repo, read-only exploration | yes | ~45% cheaper |
| big repo, your prompt names the file | barely | a wash |
| small repo | no | prepass stands aside |

The saving people actually notice is not money — it is **time and context**. On one measured prompt: 435s → 222s, and the file contents pulled into the window dropped 113 KB → 54 KB, so compaction fires much later.

## How well does it rank?

Measured on **1,007 real GitHub issues across 53 repositories** — three independent corpora, none
of them written here. The query is the issue text as filed; the correct answer is whichever files
the accepted patch touched.

| corpus | n | right file in top 20 | in top 5 | ranked first | MRR |
|---|---|---|---|---|---|
| [SWE-bench Lite](bench/swebench-lite-2026-08-05.json) | 300 | 78.0% | 63.0% | 34.3% | 0.468 |
| [Multilingual](bench/swebench-multilingual-2026-08-05.md) — 9 languages | 300 | 77.3% | 57.3% | 29.0% | 0.409 |
| [Verified, held out](bench/collision-adapt-2026-08-05.md) — never tuned on | 407 | **82.1%** | 64.1% | 31.2% | 0.452 |

### How long it takes

Latency is dominated by I/O that scales with the candidate pool, so one number
would be the wrong shape for the claim. Measured end to end across 27 real
repositories:

| repository size | n | median |
|---|---|---|
| under 500 files | 19 | **19 ms** |
| 500–2,000 files | 5 | 54 ms |
| over 2,000 files | 3 | 103 ms |
| **all 27** | | **22 ms** |

Worst case measured: **221 ms** on Django at the 5,000-file discovery cap. The
`106ms` quoted in the benchmark tables below is the SWE-bench Lite median, whose
repositories carry a median of 1,867 files — larger than most projects, and not
representative of what you will see.

Median latency **106ms** on that benchmark's 1,866-file pool. Picking 20 files at random from the same pools
hits 1.56%, so this is roughly **50× chance**. The gold file was in the candidate pool ~100% of
the time, so nearly every miss is a ranking failure rather than a file that was never scored.

**It is not Python-only — but it is not uniform either.** The multilingual corpus covers 41
repositories across nine languages. The aggregate hit@20 (76.7%) holds within a point of the
Python figure, and that average hides a 31-point spread:

| language | n | hit@1 | hit@20 |
|---|---|---|---|
| C++ | 12 | 16.7% | **91.7%** |
| PHP | 43 | **41.9%** | 86.0% |
| C | 30 | 10.0% | 80.0% |
| Rust | 43 | 27.9% | 79.1% |
| Go | 42 | 26.2% | 78.6% |
| Ruby | 44 | 29.5% | 77.3% |
| Java | 43 | 39.5% | 72.1% |
| **JS/TS** | 43 | **20.9%** | **60.5%** |

**If your codebase is TypeScript or JavaScript, expect the bottom row, not the average.** The
likely cause is filename collision: 83% of JS/TS files share a basename with another file, so the
filename field — the strongest of the three — carries much less information than it does in a
language where names are unique. C is the odd one: it lands in the shortlist 80% of the time and
on top almost never.

Two caveats travel with these numbers. 30 of 300 instances hit the 5,000-file discovery cap, so
some misses are truncation rather than ranking. And the "×chance" multiplier is not portable —
these repos are smaller, so random selection hits 5.72% here against 1.56% on Lite, which moves
the headline multiple from 50× to 13× with no change to the tool.

**Two times in three the *top* file is wrong.** prepass narrows the haystack; it does not hand you
the needle. That turns out to be enough, because narrowing is what saves the search.

Reproduce any of it: `node bench/swebench.mjs --repos <dir> --data <file>`. It calls no model and
costs nothing.

## Against embedding models, on someone else's benchmark

Everything above is measured by a harness in this repository. [Agent Retrieval
Bench](bench/arb-2026-08-06.md) is not: 287 hand-reviewed samples over 25 repositories, with
published baselines for a lexical retriever, RepoMap, and five embedding models up to 8B
parameters. All eight systems were scored on identical sample ids against the identical
answer key.

**`trace2code` — failing test output → the source at fault.** First of eight:

| retriever | Recall@5 | Recall@20 | MRR | index |
|---|---|---|---|---|
| **prepass** | **0.777** | **0.941** | **0.574** | none |
| RepoMap | 0.449 | 0.837 | 0.274 | none |
| lexical baseline | 0.343 | 0.696 | 0.207 | none |
| Qwen3-Embedding-8B | 0.244 | 0.797 | 0.165 | 36 GPU-hours, 102 GB |
| nomic-embed-code | 0.158 | 0.358 | 0.087 | 32 GPU-hours, 89 GB |

Median **15ms**. A stack trace is a dense list of exact identifiers printed verbatim, so
rarity-weighted exact matching is the right tool and semantic similarity blurs a signal that was
already clean.

**`code2test` — a code change → the tests to update.** Seventh of eight, MRR 0.195 against
Qwen3-Embedding-4B's 0.322. A test is named for a behaviour and the change is described in a PR
title; they share almost no tokens. This is the vocabulary gap in its purest form, and it is
where a model earns its cost.

**`comment2context`** lands fourth of eight, inside the embedding cluster.

prepass beats the published lexical baseline on all three tasks — **2.8×, 3.0× and 1.5×** its
MRR — which is the comparison that isolates what this project actually adds, since it is the same
family of algorithm over the same candidate pool.

> The same run supplied an unplanned control. `code2test` is a task where **every correct answer
> is a test file** — the exact inversion of the SWE-bench construction artifact documented in
> [`bench/git-history.mjs`](bench/git-history.mjs). Setting `testWeight: 0.5`, worth +6 to +8
> points of hit@1 on every SWE-bench corpus including a held-out one, collapses MRR here from
> **0.195 to 0.021**. That is why the default is 1.0.

Reproduce: `ARB_ROOT=<release> node bench/arb.mjs`.

## The glossary

Ranking can only find words that are in the file. You say *"arriving"*; CoreLocation says `didEnterRegion`. You say *"twice"*; the code says `dedup`. Nothing lexical crosses that gap — so write the bridge down:

```jsonc
// .prepass/glossary.json — commit it, your team benefits too
{
  "arriving": { "expands": ["didEnterRegion", "geofence"], "source": "manual" },
  "twice":    { "expands": ["dedup", "debounce"],          "source": "manual" }
}
```

Expansions carry reduced weight and never displace a word you typed. `"disabled": true` is a veto.

`prepass learn` proposes entries mined from your own code's comments — pairing a doc comment with the declaration beneath it, scored by how much the pairing beats chance. It proposes; you accept.

## What it sends

Paths and scores. **Never file contents.**

```xml
<candidate-files count="12" confidence="high">
  <note>Ranked guesses from a keyword heuristic, most likely first — not a verified answer.
        Open them to confirm before relying on or editing any of them.</note>
  <repo git="yes" recently-changed="LocationProvider.swift, NotificationManager.swift" />
  <file path="AppName/Core/NotificationManager.swift" bytes="66871" score="23.196"></file>
  …
</candidate-files>
```

Paths-only is a safety property, not a token optimisation. The agent has to open a file to use it, and opening it is also what disproves a bad suggestion. Tested directly: handed a deliberately **wrong** map labelled `confidence="high"`, the agent still edited the correct file — in all four arms, none touched a planted file.

The `<repo>` line pre-answers the `git status` both agents run first, which otherwise fails and wastes a turn in a directory that is not a repository.

## Commands

| | |
|---|---|
| `prepass init` | register the hook in this project (merges, never overwrites) |
| `prepass hook` | run as an agent hook (stdin JSON → stdout JSON) |
| `prepass prompt <text>` | show what would be sent |
| `prepass explain <text> --why` | show *why* each file scored what it did |
| `prepass learn` | propose glossary entries from your code's comments |
| `prepass doctor` | why nothing is happening — checks ripgrep, wiring, location, pool, glossary |
| `prepass stats` | summarise local telemetry |

## Why did it pick those files?

Ask it. `prepass explain "<your prompt>" --why` itemises the score:

```
searched 442 files in 15ms
  your words:  keeps, telling, everyone, someone, home, twice
  glossary:    savedplace (via "home"), dedup (via "twice"), debounce (via "twice")

  1. AppName/Models/SavedPlace.swift                        28.08
       +12.51  savedplace    in filename       1/442 files  ← "home"
       + 3.30  dedup         in contents ×27  24/442 files  ← "twice"
       + 2.88  home          in contents ×23 108/442 files

  3. AppName/Providers/Location/LocationProvider.swift      24.86
       + 2.89  region        in contents ×61  32/442 files  ← "home"
       + 2.85  debounce      in contents ×9    9/442 files  ← "twice"
```

The `n/442 files` column is the important one: a term in 3 files of 442 is evidence, the same term in 108 of them is barely a hint. That's what the ranking is actually weighing, and it's also how you tell whether a glossary entry is earning its place or distorting things.

## How it works

1. **Discover** — `git ls-files` in a repo, so your `.gitignore` is honoured exactly; a bounded walk otherwise.
2. **Classify** — weighted keyword taxonomies sort the prompt into a workload, which decides how many files come back and what is excluded (a bugfix does not want your release notes).
3. **Rank** — **BM25F**, the standard document-ranking function, over three fields: contents, filename, directory. Term frequencies come from **one ripgrep pass** (~10ms over 71 MB). Each field carries its own rarity model, because "matched the filename" means very little in a repo with 628 files called `__init__.py` and a great deal in one where names are unique.
4. **Bridge** — glossary expansions join the query at reduced weight.
5. **Emit** — a compact XML block within a token budget, with a confidence level derived from how separated the scores are.

Every ranking constant is swept against the benchmark rather than picked by eye.

## Things that were tried and did not work

Kept here because a negative result is still a result:

- **Local embeddings.** Path-only dense retrieval scored MRR 0.247 against the BM25F baseline of the time, 0.383 — not close. A hybrid does win by 3 points of hit@20, but costs 259 MB of dependencies, an 18-second first-run index, and a cache to invalidate on every edit. [Full bake-off.](bench/bakeoff-2026-08-04.md)
- **Pseudo-relevance feedback.** The classical answer to the vocabulary gap. All seven configurations lost to the baseline: feedback assumes the top results are right, and at hit@1 of 27% they often are not.
- **Capping query terms.** Monotonically harmful — BM25's IDF already handles common terms.
- **Extracting paths from stack traces.** Killed before building: only 3 of 70 misses mention the target file anywhere.

Each is documented in the code at the point where someone would try it again.

## Configuration

Optional. Drop a `.prepass.json` at your project root; see [`.prepass.example.json`](./.prepass.example.json). Every ranking constant is exposed so you can sweep it against your own repo.

Local telemetry lives in `.prepass/`, which ignores itself so it never appears in your `git status`.

## Contributing

```bash
git clone … && cd prepass
npm install
npm run build
npm test
npm link
```

## License

**Apache 2.0.** Use it at work, in a commercial product, in closed source — no obligation to open anything of yours. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
