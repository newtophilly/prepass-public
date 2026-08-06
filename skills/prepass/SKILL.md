---
name: prepass
description: Find which files in this repository are relevant to a request. Use this FIRST, before grep/find/ls, whenever you need to locate code in a codebase you do not already know well — especially when the request describes a symptom ("notifications fire twice") rather than naming a file. Skip it if the request already names the file, or the project is small.
---

# prepass — find the files before searching

`prepass` ranks this repository's files against a request in about 100ms, locally,
with no network call. It is much cheaper than exploring by hand.

## Use it

```bash
prepass prompt "<the user's request, verbatim>"
```

It prints a list of candidate paths, most likely first, with scores.

## What to do with the result

Read the top files it names. They are **ranked guesses, not an answer** — roughly
three quarters of the time the right file is somewhere in the list, and about a
third of the time it is first. So:

- If a suggested file clearly answers the request, work from it.
- If the top few do not fit, search normally. A wrong shortlist costs one cheap
  read; it should not send you down a wrong path.
- If it reports `standing aside`, the project is small enough to read directly —
  just search normally.

## Why this exists

Without it you would typically spend the first few turns running grep and glob to
work out where the relevant code lives. This does that part deterministically and
locally, so those turns go to the actual problem instead.

## Explaining a result

If a ranking looks wrong, `prepass explain "<request>" --why` itemises the score —
which terms matched, in which field, and how rare each term is in this repo.
