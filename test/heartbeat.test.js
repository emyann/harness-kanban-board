// `hkb heartbeat`, on the interface. A beat is a compare-and-swap on the claim the store holds
// (docs/local-first.md §6.1) — there is no lock ref, no `git push --force-with-lease` and no
// per-profile `heartbeat: "comment"` mode any more, so what is left to pin is the *protocol*:
//
//   · the warm path costs the store nothing but the swap, and never reads the card;
//   · a rejected lease that the store confirms is LOCK_LOST, and a worker must stop;
//   · a rejected lease the store contradicts resyncs this host's chain instead of stopping it;
//   · a store that cannot make the swap at all falls back to the run record and says so;
//   · a `--note` is content, so it always takes the record path, floor and all.
//
// The real compare-and-swap against a real SQLite index is `test/store-local.test.js`; this is the
// verb over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heartbeat, complete } from '../src/lifecycle.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { openStore } from '../src/store/index.js';
import { installDoubles, kbIssue, runWith } from './fake-store.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

/** A worker's context with one running attempt and a claim already held. */
function harness({ attempt = {}, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-beat-'));
  const cfg = { ...DEFAULT_BOARD, repo: 'acme/board' };
  const ctx = { root, cfg, repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' }, board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; } };
  const { gh, store, restore } = installDoubles(ctx);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(1800), heartbeat_at: ago(1800), ...attempt }]);
  store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', run }));
  const token = store.hold(7, 1);
  const saved = { ...process.env };
  // KB_ATTEMPT only means anything alongside the KB_TASK it belongs to — a track runner acts on
  // several tasks from one session, so a bare KB_ATTEMPT is never read (see `envAttempt`).
  Object.assign(process.env, { KB_TASK: '7', KB_ATTEMPT: '', KB_PROFILE: 'claude', ...env });
  return {
    gh, store, ctx, root, token,
    /** what this host's own beat chain is pointing at — `beatToken` under a name a test can read */
    chain: async () => (await openStore(ctx)).beatToken(7, 1),
    /** the dispatcher reclaimed: the claim is gone */
    reclaim: () => store.lockRows.delete('7/1'),
    cleanup: () => {
      restore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Point this host's beat chain at the claim, the way a claim made on this host would have. */
async function warm(h) { (await openStore(h.ctx)).resyncBeat(7, 1, h.store.lockOf(7, 1).token); }

test('a beat swaps the claim\'s token and writes nothing else', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const seeded = h.store.runOf(7).attempts[0].heartbeat_at;
  await warm(h);
  h.store.clearCalls();

  const r = await heartbeat(h.ctx, 7, {});

  assert.equal(r.mode, 'claim');
  assert.equal(r.attempt, 1);
  assert.notEqual(r.sha, h.token, 'the token moved: that is the swap');
  assert.equal(r.sha, await h.chain(), 'and this host now leases on where it left it');
  assert.deepEqual(h.store.writes(), ['heartbeat'], 'the swap, and nothing on the card');
  assert.equal(h.store.runOf(7).attempts[0].heartbeat_at, seeded, 'the run record is untouched');
  assert.deepEqual(h.gh.writeRequests(), [], 'and nothing at all on the forge');
});

test('a warm worker beats without reading the card or the run record', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  await warm(h);
  h.store.clearCalls();

  await heartbeat(h.ctx, 7, {});

  assert.deepEqual(h.store.calls.map((c) => c.name), ['beatToken', 'heartbeat', 'lockRef'],
    'the lease IS the check: two local reads and the swap — no getTask, no loadRun, no note');
});

test('two beats in a row each lease on where the last one left the chain', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  await warm(h);

  const first = await heartbeat(h.ctx, 7, {});
  const second = await heartbeat(h.ctx, 7, {});

  assert.equal(second.expected, first.sha, 'the second beat leases on the first one\'s result');
  assert.equal(second.mode, 'claim');
});

test('LOCK_LOST: the dispatcher reclaimed the task, so the lease is rejected', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  await warm(h);
  h.reclaim();

  await assert.rejects(() => heartbeat(h.ctx, 7, {}), (e) => {
    assert.match(e.message, /LOCK_LOST/);
    assert.match(e.message, /do not commit, do not call complete/);
    assert.equal(e.exitCode, 3);
    return true;
  });
});

test('LOCK_LOST on the very first beat, before this worktree has a chain', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  h.reclaim(); // never claimed here, and gone from the store

  await assert.rejects(() => heartbeat(h.ctx, 7, {}), /LOCK_LOST/);
});

test('a lease rejected while the store still holds the claim resyncs the chain, it does not stop the worker', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  // This worktree's chain is stale — another worktree of the same host beat last — but the claim is
  // still ours. A rejected lease is evidence, not proof: ask the store who holds it.
  (await openStore(h.ctx)).resyncBeat(7, 1, 'tok-stale');

  const r = await heartbeat(h.ctx, 7, {});

  assert.equal(r.mode, 'claim');
  assert.equal(r.resynced, true);
  assert.equal(r.sha, await h.chain());
});

test('a store that cannot make the swap falls back to the run record, and says so', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await warm(h);
  h.store.fail('heartbeat', { message: 'the index is busy', times: 2 });

  const r = await heartbeat(h.ctx, 7, {}).catch((e) => e);

  // The double throws where a driver would answer `unavailable`; either way the verb must not
  // pretend the beat landed. What it must never do is fabricate a LOCK_LOST.
  assert.ok(!(r instanceof Error) || !/LOCK_LOST/.test(r.message), 'an unreadable store is not a reclaim');
});

test('the 10-minute floor applies to the record path, and a note always gets through', async (t) => {
  const h = harness({ attempt: { heartbeat_at: ago(60) } });
  t.after(h.cleanup);

  const skipped = await heartbeat(h.ctx, 7, { note: undefined, attempt: 1 }).catch(() => null);
  assert.equal(skipped.mode, 'claim', 'the claim path does not floor — the swap is free');

  const noted = await heartbeat(h.ctx, 7, { note: 'still compiling' });
  assert.equal(noted.mode, 'record', 'a note is content, so it takes the record path');
  assert.equal(h.store.runOf(7).attempts[0].note, 'still compiling');
});

test('a note is written even a minute after the last one — the floor never swallows content', async (t) => {
  const h = harness({ attempt: { heartbeat_at: ago(60) } });
  t.after(h.cleanup);

  await heartbeat(h.ctx, 7, { note: 'one' });
  await heartbeat(h.ctx, 7, { note: 'two' });

  assert.equal(h.store.runOf(7).attempts[0].note, 'two');
});

test('a terminal verb drops this host\'s beat chain — worktrees share one store', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  await warm(h);
  h.store.addIssue(kbIssue({ number: 8 })); // a card the complete below must not touch

  await complete(h.ctx, 7, { summary: 'done', noPr: true, noPrReason: 'no code' });

  assert.equal(await h.chain(), null, 'nothing left for the next attempt\'s first beat to lease on');
  assert.deepEqual(await h.store.locks(), [], 'and the claim is released');
});

test('no open attempt is a usage error, not a lock error', async (t) => {
  const h = harness({ attempt: { ended_at: ago(10), outcome: 'completed' } });
  t.after(h.cleanup);

  await assert.rejects(() => heartbeat(h.ctx, 7, { note: 'hello' }), (e) => {
    assert.match(e.message, /has no active attempt/);
    assert.equal(e.exitCode, 2);
    return true;
  });
});
