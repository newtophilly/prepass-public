# prepass on SWE-bench Multilingual — 300 issues, 41 repos, 9 languages

**Date:** 2026-08-05 · **Mode:** retrieval only, no agent, no API cost · **k = 20** · **no glossary**

Every number in the README until now came from SWE-bench Lite, which is **entirely Python**. That
made "language-agnostic by construction" an assertion rather than a measurement. This is the
correction. Same harness, same shipped build, a dataset authored by the SWE-bench team.

Reproduce with `node bench/swebench.mjs --repos <dir> --data <SWE-bench_Multilingual.json>`.

## Results

| metric | Python (Lite, n=240) | **Multilingual (n=300)** |
|---|---|---|
| hit@1 | 35.4% | **28.3%** |
| hit@5 | 64.2% | **58.3%** |
| **hit@20** | 77.9% | **76.7%** |
| MRR | 0.475 | **0.406** |
| median latency | 104ms | **66ms** |
| gold in pool | 100% | **98.0%** |

**hit@20 held.** 76.7% against 77.9% across nine languages the ranker was never tuned on. That is
the claim worth making: it does not depend on Python conventions.

**hit@1 is where it degrades** — 35.4% → 28.3%. It finds the file about as reliably; it ranks it
first less often.

## By language

| language | n | hit@1 | hit@20 | median pool |
|---|---|---|---|---|
| PHP | 43 | **41.9%** | 86.0% | 2,245 |
| C++ | 12 | 16.7% | **91.7%** | 205 |
| C | 30 | 10.0% | 80.0% | 1,400 |
| Java | 43 | 39.5% | 72.1% | 2,164 |
| Rust | 43 | 27.9% | 79.1% | 777 |
| Go | 42 | 26.2% | 78.6% | 474 |
| Ruby | 44 | 29.5% | 77.3% | 1,884 |
| **JS/TS** | 43 | **20.9%** | **60.5%** | 331 |

JS/TS is the weak spot. C is the odd one — 10% hit@1 but 80% hit@20, so it lands in the shortlist
almost always and on top almost never.

## Two caveats that must travel with these numbers

**1. Some misses are truncation, not ranking.** 30 of 300 instances hit the 5,000-file
`discovery.maxFiles` cap, and gold-in-pool fell to 98.0% (Apache Druid: **40%**). Those gold files
were never scored. Raising the cap would recover some of them — but that would be tuning after
seeing the test, so the number above is the untuned one.

**2. The "×chance" multiplier does not transfer between benchmarks.** These repos are smaller, so
picking 20 files at random hits **5.72%** here versus 1.56% on Lite. Identical tool, identical
quality, and the multiplier falls from 50× to 13×. It is a property of pool size, not of ranking.

## A hypothesis this run refuted

Partway through, on 14 Apache instances, deep Java paths (`src/main/java/org/apache/…`) looked
like they were diluting the directory field — Java gold files sit a median of 5 directories deep
and 81 of them share only 19 distinct three-directory prefixes, against 167 for Python's 300.

The full run refutes it:

- Java hit@1 is **39.5%** — second best of the nine, and above Python's 35.4%
- Java gold paths ≤4 deep: 72.7% hit@20. Deeper than 4: **71.9%**. No difference.
- Across all 300, hit@1 by depth bucket is non-monotonic (depth 5+ scores highest, 34.1%)

Recorded because the mechanism was plausible, the interim data supported it, and it was wrong.
Do not draw conclusions from a partial benchmark run.
