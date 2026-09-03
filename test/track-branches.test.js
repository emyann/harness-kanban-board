// A track branch (`kb/track-<root>`) with no live runner behind it — the same class of bug as an
// orphaned PR: a root closed or archived, or whose last track attempt already ended, leaves
// `kb/track-<root>` sitting on GitHub with nothing on the board pointing back at it. `hkb doctor`
// flags it (`checkTrackBranches`); `hkb gc` deletes it once the root is settled (`sweepTrackBranches`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACK_BRANCH_CHECK, checkTrackBranches } from '../src/doctor.js';
import { sweepTrackBranches } from '../src/gc.js';
import { installDoubles, kbIssue, runWith } from './fake-store.js';

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

test('no track branches on the repo: a clean ok, no reads wasted', async () => {
  const { ctx, cleanup } = harness();
  try {
    const s = sink();
    await checkTrackBranches(ctx, s);
    assert.equal(s.results[0].name, TRACK_BRANCH_CHECK);
    assert.equal(s.results[0].ok, true);
  } finally { cleanup(); }
});

test('a track branch whose root is still running, attempt open: ok — a live runner', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    const live = runWith([{ attempt: 1, host: 'h', started_at: new Date().toISOString(), track: true, track_branch: 'kb/track-26' }]);
    store.addIssue(kbIssue({ number: 26, status: 'running', agent: 'claude-track', run: live }));
    gh.refs.set('refs/heads/kb/track-26', 'f'.repeat(40));
    const s = sink();
    await checkTrackBranches(ctx, s);
    assert.equal(s.results[0].ok, true);
    assert.match(s.results[0].detail, /every one with a live attempt/);
  } finally { cleanup(); }
});

test('a track branch whose root already finished (done) its track attempt: flagged, no live runner', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    const ended = runWith([{ attempt: 1, host: 'h', started_at: new Date().toISOString(), ended_at: new Date().toISOString(), outcome: 'completed', track: true, track_branch: 'kb/track-26' }]);
    store.addIssue(kbIssue({ number: 26, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', run: ended }));
    gh.refs.set('refs/heads/kb/track-26', 'f'.repeat(40));
    const s = sink();
    const orphans = await checkTrackBranches(ctx, s);
    assert.equal(s.results[0].ok, null);
    assert.match(s.results[0].detail, /kb\/track-26/);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].root, 26);
  } finally { cleanup(); }
});

test('a track branch whose root is not on the board at all: flagged, not silently skipped', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    gh.refs.set('refs/heads/kb/track-99', 'f'.repeat(40)); // no issue #99
    const s = sink();
    const orphans = await checkTrackBranches(ctx, s);
    assert.equal(s.results[0].ok, null);
    assert.equal(orphans[0].root, 99);
  } finally { cleanup(); }
});

// ---------- gc: deleting a settled root's track branch ----------

test('sweepTrackBranches deletes a settled root\'s branch only with --yes, and leaves an open root alone', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    gh.refs.set('refs/heads/kb/track-26', 'f'.repeat(40)); // #26 done
    gh.refs.set('refs/heads/kb/track-27', 'e'.repeat(40)); // #27 still running
    const finished = (root) => root === 26;

    const dry = await sweepTrackBranches(ctx, { finished, yes: false, log: () => {} });
    assert.deepEqual(dry, { removed: 0, pending: 1, skipped: 0 });
    assert.ok(gh.refs.has('refs/heads/kb/track-26'), 'a dry run deletes nothing');

    const applied = await sweepTrackBranches(ctx, { finished, yes: true, log: () => {} });
    assert.deepEqual(applied, { removed: 1, pending: 0, skipped: 0 });
    assert.ok(!gh.refs.has('refs/heads/kb/track-26'), 'the settled root\'s branch is gone');
    assert.ok(gh.refs.has('refs/heads/kb/track-27'), 'the still-open root\'s branch is untouched');
  } finally { cleanup(); }
});
