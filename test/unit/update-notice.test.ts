import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * `update-notice` reads and writes `~/.prepass/state.json`, so every test here
 * points HOME at a throwaway directory. Without that the suite would read the
 * developer's real clock and — worse — reset it.
 */
async function withHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'prepass-notice-'));
  const prev = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Imported fresh per test: the module resolves homedir() at call time, not load time. */
const mod = async () => import('../../src/core/update-notice.js');

test('first run says nothing and starts the clock', async () => {
  await withHome(async (home) => {
    const { updateNotice, readState } = await mod();
    assert.equal(updateNotice('0.1.2', 21), null, 'must not nag on the very first run');
    const state = readState();
    assert.equal(state?.version, '0.1.2');
    assert.ok(existsSync(join(home, '.prepass', 'state.json')));
  });
});

test('stays quiet before the interval elapses', async () => {
  await withHome(async () => {
    const { updateNotice, resetClock } = await mod();
    resetClock('0.1.2', new Date('2026-08-01T00:00:00Z'));
    const twentyDaysLater = new Date('2026-08-21T00:00:00Z');
    assert.equal(updateNotice('0.1.2', 21, twentyDaysLater), null);
  });
});

test('speaks once the interval has elapsed', async () => {
  await withHome(async () => {
    const { updateNotice, resetClock } = await mod();
    resetClock('0.1.2', new Date('2026-08-01T00:00:00Z'));
    const notice = updateNotice('0.1.2', 21, new Date('2026-08-25T00:00:00Z'));
    assert.ok(notice, 'expected a notice after 24 days with a 21-day interval');
    assert.match(notice, /24 days/);
    assert.match(notice, /prepass snooze/);
  });
});

test('tells the agent to ask, never to install', async () => {
  await withHome(async () => {
    const { updateNotice, resetClock } = await mod();
    resetClock('0.1.2', new Date('2026-08-01T00:00:00Z'));
    const notice = updateNotice('0.1.2', 21, new Date('2026-09-01T00:00:00Z'))!;
    // An eager agent reading "an update is available" will just install it.
    assert.match(notice, /ask the user/i);
    assert.match(notice, /Do NOT install anything without the user saying yes/);
    assert.doesNotMatch(notice, /run `npm install -g` now/i);
    // The no-network promise must be restated where the agent can see it.
    assert.match(notice, /never makes network calls/i);
  });
});

test('a version change resets the clock and suppresses the notice', async () => {
  await withHome(async () => {
    const { updateNotice, resetClock, readState } = await mod();
    resetClock('0.1.2', new Date('2026-08-01T00:00:00Z'));
    // They updated. Nagging someone the moment they update is the fastest way
    // to get the feature switched off.
    const notice = updateNotice('0.2.0', 21, new Date('2026-09-30T00:00:00Z'));
    assert.equal(notice, null);
    assert.equal(readState()?.version, '0.2.0');
  });
});

test('corrupt or partial state is treated as no state, never thrown', async () => {
  await withHome(async (home) => {
    const { readState, updateNotice } = await mod();
    mkdirSync(join(home, '.prepass'), { recursive: true });
    const p = join(home, '.prepass', 'state.json');

    writeFileSync(p, 'not json at all');
    assert.equal(readState(), null);

    writeFileSync(p, JSON.stringify({ version: '0.1.2' })); // no `since`
    assert.equal(readState(), null);

    writeFileSync(p, JSON.stringify({ version: '0.1.2', since: 'never' }));
    assert.equal(readState(), null);

    // and the hook path still works rather than exploding
    assert.equal(updateNotice('0.1.2', 21), null);
  });
});

test('snooze suppresses the notice for another full interval', async () => {
  await withHome(async () => {
    const { updateNotice, resetClock } = await mod();
    resetClock('0.1.2', new Date('2026-08-01T00:00:00Z'));
    assert.ok(updateNotice('0.1.2', 21, new Date('2026-08-25T00:00:00Z')));

    resetClock('0.1.2', new Date('2026-08-25T00:00:00Z')); // what `prepass snooze` does
    assert.equal(updateNotice('0.1.2', 21, new Date('2026-09-10T00:00:00Z')), null);
    assert.ok(updateNotice('0.1.2', 21, new Date('2026-09-20T00:00:00Z')));
  });
});
