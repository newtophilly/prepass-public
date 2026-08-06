# Adaptive basename weighting — swept, then validated on data it never saw

**Date:** 2026-08-05 · retrieval only, no agent, no API cost · k = 20 · no glossary

Two changes were proposed to fix the one metric that degraded on
[multilingual repositories](./swebench-multilingual-2026-08-05.md): hit@1 fell from 35.4% to
28.3% while hit@20 held. One was expected to work and did not. The other was expected to be a
no-op and is now shipped.

## The measured cause

Across nine languages, the share of files sharing a basename with another file tracks hit@1:

| language | colliding basenames | hit@1 |
|---|---|---|
| JS/TS | **83%** | **20.9%** |
| Go | 43% | 26.2% |
| Rust | 24% | 27.9% |
| Ruby | 18% | 29.5% |
| Java | 17% | 39.5% |
| PHP | **13%** | **41.9%** |

The basename field carries the heaviest weight in the scorer. Where names are `index.ts`,
`types.ts`, `utils.ts`, that signal is worthless — and per-field IDF does not fully cover it. IDF
answers *is this term common*; it does not answer *is this field worth trusting in this tree*.

(C is the exception: 29% collisions but 10% hit@1, the worst of any language. Its files are also
the shallowest measured — median gold depth 1.0 — so both path fields are weak at once and only
contents remain. That is a plausible story and it is **not** claimed as established.)

## What was tried

**`dirWithBasename` — give the directory partial credit when the filename matches the same term.**
The reasoning: `billing/payments/RetryHandler.swift` matching "payment" in both places is stronger
evidence than either alone, and the old `if basename else directory` discarded half of it.

**Measured harmful. 8 of 8 configurations lost, monotonically worse as the knob rose:**

| value | Lite MRR | Multilingual MRR | Multilingual hit@20 |
|---|---|---|---|
| 0 | 0.4749 | 0.4058 | 76.67 |
| 0.5 | 0.4731 | 0.4045 | 76.67 |
| 1.0 | **0.4678** | **0.3999** | **75.33** |

The intuition mistakes *correlated* evidence for *independent* evidence. A file called
`payment_handler.ts` inside `payment/` is one fact stated twice; counting it twice inflates files
that say one thing loudly and demotes files whose path and contents contribute different
information. Shipped off, kept as a knob so the result can be reproduced rather than re-derived.

**`collisionAdapt` — scale the basename weight by how distinctive filenames are in this repo.**
Computed from the candidate pool at scan time, so it needs no labels and no configuration.

## Validation on a held-out set

The swept corpora cannot decide this: 0.25 and 0.5 were *chosen by looking at them*. So the
choice was tested against **407 instances from SWE-bench Verified, excluding the 93 that overlap
SWE-bench Lite** — including six repositories never previously scored (sphinx, matplotlib,
xarray, astropy, pylint, seaborn).

| collisionAdapt | hit@1 | hit@5 | hit@20 | MRR |
|---|---|---|---|---|
| 0 | 30.71 | 62.90 | 81.33 | 0.4483 |
| **0.25** | **31.20** | **64.13** | **82.06** | **0.4519** |
| 0.5 | 31.45 | 64.13 | 81.33 | 0.4491 |

**0.25 improved every metric. 0.5 did not** — it topped both swept corpora and then went flat on
hit@20 and MRR against unseen data. That difference is what selection bias looks like from the
inside, and without a holdout the published figure would have been the inflated one.

## Shipped result — `collisionAdapt: 0.25`

Matched baselines, all on the shipped build:

| corpus | n | hit@20 | MRR |
|---|---|---|---|
| SWE-bench Lite *(used for tuning)* | 300 | 77.00 → **78.00** | 0.4590 → **0.4682** |
| SWE-bench Multilingual *(used for tuning)* | 300 | 76.67 → **77.33** | 0.4058 → **0.4091** |
| SWE-bench Verified, held out *(never seen)* | 407 | 81.33 → **82.06** | 0.4483 → **0.4519** |

Positive on all three, and the held-out gain lands between the two tuned corpora rather than
below them. **The effect is real and small** — roughly +0.7 to +1.0 points of hit@20. Quote the
held-out figure in preference to the tuned one.

⚠️ The Lite corpus grew from 240 to 300 instances in this session, because cloning repositories
for the held-out set made 60 previously-skipped instances runnable. Earlier figures on 240
instances are **not** comparable; every number above is matched at n=300.
