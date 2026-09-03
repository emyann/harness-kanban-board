// "Your board has lost track of work" (#234): an open PR sitting on a branch hkb itself would have
// made for one of its own cards, where the card has already gone to done/archived and never revisits
// it — the exact shape #227 and #228 left behind. `fillPrs` (src/forge.js) fixes the live case: a
// card still open sees the PR through the same head-branch match on every read. This check is what
// covers a card that has already settled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORPHANED_PR_CHECK, checkOrphanedPrs } from '../src/doctor.js';
import { installDoubles, kbIssue } from './fake-store.js';

function sink() {
  const results = [];
  return {
    results,
    ok: (name, detail) => results.push({ name, ok: true, detail }),
    warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }),
  };
}

function harness() {
  const ctx = { root: '/tmp/nonexistent', repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' }, board: 'default', caps: {}, _cache: {} };
  const { gh, store, restore } = installDoubles(ctx);
  return { gh, store, ctx, cleanup: restore };
}

test('a card closed as done with its PR still open, unreferenced, is flagged', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 227, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
    gh.addPull({ number: 232, head: 'kb/227', base: 'kb/191-wave1' });
    const s = sink();
    const orphans = await checkOrphanedPrs(ctx, s);
    assert.equal(s.results[0].name, ORPHANED_PR_CHECK);
    assert.equal(s.results[0].ok, null);
    assert.match(s.results[0].detail, /#227/);
    assert.match(s.results[0].detail, /PR #232/);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].n, 227);
  } finally { cleanup(); }
});

test('a card still open on the board is not an orphan — its own read already sees the PR', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 60, status: 'running' }));
    gh.addPull({ number: 70, head: 'worktree-kb-60-1' });
    const s = sink();
    await checkOrphanedPrs(ctx, s);
    assert.equal(s.results[0].ok, true);
    assert.match(s.results[0].detail, /still open/);
  } finally { cleanup(); }
});

test('an open PR on a branch that names no hkb task at all is silent', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    gh.addPull({ number: 5, head: 'feature/something-unrelated' });
    const s = sink();
    await checkOrphanedPrs(ctx, s);
    assert.equal(s.results[0].ok, true);
    assert.match(s.results[0].detail, /no open PR/);
  } finally { cleanup(); }
});

/**
 * **A verdict is never derived from a read that failed** (#304 review, item 6).
 *
 * Every `getTask` throw used to be swallowed by `catch { continue; }`, so in exactly the window this
 * card creates — a board mid-migration, where `getTask` throws — doctor printed "N open PRs, all on
 * cards still open": a clean bill of health computed from nothing at all. The same swallow hid an
 * offline or logged-out `gh`.
 */
test('a card the board could not answer for suppresses the ok, and is named', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 60, status: 'running' }));
    gh.addPull({ number: 70, head: 'worktree-kb-60-1' });
    gh.addPull({ number: 71, head: 'kb-61-1' }); // #61 is on no board this store can read
    const s = sink();

    await checkOrphanedPrs(ctx, s, { card: async (c, n) => { if (n === 61) throw new Error('no board here'); return store.raw().getTask(n); } });

    assert.equal(s.results[0].ok, null, 'not an ok — this check could not see the whole picture');
    assert.match(s.results[0].detail, /could not be read/);
    assert.match(s.results[0].detail, /#61 — no board here/);
    assert.match(s.results[0].fix, /fix the board read first/);
  } finally { cleanup(); }
});

test('an unreadable card is named alongside the orphans, not instead of them', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 227, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
    gh.addPull({ number: 232, head: 'kb/227' });
    gh.addPull({ number: 233, head: 'kb-61-1' });
    const s = sink();

    const orphans = await checkOrphanedPrs(ctx, s, { card: async (c, n) => { if (n === 61) throw new Error('no board here'); return store.raw().getTask(n); } });

    assert.equal(orphans.length, 1);
    assert.match(s.results[0].detail, /#227 \(done\) ← PR #232/);
    assert.match(s.results[0].detail, /1 card could not be read/);
  } finally { cleanup(); }
});
