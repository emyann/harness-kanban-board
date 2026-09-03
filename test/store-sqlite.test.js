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
import { openIndex, openIndexReadOnly, indexFile, LOCAL_EVENT_KINDS, LIVE_ATTEMPT_FIELDS, SCHEMA_VERSION } from '../src/store/sqlite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const SQLITE_SRC = path.join(repo, 'src', 'store', 'sqlite.js');

/** A temp root with the `.git/hkb` and `.kanban` shape the index expects, and no git in sight. */
function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-index-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** An index on a temp root. `root` and `file` are passed together so nothing asks git anything. */
function open(t, root, opts = {}) {
  const idx = openIndex(null, { root, file: indexFile(root), ...opts });
  t.after(() => idx.close());
  return idx;
}

/** A tree of A4's shape (§6.2): the board document, the cards, the run records. */
function tree({ tip = 'sha1', cards = [], runs = [], board = {} } = {}) {
  return { tip, board: { slug: 'default', host: 'test-host', paused_at: null, paused_by: null, settings: { dispatch: {} }, ...board }, cards, runs };
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
  assert.equal(again.getTask(1).title, 'card 1');
  assert.equal(again.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, String(SCHEMA_VERSION));
});

test('index: an index from a future schema version says so and names the fix, rather than being read', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 7), 'schema_version');
  idx.close();
  assert.throws(() => openIndex(null, { root, file: indexFile(root) }), (e) => e.exitCode === 2 && /rm /.test(e.message));
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
  assert.deepEqual(idx.getTask(2).blocked_by, [1]);
  assert.deepEqual(idx.getTask(1).paths, ['src/1.js']);

  const attempt = idx.getAttempt(2, 1);
  assert.equal(attempt.outcome, 'done');
  assert.equal(attempt.track, true, 'a boolean survives the round trip through an INTEGER column');
  assert.deepEqual(attempt.track_nodes, [3, 4]);
  assert.equal(attempt.weird_new_field, 'kept', 'a field the schema does not name rides in extra_json');

  // the branch moved: card 1 is gone, card 2 was renamed, a new card 3 arrived
  const second = idx.load(tree({ tip: 'bbb', cards: [card(2, { title: 'renamed' }), card(3)] }));
  assert.equal(second.tasks, 2);
  assert.equal(idx.tip(), 'bbb');
  assert.equal(idx.getTask(1), null, 'a card that left the branch leaves the index');
  assert.equal(idx.getTask(2).title, 'renamed');
  assert.deepEqual(idx.getTask(2).blocked_by, [], 'links are replaced, not accumulated');
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

test('load: a card map keyed by id reads the same as a card array', (t) => {
  const a = open(t, tmpRoot(t));
  const b = open(t, tmpRoot(t));
  a.load(tree({ cards: [card(7, { title: 'seven' })] }));
  b.load(tree({ cards: { 7: { ...card(7, { title: 'seven' }), id: undefined } } }));
  assert.deepEqual(a.getTask(7), b.getTask(7));
});

// ---------- the claim ----------

test('claim: the first wins with a token, the second is held, and a release frees it again', (t) => {
  const idx = open(t, tmpRoot(t));
  idx.load(tree({ cards: [card(5)] }));

  const first = idx.claim(5, 1);
  assert.equal(first.result, 'claimed');
  assert.ok(first.token, 'a claim hands back the token its heartbeat leases on');
  assert.equal(idx.getTask(5).status, 'running', 'the same transaction moved the card');
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
import { openIndex, indexFile } from ${JSON.stringify(pathToSrc())};
const [root, at] = process.argv.slice(2);
const idx = openIndex(null, { root, file: indexFile(root), timeout: 10000 });
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

// ---------- the read-only connection (`hkb serve`) ----------

test('read-only: serve reads the board and every write refuses, naming who may write', (t) => {
  const root = tmpRoot(t);
  const idx = open(t, root);
  idx.load(tree({ cards: [card(8)] }));
  idx.claim(8, 1);

  const ro = openIndexReadOnly(null, { root, file: indexFile(root) });
  t.after(() => ro.close());
  assert.equal(ro.getTask(8).title, 'card 8');
  assert.equal(ro.listLocks().length, 1);
  assert.ok(ro.events({ after: 0 }).length > 0, 'serve feeds its stream from the same cursor');
  for (const call of [() => ro.claim(8, 2), () => ro.release(8, 1), () => ro.heartbeat(8, 1, 'x'), () => ro.load(tree()), () => ro.setAttempt(8, 1, { pid: 1 }), () => ro.appendEvent({ kind: 'status' })]) {
    assert.throws(call, (e) => e.exitCode === 2 && /read-only/.test(e.message));
  }
});

test('read-only: an index that is not there yet says so instead of creating one behind serve', (t) => {
  const root = tmpRoot(t);
  assert.throws(() => openIndexReadOnly(null, { root, file: indexFile(root) }), (e) => e.exitCode === 2 && /hkb up/.test(e.message));
  assert.equal(fs.existsSync(indexFile(root)), false, 'and it did not create the file on the way past');
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
  // The one git question — where the common git dir is — is `storeRoot`'s, asked once per context.
  assert.match(src, /import \{ storeRoot[^}]*\} from '\.\.\/board\.js'/);
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
