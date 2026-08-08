import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectCreationIntent, applyCreationMode } from '../../src/core/creation-intent.js';
import type { ContextCandidate } from '../../src/types.js';

const cand = (path: string, score = 1): ContextCandidate => ({ path, bytes: 100, score });

test('recognises a request for something that does not exist yet', () => {
  for (const p of [
    'build the doctor command, what is the doctor command going to do?',
    'Create a DesignSystem layer. Add DesignSystem/Colors.swift',
    'implement a new endpoint for cancelling a subscription',
    'scaffold a settings page',
    'set up a worker to retry failed webhooks',
  ]) {
    assert.equal(detectCreationIntent(p).creating, true, p);
  }
});

test('does not fire on ordinary changes to code that already exists', () => {
  // The expensive false positive: these are the majority of prompts, and
  // reordering them would move the registry ahead of the actual culprit.
  for (const p of [
    'the arrival notification fires twice when the geofence reports a duplicate',
    'add a null check before dereferencing the response body',
    'I added a log line to debug the crash and it still happens',
    'why is the checkout page throwing on submit',
    'rename evaluateUnit to evaluateInspection everywhere',
    'the build is broken after the last merge',
  ]) {
    assert.equal(detectCreationIntent(p).creating, false, p);
  }
});

test('an explicit filename is enough on its own', () => {
  const s = detectCreationIntent('create Spacing.swift and Colors.swift under DesignSystem');
  assert.equal(s.creating, true);
  assert.deepEqual([...s.named].sort(), ['Colors.swift', 'Spacing.swift']);
});

/** A tiny repo shaped like the real failure: episodes plus a registry listing them. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'prepass-creation-'));
  mkdirSync(join(root, 'src', 'episodes'), { recursive: true });
  writeFileSync(join(root, 'src', 'episodes', 'Episode001.tsx'), 'export const Episode001 = () => null;\n');
  writeFileSync(join(root, 'src', 'episodes', 'Episode002.tsx'), 'export const Episode002 = () => null;\n');
  // the registry: mentions the siblings by name, which is how it gets found
  writeFileSync(
    join(root, 'src', 'Root.tsx'),
    "import { Episode001 } from './episodes/Episode001';\n" +
      "import { Episode002 } from './episodes/Episode002';\nexport const Root = () => null;\n",
  );
  writeFileSync(join(root, 'src', 'unrelated.ts'), 'export const nothing = 1;\n');
  return root;
}

test('surfaces the registry that has to be edited, and marks why', () => {
  const root = fixture();
  try {
    const ranked = [cand('src/episodes/Episode001.tsx', 9), cand('src/episodes/Episode002.tsx', 8)];
    const out = applyCreationMode(ranked, root, 20);
    const paths = out.map((c) => c.path);

    assert.ok(paths.includes('src/Root.tsx'), `registry missing from ${JSON.stringify(paths)}`);
    const registry = out.find((c) => c.path === 'src/Root.tsx');
    assert.equal(registry?.reason, 'registry');
    // It matched no search term, so it must not claim a score it did not earn.
    assert.equal(registry?.score, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('never displaces the strongest ordinary matches', () => {
  const root = fixture();
  try {
    const ranked = [
      cand('src/episodes/Episode001.tsx', 9),
      cand('src/episodes/Episode002.tsx', 8),
      cand('src/unrelated.ts', 7),
    ];
    const out = applyCreationMode(ranked, root, 20);
    // Prepending registries cost 2.6 points of top-5 accuracy in the sweep; the
    // first three positions are reserved for what ranking already believed.
    assert.deepEqual(out.slice(0, 3).map((c) => c.path), ranked.map((c) => c.path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('respects the shortlist limit and never repeats a path', () => {
  const root = fixture();
  try {
    const ranked = [cand('src/episodes/Episode001.tsx', 9), cand('src/episodes/Episode002.tsx', 8)];
    const out = applyCreationMode(ranked, root, 3);
    assert.equal(out.length, 3);
    assert.equal(new Set(out.map((c) => c.path)).size, out.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty or unfindable neighbourhood returns the ranking untouched', () => {
  assert.deepEqual(applyCreationMode([], '/nonexistent', 20), []);
  const ranked = [cand('a.ts', 5)];
  assert.deepEqual(applyCreationMode(ranked, '/nonexistent-repo-xyz', 20), ranked);
});
