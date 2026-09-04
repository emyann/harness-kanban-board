// The last step: `dispatch.merge.mode` — keep it, or hand it to GitHub's own auto-merge.
//
// Three things are pinned here, in order of how much they would cost to get wrong:
//   1. `manual` — the default, and every board.json that predates the feature — sends nothing.
//   2. `auto` enables auto-merge ONCE per PR, and never asks GitHub for something it would refuse.
//   3. `auto` on a branch with no gate is refused, by the tick and by doctor, with the fix named.
// The mutation is only ever asserted against the fake (test/fake-gh.js); nothing here can reach a
// live pull request. The card lives on the board double and the pull request on the forge double,
// which is exactly how the two are kept apart in `src/`: `h.card()` seeds both and the head branch
// is what joins them (`fillPrs`, src/forge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick, autoMergePass } from '../src/dispatch.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { checkMergePolicy, MERGE_CHECK } from '../src/doctor.js';
import { mergePolicy, autoMergeDecision, mergeGate, mergeDecision, operatorReviewEvidence, emptyRun } from '../src/model.js';
import { mergeCard } from '../src/lifecycle.js';
import { installDoubles, kbIssue, runWith } from './fake-store.js';

function harness({ merge = null, board = 'default', allowAutoMerge = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-merge-'));
  const cfg = {
    ...DEFAULT_BOARD,
    repo: 'acme/board',
    board,
    default_branch: 'main',
    dispatch: { ...DEFAULT_BOARD.dispatch, ...(merge ? { merge } : {}) },
    profiles: { claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root,
    cfg,
    repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
    board,
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  };
  const { gh, store, restore } = installDoubles(ctx, { board });
  gh.allowAutoMerge = allowAutoMerge;
  const logs = [];
  return {
    gh,
    store,
    ctx,
    root,
    log: () => logs.join('\n'),
    tick: (opts = {}) => tick(ctx, { log: (m) => logs.push(m), ...opts }),
    /**
     * A card on the board and its pull request on the forge. Seeded separately on purpose: they are
     * two systems, and the head branch (`kb/<n>` here) is the only thing that ties them together.
     */
    card(spec = {}) {
      const { prs = [], ...rest } = spec;
      // The card carries no pull request: the store does not know about them, and the tick has to
      // find this one the way it finds every other — the forge's listing, matched by head branch.
      // That is also what makes the auto-merge pass idempotent here, because the *forge* is where
      // `autoMergeEnabled` changes.
      const card = store.addIssue(kbIssue({ ...rest }));
      for (const pr of prs) {
        gh.addPull({
          number: pr.number,
          head: pr.head || `kb/${card.number}`,
          base: pr.baseRefName || 'main',
          draft: !!pr.isDraft,
          state: pr.state || 'OPEN',
          merged: !!pr.merged,
          nodeId: pr.nodeId || `PR_kwFake${pr.number}`,
          autoMerge: pr.autoMergeEnabled ? { enabledAt: '2026-08-26T02:00:00Z', mergeMethod: 'SQUASH' } : null,
          mergeable: pr.mergeable ?? null,
          mergeStateStatus: pr.mergeStateStatus ?? null,
          checksState: pr.checksState,
        });
      }
      return card;
    },
    cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Every `enablePullRequestAutoMerge` the transport was asked to send, in order. */
const enables = (gh) => gh.requests.filter((c) => c.kind === 'graphql' && /enablePullRequestAutoMerge/.test(c.query || ''));
/** Every branch-protection or ruleset read — the gate's cost. */
const gateReads = (gh) => gh.requests.filter((c) => /\/protection$|\/rules\/branches\//.test(c.path || ''));

const openPr = (over = {}) => ({ number: 100, state: 'OPEN', isDraft: false, headRefName: 'kb/1', ...over });

// ---------- the policy, pure ----------

test('a board.json that predates the feature reads as today: manual, and nothing to send', () => {
  for (const cfg of [{}, { dispatch: {} }, { dispatch: { merge: {} } }, null]) {
    const p = mergePolicy(cfg);
    assert.equal(p.mode, 'manual');
    assert.equal(p.auto, false);
    assert.equal(p.operator, false);
    assert.equal(p.error, null);
  }
  // and the shipped default says it out loud rather than leaving it to the fallback
  assert.deepEqual(DEFAULT_BOARD.dispatch.merge, { mode: 'manual', method: 'squash' });
});

test('mode auto takes squash unless the board asks for another method', () => {
  const require = { checks: true, review_comment: true };
  assert.deepEqual(mergePolicy({ dispatch: { merge: { mode: 'auto' } } }), { mode: 'auto', method: 'squash', require, mergeMethod: 'SQUASH', auto: true, operator: false, error: null });
  assert.equal(mergePolicy({ dispatch: { merge: { mode: 'auto', method: 'rebase' } } }).mergeMethod, 'REBASE');
  assert.equal(mergePolicy({ dispatch: { merge: { mode: 'auto', method: 'merge' } } }).mergeMethod, 'MERGE');
});

test('mode operator: require.checks and require.review_comment default on, and can be turned off', () => {
  const p = mergePolicy({ dispatch: { merge: { mode: 'operator' } } });
  assert.equal(p.operator, true);
  assert.equal(p.auto, false);
  assert.deepEqual(p.require, { checks: true, review_comment: true });

  const off = mergePolicy({ dispatch: { merge: { mode: 'operator', require: { checks: false, review_comment: false } } } });
  assert.deepEqual(off.require, { checks: false, review_comment: false });
});

test('a policy hkb cannot read never merges: it names the mistake and stays manual', () => {
  const bad = mergePolicy({ dispatch: { merge: { mode: 'yes' } } });
  assert.equal(bad.auto, false);
  assert.equal(bad.operator, false);
  assert.match(bad.error, /dispatch\.merge\.mode must be "manual", "operator", "auto", not "yes"/);
  const method = mergePolicy({ dispatch: { merge: { mode: 'auto', method: 'fast-forward' } } });
  assert.equal(method.auto, false);
  assert.match(method.error, /dispatch\.merge\.method must be one of squash, merge, rebase/);
  const badRequire = mergePolicy({ dispatch: { merge: { mode: 'operator', require: { checks: 'yes' } } } });
  assert.equal(badRequire.operator, false);
  assert.match(badRequire.error, /dispatch\.merge\.require\.checks must be true or false/);
});

// ---------- which PR, pure ----------

const auto = mergePolicy({ dispatch: { merge: { mode: 'auto' } } });
const card = (over = {}) => ({ number: 7, status: 'review', prs: [{ ...openPr(), nodeId: 'PR_kw7' }], ...over });

test('the card the dispatcher hands over: in review, one open non-draft PR, no auto-merge yet', () => {
  const d = autoMergeDecision(card(), auto);
  assert.equal(d.enable, true);
  assert.equal(d.pr.number, 100);
  assert.equal(d.method, 'squash');
});

test('everything else is left alone, and says why', () => {
  const cases = [
    [card(), mergePolicy({}), /manual/],
    [card({ status: 'running' }), auto, /is running, not review/],
    [card({ prs: [] }), auto, /no open PR/],
    [card({ prs: [{ ...openPr(), state: 'CLOSED', nodeId: 'PR_kw7' }] }), auto, /no open PR/],
    [card({ prs: [{ ...openPr(), isDraft: true, nodeId: 'PR_kw7' }] }), auto, /still a draft/],
    [card({ prs: [{ ...openPr(), autoMergeEnabled: true, nodeId: 'PR_kw7' }] }), auto, /already has auto-merge enabled/],
    [card({ prs: [openPr()] }), auto, /without a node id/],
  ];
  for (const [task, policy, why] of cases) {
    const d = autoMergeDecision(task, policy);
    assert.equal(d.enable, false, `${why} should not enable`);
    assert.match(d.why, why);
  }
});

// ---------- operator mode, pure (#189) ----------

const operatorPolicy = mergePolicy({ dispatch: { merge: { mode: 'operator' } } });
const manualPolicy = mergePolicy({});
const reviewCard = (over = {}) => ({ number: 9, status: 'review', prs: [{ ...openPr(), nodeId: 'PR_kw9' }], ...over });

test('a review naming a reviewer is evidence; a bare completed attempt is not', () => {
  const run = { ...emptyRun(), attempts: [{ attempt: 1, outcome: 'completed' }] };
  assert.equal(operatorReviewEvidence(run).ok, false);
  const withReviewer = { ...emptyRun(), attempts: [{ attempt: 1, outcome: 'review_requested', reviewer: 'alice' }] };
  const e = operatorReviewEvidence(withReviewer);
  assert.equal(e.ok, true);
  assert.match(e.detail, /alice \(attempt 1\)/);
});

test('a summary at merge time is evidence too, when nothing named a reviewer', () => {
  const run = emptyRun();
  assert.equal(operatorReviewEvidence(run, { summary: '  ' }).ok, false); // blank does not count
  const e = operatorReviewEvidence(run, { summary: 'ran the suite, checked Done-when #1-3' });
  assert.equal(e.ok, true);
  assert.equal(e.detail, 'ran the suite, checked Done-when #1-3');
});

test('manual and auto refuse hkb merge outright, naming the mode', () => {
  assert.match(mergeDecision(reviewCard(), emptyRun(), manualPolicy).reason, /mode is "manual" — merging is the human's step/);
  const autoPolicy = mergePolicy({ dispatch: { merge: { mode: 'auto' } } });
  assert.match(mergeDecision(reviewCard(), emptyRun(), autoPolicy).reason, /mode is "auto" — GitHub merges the PR itself/);
});

test('operator without a review on the card refuses, naming the condition', () => {
  const d = mergeDecision(reviewCard(), emptyRun(), operatorPolicy, { checksState: 'SUCCESS' });
  assert.equal(d.ok, false);
  assert.match(d.reason, /no review on #9 — request one with a named reviewer.*or run hkb merge 9 --summary/);
});

test('operator with a review but red checks refuses, naming the checks', () => {
  const d = mergeDecision(reviewCard(), emptyRun(), operatorPolicy, { summary: 'checked it', checksState: 'FAILURE' });
  assert.equal(d.ok, false);
  assert.match(d.reason, /PR #100's checks are failure, not green/);
});

test('operator with a review and green checks merges', () => {
  const d = mergeDecision(reviewCard(), emptyRun(), operatorPolicy, { summary: 'ran npm test, verified Done-when', checksState: 'SUCCESS' });
  assert.equal(d.ok, true);
  assert.equal(d.pr.number, 100);
  assert.equal(d.method, 'squash');
  assert.equal(d.reviewDetail, 'ran npm test, verified Done-when');
});

test('turning require.checks off skips the checks read entirely', () => {
  const lenient = mergePolicy({ dispatch: { merge: { mode: 'operator', require: { checks: false } } } });
  const d = mergeDecision(reviewCard(), emptyRun(), lenient, { summary: 'looked at it', checksState: null });
  assert.equal(d.ok, true);
});

test('operator refuses off-review-status and no-PR cards the same as auto does', () => {
  assert.match(mergeDecision(reviewCard({ status: 'running' }), emptyRun(), operatorPolicy).reason, /is running, not review/);
  assert.match(mergeDecision(reviewCard({ prs: [] }), emptyRun(), operatorPolicy).reason, /no open PR to merge/);
  assert.match(mergeDecision(reviewCard({ prs: [{ ...openPr(), isDraft: true, nodeId: 'PR_kw9' }] }), emptyRun(), operatorPolicy).reason, /still a draft/);
});

// ---------- the gate, pure ----------

test('a required check or a required review is a gate; anything else is a refusal with the fix', () => {
  const ok = (p) => mergeGate(p, 'main');
  assert.equal(ok({ known: true, protected: true, requiredChecks: ['test'], requiredReviews: 0 }).ok, true);
  assert.match(ok({ known: true, protected: true, requiredChecks: ['test'], requiredReviews: 0 }).detail, /main requires test/);
  assert.equal(ok({ known: true, protected: true, requiredChecks: [], requiredReviews: 1 }).ok, true);

  for (const [protection, detail] of [
    [{ known: true, protected: false, requiredChecks: [], requiredReviews: 0 }, /no branch protection/],
    [{ known: true, protected: true, requiredChecks: [], requiredReviews: 0 }, /protected but requires no status check/],
    [{ known: false, why: 'the token cannot read branch protection — it needs repo admin' }, /could not be read \(the token cannot read/],
  ]) {
    const g = ok(protection);
    assert.equal(g.ok, false);
    assert.match(g.detail, detail);
    assert.match(g.fix, /require a status check on main .* or set "dispatch": \{"merge": \{"mode": "manual"\}\}/);
  }
});

// ---------- the tick ----------

test('manual — the default — sends nothing at all: not a mutation, not even a protection read', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] });
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });

  const s = await h.tick();

  assert.deepEqual(s.auto_merge, []);
  assert.deepEqual(enables(h.gh), []);
  assert.deepEqual(gateReads(h.gh), []);
  assert.equal(h.store.statusOf(1), 'review');
  assert.equal(h.gh.autoMergeOf(100), null);
});

test('auto on a protected branch enables auto-merge once, and the next tick sends nothing', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test', 'packed artifact'] });
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });

  const first = await h.tick();
  assert.deepEqual(first.auto_merge, [{ number: 1, pr: 100, base: 'main', method: 'squash', ok: true }]);
  assert.equal(enables(h.gh).length, 1);
  assert.equal(enables(h.gh)[0].variables.method, 'SQUASH');
  assert.deepEqual(h.gh.autoMergeOf(100), { enabledAt: '2026-08-26T02:00:00Z', mergeMethod: 'SQUASH' });
  assert.match(h.log(), /#1: auto-merge \(squash\) enabled on PR #100 — main requires test, packed artifact/);

  // idempotent: the board read now carries the auto-merge request, so there is nothing to send
  const second = await h.tick();
  assert.deepEqual(second.auto_merge, []);
  assert.equal(enables(h.gh).length, 1);
  // and the gate is not re-read for a card there is nothing to do about
  assert.equal(gateReads(h.gh).length, 1);
});

test('auto on an unprotected branch refuses, every tick, with the fix — and merges nothing', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });

  const s = await h.tick();

  assert.deepEqual(enables(h.gh), []);
  assert.equal(h.gh.autoMergeOf(100), null);
  assert.equal(s.auto_merge.length, 1);
  assert.equal(s.auto_merge[0].ok, false);
  assert.match(s.auto_merge[0].why, /main has no branch protection/);
  assert.match(s.auto_merge[0].fix, /require a status check on main/);
  assert.match(h.log(), /#1: auto-merge refused on PR #100: main has no branch protection.* → require a status check/);
});

test('a ruleset is a gate too — and the only one a token without repo admin can read', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { admin: false }); // the classic endpoint answers 403
  h.gh.ruleset('main', { checks: ['test'] });
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });

  const s = await h.tick();

  assert.equal(s.auto_merge[0].ok, true);
  assert.equal(enables(h.gh).length, 1);
});

test('protection it cannot read is a refusal, not an assumption', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { admin: false }); // 403, and no ruleset to fall back on
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });

  const s = await h.tick();

  assert.deepEqual(enables(h.gh), []);
  assert.equal(s.auto_merge[0].ok, false);
  assert.match(s.auto_merge[0].why, /could not be read \(the token cannot read branch protection/);
});

test('a draft PR is never handed over — GitHub would refuse it, so hkb does not ask', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] });
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr({ isDraft: true })] });

  const s = await h.tick();

  assert.deepEqual(s.auto_merge, []);
  assert.deepEqual(enables(h.gh), []);
  assert.deepEqual(gateReads(h.gh), []); // no candidate, so not even the gate is read
});

test('a card the active_pr guard moves to review is handed over on the same tick', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] });
  h.card({ number: 1, status: 'ready', agent: 'claude', prs: [openPr()] });

  const s = await h.tick();

  assert.deepEqual(s.guarded, [{ number: 1, guard: 'active_pr', pr: 100 }]);
  assert.equal(h.store.statusOf(1), 'review');
  assert.equal(enables(h.gh).length, 1);
  assert.equal(s.auto_merge[0].number, 1);
});

test('the gate is read once a tick however many cards are waiting on the same branch', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] });
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr({ number: 100 })] });
  h.card({ number: 2, status: 'review', agent: 'claude', prs: [openPr({ number: 101 })] });

  const s = await h.tick();

  assert.equal(s.auto_merge.length, 2);
  assert.equal(enables(h.gh).length, 2);
  assert.equal(gateReads(h.gh).length, 1);
});

test('a PR based on a branch of its own is gated on THAT branch, not on the default one', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] }); // main is fine; the PR does not target it
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr({ baseRefName: 'stack/base' })] });

  const s = await h.tick();

  assert.deepEqual(enables(h.gh), []);
  assert.match(s.auto_merge[0].why, /stack\/base has no branch protection/);
  assert.equal(s.auto_merge[0].base, 'stack/base');
});

test('--dry-run enables nothing and says what it would have done', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] });
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });

  const s = await h.tick({ dryRun: true });

  assert.deepEqual(enables(h.gh), []);
  assert.equal(s.auto_merge[0].dry, true);
  assert.match(h.log(), /\[dry-run\] would enable auto-merge \(squash\) on PR #100/);
});

test('a policy hkb cannot read is reported and changes nothing', async (t) => {
  const h = harness({ merge: { mode: 'always' } });
  t.after(h.cleanup);
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });

  const s = await h.tick();

  assert.deepEqual(s.auto_merge, []);
  assert.deepEqual(enables(h.gh), []);
  assert.match(h.log(), /dispatch\.merge ignored — the last step stays manual: dispatch\.merge\.mode must be/);
});

test('a mutation GitHub rejects is reported on the card, and the tick carries on', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] });
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [openPr()] });
  h.gh.fail({ kind: 'graphql' }, { status: 422, message: 'Protected branch rules not configured for this branch' });

  const s = await autoMergePass(h.ctx, [{ number: 1, status: 'review', prs: [{ ...openPr(), nodeId: 'PR_kwFake100' }] }], { log: () => {} });

  assert.equal(s[0].ok, false);
  assert.match(s[0].error, /Protected branch rules not configured/);
});

// ---------- doctor ----------

function sink() {
  const results = [];
  return {
    results,
    ok: (name, detail) => results.push({ name, ok: true, detail }),
    bad: (name, detail, fix) => results.push({ name, ok: false, detail, fix }),
    warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }),
  };
}

test('doctor says nothing about a manual board — the default reports nothing to fix', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const s = sink();

  await checkMergePolicy(h.ctx, s);

  assert.deepEqual(s.results, []);
  assert.deepEqual(gateReads(h.gh), []);
});

test('doctor always names the operator mode and its condition — never silent, unlike manual', async (t) => {
  const h = harness({ merge: { mode: 'operator' } });
  t.after(h.cleanup);
  const s = sink();

  await checkMergePolicy(h.ctx, s);

  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].ok, true);
  assert.match(s.results[0].detail, /operator \(squash\) — hkb merge <n> merges once/);
  assert.match(s.results[0].detail, /a review on the card/);
  assert.match(s.results[0].detail, /the PR's own checks green/);
});

test('doctor names only what require still asks for, once turned down', async (t) => {
  const h = harness({ merge: { mode: 'operator', require: { checks: false } } });
  t.after(h.cleanup);
  const s = sink();

  await checkMergePolicy(h.ctx, s);

  assert.doesNotMatch(s.results[0].detail, /checks green/);
  assert.match(s.results[0].detail, /a review on the card/);
});

test('doctor FAILS on auto without a gate, and names the fix', async (t) => {
  const h = harness({ merge: { mode: 'auto' } });
  t.after(h.cleanup);
  const s = sink();

  await checkMergePolicy(h.ctx, s);

  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].name, MERGE_CHECK);
  assert.equal(s.results[0].ok, false); // hard failure: `hkb doctor` exits non-zero on it
  assert.match(s.results[0].detail, /merge\.mode is "auto" but main has no branch protection/);
  assert.match(s.results[0].fix, /require a status check on main/);
});

test('doctor passes on auto once the branch has something to wait for', async (t) => {
  const h = harness({ merge: { mode: 'auto', method: 'rebase' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'], reviews: 1 });
  const s = sink();

  await checkMergePolicy(h.ctx, s);

  assert.equal(s.results[0].ok, true);
  assert.match(s.results[0].detail, /auto \(rebase\) — main requires test and 1 approving review\(s\)/);
});

test('doctor says which gate is in force, because only a REQUIRED review holds the merge', async (t) => {
  // Confirming the interaction with `request-review --reviewer <user>` rather than assuming it:
  // GitHub's auto-merge waits for what the branch *requires*, and a review request is not that.
  const checksOnly = harness({ merge: { mode: 'auto' } });
  t.after(checksOnly.cleanup);
  checksOnly.gh.protect('main', { checks: ['test'] });
  const a = sink();
  await checkMergePolicy(checksOnly.ctx, a);
  assert.equal(a.results[0].ok, true);
  assert.match(a.results[0].detail, /nothing waits for a human: `request-review --reviewer <user>` requests a review, it does not require one/);

  const withReviews = harness({ merge: { mode: 'auto' } });
  t.after(withReviews.cleanup);
  withReviews.gh.protect('main', { checks: ['test'], reviews: 1 });
  const b = sink();
  await checkMergePolicy(withReviews.ctx, b);
  assert.match(b.results[0].detail, /a `request-review --reviewer <user>` is held until they approve/);
});

test('doctor fails auto on a repository where auto-merge is switched off', async (t) => {
  const h = harness({ merge: { mode: 'auto' }, allowAutoMerge: false });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] }); // the gate is fine; the repository setting is not
  const s = sink();

  await checkMergePolicy(h.ctx, s);

  assert.equal(s.results[0].ok, false);
  assert.match(s.results[0].detail, /does not allow auto-merge, so every enable would fail/);
  assert.match(s.results[0].fix, /Settings → General → Pull Requests → Allow auto-merge/);
});

test('doctor fails a policy it cannot read, whatever the branch looks like', async (t) => {
  const h = harness({ merge: { mode: 'auto', method: 'ff' } });
  t.after(h.cleanup);
  h.gh.protect('main', { checks: ['test'] });
  const s = sink();

  await checkMergePolicy(h.ctx, s);

  assert.equal(s.results[0].ok, false);
  assert.match(s.results[0].detail, /dispatch\.merge\.method must be one of/);
  assert.match(s.results[0].fix, /board\.json/);
  assert.deepEqual(gateReads(h.gh), []); // it never got as far as asking GitHub
});

// ---------- `hkb merge`, end to end against the fake ----------

const mergeMutations = (gh) => gh.requests.filter((c) => c.kind === 'graphql' && /mergePullRequest/.test(c.query || ''));

test('hkb merge refuses on a manual board, naming the mode — and merges nothing', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [{ ...openPr(), checksState: 'SUCCESS' }] });

  await assert.rejects(mergeCard(h.ctx, 1, { summary: 'checked it' }), /mode is "manual"/);
  assert.deepEqual(mergeMutations(h.gh), []);
});

test('hkb merge refuses an operator card with no review, naming the condition', async (t) => {
  const h = harness({ merge: { mode: 'operator' } });
  t.after(h.cleanup);
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [{ ...openPr(), checksState: 'SUCCESS' }] });

  await assert.rejects(mergeCard(h.ctx, 1), /no review on #1/);
  assert.deepEqual(mergeMutations(h.gh), []);
});

test('hkb merge refuses a red-check operator card even with a summary', async (t) => {
  const h = harness({ merge: { mode: 'operator' } });
  t.after(h.cleanup);
  h.card({ number: 1, status: 'review', agent: 'claude', prs: [{ ...openPr(), checksState: 'FAILURE' }] });

  await assert.rejects(mergeCard(h.ctx, 1, { summary: 'looked at it' }), /checks are failure, not green/);
  assert.deepEqual(mergeMutations(h.gh), []);
});

test('hkb merge on an operator board merges once a summary is given, and writes the record', async (t) => {
  const h = harness({ merge: { mode: 'operator' } });
  t.after(h.cleanup);
  h.card({
    number: 1, status: 'review', agent: 'claude',
    prs: [{ ...openPr(), checksState: 'SUCCESS' }],
    run: runWith([{ attempt: 1, outcome: 'review_requested', pr: 100, ended_at: '2026-08-26T01:00:00Z' }]),
  });

  const r = await mergeCard(h.ctx, 1, { summary: 'ran the suite, checked Done-when #1-3' });

  assert.equal(r.merged, true);
  assert.equal(r.pr, 100);
  assert.equal(r.merged_by, 'operator');
  assert.equal(mergeMutations(h.gh).length, 1);
  assert.equal(h.gh.prOf(100).merged, true);
  const comments = h.store.issues.get(1).comments.map((c) => c.body);
  assert.ok(comments.some((b) => /\*\*Merged by the operator seat\*\* — review: ran the suite.*checks: green, method: squash/.test(b)));
  assert.equal(h.store.runOf(1).attempts[0].merged_by, 'operator');
  // The merge is what finishes the card, and `hkb merge` says so itself rather than waiting for the
  // next tick's reconcile pass to find the merged PR.
  assert.equal(r.status, 'done');
  assert.equal(h.store.statusOf(1), 'done');
  assert.equal(h.store.stateOf(1).state, 'CLOSED');
});

test('hkb merge with a reviewer already on record needs no summary', async (t) => {
  const h = harness({ merge: { mode: 'operator' } });
  t.after(h.cleanup);
  h.card({
    number: 1, status: 'review', agent: 'claude',
    prs: [{ ...openPr(), checksState: 'SUCCESS' }],
    run: runWith([{ attempt: 1, outcome: 'review_requested', reviewer: 'alice', pr: 100, ended_at: '2026-08-26T01:00:00Z' }]),
  });

  const r = await mergeCard(h.ctx, 1);

  assert.equal(r.merged, true);
  const comments = h.store.issues.get(1).comments.map((c) => c.body);
  assert.ok(comments.some((b) => /review: review requested from alice \(attempt 1\)/.test(b)));
});
