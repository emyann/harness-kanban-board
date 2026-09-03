// The local store as a whole (docs/local-first.md §6): the two tiers composed, the seam that picks
// it, the one-writer rule, `hkb sync`, and the migration off a GitHub board.
//
// The conformance suite (`test/store.test.js`) is what says the driver implements the interface —
// the local driver is registered there and runs every scenario. This file is for what is *about*
// the local store and cannot be asked of an interface: two clones of one board, a branch that has to
// fast-forward, a host that is not the owner, and an import that has to land somebody else's ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, storeKind, assertOwningHost } from '../src/store/index.js';
import { openLocalStore, importGithubBoard, mountFor, syncAfterTick, cardRecord, SYNC_THROTTLE_MS } from '../src/store/local.js';
import { openGitTier } from '../src/store/git.js';
import { DEFAULT_BOARD, hostId, readState } from '../src/board.js';
import { emptyRun, serializeResultComment, serializeRunComment } from '../src/model.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** A context of the shape `makeContext` builds, for a checkout at `root`. */
function ctxAt(root, { store = 'local', repo = null, board = 'default' } = {}) {
  return {
    root,
    cfg: { ...JSON.parse(JSON.stringify(DEFAULT_BOARD)), store, ...(repo ? { repo } : {}) },
    repo: repo ? { owner: repo.split('/')[0], repo: repo.split('/')[1], nameWithOwner: repo } : null,
    board, host: hostId(), json: false, caps: {}, _cache: {},
    requireBoard() { return this; },
  };
}

/** A scratch repository with a bare `origin` beside it, and one commit on `main`. */
function scratch(t, { name = 'work' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, name);
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  return { dir, origin, root };
}

/** A board on the local store in a scratch repo, opened through the seam. */
function board(t, opts = {}) {
  const s = scratch(t, opts);
  const ctx = ctxAt(s.root, opts);
  openGitTier(ctx).init(ctx.board);
  const store = openStore(ctx);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  return { ...s, ctx, store };
}

// ---------- the seam ----------

test('openStore picks the local driver from board.json, and from the branch when nothing says', (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root, { store: undefined });
  delete ctx.cfg.store;
  assert.equal(storeKind(ctx), 'github', 'no branch and no declaration: the board is where it has always been');

  openGitTier(ctx).init('default');
  ctx._cache = {};
  assert.equal(storeKind(ctx), 'local', 'a kb-board branch is a local board, with no config at all');

  ctx.cfg.store = 'github';
  assert.equal(storeKind(ctx), 'github', 'and a declaration beats the branch');

  ctx.cfg.store = 'sqlite';
  assert.throws(() => storeKind(ctx), (e) => e.exitCode === 2 && /not a store/.test(e.message));
});

test('the local store composes both tiers: the branch is durable, the index is live', (t) => {
  const { store } = board(t);
  const card = store.createTask({ title: 'ship it', status: 'ready', agent: 'claude', kb: { priority: 2 } });
  assert.equal(store.git.getTask(card.number).title, 'ship it', 'the card is on the branch');
  assert.equal(store.index.getTaskRow(card.number).title, 'ship it', 'and indexed');
  assert.equal(store.index.tip(), store.git.tip(), 'the index records the commit it was built from');

  const { token } = store.claim(card.number, 1);
  assert.ok(token);
  assert.deepEqual(store.index.listLocks().map((l) => l.n), [card.number], 'the lock is a row, not a commit');
  const tip = store.git.tip();
  store.heartbeat(card.number, 1, token);
  assert.equal(store.git.tip(), tip, 'a beat never moves the branch');
});

test('open() rebuilds the index when the branch moved behind it', (t) => {
  const { ctx, store } = board(t);
  const card = store.createTask({ title: 'written elsewhere', status: 'ready' });
  // The branch moves with the index untouched — a crash between the commit and the index write,
  // which is the case §6.1 says `open()` exists to repair. (Two *stores* in one repo share the
  // index file, so a second store would have updated it: the tier alone is what leaves it behind.)
  openGitTier(ctx).setStatus(card, 'blocked');

  store.git.forget();
  assert.equal(store.index.getTaskRow(card.number).status, 'ready', 'the stale index still says what it indexed');
  const r = store.open();
  assert.equal(r.loaded, true);
  assert.equal(store.index.getTaskRow(card.number).status, 'blocked');
  assert.equal(store.index.tip(), store.git.tip());
  assert.equal(store.open().loaded, false, 'and a second open on an unmoved branch reads one row and stops');
});

test('a durable write commits, then indexes, then appends exactly one event', (t) => {
  const { store } = board(t);
  const before = store.events({ after: 0, limit: 1000 }).length;
  const card = store.createTask({ title: 'one', status: 'ready' });
  const after = store.events({ after: 0, limit: 1000 });
  assert.equal(after.length, before + 1);
  assert.deepEqual([after.at(-1).kind, after.at(-1).number], ['appeared', card.number]);

  // A write that decides nothing lands no commit — and so says nothing, and wakes nobody.
  const tip = store.git.tip();
  store.setStatus(card, 'ready');
  assert.equal(store.git.tip(), tip);
  assert.equal(store.events({ after: 0, limit: 1000 }).length, after.length, 'a no-op verb is not an event');
});

// ---------- one writer (§6.2) ----------

test('a mutating verb on a host that is not the board\'s is refused, naming --take-over', (t) => {
  const { ctx, store } = board(t);
  store.createTask({ title: 'theirs', status: 'ready' });
  const foreign = openLocalStore(ctx, { host: 'someone-elses-laptop' });
  t.after(() => foreign.close());

  assert.equal(foreign.owns(), false);
  assert.deepEqual(foreign.listTasks().map((x) => x.title), ['theirs'], 'a foreign host still reads the whole board');
  assert.throws(() => foreign.assertOwner('dispatch'), (e) => e.exitCode === 2 && /hkb init --take-over/.test(e.message) && /one writer/.test(e.message));
  // A real write is refused too, by the tier, whether or not anything asked first.
  assert.throws(() => foreign.setStatus(foreign.getTask(foreign.listTasks()[0].number), 'done'), (e) => e.exitCode === 2 && /one writer/.test(e.message));

  // and the guard the CLI puts in front of every mutating verb says the same thing, one step earlier
  assert.throws(
    () => assertOwningHost({ ...ctx, host: 'someone-elses-laptop', _cache: {} }, 'claim'),
    (e) => e.exitCode === 2 && /hkb claim/.test(e.message) && /hkb init --take-over/.test(e.message),
  );
  assert.equal(assertOwningHost(ctx, 'claim'), null, 'and says nothing on the host that owns it');
});

test('--take-over moves the owning host, and refuses while the old one is still ticking', (t) => {
  const { ctx, store } = board(t);
  const clock = { at: new Date('2026-09-03T12:00:00Z') };
  const foreign = openLocalStore(ctx, { host: 'laptop-b', now: () => clock.at });
  t.after(() => foreign.close());

  // The owning host stamps itself on the branch every few minutes while its loop runs.
  store.git.setBoard({ dispatch: { host: store.host, pid: 4242, at: '2026-09-03T11:59:00Z' } });
  foreign.git.forget();
  assert.throws(() => foreign.takeOver(), (e) => e.exitCode === 2 && /still running a dispatcher/.test(e.message) && /--take-over --force/.test(e.message));

  // Twenty minutes later that stamp says nothing about a laptop that is on a train.
  clock.at = new Date('2026-09-03T12:20:00Z');
  const moved = foreign.takeOver();
  assert.equal(moved.changed, true);
  assert.equal(moved.was, store.host);
  store.git.forget();
  assert.equal(store.board().host, 'laptop-b', 'and the branch says so, for every clone');
  assert.throws(() => store.setStatus(store.listTasks()[0] || { number: 1 }, 'done'), (e) => e.exitCode === 2);
});

test('--take-over --force overrides a fresh stamp', (t) => {
  const { ctx, store } = board(t);
  store.git.setBoard({ dispatch: { host: store.host, pid: 1, at: new Date().toISOString() } });
  const foreign = openLocalStore(ctx, { host: 'laptop-b' });
  t.after(() => foreign.close());
  assert.equal(foreign.takeOver({ force: true }).changed, true);
});

test('markDispatcher stamps once, then holds off — it is a commit, not a heartbeat', (t) => {
  const { store } = board(t);
  const clock = { at: new Date('2026-09-03T12:00:00Z') };
  store.now = () => clock.at;
  assert.equal(store.markDispatcher(99).stamped, true);
  const tip = store.git.tip();
  clock.at = new Date('2026-09-03T12:01:00Z');
  assert.equal(store.markDispatcher(99).stamped, false, 'a minute later there is nothing to say');
  assert.equal(store.git.tip(), tip);
  clock.at = new Date('2026-09-03T12:30:00Z');
  assert.equal(store.markDispatcher(99).stamped, true);
});

// ---------- sync (§6.2) ----------

test('sync pushes the branch, and a clone reads the same cards read-only', (t) => {
  const { dir, origin, ctx, store } = board(t);
  const a = store.createTask({ title: 'first', status: 'ready', agent: 'claude' });
  store.createTask({ title: 'second', status: 'todo' });

  const pushed = store.sync();
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.local, git(origin, 'rev-parse', 'refs/heads/kb-board'), 'origin has the board');
  assert.equal(store.sync().pushed, false, 'a second sync has nothing to push');

  // A friend clones. No .kanban/board.json of their own, no local kb-board — just the remote copy.
  const clone = path.join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  const theirCtx = ctxAt(clone, { store: undefined });
  delete theirCtx.cfg.store;
  assert.equal(storeKind(theirCtx), 'local', 'the branch alone says which store this is');
  const theirs = openStore(theirCtx);
  t.after(() => theirs.close());
  assert.deepEqual(theirs.listTasks().map((x) => x.title).sort(), ['first', 'second']);
  assert.equal(theirs.getTask(a.number).agent, 'claude');

  // Read-only: there is no local ref to compare-and-swap against, and the message says how to get one.
  assert.throws(() => theirs.setStatus(theirs.getTask(a.number), 'done'), (e) => e.exitCode === 2 && /read-only copy/.test(e.message));
  void ctx;
});

test('sync fast-forwards a clone that has a local branch, and refuses a divergence', (t) => {
  const { dir, origin, store } = board(t);
  store.createTask({ title: 'first', status: 'ready' });
  store.sync();

  const clone = path.join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  git(clone, 'branch', 'kb-board', 'origin/kb-board');
  const theirCtx = ctxAt(clone);
  const theirs = openLocalStore(theirCtx, { host: hostId() });
  t.after(() => theirs.close());

  // The owner writes and pushes; the clone fast-forwards to it and sees the new card.
  store.createTask({ title: 'second', status: 'ready' });
  store.sync();
  const ff = theirs.sync({ push: false });
  assert.equal(ff.fastForwarded, true);
  assert.deepEqual(theirs.listTasks().map((x) => x.title).sort(), ['first', 'second']);

  // Now both sides write. The branch has one writer, so hkb refuses to guess which history is right.
  store.createTask({ title: 'owner wrote this', status: 'ready' });
  store.sync();
  theirs.git.commit((tree) => { tree.cards.set(999, { ...cardRecord({ number: 999, title: 'the clone wrote this', status: 'ready', kb: {} }) }); }, 'hkb: a second writer', { allowForeignHost: true });
  assert.throws(() => theirs.sync(), (e) => e.exitCode === 2 && /diverged/.test(e.message) && /one writer/.test(e.message));
});

test('sync is a no-op with no remote, and off when the board says so', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-local-noremote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main', dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  git(dir, 'add', 'a.txt'); git(dir, 'commit', '-qm', 'init');
  const ctx = ctxAt(dir);
  openGitTier(ctx).init('default');
  const store = openStore(ctx);
  t.after(() => store.close());
  assert.equal(store.sync().skipped, 'no-remote');

  store.setBoard({ settings: { sync: { push: false } } });
  assert.equal(store.sync().skipped, 'off');
});

test('the loop syncs after a tick that wrote, at most once a minute', (t) => {
  const { ctx, origin, store } = board(t);
  store.createTask({ title: 'first', status: 'ready' });
  const first = syncAfterTick(ctx, { store });
  assert.equal(first.synced, true);
  assert.equal(first.result.pushed, true);
  assert.equal(Number.isFinite(readState(store.root).sync_at), true, 'the stamp is this host\'s, in .kanban/state.json');

  store.createTask({ title: 'second', status: 'ready' });
  assert.equal(syncAfterTick(ctx, { store }).why, 'throttled');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/kb-board'), first.result.local, 'and nothing was pushed');

  const later = syncAfterTick(ctx, { store, now: Date.now() + SYNC_THROTTLE_MS + 1 });
  assert.equal(later.result.pushed, true);
});

// ---------- the migration (`hkb init --import`) ----------

/** A GitHub board with three cards, a run record, a result and a human comment. */
function seededGh() {
  const gh = new FakeGh({ baseSha: '0'.repeat(40) });
  gh.addIssue(kbIssue({
    number: 7, title: 'the parent', status: 'done', agent: 'claude', kb: { priority: 3, paths: ['src/a.js'] },
    run: runWith([{ attempt: 1, host: 'h', started_at: '2026-08-01T10:00:00Z', ended_at: '2026-08-01T11:00:00Z', outcome: 'completed' }]),
    comments: [serializeResultComment({ attempt: 1, summary: 'the parent landed', metadata: { pr: 12 } }), 'a human said this'],
    state: 'CLOSED', stateReason: 'COMPLETED', updatedAt: '2026-09-01T00:00:00Z',
  }));
  gh.addIssue(kbIssue({ number: 12, title: 'the child', status: 'ready', agent: 'claude', blockedBy: [7], kb: { priority: 1 } }));
  gh.addIssue(kbIssue({ number: 30, title: 'needs a person', status: 'blocked', needsHuman: true }));
  // Closed long ago: history, not board state.
  gh.addIssue(kbIssue({ number: 3, title: 'ancient', status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', updatedAt: '2025-01-01T00:00:00Z' }));
  return gh;
}

test('init --import moves a GitHub board onto the branch: ids, statuses, blockers, run records', async (t) => {
  const { root, ctx } = (() => { const s = scratch(t); return { ...s, ctx: ctxAt(s.root, { repo: 'o/r' }) }; })();
  const gh = seededGh();
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };
  ctx.cfg.repo = gh.nameWithOwner;

  const lines = [];
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, { store, log: (s) => lines.push(s), now: () => new Date('2026-09-03T00:00:00Z') });

  assert.equal(summary.cards, 3, 'two open, one closed inside the 90-day window; the 2025 one stays behind');
  assert.deepEqual(store.listTasks({ states: ['OPEN', 'CLOSED'] }).map((x) => x.number).sort((a, b) => a - b), [7, 12, 30]);

  // id = issue number, and the next card carries on from there rather than colliding with one.
  const created = store.createTask({ title: 'the first local card', status: 'triage' });
  assert.equal(created.number, 31);

  const child = store.getTask(12);
  assert.deepEqual([child.title, child.status, child.agent, child.kb.priority], ['the child', 'ready', 'claude', 1]);
  assert.deepEqual(child.blockedBy.map((b) => b.number), [7], 'blockers came across as blockers');
  assert.equal(store.getTask(30).needsHuman, true);

  const parent = store.getTask(7);
  assert.equal(parent.state, 'CLOSED');
  assert.deepEqual(parent.kb.paths, ['src/a.js']);
  const { run } = store.loadRun(7);
  assert.equal(run.attempts.length, 1, 'the run record came off the run comment');
  assert.equal(run.attempts[0].outcome, 'completed');
  assert.equal(store.latestResult(7).summary, 'the parent landed');
  assert.deepEqual(store.listNotes(7).map((n) => n.text), ['a human said this'], 'and a person\'s comment is a note, not a result');
  assert.deepEqual(store.parentResults(child).map((r) => r.result.summary), ['the parent landed']);

  assert.ok(lines.some((l) => /3 card\(s\)/.test(l)), `the import prints what it did: ${lines.join(' | ')}`);
  assert.ok(lines.some((l) => /run record 1\/3/.test(l)), 'and progress per card, since it is one read each');
  void root;
});

test('a second import is refused rather than overwriting a board that has been worked', async (t) => {
  const { ctx, store } = board(t, { repo: 'o/r' });
  const gh = seededGh();
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };
  await assert.rejects(
    () => importGithubBoard(ctx, { store }),
    (e) => e.exitCode === 2 && /already exists/.test(e.message) && /branch -D kb-board/.test(e.message),
  );
});

test('the import deletes the lock refs on the remote and the local beat chains', async (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = seededGh();
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };
  gh.refs.set('refs/kb/locks/12/1', { ref: 'refs/kb/locks/12/1', object: { sha: '1'.repeat(40) } });
  git(s.root, 'update-ref', 'refs/kb/locks/12/1', git(s.root, 'rev-parse', 'HEAD'));

  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, { store, log: () => {}, now: () => new Date('2026-09-03T00:00:00Z') });
  assert.equal(summary.locks, 1);
  assert.equal(summary.chains, 1);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/kb/locks/12/1'], { cwd: s.root }).status !== 0, true);
});

// ---------- a card's whole life on a local board ----------

test('create, claim, work and finish — the whole card, with nothing on GitHub', (t) => {
  const { origin, store } = board(t);
  const card = store.createTask({ title: 'do the thing', status: 'ready', agent: 'claude' });

  // claim: the lock and the open attempt are the index's, the status is the branch's
  const { result, token } = store.claim(card.number, 1, { profile: 'claude' });
  assert.equal(result, 'claimed');
  store.setStatus(card, 'running');
  const rec = store.loadRun(card.number);
  rec.run.attempts.push({ attempt: 1, profile: 'claude', host: store.host, started_at: '2026-09-03T10:00:00Z' });
  store.saveRun(card.number, rec);
  store.setAttempt(card.number, 1, { pid: 4242, wt: '.claude/worktrees/kb-1-1' });
  assert.equal(store.getAttempt(card.number, 1).pid, 4242, 'the live fields never reach the branch');
  assert.equal(store.heartbeat(card.number, 1, token).result, 'ok');

  // finish: the outcome and the result are durable, the lock is dropped
  const done = store.loadRun(card.number);
  done.run.attempts[0].ended_at = '2026-09-03T11:00:00Z';
  done.run.attempts[0].outcome = 'completed';
  store.saveRun(card.number, done);
  store.addNote(card.number, serializeResultComment({ attempt: 1, summary: 'landed', metadata: {} }));
  store.setStatus(card, 'done');
  store.closeTask(card.number, 'completed');
  assert.equal(store.release(card.number, 1), true);

  assert.deepEqual(store.listLocks(), []);
  assert.equal(store.getTask(card.number).status, 'done');
  assert.equal(store.latestResult(card.number).summary, 'landed');
  assert.equal(store.loadRun(card.number).run.attempts[0].outcome, 'completed');
  const kinds = store.events({ after: 0, limit: 100 }).map((e) => e.kind);
  for (const k of ['appeared', 'status', 'attempt', 'result', 'closed']) assert.ok(kinds.includes(k), `the log records ${k}: ${kinds.join(',')}`);

  // and the whole of it is one branch anyone can fetch
  store.sync();
  assert.equal(git(origin, 'rev-parse', 'refs/heads/kb-board'), store.git.tip());
  assert.match(git(origin, 'show', 'kb-board:cards/1.json'), /"status": "done"/);
});

// ---------- the mount probe (§6.3) ----------

test('mountFor answers with the longest mount point that is a prefix of the path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-mounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mounts');
  fs.writeFileSync(file, [
    '/dev/sda1 / ext4 rw,relatime 0 0',
    'C:\\ /mnt/c 9p rw,dirsync 0 0',
    'tmpfs /run/user/1000 tmpfs rw 0 0',
    'host /mnt/my\\040share cifs rw 0 0',
  ].join('\n') + '\n');

  assert.equal(mountFor('/home/me/code/.git/hkb', { mounts: file })?.type, 'ext4');
  assert.equal(mountFor('/mnt/c/Users/me/repo/.git/hkb', { mounts: file })?.type, '9p', 'the longer mount point wins over /');
  assert.equal(mountFor('/mnt/my share/repo', { mounts: file })?.type, 'cifs', 'a space in a mount point is \\040');
  assert.equal(mountFor('/mnt/cheese/repo', { mounts: file })?.type, 'ext4', '/mnt/c is not a prefix of /mnt/cheese');
  assert.equal(mountFor('/anything', { mounts: path.join(dir, 'nope') }), null, 'a host with no /proc/mounts says so');
});

// ---------- what the record on the branch has to look like ----------

test('cardRecord round-trips through the branch: hoisted columns, kb, labels, blockers', (t) => {
  const { store } = board(t);
  const task = {
    number: 42, title: 'imported', bodyText: 'the why', status: 'review', agent: 'codex',
    kb: { priority: 3, paths: ['src/x.js'], goal: 'ship', max_runtime: 4242, model: 'opus' },
    needsHuman: true, blockedBy: [{ number: 7 }], labels: ['kb:board:default', 'kb:status:review', 'kb:agent:codex', 'kb:needs-human', 'area:cli'],
    state: 'OPEN', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z',
  };
  store.git.commit((tree) => { tree.cards.set(42, cardRecord(task)); }, 'hkb: one imported card');
  store.open();

  const read = store.getTask(42);
  assert.deepEqual([read.number, read.title, read.status, read.agent, read.needsHuman], [42, 'imported', 'review', 'codex', true]);
  assert.equal(read.kb.priority, 3);
  assert.deepEqual(read.kb.paths, ['src/x.js']);
  assert.equal(read.kb.goal, 'ship');
  assert.equal(read.kb.max_runtime, 4242, 'every kb key that is not a column rides under `kb`');
  assert.equal(read.kb.model, 'opus');
  assert.match(read.bodyText, /the why/);
  assert.deepEqual(read.blockedBy.map((b) => b.number), [7]);
  assert.ok(read.labels.includes('area:cli'), 'a label that is not a column is kept');
  assert.equal(read.labels.filter((l) => l === 'kb:status:review').length, 1, 'and the ones that are columns are not doubled');
});

test('a run record written by the store is the same file the index reads back', (t) => {
  const { store } = board(t);
  const card = store.createTask({ title: 'a card', status: 'ready' });
  const rec = { run: { ...emptyRun(), failures: 2, attempts: [{ attempt: 1, profile: 'claude', host: 'h', started_at: '2026-09-01T00:00:00Z', ended_at: '2026-09-01T01:00:00Z', outcome: 'blocked', reason: 'needs_input' }] }, id: null };
  store.saveRun(card.number, rec);
  const row = store.index.getAttempt(card.number, 1);
  assert.equal(row.outcome, 'blocked');
  assert.equal(row.reason, 'needs_input');
  assert.equal(store.loadRun(card.number).run.failures, 2);
  void serializeRunComment;
});
