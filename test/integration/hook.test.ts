/**
 * Integration stub: the PreToolUse hook adapter.
 *
 * Feeds a synthetic hook event on a fake stdin and asserts the adapter emits a
 * valid, non-blocking decision. Exercises the "malformed input never blocks the
 * tool call" contract too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runHook } from '../../src/entrypoints/hook.js';

/** Build a fake stdin carrying `payload` as a single chunk. */
function fakeStdin(payload: string): NodeJS.ReadStream {
  const stream = Readable.from([payload]) as unknown as NodeJS.ReadStream;
  return stream;
}

/**
 * Collect the hook's decision via the injected writer. Never patch
 * `process.stdout` here — under `node --test` that stream also carries the
 * runner's own protocol frames.
 */
function captureDecision(): { write: (line: string) => void; output: () => string } {
  let buf = '';
  return { write: (line: string) => (buf += line), output: () => buf };
}

test('emits a continue decision for a valid event', async () => {
  const cap = captureDecision();
  const event = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { prompt: 'fix the crash in the parser', file_path: 'src/parser.ts' },
  });
  const code = await runHook(fakeStdin(event), cap.write);

  assert.equal(code, 0, 'a non-zero exit makes the agent treat the hook as broken');
  const decision = JSON.parse(cap.output());
  assert.equal(decision.continue, true, 'prepass must never block the user\'s prompt');

  // Claude Code only reads additionalContext from inside hookSpecificOutput.
  // At the top level it is silently ignored and the hook does nothing.
  // https://code.claude.com/docs/en/hooks
  assert.equal(decision.additionalContext, undefined, 'must not sit at the top level');
  assert.equal(
    decision.hookSpecificOutput?.hookEventName,
    'PreToolUse',
    'the event name must be echoed back, not hard-coded — Codex fires different ones',
  );
  assert.ok(
    typeof decision.hookSpecificOutput?.additionalContext === 'string',
    'additionalContext must be a string; an object here is silently dropped',
  );
  assert.match(
    decision.hookSpecificOutput.additionalContext,
    /candidate-files/,
    'the payload must carry the ranked files — an empty context reads exactly like success',
  );
});

test('never blocks on malformed input', async () => {
  const cap = captureDecision();
  const code = await runHook(fakeStdin('not json {{{'), cap.write);

  assert.equal(code, 0, 'malformed input must still exit 0 — a crash would block the prompt');
  assert.equal(
    JSON.parse(cap.output()).continue,
    true,
    'garbage on stdin must degrade to a no-op, never to a block',
  );
});

// TODO: assert workload/model in systemMessage once taxonomies are frozen.
