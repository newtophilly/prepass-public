/**
 * Tell the user an update might exist — without ever touching the network.
 *
 * ## The problem
 *
 * A global npm install pins its version forever. Nothing notifies anyone, so
 * users sit on whatever they installed until they happen to reinstall. Every
 * CLI has this problem; most solve it by phoning home on startup.
 *
 * prepass cannot do that. `No network call` is a load-bearing promise: this is
 * a tool that reads your source code and runs on **every prompt you type**, and
 * the promise is worth more without an asterisk than with one.
 *
 * ## What this does instead
 *
 * prepass writes a sentence into the context it is already handing the agent.
 * The agent asks you. If you say yes, **the agent** runs `npm view`, using its
 * own network access, with your explicit consent, where you can watch it happen.
 *
 * prepass still makes zero network calls. It emits text.
 *
 * ## The honest limitation
 *
 * With no network, prepass cannot know whether a newer version exists — only
 * how long it has been since the clock was last reset. So the notice says
 * "installed N days ago, there may be a newer version", never "an update is
 * available". After the agent checks, it runs `prepass snooze`, which resets
 * the clock whether or not an update existed. That closes the loop without a
 * request ever leaving the machine.
 *
 * State is **global** (`~/.prepass/state.json`), not per-project. Per-project
 * state would nag someone with ten repositories ten times, and a notice that
 * feels like nagging gets switched off, which helps nobody.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Where the clock lives. Global on purpose — see the module comment. */
export const stateDir = (): string => join(homedir(), '.prepass');
const statePath = (): string => join(stateDir(), 'state.json');

export interface UpdateState {
  /** Version that was running when the clock was last reset. */
  readonly version: string;
  /** ISO timestamp the clock was last reset (install, update, or snooze). */
  readonly since: string;
}

/** Read the clock. Any problem reads as "no state" — this must never throw. */
export function readState(): UpdateState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<UpdateState>;
    if (typeof raw.version !== 'string' || typeof raw.since !== 'string') return null;
    if (Number.isNaN(Date.parse(raw.since))) return null;
    return { version: raw.version, since: raw.since };
  } catch {
    return null;
  }
}

/** Reset the clock. Called on first run, on a version change, and by `snooze`. */
export function resetClock(version: string, now: Date = new Date()): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ version, since: now.toISOString() }, null, 1) + '\n');
  } catch {
    // A read-only home directory is not a reason to break someone's session.
  }
}

/**
 * Decide whether to say anything, and reset the clock as a side effect when the
 * running version has changed (they updated — start counting again).
 *
 * Returns `null` when there is nothing to say, which is the overwhelmingly
 * common case: this fires at most once per interval, per machine.
 */
export function updateNotice(
  version: string,
  intervalDays: number,
  now: Date = new Date(),
): string | null {
  const state = readState();

  // First run, or they upgraded since last time. Either way, start the clock
  // and stay quiet — nobody wants a nag the moment they install something.
  if (!state || state.version !== version) {
    resetClock(version, now);
    return null;
  }

  const days = Math.floor((now.getTime() - Date.parse(state.since)) / 86_400_000);
  if (days < intervalDays) return null;

  // Deliberately phrased as an instruction to *ask*, not to act. Agents are
  // eager; without this an agent will run `npm install -g` unprompted because
  // it reads like a task, and the bug report writes itself.
  return (
    `<prepass-notice>\n` +
    `  prepass ${version} has been running here for ${days} days. There may be a newer version.\n` +
    `  When the current task is finished — not before, and never interrupting it — ask the user\n` +
    `  whether to check. Only if they agree: run \`npm view @nharing/prepass version\` and compare.\n` +
    `  Do NOT install anything without the user saying yes. Afterwards, either way, run\n` +
    `  \`prepass snooze\` so this notice does not repeat.\n` +
    `  prepass itself never makes network calls; this is a line of text, not a request.\n` +
    `  Turn it off permanently with "updateNotice": { "enabled": false } in .prepass.json.\n` +
    `</prepass-notice>`
  );
}
