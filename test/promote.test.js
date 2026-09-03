// `promote` (#209): a root drags its still-open blockers along with it, but never forces one
// ready. No git, no locks — promote only reads the board and writes labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promote } from '../src/lifecycle.js';
import { installDoubles, kbIssue } from './fake-store.js';

function harness() {
  const ctx = {
    root: '/tmp/nonexistent', // promote never touches the checkout
    repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
  };
  const { store, restore } = installDoubles(ctx);
  return { gh: store, ctx, cleanup: restore };
}

test('promoting a root sweeps its open triage blockers to todo, in the same call (#209)', async () => {
  const { gh: store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 154, status: 'triage', agent: 'claude' }));
    store.addIssue(kbIssue({ number: 155, status: 'triage', agent: 'claude' }));
    store.addIssue(kbIssue({ number: 158, status: 'triage', agent: 'claude', blockedBy: [154, 155] }));

    const res = await promote(ctx, 158);
    assert.deepEqual(res.map((r) => ({ number: r.number, status: r.status })).sort((a, b) => a.number - b.number), [
      { number: 154, status: 'todo' },
      { number: 155, status: 'todo' },
      { number: 158, status: 'todo' },
    ]);
    // and it actually wrote the labels, not just reported them
    assert.equal(store.statusOf(154), 'todo');
    assert.equal(store.statusOf(158), 'todo');
  } finally { cleanup(); }
});

test('promote never forces a blocker ready, even when the root is already in todo (#209)', async () => {
  const { gh: store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 154, status: 'triage', agent: 'claude' }));
    store.addIssue(kbIssue({ number: 158, status: 'todo', agent: 'claude', blockedBy: [154] }));

    // today's single-card promote would force #158 straight to ready; the cascade must not
    const res = await promote(ctx, 158);
    const byNumber = new Map(res.map((r) => [r.number, r]));
    assert.equal(byNumber.get(154).status, 'todo');
    assert.equal(byNumber.get(158).status, 'todo');
    assert.equal(byNumber.get(158).unchanged, true);
    assert.equal(byNumber.get(158).forced, undefined);
    assert.equal(store.statusOf(158) === 'ready', false);
  } finally { cleanup(); }
});

test('promote on a leaf — no open blockers — behaves exactly as it did before #209', async () => {
  const { gh: store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 40, status: 'todo', agent: 'claude' })); // no blockers at all
    const res = await promote(ctx, 40);
    assert.deepEqual(res, [{ number: 40, status: 'ready', from: 'todo', forced: false }]); // genuinely ready, not forced
    assert.equal(store.statusOf(40), 'ready');

    store.addIssue(kbIssue({ number: 41, status: 'blocked', agent: 'claude', needsHuman: true }));
    const res2 = await promote(ctx, 41);
    assert.deepEqual(res2, [{ number: 41, status: 'ready', from: 'blocked', forced: false }]); // no blockers either, so genuinely ready
    assert.equal(store.statusOf(41), 'ready');
    assert.equal(store.labelsOf(41).includes('kb:needs-human'), false); // cleared, as before
  } finally { cleanup(); }
});

test('a blocker parked with a human is left alone by the cascade, and says why', async () => {
  const { gh: store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 30, status: 'blocked', agent: 'claude', needsHuman: true }));
    store.addIssue(kbIssue({ number: 31, status: 'todo', agent: 'claude', blockedBy: [30] }));

    const res = await promote(ctx, 31);
    const byNumber = new Map(res.map((r) => [r.number, r]));
    assert.equal(byNumber.get(30).status, 'blocked');
    assert.equal(byNumber.get(30).skipped, true);
    assert.match(byNumber.get(30).reason, /needs human/);
    assert.equal(store.labelsOf(30).includes('kb:needs-human'), true); // never cleared
  } finally { cleanup(); }
});

test('--triage-only skips a card that moved on before anything is written (#238)', async () => {
  const { gh: store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 60, status: 'todo', agent: 'claude' })); // no longer in triage

    const res = await promote(ctx, 60, { triageOnly: true });
    assert.deepEqual(res, [{ number: 60, status: 'todo', unchanged: true, skipped: true, reason: 'not in triage — already todo' }]);
    // nothing written: still todo, no ready label
    assert.equal(store.statusOf(60) === 'ready', false);
    assert.equal(store.statusOf(60), 'todo');
  } finally { cleanup(); }
});

test('--triage-only promotes a card genuinely still in triage, same as without the flag', async () => {
  const { gh: store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 61, status: 'triage', agent: 'claude' }));

    const res = await promote(ctx, 61, { triageOnly: true });
    assert.deepEqual(res, [{ number: 61, status: 'todo', from: 'triage', forced: false }]);
    assert.equal(store.statusOf(61), 'todo');
  } finally { cleanup(); }
});

test('a card already past todo is reported skipped, with a reason, not silently dropped', async () => {
  const { gh: store, ctx, cleanup } = harness();
  try {
    store.addIssue(kbIssue({ number: 50, status: 'ready', agent: 'claude' }));
    store.addIssue(kbIssue({ number: 51, status: 'triage', agent: 'claude', blockedBy: [50] }));

    const res = await promote(ctx, 51);
    const byNumber = new Map(res.map((r) => [r.number, r]));
    assert.equal(byNumber.get(51).status, 'todo'); // moved
    assert.deepEqual(byNumber.get(50), { number: 50, status: 'ready', unchanged: true, skipped: true, reason: 'already ready' });
  } finally { cleanup(); }
});
