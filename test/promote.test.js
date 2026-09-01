// `promote` (#209): a root drags its still-open blockers along with it, but never forces one
// ready. No git, no locks — promote only reads the board and writes labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promote } from '../src/lifecycle.js';
import { FakeGh, kbIssue } from './fake-gh.js';

function harness() {
  const gh = new FakeGh();
  const ctx = {
    root: '/tmp/nonexistent', // promote never touches the checkout
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
  };
  const restore = gh.install();
  return { gh, ctx, cleanup: restore };
}

test('promoting a root sweeps its open triage blockers to todo, in the same call (#209)', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 154, status: 'triage', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 155, status: 'triage', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 158, status: 'triage', agent: 'claude', blockedBy: [154, 155] }));

    const res = await promote(ctx, 158);
    assert.deepEqual(res.map((r) => ({ number: r.number, status: r.status })).sort((a, b) => a.number - b.number), [
      { number: 154, status: 'todo' },
      { number: 155, status: 'todo' },
      { number: 158, status: 'todo' },
    ]);
    // and it actually wrote the labels, not just reported them
    assert.equal(gh.issues.get(154).labels.includes('kb:status:todo'), true);
    assert.equal(gh.issues.get(158).labels.includes('kb:status:todo'), true);
  } finally { cleanup(); }
});

test('promote never forces a blocker ready, even when the root is already in todo (#209)', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 154, status: 'triage', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 158, status: 'todo', agent: 'claude', blockedBy: [154] }));

    // today's single-card promote would force #158 straight to ready; the cascade must not
    const res = await promote(ctx, 158);
    const byNumber = new Map(res.map((r) => [r.number, r]));
    assert.equal(byNumber.get(154).status, 'todo');
    assert.equal(byNumber.get(158).status, 'todo');
    assert.equal(byNumber.get(158).unchanged, true);
    assert.equal(byNumber.get(158).forced, undefined);
    assert.equal(gh.issues.get(158).labels.includes('kb:status:ready'), false);
  } finally { cleanup(); }
});

test('promote on a leaf — no open blockers — behaves exactly as it did before #209', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 40, status: 'todo', agent: 'claude' })); // no blockers at all
    const res = await promote(ctx, 40);
    assert.deepEqual(res, [{ number: 40, status: 'ready', from: 'todo', forced: false }]); // genuinely ready, not forced
    assert.equal(gh.issues.get(40).labels.includes('kb:status:ready'), true);

    gh.addIssue(kbIssue({ number: 41, status: 'blocked', agent: 'claude', needsHuman: true }));
    const res2 = await promote(ctx, 41);
    assert.deepEqual(res2, [{ number: 41, status: 'ready', from: 'blocked', forced: false }]); // no blockers either, so genuinely ready
    assert.equal(gh.issues.get(41).labels.includes('kb:status:ready'), true);
    assert.equal(gh.issues.get(41).labels.includes('kb:needs-human'), false); // cleared, as before
  } finally { cleanup(); }
});

test('a blocker parked with a human is left alone by the cascade, and says why', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 30, status: 'blocked', agent: 'claude', needsHuman: true }));
    gh.addIssue(kbIssue({ number: 31, status: 'todo', agent: 'claude', blockedBy: [30] }));

    const res = await promote(ctx, 31);
    const byNumber = new Map(res.map((r) => [r.number, r]));
    assert.equal(byNumber.get(30).status, 'blocked');
    assert.equal(byNumber.get(30).skipped, true);
    assert.match(byNumber.get(30).reason, /needs human/);
    assert.equal(gh.issues.get(30).labels.includes('kb:needs-human'), true); // never cleared
  } finally { cleanup(); }
});

test('a card already past todo is reported skipped, with a reason, not silently dropped', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 50, status: 'ready', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 51, status: 'triage', agent: 'claude', blockedBy: [50] }));

    const res = await promote(ctx, 51);
    const byNumber = new Map(res.map((r) => [r.number, r]));
    assert.equal(byNumber.get(51).status, 'todo'); // moved
    assert.deepEqual(byNumber.get(50), { number: 50, status: 'ready', unchanged: true, skipped: true, reason: 'already ready' });
  } finally { cleanup(); }
});
