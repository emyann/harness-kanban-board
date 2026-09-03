// The store conformance suite.
//
// One array of scenarios, run against every driver in `DRIVERS`: the local store (docs/local-first.md
// §6 — the `kb-board` branch and the `.git/hkb/index.db` index) and the in-memory double the rest of
// the suite asserts board behaviour through. A driver is "done" when this file is green for it, and
// that is what made retiring the GitHub one a deletion rather than a rewrite.
//
// A scenario may only touch the §6.4 interface (`src/store/index.js`, `STORE_METHODS`). Anything a
// scenario needs that the interface does not offer — making a claim visible to whatever mechanism
// the driver's heartbeat leases on, simulating an out-of-band reclaim, recording a beat somebody
// else made — is asked of the *harness* through the three optional hooks below, never of the store.
// That is the line that keeps a scenario portable: if a scenario reaches for a driver's internals,
// the next driver cannot run it.
//
//   open()                  → { store, cleanup, settleClaim?, reclaim?, recordBeat? }
//   settleClaim(n, k, tok)  make the claim real for the heartbeat's own transport (nothing on a
//                           store that keeps its claims in a table: the claim *is* real)
//   reclaim(n, k)           what a dispatcher reclaim looks like (default: store.release)
//   recordBeat(n, k, at)    a beat landed at `at`, as `lockBeatAt` would read it back
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, closeStore, STORE_METHODS } from '../src/store/index.js';
import { openGitTier } from '../src/store/git.js';
import { DEFAULT_BOARD, hostId } from '../src/board.js';
import { L, emptyRun, serializeResultComment, RESULT_MARKER, blockersOf, blockersKnown } from '../src/model.js';
import { FakeGh, kbIssue } from './fake-gh.js';
import { FakeStore } from './fake-store.js';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// ---------- the local driver ----------

/**
 * The composed local store (`src/store/local.js`) in a scratch repository: the `kb-board` branch for
 * the durable half and `.git/hkb/index.db` for the live one.
 *
 * `openStore(ctx)` is what builds it, from a `.kanban/board.json` that says `"store": "local"` —
 * the seam is what the suite is here to exercise, so nothing reaches for `openLocalStore` directly.
 * The board is created with the tier's own host, which is this machine's, so the store that opens it
 * is its owner: the one-writer refusal has tests of its own in `test/store-local.test.js`.
 */
async function openLocalDriver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-store-local-'));
  const root = path.join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'main', root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });

  const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_BOARD)), store: 'local' };
  const ctx = {
    root, cfg,
    repo: null,
    board: 'default', host: hostId(), json: false, caps: {}, _cache: {},
    requireBoard() { return this; },
  };
  openGitTier(ctx).init('default');
  const store = await openStore(ctx);
  return {
    store,
    // A beat somebody else recorded. The interface's own `heartbeat` rotates the token, and a
    // scenario that wants a beat *at a given instant* has nowhere else to put it.
    recordBeat: (n, k, at) => { store.index.db.prepare('UPDATE locks SET beat_at = ? WHERE task_id = ? AND k = ?').run(at, Number(n), Number(k)); },
    cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---------- the in-memory double ----------

/**
 * `test/fake-store.js`, run through the same scenarios as the two real drivers.
 *
 * It is a double, not a product driver — but the rest of the suite asserts *board behaviour*
 * through it ("the lock was released", "nothing was written"), and a double that answers a method
 * differently from the drivers turns every one of those assertions into a lie that passes. So it
 * conforms or it is not usable, and this is where that is decided.
 */
async function openFakeDriver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-store-fake-'));
  const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_BOARD)) };
  const ctx = {
    root: dir, cfg,
    repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {},
    requireBoard() { return this; },
  };
  const store = new FakeStore({ board: 'default', events: true });
  const restore = store.install(ctx);
  return {
    store: await openStore(ctx),
    recordBeat: (n, k, at) => store.beat(n, k, at),
    cleanup: () => { restore(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const DRIVERS = [
  { name: 'local', open: openLocalDriver },
  { name: 'fake', open: openFakeDriver },
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
      const wrote = await h.store.addNote(t.number, 'a human said this');
      // the note it wrote, in the note shape — `url` is where a person reads it, or null on a store
      // with no page for one. `hkb comment` and the MCP tool answer with that field.
      for (const key of ['id', 'at', 'actor', 'text', 'url']) assert.ok(key in wrote, `addNote's answer is missing ${key}`);
      assert.equal(wrote.text, 'a human said this');
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

      // And the body that OPENS with the marker but carries no readable block: a half-written
      // result is not a result — `latestResult` cannot return it, because there is nothing to
      // parse — so if it is not a note either it is visible in no reader at all. The two drivers
      // decided this differently until one predicate (`isResultComment`, src/model.js) answered for
      // both: one kept it as a note, the other dropped it out of every listing.
      const halfWritten = `${RESULT_MARKER}\n### Result — attempt 1\n\nno json block here`;
      await h.store.addNote(t.number, halfWritten);

      const notes = await h.store.listNotes(t.number);
      assert.deepEqual(notes.map((n) => n.text), ['a human said this', quoting, halfWritten]);
      assert.equal(await h.store.latestResult(t.number), null, 'and it is not a result either — one predicate, both answers agreeing');
    },
  },
  {
    name: 'setKb replaces the machine block and leaves the prose alone',
    async run(h) {
      const t = await card(h, { kb: { priority: 1, paths: ['src/a.js'] }, body: 'the why, in prose' });
      await h.store.setKb(t, { ...t.kb, priority: 3, goal: 'ship it' });
      assert.equal(t.kb.priority, 3, 'the passed task is updated in place, like setStatus');
      const read = await h.store.getTask(t.number);
      assert.equal(read.kb.priority, 3);
      assert.equal(read.kb.goal, 'ship it');
      assert.deepEqual(read.kb.paths, ['src/a.js'], 'a key the caller carried over survives');
      assert.match(read.bodyText, /the why, in prose/, 'and the prose is untouched');
      // and the mirror image still holds: updateBody replaces the prose and keeps the block
      await h.store.updateBody(t.number, 'rewritten prose');
      const after = await h.store.getTask(t.number);
      assert.match(after.bodyText, /rewritten prose/);
      assert.equal(after.kb.priority, 3, 'updateBody must not drop the kb block');
    },
  },
  {
    name: 'ensureLabels answers with what it had to create, and is safe to repeat',
    async run(h) {
      const name = 'kb:agent:conformance';
      const created = await h.store.ensureLabels([name]);
      assert.ok(Array.isArray(created), 'ensureLabels answers with a list of names');
      assert.deepEqual(await h.store.ensureLabels([name]), [], 'the second call creates nothing');
      // whatever it does or does not create, a label can be applied afterwards
      const t = await card(h);
      await h.store.addLabels(t, [name]);
      assert.ok((await h.store.getTask(t.number)).labels.includes(name));
    },
  },
  {
    name: 'the claim tokens: lockToken is the answer, beatToken is this host\'s copy, dropBeat forgets it',
    async run(h) {
      const n = (await card(h)).number;
      assert.equal(await h.store.lockToken(n, 1), null, 'no claim, no token');
      const { token } = await h.store.claim(n, 1);
      h.settleClaim(n, 1, token);
      assert.equal(await h.store.lockToken(n, 1), token, 'the claim is readable as the store has it');
      // `beatToken` never reaches the network and never throws: it is what the warm path of
      // `hkb heartbeat` leases on, and a worker that has not beaten yet gets null rather than an error.
      const local = h.store.beatToken(n, 1);
      assert.ok(local === null || typeof local === 'string');
      assert.equal(h.store.resyncBeat(n, 1, token), true, 'a resync onto the authoritative token succeeds');
      assert.equal(h.store.beatToken(n, 1), token, 'and that is what the next beat leases on');
      const beat = await h.store.heartbeat(n, 1, token);
      assert.equal(beat.result, 'ok');
      assert.equal(typeof beat.detail, 'string', 'a beat says why, so a fallback is never silent');
      h.store.dropBeat(n, 1);
      await h.store.release(n, 1);
      assert.equal(await h.store.lockToken(n, 1), null, 'a released claim has no token');
    },
  },
  {
    // The one that was aliased away. `beatToken` was `lockToken` on the local driver, so
    // `heartbeat`'s `WHERE token = ?` leased on the value it compared against and the compare-and-
    // swap could not fail — `hkb heartbeat`'s warm path could never report `lost`, and the only
    // reason a reclaim was ever noticed is that `release()` happens to delete the row.
    name: 'a beat leased on this host\'s stale copy is lost, even while the claim is still there',
    async run(h) {
      const n = (await card(h)).number;
      const { token } = await h.store.claim(n, 1);
      h.settleClaim(n, 1, token);
      h.store.resyncBeat(n, 1, token);
      const mine = h.store.beatToken(n, 1);
      assert.equal(mine, token, 'this host beats on the token it claimed with');

      // Somebody else beats: the claim is still held, but it has moved on from `mine`.
      const theirs = await h.store.heartbeat(n, 1, token);
      assert.equal(theirs.result, 'ok');
      assert.notEqual(theirs.token, mine, 'a beat rotates the token, which is what makes the CAS a CAS');
      h.store.resyncBeat(n, 1, theirs.token);

      const stale = await h.store.heartbeat(n, 1, mine);
      assert.equal(stale.result, 'lost', 'the stale lease is rejected while the claim itself is very much alive');
      assert.notEqual(await h.store.lockToken(n, 1), null, 'and the claim is still there — `lost` is about the lease, not the row');
    },
  },
  {
    name: 'lockRef names where a claim lives, or answers null on a store with no name for one',
    async run(h) {
      const n = (await card(h)).number;
      const where = h.store.lockRef(n, 1);
      assert.ok(where === null || typeof where === 'string', 'a string or null, never undefined');
      // `hkb heartbeat` and the LOCK_LOST error print this, and used to print `refs/kb/locks/<n>/<k>`
      // on every board. A store that keeps its claims in a table has no such name, and says so.
      const { token } = await h.store.claim(n, 1);
      h.settleClaim(n, 1, token);
      const listed = (await h.store.listLocks()).find((l) => l.n === n && l.k === 1);
      assert.equal(listed.ref ?? null, where, '`lockRef` is the `ref` the listing already carries');
      await h.store.release(n, 1);
    },
  },
  {
    // `taskEvents` was `events({limit: 5000})` filtered in JS — a forward cursor from id 0, so on a
    // board past the retention floor `hkb log` read the *oldest* page and answered `[]` for a card
    // whose whole history was newer than it.
    name: 'taskEvents answers with a card\'s newest history, not the log\'s oldest page',
    async run(h) {
      const noisy = await card(h, { title: 'the other card' });
      const t = await card(h, { title: 'the one we ask about' });
      await h.store.setStatus(t, 'running');
      // Bury it: a long run of events belonging to somebody else, ahead of the card in id order.
      for (let i = 0; i < 40; i++) await h.store.addNote(noisy.number, `noise ${i}`);
      const rows = await h.store.taskEvents(t.number);
      // Only a driver with a log of its own can be buried; the GitHub driver reads the issue
      // timeline, which is already per-card and cannot be crowded out by another card's rows.
      if (h.store.capabilities().events) assert.ok(rows.length, `#${t.number} has a history under 40 rows of somebody else's`);
      for (const e of rows) for (const key of ['at', 'kind', 'detail', 'actor']) assert.ok(key in e, `an entry is missing ${key}`);
      const ats = rows.map((e) => e.at);
      assert.deepEqual(ats, [...ats].sort(), 'oldest first, the order hkb log interleaves on');
    },
  },
  {
    name: 'taskEvents is one card\'s history, in the four fields hkb log prints',
    async run(h) {
      const t = await card(h);
      await h.store.setStatus(t, 'running');
      const rows = await h.store.taskEvents(t.number);
      assert.ok(Array.isArray(rows), 'taskEvents is never refused the way events() can be');
      for (const r of rows) {
        for (const key of ['at', 'kind', 'detail', 'actor']) assert.ok(key in r, `a taskEvents row is missing ${key}`);
      }
    },
  },
  {
    name: 'listTasks says how much of blockedBy was actually looked up',
    async run(h) {
      const parent = await card(h, { title: 'first' });
      const child = await card(h, { title: 'second', status: 'todo' });
      await h.store.addBlockedBy(child.number, parent.number);
      const tasks = await h.store.listTasks({ states: ['OPEN'] });
      const note = blockersOf(tasks);
      assert.ok(note.filled, 'a board asked for its blockers comes back saying they were read');
      assert.ok(['all', 'open', 'waiting'].includes(note.scope), `scope was ${note.scope}`);
      assert.ok(note.source, 'and it names where they came from — "filled by nobody" is not an answer');
      // and the reader agrees for the card that has one — an empty list nobody read is not "no blockers"
      const read = tasks.find((x) => x.number === child.number);
      assert.equal(blockersKnown(tasks, read), true);
      assert.deepEqual(read.blockedBy.map((b) => b.number), [parent.number]);

      // `blockers: false` is the caller saying "spend nothing on dependencies". A driver may
      // honour it or ignore it — `blocked_by` is a column on a local board and free — but whichever
      // it does, the note has to describe what it actually did. The pairing is the point: a driver
      // that answers "not filled" while handing back edges, or "filled" while handing back none,
      // is the failure this scenario exists to catch, because every "an empty blockedBy nobody read
      // is not 'no blockers'" assertion elsewhere in the suite reads exactly this note.
      const cheap = await h.store.listTasks({ states: ['OPEN'], blockers: false });
      const cheapNote = blockersOf(cheap);
      const cheapRead = cheap.find((x) => x.number === child.number);
      if (cheapNote.filled) {
        assert.ok(['all', 'open', 'waiting'].includes(cheapNote.scope), `scope was ${cheapNote.scope}`);
        assert.ok(cheapNote.source, 'a filled board names its source');
        assert.equal(blockersKnown(cheap, cheapRead), true);
        assert.deepEqual(cheapRead.blockedBy.map((b) => b.number), [parent.number], 'a driver that says it filled them, did');
      } else {
        assert.deepEqual(cheapNote, { source: null, filled: false, scope: 'none' }, 'an unfilled board says so in all three fields');
        assert.equal(blockersKnown(cheap, cheapRead), false);
        assert.deepEqual(cheapRead.blockedBy, [], 'and hands back no edges to be mistaken for "none"');
      }
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
      const h = await driver.open();
      h.reclaim = h.reclaim || ((store, n, k) => store.release(n, k));
      h.settleClaim = h.settleClaim || (() => {});
      h.recordBeat = h.recordBeat || (() => {});
      t.after(h.cleanup);
      await scenario.run(h);
    });
  }
}

// ---------- the double's own contract ----------
//
// The scenarios above say the double answers the *interface* like a driver. These three say its
// **assertion helpers** mean what the rest of the suite reads them as meaning. They are here rather
// than beside any one migrated test because every migrated test depends on them: a counter that
// cannot see a removal, or a `writes()` that counts calls instead of effects, is a lie that passes
// in every file at once.

test('the double: revisionOf counts a label taken off, not only one added', async (t) => {
  const store = new FakeStore();
  const ctx = fakeCtx();
  t.after(store.install(ctx));
  store.addIssue(kbIssue({ number: 7, status: 'todo', agent: 'claude', labels: [L.needsHuman] }));
  const s = await openStore(ctx);
  const task = await s.getTask(7);
  const before = store.revisionOf(7);

  await s.setStatus(task, 'todo', { remove: [L.needsHuman] });

  assert.ok(!store.labelsOf(7).includes(L.needsHuman), 'the label is off the card');
  assert.equal(store.revisionOf(7), before + 1, 'and taking it off is a write — DELETE /issues/7/labels/… on the real driver');
  assert.deepEqual(store.writes(), ['setStatus']);
});

test('the double: writes() counts effects, so a call that changed nothing is not one', async (t) => {
  const store = new FakeStore();
  const ctx = fakeCtx();
  t.after(store.install(ctx));
  store.addIssue(kbIssue({ number: 7, status: 'todo', agent: 'claude' }));
  const s = await openStore(ctx);
  const task = await s.getTask(7);

  await s.setStatus(task, 'todo');            // already todo: no request on a real driver
  await s.ensureLabels([L.status('todo')]);   // already exists: nothing to create
  await s.addLabels(task, [L.status('todo')]);

  assert.deepEqual(store.writes(), [], 'reaching the interface is not writing');
  assert.equal(store.callsOf('setStatus').length, 1, 'the call is still recorded — writes() is about effect');
  assert.equal(store.revisionOf(7), 0);
});

test('the double: reading an assertion is not a call — it neither logs nor eats an injected failure', async (t) => {
  const store = new FakeStore();
  const ctx = fakeCtx();
  t.after(store.install(ctx));
  const s = await openStore(ctx);
  await s.claim(7, 1);
  store.clearCalls();
  store.fail('listLocks', { message: 'the tick\'s own listing is the one that must fail' });

  assert.deepEqual(await store.locks(), ['7/1'], 'the assertion reads the rows themselves');
  assert.deepEqual(store.calls, [], 'and leaves no trace in the log the next assertion reads');
  let caught = null;
  try { await s.listLocks(); } catch (e) { caught = e; }
  assert.match(String(caught?.message), /the tick's own listing/, 'the injected failure is still waiting for the caller it was meant for');
});

test('the double: setStore hands its store through the same one-handle-per-context memo a driver gets', async (t) => {
  const store = new FakeStore();
  const ctx = fakeCtx();
  t.after(store.install(ctx));

  const a = await openStore(ctx);
  const b = await openStore(ctx);

  assert.equal(a, b, 'one handle per context');
  assert.equal(ctx._store, a, 'and it is in the slot closeStore looks in');
  assert.equal(closeStore(ctx), true);
  assert.equal(store.closed, 1, 'the handle lifecycle every verb leans on, exercised through the double');
  assert.equal(closeStore(ctx), false, 'twice is a no-op');
});

/** A bare context, the shape `makeContext` hands the seam. */
function fakeCtx() {
  return {
    root: '/fake', cfg: { ...DEFAULT_BOARD },
    repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {},
    requireBoard() { return this; },
  };
}
