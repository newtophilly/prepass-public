/**
 * File discovery tests.
 *
 * Each case builds a throwaway tree under the OS temp dir so nothing depends on
 * the checkout it happens to run in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepo, mergeCandidates } from '../../src/core/file-scanner.js';
import { configSchema } from '../../src/schemas/config.js';

const config = configSchema.parse({});

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'prepass-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test('discovers files in a plain directory', () => {
  const root = makeTree({
    'src/index.ts': 'export const a = 1;',
    'src/util/helper.ts': 'export const b = 2;',
    'README.md': '# hi',
  });
  try {
    const { candidates } = scanRepo(root, config);
    const paths = candidates.map((c) => c.path).sort();
    assert.deepEqual(
      paths,
      ['README.md', 'src/index.ts', 'src/util/helper.ts'],
      'discovery must recurse and return repo-relative, sorted paths',
    );
    // Real sizes, so the curator's size penalty has something to work with.
    assert.ok(candidates.every((c) => c.bytes > 0), 'bytes feed BM25 length normalisation — zero would skew scoring');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips binaries, empty files, and oversized files', () => {
  const root = makeTree({
    'keep.ts': 'export const a = 1;',
    'logo.png': 'not really a png but the extension is what matters',
    'bundle.min.js': 'var a=1',
    'empty.ts': '',
    'huge.ts': 'x'.repeat(2000),
  });
  try {
    const { candidates } = scanRepo(root, configSchema.parse({ discovery: { maxFileBytes: 1000 } }));
    const paths = candidates.map((c) => c.path).sort();
    assert.deepEqual(paths, ['keep.ts'], 'only the ordinary source file survives');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not descend into node_modules or other heavy directories', () => {
  const root = makeTree({
    'app.ts': 'export const a = 1;',
    'node_modules/pkg/index.js': 'module.exports = {}',
    'dist/app.js': 'compiled',
    '.next/cache/blob': 'junk',
  });
  try {
    const { candidates } = scanRepo(root, config);
    assert.deepEqual(candidates.map((c) => c.path), ['app.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('honors .gitignore inside a git repository', () => {
  const root = makeTree({
    'tracked.ts': 'export const a = 1;',
    'secret.env.txt': 'SHOULD_NOT_APPEAR=1',
    '.gitignore': 'secret.env.txt\n',
  });
  try {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });

    const { candidates, source } = scanRepo(root, config);
    const paths = candidates.map((c) => c.path);

    assert.equal(source, 'git', 'should delegate ignore rules to git');
    assert.ok(paths.includes('tracked.ts'), 'a tracked file must survive the git listing');
    assert.ok(!paths.includes('secret.env.txt'), 'gitignored file must not be a candidate');
  } catch (err) {
    // Skip rather than fail if git is unavailable in the environment.
    if (String(err).includes('ENOENT')) return;
    throw err;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('caps the pool at maxFiles and reports truncation', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`f${i}.ts`] = `export const n = ${i};`;
  const root = makeTree(files);
  try {
    const { candidates, truncated } = scanRepo(root, configSchema.parse({ discovery: { maxFiles: 10 } }));
    assert.equal(candidates.length, 10, 'the pool must stop at maxFiles exactly');
    assert.equal(truncated, true, 'truncation must be reported, not silent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanning a nonexistent directory degrades to empty rather than throwing', () => {
  const { candidates } = scanRepo('/nonexistent/definitely/not/here', config);
  assert.deepEqual(candidates, []);
});

test('explicit candidates win over discovered ones and keep their prior', () => {
  const merged = mergeCandidates(
    [{ path: 'src/a.ts', bytes: 0, score: 0.5 }],
    [
      { path: 'src/a.ts', bytes: 900, score: 0 },
      { path: 'src/b.ts', bytes: 100, score: 0 },
    ],
  );
  const a = merged.find((c) => c.path === 'src/a.ts');

  assert.equal(merged.length, 2, 'no duplicate entry for the same path');
  assert.equal(a?.score, 0.5, 'explicit prior survives');
  assert.equal(a?.bytes, 900, 'but adopts the real size discovery found');
});
