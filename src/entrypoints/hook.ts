/**
 * Agent hook entrypoint: `prepass hook`.
 *
 * Works with **Claude Code and Codex CLI**, which share a hook contract: the
 * same five events, and an output of `continue` / `systemMessage` /
 * `hookSpecificOutput.additionalContext`. Handles `UserPromptSubmit` (once per
 * request — usually what you want) and `PreToolUse` (once per tool call).
 *
 * The two differ in one place, and it favours Codex: its `UserPromptSubmit`
 * payload carries `prompt` directly, while Claude Code's does not, so the
 * request has to be recovered from the session transcript. `extractPrompt`
 * prefers the field and falls back to the transcript, which means the same
 * binary serves both without branching on the agent.
 *
 * Everything here is local and deterministic, so a hook can never block a
 * session on the network. The wire format is owned by the host, so we parse
 * defensively and degrade to a no-op (exit 0, empty output) on anything
 * unexpected rather than blocking the user's request.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { readSessionContext } from '../core/session-context.js';
import { updateNotice } from '../core/update-notice.js';
import { VERSION } from '../version.js';
import type { ContextCandidate } from '../types.js';
import { runPipeline } from '../pipeline.js';
import { loadConfig } from '../config.js';
import { log } from '../core/telemetry.js';
import { confidenceOf } from '../core/context-curator.js';

/** Loosely-typed view of the hook payload we care about. */
interface HookEvent {
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly prompt?: string;
  readonly cwd?: string;
  /**
   * Path to the session transcript. This is the only place the user's actual
   * request is available: neither PreToolUse nor UserPromptSubmit carries the
   * prompt text, and a tool's `tool_input` holds that tool's arguments — a
   * grep pattern, a file path — not what the user asked for.
   */
  readonly transcript_path?: string;
}

/** Events we know how to answer. */
type HookEventName = 'PreToolUse' | 'UserPromptSubmit';

/**
 * Shape Claude Code reads back from a PreToolUse hook.
 *
 * `additionalContext` MUST be nested under `hookSpecificOutput` alongside
 * `hookEventName` — Claude Code ignores a top-level `additionalContext`
 * entirely, which makes the hook a silent no-op. Exit code must be 0 for the
 * JSON to be processed at all.
 *
 * https://code.claude.com/docs/en/hooks
 */
interface HookDecision {
  readonly continue: boolean;
  /** Advisory metadata, surfaced to the user rather than the model. */
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName: HookEventName;
    /** Extra context inserted next to the tool result on the next request. */
    readonly additionalContext: string;
  };
}

/**
 * Sink for the hook's JSON decision. Injectable because tests must not
 * monkey-patch `process.stdout` — under `node --test` that stream also carries
 * the runner's own binary protocol, and intercepting it corrupts both.
 */
export type DecisionWriter = (line: string) => void;

const stdoutWriter: DecisionWriter = (line) => {
  process.stdout.write(line);
};

export async function runHook(
  stdin: NodeJS.ReadStream = process.stdin,
  write: DecisionWriter = stdoutWriter,
): Promise<number> {
  let event: HookEvent;
  try {
    event = parseEvent(await readAll(stdin));
  } catch (err) {
    // Malformed input: don't block the tool call.
    log('warn', 'hook.parse_failed', { error: String(err) });
    emit({ continue: true }, write);
    return 0;
  }

  const prompt = extractPrompt(event);
  if (!prompt) {
    emit({ continue: true }, write);
    return 0;
  }

  try {
    // Discovery must scan the project the event came from. Claude Code normally
    // runs hooks with that as cwd, but the event carries it explicitly, so
    // prefer the stated value over the ambient one.
    const loaded = loadConfig(event.cwd ?? process.cwd());
    // The transcript is already open to recover the prompt; read the rest of it
    // too. A contextless follow-up ("okay lets do it") cannot be ranked from its
    // own text, and the answer is usually a file this session already opened.
    const sc = loaded.config.curation.sessionContext;
    const session =
      sc.enabled && event.transcript_path
        ? readSessionContext(event.transcript_path, loaded.rootDir, prompt, sc.lookback)
        : undefined;

    const result = await runPipeline({
      prompt,
      candidates: extractCandidates(event),
      entrypoint: 'hook',
      loaded,
      ...(session && (session.priorText || session.touched.size) ? { session } : {}),
    });
    // A global npm install pins its version forever and nothing tells the user
    // otherwise. prepass will not phone home to find out — it appends a sentence
    // asking the AGENT to ask, and the agent makes the request with its own
    // network access only after the user agrees. Fires at most once every
    // `intervalDays`, per machine, and never on the run where the version changed.
    const notice = loaded.config.updateNotice.enabled
      ? updateNotice(VERSION, loaded.config.updateNotice.intervalDays)
      : null;

    emit(
      {
        continue: true,
        systemMessage: statusLine(result),
        hookSpecificOutput: {
          hookEventName: eventName(event),
          additionalContext: notice
            ? `${result.curation.payload}\n${notice}`
            : result.curation.payload,
        },
      },
      write,
    );
    return 0;
  } catch (err) {
    // Never block the session — but say so out loud. A hook that fails
    // silently is indistinguishable from one that is working and finding
    // nothing, and the usual cause (an invalid `.prepass.json`) is
    // trivially fixable once you know about it.
    log('error', 'hook.pipeline_failed', { error: String(err) });
    emit(
      {
        continue: true,
        systemMessage: `prepass: skipped — ${firstLine(err)}`,
      },
      write,
    );
    return 0;
  }
}

/**
 * The one line the user actually sees. It is the whole visible surface of a
 * tool that otherwise runs invisibly, so it reports what was *done* — how many
 * files, how sure, how long — and nothing else.
 *
 * It used to read "bugfix (claude-opus-5, escalated)". Naming a model was wrong
 * twice over: nothing acts on the routing decision, and this hook also runs
 * under Codex, where announcing a Claude model to a GPT session is simply
 * false. The workload stays — it is real, and it is the first thing worth
 * knowing when the results look wrong.
 */
function statusLine(result: Awaited<ReturnType<typeof runPipeline>>): string {
  const n = result.curation.selected.length;
  if (result.curation.degraded === 'repo-too-small') {
    return `prepass · standing aside · project small enough to read directly`;
  }
  if (n === 0) return `prepass · ${result.intent.workload} · no candidates · searching as normal`;
  const confidence = confidenceOf(result.curation.selected);
  return (
    `prepass · ${result.intent.workload} · ${n} file${n === 1 ? '' : 's'} · ` +
    `${confidence} confidence · ${result.latencyMs}ms`
  );
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split('\n')[0] ?? message).slice(0, 200);
}

/**
 * Recover the user's request.
 *
 * Hook events do not carry it. `UserPromptSubmit` announces that a prompt was
 * submitted without including its text, and `PreToolUse` carries only the
 * tool's own arguments. So we fall back to the session transcript, which both
 * events locate via `transcript_path`.
 */
function extractPrompt(event: HookEvent): string {
  if (typeof event.prompt === 'string' && event.prompt.trim()) return event.prompt;

  // Some tools do carry request-like text (Bash descriptions, Task prompts).
  // Prefer it when present: it is more specific than the whole user turn.
  const input = event.tool_input ?? {};
  for (const key of ['prompt', 'query', 'description', 'command', 'content']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v;
  }

  if (event.transcript_path) {
    const fromTranscript = lastUserMessage(event.transcript_path);
    if (fromTranscript) return fromTranscript;
  }
  return '';
}

/**
 * Last human-authored message in a JSONL transcript.
 *
 * Reads a bounded tail rather than the whole file — transcripts routinely reach
 * tens of megabytes, and this runs on the critical path of a tool call. Lines
 * are scanned newest-first and the first genuine user turn wins.
 */
function lastUserMessage(transcriptPath: string, tailBytes = 256 * 1024): string {
  let text: string;
  let start: number;
  try {
    const size = statSync(transcriptPath).size;
    start = Math.max(0, size - tailBytes);
    const fd = openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(tailBytes, size));
      const read = readSync(fd, buf, 0, buf.length, start);
      text = buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    log('debug', 'hook.transcript_unreadable', { error: String(err) });
    return '';
  }

  const lines = text.split('\n');
  // Only discard the first line when the read began mid-file, where it is
  // probably a fragment. Discarding it unconditionally would drop the only
  // entry in a short transcript.
  const lowest = start > 0 ? 1 : 0;
  for (let i = lines.length - 1; i >= lowest; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('{')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = userContentOf(entry);
    if (content) return content;
  }
  return '';
}

/**
 * Text of a transcript entry, if it is a real user turn. Tool results are
 * recorded as user-role messages too, so they must be filtered out — otherwise
 * we would curate against a previous tool's output instead of the request.
 */
function userContentOf(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return '';
  const e = entry as Record<string, unknown>;
  if (e['type'] !== 'user') return '';

  const message = e['message'];
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as Record<string, unknown>)['content'];

  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    // tool_result blocks are machine output, not something the user asked.
    if (b['type'] !== 'text') return '';
    if (typeof b['text'] === 'string') parts.push(b['text']);
  }
  return parts.join(' ').trim();
}

/** Pull candidate file paths (e.g. tool targeting a file) from the event. */
function extractCandidates(event: HookEvent): ContextCandidate[] {
  const input = event.tool_input ?? {};
  const paths = new Set<string>();
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = input[key];
    if (typeof v === 'string' && v) paths.add(v);
  }
  return [...paths].map((path) => ({ path, bytes: 0, score: 0.5 }));
}

function parseEvent(raw: string): HookEvent {
  const parsed: unknown = JSON.parse(raw || '{}');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('hook event is not an object');
  }
  return parsed as HookEvent;
}

/**
 * Echo back the event we were called for. `additionalContext` is only honored
 * when `hookEventName` matches the firing event, so hard-coding it would make
 * the hook a no-op under whichever event it wasn't hard-coded to.
 */
function eventName(event: HookEvent): HookEventName {
  return event.hook_event_name === 'UserPromptSubmit' ? 'UserPromptSubmit' : 'PreToolUse';
}

function emit(decision: HookDecision, write: DecisionWriter): void {
  write(JSON.stringify(decision) + '\n');
}

function readAll(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (data += chunk));
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}
