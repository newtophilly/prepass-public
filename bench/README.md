# bench — does the hook actually help?

Proves (or disproves) the central claim: that handing Claude a ranked file map stops it hunting
through the repo. It runs real headless Claude Code sessions, same prompts, hook on vs hook off.

Three harnesses live here:

```bash
# 1. retrieval against real GitHub issues — free, no agent, no API calls
node bench/swebench.mjs --repos <dir> --data <SWE-bench json>

# 2. the control that catches what SWE-bench cannot — also free
node bench/git-history.mjs --repo <dir> --out corpus.json
node bench/swebench.mjs --repos <parent> --data corpus.json

# 3. agent behaviour — costs real usage
python3 bench/ab.py --repo /path/to/your/repo --repeat 3
```

⚠️ **Read `test-discount-2026-08-06.md` before tuning anything against SWE-bench.** Its answers
are never test files, because the graded fix and its tests are stored in separate fields. So any
change that demotes tests scores better there whether or not it helps a real user — measured at
+6 to +8 points of hit@1, entirely artificial. A held-out SWE-bench corpus does **not** catch
this; every SWE-bench corpus shares the split. `git-history.mjs` builds a corpus from a
repository's own commits, where roughly a quarter of the answers *are* test files, which is what
makes the artifact visible.

`swebench.mjs` is the one that produced the numbers in the README: 240 real GitHub issues,
six repos, issue text as the query and the accepted patch's files as the label. Start there —
it costs nothing and is fully reproducible. `ab.py` measures the thing retrieval cannot: what
the agent actually *does* differently.

Costs real usage — roughly $0.20–0.50 per run, and a run happens per prompt, per condition, per
repeat. The default is 12 runs.

## What it measures

- **tool calls** — the honest signal. Every call is Claude going "let me grep... let me read..."
- **subagent spawned** — the expensive failure mode: Claude gives up guessing and dispatches an
  agent to search. If the file map works, this should stop happening.
- **cost / duration** — the bottom line.

**Do not use `num_turns`.** It counts top-level turns only, so subagent work is invisible: a run
on 2026-08-01 reported `num_turns: 2` while making 15 tool calls. That mistake made the first
pass of this measurement unreadable. Also note `--allowedTools` does not stop a spawned subagent
from calling other tools.

Always eyeball the answers in the raw JSONL. **Cheap but wrong is not a win.**

## Result — 2026-08-01 (n=1 per cell)

Sonnet 5, read-only tools. Two repos, described by size because one was private.

| | hook ON | hook OFF | delta |
|---|---|---|---|
| small repo (17 files) | $0.471 | $0.550 | −14% — a wash |
| large repo (277 files) | $0.495 | $1.166 | **−58%** |
| overall | $0.966 | $1.716 | **−44%** (won 5 of 6 prompts) |

Mechanism, from a `stream-json` pair on one prompt:

| | tool calls | what happened | cost |
|---|---|---|---|
| hook OFF | **15** | spawned a subagent, then Bash + 5 Glob + 6 Read | $0.330 |
| hook ON | **2** | Read, Read | $0.145 |

Answers were correct in both conditions — no quality traded for cost.

**The benefit scales with repo size.** Near zero on a small repo, large on a real one. That is a
positioning fact, not a flaw: this is a tool for big codebases.

**Caveat: n=1 per cell.** The direction is consistent across six prompts and the mechanism is
explained rather than guessed, but before putting a number in the README, run `--repeat 3` or 5.
