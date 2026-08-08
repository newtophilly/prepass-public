import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { mineOutcomes, usableTurns, type Turn } from '../../src/core/outcome-glossary.js';

const turn = (prompt: string, ...edited: string[]): Turn => ({ prompt, edited });

test('learns the bridge a user actually crossed', () => {
  // "arriving" never appears in the code; the file is SavedPlace.swift. Nothing
  // lexical connects them — only the outcome does. Contrast turns are required:
  // PMI measures how far a pairing beats chance, so a sample where every prompt
  // and every file are identical carries no information at all (see below).
  const misses = [
    turn('the notification when arriving home fires twice for the same place',
      'App/Models/SavedPlace.swift'),
    turn('arriving at a location should only notify once per visit window',
      'App/Models/SavedPlace.swift'),
    turn('the checkout button is misaligned on small screens',
      'App/Views/CheckoutView.swift'),
    turn('checkout total ignores the discount code entirely',
      'App/Views/CheckoutView.swift'),
    turn('subscription renewal emails go out a day early',
      'App/Billing/RenewalJob.swift'),
  ];
  const props = mineOutcomes(misses);
  const arriving = props.find((p) => p.term === 'arriving');
  assert.ok(arriving, `expected a bridge from "arriving", got ${props.map((p) => p.term).join(', ')}`);
  assert.ok(arriving.expands.some((e) => ['saved', 'place'].includes(e)),
    `expected saved/place, got ${arriving.expands.join(', ')}`);
  assert.equal(arriving.seen, 2);
  assert.ok(arriving.evidence.length > 0, 'a human must be able to check the evidence');

  // The second cluster is learned independently — no cross-contamination.
  // (`misaligned` and `discount` appear once each and correctly fail minSeen.)
  const checkout = props.find((p) => p.term === 'checkout');
  assert.ok(checkout, `expected a bridge from "checkout", got ${props.map((p) => p.term).join(', ')}`);
  assert.ok(checkout.expands.some((e) => ['checkoutview', 'view'].includes(e)));
  assert.ok(!checkout.expands.some((e) => ['saved', 'place'].includes(e)),
    'clusters must not bleed into each other');
});

test('a homogeneous history teaches nothing, and says so by staying silent', () => {
  // Every prompt shares every word, every turn edits the same file. PMI is 0:
  // the pairing is exactly as frequent as chance predicts, so there is no way to
  // tell a real bridge from a property of the sample. Silence is correct.
  const same = [
    turn('the notification when arriving home fires twice', 'App/Models/SavedPlace.swift'),
    turn('the notification when arriving home fires again', 'App/Models/SavedPlace.swift'),
    turn('the notification when arriving home still fires', 'App/Models/SavedPlace.swift'),
  ];
  assert.deepEqual(mineOutcomes(same), [],
    'a sample with no contrast must not produce confident bridges');
});

test('a pairing seen once is not proposed', () => {
  // One coincidence is not a dictionary entry.
  const props = mineOutcomes([turn('the widget refresh is stale', 'App/Timeline.swift')]);
  assert.deepEqual(props, []);
});

test('never bridges a word to itself', () => {
  // The ranker already matches identical tokens; an identity entry is pure noise.
  const misses = [
    turn('the timeline provider reloads too often', 'App/Timeline.swift'),
    turn('timeline entries are duplicated after a reload', 'App/Timeline.swift'),
    turn('reloading the timeline drops the last entry', 'App/Timeline.swift'),
  ];
  for (const p of mineOutcomes(misses)) {
    assert.ok(!p.expands.includes(p.term), `${p.term} bridged to itself`);
  }
});

test('common words are not used as keys', () => {
  // A key that fires on every prompt injects the same expansion into every query.
  const misses = [
    turn('please update the thing so it works, look at the file', 'App/Alpha.swift'),
    turn('please update the other thing so it works too, look again', 'App/Alpha.swift'),
    turn('please update that thing as well, it should work now', 'App/Alpha.swift'),
  ];
  const keys = mineOutcomes(misses).map((p) => p.term);
  for (const bad of ['please', 'update', 'thing', 'works', 'look', 'file']) {
    assert.ok(!keys.includes(bad), `stop word leaked in as a key: ${bad}`);
  }
});

test('PMI prefers a distinctive pairing over a frequent one', () => {
  // `shared` appears with everything; `geofence` appears only with the region file.
  const misses = [
    turn('geofence dedupe is broken in the shared runtime layer', 'App/RegionMonitor.swift', 'App/Shared.swift'),
    turn('geofence entries repeat inside the shared runtime layer', 'App/RegionMonitor.swift', 'App/Shared.swift'),
    turn('the shared runtime layer needs a cache for the settings screen', 'App/Shared.swift'),
    turn('shared runtime layer should expose the settings screen state', 'App/Shared.swift'),
  ];
  const props = mineOutcomes(misses);
  const geo = props.find((p) => p.term === 'geofence');
  assert.ok(geo, 'geofence should produce a bridge');
  assert.ok(geo.expands.includes('region') || geo.expands.includes('monitor'),
    `expected region/monitor, got ${geo.expands.join(', ')}`);
});

test('usableTurns rejects what cannot be a label', () => {
  const raw: Turn[] = [
    turn('ok', 'a.ts'),                                            // too short
    turn('I actually like take 2 better. not take 3', 'a.ts'),     // no referent of its own
    turn('the license validation locks out a paying customer when polar returns not_found',
      'api/license.ts'),                                           // usable
    turn('a properly descriptive prompt about the checkout flow and its handlers',
      'a.ts', 'b.ts', 'c.ts', 'd.ts'),                             // too many files to attribute
  ];
  const kept = usableTurns(raw);
  assert.equal(kept.length, 1);
  assert.match(kept[0]!.prompt, /license validation/);
});

test('an empty history yields nothing rather than throwing', () => {
  assert.deepEqual(mineOutcomes([]), []);
  assert.deepEqual(usableTurns([]), []);
});
