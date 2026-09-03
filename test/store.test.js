// The store conformance suite.
//
// One array of scenarios, run against every driver in `DRIVERS`. Today the list holds the GitHub
// driver backed by `test/fake-gh.js`; the `kb-board` branch tier and the `.git/hkb/index.db` index
// (docs/local-first.md §6) append theirs, and a driver is "done" when this file is green for it.
//
// A scenario may only touch the §6.4 interface (`src/store/index.js`, `STORE_METHODS`). Anything a
// scenario needs that the interface does not offer — making a claim visible to whatever mechanism
// the driver's heartbeat leases on, simulating an out-of-band reclaim, recording a beat somebody
// else made — is asked of the *harness* through the three optional hooks below, never of the store.
// That is the line that keeps a scenario portable: if a scenario reaches for a driver's internals,
// the next driver cannot run it.
//
//   open()                  → { store, cleanup, settleClaim?, reclaim?, recordBeat? }
//   settleClaim(n, k, tok)  make the claim real for the heartbeat's own transport (GitHub: push the
//                           lock ref to the real `origin`; a local driver: nothing, the claim *is* real)
//   reclaim(n, k)           what a dispatcher reclaim looks like (default: store.release)
//   recordBeat(n, k, at)    a beat landed at `at`, as `lockBeatAt` would read it back
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, STORE_METHODS } from '../src/store/index.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { L, emptyRun, serializeResultComment, RESULT_MARKER } from '../src/model.js';
import { FakeGh, kbIssue } from './fake-gh.js';

// ---------- the GitHub driver ----------

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * The GitHub store over the in-memory GitHub, in a real checkout with a real `origin`.
 *
 * The checkout is not decoration: the GitHub driver's `heartbeat` is a `--force-with-lease` push,
 * and only git can say whether a lease really held. So the fake's base sha *is* this repo's HEAD,
 * and `settleClaim` pushes the lock ref the claim created into the real remote — which is exactly
 * what the dispatcher's claim does today (`POST git/refs` at the default branch head).
 */
function openGithubDriver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-store-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  const base = git(root, 'rev-parse', 'HEAD');

  const gh = new FakeGh({ baseSha: base });
  // deep, as src/init.js does: a shallow spread shares `dispatch` and `profiles` with every other
  // harness in the process, so one scenario mutating a nested key corrupts the rest.
  const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_BOARD)), repo: gh.nameWithOwner };
  const ctx = {
    root, cfg,
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {},
    requireBoard() { return this; },
  };
  const restore = gh.install();
  const ref = (n, k) => `refs/kb/locks/${n}/${k}`;
  return {
    store: openStore(ctx),
    gh,
    settleClaim: (n, k, token) => { git(root, 'push', '-q', 'origin', `${token}:${ref(n, k)}`); },
    reclaim: async (store, n, k) => {
      await store.release(n, k);
      git(root, 'push', '-q', 'origin', '--delete', ref(n, k));
    },
    recordBeat: (n, k, at) => gh.beat(n, k, at),
    cleanup: () => { restore(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const DRIVERS = [
  { name: 'github', open: openGithubDriver },
];

// ---------- the scenarios ----------


/** A card on the board, made through the interface. */
async function card(h, { title = 'a card', status = 'ready', agent = 'claude', kb = {}, body = '' } = {}) {
  return h.store.createTask({ title, body, kb, status, agent });
}

const SCENARIOS = [
  {
    name: 'the driver has every method of the §6.4 interface',
    async run(h) {
      for (const m of STORE_METHODS) assert.equal(typeof h.store[m], 'function', `missing ${m}()`);
      const caps = h.store.capabilities();
      assert.equal(typeof caps.events, 'boolean', 'capabilities().events must be a boolean');
    },
  },
  {
    name: 'board() names the slug and carries the settings',
    async run(h) {
      const b = h.store.board();
      assert.equal(b.slug, 'default');
      assert.ok(b.settings, 'settings are part of board()');
      assert.ok('paused_at' in b && 'paused_by' in b && 'host' in b);
    },
  },
  {
    name: 'create: a new card comes back with the status, agent and kb it was made with',
    async run(h) {
      const t = await card(h, { title: 'ship it', status: 'ready', agent: 'claude', kb: { priority: 2 }, body: 'the why' });
      assert.equal(t.title, 'ship it');
      assert.equal(t.status, 'ready');
      assert.equal(t.agent, 'claude');
      assert.equal(t.kb.priority, 2);
      assert.match(t.body, /the why/);
      // and the same card reads back the same way
      const again = await h.store.getTask(t.number);
      assert.deepEqual([again.number, again.status, again.agent], [t.number, 'ready', 'claude']);
    },
  },
  {
    name: 'list: every open card, in the shape src/model.js reads',
    async run(h) {
      const a = await card(h, { title: 'one', status: 'ready' });
      const b = await card(h, { title: 'two', status: 'todo' });
      const tasks = await h.store.listTasks({ states: ['OPEN'] });
      const numbers = tasks.map((t) => t.number).sort((x, y) => x - y);
      assert.deepEqual(numbers, [a.number, b.number].sort((x, y) => x - y));
      for (const key of ['number', 'kb', 'status', 'agent', 'needsHuman', 'blockedBy', 'prs', 'state', 'createdAt', 'updatedAt', 'url']) {
        assert.ok(key in tasks[0], `a listed task is missing ${key}`);
      }
      assert.ok(Array.isArray(tasks[0].blockedBy) && Array.isArray(tasks[0].prs));
    },
  },
  {
    name: 'status: setStatus moves the card and the next read agrees',
    async run(h) {
      const t = await card(h, { status: 'ready' });
      await h.store.setStatus(t, 'running');
      assert.equal(t.status, 'running', 'the passed task is updated in place');
      assert.equal((await h.store.getTask(t.number)).status, 'running');
      // add/remove ride along with the move
      await h.store.setStatus(t, 'blocked', { add: [L.needsHuman] });
      const read = await h.store.getTask(t.number);
      assert.equal(read.status, 'blocked');
      assert.equal(read.needsHuman, true);
      await h.store.removeLabel(t, L.needsHuman);
      assert.equal((await h.store.getTask(t.number)).needsHuman, false);
    },
  },
  {
    name: 'agent: setAgent leaves exactly one profile on the card',
    async run(h) {
      const t = await card(h, { agent: 'claude' });
      await h.store.setAgent(t, 'codex');
      assert.equal((await h.store.getTask(t.number)).agent, 'codex');
    },
  },
  {
    name: 'blockers: addBlockedBy links, removeBlockedBy unlinks',
    async run(h) {
      const parent = await card(h, { title: 'first' });
      const child = await card(h, { title: 'second' });
      await h.store.addBlockedBy(child.number, parent.number);
      const linked = await h.store.getTask(child.number);
      assert.deepEqual(linked.blockedBy.map((b) => b.number), [parent.number]);
      await h.store.removeBlockedBy(child.number, parent.number);
      assert.deepEqual((await h.store.getTask(child.number)).blockedBy, []);
    },
  },
  {
    name: 'run record: loadRun on an untouched card is empty, and a save round-trips',
    async run(h) {
      const t = await card(h);
      const first = await h.store.loadRun(t.number);
      assert.deepEqual(first.run, emptyRun());
      first.run.attempts.push({ attempt: 1, host: 'test-host', started_at: '2026-09-02T10:00:00Z', outcome: null });
      first.run.failures = 1;
      await h.store.saveRun(t.number, first);
      const back = await h.store.loadRun(t.number);
      assert.equal(back.run.attempts.length, 1);
      assert.equal(back.run.attempts[0].host, 'test-host');
      assert.equal(back.run.failures, 1);
      // a second save updates the record it created — never a second one
      back.run.attempts[0].outcome = 'done';
      await h.store.saveRun(t.number, back);
      const third = await h.store.loadRun(t.number);
      assert.equal(third.run.attempts.length, 1);
      assert.equal(third.run.attempts[0].outcome, 'done');
    },
  },
  {
    name: 'notes: addNote is readable through listNotes, and results through latestResult',
    async run(h) {
      const t = await card(h);
      assert.deepEqual(await h.store.listNotes(t.number), []);
      await h.store.addNote(t.number, 'a human said this');
      const notes = await h.store.listNotes(t.number);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'a human said this');
      assert.ok(notes[0].at, 'a note carries when it was written');
      assert.equal(await h.store.latestResult(t.number), null, 'a note is not a result');
      await h.store.addNote(t.number, serializeResultComment({ attempt: 1, summary: 'landed', metadata: { ok: true } }));
      const r = await h.store.latestResult(t.number);
      assert.equal(r.summary, 'landed');
      assert.deepEqual(r.metadata, { ok: true });
    },
  },
  {
    name: 'parentResults: one row per blocker, carrying its latest result',
    async run(h) {
      const parent = await card(h, { title: 'the parent' });
      const child = await card(h, { title: 'the child' });
      await h.store.addNote(parent.number, serializeResultComment({ attempt: 1, summary: 'parent done', metadata: {} }));
      await h.store.addBlockedBy(child.number, parent.number);
      const linked = await h.store.getTask(child.number);
      const rows = await h.store.parentResults(linked);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].number, parent.number);
      assert.equal(rows[0].result.summary, 'parent done');
    },
  },
  {
    name: 'closed-recent: a closed card leaves the open list and joins the closed one; reopen puts it back',
    async run(h) {
      const t = await card(h, { status: 'done' });
      await h.store.closeTask(t.number, 'completed');
      const open = await h.store.listTasks({ states: ['OPEN'] });
      assert.ok(!open.some((x) => x.number === t.number), 'a closed card is not open');
      const closed = await h.store.listClosedRecent();
      assert.ok(closed.some((x) => x.number === t.number), 'and it is in listClosedRecent');
      assert.ok((await h.store.listTasks({ states: ['OPEN', 'CLOSED'] })).some((x) => x.number === t.number));
      await h.store.reopenTask(t.number);
      assert.ok((await h.store.listTasks({ states: ['OPEN'] })).some((x) => x.number === t.number));
    },
  },
  {
    name: 'updateBody rewrites the prose and keeps every machine field',
    async run(h) {
      const kb = { priority: 5, paths: ['src/x.js'], max_runtime: 4242 };
      const t = await card(h, { body: 'before', kb });
      await h.store.updateBody(t.number, 'after');
      const read = await h.store.getTask(t.number);
      assert.match(read.bodyText ?? read.body, /after/);
      assert.doesNotMatch(read.bodyText ?? read.body, /before/);
      // the whole point: a body rewrite that drops the kb block silently resets priority, paths and
      // every other dispatch field to the defaults on the next read.
      assert.equal(read.kb.priority, 5);
      assert.deepEqual(read.kb.paths, ['src/x.js']);
      assert.equal(read.kb.max_runtime, 4242);
    },
  },
  {
    name: 'claim: the first wins with a token, the second is held, and a release frees it again',
    async run(h) {
      const n = (await card(h)).number;
      const first = await h.store.claim(n, 1);
      assert.equal(first.result, 'claimed');
      assert.ok(first.token, 'a claim hands back the token its heartbeat leases on');
      const second = await h.store.claim(n, 1);
      assert.equal(second.result, 'held');
      assert.equal(await h.store.release(n, 1), true);
      assert.equal((await h.store.claim(n, 1)).result, 'claimed', 'a released claim can be taken again');
      await h.store.release(n, 1);
      assert.equal(await h.store.release(n, 1), false, 'releasing twice is not an error, and says nothing was there');
    },
  },
  {
    name: 'listLocks reports every live claim, and nothing after they are released',
    async run(h) {
      const n = (await card(h)).number;
      const m = (await card(h)).number;
      const a = await h.store.claim(n, 1);
      const b = await h.store.claim(m, 2);
      const rows = await h.store.listLocks();
      const seen = rows.map((r) => `${r.n}/${r.k}`).sort();
      assert.deepEqual(seen, [`${n}/1`, `${m}/2`].sort());
      for (const r of rows) assert.ok('token' in r && 'beat_at' in r, 'a lock row carries its token and last beat');
      assert.ok(a.token && b.token);
      await h.store.release(n, 1);
      await h.store.release(m, 2);
      assert.deepEqual(await h.store.listLocks(), []);
    },
  },
  {
    name: 'lockBeatAt is null until a beat lands, then it is when the beat landed',
    async run(h) {
      const n = (await card(h)).number;
      await h.store.claim(n, 1);
      assert.equal(await h.store.lockBeatAt(n, 1), null, 'a fresh claim has no beat behind it');
      const at = '2026-09-02T12:34:56.000Z';
      h.recordBeat(n, 1, at);
      assert.equal(new Date(await h.store.lockBeatAt(n, 1)).toISOString(), at);
      await h.store.release(n, 1);
    },
  },
  {
    name: 'heartbeat: ok while the claim is ours, lost once it has been reclaimed',
    async run(h) {
      const n = (await card(h)).number;
      const { result, token } = await h.store.claim(n, 1);
      assert.equal(result, 'claimed');
      h.settleClaim(n, 1, token);
      const first = await h.store.heartbeat(n, 1, token);
      assert.equal(first.result, 'ok');
      assert.ok(first.token, 'a beat hands back where it left the lease');
      // the second beat is the one that matters: leasing on the FIRST beat's expected sha is what a
      // worker does every ten minutes, and returning only the verdict made it read as LOCK_LOST.
      const second = await h.store.heartbeat(n, 1, first.token);
      assert.equal(second.result, 'ok', 'a worker beats for as long as it holds the claim');
      await h.reclaim(h.store, n, 1);
      assert.equal((await h.store.heartbeat(n, 1, second.token)).result, 'lost', 'a reclaimed lock stops the worker');
    },
  },
  {
    name: 'listTasks: OPEN, CLOSED and both mean three different answers',
    async run(h) {
      const open = await card(h);
      const closed = await card(h);
      await h.store.closeTask(closed.number, 'completed');

      const justOpen = (await h.store.listTasks({ states: ['OPEN'] })).map((t) => t.number);
      assert.ok(justOpen.includes(open.number));
      assert.ok(!justOpen.includes(closed.number));

      const justClosed = (await h.store.listTasks({ states: ['CLOSED'] })).map((t) => t.number);
      assert.ok(justClosed.includes(closed.number));
      assert.ok(!justClosed.includes(open.number), 'asking for closed cards must not hand back the open board');

      const both = (await h.store.listTasks({ states: ['OPEN', 'CLOSED'] })).map((t) => t.number);
      assert.ok(both.includes(open.number) && both.includes(closed.number));

      await assert.rejects(async () => h.store.listTasks({ states: ['MAYBE'] }), (e) => e.exitCode === 2);
    },
  },
  {
    name: 'listNotes returns what a person wrote, never hkb\'s own records',
    async run(h) {
      const t = await card(h);
      await h.store.saveRun(t.number, { run: { ...emptyRun(), attempts: [{ attempt: 1, profile: 'claude', host: 'h', started_at: new Date().toISOString() }] }, id: null });
      await h.store.addNote(t.number, 'a human said this');

      // A person *quoting* a marker is still a person. Filtering on `includes` made this note
      // disappear from the board with nothing to say it had — and the two drivers disagreed about
      // it unseen, because the suite never asked.
      const quoting = `the ${RESULT_MARKER} block was empty, so I am writing it out here`;
      await h.store.addNote(t.number, quoting);

      const notes = await h.store.listNotes(t.number);
      assert.deepEqual(notes.map((n) => n.text), ['a human said this', quoting]);
    },
  },
  {
    name: 'events: every mutating call appends one — or capabilities() says there is no log',
    async run(h) {
      if (!h.store.capabilities().events) {
        // A driver with no log must refuse, not answer an empty list: "nothing happened" and "I
        // cannot tell you what happened" are different answers, and `hkb serve` picks its feed on
        // the difference.
        await assert.rejects(async () => h.store.events({ after: 0 }), (e) => e.exitCode === 2 && /event log/i.test(e.message));
        return;
      }
      const before = await h.store.events({ after: 0, limit: 1000 });
      const t = await card(h);
      await h.store.setStatus(t, 'running');
      await h.store.addNote(t.number, 'hello');
      const after = await h.store.events({ after: 0, limit: 1000 });
      assert.ok(after.length >= before.length + 3, 'create, setStatus and addNote each append an event');
      for (const e of after.slice(before.length)) {
        for (const key of ['id', 'at', 'kind', 'number', 'payload']) assert.ok(key in e, `an event is missing ${key}`);
      }
      const ids = after.map((e) => e.id);
      assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'events come back in id order');
      const tail = await h.store.events({ after: ids[ids.length - 2], limit: 1000 });
      assert.deepEqual(tail.map((e) => e.id), ids.slice(-1), '`after` is exclusive');
    },
  },
];

// ---------- the run ----------

for (const driver of DRIVERS) {
  for (const scenario of SCENARIOS) {
    test(`store[${driver.name}]: ${scenario.name}`, async (t) => {
      const h = driver.open();
      h.reclaim = h.reclaim || ((store, n, k) => store.release(n, k));
      h.settleClaim = h.settleClaim || (() => {});
      h.recordBeat = h.recordBeat || (() => {});
      t.after(h.cleanup);
      await scenario.run(h);
    });
  }
}

// One assertion that is *about* the GitHub driver rather than about the interface: the seam moved
// the bodies, it did not rewrite them, so a card seeded the old way still reads the old way.
test('store[github]: a card seeded as an issue reads back through the interface', async (t) => {
  const h = openGithubDriver();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 42, title: 'seeded', status: 'review', agent: 'claude', kb: { priority: 1 } }));
  const task = await h.store.getTask(42);
  assert.deepEqual(
    [task.number, task.title, task.status, task.agent, task.kb.priority],
    [42, 'seeded', 'review', 'claude', 1],
  );
});
