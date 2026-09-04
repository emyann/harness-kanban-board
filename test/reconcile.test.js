// The reconcile decision: which card a merged pull request finishes, and when the dispatcher pays
// for the extra listing that finds one.
//
// Nothing tells hkb that a PR merged — the board is local, there is no issue for `Closes #n` to
// close, and the merge happens on the forge (by `hkb merge`, by GitHub's auto-merge, or by a person
// pressing the button). So the tick looks: one listing of merged PRs, matched to cards by head
// branch, which is the same `taskBranchRe` the `active_pr` guard and the terminal verbs use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDecision, closeAttemptForReconcile, boardSignature, shouldReconcile } from '../src/dispatch.js';
import { emptyRun } from '../src/model.js';

const pr = (number, head) => [head, { number, headRefName: head, state: 'MERGED', merged: true }];
/** A merged-PR listing, keyed by head branch — what `mergedPrsByHead` (src/forge.js) hands back. */
const merged = (...entries) => new Map(entries);
const card = (status, number = 1) => ({ number, status, state: 'OPEN', stateReason: null });

test('a merged PR on this card\'s branch finishes it, from any live status', () => {
  const listing = merged(pr(90, 'kb-1-1'));
  for (const status of ['triage', 'todo', 'ready', 'running', 'blocked', 'review']) {
    const d = reconcileDecision(card(status), listing);
    assert.equal(d.status, 'done', status);
    assert.equal(d.outcome, 'completed');
    assert.equal(d.pr.number, 90);
    assert.match(d.reason, /PR #90 merged \(kb-1-1\)/);
  }
});

test('every branch name hkb makes for a card counts, and nobody else\'s does', () => {
  for (const head of ['kb-1-1', 'kb-1-7', 'worktree-kb-1-2', 'kb/1']) {
    assert.equal(reconcileDecision(card('review'), merged(pr(90, head)))?.status, 'done', head);
  }
  // #11's branch is not #1's, and a branch hkb never made belongs to nobody
  for (const head of ['kb-11-1', 'kb/11', 'feature/whatever', 'main']) {
    assert.equal(reconcileDecision(card('review'), merged(pr(90, head))), null, head);
  }
});

test('nothing to do for a card that is already settled, or with no merged PR at all', () => {
  assert.equal(reconcileDecision(card('done'), merged(pr(90, 'kb-1-1'))), null);
  assert.equal(reconcileDecision(card('archived'), merged(pr(90, 'kb-1-1'))), null);
  assert.equal(reconcileDecision(card(null), merged(pr(90, 'kb-1-1'))), null); // no status at all
  assert.equal(reconcileDecision(null, merged(pr(90, 'kb-1-1'))), null);
  assert.equal(reconcileDecision(card('review'), merged()), null);
  assert.equal(reconcileDecision(card('review'), null), null, 'a listing that could not be read decides nothing');
});

test('the pass is idempotent: the card it moved is not in a live status the next time', () => {
  const listing = merged(pr(90, 'kb-1-1'));
  const first = reconcileDecision(card('review'), listing);
  assert.equal(first.status, 'done');
  assert.equal(reconcileDecision({ ...card('review'), status: first.status }, listing), null);
});

test('reconcile closes the open attempt with the decision outcome', () => {
  const run = emptyRun();
  run.attempts.push({ attempt: 1, profile: 'claude', host: 'h', started_at: '2026-08-26T10:00:00Z', ended_at: '2026-08-26T10:05:00Z', outcome: 'crashed' });
  run.attempts.push({ attempt: 2, profile: 'claude', host: 'h', started_at: '2026-08-26T10:06:00Z' });
  const d = reconcileDecision(card('running'), merged(pr(90, 'kb-1-1')));
  const a = closeAttemptForReconcile(run, d, '2026-08-26T11:00:00Z');
  assert.equal(a.attempt, 2);
  assert.equal(a.outcome, 'completed');
  assert.equal(a.ended_at, '2026-08-26T11:00:00Z');
  assert.match(a.reason, /PR #90 merged/);
  assert.equal(run.attempts[0].outcome, 'crashed'); // earlier attempts untouched
});

test('reconcile leaves an already-finished run alone', () => {
  const d = reconcileDecision(card('review'), merged(pr(90, 'kb-1-1')));
  const run = emptyRun();
  run.attempts.push({ attempt: 1, profile: 'claude', host: 'h', started_at: '2026-08-26T10:00:00Z', ended_at: '2026-08-26T10:20:00Z', outcome: 'completed', summary: 'done' });
  const before = JSON.stringify(run);
  assert.equal(closeAttemptForReconcile(run, d, '2026-08-26T11:00:00Z'), null);
  assert.equal(JSON.stringify(run), before);
  assert.equal(closeAttemptForReconcile(emptyRun(), d, '2026-08-26T11:00:00Z'), null);
});

test('board signature moves with the task count and the newest updatedAt', () => {
  const a = [{ updatedAt: '2026-08-26T10:00:00Z' }, { updatedAt: '2026-08-26T09:00:00Z' }];
  assert.equal(boardSignature(a), boardSignature([...a].reverse()));
  assert.notEqual(boardSignature(a), boardSignature([...a, { updatedAt: '2026-08-26T09:30:00Z' }]));
  assert.notEqual(boardSignature(a), boardSignature([{ updatedAt: '2026-08-26T11:00:00Z' }, { updatedAt: '2026-08-26T09:00:00Z' }]));
  assert.equal(boardSignature([]), '0:');
  assert.equal(boardSignature(undefined), '0:');
});

test('the extra query is gated: paid for only when something could have closed', () => {
  const quiet = [{ status: 'todo', updatedAt: '2026-08-26T10:00:00Z' }];
  const clean = { checked_at: '2026-08-26T10:30:00Z', signature: boardSignature(quiet), found: 0 };

  assert.equal(shouldReconcile(quiet, clean).run, false);
  assert.equal(shouldReconcile(quiet, null).run, true);                                  // never looked
  assert.equal(shouldReconcile(quiet, { signature: clean.signature, found: 0 }).run, true); // no checked_at
  assert.equal(shouldReconcile(quiet, { ...clean, found: 2 }).run, true);                // last look found work
  assert.equal(shouldReconcile(quiet, { ...clean, signature: '9:x' }).run, true);        // board moved
  assert.equal(shouldReconcile([{ status: 'review', updatedAt: 'x' }], clean).run, true);
  assert.equal(shouldReconcile([{ status: 'running', updatedAt: 'x' }], clean).run, true);
  assert.equal(shouldReconcile([], clean).run, true);                                    // signature differs
  assert.ok(shouldReconcile(quiet, clean).why);                                          // always says why
});
