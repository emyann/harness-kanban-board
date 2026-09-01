// `complete` must not land a card in *done* when it found no PR — refuse, or record a
// protocol_violation naming the missing PR, and leave the card where a human will see it (#234).
// No git, no locks: complete only reads the board, writes labels/comments and releases the lock ref
// through the fake GitHub — nothing here touches a real checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { complete } from '../src/lifecycle.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

function harness({ prs = [] } = {}) {
  const gh = new FakeGh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-nopr-'));
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: '2026-09-01T00:00:00Z' }]);
  gh.addIssue(kbIssue({ number: 234, status: 'running', agent: 'claude', run, prs }));
  const ctx = {
    root,
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
  };
  const restore = gh.install();
  return { gh, ctx, cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('complete refuses to land in done with no PR found: protocol_violation, blocked, needs-human', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    const r = await complete(ctx, 234, { summary: 'did the thing' });
    assert.equal(r.status, 'blocked');
    assert.equal(r.protocol_violation, true);
    assert.match(r.reason, /no PR found for #234/);

    assert.equal(gh.statusOf(234), 'blocked');
    assert.equal(gh.issues.get(234).labels.includes('kb:needs-human'), true);
    const run = gh.runOf(234);
    assert.equal(run.attempts[0].outcome, 'protocol_violation');
    assert.match(run.attempts[0].reason, /no PR found/);
    const comment = gh.issues.get(234).comments.find((c) => c.body.startsWith('**Protocol violation**'));
    assert.ok(comment, 'the reason is written where a human will see it');
  } finally { cleanup(); }
});

test('complete --no-pr lands the card in done as before, with the reason recorded', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    const r = await complete(ctx, 234, { summary: 'docs only, nothing to merge', noPr: true, noPrReason: 'this card only updates a wiki page' });
    assert.equal(r.status, 'done');
    assert.equal(gh.statusOf(234), 'done');
    const run = gh.runOf(234);
    assert.equal(run.attempts[0].outcome, 'completed');
    const result = gh.issues.get(234).comments.find((c) => c.body.startsWith('<!-- kb-result -->'));
    assert.match(result.body, /this card only updates a wiki page/);
  } finally { cleanup(); }
});

test('complete finds its own PR through the head-branch fallback and never treats it as a violation', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addPull({ number: 300, head: 'kb/234', base: 'kb/191-wave1' }); // a stacked branch GraphQL will not link
    const r = await complete(ctx, 234, { summary: 'did the thing' });
    assert.equal(r.status, 'review');
    assert.equal(r.pr, 300);
    assert.equal(gh.runOf(234).attempts[0].outcome, 'completed');
  } finally { cleanup(); }
});
