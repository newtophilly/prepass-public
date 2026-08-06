/**
 * The telemetry store lives inside whatever project the hook runs in, so its
 * first duty is to stay out of the user's way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../../src/core/telemetry.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the state directory ignores itself, so it never dirties git status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepass-tel-'));
  try {
    const t = await Telemetry.open(join(root, '.prepass', 'telemetry.db'), true);
    const marker = join(root, '.prepass', '.gitignore');
    assert.ok(existsSync(marker), 'must write a .gitignore beside its own state');
    assert.match(readFileSync(marker, 'utf8'), /^\*$/m, 'must ignore everything in there');
    t.close?.();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing .gitignore is left alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepass-tel-'));
  const dir = join(root, '.prepass');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'mine\n');
    const t = await Telemetry.open(join(dir, 'telemetry.db'), true);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'mine\n');
    t.close?.();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabled telemetry writes nothing at all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prepass-tel-'));
  try {
    await Telemetry.open(join(root, '.prepass', 'telemetry.db'), false);
    assert.equal(existsSync(join(root, '.prepass')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
