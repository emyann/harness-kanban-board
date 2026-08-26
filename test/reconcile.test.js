// The reconcile decision: what a closed issue that still wears a live status label becomes,
// and when the dispatcher pays for the extra closed-issues query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDecision, closeAttemptForReconcile, boardSignature, shouldReconcile } from '../src/dispatch.js';
import { emptyRun } from '../src/model.js';

const closed = (status, stateReason = 'COMPLETED') => ({ number: 1, status, state: 'CLOSED', stateReason });

test('reconcile decision: closed as completed → done, not planned → archived', () => {
  assert.deepEqual(reconcileDecision(closed('review')), { status: 'done', outcome: 'completed', reason: 'issue closed as completed' });
  assert.equal(reconcileDecision(closed('running')).status, 'done');
  assert.equal(reconcileDecision(closed('ready')).status, 'done');
  assert.equal(reconcileDecision(closed('todo')).status, 'done');
  assert.equal(reconcileDecision(closed('triage')).status, 'done');
  assert.equal(reconcileDecision(closed('blocked')).status, 'done');
  // GitHub leaves stateReason null on plenty of closes; that is a completed close
  assert.equal(reconcileDecision(closed('review', null)).status, 'done');

  const np = reconcileDecision(closed('running', 'NOT_PLANNED'));
  assert.equal(np.status, 'archived');
  assert.equal(np.outcome, 'blocked');
  assert.match(np.reason, /not planned/);
  assert.equal(reconcileDecision(closed('review', 'DUPLICATE')).status, 'archived');
});

test('reconcile decision: nothing to do for open issues or settled labels', () => {
  assert.equal(reconcileDecision({ number: 1, status: 'review', state: 'OPEN', stateReason: null }), null);
  assert.equal(reconcileDecision(closed('done')), null);
  assert.equal(reconcileDecision(closed('archived')), null);
  assert.equal(reconcileDecision(closed(null)), null); // no kb:status label at all
  assert.equal(reconcileDecision(null), null);
});

test('reconcile decision: state and reason are read case-insensitively', () => {
  assert.equal(reconcileDecision({ number: 2, status: 'review', state: 'closed', stateReason: 'completed' }).status, 'done');
  assert.equal(reconcileDecision({ number: 2, status: 'review', state: 'closed', state_reason: 'not_planned' }).status, 'archived');
});

test('reconcile closes the open attempt with the decision outcome', () => {
  const run = emptyRun();
  run.attempts.push({ attempt: 1, profile: 'claude', host: 'h', started_at: '2026-08-26T10:00:00Z', ended_at: '2026-08-26T10:05:00Z', outcome: 'crashed' });
  run.attempts.push({ attempt: 2, profile: 'claude', host: 'h', started_at: '2026-08-26T10:06:00Z' });
  const a = closeAttemptForReconcile(run, reconcileDecision(closed('running')), '2026-08-26T11:00:00Z');
  assert.equal(a.attempt, 2);
  assert.equal(a.outcome, 'completed');
  assert.equal(a.ended_at, '2026-08-26T11:00:00Z');
  assert.match(a.reason, /closed as completed/);
  assert.equal(run.attempts[0].outcome, 'crashed'); // earlier attempts untouched
});

test('reconcile leaves an already-finished run alone', () => {
  const run = emptyRun();
  run.attempts.push({ attempt: 1, profile: 'claude', host: 'h', started_at: '2026-08-26T10:00:00Z', ended_at: '2026-08-26T10:20:00Z', outcome: 'completed', summary: 'done' });
  const before = JSON.stringify(run);
  assert.equal(closeAttemptForReconcile(run, reconcileDecision(closed('review')), '2026-08-26T11:00:00Z'), null);
  assert.equal(JSON.stringify(run), before);
  assert.equal(closeAttemptForReconcile(emptyRun(), reconcileDecision(closed('review')), '2026-08-26T11:00:00Z'), null);
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
