/**
 * The glossary and its miner. The rules that matter here are about trust: a
 * human's entry outranks an inferred one, and an inferred term never outranks
 * a word the user actually typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandTerms,
  loadGlossary,
  appendProposals,
  EXPANSION_WEIGHT,
  GLOSSARY_FILENAME,
} from '../../src/glossary.js';
import { mineGlossary } from '../../src/core/glossary-miner.js';

test('expansion adds reach without ever displacing a typed word', () => {
  const g = { arriving: { expands: ['didEnterRegion'], source: 'manual' as const, disabled: false } };
  const out = expandTerms(['arriving', 'twice'], g);
  const byTerm = new Map(out.map((t) => [t.term, t]));

  assert.equal(byTerm.get('arriving')?.weight, 1, 'a typed word keeps full weight');
  assert.equal(byTerm.get('twice')?.weight, 1, 'an unmapped word is untouched');
  assert.equal(byTerm.get('didenterregion')?.weight, EXPANSION_WEIGHT);
  assert.ok(
    (byTerm.get('didenterregion')?.weight ?? 1) < (byTerm.get('arriving')?.weight ?? 0),
    'inferred must never outrank typed',
  );
});

test('a disabled entry is a veto, not a suggestion', () => {
  const g = { double: { expands: ['dedup'], source: 'manual' as const, disabled: true } };
  const out = expandTerms(['double'], g);
  assert.deepEqual(
    out.map((t) => t.term),
    ['double'],
    'a vetoed term expands to nothing',
  );
});

test('a word that is both typed and inferred counts as typed', () => {
  const g = { queue: { expands: ['dedup'], source: 'manual' as const, disabled: false } };
  const out = expandTerms(['queue', 'dedup'], g);
  assert.equal(out.find((t) => t.term === 'dedup')?.weight, 1);
});

test('mining never overwrites a human entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepass-gloss-'));
  try {
    mkdirSync(join(root, '.prepass'), { recursive: true });
    writeFileSync(
      join(root, GLOSSARY_FILENAME),
      JSON.stringify({
        arriving: { expands: ['didEnterRegion'], source: 'manual' },
        double: { expands: [], source: 'manual', disabled: true },
      }),
    );
    const existing = loadGlossary(root);

    const added = appendProposals(root, existing, [
      { term: 'arriving', expands: ['SomethingElse'], evidence: 'a.ts:1', seen: 9 },
      { term: 'double', expands: ['AlsoWrong'], evidence: 'b.ts:2', seen: 9 },
      { term: 'retries', expands: ['BackoffPolicy'], evidence: 'c.ts:3', seen: 4 },
    ]);

    const after = JSON.parse(readFileSync(join(root, GLOSSARY_FILENAME), 'utf8'));
    assert.equal(added, 1, 'only the genuinely new term is added');
    assert.deepEqual(after.arriving.expands, ['didEnterRegion'], 'manual entry untouched');
    assert.equal(after.double.disabled, true, 'a veto survives mining');
    assert.equal(after.retries.source, 'mined');
    assert.equal(after.retries.evidence, 'c.ts:3', 'inferred entries cite their evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the miner pairs a doc comment with what it documents', () => {
  const root = mkdtempSync(join(tmpdir(), 'prepass-mine-'));
  try {
    // The human words and the symbol are on different lines — pairing within a
    // single line finds nothing here, which is the whole point.
    //
    // The filler matters: association is scored by how much a pairing beats
    // chance, so a word appearing in *every* comment is uninformative by
    // definition and scores zero. A corpus needs something to contrast against.
    const filler = Array.from({ length: 10 }, (_, i) =>
      [`/// Handles billing rollover for tier ${i}.`, `func billingRollover${i}() {}`, ''].join('\n'),
    ).join('\n');
    writeFileSync(
      join(root, 'a.swift'),
      [
        filler,
        '/// A saved location for geofence notifications when you arrive.',
        'struct SavedPlace {}',
        '',
      ].join('\n'),
    );
    const proposals = mineGlossary(root, {}, { minSeen: 1, limit: 50 });
    const arrive = proposals.find((p) => p.term === 'arrive');
    assert.ok(arrive, 'a doc comment above a declaration must produce a bridge');
    assert.ok(
      arrive.expands.includes('SavedPlace'),
      `expected SavedPlace, got ${arrive?.expands.join(', ')}`,
    );
    assert.match(arrive.evidence, /a\.swift:\d+/, 'must cite a checkable line');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a prompt naming an Object.prototype member does not crash', () => {
  // Plain property lookup on a glossary object resolves `constructor`,
  // `toString`, `valueOf` and `hasOwnProperty` against Object.prototype,
  // returning something truthy with no `expands`. Real bug reports use these
  // words constantly; a hand-written test set never does.
  for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const out = expandTerms([word, 'geofence'], {});
    // Terms are lowercased on the way through, so compare in that form.
    assert.deepEqual(
      out.map((t) => t.term).sort(),
      [word.toLowerCase(), 'geofence'].sort(),
      `"${word}" must pass through rather than resolving against Object.prototype`,
    );
  }
});

test('a glossary entry with a malformed expands list is ignored, not fatal', () => {
  const broken = { arriving: { expands: 'didEnterRegion', source: 'manual' } } as never;
  const out = expandTerms(['arriving'], broken);
  assert.deepEqual(out.map((t) => t.term), ['arriving']);
});

/* ── install ─────────────────────────────────────────────────────────────── */

test('init merges into settings instead of overwriting them', async () => {
  const { registerIn, TARGETS } = await import('../../src/core/install.js');
  const root = mkdtempSync(join(tmpdir(), 'prepass-init-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    // A real settings file holds things that would hurt to lose.
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        permissions: { allow: ['WebSearch'] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'someone-else' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'notifier' }] }],
        },
      }),
    );
    const target = TARGETS.find((t) => t.agent === 'claude');
    assert.ok(target, 'the claude target must exist in TARGETS, or init registers nothing');

    assert.equal(registerIn(root, target).outcome, 'added', 'first registration should report added');
    const after = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));

    assert.deepEqual(after.permissions.allow, ['WebSearch'], 'permissions survive');
    assert.equal(after.hooks.Stop[0].hooks[0].command, 'notifier', 'other events survive');
    assert.equal(after.hooks.UserPromptSubmit.length, 2, "someone else's hook survives");
    assert.equal(
      after.hooks.UserPromptSubmit[0].hooks[0].command,
      'someone-else',
      'an existing UserPromptSubmit hook must keep its position, not be replaced',
    );
    assert.match(
      after.hooks.UserPromptSubmit[1].hooks[0].command,
      /prepass hook/,
      'ours should be appended after the existing hook, not prepended',
    );

    assert.equal(registerIn(root, target).outcome, 'already-present', 'running twice is a no-op');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init refuses to clobber a settings file it cannot parse', async () => {
  const { registerIn, TARGETS } = await import('../../src/core/install.js');
  const root = mkdtempSync(join(tmpdir(), 'prepass-init-bad-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    const broken = '{ "permissions": { broken,, }';
    writeFileSync(join(root, '.claude/settings.json'), broken);
    const target = TARGETS.find((t) => t.agent === 'claude');
    assert.ok(target);

    assert.equal(registerIn(root, target).outcome, 'unparsable');
    assert.equal(
      readFileSync(join(root, '.claude/settings.json'), 'utf8'),
      broken,
      "a config we can't read is still theirs — leave it alone",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
