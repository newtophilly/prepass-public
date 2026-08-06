# Contributing to prepass

Thanks for helping. The two highest-leverage contribution types are **taxonomies** (teach the detector new workloads / better keywords) and **providers** (support more upstream LLMs). Both have a small, well-defined surface.

## Setup

```bash
npm install
npm run typecheck   # strict; must pass
npm run test        # node:test
npm run build
```

The codebase is strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitAny`) with no `any`. Comments explain *why*, not *what* — the code should already say what.

## Contributing a taxonomy

A taxonomy is a single JSON file matching the shape in [`src/types.ts`](./src/types.ts) (`Taxonomy`) and validated by the schema in [`src/core/intent-detector.ts`](./src/core/intent-detector.ts).

To **improve an existing workload**, edit the matching `taxonomies/<workload>.json`:

- `keywords` — plain signals, each worth 1.0.
- `weightedKeywords` — strong signals worth more (e.g. `"stack trace": 2.0`).
- `antiKeywords` — terms that *subtract* confidence (disambiguators against other workloads).
- `curationStrategy` — how to gather context for this workload (globs, `maxFiles`, `prioritySignals`, whether to run the Haiku stage).
- `routing` — `defaultTier`, `escalateTier`, and the signals that justify escalation.

To **add a new workload**, you must (a) add it to the `Workload` union in `src/types.ts`, the enums in `src/schemas/config.ts`, and the `WORKLOADS` list in `src/core/intent-detector.ts`, then (b) add `taxonomies/<workload>.json`. The compiler will flag every switch/map that needs the new case.

**Guidelines:** prefer precise, low-collision keywords; use `antiKeywords` to fight overlap with sibling workloads; keep `maxFiles` proportional to how much context the workload genuinely needs. Add a case to `test/unit/intent-detector.test.ts` proving a representative prompt classifies correctly.

## Pull requests

- One logical change per PR; keep taxonomy and provider changes separate.
- `npm run typecheck && npm run test && npm run build` must pass.
- Update `ARCHITECTURE.md` if you change module boundaries.
- Never commit secrets, `.env*`, or a `.prepass/` telemetry DB (all git-ignored).

## Code of conduct

Be kind, assume good faith, review the code and not the person.
