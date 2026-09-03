// The git tier (src/store/git.js) — the `kb-board` branch, written with plumbing from any worktree.
//
// Two halves:
//   1. what is *about git* — a commit from a linked worktree that leaves every working tree clean,
//      the compare-and-swap under a concurrent writer, a plain `git clone` that can read the board,
//      the §6.2 file layout byte for byte, and the one-writer refusal on another host;
//   2. the durable half of the §6.4 conformance suite, run against this tier.
//
// Why (2) lives here rather than in `test/store.test.js`'s `DRIVERS`: that list is a list of whole
// `Store`s, and this is a *tier*. Locks, heartbeats and the event log are the index's (A5,
// `src/store/sqlite.js`), so a `GitTier` registered as a driver would fail the shape check before any
// scenario ran. A6 composes the two into `src/store/local.js`, and *that* is what joins `DRIVERS`.
// The scenarios below are the durable ones from `test/store.test.js`, kept assertion-for-assertion
// so the composed driver inherits a tier that already answers them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitTier, openGitTier, BOARD_BRANCH, BOARD_REF, fileJson } from '../src/store/git.js';
import { L, emptyRun, serializeResultComment, serializeRunComment } from '../src/model.js';

const ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * A scratch repository with one commit and one linked worktree.
 *
 * The worktree is the point: a worker runs in `.claude/worktrees/kb-99-1`, and every store call it
 * makes has to land on the *repository's* board, not on a board per worktree.
 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-git-tier-'));
  const root = path.join(dir, 'main');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  const wt = path.join(dir, 'wt');
  git(root, 'worktree', 'add', '-q', wt, '-b', 'work');
  return {
    dir, root, wt,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** A tier over a checkout, with a fixed host so the one-writer guard is deterministic. */
function tierAt(cwd, { host = 'test-host' } = {}) {
  const ctx = { root: cwd, cfg: {}, board: 'default', json: false, _cache: {} };
  return openGitTier(ctx, { host });
}

/** A scratch repo with the board already initialised, opened from the linked worktree. */
function board({ host = 'test-host', settings = { dispatch: { interval: 60 } } } = {}) {
  const s = scratch();
  const tier = tierAt(s.wt, { host });
  tier.init('default', host, { settings });
  return { ...s, tier };
}

function card(tier, { title = 'a card', status = 'ready', agent = 'claude', kb = {}, body = '' } = {}) {
  return tier.createTask({ title, body, kb, status, agent });
}

// ---------- what is about git ----------

test('git tier: init creates kb-board and leaves every working tree untouched', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const tier = tierAt(s.wt);
  assert.equal(tier.exists(), false);
  const made = tier.init('default', 'test-host', { settings: { a: 1 } });
  assert.equal(made.created, true);
  assert.ok(made.tip);

  // the branch is real, and it is the repository's — the worktree wrote the main checkout's ref
  assert.equal(git(s.root, 'rev-parse', BOARD_REF), made.tip);
  assert.deepEqual(git(s.root, 'ls-tree', '--name-only', BOARD_BRANCH).split('\n'), ['board.json']);

  // and nothing was staged, checked out or written anywhere a human is working
  assert.equal(git(s.wt, 'status', '--porcelain'), '');
  assert.equal(git(s.root, 'status', '--porcelain'), '');
  assert.equal(git(s.wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'work');
  assert.equal(git(s.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  const b = tier.board();
  assert.equal(b.slug, 'default');
  assert.equal(b.host, 'test-host');
  assert.deepEqual(b.settings, { a: 1 });

  // idempotent: a second init changes nothing, and does not put a commit on the history
  const again = tier.init('default', 'other-host');
  assert.equal(again.created, false);
  assert.equal(again.tip, made.tip);
  assert.equal(tier.board().host, 'test-host', 'init never moves the owning host — that is --take-over');
});

test('git tier: a card committed from the linked worktree leaves both working trees clean', (t) => {
  const s = board();
  t.after(s.cleanup);
  const task = card(s.tier, { title: 'from the worktree', kb: { priority: 3 } });

  assert.equal(git(s.wt, 'status', '--porcelain'), '');
  assert.equal(git(s.root, 'status', '--porcelain'), '');
  // the main checkout can read it back through its own tier — one board, two worktrees
  assert.equal(tierAt(s.root).getTask(task.number).title, 'from the worktree');
  assert.deepEqual(
    git(s.root, 'ls-tree', '-r', '--name-only', BOARD_BRANCH).split('\n').sort(),
    ['board.json', `cards/${task.number}.json`],
  );
});

test('git tier: the §6.2 layout — sorted keys, two-space JSON, a trailing newline', (t) => {
  const s = board();
  t.after(s.cleanup);
  const task = card(s.tier, { title: 'shaped', kb: { priority: 2, paths: ['src/x.js'], goal: 'g' } });
  s.tier.saveRun(task.number, { run: { ...emptyRun(), failures: 1, attempts: [{ attempt: 1, host: 'h' }] }, id: null });

  for (const file of ['board.json', `cards/${task.number}.json`, `runs/${task.number}.json`]) {
    const raw = spawnSync('git', ['show', `${BOARD_BRANCH}:${file}`], { cwd: s.root, encoding: 'utf8', env: { ...process.env, ...ENV } }).stdout;
    assert.ok(raw.endsWith('}\n') && !raw.endsWith('}\n\n'), `${file} ends with exactly one newline`);
    const parsed = JSON.parse(raw);
    assert.equal(raw, fileJson(parsed), `${file} is sorted, two-space JSON`);
    assert.match(raw, /^\{\n {2}"/, `${file} is indented two spaces`);
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [...keys].sort(), `${file} has sorted keys`);
  }

  const c = JSON.parse(git(s.root, 'show', `${BOARD_BRANCH}:cards/${task.number}.json`));
  // §6.2 hoists these onto the card rather than leaving them in the machine block
  for (const key of ['id', 'title', 'body', 'status', 'agent', 'priority', 'rank', 'paths', 'goal',
    'scheduled_at', 'suspended', 'needs_human', 'blocked_by', 'created_at', 'updated_at']) {
    assert.ok(key in c, `cards/<id>.json is missing ${key}`);
  }
  assert.equal(c.id, task.number);
  assert.equal(c.priority, 2);
  assert.deepEqual(c.paths, ['src/x.js']);
  // and the rest of the machine block survives, or a dispatch field silently reverts on the next read
  assert.equal(c.kb.max_runtime, 3600);
});

test('git tier: integer ids come from board.json.next_id', (t) => {
  const s = board();
  t.after(s.cleanup);
  assert.equal(JSON.parse(git(s.root, 'show', `${BOARD_BRANCH}:board.json`)).next_id, 1);
  const a = card(s.tier, { title: 'one' });
  const b = card(s.tier, { title: 'two' });
  assert.deepEqual([a.number, b.number], [1, 2]);
  assert.equal(JSON.parse(git(s.root, 'show', `${BOARD_BRANCH}:board.json`)).next_id, 3);
  // a closed card does not free its number
  s.tier.closeTask(a.number, 'completed');
  assert.equal(card(s.tier, { title: 'three' }).number, 3);
});

test('git tier: a concurrent writer makes the CAS refuse, and the retry lands both', (t) => {
  const s = board();
  t.after(s.cleanup);
  const other = tierAt(s.root);
  card(s.tier, { title: 'already here' });

  // Every git call in this module is synchronous, so a real race cannot be staged inside one
  // process — but the mutation callback runs at exactly the moment the race would open, between the
  // read and the update-ref. Committing from a second tier there is the same thing the other writer
  // does, and it is deterministic instead of timing-dependent.
  let interfered = 0;
  const before = s.tier.tip();
  const r = s.tier.commit((tree) => {
    if (interfered === 0) {
      interfered++;
      other.createTask({ title: 'landed first', status: 'ready' });
    }
    tree.cards.get(1).title = 'renamed second';
    return interfered;
  }, 'hkb: the contended write');

  assert.equal(interfered, 1, 'the interfering write happened once');
  assert.notEqual(r.tip, before);
  assert.equal(r.changed, true);

  // both writes are on the branch, and the retry replayed the mutation onto the newer tree
  assert.equal(s.tier.getTask(1).title, 'renamed second');
  const titles = s.tier.listTasks({ states: ['OPEN'] }).map((x) => x.title).sort();
  assert.deepEqual(titles, ['landed first', 'renamed second']);
  // one linear history, no lost commit
  const log = git(s.root, 'log', '--format=%s', BOARD_BRANCH).split('\n');
  assert.ok(log.includes('hkb: the contended write'), 'the retried write is on the history');
  assert.ok(log.some((l) => l.includes('landed first')), 'and so is the writer that beat it');
});

test('git tier: a fresh clone reads the board from origin/kb-board', (t) => {
  const s = board();
  t.after(s.cleanup);
  const task = card(s.tier, { title: 'travels with the clone', kb: { priority: 4 } });
  s.tier.addNote(task.number, 'a human said this');

  const clone = path.join(s.dir, 'clone');
  git(s.dir, 'clone', '-q', s.root, clone);
  // a clone has no local kb-board, only the remote-tracking ref — which is what a friend gets
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', BOARD_REF], { cwd: clone }).status, 1);

  const theirs = tierAt(clone, { host: 'their-laptop' });
  const read = theirs.readTree();
  assert.ok(read.tip, 'the board is reachable through origin/kb-board');
  assert.equal(read.cards.get(task.number).title, 'travels with the clone');
  assert.equal(theirs.getTask(task.number).kb.priority, 4);
  assert.deepEqual(theirs.listNotes(task.number).map((n) => n.text), ['a human said this']);

  // and it is read-only there: the board names another host
  assert.throws(() => theirs.createTask({ title: 'nope' }), (e) => e.exitCode === 2 && /--take-over/.test(e.message));
});

test('git tier: another host reads but does not write, and --take-over is how that changes', (t) => {
  const s = board({ host: 'laptop-a' });
  t.after(s.cleanup);
  card(s.tier, { title: 'made on laptop-a' });

  const b = tierAt(s.wt, { host: 'laptop-b' });
  assert.equal(b.listTasks({ states: ['OPEN'] }).length, 1, 'a foreign host still reads');
  for (const write of [
    () => b.createTask({ title: 'x' }),
    () => b.setStatus({ number: 1 }, 'done'),
    () => b.addNote(1, 'hello'),
    () => b.setBoard({ paused_at: 'now' }),
  ]) {
    assert.throws(write, (e) => e.exitCode === 2 && /laptop-a/.test(e.message) && /hkb init --take-over/.test(e.message));
  }

  b.takeOver('laptop-b');
  assert.equal(b.board().host, 'laptop-b');
  assert.equal(b.createTask({ title: 'now it writes' }).number, 2);
  // and laptop-a is the one locked out now
  assert.throws(() => s.tier.createTask({ title: 'x' }), (e) => e.exitCode === 2 && /laptop-b/.test(e.message));
});

test('git tier: a read is one cat-file --batch, and a no-op write is no commit at all', (t) => {
  const s = board();
  t.after(s.cleanup);
  for (let i = 0; i < 12; i++) card(s.tier, { title: `card ${i}` });

  s.tier.trace.length = 0;
  const read = s.tier.readTree();
  assert.equal(read.cards.size, 12);
  const batches = s.tier.trace.filter((c) => c === 'cat-file');
  assert.equal(batches.length, 1, `one cat-file --batch for the whole tree, not ${batches.length}`);
  assert.equal(s.tier.trace.filter((c) => c === 'ls-tree').length, 1);

  // a write that changes no bytes must not put a commit on the board's history
  const before = s.tier.tip();
  const r = s.tier.commit(() => {}, 'hkb: nothing happened');
  assert.equal(r.changed, false);
  assert.equal(r.tip, before);
  assert.equal(s.tier.tip(), before);
});

test('git tier: the module never touches a working tree', () => {
  const src = fs.readFileSync(new URL('../src/store/git.js', import.meta.url), 'utf8');
  // the verbs that would stage or check out somebody's files, as they would appear in an argv array
  for (const forbidden of ["'checkout'", "'add'", "'stash'", "'reset'", "'restore'", "'switch'", "'merge'", "'rebase'"]) {
    assert.ok(!src.includes(`[${forbidden}`) && !src.includes(`${forbidden},`), `src/store/git.js must not run git ${forbidden}`);
  }
  assert.ok(src.includes('GIT_INDEX_FILE'), 'the index it builds is a temporary one');
});

// ---------- the durable half of the §6.4 conformance suite ----------
//
// These are `test/store.test.js`'s scenarios for the methods this tier owns, kept assertion-for-
// assertion. See the header for why they run here rather than through `DRIVERS`.

const SCENARIOS = [
  {
    name: 'the tier has every durable method of the §6.4 interface',
    run(tier) {
      const durable = [
        'board', 'setBoard', 'listTasks', 'listClosedRecent', 'getTask', 'createTask', 'updateBody',
        'setStatus', 'setAgent', 'addLabels', 'removeLabel', 'closeTask', 'reopenTask',
        'addBlockedBy', 'removeBlockedBy', 'loadRun', 'saveRun', 'latestResult', 'parentResults',
        'addNote', 'listNotes',
      ];
      for (const m of durable) assert.equal(typeof tier[m], 'function', `missing ${m}()`);
      // and none of A5's: a tier that grew a lock would be two stores writing one board
      for (const m of ['claim', 'release', 'listLocks', 'lockBeatAt', 'heartbeat', 'events']) {
        assert.equal(tier[m], undefined, `${m}() belongs to the index (A5), not the branch`);
      }
    },
  },
  {
    name: 'board() names the slug and carries the settings',
    run(tier) {
      const b = tier.board();
      assert.equal(b.slug, 'default');
      assert.ok(b.settings, 'settings are part of board()');
      assert.ok('paused_at' in b && 'paused_by' in b && 'host' in b);
      tier.setBoard({ paused_at: '2026-09-02T10:00:00Z', paused_by: 'me', settings: { extra: true } });
      const after = tier.board();
      assert.equal(after.paused_at, '2026-09-02T10:00:00Z');
      assert.equal(after.paused_by, 'me');
      assert.equal(after.settings.extra, true);
      assert.equal(after.settings.dispatch.interval, 60, 'a settings patch merges, it does not replace');
    },
  },
  {
    name: 'create: a new card comes back with the status, agent and kb it was made with',
    run(tier) {
      const t = card(tier, { title: 'ship it', status: 'ready', agent: 'claude', kb: { priority: 2 }, body: 'the why' });
      assert.equal(t.title, 'ship it');
      assert.equal(t.status, 'ready');
      assert.equal(t.agent, 'claude');
      assert.equal(t.kb.priority, 2);
      assert.match(t.body, /the why/);
      const again = tier.getTask(t.number);
      assert.deepEqual([again.number, again.status, again.agent], [t.number, 'ready', 'claude']);
    },
  },
  {
    name: 'list: every open card, in the shape src/model.js reads',
    run(tier) {
      const a = card(tier, { title: 'one', status: 'ready' });
      const b = card(tier, { title: 'two', status: 'todo' });
      const tasks = tier.listTasks({ states: ['OPEN'] });
      assert.deepEqual(tasks.map((x) => x.number).sort((x, y) => x - y), [a.number, b.number].sort((x, y) => x - y));
      for (const key of ['number', 'kb', 'status', 'agent', 'needsHuman', 'blockedBy', 'prs', 'state', 'createdAt', 'updatedAt', 'url']) {
        assert.ok(key in tasks[0], `a listed task is missing ${key}`);
      }
      assert.ok(Array.isArray(tasks[0].blockedBy) && Array.isArray(tasks[0].prs));
    },
  },
  {
    name: 'status: setStatus moves the card and the next read agrees',
    run(tier) {
      const t = card(tier, { status: 'ready' });
      tier.setStatus(t, 'running');
      assert.equal(t.status, 'running', 'the passed task is updated in place');
      assert.equal(tier.getTask(t.number).status, 'running');
      tier.setStatus(t, 'blocked', { add: [L.needsHuman] });
      const read = tier.getTask(t.number);
      assert.equal(read.status, 'blocked');
      assert.equal(read.needsHuman, true);
      tier.removeLabel(t, L.needsHuman);
      assert.equal(tier.getTask(t.number).needsHuman, false);
    },
  },
  {
    name: 'labels that are not columns ride along as themselves',
    run(tier) {
      const t = card(tier);
      tier.addLabels(t, [L.noTrack]);
      assert.ok(tier.getTask(t.number).labels.includes(L.noTrack));
      assert.ok(t.labels.includes(L.noTrack), 'the caller\'s task is updated in place');
      tier.removeLabel(t, L.noTrack);
      assert.ok(!tier.getTask(t.number).labels.includes(L.noTrack));
      // and the columns are always there
      assert.deepEqual(tier.getTask(t.number).labels.slice(0, 3), [L.board('default'), L.status('ready'), L.agent('claude')]);
    },
  },
  {
    name: 'agent: setAgent leaves exactly one profile on the card',
    run(tier) {
      const t = card(tier, { agent: 'claude' });
      tier.setAgent(t, 'codex');
      const read = tier.getTask(t.number);
      assert.equal(read.agent, 'codex');
      assert.deepEqual(read.labels.filter((l) => l.startsWith('kb:agent:')), [L.agent('codex')]);
    },
  },
  {
    name: 'blockers: addBlockedBy links, removeBlockedBy unlinks',
    run(tier) {
      const parent = card(tier, { title: 'first' });
      const child = card(tier, { title: 'second' });
      tier.addBlockedBy(child.number, parent.number);
      const linked = tier.getTask(child.number);
      assert.deepEqual(linked.blockedBy.map((b) => b.number), [parent.number]);
      assert.equal(linked.blockedBy[0].title, 'first', 'a blocker row carries enough to judge it done');
      assert.equal(linked.blockedBy[0].state, 'OPEN');
      tier.closeTask(parent.number, 'completed');
      assert.equal(tier.getTask(child.number).blockedBy[0].stateReason, 'COMPLETED');
      tier.removeBlockedBy(child.number, parent.number);
      assert.deepEqual(tier.getTask(child.number).blockedBy, []);
    },
  },
  {
    name: 'run record: loadRun on an untouched card is empty, and a save round-trips',
    run(tier) {
      const t = card(tier);
      const first = tier.loadRun(t.number);
      assert.deepEqual(first.run, emptyRun());
      first.run.attempts.push({ attempt: 1, host: 'test-host', started_at: '2026-09-02T10:00:00Z', outcome: null });
      first.run.failures = 1;
      tier.saveRun(t.number, first);
      const back = tier.loadRun(t.number);
      assert.equal(back.run.attempts.length, 1);
      assert.equal(back.run.attempts[0].host, 'test-host');
      assert.equal(back.run.failures, 1);
      back.run.attempts[0].outcome = 'done';
      tier.saveRun(t.number, back);
      const third = tier.loadRun(t.number);
      assert.equal(third.run.attempts.length, 1);
      assert.equal(third.run.attempts[0].outcome, 'done');
    },
  },
  {
    name: 'notes: addNote is readable through listNotes, and results through latestResult',
    run(tier) {
      const t = card(tier);
      assert.deepEqual(tier.listNotes(t.number), []);
      tier.addNote(t.number, 'a human said this');
      const notes = tier.listNotes(t.number);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].text, 'a human said this');
      assert.ok(notes[0].at, 'a note carries when it was written');
      assert.equal(tier.latestResult(t.number), null, 'a note is not a result');
      tier.addNote(t.number, serializeResultComment({ attempt: 1, summary: 'landed', metadata: { ok: true } }));
      const r = tier.latestResult(t.number);
      assert.equal(r.summary, 'landed');
      assert.deepEqual(r.metadata, { ok: true });
      assert.ok(r.at, 'a result carries when it landed');
    },
  },
  {
    name: 'listNotes returns what a person wrote, never hkb\'s own records',
    run(tier) {
      const t = card(tier);
      tier.saveRun(t.number, { run: { ...emptyRun(), attempts: [{ attempt: 1, profile: 'claude', host: 'h', started_at: new Date().toISOString() }] }, id: null });
      tier.addNote(t.number, 'a human said this');
      tier.addNote(t.number, serializeResultComment({ attempt: 1, summary: 'landed', metadata: {} }));
      assert.deepEqual(tier.listNotes(t.number).map((n) => n.text), ['a human said this']);
      // and a run record arriving down the note path is refused rather than swallowed
      assert.throws(() => tier.addNote(t.number, serializeRunComment(emptyRun())), (e) => e.exitCode === 2 && /saveRun/.test(e.message));
    },
  },
  {
    name: 'parentResults: one row per blocker, carrying its latest result',
    run(tier) {
      const parent = card(tier, { title: 'the parent' });
      const child = card(tier, { title: 'the child' });
      tier.addNote(parent.number, serializeResultComment({ attempt: 1, summary: 'parent done', metadata: {} }));
      tier.addBlockedBy(child.number, parent.number);
      const rows = tier.parentResults(tier.getTask(child.number));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].number, parent.number);
      assert.equal(rows[0].title, 'the parent');
      assert.equal(rows[0].result.summary, 'parent done');
    },
  },
  {
    name: 'closed-recent: a closed card leaves the open list and joins the closed one; reopen puts it back',
    run(tier) {
      const t = card(tier, { status: 'done' });
      tier.closeTask(t.number, 'completed');
      assert.ok(!tier.listTasks({ states: ['OPEN'] }).some((x) => x.number === t.number), 'a closed card is not open');
      assert.ok(tier.listClosedRecent().some((x) => x.number === t.number), 'and it is in listClosedRecent');
      assert.ok(tier.listTasks({ states: ['OPEN', 'CLOSED'] }).some((x) => x.number === t.number));
      tier.reopenTask(t.number);
      assert.ok(tier.listTasks({ states: ['OPEN'] }).some((x) => x.number === t.number));
      assert.equal(tier.getTask(t.number).stateReason, null);
    },
  },
  {
    name: 'updateBody rewrites the prose and keeps every machine field',
    run(tier) {
      const kb = { priority: 5, paths: ['src/x.js'], max_runtime: 4242 };
      const t = card(tier, { body: 'before', kb });
      tier.updateBody(t.number, 'after');
      const read = tier.getTask(t.number);
      assert.match(read.bodyText ?? read.body, /after/);
      assert.doesNotMatch(read.bodyText ?? read.body, /before/);
      assert.equal(read.kb.priority, 5);
      assert.deepEqual(read.kb.paths, ['src/x.js']);
      assert.equal(read.kb.max_runtime, 4242);
    },
  },
  {
    name: 'listTasks: OPEN, CLOSED and both mean three different answers',
    run(tier) {
      const open = card(tier);
      const closed = card(tier);
      tier.closeTask(closed.number, 'completed');

      const justOpen = tier.listTasks({ states: ['OPEN'] }).map((t) => t.number);
      assert.ok(justOpen.includes(open.number));
      assert.ok(!justOpen.includes(closed.number));

      const justClosed = tier.listTasks({ states: ['CLOSED'] }).map((t) => t.number);
      assert.ok(justClosed.includes(closed.number));
      assert.ok(!justClosed.includes(open.number), 'asking for closed cards must not hand back the open board');

      const both = tier.listTasks({ states: ['OPEN', 'CLOSED'] }).map((t) => t.number);
      assert.ok(both.includes(open.number) && both.includes(closed.number));

      assert.throws(() => tier.listTasks({ states: ['MAYBE'] }), (e) => e.exitCode === 2);
    },
  },
  {
    name: 'a card that is not there is exit 2 and says how to find out what is',
    run(tier) {
      for (const call of [() => tier.getTask(99), () => tier.updateBody(99, 'x'), () => tier.addNote(99, 'x'), () => tier.closeTask(99)]) {
        assert.throws(call, (e) => e.exitCode === 2 && /#99/.test(e.message) && /hkb list/.test(e.message));
      }
    },
  },
];

for (const scenario of SCENARIOS) {
  test(`store[git-tier]: ${scenario.name}`, (t) => {
    const s = board();
    t.after(s.cleanup);
    scenario.run(s.tier);
  });
}

// One assertion that is about the class rather than the interface: `new GitTier(path)` works, and it
// resolves the *repository's* root from a linked worktree.
test('git tier: storeRoot, not --show-toplevel — a worktree and the main checkout are one board', (t) => {
  const s = board();
  t.after(s.cleanup);
  const fromWorktree = new GitTier(s.wt, { host: 'test-host' });
  assert.equal(fs.realpathSync(fromWorktree.root), fs.realpathSync(s.root));
  const made = fromWorktree.createTask({ title: 'one board' });
  assert.equal(new GitTier(s.root, { host: 'test-host' }).getTask(made.number).title, 'one board');
});
