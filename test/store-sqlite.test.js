// The index (`src/store/sqlite.js`) — docs/local-first.md §6.3.
//
// Two halves. The first is what only this tier can be asked: the claim really is atomic across
// *processes* (not just across two calls in one), a heartbeat is a row count, a rebuild from the
// branch replaces the indexed tables without touching the live ones, and `wake()` cannot throw.
// The second is the conformance suite's live scenarios (`test/store.test.js`) run against the
// index directly — the interface's claim/lock/heartbeat/events contract, checked here because the
// index is not yet a whole `Store`: node A6 composes it with A4's branch, and *that* is what joins
// `DRIVERS`. The scenario bodies are kept close to the suite's on purpose, so the composed driver
// inherits nothing surprising when it gets there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { openIndex, openIndexReadOnly, indexFileIn, indexDirIn, LOCAL_EVENT_KINDS, LIVE_ATTEMPT_FIELDS, SCHEMA_VERSION } from '../src/store/sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import { GitTier } from '../src/store/git.js';
import { storeGitDir, storeRoot, readPidFile, pidFile } from '../src/board.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const SQLITE_SRC = path.join(repo, 'src', 'store', 'sqlite.js');

/** The git dir of a temp root — the argument `indexFileIn` takes, and what `storeGitDir` answers. */
const gitDirOf = (root) => path.join(root, '.git');

/**
 * A temp root with the `.git/hkb` and `.kanban` shape the index expects, and no git in sight.
 *
 * The removal is registered through `open()` rather than here so it runs *after* every index this
 * test opened is closed: `t.after` hooks run in the order they were registered, so a root that
 * cleaned itself up first deleted a WAL database with a live connection on it — survivable on
 * POSIX, `EBUSY` on Windows.
 */
function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-index-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  /** @type {{close: () => void}[]} */ const open = [];
  OPEN.set(root, open);
  t.after(() => {
    for (const idx of open.splice(0)) { try { idx.close(); } catch { /* already closed */ } }
    OPEN.delete(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Every index opened against a temp root, so the root's cleanup can close them before removing it. */
const OPEN = new Map();

/** An index on a temp root. `root` and `file` are passed together so nothing asks git anything. */
function open(t, root, opts = {}) {
  const idx = openIndex(null, { root, file: indexFileIn(gitDirOf(root)), ...opts });
  OPEN.get(root)?.push(idx);
  return idx;
}

/** A tree of A4's shape (§6.2): the board document, the cards, the run records. */
function tree({ tip = 'sha1', cards = [], runs = [], board = {} } = {}) {
  return {
    tip,
    board: board === null ? undefined : { slug: 'default', host: 'test-host', paused_at: null, paused_by: null, settings: { dispatch: {} }, ...board },
    // A4's `readTree()` hands Maps keyed by id; the array form below is the same records after a
    // JSON round trip. `load()` reads both and nothing else.
    cards: new Map(cards.map((c) => [c.id, c])),
    runs: new Map(runs.map((r) => [r.id, r])),
  };
}

const card = (id, over = {}) => ({
  id, title: `card ${id}`, body: 'why', status: 'ready', agent: 'claude', priority: 2, rank: null,
  paths: [`src/${id}.js`], goal: null, scheduled_at: null, suspended: null, needs_human: false,
  blocked_by: [], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...over,
});

// ---------- opening and the schema ----------

test('index: the file lands under the common git dir, the schema is created once, and reopening keeps it', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  assert.equal(idx.file, path.join(root, '.git', 'hkb', 'index.db'));
  assert.ok(fs.existsSync(idx.file));
  assert.deepEqual(idx.capabilities(), { events: true });
  assert.equal(idx.tip(), null, 'a fresh index has no branch tip behind it');

  idx.load(tree({ cards: [card(1)] }));
  idx.close();

  // reopening must not wipe what the first open built — the schema guard is a version row, not a
  // CREATE that runs again on a live database.
  const again = open(t, root);
  assert.equal(again.tip(), 'sha1');
  assert.equal(again.getTaskRow(1).title, 'card 1');
  assert.equal(again.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, String(SCHEMA_VERSION));
});

test('index: an index from a future schema version says so and names the fix, rather than being read', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 7), 'schema_version');
  idx.close();
  assert.throws(() => openIndex(null, { root, file: indexFileIn(gitDirOf(root)) }), (e) => e.exitCode === 2 && /rm /.test(e.message));
});

test('index: journal_mode is WAL — four processes read while the loop writes', (t) => {
  const idx = open(t, tmpRoot(t));
  assert.equal(idx.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
});

// ---------- load() ----------

test('load: the tree becomes tables, and a second load with a changed tree replaces cleanly', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);

  const first = idx.load(tree({
    tip: 'aaa',
    cards: [card(1), card(2, { status: 'done', blocked_by: [1] })],
    runs: [{
      id: 2, failures: 1, block_loops: { needs_input: 1 }, last_error: 'nope',
      attempts: [
        { attempt: 1, profile: 'claude', host: 'h', started_at: '2026-09-01T01:00:00Z', ended_at: '2026-09-01T02:00:00Z', outcome: 'done', track: true, track_nodes: [3, 4], weird_new_field: 'kept' },
      ],
      results: [{ attempt: 1, summary: 'landed', metadata: { pr: 9 }, artifacts: ['a.txt'] }],
    }],
  }));
  assert.deepEqual([first.tasks, first.links, first.runs, first.attempts, first.results], [2, 1, 1, 1, 1]);
  assert.equal(idx.tip(), 'aaa');
  assert.equal(idx.board().host, 'test-host');
  assert.deepEqual(idx.board().settings, { dispatch: {} });
  assert.deepEqual(idx.getTaskRow(2).blocked_by, [1]);
  assert.deepEqual(idx.getTaskRow(1).paths, ['src/1.js']);

  const attempt = idx.getAttempt(2, 1);
  assert.equal(attempt.outcome, 'done');
  assert.equal(attempt.track, true, 'a boolean survives the round trip through an INTEGER column');
  assert.deepEqual(attempt.track_nodes, [3, 4]);
  assert.equal(attempt.weird_new_field, 'kept', 'a field the schema does not name rides in extra_json');

  // the branch moved: card 1 is gone, card 2 was renamed, a new card 3 arrived
  const second = idx.load(tree({ tip: 'bbb', cards: [card(2, { title: 'renamed' }), card(3)] }));
  assert.equal(second.tasks, 2);
  assert.equal(idx.tip(), 'bbb');
  assert.equal(idx.getTaskRow(1), null, 'a card that left the branch leaves the index');
  assert.equal(idx.getTaskRow(2).title, 'renamed');
  assert.deepEqual(idx.getTaskRow(2).blocked_by, [], 'links are replaced, not accumulated');
  assert.equal(idx.getAttempt(2, 1), null, 'the closed attempt rows are replaced too');
  assert.equal(idx.db.prepare('SELECT count(*) c FROM results').get().c, 0);
  assert.equal(idx.db.prepare('SELECT count(*) c FROM runs').get().c, 0);
});

test('load: the live half survives a rebuild — locks, open attempts and events are not the branch\'s', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ tip: 'aaa', cards: [card(1)] }));
  const { token } = idx.claim(1, 1, { profile: 'claude', host: 'h' });
  idx.setAttempt(1, 1, { pid: 4242, wt: '/w/kb-1-1' });
  const before = idx.events({ after: 0 }).length;

  idx.load(tree({ tip: 'bbb', cards: [card(1, { title: 'moved on' })] }));

  assert.deepEqual(idx.listLocks().map((l) => [l.n, l.k]), [[1, 1]], 'a rebuild that dropped the locks would hand a running card to the next tick');
  const open1 = idx.getAttempt(1, 1);
  assert.equal(open1.pid, 4242);
  assert.equal(open1.wt, '/w/kb-1-1');
  assert.equal(idx.heartbeat(1, 1, token).result, 'ok', 'the lease is still the one the claim handed out');
  assert.ok(idx.events({ after: 0 }).length >= before, 'the event log is append-only across a rebuild');
});

test('load: needsLoad is the cheap question asked on every open', (t) => {
  const idx = open(t, tmpRoot(t));
  assert.equal(idx.needsLoad('aaa'), true);
  idx.load(tree({ tip: 'aaa' }));
  assert.equal(idx.needsLoad('aaa'), false);
  assert.equal(idx.needsLoad('bbb'), true);
});

test('load: the Map A4 hands back and the array it becomes through JSON read the same', (t) => {
  const a = open(t, tmpRoot(t));
  const b = open(t, tmpRoot(t));
  a.load(tree({ cards: [card(7, { title: 'seven' })] })); // `tree()` builds Maps, as readTree() does
  b.load({ tip: 'sha1', board: { slug: 'default' }, cards: [card(7, { title: 'seven' })], runs: [] });
  assert.deepEqual(a.getTaskRow(7), b.getTaskRow(7));
});

test('load: a shape the branch does not write is refused, not half-read', (t) => {
  const idx = open(t, tmpRoot(t));
  // An id-keyed plain object used to be accepted, which is how a `Map` — the shape A4 actually
  // hands over — read as zero cards: `Object.entries(map)` is empty, so the load "succeeded" and
  // indexed nothing. One shape, and anything else says so.
  assert.throws(
    () => idx.load({ tip: 'a', cards: { 7: card(7) } }),
    (e) => e.exitCode === 2 && /Map keyed by id/.test(e.message),
  );
  assert.throws(() => idx.load({ tip: 'a', cards: [], runs: 'runs/7.json' }), (e) => e.exitCode === 2);
  assert.equal(idx.tip(), null, 'and a refused load changed nothing');
});

test('load: a board key the tree omits keeps the board — a pause does not vanish on a rebuild', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ tip: 'aaa', cards: [card(1)], board: { paused_at: '2026-09-02T09:00:00Z', paused_by: 'me', settings: { dispatch: { interval: 60 } } } }));
  assert.equal(idx.board().paused_at, '2026-09-02T09:00:00Z');

  // a partial read — a caller that had the cards but not the document — must not read as "running"
  idx.load({ tip: 'bbb', cards: new Map([[1, card(1)]]), runs: new Map() });
  const after = idx.board();
  assert.equal(after.tip_sha, 'bbb', 'the tip still moves');
  assert.equal(after.paused_at, '2026-09-02T09:00:00Z', 'a board-wide pause is not the cards\' to drop');
  assert.equal(after.paused_by, 'me');
  assert.equal(after.host, 'test-host');
  assert.deepEqual(after.settings, { dispatch: { interval: 60 } });
  assert.equal(after.slug, 'default');

  // and when the document IS there, it is authoritative — including its nulls
  idx.load(tree({ tip: 'ccc', cards: [card(1)] }));
  assert.equal(idx.board().paused_at, null, 'the branch says the board is running again');
});

test('load: a card the tree names twice, and a field the schema cannot hold, say which file to look at', (t) => {
  const idx = open(t, tmpRoot(t));
  assert.throws(
    () => idx.load({ tip: 'a', cards: [card(3), card(3, { title: 'again' })], runs: [] }),
    (e) => e.exitCode === 2 && /two cards numbered 3/.test(e.message),
  );
  assert.throws(
    () => idx.load(tree({ cards: [card(4, { title: { not: 'a string' } })] })),
    (e) => e.exitCode === 2 && /cards\/4\.json/.test(e.message),
  );
  assert.equal(idx.db.prepare('SELECT count(*) c FROM tasks').get().c, 0, 'and neither load left half a board behind');
});

test('load: a lock on a card that left the branch is not a lock', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ tip: 'aaa', cards: [card(1), card(2)] }));
  idx.claim(1, 1, { profile: 'claude' });
  idx.claim(2, 1, { profile: 'claude' });
  assert.equal(idx.listLocks().length, 2);

  // #2 left the board; #1 is still there and its lock is still held.
  idx.load(tree({ tip: 'bbb', cards: [card(1)] }));
  assert.deepEqual(idx.listLocks().map((l) => l.n), [1], '§6.1 retires the tick\'s orphan sweep — this is where it happens instead');
});

test('load: the branch closing an attempt does not take the lock off the worker still running it', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.load(tree({ tip: 'aaa', cards: [card(1)] }));
  const { token } = idx.claim(1, 3, { profile: 'claude' });
  idx.setAttempt(1, 3, { pid: 4242, job: 'j1', wt: '/tmp/wt' });

  // This is `hkb finish`'s own window: the attempt is written closed to the branch *before*
  // `release()` runs, and any tick reloading on the moved tip lands in it. Reading the tree's
  // `ended_at` as permission to overwrite wiped the pid the loop was watching, and the sweep then
  // dropped the lock — so the running worker's next heartbeat came back `lost`, exit 3.
  const r = idx.load(tree({
    tip: 'bbb',
    cards: [card(1)],
    runs: [{ id: 1, attempts: [{ attempt: 3, ended_at: '2026-09-01T02:00:00Z', outcome: 'done', summary: 'from the branch' }] }],
  }));
  assert.equal(r.attempts_held, 1, 'the branch\'s copy of a live attempt is held, not written');
  assert.equal(r.locks_dropped, 0);
  const live = idx.getAttempt(1, 3);
  assert.equal(live.pid, 4242, 'the live fields are still here');
  assert.equal(live.job, 'j1');
  assert.equal(live.wt, '/tmp/wt');
  assert.equal(live.ended_at, null, 'and the attempt is still open');
  assert.deepEqual(idx.listLocks().map((l) => [l.n, l.k]), [[1, 3]]);
  assert.equal(idx.heartbeat(1, 3, token).result, 'ok', 'the worker still holds its lease');

  // The lock is what makes it self-clearing: once the worker releases, the branch is the source
  // again and the next load indexes its copy.
  assert.equal(idx.release(1, 3), true);
  idx.load(tree({
    tip: 'ccc',
    cards: [card(1)],
    runs: [{ id: 1, attempts: [{ attempt: 3, ended_at: '2026-09-01T02:00:00Z', outcome: 'done', summary: 'from the branch' }] }],
  }));
  assert.equal(idx.getAttempt(1, 3).outcome, 'done');
  assert.equal(idx.getAttempt(1, 3).summary, 'from the branch');
});

test('load: an attempt record carrying a task_id of its own lands on its own card, not that one', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({
    tip: 'aaa',
    cards: [card(1), card(2)],
    runs: [
      { id: 1, attempts: [{ attempt: 1, ended_at: '2026-09-01T02:00:00Z', outcome: 'ours' }] },
      // `task_id` is in the schema's column list, so it used to be written straight through — the
      // row landed on card 1 and INSERT OR REPLACE quietly replaced that card's attempt.
      { id: 2, attempts: [{ attempt: 1, task_id: 1, n: 1, ended_at: '2026-09-01T03:00:00Z', outcome: 'theirs' }] },
    ],
  }));
  assert.equal(idx.getAttempt(1, 1).outcome, 'ours', 'card 1 still has its own attempt');
  assert.equal(idx.getAttempt(2, 1).outcome, 'theirs');
  assert.equal(idx.getAttempt(2, 1).n, 2, 'and the row knows which card it is on');
  assert.equal(idx.db.prepare('SELECT count(*) c FROM attempts').get().c, 2);
});

test('listTaskRows answers the whole board with its blockers, not one query per card', (t) => {
  const idx = open(t, tmpRoot(t));
  const cards = [];
  for (let i = 1; i <= 20; i++) cards.push(card(i, { blocked_by: i > 1 ? [i - 1] : [], status: i % 2 ? 'ready' : 'done' }));
  idx.load(tree({ cards }));

  const rows = idx.listTaskRows();
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map((r) => r.id), cards.map((c) => c.id));
  assert.deepEqual(rows[9].blocked_by, [9], 'every row still carries its blockers');
  assert.deepEqual(rows[0].blocked_by, []);
  assert.deepEqual(idx.listTaskRows({ status: 'ready' }).map((r) => r.id), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);

  // the lookup is by blocked_id, and `links` is UNIQUE(blocker_id, blocked_id) — the wrong leading
  // column, so without this index the grouping query is a scan
  const plan = idx.db.prepare('EXPLAIN QUERY PLAN SELECT blocker_id, blocked_id FROM links WHERE blocked_id = ?').all().map((r) => r.detail).join(' ');
  assert.match(plan, /links_blocked/, `the blocker lookup has an index to use (${plan})`);
});

// ---------- the claim ----------

test('claim: the first wins with a token, the second is held, and a release frees it again', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(5)] }));

  const first = idx.claim(5, 1);
  assert.equal(first.result, 'claimed');
  assert.ok(first.token, 'a claim hands back the token its heartbeat leases on');
  assert.equal(idx.getTaskRow(5).status, 'running', 'the same transaction moved the card');
  assert.ok(idx.getAttempt(5, 1), 'and opened the attempt row');

  const second = idx.claim(5, 1);
  assert.equal(second.result, 'held');
  assert.equal(second.token, null);

  assert.equal(idx.release(5, 1), true);
  assert.equal(idx.claim(5, 1).result, 'claimed', 'a released claim can be taken again');
  idx.release(5, 1);
  assert.equal(idx.release(5, 1), false, 'releasing twice is not an error, and says nothing was there');
});

test('claim: a held claim rolls the whole transaction back — no half-open attempt behind it', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(5)] }));
  idx.claim(5, 1, { profile: 'claude' });
  const events = idx.events({ after: 0 }).length;
  const before = idx.getAttempt(5, 1);

  assert.equal(idx.claim(5, 1, { profile: 'codex' }).result, 'held');
  assert.equal(idx.getAttempt(5, 1).profile, before.profile, 'the loser did not overwrite the winner\'s attempt row');
  assert.equal(idx.events({ after: 0 }).length, events, 'and it appended no event');
});

test('claim: two processes racing for the same card — exactly one wins', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.load(tree({ cards: [card(9)] }));
  idx.close();

  const runner = path.join(root, 'claimer.mjs');
  fs.writeFileSync(runner, `
import path from 'node:path';
import { openIndex, indexFileIn } from ${JSON.stringify(pathToSrc())};
const [root, at] = process.argv.slice(2);
const idx = openIndex(null, { root, file: indexFileIn(path.join(root, '.git')), timeout: 10000 });
while (Date.now() < Number(at)) { /* a barrier, so both are inside BEGIN IMMEDIATE at once */ }
const r = idx.claim(9, 1, { profile: 'p' + process.pid });
idx.close();
process.stdout.write(JSON.stringify(r));
`);

  const at = String(Date.now() + 400);
  const kids = [0, 1].map(() => spawn(process.execPath, [runner, root, at], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const done = Promise.all(kids.map((kid) => new Promise((resolve) => {
    let out = ''; let err = '';
    kid.stdout.on('data', (d) => { out += d; });
    kid.stderr.on('data', (d) => { err += d; });
    kid.on('close', (code) => resolve({ code, out, err }));
  })));

  return done.then((rows) => {
    for (const r of rows) assert.equal(r.code, 0, `a claimer failed: ${r.err}`);
    const results = rows.map((r) => JSON.parse(r.out).result).sort();
    assert.deepEqual(results, ['claimed', 'held'], `two processes, one claim (got ${results.join(', ')})`);

    const after = open(t, root);
    assert.equal(after.listLocks().length, 1, 'and exactly one lock row exists afterwards');
    assert.equal(after.events({ after: 0 }).filter((e) => e.payload?.op === 'claim').length, 1, 'and exactly one claim event');
  });
});

function pathToSrc() { return new URL('../src/store/sqlite.js', import.meta.url).href; }

// ---------- the heartbeat ----------

test('heartbeat: ok while the claim is ours, and the token rotates so the next beat leases on it', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(3)] }));
  const { token } = idx.claim(3, 1);

  const first = idx.heartbeat(3, 1, token);
  assert.equal(first.result, 'ok');
  assert.ok(first.token && first.token !== token, 'a beat advances the lease, as the ref\'s sha does');
  // the second beat is the one that matters: a worker beats every ten minutes, and leasing on the
  // FIRST beat's `expected` would read back as LOCK_LOST.
  assert.equal(idx.heartbeat(3, 1, first.token).result, 'ok');
  assert.equal(idx.heartbeat(3, 1, token).result, 'lost', 'a stale token is somebody else\'s lease');
});

test('heartbeat: lost once the claim has been released, and it says so without throwing', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(3)] }));
  const { token } = idx.claim(3, 1);
  idx.release(3, 1);
  assert.deepEqual(idx.heartbeat(3, 1, token), { result: 'lost', token: null });
  assert.throws(() => idx.heartbeat(3, 1, null), (e) => e.exitCode === 2);
});

test('lockBeatAt is null until a beat lands, then it is when the beat landed', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(3)] }));
  const { token } = idx.claim(3, 1);
  assert.equal(idx.lockBeatAt(3, 1), null, 'a fresh claim has no beat behind it');
  idx.heartbeat(3, 1, token);
  const at = idx.lockBeatAt(3, 1);
  assert.ok(at && !Number.isNaN(Date.parse(at)));
  assert.equal(idx.getAttempt(3, 1).heartbeat_at, at, 'the attempt row learns it too — that is what reap reads');
  assert.equal(idx.lockBeatAt(999, 1), null, 'a lock nobody holds has no beat');
});

test('listLocks reports every live claim, and nothing after they are released', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(1), card(2)] }));
  const a = idx.claim(1, 1);
  const b = idx.claim(2, 2);
  const rows = idx.listLocks();
  assert.deepEqual(rows.map((r) => `${r.n}/${r.k}`), ['1/1', '2/2']);
  for (const r of rows) assert.ok('token' in r && 'beat_at' in r, 'a lock row carries its token and last beat');
  assert.ok(a.token && b.token && a.token !== b.token);
  idx.release(1, 1);
  idx.release(2, 2);
  assert.deepEqual(idx.listLocks(), []);
});

// ---------- the open attempt's live fields ----------

test('setAttempt writes the live fields, refuses the durable ones, and events a pause as a pause', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(4)] }));
  idx.claim(4, 1);

  idx.setAttempt(4, 1, { pid: 1234, job: 'j-1', wt: '/w/kb-4-1' });
  const row = idx.getAttempt(4, 1);
  assert.deepEqual([row.pid, row.job, row.wt], [1234, 'j-1', '/w/kb-4-1']);

  const at = '2026-09-02T10:00:00.000Z';
  idx.setAttempt(4, 1, { paused_at: at, pauses_json: JSON.stringify([{ at }]) });
  assert.equal(idx.getAttempt(4, 1).paused_at, at);
  assert.equal(idx.events({ after: 0 }).at(-1).kind, 'paused');
  idx.setAttempt(4, 1, { paused_at: null });
  assert.equal(idx.events({ after: 0 }).at(-1).kind, 'resumed');

  assert.throws(() => idx.setAttempt(4, 1, { outcome: 'done' }), (e) => e.exitCode === 2 && /kb-board branch/.test(e.message));
  assert.throws(() => idx.setAttempt(404, 1, { pid: 1 }), (e) => e.exitCode === 2 && /claim it first/.test(e.message));
  for (const f of LIVE_ATTEMPT_FIELDS) assert.doesNotThrow(() => idx.setAttempt(4, 1, { [f]: null }));
});

test('setAttempt cannot forge a heartbeat — the beat is the lease, and the lease needs the token', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(4)] }));
  const { token } = idx.claim(4, 1);
  idx.heartbeat(4, 1, token);
  const real = idx.getAttempt(4, 1).heartbeat_at;

  assert.ok(!LIVE_ATTEMPT_FIELDS.includes('heartbeat_at'));
  // A worker the reap already declared lost could otherwise keep its attempt looking alive with no
  // token at all — `setAttempt` asks for none.
  assert.throws(() => idx.setAttempt(4, 1, { heartbeat_at: new Date().toISOString() }), (e) => e.exitCode === 2 && /heartbeat_at/.test(e.message));
  assert.equal(idx.getAttempt(4, 1).heartbeat_at, real);
  assert.equal(idx.heartbeat(4, 1, 'a-token-nobody-holds').result, 'lost');
  assert.equal(idx.getAttempt(4, 1).heartbeat_at, real, 'and a lost beat writes nothing either');
});

// ---------- events ----------

test('events: every mutating call appends exactly one, and a call that changed nothing appends none', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(6)] }));
  const count = () => idx.events({ after: 0, limit: 1000 }).length;

  const mutations = [
    ['claim', () => idx.claim(6, 1)],
    ['heartbeat', () => idx.heartbeat(6, 1, idx.listLocks()[0].token)],
    ['setAttempt', () => idx.setAttempt(6, 1, { pid: 7 })],
    ['appendEvent', () => idx.appendEvent({ kind: 'suspended', task_id: 6, payload: { by: 'op' } })],
    ['release', () => idx.release(6, 1)],
  ];
  for (const [name, run] of mutations) {
    const before = count();
    run();
    assert.equal(count(), before + 1, `${name} must append exactly one event`);
  }

  const before = count();
  idx.release(6, 1);
  idx.heartbeat(6, 1, 'a-token-nobody-holds');
  idx.load(tree({ tip: 'ccc', cards: [card(6)] }));
  assert.equal(count(), before, 'a release of nothing, a lost beat and a rebuild are not decisions');
});

test('events: id order, an exclusive cursor, and the shape a stream reader gets', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(1), card(2)] }));
  idx.claim(1, 1);
  idx.claim(2, 1);
  idx.release(1, 1);

  const all = idx.events({ after: 0, limit: 1000 });
  assert.ok(all.length >= 3);
  for (const e of all) {
    for (const key of ['id', 'at', 'kind', 'number', 'payload']) assert.ok(key in e, `an event is missing ${key}`);
    assert.ok(LOCAL_EVENT_KINDS.includes(e.kind), `unknown kind ${e.kind}`);
    assert.ok(!Number.isNaN(Date.parse(e.at)));
  }
  const ids = all.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'events come back in id order');
  assert.deepEqual(idx.events({ after: ids.at(-2), limit: 1000 }).map((e) => e.id), ids.slice(-1), '`after` is exclusive');
  assert.equal(idx.events({ after: 0, limit: 2 }).length, 2, 'and `limit` is a page, not a suggestion');
  assert.throws(() => idx.appendEvent({ kind: 'invented' }), (e) => e.exitCode === 2);
});

test('events: the log has a ceiling — a beat every ten minutes is a row nobody decided to write', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(1)] }));
  for (let i = 0; i < 40; i++) idx.appendEvent({ kind: 'status', task_id: 1, payload: { i } });
  assert.equal(idx.db.prepare('SELECT count(*) c FROM events').get().c, 40);

  assert.equal(idx.trimEvents({ keep: 10 }), 30, 'the oldest rows go');
  const left = idx.events({ after: 0, limit: 1000 });
  assert.equal(left.length, 10);
  assert.deepEqual(left.map((e) => e.payload.i), [30, 31, 32, 33, 34, 35, 36, 37, 38, 39], 'and the newest stay');
  assert.equal(idx.trimEvents({ keep: 1000 }), 0, 'a log under the ceiling is left alone');
  // the cursor still works for a reader that fell off the back: `after` is an id, not an offset
  assert.equal(idx.events({ after: 0 })[0].id, left[0].id);
});

// ---------- wake() ----------

test('wake: no pid file is a no-op, a dead pid is a no-op, and neither throws', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  assert.equal(idx.wake(), false, 'no dispatcher, nobody to wake');

  fs.writeFileSync(path.join(root, '.kanban', 'dispatch.pid'), 'not a number\n');
  assert.equal(idx.wake(), false);

  // a pid that was never alive in this boot: the highest pid the kernel will hand out, plus one
  fs.writeFileSync(path.join(root, '.kanban', 'dispatch.pid'), '4194304\n');
  assert.equal(idx.wake(), false);
});

test('wake: SIGUSR1 reaches the pid in .kanban/dispatch.pid', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  const flag = path.join(root, 'woke');
  const sleeper = path.join(root, 'sleeper.mjs');
  fs.writeFileSync(sleeper, `
import fs from 'node:fs';
process.on('SIGUSR1', () => { fs.writeFileSync(${JSON.stringify(flag)}, 'woke'); process.exit(0); });
process.stdout.write('ready');
setTimeout(() => process.exit(1), 10000);
`);
  const kid = spawn(process.execPath, [sleeper], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { kid.kill('SIGKILL'); } catch { /* already gone */ } });

  return new Promise((resolve, reject) => {
    kid.stdout.once('data', () => {
      fs.writeFileSync(path.join(root, '.kanban', 'dispatch.pid'), `${kid.pid}\n`);
      assert.equal(idx.wake(), true, 'a live dispatcher is signalled');
    });
    kid.on('close', () => {
      try {
        assert.ok(fs.existsSync(flag), 'the dispatcher saw SIGUSR1');
        resolve();
      } catch (e) { reject(e); }
    });
    kid.on('error', reject);
  });
});

test('wake: a pid file older than this boot is a stranger, and nobody signals a stranger', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  const flag = path.join(root, 'woke');
  const sleeper = path.join(root, 'sleeper.mjs');
  fs.writeFileSync(sleeper, `
import fs from 'node:fs';
process.on('SIGUSR1', () => { fs.writeFileSync(${JSON.stringify(flag)}, 'woke'); });
process.stdout.write('ready');
setTimeout(() => process.exit(0), 3000);
`);
  const kid = spawn(process.execPath, [sleeper], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { kid.kill('SIGKILL'); } catch { /* already gone */ } });

  return new Promise((resolve, reject) => {
    kid.stdout.once('data', () => {
      try {
        const pidPath = path.join(root, '.kanban', 'dispatch.pid');
        fs.writeFileSync(pidPath, `${kid.pid}\n`);
        // The claim was written before this boot, and the process holding that pid now is not a
        // dispatcher: `readPidFile` calls that stale, and `wake()` used to re-read the file by hand
        // and never ask. A live pid the kernel reused after a reboot belongs to somebody else.
        fs.utimesSync(pidPath, new Date(0), new Date(0));
        assert.equal(idx.wake(), false, 'a stale claim names a stranger, not the loop');
        assert.equal(fs.existsSync(flag), false, 'and nothing was signalled');
        resolve();
      } catch (e) { reject(e); } finally { try { kid.kill('SIGKILL'); } catch { /* gone */ } }
    });
    kid.on('error', reject);
  });
});

// ---------- where the file goes ----------

test('index: a checkout whose .git is a file still gets an index, not ENOTDIR', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-sep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, 'work');
  const gitDir = path.join(dir, 'elsewhere.git');
  const r = spawnSync('git', ['init', '-q', '--separate-git-dir', gitDir, work], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(path.join(work, '.git')).isFile(), '`.git` is a file here — a submodule looks the same');

  // `storeRoot(ctx)` answers with the *parent* of the common git dir and only when it is named
  // `.git`, so joining `.git` back on gave `<work>/.git/hkb/index.db` — a path through a file.
  const ctx = { root: work, cfg: {}, board: 'default', json: false, _cache: {} };
  const idx = openIndex(ctx);
  t.after(() => idx.close());
  assert.equal(idx.file, path.join(gitDir, 'hkb', 'index.db'));
  assert.ok(fs.existsSync(idx.file));
  idx.load(tree({ cards: [card(1)] }));
  assert.equal(idx.getTaskRow(1).title, 'card 1');
});

// ---------- two boards in one repository ----------

test('two boards in one repo are two indexes, and one index never answers for the other', (t) => {
  const root = tmpRoot(t);
  const alpha = openIndex(null, { root, gitDir: gitDirOf(root), slug: 'alpha' });
  const beta = openIndex(null, { root, gitDir: gitDirOf(root), slug: 'beta' });
  OPEN.get(root).push(alpha, beta);

  assert.notEqual(alpha.file, beta.file, '`--repos` and the {path, board} entries are a documented shape');
  assert.equal(path.dirname(alpha.file), indexDirIn(gitDirOf(root)));
  alpha.load(tree({ tip: 'a', cards: [card(1, { title: 'alpha card' })], board: { slug: 'alpha' } }));
  beta.load(tree({ tip: 'b', cards: [card(1, { title: 'beta card' })], board: { slug: 'beta' } }));

  assert.equal(alpha.board().slug, 'alpha');
  assert.equal(beta.board().slug, 'beta');
  assert.equal(alpha.getTaskRow(1).title, 'alpha card');
  assert.equal(beta.getTaskRow(1).title, 'beta card', 'beta reading alpha\'s cards is two boards sharing one index');

  // and a caller that names alpha's file while asking for beta is told, not quietly answered
  assert.throws(
    () => openIndex(null, { root, file: alpha.file, slug: 'beta' }),
    (e) => e.exitCode === 2 && /holds board "alpha"/.test(e.message),
  );
});

// ---------- the read-only connection (`hkb serve`) ----------

test('read-only: serve reads the board and every write refuses, naming who may write', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.load(tree({ cards: [card(8)] }));
  idx.claim(8, 1);

  const ro = openIndexReadOnly(null, { root, file: indexFileIn(gitDirOf(root)) });
  t.after(() => ro.close());
  assert.equal(ro.getTaskRow(8).title, 'card 8');
  assert.equal(ro.listLocks().length, 1);
  assert.ok(ro.events({ after: 0 }).length > 0, 'serve feeds its stream from the same cursor');
  for (const call of [() => ro.claim(8, 2), () => ro.release(8, 1), () => ro.heartbeat(8, 1, 'x'), () => ro.load(tree()), () => ro.setAttempt(8, 1, { pid: 1 }), () => ro.appendEvent({ kind: 'status' })]) {
    assert.throws(call, (e) => e.exitCode === 2 && /read-only/.test(e.message));
  }
});

test('read-only: serve refuses an index another hkb wrote, exactly as the writing connection does', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.load(tree({ cards: [card(8)] }));
  idx.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 7), 'schema_version');
  idx.close();
  // `openIndex` has always checked this; `openIndexReadOnly` skipped it, so `hkb serve` happily read
  // an index whose columns it does not know — and it cannot create the schema to repair it either.
  assert.throws(
    () => openIndexReadOnly(null, { root, file: indexFileIn(gitDirOf(root)) }),
    (e) => e.exitCode === 2 && /schema version/.test(e.message) && /rm /.test(e.message),
  );
});

test('read-only: an index that is not there yet says so instead of creating one behind serve', (t) => {
  const root = tmpRoot(t);
  assert.throws(() => openIndexReadOnly(null, { root, file: indexFileIn(gitDirOf(root)) }), (e) => e.exitCode === 2 && /hkb up/.test(e.message));
  assert.equal(fs.existsSync(indexFileIn(gitDirOf(root))), false, 'and it did not create the file on the way past');
});

// ---------- the two tiers agree on one tree shape ----------
//
// This is the only place the two modules meet, and it is on purpose: composing them into one driver
// is A6's (#294). What is asserted here is narrower and is what A6 needs to be true first — that
// what `GitTier.readTree()` hands over is exactly what `load()` reads, field for field, with no
// translation in between. Both tiers were written in parallel against §6.2, and the tolerance that
// used to paper over a disagreement (four shapes accepted, a `Map` silently reading as zero cards)
// is gone, so a drift fails here rather than costing a field at runtime.

test('shape: what the git tier reads is what the index loads — no translation between them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repoDir = path.join(dir, 'main');
  fs.mkdirSync(repoDir);
  const git = (...args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');

  const tier = new GitTier(repoDir, { host: 'test-host' });
  tier.init('default', 'test-host', { settings: { dispatch: { interval: 60 } } });
  const parent = tier.createTask({ title: 'the parent', status: 'done', agent: 'claude', kb: { priority: 3, paths: ['src/x.js'] } });
  const child = tier.createTask({ title: 'the child', status: 'ready', agent: 'claude' });
  tier.addBlockedBy(child.number, parent.number);
  tier.setStatus(child, 'blocked', { add: ['kb:needs-human'] });
  tier.saveRun(parent.number, {
    id: null,
    run: {
      failures: 1,
      block_loops: { needs_input: 1 },
      last_error: 'nope',
      attempts: [{ attempt: 1, profile: 'claude', host: 'test-host', started_at: '2026-09-01T01:00:00Z', ended_at: '2026-09-01T02:00:00Z', outcome: 'done', track: true, track_nodes: [3, 4] }],
    },
  });
  tier.addNote(parent.number, 'a human said this');

  const idx = openIndex(null, { root: repoDir, gitDir: path.join(repoDir, '.git'), slug: 'default' });
  t.after(() => idx.close());
  const counts = idx.load(tier.readTree());

  assert.deepEqual([counts.tasks, counts.links, counts.runs, counts.attempts], [2, 1, 1, 1]);
  assert.equal(idx.tip(), tier.tip(), 'the index records the commit it was built from');
  assert.equal(idx.board().host, 'test-host');
  assert.deepEqual(idx.board().settings, { dispatch: { interval: 60 } });

  const p = idx.getTaskRow(parent.number);
  assert.equal(p.title, 'the parent');
  assert.equal(p.status, 'done');
  assert.equal(p.agent, 'claude');
  assert.equal(p.priority, 3, 'the hoisted columns land in their own columns');
  assert.deepEqual(p.paths, ['src/x.js']);
  assert.ok(p.created_at && p.updated_at);

  const c = idx.getTaskRow(child.number);
  assert.deepEqual(c.blocked_by, [parent.number], 'blockers are card numbers on both sides');
  assert.equal(c.needs_human, true, 'and `needs_human` is one field with one name');

  const attempt = idx.getAttempt(parent.number, 1);
  assert.equal(attempt.outcome, 'done');
  assert.equal(attempt.track, true);
  assert.deepEqual(attempt.track_nodes, [3, 4]);
  assert.equal(idx.db.prepare('SELECT failures, last_error FROM runs WHERE task_id = ?').get(parent.number).failures, 1);
});

// ---------- the two invariants the card states outright ----------

test('the module never shells out — no git, no child process, anywhere in it', () => {
  const src = fs.readFileSync(SQLITE_SRC, 'utf8');
  const code = src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  assert.doesNotMatch(code, /child_process/, 'the index answers from the file, never from a subprocess');
  for (const fn of ['spawnSync', 'spawn(', 'execSync', 'execFile', 'execFileSync']) {
    assert.ok(!code.includes(fn), `${fn} has no business in the index`);
  }
  assert.doesNotMatch(code, /['"`]git['"`]/, 'no git command line anywhere in the module');
  // The one git question — where the common git dir is — is `storeGitDir`'s, asked once per context.
  assert.match(src, /import \{[^}]*storeGitDir[^}]*\} from '\.\.\/board\.js'/);
});

test('node:sqlite prints nothing on stderr through bin/hkb.js\'s warning filter', () => {
  // On 24 there is no ExperimentalWarning at all; on the 22 floor there is, and `bin/hkb.js`
  // silences it (docs/local-first.md §9). The filter is taken from the real file rather than
  // retyped here, so this asserts A1's code and not a copy of it.
  const bin = fs.readFileSync(path.join(repo, 'bin', 'hkb.js'), 'utf8');
  const cut = bin.indexOf('const { main }');
  assert.ok(cut > 0, 'bin/hkb.js no longer loads src/cli.js the way this test slices it — re-read it');
  const probe = path.join(os.tmpdir(), `hkb-warn-${process.pid}.mjs`);
  fs.writeFileSync(probe, `${bin.slice(0, cut)}\nawait import(${JSON.stringify(pathToSrc())});\n`);
  try {
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '', 'a warning a user cannot act on is noise on every command');
  } finally { fs.rmSync(probe, { force: true }); }
});

// ---------- what the review of the review found ----------

test('load: a tree that carried no cards says nothing about which locks are orphans', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.load(tree({ tip: 'aaa', cards: [card(1)] }));
  const { token } = idx.claim(1, 1, { profile: 'claude' });
  assert.equal(idx.listLocks().length, 1);

  // A partial tree — the shape `board` is already read this way for — used to empty `tasks` and then
  // ask `task_id NOT IN (SELECT id FROM tasks)`, which SQL answers `true` for every row against an
  // empty set. Every live lock went, the worker's next beat came back `lost`, and the card was
  // handed to the next tick: exactly what the split between the durable and the live half exists to
  // prevent.
  const partial = idx.load({ tip: 'bbb' });
  assert.equal(partial.locks_dropped, 0);
  assert.equal(idx.listLocks().length, 1, 'the running worker still holds its card');
  assert.equal(idx.heartbeat(1, 1, token).result, 'ok', 'and its beat is still its own');
  assert.equal(idx.tip(), 'bbb', 'the tip still moved');
  assert.equal(idx.getTaskRow(1).title, 'card 1', 'and a question the tree did not answer changed nothing');

  // a tree that *does* carry cards still reconciles
  assert.equal(idx.load(tree({ tip: 'ccc', cards: [] })).locks_dropped, 1);
  assert.deepEqual(idx.listLocks(), []);
});

test('load: a card\'s identity is its file name, not a field inside it', (t) => {
  const idx = open(t, tmpRoot(t));
  // `cards/7.json` saying `"id": 3` after a hand edit or a bad merge indexed as card 3: `getTaskRow(7)`
  // null, `claim(7, k)` matching no row, and card 7 on the branch and invisible to every index read.
  const tree7 = tree({ tip: 'aaa', cards: [card(7, { title: 'seven' })] });
  tree7.cards.get(7).id = 3;
  idx.load(tree7);
  assert.equal(idx.getTaskRow(7)?.title, 'seven', 'the key is the id');
  assert.equal(idx.getTaskRow(3), null);
  assert.equal(idx.claim(7, 1, { profile: 'claude' }).result, 'claimed');
  assert.deepEqual(idx.listTaskRows().map((r) => r.id), [7]);

  // and when the id it claims really is another card's, the duplicate guard names the file it is in
  const both = tree({ tip: 'bbb', cards: [card(3), card(7)] });
  both.cards.get(7).id = 3;
  assert.doesNotThrow(() => idx.load(both), 'two files, two cards — the field is simply overridden');
  assert.deepEqual(idx.listTaskRows().map((r) => r.id), [3, 7]);
});

test('load: a tree carrying another board\'s slug is refused, not indexed over this one', (t) => {
  const idx = open(t, tmpRoot(t), { slug: 'alpha' });
  idx.load(tree({ tip: 'aaa', cards: [card(1, { title: 'alpha card' })], board: { slug: 'alpha' } }));
  // `openIndex` clears this at open time; writing the slug unconditionally in `load` moved the same
  // bug — two boards sharing one index — from open time to load time.
  assert.throws(
    () => idx.load(tree({ tip: 'bbb', cards: [card(1, { title: 'beta card' })], board: { slug: 'beta' } })),
    (e) => e.exitCode === 2 && /holds board "alpha"/.test(e.message),
  );
  assert.equal(idx.board().slug, 'alpha');
  assert.equal(idx.getTaskRow(1).title, 'alpha card', 'and the refusal rolled the whole load back');
  // a tree with no slug of its own still loads, and keeps the index's
  idx.load(tree({ tip: 'ccc', cards: [card(1)], board: { slug: undefined } }));
  assert.equal(idx.board().slug, 'alpha');
});

test('trimEvents: keep 0 keeps none of them', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ tip: 'aaa', cards: [card(1)] }));
  for (let i = 0; i < 5; i++) idx.appendEvent({ kind: 'comment', task_id: 1, payload: { i } });
  assert.equal(idx.events({ limit: 100 }).length, 5);
  assert.equal(idx.trimEvents({ keep: 2 }), 3);
  // `Number(keep) || EVENT_RETENTION` read `0` as "unset" and kept fifty thousand rows — the same
  // falsy-zero shape `nextId` was fixed for on the branch side.
  assert.equal(idx.trimEvents({ keep: 0 }), 2);
  assert.deepEqual(idx.events({ limit: 100 }), []);
  assert.deepEqual(idx.events({ limit: 0 }), [], 'and a caller asking for no rows gets no rows');
});

test('locate: an explicit file decides the root, so wake() looks where the index lives', async (t) => {
  const root = tmpRoot(t);
  // `openIndex(undefined, {file})` — no ctx object at all — used to fall through to `storeRoot()`
  // against `process.cwd()`, so `root()` and `wake()`'s pid file pointed at a different directory
  // than the index was in, and `wake()` swallowed the miss and returned false.
  const idx = openIndex(undefined, { file: indexFileIn(gitDirOf(root)) });
  OPEN.get(root).push(idx);
  assert.equal(idx.root(), root);

  // A *real* other process, not this one: the signal has to reach something. The child installs a
  // SIGUSR1 handler and writes a marker, which is what proves the nudge arrived rather than merely
  // being sent — before this, nothing in the tree listened for SIGUSR1 at all and node's default
  // action for it is to start the inspector.
  const ready = path.join(root, 'ready');
  const marker = path.join(root, 'woken');
  const child = spawn(process.execPath, [
    '-e', `const fs = require("node:fs");
      process.on("SIGUSR1", () => { fs.writeFileSync(process.argv[2], "woken"); process.exit(0); });
      fs.writeFileSync(process.argv[1], "ready");
      setTimeout(() => process.exit(1), 10000);`,
    ready, marker,
  ], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  fs.writeFileSync(path.join(root, '.kanban', 'dispatch.pid'), `${child.pid}\n`);

  // The handler has to be installed before the signal, or SIGUSR1's default action ends the child.
  await until(() => fs.existsSync(ready));
  assert.equal(idx.wake(), true, 'the pid file is where the index is');
  await until(() => fs.existsSync(marker));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'woken', 'and the signal reached the process it names');

  fs.writeFileSync(path.join(root, '.kanban', 'dispatch.pid'), `${process.pid}\n`);
  assert.equal(idx.wake(), false, 'and a store never signals its own process');
});

/** Spin until `f()`, or fail the test — a signal is delivered asynchronously. */
async function until(f, ms = 10_000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`waited ${ms}ms for ${f}`);
}

test('storeGitDir ignores an inherited GIT_DIR — the index is this repo\'s, not the hook\'s', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-gitdir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mine = path.join(dir, 'mine');
  const theirs = path.join(dir, 'theirs');
  for (const d of [mine, theirs]) {
    fs.mkdirSync(d, { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q', d], { encoding: 'utf8' }).status, 0);
  }
  // hkb's own Stop hook runs inside git sometimes, and `gitCommonDir` is now the sole decider of
  // where the board root and the index file are — it went through a bare `spawnSync`, so it never
  // unset this and the index landed in somebody else's repository.
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(theirs, '.git');
  t.after(() => { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; });
  assert.equal(fs.realpathSync(storeGitDir({ root: mine, _cache: {} })), fs.realpathSync(path.join(mine, '.git')));
  assert.equal(fs.realpathSync(storeRoot({ root: mine, _cache: {} })), fs.realpathSync(mine));
  assert.equal(
    fs.realpathSync(path.dirname(path.dirname(indexFileIn(storeGitDir({ root: mine, _cache: {} }))))),
    fs.realpathSync(path.join(mine, '.git')),
    'the index lands under this repo\'s git dir',
  );
  assert.equal(indexFileIn(storeGitDir({ root: mine, _cache: {} })).endsWith(path.join('hkb', 'index.db')), true);
});

test('load: a `board` that is not the document is refused, like `cards` and `runs`', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ tip: 'aaa', cards: [card(1)], board: { paused_at: '2026-09-01T00:00:00Z', paused_by: 'ops' } }));
  assert.equal(idx.board().paused_at, '2026-09-01T00:00:00Z');

  // `{board: 'default'}` is the slug where the document goes. It used to fall through to the
  // tip-only branch: `tip_sha` moved, host/paused_at/paused_by/settings were left alone, and the
  // call reported success — the same silence `collection()` was made strict to end.
  for (const bad of ['default', 42, ['default']]) {
    assert.throws(
      () => idx.load({ tip: 'bbb', board: bad, cards: new Map(), runs: new Map() }),
      (e) => e.exitCode === 2 && /`board` is a/.test(e.message),
      `load({board: ${JSON.stringify(bad)}})`,
    );
  }
  assert.equal(idx.tip(), 'aaa', 'and nothing moved on the way past');
  assert.equal(idx.board().paused_by, 'ops');
});

test('two board slugs that differ at all are two files', () => {
  const gitDir = path.join(os.tmpdir(), 'hkb-slug-probe', '.git');
  const file = (slug) => indexFileIn(gitDir, slug);
  // `a/b` and `a-b` both squashed to `index.a-b.db`, as did `Alpha`/`alpha` on a case-insensitive
  // filesystem and any two slugs sharing 64 characters — and the collision error then said to run
  // `hkb --board a/b`, which resolves to the file the operator is already looking at.
  const slugs = ['a/b', 'a-b', 'a b', 'Alpha', 'alpha', `x${'y'.repeat(80)}1`, `x${'y'.repeat(80)}2`];
  assert.equal(new Set(slugs.map(file)).size, slugs.length, 'one file per slug');
  assert.equal(file('default'), path.join(gitDir, 'hkb', 'index.db'), 'the default board keeps the bare name');
  assert.equal(file('a/b'), file('a/b'), 'and the name is a function of the slug');
  assert.equal(path.basename(file('a/b')).includes(path.sep), false);
});

test('read-only: an error that is not "no schema table" is not "delete your database"', (t) => {
  const root = tmpRoot(t);
  const file = indexFileIn(gitDirOf(root));
  open(t, root).close();
  // `meta` is there but unreadable — a `no such column`, standing in for the transient SQLITE_BUSY
  // that used to read as "no schema version" and told `hkb serve`, the one connection that may not
  // repair anything, to `rm` an index that was current and healthy.
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE meta; CREATE TABLE meta (key TEXT PRIMARY KEY, v TEXT)');
  db.close();
  assert.throws(
    () => openIndexReadOnly(null, { root, file }),
    (e) => !/rm /.test(e.message) && /no such column/i.test(e.message),
    'the driver error propagates instead of becoming rm advice',
  );
});

test('every message names the branch this index was opened for, never kb-board by reflex', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root, { branch: 'kb-board-staging' });
  assert.throws(
    () => idx.load(tree({ tip: 'aaa', cards: [card(1, { title: { not: 'a string' } })] })),
    (e) => e.exitCode === 2 && /kb-board-staging:cards\/1\.json/.test(e.message) && !/ kb-board:/.test(e.message),
  );
  assert.throws(
    () => idx.load({ tip: 'aaa', cards: [card(1), card(1)], runs: new Map(), board: { slug: 'default' } }),
    (e) => e.exitCode === 2 && /ls-tree -r kb-board-staging/.test(e.message),
  );
  // and the tree may say so itself, for a composed driver that knows better than the open did
  assert.throws(
    () => idx.load({ tip: 'aaa', branch: 'from-the-tree', cards: [card(1), card(1)], runs: new Map() }),
    (e) => /ls-tree -r from-the-tree/.test(e.message),
  );
});

test('listTaskRows: a filtered read groups only the links of the cards it returns', (t) => {
  const idx = open(t, tmpRoot(t));
  const cards = [];
  for (let n = 1; n <= 40; n++) cards.push(card(n, { status: n <= 2 ? 'ready' : 'todo', blocked_by: n > 2 ? [1, 2] : [] }));
  idx.load(tree({ tip: 'aaa', cards }));

  const ready = idx.listTaskRows({ status: 'ready' });
  assert.deepEqual(ready.map((r) => r.id), [1, 2]);
  assert.deepEqual(ready.map((r) => r.blocked_by), [[], []], 'and their blockers are still right');
  const one = idx.listTaskRows({ status: 'todo' })[0];
  assert.deepEqual(one.blocked_by, [1, 2]);
  assert.deepEqual(idx.listTaskRows().find((r) => r.id === 3).blocked_by, [1, 2], 'the whole board still answers');
});

test('the boot instant is read once per process, not on every wake()', (t) => {
  const root = tmpRoot(t);
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-btime-'));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
  fs.utimesSync(pidFile(root, 'dispatch'), new Date(0), new Date(0)); // written in 1970: after this "boot"
  fs.writeFileSync(path.join(proc, 'stat'), `cpu 1 2 3\nbtime ${Math.floor(Date.now() / 1000) - 60}\n`);

  assert.equal(readPidFile(root, 'dispatch', { proc }).stale, true, 'the claim predates this boot');
  // On darwin this read is a `sysctl` fork, and `wake()` — which every store write that nudges the
  // loop calls — went through it each time, in a module whose contract is that nothing here shells
  // out. Deleting the source proves the second call never went back for it.
  fs.rmSync(path.join(proc, 'stat'));
  assert.equal(readPidFile(root, 'dispatch', { proc }).stale, true, 'the boot instant came from the cache');
});
