/**
 * `doctor` is the command someone runs when prepass appears to do nothing.
 *
 * It had no tests, which is the wrong way round: prepass degrades silently by
 * design — a missing hook, an unparseable settings file and a repo below the
 * size threshold all look identical from the outside, namely "it ran and found
 * little". `doctor` is the only thing that distinguishes them, so a `doctor`
 * that is wrong is worse than no `doctor` at all.
 *
 * Every case here is a failure that actually happened to somebody.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { diagnose } from '../../src/core/doctor.js';
import { configSchema } from '../../src/schemas/config.js';

const config = configSchema.parse({});
const smoke = () => ({ files: 12, ms: 20 });
const find = (checks: ReturnType<typeof diagnose>, name: string) =>
  checks.find((c) => c.name === name);

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'prepass-doctor-'));
}

test('says plainly when nothing is registered, because silence is the failure mode', () => {
  const dir = tempProject();
  try {
    const wiring = find(diagnose(dir, config, smoke), 'wiring');
    assert.equal(wiring?.level, 'fail', 'an unregistered project must fail, not warn');
    assert.match(
      wiring?.detail ?? '',
      /nothing is registered/i,
      'the detail has to name the problem — the user is here because nothing happened',
    );
    assert.match(wiring?.fix ?? '', /prepass init/, 'a failure without a fix wastes the trip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports a registered hook rather than claiming nothing is wired', () => {
  const dir = tempProject();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/settings.json'),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'prepass hook' }] }] },
      }),
    );
    const wiring = find(diagnose(dir, config, smoke), 'wiring');
    assert.equal(wiring?.level, 'ok', 'a correctly registered hook must not report as failing');
    assert.match(wiring?.detail ?? '', /Claude Code/, 'say which agent was found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a settings file that is not valid JSON fails loudly instead of reading as unregistered', () => {
  const dir = tempProject();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude/settings.json'), 'not json {{{');
    const checks = diagnose(dir, config, smoke);
    assert.ok(
      checks.some((c) => c.level === 'fail' && /not valid JSON/i.test(c.detail)),
      'unparseable settings must be distinguishable from absent settings',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registering the same hook twice is reported — it runs twice per prompt', () => {
  const dir = tempProject();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'prepass hook' }] },
            { hooks: [{ type: 'command', command: 'prepass hook' }] },
          ],
        },
      }),
    );
    const checks = diagnose(dir, config, smoke);
    assert.ok(
      checks.some((c) => c.level === 'warn' && /registered 2 times/i.test(c.detail)),
      'a duplicate registration doubles latency and cost, so it must be surfaced',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an absolute hook path that no longer resolves is a failure, not a pass', () => {
  const dir = tempProject();
  try {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: '/nonexistent/bin/prepass hook' }] },
          ],
        },
      }),
    );
    const checks = diagnose(dir, config, smoke);
    assert.ok(
      checks.some((c) => c.level === 'fail' && /does not exist/i.test(c.detail)),
      'a stale absolute path is the quiet way this dies after a reinstall',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('points at the repository one level down instead of scanning its parent', () => {
  // The failure this exists for: an agent started in a container folder while
  // the actual project sits inside it. A file-count comparison stayed silent on
  // exactly this case, because walking the container picked up more loose files
  // than the repo tracked. The signal has to be structural.
  const dir = tempProject();
  try {
    const inner = join(dir, 'my-app');
    mkdirSync(inner, { recursive: true });
    execFileSync('git', ['-C', inner, 'init', '-q'], { stdio: 'ignore' });
    for (let i = 0; i < 30; i++) writeFileSync(join(inner, `f${i}.ts`), 'export const x = 1;\n');
    execFileSync('git', ['-C', inner, 'add', '-A'], { stdio: 'ignore' });

    const location = find(diagnose(dir, config, smoke), 'location');
    assert.equal(location?.level, 'warn', 'scanning the wrong directory must not look healthy');
    assert.match(
      location?.fix ?? '',
      /my-app/,
      'the fix has to name the directory to start in, not just say something is wrong',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a smoke test returning nothing is surfaced rather than reported as healthy', () => {
  const dir = tempProject();
  try {
    const checks = diagnose(dir, config, () => ({ files: 0, ms: 5 }));
    const smokeCheck = find(checks, 'smoke test');
    assert.equal(smokeCheck?.level, 'warn', 'ranking zero files is the original silent failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing smoke test is caught and reported, never propagated', () => {
  const dir = tempProject();
  try {
    const checks = diagnose(dir, config, () => {
      throw new Error('ripgrep exploded');
    });
    const smokeCheck = find(checks, 'smoke test');
    assert.equal(smokeCheck?.level, 'fail');
    assert.match(
      smokeCheck?.detail ?? '',
      /exploded/,
      'doctor must report the underlying error, not swallow it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
