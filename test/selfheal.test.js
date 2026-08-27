// A long-lived dispatcher must not back off for ever. Two halves, both against the in-memory
// GitHub (test/fake-gh.js) or a hand-rolled transport — no `gh`, no network, no worker:
//   1. the base sha is re-resolved every tick, conditionally, so a stale one cannot outlive a tick
//   2. a claim that keeps answering `unknown` drops this process's caches, then removes the process
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loop, tick, noteClaimResult, dropCaches, SELF_HEAL } from '../src/dispatch.js';
import { baseSha, staleBaseSha } from '../src/lock.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { GhError, setTransport } from '../src/gh.js';
import { FakeGh, kbIssue } from './fake-gh.js';

function harness({ dispatch = {}, board = 'default', host = 'test-host' } = {}) {
  const gh = new FakeGh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-selfheal-'));
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    board,
    // The loop's once-a-day version notice asks npm. Nothing in this suite reaches the network:
    // that path has its own tests, with the registry stubbed (test/update.test.js).
    version_check: false,
    dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch },
    profiles: { claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root,
    cfg,
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board,
    host,
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  };
  const restore = gh.install();
  const logs = [];
  return {
    gh,
    ctx,
    root,
    logs,
    log: () => logs.join('\n'),
    push: (m) => logs.push(m),
    tick: (opts = {}) => tick(ctx, { log: (m) => logs.push(m), ...opts }),
    cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const stubCtx = () => ({ root: '/nowhere', cfg: { default_branch: 'main' }, repo: { owner: 'acme', repo: 'board' }, board: 'default', caps: {}, _cache: {} });
const response = (status, data, headers = {}) => ({ __response: true, status, headers, data });

// ---------- 1. the base sha is a per-tick read, not a process-lifetime cache ----------

test('the base sha is revalidated once per tick with If-None-Match, and a 304 keeps the cached sha', async (t) => {
  const ctx = stubCtx();
  const calls = [];
  let head = { sha: 'a'.repeat(40), etag: 'W/"one"' };
  const restore = setTransport((req) => {
    calls.push(req);
    if (req.method !== 'GET' || req.path !== 'repos/acme/board/git/ref/heads/main') throw new GhError(`unexpected ${req.method} ${req.path}`, { status: 501 });
    if (req.headers?.['If-None-Match'] === head.etag) return response(304, null, { etag: head.etag });
    return response(200, { ref: 'refs/heads/main', object: { sha: head.sha } }, { etag: head.etag });
  });
  t.after(restore);

  assert.equal(await baseSha(ctx), 'a'.repeat(40));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers?.['If-None-Match'], undefined, 'nothing cached yet: an unconditional read');

  assert.equal(await baseSha(ctx), 'a'.repeat(40));
  assert.equal(calls.length, 1, 'within the tick the sha is memoized — one claim per task must not cost one read each');

  staleBaseSha(ctx); // what the top of every tick does
  assert.equal(await baseSha(ctx), 'a'.repeat(40));
  assert.equal(calls.length, 2, 'a new tick re-reads');
  assert.equal(calls[1].headers['If-None-Match'], 'W/"one"', 'conditionally: a quiet repo answers 304 and costs no rate limit');

  head = { sha: 'b'.repeat(40), etag: 'W/"two"' }; // someone merged
  staleBaseSha(ctx);
  assert.equal(await baseSha(ctx), 'b'.repeat(40), 'the moved branch is picked up on the next tick, never later');
  staleBaseSha(ctx);
  await baseSha(ctx);
  assert.equal(calls[3].headers['If-None-Match'], 'W/"two"', 'and the new etag is what the next read leases on');
});

test('a branch the API does not know falls back to the repo default, prefix matches included', async (t) => {
  const seen = [];
  const restore = setTransport((req) => {
    seen.push(req.path);
    if (req.path === 'repos/acme/board') return { default_branch: 'trunk' };
    if (req.path === 'repos/acme/board/git/ref/heads/trunk') return response(200, { object: { sha: 'c'.repeat(40) } });
    // GitHub answers a miss with a 404, or with an array of every ref sharing the prefix
    if (req.path === 'repos/acme/board/git/ref/heads/main') throw new GhError('Not Found', { status: 404, kind: 'notfound' });
    if (req.path === 'repos/acme/board/git/ref/heads/dev') return response(200, [{ ref: 'refs/heads/dev-2', object: { sha: 'd'.repeat(40) } }]);
    throw new GhError(`unexpected ${req.path}`, { status: 501 });
  });
  t.after(restore);

  assert.equal(await baseSha(stubCtx()), 'c'.repeat(40));
  const dev = stubCtx();
  dev.cfg.default_branch = 'dev';
  assert.equal(await baseSha(dev), 'c'.repeat(40), 'an array is a miss, not a sha to claim at');
  assert.ok(seen.includes('repos/acme/board'), 'the repo read is what names the real default branch');
});

test('every tick claims at the sha the branch has now', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 2, status: 'ready', agent: 'claude' }));

  await h.tick({ max: 1 });
  assert.equal(h.gh.refs.get('refs/kb/locks/1/1'), 'f'.repeat(40));

  h.gh.refs.set('refs/heads/main', '9'.repeat(40)); // a PR merged while the loop was up
  await h.tick({ max: 1 });

  assert.equal(h.gh.refs.get('refs/kb/locks/2/1'), '9'.repeat(40), 'the sha of the first tick must not outlive it');
});

// ---------- 2. the self-heal ladder ----------

test('noteClaimResult: consecutive unknowns escalate, anything else resets, upstream is excused', () => {
  const health = new Map();
  const unknown = (kind, message = 'boom') => ({ result: 'unknown', error: { kind, message } });

  assert.equal(noteClaimResult(health, 7, unknown('notfound')).action, 'none');
  assert.equal(noteClaimResult(health, 7, unknown('notfound')).streak, 2);
  const dropped = noteClaimResult(health, 7, unknown('notfound', '404 on git/refs'));
  assert.equal(dropped.action, 'drop_caches');
  assert.equal(dropped.streak, SELF_HEAL.dropAfter);
  assert.match(dropped.error, /notfound: 404 on git\/refs/);
  assert.equal(noteClaimResult(health, 7, unknown('notfound')).action, 'none', 'the caches are dropped once, not every tick');
  assert.equal(noteClaimResult(health, 7, unknown('notfound')).action, 'none');
  assert.equal(noteClaimResult(health, 7, unknown('server')).action, 'exit', '3 more after the drop: the process is the problem');

  // another task is another ladder, and a claim that lands clears the one it was on
  assert.equal(noteClaimResult(health, 8, unknown('notfound')).streak, 1);
  assert.equal(noteClaimResult(health, 7, { result: 'claimed' }).streak, 0);
  assert.equal(noteClaimResult(health, 7, unknown('notfound')).streak, 1, 'recovery is a clean slate');
  assert.equal(noteClaimResult(health, 8, { result: 'held' }).action, 'none');
  assert.equal(health.has(8), false);

  // rate limits and an unreachable GitHub are upstream: waiting fixes them, a restart does not
  const up = new Map();
  for (let i = 0; i < 10; i++) assert.equal(noteClaimResult(up, 9, unknown('ratelimit')).action, 'none');
  for (let i = 0; i < 10; i++) assert.equal(noteClaimResult(up, 9, unknown('network')).action, 'none');
  assert.equal(up.has(9), false);
});

test('dropCaches forgets the base sha, its etag and the capability probe', () => {
  const ctx = stubCtx();
  ctx.caps = { blockedByGql: true };
  ctx._cache = { base: { branch: 'main', sha: 'a'.repeat(40), etag: 'W/"one"', fresh: true }, 'comments:5': [{ id: 1 }] };
  dropCaches(ctx);
  assert.deepEqual(ctx._cache, {});
  assert.deepEqual(ctx.caps, {});
});

test('a transient unknown claim recovers on the next tick, with no cache drop and no restart', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'ready', agent: 'claude' }));
  h.gh.fail({ method: 'POST', path: 'git/refs' }, { status: 404, message: 'Not Found', times: 1 });

  const first = await h.tick();
  assert.deepEqual(first.claimed, []);
  assert.deepEqual(first.self_heal, []);
  assert.equal(first.fatal, null);
  assert.equal(h.gh.statusOf(1), 'ready', 'an unknown claim never moves the card');
  assert.match(h.log(), /#1: claim result unknown \(notfound/);

  const second = await h.tick();

  assert.equal(second.claimed.length, 1, 'the tick after the upstream healed claims it — no bounce needed');
  assert.equal(h.gh.statusOf(1), 'running');
  assert.deepEqual(second.self_heal, []);
  assert.equal(h.ctx._health.has(1), false, 'and the streak is forgotten');
  assert.doesNotMatch(h.log(), /self-heal/);
});

test('a persistent unknown claim drops the caches at tick 3 and exits the loop at tick 6', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, title: 'wedged', status: 'ready', agent: 'claude' }));
  h.gh.fail({ method: 'POST', path: 'git/refs' }, { status: 404, message: 'Not Found', times: 99 });

  let waits = 0;
  const sleeper = async () => { if (++waits > 20) throw new Error('the loop never gave up'); };
  await assert.rejects(
    () => loop(h.ctx, { interval: 60, max: Infinity, log: h.push, sleeper }),
    (e) => {
      assert.equal(e.exitCode, 4, 'non-zero, so a supervisor restarts it');
      assert.match(e.message, /#1 claim came back unknown 6 ticks in a row/);
      assert.match(e.message, /Last error: notfound: POST .*git\/refs failed \(404\): Not Found/);
      return true;
    },
  );

  const log = h.log();
  assert.equal(h.gh.callsMatching('POST', 'git/refs').length, 6, 'it kept trying for six ticks, then stopped');
  assert.equal(waits, 5, 'and it did not sleep after the last one');
  assert.equal(log.split('self-heal: caches dropped').length - 1, 1, 'the caches are dropped once');
  assert.match(log, /#1: self-heal: caches dropped after 3 unknown claim results in a row \(notfound: /);
  assert.match(log, /#1: claim still unknown 6 ticks in, 3 of them after the cache drop/);
  assert.match(log, /FATAL dispatcher exiting: #1/);
  assert.equal(h.gh.statusOf(1), 'ready', 'the card is left exactly where the next dispatcher can pick it up');

  // the drop landed on tick 3, not before: the two ticks before it left the cache alone
  const order = h.logs.map((l) => (/^tick: /.test(l) ? 'tick' : /self-heal: caches dropped/.test(l) ? 'drop' : null)).filter(Boolean);
  assert.deepEqual(order, ['tick', 'tick', 'drop', 'tick', 'tick', 'tick', 'tick']);
});

test('a base sha that will not resolve is an unknown claim, not a tick that died on the way', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'ready', agent: 'claude' }));
  h.gh.fail({ method: 'GET', path: 'git/ref/heads/main' }, { status: 404, message: 'Not Found', times: 99 });

  const s = await h.tick(); // the reclaim, the promotion and the state write must all still happen
  assert.deepEqual(s.claimed, []);
  assert.equal(s.fatal, null);
  assert.match(h.log(), /#1: claim result unknown \(notfound/);
  assert.equal(h.ctx._health.get(1).streak, 1, 'and it counts on the same ladder');
  assert.equal(h.gh.statusOf(1), 'ready');
});

test('an unreachable GitHub never escalates: waiting is the fix, restarting is not', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'ready', agent: 'claude' }));
  h.gh.fail({ method: 'POST', path: 'git/refs' }, { status: 0, kind: 'network', message: 'dial tcp: no such host', times: 99 });

  for (let i = 0; i < 8; i++) {
    const s = await h.tick();
    assert.equal(s.fatal, null);
    assert.deepEqual(s.self_heal, []);
  }
  assert.doesNotMatch(h.log(), /self-heal/);
});
