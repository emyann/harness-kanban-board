// `complete` must not land a card in *done* when it found no PR — refuse, or record a
// protocol_violation naming the missing PR, and leave the card where a human will see it (#234).
// The card is on the board double and its pull request on the forge double, joined by head branch,
// which is the whole of what ties them together now (`fillPrs`, src/forge.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { complete } from '../src/lifecycle.js';
import { installDoubles, kbIssue, runWith } from './fake-store.js';

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-nopr-'));
  const ctx = {
    root,
    repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
  };
  const { gh, store, restore } = installDoubles(ctx);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: '2026-09-01T00:00:00Z' }]);
  store.addIssue(kbIssue({ number: 234, status: 'running', agent: 'claude', run }));
  return { gh, store, ctx, cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('complete refuses to land in done with no PR found: protocol_violation, blocked, needs-human', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    const r = await complete(ctx, 234, { summary: 'did the thing' });
    assert.equal(r.status, 'blocked');
    assert.equal(r.protocol_violation, true);
    assert.match(r.reason, /no PR found for #234/);

    assert.equal(store.statusOf(234), 'blocked');
    assert.equal(store.issues.get(234).labels.includes('kb:needs-human'), true);
    const run = store.runOf(234);
    assert.equal(run.attempts[0].outcome, 'protocol_violation');
    assert.match(run.attempts[0].reason, /no PR found/);
    const comment = store.issues.get(234).comments.find((c) => c.body.startsWith('**Protocol violation**'));
    assert.ok(comment, 'the reason is written where a human will see it');
  } finally { cleanup(); }
});

test('complete --no-pr lands the card in done as before, with the reason recorded', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    const r = await complete(ctx, 234, { summary: 'docs only, nothing to merge', noPr: true, noPrReason: 'this card only updates a wiki page' });
    assert.equal(r.status, 'done');
    assert.equal(store.statusOf(234), 'done');
    const run = store.runOf(234);
    assert.equal(run.attempts[0].outcome, 'completed');
    const result = store.issues.get(234).comments.find((c) => c.body.startsWith('<!-- kb-result -->'));
    assert.match(result.body, /this card only updates a wiki page/);
  } finally { cleanup(); }
});

test('complete finds its own PR through the head-branch fallback and never treats it as a violation', async () => {
  const { gh, store, ctx, cleanup } = harness();
  try {
    gh.addPull({ number: 300, head: 'kb/234', base: 'kb/191-wave1' }); // a stacked branch GraphQL will not link
    const r = await complete(ctx, 234, { summary: 'did the thing' });
    assert.equal(r.status, 'review');
    assert.equal(r.pr, 300);
    assert.equal(store.runOf(234).attempts[0].outcome, 'completed');
  } finally { cleanup(); }
});
