// The PR decision a terminal verb makes: a worker's draft PR must come out of draft,
// or `gh pr merge` refuses it. Pure — no `gh`, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prReadyDecision, prAttemptFields, noPrDecision } from '../src/lifecycle.js';

const pr = (over = {}) => ({ number: 12, nodeId: 'PR_kwn', state: 'OPEN', isDraft: true, url: 'https://x/pull/12', headRefName: 'worktree-kb-15-6', merged: false, ...over });

test('draft PR → mark it ready', () => {
  const d = prReadyDecision([pr()]);
  assert.equal(d.markReady, true);
  assert.equal(d.pr.number, 12);
  assert.match(d.reason, /draft/);
});

test('open, non-draft PR → skip', () => {
  const d = prReadyDecision([pr({ isDraft: false })]);
  assert.equal(d.markReady, false);
  assert.equal(d.pr.number, 12);
  assert.match(d.reason, /already ready/);
});

test('no PR → skip', () => {
  for (const prs of [[], null, undefined]) {
    const d = prReadyDecision(prs);
    assert.equal(d.pr, null);
    assert.equal(d.markReady, false);
    assert.match(d.reason, /no open PR/);
  }
});

test('closed and merged PRs are never touched', () => {
  const merged = pr({ number: 9, state: 'MERGED', isDraft: false, merged: true });
  const closed = pr({ number: 10, state: 'CLOSED', isDraft: true, merged: false });
  assert.equal(prReadyDecision([merged, closed]).pr, null);
  assert.equal(prReadyDecision([merged, closed]).markReady, false);
  // the open one wins even when it comes last
  const d = prReadyDecision([merged, closed, pr({ number: 12 })]);
  assert.equal(d.pr.number, 12);
  assert.equal(d.markReady, true);
});

test('a PR read without a node id is still a draft to fix (the caller looks the id up)', () => {
  const d = prReadyDecision([pr({ nodeId: undefined })]);
  assert.equal(d.markReady, true);
});

// ---------- what `complete` owes a card it found no PR on (#234) ----------

test('noPrDecision: refuses by default, naming the branches it looked for', () => {
  const d = noPrDecision(234);
  assert.equal(d.ok, false);
  assert.match(d.reason, /#234/);
  assert.match(d.reason, /kb\/234/);
  assert.match(d.reason, /--no-pr/);
});

test('noPrDecision: an explicit --no-pr override is accepted, with or without a reason', () => {
  assert.deepEqual(noPrDecision(1, { noPr: true }), { ok: true, no_pr_reason: null });
  assert.deepEqual(noPrDecision(1, { noPr: true, noPrReason: 'docs-only, nothing to merge' }), { ok: true, no_pr_reason: 'docs-only, nothing to merge' });
  assert.equal(noPrDecision(1, { noPr: false }).ok, false);
});

test('attempt row records pr and pr_head, and stays empty without a PR', () => {
  assert.deepEqual(prAttemptFields(prReadyDecision([pr()])), { pr: 12, pr_head: 'worktree-kb-15-6' });
  assert.deepEqual(prAttemptFields(prReadyDecision([pr({ isDraft: false })])), { pr: 12, pr_head: 'worktree-kb-15-6' });
  assert.deepEqual(prAttemptFields(prReadyDecision([pr({ headRefName: undefined })])), { pr: 12, pr_head: null });
  assert.deepEqual(prAttemptFields(prReadyDecision([])), {});
});
