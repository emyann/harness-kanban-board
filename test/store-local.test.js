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
import { syncPass, loop, DURABLE_TICK_KEYS } from '../src/dispatch.js';
import { invocationWritesBoard } from '../src/cli.js';
import { DEFAULT_BOARD, hostId, readState, writeState, runGitAsync, storeGitDir } from '../src/board.js';
import { indexFileIn } from '../src/store/sqlite.js';
import { emptyRun, serializeResultComment, RESULT_MARKER } from '../src/model.js';
import { runComment as serializeRunComment } from './fake-gh.js';
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
async function board(t, opts = {}) {
  const s = scratch(t, opts);
  const ctx = ctxAt(s.root, opts);
  openGitTier(ctx).init(ctx.board);
  const store = await openStore(ctx);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  return { ...s, ctx, store };
}

// ---------- the seam ----------

test('the store is what board.json says, and a kb-board branch never decides it', async (t) => {
  // **The rule this file exists to hold now.** `storeKind` used to have a second rule — a repository
  // with a `kb-board` (or `origin/kb-board`) ref is a local board — so that a clone needed no
  // config. It is gone, because a rule that reads the store off a *ref* is reachable by `git fetch`:
  // another host's push, a colleague's experiment, a branch pulled in by accident, and the checkout
  // flips onto the local store while `.kanban/board.json` still points every verb at GitHub. Three
  // successive reviews found a different destructive interaction in that half-migrated state (an
  // import that deleted live workers' lock refs; a gc that read `[]` and destroyed worker worktrees;
  // collaborators refused every write verb on a board of issues they own). One cause, one fix.
  const s = scratch(t);
  const ctx = ctxAt(s.root, { store: undefined });
  delete ctx.cfg.store;
  assert.equal(storeKind(ctx), 'github', 'no declaration: the board is where it has always been');

  openGitTier(ctx).init('default');
  assert.equal(storeKind(ctx), 'github', 'and a branch appearing under the checkout does not move it');
  // The invalidation that remains is about the memoized *tree*, not about a cached answer: there is
  // no cached answer any more, because there is nothing to work out.
  await forgetStore(ctx);
  assert.equal(storeKind(ctx), 'github', 'still — only the key decides');

  ctx.cfg.store = 'local';
  assert.equal(storeKind(ctx), 'local', 'the key, and nothing else');
  ctx.cfg.store = 'github';
  assert.equal(storeKind(ctx), 'github');

  ctx.cfg.store = 'sqlite';
  assert.throws(() => storeKind(ctx), (e) => e.exitCode === 2 && /not a store/.test(e.message));
});

test('a fetched kb-board branch cannot convert a collaborator, and cannot make gc destructive', async (t) => {
  // The end-to-end shape of the finding above, on the two verbs it reached: one host publishes the
  // branch, everybody else fetches it, and on their checkouts nothing at all changes.
  const s = scratch(t);
  const ctx = ctxAt(s.root, { store: undefined });
  delete ctx.cfg.store;
  // The branch arrives the way it really would: on the remote-tracking ref, from a fetch.
  const publisher = ctxAt(s.root, {});
  openGitTier(publisher).init('default');
  git(s.root, 'push', '-q', 'origin', 'kb-board');
  git(s.root, 'update-ref', 'refs/remotes/origin/kb-board', git(s.root, 'rev-parse', 'kb-board'));
  git(s.root, 'branch', '-D', 'kb-board');

  assert.equal(storeKind(ctx), 'github', 'a branch on the remote is not a store');
  const store = await openStore(ctx);
  assert.equal(store.kind, 'github', 'and openStore hands back the driver the verbs are using');
  // The write guard follows: a collaborator is not refused `hkb create` on a board of issues they
  // have always been able to write.
  assert.equal(await assertOwningHost({ ...ctx, host: 'someone-elses-laptop' }, 'create'), null);
});

test('the local store composes both tiers: the branch is durable, the index is live', async (t) => {
  const { store } = await board(t);
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

test('open() rebuilds the index when the branch moved behind it', async (t) => {
  const { ctx, store } = await board(t);
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

test('a durable write commits, then indexes, then appends exactly one event', async (t) => {
  const { store } = await board(t);
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

test('a mutating verb on a host that is not the board\'s is refused, naming --take-over', async (t) => {
  const { ctx, store } = await board(t);
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
  await assert.rejects(
    () => assertOwningHost({ ...ctx, host: 'someone-elses-laptop', _cache: {} }, 'claim'),
    (e) => e.exitCode === 2 && /hkb claim/.test(e.message) && /hkb init --take-over/.test(e.message),
  );
  assert.equal(await assertOwningHost(ctx, 'claim'), null, 'and says nothing on the host that owns it');
});

test('the guard is on the invocation, not the noun: `hkb up --status` reads, so a clone may run it', () => {
  // `up` is on WRITES_BOARD because it starts a dispatcher, and refusing the whole verb meant
  // somebody who cloned a board owned by another host could not ask what was running on their own
  // machine — a command documented as pid files and liveness, no board read and no network.
  assert.equal(invocationWritesBoard('up', { status: true }), false);
  assert.equal(invocationWritesBoard('up', {}), true, 'and starting one still needs the owning host');
  // `--serve` is not the exception: it brings a dispatcher up alongside the web server. Nor is
  // `hkb serve` on its own — the web board's drag-and-drop runs the same mutating verbs, so a
  // non-owning host got a writable UI whose every drag died inside the tier with a raw exit 2.
  assert.equal(invocationWritesBoard('up', { serve: true }), true);
  assert.equal(invocationWritesBoard('serve', {}), true);
  assert.equal(invocationWritesBoard('claim', { status: true }), true, 'and the flag is not a skeleton key for every verb');
  // the same rule swept onto its other instance: a dry run gates every write behind the flag, so it
  // is how somebody holding a clone asks what this board would do next.
  assert.equal(invocationWritesBoard('dispatch', { 'dry-run': true }), false);
  assert.equal(invocationWritesBoard('dispatch', {}), true);
  // …but not when it is a *loop*: that stamps this host onto the branch and pushes it every few
  // minutes, which no per-tick flag gates. The exemption is for the one-shot read, not the daemon.
  assert.equal(invocationWritesBoard('dispatch', { 'dry-run': true, loop: 30 }), true);
  assert.equal(invocationWritesBoard('dispatch', { 'dry-run': true, loop: true }), true);
});

test('a board with no branch is nobody\'s: both layers pass, and owner() does not throw', async (t) => {
  const s = scratch(t);
  const ctx = ctxAt(s.root);
  const store = openLocalStore(ctx, { host: 'someone-elses-laptop' });
  t.after(() => store.close());
  // `owner()` used to go through `git.board()`, which throws `there is no kb-board branch` — while
  // `assertLocalOwner` returns null on the same checkout. The two guards must agree about a board
  // that does not exist yet, or a `hkb init` in a fresh clone is refused by one and passed by the other.
  assert.equal(store.owner(), null);
  assert.equal(store.owns(), true);
  assert.equal(await assertOwningHost({ ...ctx, host: 'someone-elses-laptop' }, 'create'), null);
});

test('--take-over moves the owning host, and refuses while the old one is still ticking', async (t) => {
  const { ctx, store } = await board(t);
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

test('a stamp from the future is a live dispatcher, not an absent one', async (t) => {
  // The two clocks being compared are on different hosts, so ordinary skew — a laptop a minute
  // ahead, an RTC that drifted — is the normal case. Reading a future stamp as "nobody is ticking"
  // failed the guard open in the one direction it must not: `--take-over` walking in while the
  // other host's loop is writing the branch.
  const { ctx, store } = await board(t);
  const clock = { at: new Date('2026-09-03T12:00:00Z') };
  store.git.setBoard({ dispatch: { host: store.host, pid: 7, at: '2026-09-03T12:00:30Z' } });
  const foreign = openLocalStore(ctx, { host: 'laptop-b', now: () => clock.at });
  t.after(() => foreign.close());
  assert.throws(() => foreign.takeOver(), (e) => e.exitCode === 2 && /still running a dispatcher/.test(e.message));
  assert.equal(liveDispatcher(foreign.git._read().board, 'laptop-b', clock.at).age, 0, 'a negative age is clamped, not treated as absent');
});

test('--take-over --force overrides a fresh stamp', async (t) => {
  const { ctx, store } = await board(t);
  store.git.setBoard({ dispatch: { host: store.host, pid: 1, at: new Date().toISOString() } });
  const foreign = openLocalStore(ctx, { host: 'laptop-b' });
  t.after(() => foreign.close());
  assert.equal(foreign.takeOver({ force: true }).changed, true);
});

test('markDispatcher stamps once, then holds off — it is a commit, not a heartbeat', async (t) => {
  const { store } = await board(t);
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
  const { dir, origin, ctx, store } = await board(t);
  const a = store.createTask({ title: 'first', status: 'ready', agent: 'claude' });
  store.createTask({ title: 'second', status: 'todo' });

  const pushed = await store.sync();
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.local, git(origin, 'rev-parse', 'refs/heads/kb-board'), 'origin has the board');
  assert.equal((await store.sync()).pushed, false, 'a second sync has nothing to push');

  // A friend clones. No .kanban/board.json of their own, no local kb-board — just the remote copy.
  const clone = path.join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
  // Their `.kanban/board.json` is the repository's own — it is a tracked file, and the `"store"`
  // key rode in with the clone. **That** is what makes "a friend clones the repo and has the board"
  // work, and it is more deterministic than the rule it replaced: the store no longer depends on
  // which refs a particular clone happens to carry (`--single-branch`, a stale fetch, a mirror).
  const theirCtx = ctxAt(clone);
  assert.equal(theirCtx.cfg.store, 'local');
  assert.equal(storeKind(theirCtx), 'local', 'the tracked key says which store this is');
  const theirs = await openStore(theirCtx);
  t.after(() => theirs.close());
  assert.deepEqual(theirs.listTasks().map((x) => x.title).sort(), ['first', 'second']);
  assert.equal(theirs.getTask(a.number).agent, 'claude');

  // Read-only: there is no local ref to compare-and-swap against, and the message says how to get one.
  assert.throws(() => theirs.setStatus(theirs.getTask(a.number), 'done'), (e) => e.exitCode === 2 && /read-only copy/.test(e.message));
  void ctx;
});

test('sync fast-forwards a clone that has a local branch, and refuses a divergence', async (t) => {
  const { dir, origin, store } = await board(t);
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
  const store = await openStore(ctx);
  t.after(() => store.close());
  assert.equal((await store.sync()).skipped, 'no-remote');

  store.setBoard({ settings: { sync: { push: false } } });
  assert.equal((await store.sync()).skipped, 'no-remote', 'no remote is still the first answer');
});

test('the loop syncs after a tick that wrote, at most once a minute', async (t) => {
  const { ctx, origin, store } = await board(t);
  store.createTask({ title: 'first', status: 'ready' });
  const first = await syncAfterTick(ctx, { store });
  assert.equal(first.synced, true);
  assert.equal(first.result.pushed, true);
  assert.equal(Number.isFinite(readState(store.root()).sync_at), true, 'the stamp is this host\'s, in .kanban/state.json');

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
  const { ctx, store } = await board(t);
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

test('a repository with exactly a whole number of pages is not told cards were left off', async (t) => {
  // **A ceiling is only real if there is something above it.** `more = page === pages` called the
  // last *full* page a truncation, so a repository with exactly `pages × 100` open issues — every
  // one of them adopted — was warned that it had more that were not on the board. A full page says
  // nothing about whether a next one exists, so the next one is read, and that is the answer.
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const lines = [];
  const page = (n) => Array.from({ length: 100 }, (_, i) => ({ number: n * 100 + i, title: `issue ${n}.${i}`, body: '', labels: [] }));
  const asked = [];
  const summary = await adoptOpenIssues(ctx, {
    store,
    log: (l) => lines.push(l),
    pages: 2,
    issues: (p) => { asked.push(p); return p <= 2 ? page(p) : []; },
  });
  assert.equal(summary.cards, 200, 'both pages adopted');
  assert.equal(summary.issues_capped, false, 'and nothing was left off, so nothing is claimed to be');
  assert.deepEqual(asked, [1, 2, 3], 'the page after the last full one is what settles it');
  assert.equal(lines.some((l) => /WARNING stopped at/.test(l)), false);
});

test('a second import is refused rather than overwriting a board that has been worked', async (t) => {
  const { ctx, store } = await board(t, { repo: 'o/r' });
  const gh = seededGh();
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };
  await assert.rejects(
    () => importGithubBoard(ctx, { store }),
    (e) => e.exitCode === 2 && /already exists/.test(e.message) && /branch -D kb-board/.test(e.message),
  );
});

test('the import\'s refusal does not create the index it names', async (t) => {
  // **A diagnosis does not create what it describes**, and neither does a refusal. The message
  // reads `rm -f <index.db>*`, and it used to reach that path through the store's lazy `index`
  // getter — which `mkdir`s the directory, creates the file and runs the schema. So a refusal whose
  // whole point is to leave the board untouched created a database, leaked its connection, and on a
  // node without `node:sqlite` threw a different error in place of this sentence. Same shape as the
  // one `hkb doctor` had.
  const sc = scratch(t);
  const ctx = ctxAt(sc.root, { repo: 'o/r' });
  openGitTier(ctx).init('default'); // the branch the refusal is about
  const gh = seededGh();
  const restore = gh.install();
  t.after(restore);
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const file = indexFileIn(storeGitDir(ctx), 'default');
  assert.equal(fs.existsSync(file), false, 'no verb has opened this board here yet');

  await assert.rejects(() => importGithubBoard(ctx, { store }), (e) => e.exitCode === 2 && /already exists/.test(e.message));
  assert.equal(fs.existsSync(file), false, 'the refusal created no database');
  assert.equal(store.indexOpen, false, 'and opened no connection to leak');
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
  const { origin, store } = await board(t);
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

test('a malformed result body is a comment on both sides, not a result event nothing can read', async (t) => {
  const { store } = await board(t);
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

test('cardRecord round-trips through the branch: hoisted columns, kb, labels, blockers', async (t) => {
  const { store } = await board(t);
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

test('a run record written by the store is the same file the index reads back', async (t) => {
  const { store } = await board(t);
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
  assert.ok(lines.some((l) => /WARNING/.test(l) && /one full page of 100/.test(l) && /there may be more/.test(l)),
    `the cap is named, and named as a maybe — a full page says nothing about whether a next one exists: ${lines.join(' | ')}`);
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
  const { dir, origin, store } = await board(t);
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
  const { dir, origin, root, store } = await board(t);
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

test('the one-writer guard and the verb behind it share one decoded tree', async (t) => {
  // `assertOwningHost` opened a tier to read one string out of board.json and threw the memo away;
  // the verb behind it then opened the store and decoded the whole board again. Two `ls-tree -r`
  // plus two `cat-file --batch` per `hkb create`, on every card of the board.
  const { ctx, store } = await board(t);
  store.createTask({ title: 'a card', status: 'ready' });

  assert.equal(await assertOwningHost(ctx, 'create'), null, 'this host owns it');
  const second = await openStore(ctx);
  t.after(() => { try { second.close(); } catch { /* already closed */ } });
  assert.equal(second.git, store.git, 'one tier per context, so one decode');
  assert.equal(gitTierFor(ctx, { host: ctx.host }), store.git);

  // A caller with its own clock is a test, and never gets — or poisons — the shared one.
  const withClock = gitTierFor(ctx, { host: ctx.host, now: () => new Date('2020-01-01T00:00:00Z') });
  assert.notEqual(withClock, store.git);
  assert.equal(gitTierFor(ctx, { host: ctx.host }), store.git, 'and the shared tier is still the shared tier');
});

// ---------- round 5: the three that destroy live state, and the invariants behind them ----------

/** A lock listing/beat/release triple the migration can be pointed at, with a record of what it deleted. */
function fakeLocks(refs, { beats = {} } = {}) {
  const released = [];
  return {
    released,
    locks: {
      list: async () => refs.map((r) => ({ ref: `refs/kb/locks/${r.n}/${r.k}`, n: r.n, k: r.k, sha: `${r.n}-${r.k}` })),
      beatAt: async (_ctx, sha) => beats[sha] ?? null,
      release: async (_ctx, n, k) => { released.push(`${n}/${k}`); return true; },
    },
  };
}

test('a migration refuses while a worker still holds a claim, and writes nothing at all', async (t) => {
  // The command in the README, run on a live board: the migration's last step deletes the lock refs
  // the workers heartbeat on, so each one exits 3 (LOCK_LOST) mid-task having pushed nothing. The
  // refusal is before the first commit, because half a migration and two dead workers is not a state
  // anybody can reason about.
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = seededGh();
  t.after(gh.install());
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };

  const now = () => new Date('2026-09-03T00:00:00Z');
  const beat = '2026-09-02T23:55:00Z'; // five minutes ago: a worker is very much here
  const f = fakeLocks([{ n: 12, k: 3 }], { beats: { '12-3': beat } });
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());

  await assert.rejects(
    () => importGithubBoard(ctx, { store, now, leftovers: f }),
    (e) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /#12 attempt 3/);
      assert.match(e.message, /hkb init --import --force/);
      return true;
    },
  );
  assert.equal(store.git.tip(), null, 'and not one commit landed on the branch');
  assert.deepEqual(f.released, [], 'nor was a single lock deleted');

  // `--force` is the way through, and it says what it is about to cost.
  const lines = [];
  const summary = await importGithubBoard(ctx, { store, now, force: true, log: (l) => lines.push(l), leftovers: f });
  assert.equal(summary.cards, 3);
  assert.ok(lines.some((l) => /LOCK_LOST/.test(l)), `--force names the price: ${lines.join(' | ')}`);
});

test('the lock sweep is scoped to the cards migrated, and never deletes one it did not see was dead', async (t) => {
  // `refs/kb/locks/<n>/<k>` carries no board segment, so listing the namespace lists every board in
  // the repository: migrating `alpha` deleted `beta`'s live locks and beta's workers lost their
  // claims. And a lock whose beat says a worker is holding it is not litter, `--force` or not.
  const s = scratch(t);
  const ctx = ctxAt(s.root, { repo: 'o/r' });
  const gh = seededGh();
  t.after(gh.install());
  ctx.repo = { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner };

  const now = () => new Date('2026-09-03T00:00:00Z');
  const f = fakeLocks(
    [{ n: 12, k: 1 }, { n: 30, k: 2 }, { n: 4242, k: 1 }],
    { beats: { '12-1': '2026-08-01T00:00:00Z', '30-2': '2026-09-02T23:59:00Z' } },
  );
  const chainsSeen = [];
  const lines = [];
  const store = openLocalStore(ctx, { reconcile: false });
  t.after(() => store.close());
  const summary = await importGithubBoard(ctx, {
    store, now, force: true, log: (l) => lines.push(l),
    leftovers: { ...f, chains: { list: () => [{ n: 12, k: 1 }, { n: 4242, k: 9 }], drop: (_r, n, k) => { chainsSeen.push(`${n}/${k}`); return true; } } },
  });

  assert.deepEqual(f.released, ['12/1'], 'only the dead lock, on a card this import moved');
  assert.equal(summary.locks, 1);
  assert.equal(summary.locks_foreign, 1, '#4242 is another board\'s and was left alone');
  assert.deepEqual(summary.locks_kept.map((l) => l.n), [30], 'and #30 is still beating');
  assert.ok(lines.some((l) => /lock #30\/2 was NOT deleted/.test(l)));
  assert.deepEqual(chainsSeen, ['12/1'], 'the beat chains are scoped the same way');
  assert.equal(summary.chains_foreign, 1);
});

test('init --import will not flip a board.json the repository tracks', async (t) => {
  // Writing `"store": "local"` into a tracked file is a change to everybody's checkout: the next
  // `git pull` moves every collaborator onto a board only one host can write.
  const { boardFileTracked } = await import('../src/init.js');
  const s = scratch(t);
  const file = path.join(s.root, '.kanban', 'board.json');
  fs.writeFileSync(file, JSON.stringify({ repo: 'o/r' }, null, 2) + '\n');
  assert.equal(boardFileTracked(s.root), false, 'an untracked board.json is this checkout\'s own business');
  git(s.root, 'add', '.kanban/board.json');
  git(s.root, 'commit', '-qm', 'board');
  assert.equal(boardFileTracked(s.root), true);
});

test('a dry-run loop is still a write: the guard holds and the flag reaches the tick', async () => {
  // `--dry-run` removed the owner guard *and* was dropped on the floor by the `--loop` branch, so
  // the one flag combination that promised to write nothing ran a real claiming, spawning loop.
  const { loop } = await import('../src/dispatch.js');
  assert.equal(invocationWritesBoard('dispatch', { 'dry-run': true, loop: 30 }), true);
  const src = fs.readFileSync(new URL('../src/dispatch.js', import.meta.url), 'utf8');
  assert.match(src, /await tick\(ctx, \{ max, children, profiles, dryRun, log \}\)/, 'the loop threads dryRun into the tick');
  assert.match(src, /if \(!dryRun\) await syncPass/, 'and does not stamp or push on a dry run');
  void loop;
});

test('sync reads the exit status of every update-ref: a lost compare-and-swap is not a success', async (t) => {
  const { dir, origin, store } = await board(t);
  store.createTask({ title: 'the owner made this', status: 'ready' });
  await store.sync();

  const clone = path.join(dir, 'racer');
  git(dir, 'clone', '-q', origin, clone);
  fs.mkdirSync(path.join(clone, '.kanban'), { recursive: true });
  const theirs = openLocalStore(ctxAt(clone), { reconcile: false });
  t.after(() => theirs.close());

  // Every CAS loses — somebody else is moving the ref between the read and the write.
  const tried = [];
  theirs._setRef = (ref, to, from) => { tried.push([ref, to, from]); return { status: 1, stdout: '', stderr: 'cannot lock ref' }; };
  await assert.rejects(() => theirs.sync(), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /moved while `hkb sync` was fast-forwarding it, 3 times in a row/);
    return true;
  });
  assert.equal(tried.length, 3, 'a lost CAS is retried on a re-read, not reported as done');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/kb-board'], { cwd: clone }).status !== 0, true,
    'and the ref really did not move, which is what the old code reported as `fastForwarded: true`');
});

test('a sync that creates the branch changes nothing about which store this is', async (t) => {
  // The old shape of this test asserted the opposite — that `hkb sync` creating `kb-board` under a
  // running process flipped it onto the local store, and that `forgetStore` was what made that
  // safe. It is not safe, and it is no longer possible: `storeKind` reads `"store"` in board.json
  // and nothing else, so a branch arriving (a sync, a fetch, another host's push) leaves every verb
  // exactly where it was. That inference is the one this round removed.
  const { dir, origin, store } = await board(t);
  store.createTask({ title: 'published', status: 'ready' });
  await store.sync();

  const clone = path.join(dir, 'late');
  git(dir, 'clone', '-q', '--single-branch', '--branch', 'main', origin, clone);
  fs.mkdirSync(path.join(clone, '.kanban'), { recursive: true });
  const ctx = ctxAt(clone, { store: undefined });
  delete ctx.cfg.store;
  assert.equal(storeKind(ctx), 'github', 'no key, no local board');

  const theirs = openLocalStore(ctx, { reconcile: false });
  t.after(() => theirs.close());
  assert.equal((await theirs.sync()).fastForwarded, true, 'the branch is fetched and created all the same');
  assert.equal(storeKind(ctx), 'github', 'and the store did not move under the running process');
  assert.equal((await openStore(ctx)).kind, 'github');
});

test('a clock corrected backwards throttles, and does not commit a stamp every tick', async (t) => {
  // **One rule for every throttle, and this is the round it was got right.** The previous round put
  // a clamp on `liveDispatcher` (a *liveness* guard: a future stamp is somebody who is there) and
  // then made the throttle two functions away resolve the same skew the opposite way — `delta >= 0`,
  // so any negative delta was "due". A single backward step (NTP, a VM or WSL resync, a laptop
  // waking) then made the dispatcher commit a stamp and push it on every tick, on a branch that is
  // meant to read as the board's decisions; it was also a live flaky test in this file.
  //
  // `throttled()` is now the one answer for all three sites: fresh means *inside the window on
  // either side of now*. Nothing is lost by holding off on a future stamp — every reader of it
  // already treats it as live — and a stamp further ahead than the window is not skew but a broken
  // record, so it is rewritten once and throttles normally afterwards.
  const clock = { at: new Date('2026-09-03T12:00:00Z') };
  const { root } = scratch(t, { name: 'skewed' });
  const ctx = ctxAt(root);
  openGitTier(ctx).init('default');
  const store = openLocalStore(ctx, { now: () => clock.at });
  t.after(() => store.close());
  store.createTask({ title: 'a card that must survive every stamp', status: 'ready' });

  assert.equal(store.markDispatcher(11).stamped, true);
  const tip = store.git.tip();
  clock.at = new Date('2026-09-03T12:01:00Z');
  assert.equal(store.markDispatcher(11).stamped, false, 'a minute later is throttled: the stamp is a commit');
  // The injected backward step, ten times: a clock that has moved back inside the window is a
  // throttle that holds, not one commit per tick.
  for (let i = 0; i < 10; i++) {
    clock.at = new Date('2026-09-03T11:59:00Z');
    assert.equal(store.markDispatcher(11).stamped, false, 'a stamp dated after now is still a fresh stamp');
  }
  assert.equal(store.git.tip(), tip, 'and the branch has one stamp commit on it, not eleven');

  // The same injection through `syncAfterTick`'s own throttle, which is the one that pushes.
  writeState(root, { ...readState(root), sync_at: Date.now() + 30_000 });
  assert.equal((await syncAfterTick(ctx, { store, now: Date.now() })).why, 'throttled', 'a sync stamp from the future throttles too');

  // A stamp that is not skew at all — further ahead than the whole window — is rewritten once, so
  // one broken record cannot freeze this host's liveness for ever.
  clock.at = new Date('2026-09-03T11:00:00Z');
  assert.equal(store.markDispatcher(11).stamped, true, 'an hour in the future is a broken record, not a clock');
  assert.equal(store.markDispatcher(11).stamped, false, 'and the rewrite settles it');

  // …and the stamp moves the index's tip and nothing else. A full reindex here dropped and
  // re-inserted every task, link, run and result on the board every five minutes.
  assert.equal(store.index.tip(), store.git.tip());
  assert.deepEqual(store.listTasks().map((x) => x.title), ['a card that must survive every stamp']);
  assert.equal(store.index.listTaskRows ? store.index.listTaskRows().length : 1, 1, 'the card is still indexed');
});

test('an event names the write it was, and carries what a reader renders', async (t) => {
  // Six unrelated writes were filed as `status` with an `op` key nothing reads, so `hkb watch
  // --kinds status` rendered each of them `none → none`; `needs-human` added and cleared were the
  // same kind with the same payload, so a raised flag read as a cleared one.
  const { store } = await board(t);
  const seen = () => store.events({ after: 0 }).map((e) => ({ kind: e.kind, n: e.number, p: e.payload }));

  const card = store.createTask({ title: 'evented', status: 'triage' });
  store.setStatus(card, 'ready');
  store.setAgent(card, 'codex');
  store.addLabels(card, ['kb:needs-human']);
  store.removeLabel(card, 'kb:needs-human');
  store.addLabels(card, ['bug']);
  store.updateBody(card.number, 'a longer body');
  const other = store.createTask({ title: 'a blocker', status: 'ready' });
  store.addBlockedBy(card.number, other.number);
  store.removeBlockedBy(card.number, other.number);
  store.setBoard({ settings: { sync: { push: false } } });

  const by = (kind) => seen().filter((e) => e.kind === kind);
  assert.deepEqual(by('appeared').map((e) => e.p.to), ['triage', 'ready']);
  assert.deepEqual(by('status').map((e) => [e.p.from, e.p.to]), [['triage', 'ready']], 'a status event is a transition, and says both ends');
  assert.deepEqual(by('agent').map((e) => [e.p.from, e.p.to]), [[null, 'codex']], 'the card had no agent before, and the event says so rather than saying nothing');
  assert.deepEqual(by('needs-human').map((e) => e.p.to), [true, false], 'raised and cleared are not the same event');
  assert.deepEqual(by('labels').map((e) => e.p.add), [['bug']]);
  assert.equal(by('body').length, 1);
  assert.deepEqual(by('blocked-by').map((e) => e.p.blocker), [other.number]);
  assert.deepEqual(by('unblocked-by').map((e) => e.p.blocker), [other.number]);
  assert.deepEqual(by('board').map((e) => e.n), [null], 'a board-wide write is not a card event');
  assert.equal(seen().some((e) => e.kind === 'status' && e.n === null), false, 'and nothing is filed as card #null');

  // **A mixed label batch reports every label in it.** `[needs-human, urgent, triage-me]` was one
  // `needs-human` event carrying `{to: true}` and nothing else, so `hkb watch --kinds labels` showed
  // nothing at all for a write that changed three labels — the same fidelity defect one level down.
  store.addLabels(card, ['kb:needs-human', 'urgent', 'triage-me']);
  const mixed = by('labels').slice(-1)[0];
  assert.deepEqual(mixed.p.add, ['kb:needs-human', 'urgent', 'triage-me'], 'no label is dropped from the payload');
  assert.equal(mixed.p.to, true, 'and the flag it also raised is still visible');
  assert.equal(by('needs-human').length, 2, 'the dedicated kind stays for the write that is only the flag');

  // The take-over is its own kind too, and names both hosts.
  store.git.takeOver('someone-elses-laptop');
  store.git.forget();
  const back = store.takeOver({ force: true });
  assert.equal(back.was, 'someone-elses-laptop');
  assert.deepEqual(by('take-over').map((e) => [e.p.from, e.p.to]), [['someone-elses-laptop', store.host]]);
});

test('a hundred failing sweeps hold one store handle, and one call lets it go', async (t) => {
  // The defect this guards: the dispatcher runs the sweep every `gc_every_ticks`, the local driver
  // holds a SQLite connection with a WAL and an shm handle behind it, and a repeatedly failing
  // sweep leaked one per tick until the process ran out of file descriptors.
  //
  // It used to be guarded by a `finally` inside `sweep()`. That is no longer where it belongs —
  // `sweep` does not own the handle any more, `openStore(ctx)` hands back one per context and
  // closing it here would close the loop's store mid-tick. So the guarantee is stronger and stated
  // as such: the count of stores *opened* does not grow with the number of sweeps, however many of
  // them throw, and the owner closes the one there is.
  const { LocalStore } = await import('../src/store/local.js');
  const { sweep } = await import('../src/gc.js');
  const { closeStore } = await import('../src/store/index.js');
  const { root, ctx } = (() => { const s = scratch(t, { name: 'gc' }); const c = ctxAt(s.root); openGitTier(c).init('default'); return { ...s, ctx: c }; })();

  const realList = LocalStore.prototype.listTasks;
  const realClose = LocalStore.prototype.close;
  let closed = 0;
  let opened = 0;
  const realOpen = LocalStore.prototype.open;
  LocalStore.prototype.open = function open() { opened++; return realOpen.call(this); };
  LocalStore.prototype.listTasks = () => { throw new Error('the board read blew up'); };
  LocalStore.prototype.close = function close() { closed++; return realClose.call(this); };
  t.after(() => { LocalStore.prototype.listTasks = realList; LocalStore.prototype.close = realClose; LocalStore.prototype.open = realOpen; });

  for (let i = 0; i < 20; i++) {
    await assert.rejects(() => sweep(ctx, { yes: false, log: () => {} }), /the board read blew up/);
  }
  assert.equal(closed, 0, 'a sweep does not close a handle it did not open');
  assert.equal(closeStore(ctx), true, 'the owner does');
  assert.equal(closed, 1, 'and there was exactly one handle to close after twenty failed sweeps');
  void root;
  void opened;
});

test('nothing loads node:sqlite until a local board opens its index', async () => {
  // `src/store/index.js` imports the local store so `openStore` can pick it, and `openStore` is on
  // the path of every command — including `hkb hook pretool`, whose whole contract is to stand aside
  // rather than throw onto a worker's tool call. A static `import ... from 'node:sqlite'` made that
  // whole graph refuse to load on a node built without SQLite, on a GitHub board that never opens an
  // index at all.
  const src = fs.readFileSync(new URL('../src/store/sqlite.js', import.meta.url), 'utf8');
  assert.equal(/^import .* from 'node:sqlite'/m.test(src), false, 'the builtin is resolved on first use, not at import time');

  const probe = [
    "const loaded = () => process.moduleLoadList.filter((s) => /sqlite/.test(s)).length;",
    "await import('./src/store/index.js');",
    "await import('./src/doctor.js');",
    "await import('./src/cli.js');",
    "if (loaded()) { console.log('LOADED'); process.exit(0); }",
    "const { openIndex } = await import('./src/store/sqlite.js');",
    "if (loaded()) { console.log('LOADED BY IMPORT'); process.exit(0); }",
    "console.log(typeof openIndex === 'function' ? 'CLEAN' : 'BROKEN');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: path.dirname(fileURLToPathish(new URL('../package.json', import.meta.url))), encoding: 'utf8',
  });
  assert.equal(r.stdout.trim(), 'CLEAN', `${r.stdout}${r.stderr}`);
});

/** `new URL(...).pathname` is not a path on Windows; this is `fileURLToPath` without the import. */
function fileURLToPathish(url) {
  return decodeURIComponent(url.pathname);
}

test('a throttled stamp opens no database at all', async (t) => {
  // `syncPass` builds a store every tick to reach `markDispatcher`, which touches git and nothing
  // else on all but one tick in five minutes. At the interval floor that was a fresh `DatabaseSync`,
  // `ensureSchema` and `assertSameBoard` every five seconds, for an answer nobody read.
  const clock = { at: new Date('2026-09-03T12:00:00Z') };
  const { root } = scratch(t, { name: 'lazy' });
  const ctx = ctxAt(root);
  openGitTier(ctx).init('default');

  const first = openLocalStore(ctx, { reconcile: false, now: () => clock.at });
  assert.equal(first.indexOpen, false, 'nothing is opened by building the store');
  assert.equal(first.markDispatcher(1).stamped, true);
  assert.equal(first.indexOpen, true, 'a stamp that landed has to move the index tip');
  first.close();

  clock.at = new Date('2026-09-03T12:01:00Z');
  const second = openLocalStore(ctx, { reconcile: false, now: () => clock.at });
  t.after(() => second.close());
  assert.equal(second.markDispatcher(1).stamped, false, 'throttled');
  assert.equal(second.indexOpen, false, 'and it cost no connection');
});

test('a loop that dies leaves no signal listener behind', async (t) => {
  // The teardown used to be two statements after the `for(;;)`, so anything that unwound past the
  // loop — a throw from `tokenExpiryNotice`/`versionNotice`, which are awaited at the top of a tick
  // and outside the tick's own try — skipped `dropLock()` and `process.off('SIGUSR1', nudge)`. A
  // later `wake()` then reached a handler with no sleep to end instead of falling through to node's
  // default. The SIGINT/SIGTERM pair was never removed at all. One `finally` for all four.
  const { ctx } = await board(t);
  const before = ['SIGUSR1', 'SIGINT', 'SIGTERM'].map((sig) => process.listenerCount(sig));
  const boom = new Error('the loop dies here');
  // A throw from between the ticks: the same unwind as the two notices above.
  const sleeper = async () => { throw boom; };
  await assert.rejects(() => loop(ctx, { interval: 60, max: Infinity, log: () => {}, sleeper }), (e) => e === boom);
  assert.deepEqual(['SIGUSR1', 'SIGINT', 'SIGTERM'].map((sig) => process.listenerCount(sig)), before,
    'every listener the loop installed is gone');
  assert.equal(fs.existsSync(path.join(ctx.root, '.kanban', 'dispatch.pid')), false, 'and the singleton lock with them');
});

// ---------- what the review of #326 found ----------

test('every attempt event carries the attempt it is about', async (t) => {
  // `saveRun` read `rec.attempts`, but a run record is `{run, id}` — `loadRun`'s shape, and what
  // every caller hands straight back. So every attempt event on a local board went in as
  // `{attempt: null, profile: null, host: null}`, and `hkb log` is what renders them.
  const { ctx, store } = await board(t);
  const card = await store.createTask({ title: 'a card', status: 'running', agent: 'claude' });
  const rec = await store.loadRun(card.number);
  rec.run.attempts.push({ attempt: 1, profile: 'claude', host: 'laptop-a', started_at: new Date().toISOString() });
  await store.saveRun(card.number, rec);

  const saved = store.index.events({ limit: 200 }).filter((e) => e.kind === 'attempt' && e.number === card.number);
  const last = saved[saved.length - 1];
  assert.ok(last, 'saving a run appends an attempt event');
  assert.deepEqual(
    [last.payload.attempt, last.payload.profile, last.payload.host],
    [1, 'claude', 'laptop-a'],
  );
  void ctx;
});

test('hkb log reads a card\'s newest history, not the oldest page of the whole log', async (t) => {
  // `taskEvents` was `events({limit: 5000})` filtered in JS. `events` is a forward cursor from id 0,
  // so past the retention floor it read the *oldest* rows: `[]` for a recent card, pre-history for
  // an old one, and nothing saying rows had been cut. Narrowing in SQL is correct and cheaper.
  const { store } = await board(t);
  const mine = await store.createTask({ title: 'the card we ask about', status: 'ready', agent: 'claude' });
  const noise = await store.createTask({ title: 'somebody else', status: 'ready', agent: 'claude' });
  for (let i = 0; i < 60; i++) await store.addNote(noise.number, `noise ${i}`);
  await store.addNote(mine.number, 'the newest thing that happened to me');

  const rows = await store.taskEvents(mine.number);
  assert.ok(rows.length >= 2, `#${mine.number}'s own history survived 60 rows of somebody else's: ${rows.length}`);
  assert.ok(rows.every((r) => typeof r.at === 'string' && typeof r.kind === 'string'));
  const ats = rows.map((r) => r.at);
  assert.deepEqual(ats, [...ats].sort(), 'oldest first, the order hkb log interleaves on');
  // and it is not paying to parse the whole log to find them
  const narrow = store.index.taskEvents(mine.number, { limit: 2 });
  assert.equal(narrow.length, 2, 'the narrowing happens in SQL, so a limit is a limit');
});

test('a stale lease is lost even while the claim is held — the local beat mirror is not the claim', async (t) => {
  // `beatToken` was an alias for `lockToken`, so `heartbeat`'s `WHERE token = ?` leased on the value
  // it compared against: the compare-and-swap could not fail, and `hkb heartbeat`'s warm path could
  // never report `lost`. The mirror is now its own table — the counterpart of the GitHub driver's
  // local `refs/kb/locks/<n>/<k>` ref — and it deliberately outlives a released row.
  const { store } = await board(t);
  const card = await store.createTask({ title: 'a card', status: 'ready', agent: 'claude' });
  const n = card.number;
  const { token } = await store.claim(n, 1);
  assert.equal(store.beatToken(n, 1), token, 'the claimer is where the chain starts');

  const moved = await store.heartbeat(n, 1, token);
  assert.equal(moved.result, 'ok');
  assert.equal(store.beatToken(n, 1), moved.token, 'a beat advances this host\'s mirror with it');
  assert.notEqual(moved.token, token, 'and rotates the token, which is what makes the CAS a CAS');

  assert.equal((await store.heartbeat(n, 1, token)).result, 'lost', 'the superseded lease is rejected');
  assert.equal(await store.lockToken(n, 1), moved.token, 'while the claim itself is very much alive');

  // `resyncBeat` is how a worker recovers from that, and `dropBeat` is what a terminal verb leaves
  // behind — nothing.
  assert.equal(store.resyncBeat(n, 1, moved.token), true);
  assert.equal(store.beatToken(n, 1), moved.token);
  assert.equal(store.dropBeat(n, 1), true);
  assert.equal(store.beatToken(n, 1), null, 'null means "this host has not beaten", never "the claim is gone"');
  assert.notEqual(await store.lockToken(n, 1), null, 'which is a different question, with a different answer');
});

test('one context, one store handle — and closing it is one call', async (t) => {
  // `gc.js` documents what the alternative costs: "leaked one handle per tick until the process hit
  // its file-descriptor limit". A server reads four times for one request and a doctor twenty times
  // in a run, so the fix is one handle per context rather than a `finally` at forty call sites.
  const { ctx } = await board(t);
  const { openStore, closeStore } = await import('../src/store/index.js');
  const a = await openStore(ctx);
  const b = await openStore(ctx);
  assert.equal(a, b, 'the second verb of a process gets the handle the first one opened');
  await a.createTask({ title: 'opens the index', status: 'ready', agent: 'claude' });
  assert.equal(a.indexOpen, true);
  assert.equal(closeStore(ctx), true, 'and one call lets it go');
  assert.equal(closeStore(ctx), false, 'twice is a no-op, not an error');
  const c = await openStore(ctx);
  assert.notEqual(c, a, 'a store asked for after the close is a fresh one');
  c.close();
});

test('a local board\'s heartbeat never names a git ref, and neither does LOCK_LOST', async (t) => {
  // `hkb heartbeat` printed `refs/kb/locks/42/1` and, on its fallback, "the run comment". Neither
  // exists on a local board — the claim is a row and the record is a file on the branch. The same
  // wart was fixed two files over (`cli.js`'s `c.ref || \`attempt ${k}\``) and left standing here.
  const { heartbeat } = await import('../src/lifecycle.js');
  const { ctx, store } = await board(t);
  const card = await store.createTask({ title: 'a claimed card', status: 'ready', agent: 'claude' });
  const n = card.number;
  const { token } = await store.claim(n, 1);
  const rec = await store.loadRun(n);
  rec.run.attempts.push({ attempt: 1, profile: 'claude', host: ctx.host, started_at: new Date().toISOString(), lock_sha: token });
  await store.saveRun(n, rec);

  const beat = await heartbeat(ctx, n, { attempt: 1 });
  assert.equal(beat.ref, null, 'a store that keeps its claims in a table has no ref to name');
  assert.equal(beat.attempt, 1);
  assert.equal(store.lockRef(n, 1), null);

  // and when the claim really is gone, the error says which attempt rather than which ref
  await store.release(n, 1);
  store.dropBeat(n, 1);
  await assert.rejects(
    () => heartbeat(ctx, n, { attempt: 1 }),
    (e) => e.exitCode === 3 && /LOCK_LOST/.test(e.message) && !/refs\/kb\/locks/.test(e.message) && /attempt 1/.test(e.message),
  );
});

test('hkb comment on a local board prints a line, not a JSON blob', async (t) => {
  // `out(ctx, obj, c.url)` with `c.url === null` — which is always, on a store with no page for a
  // note — fell through to `JSON.stringify`. CLAUDE.md: human output is a one-liner per item.
  const { main } = await import('../src/cli.js');
  const { ctx, store } = await board(t);
  const card = await store.createTask({ title: 'a card', status: 'ready', agent: 'claude' });
  // `main` builds its own context off the checkout, so the board has to be on disk for it. The
  // `repo` is there because `ctx.requireBoard()` still insists on one even for a board that never
  // reaches the forge — that is `docs/wiki/FINDINGS.md`'s open cleanup, not this test's subject.
  fs.writeFileSync(path.join(ctx.root, '.kanban', 'board.json'), JSON.stringify({ ...ctx.cfg, repo: 'o/r' }, null, 2));
  const written = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const cwd = process.cwd();
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  process.chdir(ctx.root);
  try {
    await main(['comment', String(card.number), 'a note from a human']);
  } finally { process.chdir(cwd); process.stdout.write = realWrite; }

  const printed = written.join('');
  assert.doesNotMatch(printed, /^\s*\{/, `a blob, not a line: ${printed}`);
  assert.match(printed, new RegExp(`#${card.number}`), printed);
  assert.equal(printed.trim().split('\n').length, 1, 'one line per item');
  assert.deepEqual((await store.listNotes(card.number)).map((c) => c.text), ['a note from a human']);
});
