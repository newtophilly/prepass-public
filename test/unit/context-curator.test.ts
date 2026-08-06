/**
 * Unit stubs for the context curator (heuristic stage + payload assembly).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainRanking } from '../../src/core/explain-ranking.js';
import {
  runHeuristicStage,
  buildXmlPayload,
  matchesGlobs,
  confidenceOf,
} from '../../src/core/context-curator.js';
import { estimateTokens } from '../../src/tokens.js';
import { configSchema } from '../../src/schemas/config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextCandidate, Taxonomy } from '../../src/types.js';

const taxonomy: Taxonomy = {
  workload: 'feature',
  displayName: 'Feature',
  keywords: [],
  weightedKeywords: {},
  antiKeywords: [],
  curationStrategy: {
    maxFiles: 2,
    includeGlobs: ['src/**'],
    excludeGlobs: ['**/*.min.*'],
    prioritySignals: [],
  },
  routing: { defaultTier: 'balanced', escalateTier: 'premium', escalateWhen: [] },
};

const candidates: ContextCandidate[] = [
  { path: 'src/limiter.ts', bytes: 100, score: 0 },
  { path: 'src/util/big.min.js', bytes: 100, score: 0 },
  { path: 'src/a.ts', bytes: 100, score: 0 },
  { path: 'docs/readme.md', bytes: 100, score: 0 },
];

test('heuristic stage honors excludeGlobs and maxFiles', () => {
  const kept = runHeuristicStage({ prompt: 'add a limiter', candidates, taxonomy });
  assert.ok(kept.length <= taxonomy.curationStrategy.maxFiles);
  assert.ok(!kept.some((c) => c.path.endsWith('.min.js')));
});

test('includeGlobs prefer source dirs when nothing else separates candidates', () => {
  const tied: ContextCandidate[] = [
    { path: 'docs/notes.md', bytes: 100, score: 0 },
    { path: 'src/thing.ts', bytes: 100, score: 0 },
  ];
  const kept = runHeuristicStage({ prompt: 'unrelated words entirely', candidates: tied, taxonomy });
  assert.equal(kept[0]?.path, 'src/thing.ts');
});

test('a layout outside includeGlobs still yields candidates', () => {
  // Regression: `src/**`-style includes used to be a hard gate, so an iOS,
  // Go or Python layout selected nothing at all while reporting success.
  const swift: ContextCandidate[] = [
    { path: 'AppName/Core/NotificationManager.swift', bytes: 900, score: 0 },
    { path: 'AppName/Models/Trip.swift', bytes: 400, score: 0 },
  ];
  const kept = runHeuristicStage({
    prompt: 'the notification manager fires twice',
    candidates: swift,
    taxonomy,
  });
  assert.ok(kept.length > 0, 'non-Node layout must not curate to nothing');
  assert.equal(kept[0]?.path, 'AppName/Core/NotificationManager.swift');
});

test('a real name match outranks the source-dir hint', () => {
  const mixed: ContextCandidate[] = [
    { path: 'src/unrelated.ts', bytes: 100, score: 0 },
    { path: 'AppName/Core/limiter.swift', bytes: 100, score: 0 },
  ];
  const kept = runHeuristicStage({ prompt: 'fix the limiter', candidates: mixed, taxonomy });
  assert.equal(kept[0]?.path, 'AppName/Core/limiter.swift');
});

test('prompt-overlapping paths score higher', () => {
  const kept = runHeuristicStage({ prompt: 'add a limiter', candidates, taxonomy });
  assert.equal(kept[0]?.path, 'src/limiter.ts');
});

test('a rare term outweighs a common one', () => {
  // The failure this replaces: every matched term scored a flat +0.75, so on a
  // real repo `departing` (1 file of 441) counted exactly as much as `double`
  // (104 files, because it is Swift's numeric type). The near-unique pointer
  // was drowned out by a language keyword.
  const root = mkdtempSync(join(tmpdir(), 'prepass-idf-'));
  try {
    // `common` is everywhere; `departing` is in exactly one file.
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(root, `noise${i}.ts`), 'const common = 1;\n'.repeat(40));
    }
    writeFileSync(join(root, 'rare.ts'), 'const common = 1;\nexport const departing = true;\n');

    const candidates: ContextCandidate[] = [
      ...Array.from({ length: 8 }, (_, i) => ({ path: `noise${i}.ts`, bytes: 680, score: 0 })),
      { path: 'rare.ts', bytes: 60, score: 0 },
    ];
    const selected = runHeuristicStage(
      {
        prompt: 'the common departing case',
        rootDir: root,
        taxonomy: {
          ...taxonomy,
          curationStrategy: { ...taxonomy.curationStrategy, maxFiles: 9, includeGlobs: [] },
        },
        candidates,
      },
      configSchema.parse({}),
    );
    assert.equal(selected[0]?.path, 'rare.ts', 'the discriminating term must win');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('glob matcher supports ** and *', () => {
  assert.equal(matchesGlobs('src/a/b.ts', ['src/**'], []), true);
  assert.equal(matchesGlobs('lib/a.ts', ['src/**'], []), false);
  assert.equal(matchesGlobs('src/a.min.js', ['src/**'], ['**/*.min.*']), false);
});

test('a leading **/ matches zero directories too', () => {
  // Regression: `**/` compiled to `.*/`, which requires at least one directory,
  // so root-level files escaped every exclude rule.
  assert.equal(matchesGlobs('code_audit.md', [], ['**/*.md']), false);
  assert.equal(matchesGlobs('deep/nested/notes.md', [], ['**/*.md']), false);
  assert.equal(matchesGlobs('bundle.min.js', [], ['**/*.min.*']), false);
  assert.equal(matchesGlobs('node_modules/left-pad/index.js', [], ['**/node_modules/**']), false);
  assert.equal(matchesGlobs('src/app.ts', [], ['**/*.md']), true);
});

test('glob matching ignores case, as the filesystem does', () => {
  assert.equal(matchesGlobs('AppName/MASTER.MD', [], ['**/*.md']), false);
  assert.equal(matchesGlobs('README.MD', [], ['**/*.md']), false);
});

test('payload is well-formed and escapes markup', () => {
  const xml = buildXmlPayload([{ path: 'src/<x>.ts', bytes: 1, score: 0.5 }]);
  assert.match(xml, /^<candidate-files count="1" confidence="/);
  assert.match(xml, /&lt;x&gt;/);
  assert.ok(estimateTokens(xml) > 0);
});

test('payload presents itself as guesses, not as answers', () => {
  // The wording is load-bearing. Asserting these files ARE the context invites
  // a plausible-but-wrong file to be edited on a prompt that can write.
  const xml = buildXmlPayload([{ path: 'src/a.ts', bytes: 10, score: 2 }]);
  assert.match(xml, /guesses/i, 'must not assert these are the right files');
  assert.match(xml, /verify|confirm/i, 'must tell the reader to check');
  assert.doesNotMatch(xml, /curated-context/, 'the asserting name is gone');
});

test('an empty selection tells the reader to search normally', () => {
  const xml = buildXmlPayload([]);
  assert.match(xml, /count="0"/);
  assert.match(xml, /search as you normally would/i);
});

test('confidence reflects how separated the scores are', () => {
  const flat = [
    { path: 'a.ts', bytes: 1, score: 3.0 },
    { path: 'b.ts', bytes: 1, score: 2.95 },
    { path: 'c.ts', bytes: 1, score: 2.9 },
  ];
  const separated = [
    { path: 'a.ts', bytes: 1, score: 9.0 },
    { path: 'b.ts', bytes: 1, score: 3.0 },
    { path: 'c.ts', bytes: 1, score: 2.0 },
  ];
  assert.equal(confidenceOf(flat), 'low', 'bunched scores mean the ranker guessed');
  assert.equal(confidenceOf(separated), 'high');
  assert.equal(confidenceOf([]), 'low');
  assert.match(buildXmlPayload(flat), /order means little/i);
});


/**
 * Regression: before content scanning, path names were the only signal. With
 * every candidate scoring ~0, the size penalty became the sole tiebreaker and
 * ranking collapsed to "smallest file first" — which excluded the one file
 * defining the symbol the prompt named, while keeping a stylesheet.
 */
test('a file containing the prompt symbol outranks smaller irrelevant files', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepass-curate-'));
  try {
    // The relevant file is deliberately the largest of the three.
    writeFileSync(join(root, 'status.ts'), 'export function evaluateUnit() {}\n' + 'x'.repeat(9000));
    writeFileSync(join(root, 'tiny.css'), 'body{color:red}');
    writeFileSync(join(root, 'small.ts'), 'export const a = 1;');

    const selected = runHeuristicStage(
      {
        prompt: 'fix the bug where evaluateUnit resets the clock',
        rootDir: root,
        taxonomy: {
          ...taxonomy,
          // Files sit at the temp-dir root, so don't restrict to `src/**`.
          curationStrategy: { ...taxonomy.curationStrategy, maxFiles: 3, includeGlobs: [] },
        },
        candidates: [
          { path: 'tiny.css', bytes: 15, score: 0 },
          { path: 'small.ts', bytes: 19, score: 0 },
          { path: 'status.ts', bytes: 9034, score: 0 },
        ],
      },
      configSchema.parse({}),
    );

    assert.equal(selected[0]?.path, 'status.ts', 'the file defining the symbol must rank first');
    assert.ok(
      (selected[0]?.score ?? 0) > (selected[1]?.score ?? 0),
      'content match must beat the size penalty, not merely tie it',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content scoring sees past the head-scan window', () => {
  // Regression: scoring read only the first `contentScanBytes` of a file, so a
  // symbol defined deep in a large one scored zero. Measured on a real 233 KB
  // file whose first relevant mention sat ~60 lines past the window.
  const root = mkdtempSync(join(tmpdir(), 'prepass-deep-'));
  try {
    const cfg = configSchema.parse({});
    const padding = '// filler\n'.repeat(cfg.curation.contentScanBytes / 5);
    writeFileSync(join(root, 'deep.ts'), padding + 'export function evaluateUnit() {}\n');
    writeFileSync(join(root, 'shallow.ts'), 'export const unrelated = 1;');

    const selected = runHeuristicStage(
      {
        prompt: 'fix the bug where evaluateUnit resets the clock',
        rootDir: root,
        taxonomy: {
          ...taxonomy,
          curationStrategy: { ...taxonomy.curationStrategy, maxFiles: 2, includeGlobs: [] },
        },
        candidates: [
          { path: 'shallow.ts', bytes: 27, score: 0 },
          { path: 'deep.ts', bytes: padding.length + 34, score: 0 },
        ],
      },
      cfg,
    );

    assert.equal(
      selected[0]?.path,
      'deep.ts',
      'a symbol past the head-scan window must still be found',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the payload answers the git question before the agent asks it', () => {
  // Both Claude Code and Codex run `git status` first. In a directory that was
  // never a repository that call fails and costs a round trip that teaches
  // nothing — observed three times across two real sessions on one project.
  const files = [{ path: 'a.ts', bytes: 10, score: 2 }];
  const withGit = buildXmlPayload(files, { isGitRepo: true, recentlyChanged: ['src/x.ts'] });
  assert.match(withGit, /<repo git="yes"/);
  assert.match(withGit, /recently-changed="src\/x\.ts"/);

  const withoutGit = buildXmlPayload(files, { isGitRepo: false, recentlyChanged: [] });
  assert.match(withoutGit, /<repo git="no" \/>/, 'no recent list when there is nothing to list');

  assert.doesNotMatch(buildXmlPayload(files), /<repo/, 'omitted entirely when unknown');
});

/**
 * The scorer and its explainer are deliberately duplicated — `explain-ranking`
 * re-implements `scoreBm25f` so the hot path never carries provenance. That
 * duplication silently drifted: the explainer kept an `else if` the scorer had
 * dropped, and never applied the prose discount at all, so on sympy it ranked a
 * `.rst` doc first at 59.67 while the payload had it second at 29.83 — exactly
 * half. Fifty-odd passing tests said nothing, because none compared the two.
 */
test('explain --why reports the ranking the tool actually produces', () => {
  // Chosen so the prose discount actually changes the order: on raw BM25F the
  // .md wins 6.27 to 3.50, and only the discount puts the source file first.
  // A fixture where the source wins either way would pass without testing
  // anything — the first version of this test did exactly that.
  const files: ContextCandidate[] = [
    { path: 'docs/payment/retry_handler.md', bytes: 4000, score: 0 },
    { path: 'src/payment/retry/Coordinator.ts', bytes: 4000, score: 0 },
  ];
  const prompt = 'payment retry handler';
  const config = configSchema.parse({});

  const wide = { ...taxonomy, curationStrategy: { ...taxonomy.curationStrategy, maxFiles: 10 } };
  const ranked = runHeuristicStage({ prompt, candidates: files, taxonomy: wide }, config)
    .map((c) => c.path);

  const explained = explainRanking(
    prompt, files, config, '', {}, files.length, wide,
  ).files.map((f) => f.path);

  assert.deepEqual(
    explained,
    ranked,
    'explain and the real ranking disagree — the duplicated scorer has drifted',
  );
});
