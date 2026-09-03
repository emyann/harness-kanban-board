// The verbs, against every store — the portability half of the store double.
//
// `test/dispatch.test.js`, `test/track.test.js` and the rest now assert on board *behaviour* through
// the `Store` interface (`test/fake-store.js`) rather than on the in-memory GitHub's REST log. That
// makes the assertions portable, and this file is what proves it rather than asserting it: the
// scenarios below are the ones those files rewrote — a promote, a claim and its run record, a
// reclaim, a release, "a dry run writes nothing" — and they run unchanged against
//
//   · the in-memory double (`test/fake-store.js`), and
//   · the **real** local driver (`src/store/local.js`: the `kb-board` branch and the
//     `.git/hkb/index.db` index) in a scratch repository.
//
// One temp repo per scenario, which is what keeps this readable; the whole file is a couple of
// seconds. What it buys: the day `src/store/github.js` is deleted (docs/local-first.md §10, track C)
// these sentences about the dispatcher are already known to be true of a store that is not GitHub.
//
// Not here: anything a *forge* answers. A pull request is `src/forge.js` on every board, and
// `test/merge.test.js` is where that lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tick } from '../src/dispatch.js';
import { complete } from '../src/lifecycle.js';
import { openStore, closeStore } from '../src/store/index.js';
import { openGitTier } from '../src/store/git.js';
import { DEFAULT_BOARD, hostId } from '../src/board.js';
import { locksOf, FakeStore, runWith } from './fake-store.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const PROFILES = { claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } };

/** A tick's context, wherever the board is kept. */
function context(root, { store = null, host = 'test-host', dispatch = {} } = {}) {
  const cfg = {
    ...JSON.parse(JSON.stringify(DEFAULT_BOARD)),
    repo: 'acme/board',
    dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch },
    profiles: PROFILES,
    ...(store ? { store } : {}),
  };
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify(cfg));
  return {
    root, cfg,
    repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
    board: 'default', host, json: false, caps: {}, _cache: {},
    requireBoard() { return this; },
  };
}

// ---------- the drivers ----------

/** The in-memory double, on a plain temp directory. */
async function openFake({ dispatch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-portable-fake-'));
  const ctx = context(root, { dispatch });
  const double = new FakeStore({ board: 'default', host: 'test-host' });
  const restore = double.install(ctx);
  return { ctx, root, store: await openStore(ctx), cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/**
 * `src/store/local.js` for real, in a scratch repository. `hostId()` is the host on purpose: the
 * `kb-board` branch has one writer (§6.2) and `assertOwningHost` refuses every write verb otherwise,
 * so a scenario run under a made-up host would fail for a reason that is not what it is testing.
 */
async function openLocal({ dispatch = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-portable-local-'));
  const root = path.join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'main', root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  const ctx = context(root, { store: 'local', host: hostId(), dispatch });
  openGitTier(ctx).init('default');
  return { ctx, root, store: await openStore(ctx), cleanup: () => { closeStore(ctx); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const DRIVERS = [{ name: 'fake', open: openFake }, { name: 'local', open: openLocal }];

// ---------- the fixtures, through the interface ----------

/** A card, made the way `hkb create` makes one. */
async function card(h, { title = 'a card', status = 'ready', agent = 'claude', kb = {}, body = '' } = {}) {
  return h.store.createTask({ title, body, kb, status, agent });
}

/** The card's run record as the board has it now. */
const runOf = async (h, n) => (await h.store.loadRun(n)).run;
/** The card's status as the board has it now. */
const statusOf = async (h, n) => (await h.store.getTask(n)).status;

/**
 * A running attempt somebody else owns, claimed and beating — the fixture behind every reclaim
 * scenario. Written through the interface only: `claim` makes the row and `saveRun` the record.
 */
async function running(h, n, { attempt = 1, host = 'other-host', startedAgo = 600, beatAgo = 600, extra = {} } = {}) {
  const t = await h.store.getTask(n);
  await h.store.setStatus(t, 'running');
  const { token } = await h.store.claim(n, attempt);
  const rec = await h.store.loadRun(n);
  rec.run = runWith([{ attempt, host, started_at: ago(startedAgo), heartbeat_at: ago(beatAgo), lock_sha: token, ...extra }]);
  await h.store.saveRun(n, rec);
  return token;
}

// ---------- the scenarios ----------

const SCENARIOS = [
  {
    // test/dispatch.test.js: 'todo → ready only when every blocker closed as completed'
    name: 'promote: a card whose blockers are all done goes ready, and one that is not stays put',
    async run(h) {
      const shipped = await card(h, { title: 'shipped', status: 'done' });
      await h.store.closeTask(shipped.number, 'completed');
      const dropped = await card(h, { title: 'dropped', status: 'archived' });
      await h.store.closeTask(dropped.number, 'not_planned');
      const ready = await card(h, { status: 'todo' });
      const waiting = await card(h, { status: 'todo' });
      await h.store.addBlockedBy(ready.number, shipped.number);
      await h.store.addBlockedBy(waiting.number, dropped.number);

      const s = await tick(h.ctx, { log: h.log, max: 0 }); // no slot: promotion never depends on capacity

      assert.deepEqual(s.promoted, [ready.number]);
      assert.equal(await statusOf(h, ready.number), 'ready');
      assert.equal(await statusOf(h, waiting.number), 'todo', 'NOT_PLANNED is not "done"');
    },
  },
  {
    // test/dispatch.test.js: 'a ready task is claimed once: ref, run comment, running label, worker spawned'
    name: 'claim: one live claim, one open attempt, and the card is running',
    async run(h) {
      const t = await card(h);

      const s = await tick(h.ctx, { log: h.log });

      assert.deepEqual(s.claimed.map((c) => [c.number, c.attempt]), [[t.number, 1]]);
      assert.equal(await statusOf(h, t.number), 'running');
      assert.deepEqual(await locksOf(h.store), [`${t.number}/1`]);
      const run = await runOf(h, t.number);
      assert.equal(run.attempts.length, 1);
      assert.equal(run.attempts[0].host, 'test-host' === h.ctx.host ? 'test-host' : h.ctx.host);
      assert.equal(run.attempts[0].profile, 'claude');
      assert.equal(run.attempts[0].ended_at, undefined, 'the attempt is open');
      // The row leases on what the store's own claim handed back, never on a value the dispatcher
      // invented — and it is a sha on GitHub, a row token on a store with a table.
      assert.equal(run.attempts[0].lock_sha, await h.store.lockToken(t.number, 1));
    },
  },
  {
    // test/dispatch.test.js: the live-worker lane — a claimed, beating attempt is nobody else's
    name: 'a live attempt is left where it is: not reclaimed, not re-claimed, not re-recorded',
    dispatch: { stale_after: 3600 },
    async run(h) {
      const t = await card(h, { kb: { max_runtime: 86_400 } });
      // this host, a pid that is alive (our own), a beat seconds ago: every liveness test passes
      await running(h, t.number, { host: h.ctx.host, startedAgo: 120, beatAgo: 5, extra: { pid: process.pid } });
      const before = JSON.stringify(await runOf(h, t.number));

      const s = await tick(h.ctx, { log: h.log });

      assert.deepEqual(s.reclaimed, []);
      assert.deepEqual(s.claimed, [], 'a running card is not a card to claim');
      assert.equal(await statusOf(h, t.number), 'running');
      assert.deepEqual(await locksOf(h.store), [`${t.number}/1`], 'the claim it beats on survives');
      assert.equal(JSON.stringify(await runOf(h, t.number)), before, 'and its run record is not rewritten');
    },
  },
  {
    // test/dispatch.test.js: 'a stale heartbeat is reclaimed: lock released, attempt closed, back to ready'
    name: 'reclaim: a stale attempt loses its claim, closes its row and goes back to ready',
    dispatch: { stale_after: 60 },
    async run(h) {
      const t = await card(h, { kb: { max_runtime: 86_400 } });
      await running(h, t.number, { extra: { pid: 4_000_000 } });

      const s = await tick(h.ctx, { log: h.log, max: 0 });

      assert.deepEqual(s.reclaimed, [{ number: t.number, outcome: 'reclaimed' }]);
      assert.equal(await statusOf(h, t.number), 'ready');
      assert.deepEqual(await locksOf(h.store), [], 'the claim is released');
      const saved = await runOf(h, t.number);
      assert.equal(saved.failures, 1);
      assert.equal(saved.attempts[0].outcome, 'reclaimed');
    },
  },
  {
    // test/dispatch.test.js: 'a ref-CAS beat keeps a worker alive: the run comment is stale, the lock is not'
    name: 'a worker whose last beat is fresh is left alone, claim and record both',
    dispatch: { stale_after: 60 },
    async run(h) {
      const t = await card(h, { kb: { max_runtime: 86_400 } });
      const token = await running(h, t.number, { startedAgo: 3600, beatAgo: 3600 });
      // A beat the store recorded, which is the only trace a CAS heartbeat leaves: the run record
      // stays as old as the claim.
      assert.equal((await h.store.heartbeat(t.number, 1, token)).result, 'ok');

      const s = await tick(h.ctx, { log: h.log, max: 0 });

      assert.deepEqual(s.reclaimed, []);
      assert.equal(await statusOf(h, t.number), 'running');
      assert.deepEqual(await locksOf(h.store), [`${t.number}/1`], 'the claim is left alone');
      assert.ok(Date.now() - new Date((await runOf(h, t.number)).attempts[0].heartbeat_at).getTime() > 600_000,
        'and the run record is not rewritten — the beat is not in it');
    },
  },
  {
    // test/dispatch.test.js: 'a dry run reports what it would do and writes nothing'
    name: 'a dry run reports what it would do and leaves the board exactly as it was',
    async run(h) {
      const blocker = await card(h, { title: 'shipped', status: 'done' });
      await h.store.closeTask(blocker.number, 'completed');
      const waiting = await card(h, { status: 'todo' });
      await h.store.addBlockedBy(waiting.number, blocker.number);
      const ready = await card(h);

      const s = await tick(h.ctx, { log: h.log, dryRun: true });

      assert.deepEqual(s.promoted, [waiting.number]);
      assert.deepEqual(s.claimed, [{ number: ready.number, attempt: 1, profile: 'claude', dry: true }]);
      assert.equal(await statusOf(h, waiting.number), 'todo');
      assert.equal(await statusOf(h, ready.number), 'ready');
      assert.deepEqual(await locksOf(h.store), []);
      assert.deepEqual((await runOf(h, ready.number)).attempts, []);
    },
  },
  {
    // test/dispatch.test.js / test/session.test.js: what a terminal verb leaves behind
    name: 'finish releases the claim, closes the attempt and moves the card on',
    async run(h) {
      const t = await card(h);
      await tick(h.ctx, { log: h.log });
      assert.deepEqual(await locksOf(h.store), [`${t.number}/1`], 'precondition: claimed');

      const done = await complete(h.ctx, t.number, { summary: 'the thing is done', noPr: true, attempt: 1 });

      // `--no-pr`: nothing is left to review, so the card lands on done rather than review.
      assert.equal(done.status, 'done');
      assert.deepEqual(await locksOf(h.store), [], 'the claim is released by the terminal verb');
      assert.equal(await statusOf(h, t.number), 'done');
      const last = (await runOf(h, t.number)).attempts.at(-1);
      assert.equal(last.outcome, 'completed');
      assert.ok(last.ended_at, 'and the row is closed');
      // the summary reaches the board as a result, which is what the next worker's brief reads
      assert.match((await h.store.latestResult(t.number)).summary, /the thing is done/);
    },
  },
];

// ---------- the run ----------

for (const driver of DRIVERS) {
  for (const scenario of SCENARIOS) {
    test(`verbs[${driver.name}]: ${scenario.name}`, async (t) => {
      const h = await driver.open({ dispatch: scenario.dispatch || {} });
      const logs = [];
      h.log = (m) => logs.push(m);
      h.logs = logs;
      t.after(h.cleanup);
      await scenario.run(h);
    });
  }
}
