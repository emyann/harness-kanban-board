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
import { openStore, storeKind, assertOwningHost, forgetStore } from '../src/store/index.js';
import { gitTierFor } from '../src/store/local.js';
import { openLocalStore, importGithubBoard, adoptOpenIssues, liveDispatcher, dropGithubLeftovers, mountFor, syncAfterTick, cardRecord, SYNC_THROTTLE_MS, OFFLINE } from '../src/store/local.js';
import { openGitTier } from '../src/store/git.js';
import { syncPass, DURABLE_TICK_KEYS } from '../src/dispatch.js';
import { invocationWritesBoard } from '../src/cli.js';
import { DEFAULT_BOARD, hostId, readState, runGitAsync } from '../src/board.js';
import { emptyRun, serializeResultComment, serializeRunComment, RESULT_MARKER } from '../src/model.js';
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
  assert.equal(storeKind(ctx), 'github', 'and that answer is remembered — two rev-parse per verb for a board that can only ever be on GitHub is the cost of not remembering it');
  // `forgetStore` is the invalidation, and the only thing that creates the branch under a running
  // process — `hkb init` — calls it. That is the contract the cached negative rests on.
  forgetStore(ctx);
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
  // **Two** layers, and no third: `assertOwningHost` (below) in front of the verb, and the tier
  // inside the write. There was a `LocalStore.assertOwner()` between them that nothing in `src/`
  // ever called — a third copy of the sentence with no caller to keep it honest, and one that would
  // have refused a branchless board both other layers deliberately pass.
  assert.equal(typeof (/** @type {any} */ (foreign).assertOwner), 'undefined', 'no uncalled third guard');
  // A real write is refused too, by the tier, whether or not anything asked first.
  assert.throws(() => foreign.setStatus(foreign.getTask(foreign.listTasks()[0].number), 'done'), (e) => e.exitCode === 2 && /one writer/.test(e.message));

  // and the guard the CLI puts in front of every mutating verb says the same thing, one step earlier
  assert.throws(
    () => assertOwningHost({ ...ctx, host: 'someone-elses-laptop', _cache: {} }, 'claim'),
    (e) => e.exitCode === 2 && /hkb claim/.test(e.message) && /hkb init --take-over/.test(e.message),
  );
  assert.equal(assertOwningHost(ctx, 'claim'), null, 'and says nothing on the host that owns it');
});

test('the guard is on the invocation, not the noun: `hkb up --status` reads, so a clone may run it', () => {
  // `up` is on WRITES_BOARD because it starts a dispatcher, and refusing the whole verb meant
  // somebody who cloned a board owned by another host could not ask what was running on their own
  // machine — a command documented as pid files and liveness, no board read and no network.
  assert.equal(invocationWritesBoard('up', { status: true }), false);
  assert.equal(invocationWritesBoard('up', {}), true, 'and starting one still needs the owning host');
  // `--serve` is not the exception: it brings a dispatcher up alongside the web server. Serving a
  // clone read-only is `hkb serve`, which is not on the list at all.
  assert.equal(invocationWritesBoard('up', { serve: true }), true);
  assert.equal(invocationWritesBoard('serve', {}), false);
  assert.equal(invocationWritesBoard('claim', { status: true }), true, 'and the flag is not a skeleton key for every verb');
  // the same rule swept onto its other instance: a dry run gates every write behind the flag, so it
  // is how somebody holding a clone asks what this board would do next.
  assert.equal(invocationWritesBoard('dispatch', { 'dry-run': true }), false);
  assert.equal(invocationWritesBoard('dispatch', {}), true);
});

test('a board with no branch is nobody\'s: both layers pass, and owner() does not throw', (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root);
  const store = openLocalStore(ctx, { host: 'someone-elses-laptop' });
  t.after(() => store.close());
  // `owner()` used to go through `git.board()`, which throws `there is no kb-board branch` — while
  // `assertLocalOwner` returns null on the same checkout. The two guards must agree about a board
  // that does not exist yet, or a `hkb init` in a fresh clone is refused by one and passed by the other.
  assert.equal(store.owner(), null);
  assert.equal(store.owns(), true);
  assert.equal(assertOwningHost({ ...ctx, host: 'someone-elses-laptop' }, 'create'), null);
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

test('a stamp from the future is a live dispatcher, not an absent one', (t) => {
  // The two clocks being compared are on different hosts, so ordinary skew — a laptop a minute
  // ahead, an RTC that drifted — is the normal case. Reading a future stamp as "nobody is ticking"
  // failed the guard open in the one direction it must not: `--take-over` walking in while the
  // other host's loop is writing the branch.
  const { ctx, store } = board(t);
  const clock = { at: new Date('2026-09-03T12:00:00Z') };
  store.git.setBoard({ dispatch: { host: store.host, pid: 7, at: '2026-09-03T12:00:30Z' } });
  const foreign = openLocalStore(ctx, { host: 'laptop-b', now: () => clock.at });
  t.after(() => foreign.close());
  assert.throws(() => foreign.takeOver(), (e) => e.exitCode === 2 && /still running a dispatcher/.test(e.message));
  assert.equal(liveDispatcher(foreign.git._read().board, 'laptop-b', clock.at).age, 0, 'a negative age is clamped, not treated as absent');
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

test('sync pushes the branch, and a clone reads the same cards read-only', async (t) => {
  const { dir, origin, ctx, store } = board(t);
  const a = store.createTask({ title: 'first', status: 'ready', agent: 'claude' });
  store.createTask({ title: 'second', status: 'todo' });

  const pushed = await store.sync();
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.local, git(origin, 'rev-parse', 'refs/heads/kb-board'), 'origin has the board');
  assert.equal((await store.sync()).pushed, false, 'a second sync has nothing to push');

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

test('sync fast-forwards a clone that has a local branch, and refuses a divergence', async (t) => {
  const { dir, origin, store } = board(t);
  store.createTask({ title: 'first', status: 'ready' });
  await store.sync();

  const clone = path.join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  git(clone, 'branch', 'kb-board', 'origin/kb-board');
  const theirCtx = ctxAt(clone);
  const theirs = openLocalStore(theirCtx, { host: hostId() });
  t.after(() => theirs.close());

  // The owner writes and pushes; the clone fast-forwards to it and sees the new card.
  store.createTask({ title: 'second', status: 'ready' });
  await store.sync();
  const ff = await theirs.sync({ push: false });
  assert.equal(ff.fastForwarded, true);
  assert.deepEqual(theirs.listTasks().map((x) => x.title).sort(), ['first', 'second']);

  // Now both sides write. The branch has one writer, so hkb refuses to guess which history is right.
  store.createTask({ title: 'owner wrote this', status: 'ready' });
  await store.sync();
  theirs.git.commit((tree) => { tree.cards.set(999, { ...cardRecord({ number: 999, title: 'the clone wrote this', status: 'ready', kb: {} }) }); }, 'hkb: a second writer', { allowForeignHost: true });
  await assert.rejects(() => theirs.sync(), (e) => e.exitCode === 2 && /diverged/.test(e.message) && /one writer/.test(e.message));
});

test('sync is a no-op with no remote, and off when the board says so', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-local-noremote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main', dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  git(dir, 'add', 'a.txt'); git(dir, 'commit', '-qm', 'init');
  const ctx = ctxAt(dir);
  openGitTier(ctx).init('default');
  const store = openStore(ctx);
  t.after(() => store.close());
  assert.equal((await store.sync()).skipped, 'no-remote');

  store.setBoard({ settings: { sync: { push: false } } });
  assert.equal((await store.sync()).skipped, 'no-remote', 'no remote is still the first answer');
});

test('the loop syncs after a tick that wrote, at most once a minute', async (t) => {
  const { ctx, origin, store } = board(t);
  store.createTask({ title: 'first', status: 'ready' });
  const first = await syncAfterTick(ctx, { store });
  assert.equal(first.synced, true);
  assert.equal(first.result.pushed, true);
  assert.equal(Number.isFinite(readState(store.root).sync_at), true, 'the stamp is this host\'s, in .kanban/state.json');

  store.createTask({ title: 'second', status: 'ready' });
  assert.equal((await syncAfterTick(ctx, { store })).why, 'throttled');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/kb-board'), first.result.local, 'and nothing was pushed');

  const later = await syncAfterTick(ctx, { store, now: Date.now() + SYNC_THROTTLE_MS + 1 });
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

test('an idle tick still stamps: liveness is about the process, not about what it decided', async (t) => {
  // The rule the second review named, one level up from the instance. Gating the stamp on
  // `DURABLE_TICK_KEYS` meant a dispatcher idling on a quiet board stopped re-stamping, its
  // liveness expired after HOST_LIVE_MS, and another host's `hkb init --take-over` took a board it
  // was actively ticking — no `--force`, no warning. The push is what a decision buys; the stamp is
  // what being alive buys.
  const { ctx, store } = board(t);
  const empty = Object.fromEntries(DURABLE_TICK_KEYS.map((k) => [k, []]));
  await syncPass(ctx, empty, () => {});
  store.git.forget();
  assert.equal(store.git._read().board.dispatch.host, store.host, 'a tick that decided nothing still says "I am here"');
  assert.equal(store.git._read().board.dispatch.pid, process.pid);

  // and the throttle still holds: the stamp is a commit, not a heartbeat, so a second pass a
  // moment later writes nothing.
  const tip = store.git.tip();
  await syncPass(ctx, empty, () => {});
  store.git.forget();
  assert.equal(store.git.tip(), tip);

  // A GitHub board gets none of this, and does not pay the two rev-parse to find that out twice.
  const ghCtx = ctxAt(scratch(t, { name: 'gh' }).root, { store: 'github' });
  await syncPass(ghCtx, empty, () => { assert.fail('a GitHub board has no branch to stamp'); });
});

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

test('--import on a repo with no kb board adopts its open issues instead of importing nothing', async (t) => {
  // Two operations have always shared this flag, and the migration answered for both: its board
  // query filters on `kb:board:<slug>`, so a repository with unlabelled issues and no kb board
  // imported ZERO cards, logged `0 open card(s)` and created an empty board — while the README
  // promised the flag "pulls your existing open issues onto the board as triage".
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = new FakeGh({ baseSha: '0'.repeat(40) });
  gh.addIssue({ number: 4, title: 'a plain issue', body: 'no kb labels here', labels: ['bug'] });
  gh.addIssue({ number: 9, title: 'another', body: '', labels: [] });
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };
  ctx.cfg.repo = gh.nameWithOwner;

  const lines = [];
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, { store, log: (l) => lines.push(l), now: () => new Date('2026-09-03T00:00:00Z') });

  assert.equal(summary.mode, 'adopt', 'the summary says which of the two operations ran');
  assert.equal(summary.cards, 2);
  assert.ok(lines.some((l) => /no .*board on .* to migrate — adopting/.test(l)), `and so does the log: ${lines.join(' | ')}`);
  assert.deepEqual(store.listTasks().map((x) => [x.number, x.status]), [[4, 'triage'], [9, 'triage']]);
  assert.equal(store.getTask(4).title, 'a plain issue');
  assert.deepEqual(store.getTask(4).blockedBy, [], 'an issue that has never been on a board has no graph to erase');
  assert.equal(store.createTask({ title: 'the first real card' }).number, 10, 'and the ids carry on from the issues');
});

test('the adoption path skips pull requests and names its own page ceiling', async (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const lines = [];
  // Two full pages of the injected reader: the same shape as the migration's closed-card cap, and
  // the same answer — a ceiling that is not named reads as the whole repository.
  const page = (n) => Array.from({ length: 100 }, (_, i) => ({ number: n * 100 + i, title: `issue ${n}.${i}`, body: '', labels: [] }));
  const summary = await adoptOpenIssues(ctx, {
    store,
    log: (l) => lines.push(l),
    pages: 2,
    issues: (p) => (p === 1 ? [...page(1).slice(0, 99), { number: 999, title: 'a pull request', pull_request: {} }] : page(2)),
  });
  assert.equal(summary.cards, 199, 'the pull request is not an issue and never becomes a card');
  assert.equal(summary.issues_capped, true);
  assert.ok(lines.some((l) => /WARNING stopped at 2 page\(s\)/.test(l)), lines.join(' | '));
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

test('create, claim, work and finish — the whole card, with nothing on GitHub', async (t) => {
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
  await store.sync();
  assert.equal(git(origin, 'rev-parse', 'refs/heads/kb-board'), store.git.tip());
  assert.match(git(origin, 'show', 'kb-board:cards/1.json'), /"status": "done"/);
});

// ---------- the mount probe (§6.3) ----------

test('a malformed result body is a comment on both sides, not a result event nothing can read', (t) => {
  const { store } = board(t);
  const card = store.createTask({ title: 'handoff', status: 'running' });
  const before = store.events({ after: 0, limit: 1000 }).length;

  // The marker with no readable JSON block behind it. The tier files it as a note (the parse
  // failed); deciding the *event kind* on the marker alone announced a `result` on `hkb watch
  // --kinds result` and in serve's stream for a handoff `latestResult(n)` would never return.
  store.addNote(card.number, `${RESULT_MARKER}\n### Result — attempt 1\n\nno json block here`);
  const events = store.events({ after: 0, limit: 1000 });
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).kind, 'comment', 'one predicate, and both sides asked it');
  assert.equal(store.latestResult(card.number), null);
  assert.equal(store.listNotes(card.number).length, 1, 'and the note is still a note');

  // and a well-formed one is a result on both sides
  store.addNote(card.number, serializeResultComment({ attempt: 1, summary: 'landed', kind: 'result' }));
  assert.equal(store.events({ after: 0, limit: 1000 }).at(-1).kind, 'result');
  assert.equal(store.latestResult(card.number).summary, 'landed');
});

test('the beat-chain advice names the refs the code actually reads', async (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const lines = [];
  await dropGithubLeftovers(ctx, s.root, {
    log: (l) => lines.push(l),
    locks: { list: async () => [], release: async () => false },
    chains: { list: () => { throw new Error('for-each-ref refused'); }, drop: () => false },
  });
  const said = lines.join(' | ');
  assert.ok(/refs\/kb\/locks\//.test(said), `a beat chain lives on the lock's own ref name: ${said}`);
  assert.ok(!/refs\/kb\/beats\//.test(said), 'and never under a namespace that does not exist');
});

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

// ---------- what the round-2 review found: a local answer decided after the GitHub path ran ----------

test('the migration keeps the blockers of every open card, not only the tick lanes', async (t) => {
  // A repository WITHOUT the GraphQL blockedBy field: every list costs one REST call, and the
  // default `blockers: true` fills them in for todo/blocked only. A card in ready, review or
  // running would then arrive with an empty list that means "not asked", and the branch would
  // record it as "nothing blocks it" — the board's DAG, gone, on the one operation nobody re-runs.
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = new FakeGh({ baseSha: '0'.repeat(40), caps: { blockedByGql: false } });
  gh.addIssue(kbIssue({ number: 5, title: 'the blocker', status: 'ready' }));
  gh.addIssue(kbIssue({ number: 6, title: 'in review, and blocked', status: 'review', blockedBy: [5] }));
  gh.addIssue(kbIssue({ number: 8, title: 'waiting, and blocked', status: 'todo', blockedBy: [5] }));
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };
  ctx.cfg.repo = gh.nameWithOwner;

  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  await importGithubBoard(ctx, { store, log: () => {}, now: () => new Date('2026-09-03T00:00:00Z') });

  assert.deepEqual(store.getTask(8).blockedBy.map((b) => b.number), [5], 'a todo card, which the default would have filled in');
  assert.deepEqual(store.getTask(6).blockedBy.map((b) => b.number), [5], 'and a review card, which it would not');
});

test('cardRecord refuses to write "no blockers" for a card nobody looked up', () => {
  const task = { number: 9, title: 'x', status: 'ready', kb: {}, blockedBy: [], state: 'OPEN' };
  assert.throws(
    () => cardRecord(task, { blockersKnown: false }),
    (e) => e.exitCode === 2 && /never looked up/.test(e.message) && /blockers: "all"/.test(e.message),
  );
  assert.deepEqual(cardRecord(task, { blockersKnown: true }).blocked_by, [], 'and writes it when it is a real answer');
});

test('a closed card whose blockers cannot be read is imported and reported, not a dead end', async (t) => {
  // The refusal above needs a way through, or the migration dead-ends on the repo it is for. On a
  // repository WITHOUT the GraphQL blockedBy field there is no read at all that fills a *closed*
  // card's blockers in — `fetchClosedRecent` never calls the REST fill-in — so refusing there
  // aborted `hkb init --import` on the first closed card, with a message telling the operator to
  // re-read with `blockers: "all"`, which cannot fill a closed card's blockers either.
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = new FakeGh({ baseSha: '0'.repeat(40), caps: { blockedByGql: false } });
  gh.addIssue(kbIssue({ number: 3, title: 'open, and read properly', status: 'ready' }));
  gh.addIssue(kbIssue({ number: 4, title: 'settled last week', status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', updatedAt: '2026-09-01T00:00:00Z' }));
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };

  const lines = [];
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, { store, log: (l) => lines.push(l), now: () => new Date('2026-09-03T00:00:00Z') });

  assert.deepEqual(summary.cards, 2, 'the migration completes');
  assert.deepEqual(summary.unknown_blockers, [4], 'and the summary names every card it could not read');
  assert.ok(lines.some((l) => /blockers UNKNOWN, not empty/.test(l) && /#4/.test(l)), `said out loud: ${lines.join(' | ')}`);
  assert.equal(store.git._read().cards.get(4).blockers_unknown, true, 'the branch records that nobody looked, rather than "nothing blocks it"');
  assert.equal(store.git._read().cards.get(3).blockers_unknown, undefined, 'an open card was read properly and is not marked');

  // and an OPEN card is still a refusal: there a better read exists, and the edges decide whether
  // the card can ever be dispatched again.
  assert.throws(
    () => cardRecord({ number: 9, title: 'x', status: 'ready', kb: {}, blockedBy: [], state: 'OPEN' }, { blockersKnown: false }),
    (e) => e.exitCode === 2,
  );
});

test('a blocker that is not imported is dropped, said out loud, and does not block the card forever', async (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = new FakeGh({ baseSha: '0'.repeat(40) });
  // #40 is open and blocked by #11, closed 200 days ago — outside the 90-day window, so it is not
  // imported. Keeping the edge would leave #40 blocked by an id that reads back as an open issue
  // nobody can close: `blockerDone()` false forever, `computeReady()` never true, #40 undispatchable.
  gh.addIssue(kbIssue({ number: 11, title: 'ancient blocker', status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', updatedAt: '2025-06-01T00:00:00Z' }));
  gh.addIssue(kbIssue({ number: 40, title: 'the child', status: 'todo', blockedBy: [11] }));
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };

  const lines = [];
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, { store, log: (l) => lines.push(l), now: () => new Date('2026-09-03T00:00:00Z') });

  assert.deepEqual(summary.dropped_blockers, [{ card: 40, blocker: 11 }], 'the summary says which edge went');
  assert.ok(lines.some((l) => /#40 was blocked by #11/.test(l) && /dropped/.test(l)), `and so does the output: ${lines.join(' | ')}`);
  assert.deepEqual(store.getTask(40).blockedBy, [], 'and #40 is not held back by a card that is not there');
});

test('the closed-card page is a cap, and the import says so rather than reading as the whole window', async (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = new FakeGh({ baseSha: '0'.repeat(40) });
  gh.addIssue(kbIssue({ number: 1, title: 'open', status: 'ready' }));
  for (let i = 0; i < 100; i++) {
    gh.addIssue(kbIssue({ number: 200 + i, title: `closed ${i}`, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', updatedAt: '2026-09-01T00:00:00Z' }));
  }
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };

  const lines = [];
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, { store, log: (l) => lines.push(l), now: () => new Date('2026-09-03T00:00:00Z') });
  assert.equal(summary.closed_capped, true);
  assert.equal(summary.closed_page, 100);
  assert.ok(lines.some((l) => /WARNING/.test(l) && /one page of 100/.test(l)), `the cap is named: ${lines.join(' | ')}`);
});

test('a lock ref that will not delete does not fail a migration that landed', async (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = seededGh();
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };

  const lines = [];
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, {
    store, log: (l) => lines.push(l), now: () => new Date('2026-09-03T00:00:00Z'),
    leftovers: {
      locks: { list: () => { throw new Error('the remote said no'); }, release: () => true },
      chains: { list: () => { throw new Error('refs/kb/beats is locked'); }, drop: () => true },
    },
  });
  assert.equal(summary.cards, 3, 'the board migrated');
  assert.equal(summary.locks, 0);
  assert.equal(summary.chains, 0);
  assert.ok(lines.some((l) => /lock refs on the remote were left alone/.test(l)));
  assert.ok(lines.some((l) => /beat chains were left alone/.test(l)));
});

test('sync fetches a board this checkout does not have a branch for yet', async (t) => {
  // The friend's clone: `git clone --single-branch`, so `origin/kb-board` is not even here. Reading
  // the board document first threw "there is no kb-board branch" at the exact person who ran the
  // command to go and get one — and `hkb init` there then made a second, empty board.
  const { dir, origin, store } = board(t);
  store.createTask({ title: 'the owner made this', status: 'ready' });
  await store.sync();

  const clone = path.join(dir, 'thin');
  git(dir, 'clone', '-q', '--single-branch', '--branch', 'main', origin, clone);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/kb-board'], { cwd: clone }).status !== 0, true, 'the clone really has no copy of the branch');
  fs.mkdirSync(path.join(clone, '.kanban'), { recursive: true });

  const theirs = openLocalStore(ctxAt(clone), { reconcile: false });
  t.after(() => theirs.close());
  const r = await theirs.sync();
  assert.equal(r.fastForwarded, true, `sync brought the board in: ${r.detail}`);
  assert.deepEqual(theirs.listTasks().map((x) => x.title), ['the owner made this']);
});

test('sync.push false turns off the push and nothing else, and --no-push cannot do more than the default', async (t) => {
  const { dir, origin, root, store } = board(t);
  store.setBoard({ settings: { sync: { push: false } } });
  store.createTask({ title: 'first', status: 'ready' });

  // The push half is off: nothing this host decided reaches the remote.
  const off = await store.sync();
  assert.equal(off.skipped, 'off');
  assert.equal(off.pushed, false);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/kb-board'], { cwd: origin }).status !== 0, true, 'origin has no board at all');

  // The fetch half is NOT. A checkout that does not publish its copy still has to be able to read
  // what another host published — that is the whole of what `hkb sync` is for on a reader's clone.
  git(root, 'push', '-q', origin, 'kb-board:kb-board');
  const other = path.join(dir, 'other');
  git(dir, 'clone', '-q', origin, other);
  const theirs = git(other, 'commit-tree', git(other, 'rev-parse', 'origin/kb-board^{tree}'), '-p', git(other, 'rev-parse', 'origin/kb-board'), '-m', 'hkb: somebody else decided something');
  git(other, 'push', '-q', origin, `${theirs}:refs/heads/kb-board`);

  const r = await store.sync();
  assert.equal(r.fastForwarded, true, `push: false must not disable the fetch — ${r.detail}`);
  assert.equal(r.pushed, false);
  assert.equal(store.git.tip(), theirs, 'and the branch here is what the remote said');

  // And the flag is the same switch, so the more restrictive spelling cannot do strictly more work.
  const noPush = await store.sync({ push: false });
  assert.equal(noPush.pushed, false);
  assert.equal(noPush.offline, false);
});

test('the dispatcher stamp leaves the index level with the branch', async (t) => {
  const clock = { at: new Date('2026-09-03T12:00:00Z') };
  const { root } = scratch(t, { name: 'stamped' });
  const ctx = ctxAt(root);
  openGitTier(ctx).init('default');
  const store = openLocalStore(ctx, { now: () => clock.at });
  t.after(() => store.close());

  assert.equal(store.markDispatcher(4242).stamped, true);
  assert.equal(store.index.tip(), store.git.tip(), 'a stamp that is not indexed is a permanent `hkb doctor` warning on a healthy board');
  assert.match(git(root, 'log', '-1', '--format=%s', 'kb-board'), /dispatcher on host/, 'and the log says what the commit is');
});

test('OFFLINE reads a git that never answered as offline, not as a broken remote', () => {
  for (const said of [
    'spawn git ETIMEDOUT after 15000ms',
    'fatal: unable to access \'https://example/\': Connection timed out after 30001 milliseconds',
    'ssh: connect to host example port 22: Connection refused',
    'fatal: unable to access \'https://example/\': getaddrinfo() thread failed to start: EAI_AGAIN',
    'error: RPC failed; ECONNRESET',
  ]) assert.equal(OFFLINE.test(said), true, said);
  assert.equal(OFFLINE.test('! [rejected] kb-board -> kb-board (non-fast-forward)'), false, 'a divergence is not a network');
});

test('mountFor keeps the LAST of two entries on one mount point', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-mounts2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mounts');
  // `/proc/mounts` is in mount order. A network filesystem remounted over a local path is exactly
  // what the probe exists to catch, and keeping the first entry reads it as the ext4 underneath.
  fs.writeFileSync(file, [
    '/dev/sda1 / ext4 rw 0 0',
    '/dev/sdb1 /work ext4 rw 0 0',
    'server:/export /work nfs4 rw 0 0',
  ].join('\n') + '\n');
  assert.equal(mountFor('/work/repo/.git/hkb', { mounts: file })?.type, 'nfs4');
});

test('the network git runs off the event loop, and a git that never answers reads as offline', async (t) => {
  const { root } = scratch(t, { name: 'async' });
  // 10.255.255.1 is not routable, so this hangs rather than failing fast — which is the case that
  // matters: `spawnSync` would hold the dispatcher's loop for the whole timeout, and while it did,
  // a finished worker's exit handler could not fire, the sleeper could not be woken and `hkb down`'s
  // SIGTERM would not be handled.
  let tickedWhileGitRan = 0;
  const beat = setInterval(() => { tickedWhileGitRan++; }, 20);
  const r = await runGitAsync(root, ['ls-remote', 'https://10.255.255.1/nothing.git'], { timeout: 400 });
  clearInterval(beat);

  assert.notEqual(r.status, 0);
  assert.ok(tickedWhileGitRan > 0, 'timers kept firing while git was out on the network');
  assert.equal(OFFLINE.test(r.out), true, `a git that never answered is offline, not a broken remote: ${r.out}`);
});

test('the one-writer guard and the verb behind it share one decoded tree', (t) => {
  // `assertOwningHost` opened a tier to read one string out of board.json and threw the memo away;
  // the verb behind it then opened the store and decoded the whole board again. Two `ls-tree -r`
  // plus two `cat-file --batch` per `hkb create`, on every card of the board.
  const { ctx, store } = board(t);
  store.createTask({ title: 'a card', status: 'ready' });

  assert.equal(assertOwningHost(ctx, 'create'), null, 'this host owns it');
  const second = openStore(ctx);
  t.after(() => { try { second.close(); } catch { /* already closed */ } });
  assert.equal(second.git, store.git, 'one tier per context, so one decode');
  assert.equal(gitTierFor(ctx, { host: ctx.host }), store.git);

  // A caller with its own clock is a test, and never gets — or poisons — the shared one.
  const withClock = gitTierFor(ctx, { host: ctx.host, now: () => new Date('2020-01-01T00:00:00Z') });
  assert.notEqual(withClock, store.git);
  assert.equal(gitTierFor(ctx, { host: ctx.host }), store.git, 'and the shared tier is still the shared tier');
});
