# The test discount: a six-point gain that wasn't there

**Date:** 2026-08-06 · retrieval only · k = 20

A warning for anyone tuning file retrieval against SWE-bench, and a record of a change that
looked like the largest win this project ever measured and was shipped **off**.

## How it was found

The benchmark harness recorded only where the gold file ranked. It threw away the other 19
slots — which is where both of this project's real gains were hiding. It now records the whole
shortlist.

Across 300 SWE-bench Lite issues:

| category | % of top-20 | % of top-5 | % of answers |
|---|---|---|---|
| source | 66.6% | 71.5% | 100% |
| **tests** | **27.2%** | **25.9%** | **0%** |
| i18n | 4.7% | 2.1% | 0% |
| docs | 0.9% | 0.1% | 0% |

Documentation at 0.9% is the prose discount working — it was 60% on Django before that change.
i18n is worth **+0.0002 MRR**; a dead end. Tests are a quarter of every shortlist and, in this
benchmark, never the answer.

## What discounting them appeared to buy

| corpus | hit@1 | hit@5 | hit@20 | MRR |
|---|---|---|---|---|
| Lite, off | 34.11 | 62.88 | 77.93 | 0.4665 |
| Lite, 0.5 | **40.33** | **70.33** | **82.67** | **0.5277** |
| Held-out, off | 31.20 | 64.13 | 82.06 | 0.4519 |
| Held-out, 0.5 | **39.15** | **71.27** | **87.04** | **0.5252** |
| Multilingual, off | 29.00 | 57.33 | 77.33 | 0.4091 |
| Multilingual, 0.5 | **34.33** | **64.67** | **81.67** | **0.4744** |

Six to eight points of hit@1 on three separate corpora, including one held out from tuning. An
order of magnitude larger than any other change measured on this project.

## Why it is not real

**SWE-bench separates the graded fix from its tests by construction.** The `patch` field is the
source change; the tests live in `test_patch` and are applied separately to verify it. Verified
directly: **0 of 300 graded patches touch a test file; 300 of 300 `test_patch`es do.**

So "tests are never the answer" is a property of the benchmark's design, not of software repair.
Every one of those 300 real fixes shipped with test changes.

⚠️ **A held-out SWE-bench corpus does not help.** All three corpora above share the same split, so
the holdout guards against parameter overfitting and not against this at all. That distinction
cost an afternoon and is the main thing worth taking from this document.

## The control that settled it

A corpus was built from **sympy's own git history** — 150 commits with substantive messages and a
single changed file, the message as the query and the changed file as ground truth. Unlike
SWE-bench, **20% of those answers are test files**, because in real work fixing a test *is* the
change.

The commit messages predict their files about as well as GitHub issues do (hit@1 36.0%, MRR
0.455, against 34.3% and 0.468 on Lite), so it is a fair proxy for the task.

| git-history corpus (n≈150) | hit@1 | hit@5 | hit@20 | MRR |
|---|---|---|---|---|
| testWeight off | 38.3 | **55.0** | **71.1** | **0.4748** |
| testWeight 0.5 | 39.3 | 52.7 | 68.7 | 0.4528 |

**hit@5 −2.3, hit@20 −2.4, MRR −0.022.** Once tests can legitimately be the answer, discounting
them costs more than it buys.

## What shipped

`curation.testWeight`, **default 1.0 — no discount**. It exists because someone who never wants
tests in their shortlist should be able to say so, and because a documented dead end is cheaper
than the next person rediscovering it.

The argument that *would* have justified a default discount — that a test path is derivable from
its source path, so a slot spent on one is wasted — is plausible and remains unproven. It
predicts a smaller effect than the benchmark showed, and the control suggests whatever real
effect exists is smaller still, or negative.

**If you are tuning retrieval on SWE-bench: check whether your change interacts with the
patch/test_patch split before you believe your number.**
