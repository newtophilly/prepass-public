/**
 * Integration stub: end-to-end pipeline against the built-in taxonomies.
 *
 * Runs heuristic-only (no network) so it's hermetic. Points config at this
 * repo's `taxonomies/` and a throwaway telemetry DB under the OS temp dir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runPipeline } from '../../src/pipeline.js';
import { configSchema } from '../../src/schemas/config.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up until we find the package root. Keeps the test correct whether it
 * runs from `test/` (source) or `dist-test/test/` (compiled).
 */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error('package.json not found above ' + from);
    dir = parent;
  }
}

const repoRoot = findRepoRoot(here);

const loaded = {
  config: configSchema.parse({
    taxonomies: { dir: join(repoRoot, 'taxonomies'), custom: [] },
    telemetry: { enabled: false, dbPath: join(tmpdir(), 'prepass-test.db') },
  }),
  rootDir: repoRoot,
  configPath: null,
};

test('routes a review prompt to the premium tier', async () => {
  const result = await runPipeline({
    prompt: 'please do a security review of the auth module',
    candidates: [{ path: 'src/auth.ts', bytes: 2000, score: 0.5 }],
    entrypoint: 'cli',
    discover: false, // hermetic: don't scan whatever repo the test runs in
    loaded,
  });
  assert.equal(result.intent.workload, 'review');
  assert.equal(result.routing.tier, 'premium');
  assert.equal(result.curation.stage, 'heuristic');
  assert.match(result.curation.payload, /candidate-files/);
});

test('classifies a search prompt and stays cheap', async () => {
  const result = await runPipeline({
    prompt: 'where is the rate limiter defined',
    candidates: [],
    entrypoint: 'cli',
    discover: false, // hermetic: don't scan whatever repo the test runs in
    loaded,
  });
  assert.equal(result.intent.workload, 'search');
  assert.equal(result.routing.tier, 'cheap');
});

