#!/usr/bin/env python3
"""A/B harness: does claude-smart's injected file map reduce Claude's search work?

Runs the same prompts through real headless Claude Code sessions twice -- once with the
claude-smart hook registered, once without -- and reports tool calls, tokens, cost and time.

    python3 bench/ab.py                      # default: sandbox + this repo
    python3 bench/ab.py --repo /path/to/big  # measure any repo
    python3 bench/ab.py --repeat 3           # 3 runs per cell for defensible numbers

WHY TOOL CALLS AND NOT `num_turns`
  `num_turns` counts top-level turns only. When Claude spawns a subagent to go hunting, all of
  that work is invisible -- a run measured on 2026-08-01 reported `num_turns: 2` while making 15
  tool calls. So this harness uses `--output-format stream-json` and counts `tool_use` blocks.
  Note `--allowedTools` does NOT stop a spawned subagent from calling other tools.
"""
import argparse, json, os, subprocess, statistics, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

DEFAULT_CASES = [
    # This repo, so the benchmark runs for anyone who clones it. Point --repo at a
    # bigger codebase to see the effect that matters: the saving scales with repo size.
    (REPO, [
        "where is the relevance ranking implemented and how does it score files?",
        "which file decides the model tier and what triggers an escalation?",
        "how does the hook recover the user's prompt when the event doesn't carry it?",
    ]),
]


def run_once(cwd, prompt, hook_on, model):
    settings = os.path.join(HERE, "hook-on.json" if hook_on else "hook-off.json")
    cmd = [
        "claude", "-p", prompt,
        "--settings", settings,
        "--setting-sources", "user",
        "--model", model,
        "--output-format", "stream-json", "--verbose",
        "--allowedTools", "Read", "Grep", "Glob",
        "--permission-mode", "bypassPermissions",
    ]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return {"error": "timeout", "wall_s": round(time.time() - t0, 1)}

    tools, result, answer = [], {}, ""
    for line in p.stdout.splitlines():
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("type") == "assistant":
            for c in d.get("message", {}).get("content", []) or []:
                if c.get("type") == "tool_use":
                    tools.append(c.get("name"))
        elif d.get("type") == "result":
            result = d
            answer = (d.get("result") or "")[:400]

    if not result:
        return {"error": (p.stderr or p.stdout or "no result")[:200]}

    u = result.get("usage", {}) or {}
    return {
        "tool_calls": len(tools),
        "tools": tools,
        "spawned_subagent": any(t in ("Agent", "Task") for t in tools),
        "cost": result.get("total_cost_usd"),
        "duration_ms": result.get("duration_ms"),
        "cache_creation": u.get("cache_creation_input_tokens"),
        "cache_read": u.get("cache_read_input_tokens"),
        "output_tokens": u.get("output_tokens"),
        "answer": answer,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", action="append", help="repo to measure (repeatable)")
    ap.add_argument("--prompt", action="append", help="prompt to use with --repo")
    ap.add_argument("--repeat", type=int, default=1, help="runs per cell (default 1)")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--out", default=os.path.join(HERE, "results.jsonl"))
    args = ap.parse_args()

    if args.repo:
        prompts = args.prompt or [p for _, ps in DEFAULT_CASES for p in ps][:3]
        cases = [(r, prompts) for r in args.repo]
    else:
        cases = DEFAULT_CASES

    rows = []
    with open(args.out, "w") as f:
        for cwd, prompts in cases:
            if not os.path.isdir(cwd):
                print(f"!! skipping missing repo: {cwd}", file=sys.stderr)
                continue
            label = os.path.basename(cwd.rstrip("/"))
            for prompt in prompts:
                for hook_on in (True, False):
                    for i in range(args.repeat):
                        state = "ON " if hook_on else "OFF"
                        print(f"[{label}] hook={state} run={i+1} :: {prompt[:55]}", flush=True)
                        r = run_once(cwd, prompt, hook_on, args.model)
                        rec = {"repo": label, "hook": "on" if hook_on else "off",
                               "prompt": prompt, "run": i + 1, **r}
                        rows.append(rec)
                        f.write(json.dumps(rec) + "\n")
                        f.flush()
                        print(f"      tools={r.get('tool_calls')} subagent={r.get('spawned_subagent')} "
                              f"cost={r.get('cost')} {r.get('error','')}", flush=True)
    report(rows)
    print(f"\nraw -> {args.out}")


def report(rows):
    ok = [r for r in rows if not r.get("error")]
    if not ok:
        print("\nno successful runs")
        return
    print("\n" + "=" * 72)
    print(f"{'repo':<20}{'hook':<6}{'tool calls':>11}{'cost':>10}{'subagents':>11}")
    print("-" * 72)
    for repo in dict.fromkeys(r["repo"] for r in ok):
        for hook in ("on", "off"):
            cell = [r for r in ok if r["repo"] == repo and r["hook"] == hook]
            if not cell:
                continue
            print(f"{repo:<20}{hook:<6}"
                  f"{statistics.mean(r['tool_calls'] for r in cell):>11.1f}"
                  f"{sum(r['cost'] or 0 for r in cell):>10.3f}"
                  f"{sum(1 for r in cell if r['spawned_subagent']):>11}")
        on = [r for r in ok if r["repo"] == repo and r["hook"] == "on"]
        off = [r for r in ok if r["repo"] == repo and r["hook"] == "off"]
        if on and off:
            c_on = sum(r["cost"] or 0 for r in on)
            c_off = sum(r["cost"] or 0 for r in off)
            if c_off:
                print(f"{'':<20}{'-> ':<6}{'':>11}{(c_on - c_off) / c_off * 100:>9.0f}%  cost delta")
    print("=" * 72)
    print("Check the answers in the raw file too -- cheap but wrong is not a win.")


if __name__ == "__main__":
    main()
