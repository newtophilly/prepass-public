/**
 * The hook recovers the user's request from the session transcript.
 *
 * This is load-bearing: neither PreToolUse nor UserPromptSubmit includes the
 * prompt text, and a tool's `tool_input` holds that tool's arguments, not what
 * the user asked. Without transcript extraction the hook has nothing to curate
 * against and silently does nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../src/entrypoints/hook.js';

function fakeStdin(payload: string): NodeJS.ReadStream {
  return Readable.from([payload]) as unknown as NodeJS.ReadStream;
}

function captureDecision(): { write: (line: string) => void; output: () => string } {
  let buf = '';
  return { write: (line: string) => (buf += line), output: () => buf };
}

function writeTranscript(lines: unknown[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prepass-transcript-'));
  // These fixtures are tiny by design and would trip the small-repo bypass,
  // which is not what they are testing.
  writeFileSync(join(dir, '.prepass.json'), JSON.stringify({ curation: { minFiles: 0 } }));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, path };
}

const userTurn = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

test('recovers the prompt from the transcript when the event carries none', async () => {
  const { dir, path } = writeTranscript([
    userTurn('something older and unrelated'),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    userTurn('where is the inspection clock logic'),
  ]);
  try {
    const cap = captureDecision();
    const code = await runHook(
      fakeStdin(JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: path, cwd: dir })),
      cap.write,
    );
    assert.equal(code, 0, 'the hook must not fail the session');

    const decision = JSON.parse(cap.output());
    assert.equal(
      decision.hookSpecificOutput?.hookEventName,
      'UserPromptSubmit',
      'the firing event must be echoed, not assumed',
    );
    // 'search' is the workload for a "where is ..." question.
    assert.match(decision.systemMessage, /search/, 'the status line should name the detected workload');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores tool results, which are also recorded as user-role messages', async () => {
  const { dir, path } = writeTranscript([
    userTurn('review the ordinance rules for correctness'),
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file contents here' }],
      },
    },
  ]);
  try {
    const cap = captureDecision();
    await runHook(
      fakeStdin(JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: path, cwd: dir })),
      cap.write,
    );

    const decision = JSON.parse(cap.output());
    // Curating against the tool_result would misclassify; the real request is
    // a review, so anything else means the tool_result won.
    assert.match(decision.systemMessage, /review/, 'a review prompt must classify as review, not the default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('echoes back the firing event name, not a hard-coded one', async () => {
  const { dir, path } = writeTranscript([userTurn('fix the crash in the auth parser')]);
  try {
    for (const name of ['PreToolUse', 'UserPromptSubmit']) {
      const cap = captureDecision();
      await runHook(
        fakeStdin(JSON.stringify({ hook_event_name: name, transcript_path: path })),
        cap.write,
      );
      const decision = JSON.parse(cap.output());
      assert.equal(
        decision.hookSpecificOutput?.hookEventName,
        name,
        `additionalContext is only honored when hookEventName matches the firing event`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or unreadable transcript degrades to a no-op', async () => {
  const cap = captureDecision();
  const code = await runHook(
    fakeStdin(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        transcript_path: '/nonexistent/transcript.jsonl',
      }),
    ),
    cap.write,
  );

  assert.equal(code, 0, 'must never block the session');
  const decision = JSON.parse(cap.output());
  assert.equal(decision.continue, true, 'a degraded run still has to let the prompt through');
  assert.equal(
    decision.hookSpecificOutput,
    undefined,
    'with nothing useful to add, emit no context rather than an empty block',
  );
});

/**
 * A hook that fails silently is indistinguishable from one that is working and
 * finding nothing — which is how an invalid config once made the whole tool
 * look functional while doing nothing. Failures must announce themselves.
 */
test('a pipeline failure surfaces a reason instead of failing silently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepass-badcfg-'));
  try {
    writeFileSync(join(dir, '.prepass.json'), JSON.stringify({ notARealKey: true }));
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify(userTurn('fix the crash in the parser')) + '\n');

    const cap = captureDecision();
    const code = await runHook(
      fakeStdin(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          cwd: dir,
          transcript_path: transcript,
        }),
      ),
      cap.write,
    );

    assert.equal(code, 0, 'must never block the session');
    const decision = JSON.parse(cap.output());
    assert.equal(decision.continue, true);
    assert.match(decision.systemMessage ?? '', /prepass: skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Codex CLI ships the same hook contract as Claude Code — the same five events
 * and the same `continue` / `systemMessage` / `hookSpecificOutput` response —
 * but its `UserPromptSubmit` payload carries `prompt` directly instead of
 * making the handler recover it from a transcript. One binary serves both, and
 * this pins that so a Claude-shaped assumption can't creep back in.
 */
test('a Codex-shaped event works without a transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepass-codex-'));
  try {
    writeFileSync(join(dir, 'inspection-clock.ts'), 'export function inspectionClock() {}\n');
    const cap = captureDecision();
    const code = await runHook(
      fakeStdin(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          agent_id: 'a1',
          agent_type: 'codex',
          model: 'gpt-5.5',
          permission_mode: 'default',
          cwd: dir,
          prompt: 'where is the inspection clock logic',
          // Deliberately no transcript_path — Codex does not send one here.
        }),
      ),
      cap.write,
    );

    assert.equal(code, 0);
    const decision = JSON.parse(cap.output());
    assert.equal(decision.continue, true);
    assert.equal(decision.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.match(decision.hookSpecificOutput.additionalContext, /candidate-files/);
    assert.match(decision.hookSpecificOutput.additionalContext, /inspection-clock\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the status line names no model, since the host may not be Claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prepass-status-'));
  try {
    // A one-file fixture is below the small-repo threshold, and this test is
    // about wording rather than that rule, so opt in explicitly.
    writeFileSync(join(dir, '.prepass.json'), JSON.stringify({ curation: { minFiles: 0 } }));
    writeFileSync(join(dir, 'a.ts'), 'export const inspectionClock = 1;\n');
    const cap = captureDecision();
    await runHook(
      fakeStdin(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          cwd: dir,
          prompt: 'where is the inspection clock logic',
        }),
      ),
      cap.write,
    );
    const { systemMessage } = JSON.parse(cap.output());
    assert.doesNotMatch(systemMessage, /claude|gpt|opus|sonnet|haiku/i);
    assert.match(systemMessage, /prepass · search · /);
    assert.match(systemMessage, /confidence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
