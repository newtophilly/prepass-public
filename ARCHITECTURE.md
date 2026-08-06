# Architecture

What exists in the code today. Where this file and a comment in the source disagree, the
source wins — every ranking constant here was swept against `bench/swebench.mjs` rather than
picked by eye, and the reasoning lives next to the code that depends on it.

## Data flow

```
                    your prompt
                         │
        ┌────────────────▼────────────────┐
        │  config.ts                       │  .prepass.json → SmartConfig
        │  load + validate (Zod)           │  every knob has a measured default
        └────────────────┬────────────────┘
                         │
        ┌────────────────▼────────────────┐
        │  core/file-scanner.ts            │  git ls-files, honouring .gitignore
        │  discover candidates             │  bounded walk if not a repo
        └────────────────┬────────────────┘
                         │
        ┌────────────────▼────────────────┐
        │  core/intent-detector.ts         │  taxonomies/*.json → workload
        │  weighted keyword scoring        │  bugfix / feature / refactor / …
        └────────────────┬────────────────┘
                         │
        ┌────────────────▼────────────────┐
        │  glossary.ts                     │  your words → your codebase's words
        │  expand at reduced weight        │  never displaces a term you typed
        └────────────────┬────────────────┘
                         │
        ┌────────────────▼────────────────┐
        │  core/context-curator.ts         │  BM25F over contents · filename ·
        │  ONE local scoring pass          │  directory, each with its own IDF.
        │  + XML payload assembly          │  Term frequencies from one ripgrep
        └────────────────┬────────────────┘  pass over the whole tree.
                         │
        ┌────────────────▼────────────────┐
        │  core/telemetry.ts (SQLite/WAL)  │  local only, never leaves the machine
        └────────────────┬────────────────┘
                         │
              ranked paths  →  cli / hook
```

`pipeline.ts` orchestrates the middle boxes; the two entrypoints are thin adapters over it.

**No model is called anywhere in this diagram.** Curation is a single deterministic local
stage. That is the whole product — see "What was removed" below.

## Modules

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Shared, dependency-free domain vocabulary. |
| `src/schemas/config.ts` | Zod schema; `SmartConfig` is inferred from it. |
| `src/config.ts` | Find, read, validate config; resolve all paths to absolute. |
| `src/glossary.ts` | Load, expand and append glossary terms. |
| `src/tokens.ts` | Token estimation. Shared on purpose — inlining it in the curator was a real bug. |
| `src/core/file-scanner.ts` | Candidate discovery: `git ls-files`, or a bounded walk. |
| `src/core/intent-detector.ts` | Taxonomy loading + weighted keyword scoring + confidence. |
| `src/core/context-curator.ts` | BM25F scoring and XML payload assembly. The load-bearing file. |
| `src/core/explain-ranking.ts` | Mirrors the scorer, keeping the arithmetic for `explain --why`. |
| `src/core/glossary-miner.ts` | PMI-based term mining for `learn`. |
| `src/core/install.ts` | `init` — registers the hook, skill and instructions. Merges, never clobbers. |
| `src/core/doctor.ts` | `doctor` — every check exists because it silently went wrong for somebody. |
| `src/core/model-router.ts` | Vestigial: prints an advisory tier. A hook **cannot** switch models. |
| `src/core/telemetry.ts` | Structured logging + SQLite (WAL) metrics store, local only. |
| `src/pipeline.ts` | End-to-end orchestration shared by both entrypoints. |
| `src/entrypoints/cli.ts` | Direct invocation. |
| `src/entrypoints/hook.ts` | `UserPromptSubmit` hook handler (Claude Code and Codex share the contract). |
| `src/cli/index.ts` | Commander wiring for `init`/`hook`/`prompt`/`explain`/`learn`/`doctor`/`stats`. |

## Design principles

- **Graceful degradation everywhere.** A missing taxonomy, an unopenable telemetry DB, a
  malformed hook payload, or a missing `ripgrep` must never fail your request — each degrades
  to a valid, lesser answer. The cost of this is that the failure mode is *silence*, which is
  why `doctor` exists.
- **Paths, never contents.** The payload names files; the agent opens them. Opening a file is
  also what disproves a bad suggestion, so a wrong ranking costs a read, not a wrong edit.
- **The schema is the source of truth.** Config typing is inferred from the Zod schema, so
  validation and types cannot drift.
- **Deterministic and offline.** No API key, no network call, no index, no daemon. Everything
  is reproducible from the same inputs, which is what makes the benchmark meaningful.
- **Measure before shipping a constant.** `bench/swebench.mjs` runs against 240 real GitHub
  issues at no cost. Several obvious-sounding ideas lost there; see the README.

## What was removed, and why it is not coming back

Cut in `1d6b8a6`. Documented here because each looks like an obvious thing to add.

- **Model routing.** A hook cannot change the model — no field in the hook output contract
  selects one. `model-router.ts` survives only as an advisory print.
- **The second LLM curation stage** (a Haiku pass over stage-one output). Removing it is what
  made the tool keyless, and keylessness is its best property.
- **Provider adapters** (`src/providers/`) and the **MCP entrypoint**. Both existed only to
  serve the two items above. An MCP server may return one day to reach Cursor/Cline/Zed, but
  as *pull* transport for the same local ranker — not as a way to call a model.
