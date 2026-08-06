# prepass on SWE-bench Lite — retrieval, 240 instances

> ⚠️ **SUPERSEDED — historical record only.** These numbers predate two changes and a corpus
> change. Current figures live in [`../README.md`](../README.md) and
> [`collision-adapt-2026-08-05.md`](./collision-adapt-2026-08-05.md), measured on **300**
> instances: the corpus grew from 240 when more repositories became available locally, so the
> figures below are **not comparable** to the current ones. Kept because the reasoning about
> per-field rarity and directory weighting is still what the code does.

**Date:** 2026-08-04 · **Mode:** retrieval only, no agent, no API cost · **k = 20** · **no glossary**

The labelled set in `eval-set.json` has a flaw that cannot be fixed from inside it: the same
person wrote the queries, the ground-truth labels, and the glossary entries that hit those
labels. This is the correction. Every query here is a real GitHub issue written by a stranger;
every label is the set of files the accepted fix actually touched; every repo is one we have
never opened. Reproduce with `bench/swebench.mjs`.

## Results

| metric | first run | after two fixes | |
|---|---|---|---|
| hit@1 | 20.0% | **~25%** | the file that needed fixing ranked first |
| hit@3 | 36.3% | **43.3%** | |
| hit@5 | 40.8% | **52.1%** | |
| hit@10 | 52.9% | **62.1%** | |
| **hit@20** | 63.3% | **70.8%** | found anywhere in the shortlist |
| MRR | 0.305 | **0.383** | |
| median latency | 109ms | **111ms** | over a median pool of 1,866 files |
| gold in pool | 100% | **100%** | so every miss is a *ranking* failure, never truncation |

**Floor:** picking 20 files at random from the same pools hits **1.563%** (every instance has exactly one gold file, so the exact hypergeometric and the linear approximation agree). At 70.8% that is **45×**; after the prose discount, at 77.9%, it is **50×**.

## By repo

| repo | n | hit@1 (before → after) | hit@20 (before → after) |
|---|---|---|---|
| sympy/sympy | 77 | 35% → 35% | 71% → **74%** |
| scikit-learn | 23 | 22% → **26%** | 65% → **78%** |
| pytest | 17 | 6% → **24%** | 65% → 59% |
| django/django | 114 | 11% → **23%** | 54% → **67%** |
| requests | 6 | 17% → 17% | 100% → 100% |
| flask | 3 | 33% → **67%** | 100% → 100% |

## What the benchmark bought — two fixes it made possible

**1. Per-field rarity.** A filename match was weighted by how rare the term is in file *contents*.
Django has 6,712 files of which **66% share a basename with another** (628 `__init__.py`, 209
`tests.py`, 194 `models.py`); sympy's figure is 18%. So "matched the filename" means almost
nothing in Django and a great deal in sympy, and body frequency could not tell them apart.
Body, basename and directory now each carry their own document frequency.

**2. The directory was weighted 10× too low.** It sat at 0.4 against the basename's 4.0, on the
assumption that the filename is the informative part of a path. True in a small repo, wrong in a
large one: `django/db/models/` says far more than `base.py` does. Swept against these 240 issues,
raising it improved results *monotonically at every basename weight* — the signature of a real
effect rather than noise. Both constants now sit **mid-plateau** (base 3–4 and dir 4–6 all score
0.354–0.363) rather than at the measured peak, because 240 instances cannot justify chasing an
exact optimum.

Django — the repo this targeted — roughly **doubled** its hit@1, and no repo regressed on hit@20
except pytest (n=17, 65% → 59%).

## What this does and does not say

**It does not invalidate the cost measurements.** Those came from agent *behaviour* — the agent
stopped spawning search subagents — and a rank-15 hit still narrows 6,000 files to 20. Saving a
search does not require hit@1.

**It does puncture any claim of ranking precision.** Four in five times the top file is wrong.
Anyone selling this on "it finds the right file" would be overselling it.

**It quantifies the circularity.** The hand-written set scores MRR 0.841; this scores 0.305. That
gap of 0.54 is the cost of grading your own homework, and it is worth remembering the next time a
number looks good.

**Conditions differ from the −47% cost run**, in prepass's favour there: that was a repo the user
knows, with a hand-written glossary, and short symptom-style prompts. This is cold, glossary-less,
on strangers' code, with prompts that are long rambling GitHub issues full of stack traces. Real
users start in the second condition and move toward the first.

**Intent classification held up on inputs nobody here wrote:** 155 bugfix, 47 feature, 31 search,
6 refactor, 1 review — plausible for a set of bug reports, and evidence the taxonomy fix
generalised rather than fitting one person's phrasing.

## The bug this found

The first run **crashed at instance 53**. Glossary lookup used a plain property access, so a
prompt containing `constructor` — or `toString`, `valueOf`, `hasOwnProperty` — resolved against
`Object.prototype` and returned something truthy with no `expands`. Real bug reports use those
words constantly; 53 unit tests and an 11-case eval never did. Fixed in `a01cc85`.

That alone justified the exercise.

## Honest limits

- **File-level, not function-level.** Published baselines like SweRank measure function-level
  Acc@k; these numbers are not comparable to those and should not be presented as if they were.
- **k = 20** is generous. At the k=12 a bugfix actually emits, hit rate sits nearer hit@10 (53%).
- **60 of 300 instances skipped** — repos not cloned (matplotlib, sphinx, astropy, xarray,
  seaborn, pylint).
- **No glossary and no `observed` learning**, both of which exist and would presumably help. This
  is the floor for a cold install, not the ceiling.

---

## Re-run after the prose discount — 2026-08-04 (authoritative)

Same 240 instances, same harness, run against the **shipped** build so the published figures
come from the code people actually install. Raw data: `swebench-lite-2026-08-04b.json`.

| metric | before prose discount | **after** | |
|---|---|---|---|
| hit@1 | 27.5% | **35.4%** | the file that needed fixing ranked first |
| hit@3 | 43.3% | **53.8%** | |
| hit@5 | 52.1% | **64.2%** | |
| hit@10 | 62.1% | **71.2%** | |
| **hit@20** | 70.8% | **77.9%** | found anywhere in the shortlist |
| MRR | 0.383 | **0.475** | +24% |
| median latency | 111ms | **105ms** | over a median pool of 1,866 files |
| gold in pool | 100% | **100%** | every miss is a *ranking* failure, never truncation |

### By repo

| repo | n | hit@1 | hit@20 |
|---|---|---|---|
| django/django | 114 | 32% | **80%** |
| sympy/sympy | 77 | 38% | 74% |
| scikit-learn | 23 | 35% | 83% |
| pytest-dev/pytest | 17 | 35% | 65% |
| psf/requests | 6 | 50% | 100% |
| pallets/flask | 3 | 67% | 100% |

### What changed

**In-repo prose is discounted rather than excluded.** Django ships its documentation inside
the repository, and a GitHub issue is prose describing a feature — so is
`docs/topics/forms/media.txt`. On lexical match the docs beat the source almost every time.
Documentation is ~8% of that tree and was taking **60%** of the shortlist.

Discounting by a score multiplier and *not* by removing files from the corpus is deliberate:
pruning shifts every statistic IDF is computed from, and measured **worse** when tried
(MRR 0.383 → 0.347 excluding `.po`/`.mo`). Django, the repo this targeted, went 67% → **80%**
on hit@20 and 23% → **32%** on hit@1.

**Still four times in five the top file is wrong.** prepass narrows the haystack; it does not
hand you the needle. Picking 20 files at random from the same pools hits 1.563%.
