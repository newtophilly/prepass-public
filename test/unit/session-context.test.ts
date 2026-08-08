import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readSessionContext } from '../../src/core/session-context.js';

/** Build a transcript in Claude Code's shape: one JSON object per line. */
function transcript(entries: unknown[]): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prepass-session-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { path, dir };
}

const userText = (text: string) => ({ type: 'user', message: { content: text } });
const toolUse = (name: string, file_path: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input: { file_path } }] },
});

test('recovers prior turns and the files the session opened', () => {
  const { path, dir } = transcript([
    userText('rework the episode template so the intro is shorter'),
    toolUse('Read', '/repo/src/episodes/EpisodeTemplate.tsx'),
    toolUse('Edit', '/repo/src/Root.tsx'),
    userText('okay lets do it'),
  ]);
  try {
    const ctx = readSessionContext(path, '/repo', 'okay lets do it');
    assert.match(ctx.priorText, /episode template/);
    // The turn being ranked must not be folded into its own context.
    assert.doesNotMatch(ctx.priorText, /okay lets do it/);
    assert.deepEqual([...ctx.touched].sort(), ['src/Root.tsx', 'src/episodes/EpisodeTemplate.tsx']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores records that arrive in a user slot but that no human typed', () => {
  // Feeding tool output back into the query is pseudo-relevance feedback, which
  // measured worse in all seven configurations tried.
  const { path, dir } = transcript([
    userText('the real question about geofence dedupe'),
    { type: 'user', toolUseResult: { ok: true }, message: { content: 'file contents here' } },
    { type: 'user', isMeta: true, message: { content: 'hook injected something' } },
    userText('<system-reminder>ignore me</system-reminder>'),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'more output' }] } },
    userText('now'),
  ]);
  try {
    const ctx = readSessionContext(path, '/repo', 'now', 5);
    assert.match(ctx.priorText, /geofence dedupe/);
    for (const bad of ['file contents here', 'hook injected', 'system-reminder', 'more output']) {
      assert.ok(!ctx.priorText.includes(bad), `leaked: ${bad}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookback bounds how much prior context is used', () => {
  const { path, dir } = transcript([
    userText('alpha the first topic'),
    userText('beta the second topic'),
    userText('gamma the third topic'),
    userText('now'),
  ]);
  try {
    const two = readSessionContext(path, '/repo', 'now', 2);
    assert.ok(two.priorText.includes('gamma'));
    assert.ok(two.priorText.includes('beta'));
    assert.ok(!two.priorText.includes('alpha'), 'lookback of 2 must not reach the third turn back');

    const none = readSessionContext(path, '/repo', 'now', 0);
    assert.equal(none.priorText, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paths outside the repo are dropped, not stored as escapes', () => {
  const { path, dir } = transcript([
    userText('a prompt long enough to count'),
    toolUse('Read', '/repo/src/a.ts'),
    toolUse('Read', '/somewhere/else/b.ts'),
    toolUse('Read', 'relative/c.ts'),
  ]);
  try {
    const ctx = readSessionContext(path, '/repo', 'x');
    assert.ok(ctx.touched.has('src/a.ts'));
    assert.ok(ctx.touched.has('relative/c.ts'));
    for (const p of ctx.touched) assert.ok(!p.startsWith('..'), `escaped the repo: ${p}`);
    assert.ok(!ctx.touched.has('../else/b.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable or corrupt transcript degrades to no context', () => {
  // A hook that throws is worse than a hook that adds nothing.
  const empty = readSessionContext('/no/such/transcript.jsonl', '/repo', 'x');
  assert.equal(empty.priorText, '');
  assert.equal(empty.touched.size, 0);

  const { path, dir } = transcript([]);
  try {
    writeFileSync(path, 'not json\n{"broken":\nalso not json\n');
    const ctx = readSessionContext(path, '/repo', 'x');
    assert.equal(ctx.priorText, '');
    assert.equal(ctx.touched.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only file-opening tools count as touched', () => {
  const { path, dir } = transcript([
    userText('a prompt long enough to count'),
    toolUse('Read', '/repo/read.ts'),
    toolUse('Grep', '/repo/grep.ts'),   // a search is not evidence the agent looked at a file
    toolUse('Bash', '/repo/bash.ts'),
  ]);
  try {
    const ctx = readSessionContext(path, '/repo', 'x');
    assert.deepEqual([...ctx.touched], ['read.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
