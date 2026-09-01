// "Your board has lost track of work" (#234): an open PR sitting on a branch hkb itself would have
// made for one of its own cards, where the card has already gone to done/archived and never revisits
// it — the exact shape #227 and #228 left behind. `fetchBoard`/`getTask` fix the live case (a card
// still open sees the PR through the same head-branch match, as a fallback), so this check is what
// covers a card that has already closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORPHANED_PR_CHECK, checkOrphanedPrs } from '../src/doctor.js';
import { FakeGh, kbIssue } from './fake-gh.js';

function sink() {
  const results = [];
  return {
    results,
    ok: (name, detail) => results.push({ name, ok: true, detail }),
    warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }),
  };
}

function harness() {
  const gh = new FakeGh();
  const ctx = { repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner }, board: 'default', caps: {}, _cache: {} };
  const restore = gh.install();
  return { gh, ctx, cleanup: restore };
}

test('a card closed as done with its PR still open, unreferenced, is flagged', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 227, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
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
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 60, status: 'running' }));
    gh.addPull({ number: 70, head: 'worktree-kb-60-1' });
    const s = sink();
    await checkOrphanedPrs(ctx, s);
    assert.equal(s.results[0].ok, true);
    assert.match(s.results[0].detail, /still open/);
  } finally { cleanup(); }
});

test('an open PR on a branch that names no hkb task at all is silent', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addPull({ number: 5, head: 'feature/something-unrelated' });
    const s = sink();
    await checkOrphanedPrs(ctx, s);
    assert.equal(s.results[0].ok, true);
    assert.match(s.results[0].detail, /no open PR/);
  } finally { cleanup(); }
});
