// The local store: the `kb-board` branch and the `.git/hkb/index.db` index, as one `Store`.
//
// docs/local-first.md §6.1. The two tiers are halves of one board and neither is a `Store` on its
// own: the branch (`./git.js`, A4) holds everything a `git clone` must carry and none of what is
// live, the index (`./sqlite.js`, A5) holds the locks, the open attempts and the event log and is
// rebuilt from the branch whenever the branch has moved. This file is the composition, and the
// rules it enforces are three:
//
//   1. **open() reconciles.** The index stores the sha it was built from; when that is not what
//      `refs/heads/kb-board` says, the whole tree is read and loaded. A crash between a commit and
//      the index write leaves the index one commit behind, and this is what repairs it.
//   2. **A durable write commits first, indexes second, wakes third.** In that order, because the
//      branch is the source of truth: an index ahead of the branch is a board that lost a decision
//      on the next reload, while an index behind one is repaired by rule 1.
//   3. **A live write never touches git.** Claims, heartbeats and the attempt's pid/job/worktree are
//      the index's alone — a lock on a branch would be a commit per beat, and `git log kb-board` is
//      meant to be the board's history of *decisions*.
//
// Reads of durable state go to the branch, not to the index: the tier memoizes the tree per sha, so
// a tick that asks about twelve cards decodes it once, and there is exactly one answer to "what does
// the board say" rather than two that can disagree. The index answers the live half.
import fs from 'node:fs';
import path from 'node:path';
import { storeRoot, hostId, runGit, gitSays, GIT_SHA_RE, readState, writeState, normalizeCardGrants } from '../board.js';
import { RESULT_MARKER, RUN_MARKER, DEFAULT_KB, L, emptyRun, parseResultComment } from '../model.js';
import { openGitTier, BOARD_BRANCH, BOARD_REF } from './git.js';
import { openIndex } from './sqlite.js';
import { openGithubStore, listComments, listLocks, release, listBeatChains, dropBeatChain } from './github.js';

export { BOARD_BRANCH, BOARD_REF };

/** How often the loop may push, at most (§6.2: "throttled and offline-tolerant"). */
export const SYNC_THROTTLE_MS = 60_000;

/** How fresh another host's dispatcher stamp has to be for `--take-over` to refuse. */
export const HOST_LIVE_MS = 15 * 60_000;

/**
 * Why a `git fetch`/`git push` failed with no network. Silent when the loop hits one of these, and
 * an error the human can read when they ran `hkb sync` themselves.
 */
const OFFLINE = /could not resolve host|could not read from remote|unable to access|network is unreachable|no route to host|connection timed out|connection refused|temporary failure in name resolution|operation timed out/i;

/** @returns {Error & {exitCode: number}} */
function fail(message, exitCode = 2) {
  const e = /** @type {any} */ (new Error(message));
  e.exitCode = exitCode;
  return e;
}

/**
 * Which durable verb wrote, in the vocabulary `hkb watch` and `hkb serve` already speak
 * (`EVENT_KINDS`, src/watch.js). A durable method appends exactly one of these *after* its commit
 * lands, and only when the commit really moved the branch.
 */
const KIND = {
  createTask: 'appeared',
  setStatus: 'status',
  setAgent: 'agent',
  closeTask: 'closed',
  reopenTask: 'reopened',
  saveRun: 'attempt',
};

export class LocalStore {
  /**
   * @param {any} ctx  a context from `makeContext`/`makeContextAt`, or a path
   * @param {{git?: any, index?: any, host?: string, ref?: string, remote?: string, now?: () => Date}} [opts]
   */
  constructor(ctx, { git = null, index = null, host = null, ref = BOARD_REF, remote = null, now = () => new Date() } = {}) {
    this.ctx = ctx;
    this.root = storeRoot(ctx);
    // The context's own identity, when it has one: `makeContext` sets `host` and every other verb
    // reads it from there, so the store must not answer to a different name than the process does.
    this.host = host || (ctx && typeof ctx === 'object' ? ctx.host : null) || hostId();
    this.now = now;
    this.git = git || openGitTier(ctx, { ref, remote, host: this.host, now });
    this.index = index || openIndex(ctx, { branch: this.git.branch });
    this.remote = this.git.remote;
  }

  /** The branch the durable tier writes — `kb-board` unless a test asked for another. */
  get branch() { return this.git.branch; }

  /**
   * Reconcile the index with the branch, and answer what moved.
   *
   * One `rev-parse` and one indexed row in the common case (the tip has not moved), which is why
   * `openLocalStore` can afford to call it on every verb. A board whose branch does not exist yet —
   * a checkout `hkb init` has not run in — loads nothing rather than emptying the index: there is no
   * tree to be authoritative, and `{tip: null}` would delete the tasks a `git fetch` is about to
   * bring back.
   * @returns {{loaded: boolean, tip: string|null, counts: any}}
   */
  open() {
    const tip = this.git.tip();
    if (!tip) return { loaded: false, tip: null, counts: null };
    if (!this.index.needsLoad(tip)) return { loaded: false, tip, counts: null };
    const tree = this.git.readTree();
    const counts = this.index.load({ ...tree, branch: this.branch });
    return { loaded: true, tip, counts };
  }

  /** Close the index's connection. The git tier holds nothing open. */
  close() { this.index.close(); }

  capabilities() { return { events: true, durable: true }; }

  // ---------- the durable half ----------

  /**
   * Run one durable verb: commit, then index, then wake (§6.1's order).
   *
   * The tip is read before and after so the index and the log see exactly what the branch saw: a
   * verb that wrote the same bytes back lands no commit, and so appends no event and wakes nobody.
   * That is what keeps a reconcile pass — a tick re-asserting the state of twenty cards — free.
   *
   * `number` may be a function of the verb's own return value: `createTask` is the card that only
   * exists once the commit has landed, and an event that could not say which card appeared would be
   * the one event nobody can act on.
   */
  _durable(kind, number, run, payload = {}) {
    const before = this.git.tip();
    const value = run();
    const after = this.git.tip();
    if (after === before) return value;
    const n = typeof number === 'function' ? number(value) : number;
    this.index.load({ ...this.git.readTree(), branch: this.branch });
    this.index.appendEvent({ kind, task_id: n ?? null, payload: { ...payload, tip: after } });
    this.index.wake();
    return value;
  }

  board() { return this.git.board(); }

  setBoard(patch = {}) {
    return this._durable('status', null, () => this.git.setBoard(patch), { op: 'board' });
  }

  listTasks(opts) { return this.git.listTasks(opts); }
  listClosedRecent(opts) { return this.git.listClosedRecent(opts); }
  getTask(n) { return this.git.getTask(n); }

  createTask(spec) {
    return this._durable(KIND.createTask, (task) => task?.number ?? null, () => this.git.createTask(spec), { op: 'create' });
  }

  updateBody(n, body) {
    return this._durable('status', Number(n), () => this.git.updateBody(n, body), { op: 'body' });
  }

  setStatus(task, status, opts) {
    return this._durable(KIND.setStatus, numberOf(task), () => this.git.setStatus(task, status, opts), { status });
  }

  setAgent(task, agent) {
    return this._durable(KIND.setAgent, numberOf(task), () => this.git.setAgent(task, agent), { agent });
  }

  addLabels(task, names) {
    return this._durable(labelKind(names), numberOf(task), () => this.git.addLabels(task, names), { add: names });
  }

  removeLabel(task, name) {
    return this._durable(labelKind([name]), numberOf(task), () => this.git.removeLabel(task, name), { remove: [name] });
  }

  closeTask(n, reason) {
    return this._durable(KIND.closeTask, Number(n), () => this.git.closeTask(n, reason), { reason: reason ?? 'completed' });
  }

  reopenTask(n) {
    return this._durable(KIND.reopenTask, Number(n), () => this.git.reopenTask(n), {});
  }

  addBlockedBy(child, parent) {
    return this._durable('status', Number(child), () => this.git.addBlockedBy(child, parent), { op: 'blocked-by', blocker: Number(parent) });
  }

  removeBlockedBy(child, parent) {
    return this._durable('status', Number(child), () => this.git.removeBlockedBy(child, parent), { op: 'unblocked-by', blocker: Number(parent) });
  }

  loadRun(n) { return this.git.loadRun(n); }

  saveRun(n, rec) {
    return this._durable(KIND.saveRun, Number(n), () => this.git.saveRun(n, rec), { op: 'run' });
  }

  latestResult(n) { return this.git.latestResult(n); }
  parentResults(task) { return this.git.parentResults(task); }

  /** A note is a comment; a worker's handoff arriving through the same call is a result (`git.js`). */
  addNote(n, text) {
    const kind = String(text ?? '').startsWith(RESULT_MARKER) ? 'result' : 'comment';
    return this._durable(kind, Number(n), () => this.git.addNote(n, text), { op: kind });
  }

  listNotes(n) { return this.git.listNotes(n); }

  // ---------- the live half ----------

  claim(n, k, opts = {}) { return this.index.claim(n, k, { host: this.host, ...opts }); }
  release(n, k) { return this.index.release(n, k); }
  listLocks() { return this.index.listLocks(); }
  lockBeatAt(n, k) { return this.index.lockBeatAt(n, k); }
  heartbeat(n, k, expected) { return this.index.heartbeat(n, k, expected); }
  events(opts) { return this.index.events(opts); }
  appendEvent(spec) { return this.index.appendEvent(spec); }
  getAttempt(n, k) { return this.index.getAttempt(n, k); }
  openAttempts() { return this.index.openAttempts(); }
  setAttempt(n, k, patch) { return this.index.setAttempt(n, k, patch); }

  // ---------- one writer (§6.2) ----------

  /**
   * The host `board.json` names, or null on a board that has never been written.
   */
  owner() { return this.git.board().host ?? null; }

  /** Is this host the one the branch says writes this board? */
  owns() { const o = this.owner(); return !o || o === this.host; }

  /**
   * Refuse a mutating verb on a host that is not the board's.
   *
   * The tier already refuses the *write* (`_assertOwner`), and this is the same answer one step
   * earlier, so a dispatcher spends no API call and spawns no worker before finding out. `verb` only
   * shapes the sentence.
   */
  assertOwner(verb = 'this') {
    const owner = this.owner();
    if (!owner || owner === this.host) return;
    throw fail(
      `${verb === 'this' ? 'this board' : `\`hkb ${verb}\``} needs the host that owns the board: `
      + `${this.branch} says "${owner}" and this is "${this.host}" — the branch has one writer (docs/local-first.md §6.2). `
      + 'Read the board here with `hkb list`, or move it to this host with `hkb init --take-over`.',
    );
  }

  /**
   * Move `board.host` to this host.
   *
   * Refused while the old host still looks live: the branch's `board.json` carries the last
   * dispatcher stamp this board saw (`markDispatcher`), and a stamp younger than `HOST_LIVE_MS` from
   * another host means a loop is ticking against it right now — two hosts writing one branch is what
   * §6.2 says is not supported. `--force` is the human's override for a laptop that is not coming
   * back.
   * @param {{force?: boolean}} [opts]
   */
  takeOver({ force = false } = {}) {
    const doc = this.git.readTree().board;
    const owner = doc?.host ?? null;
    if (owner === this.host) return { host: this.host, changed: false, was: owner };
    const live = liveDispatcher(doc, this.host, this.now());
    if (live && !force) {
      throw fail(
        `${this.branch} says host "${owner}" is still running a dispatcher (it stamped ${live.at}, `
        + `${Math.round(live.age / 1000)}s ago) — two hosts writing one board is what the one-writer rule exists to stop. `
        + `Stop it there with \`hkb down\`, or take the board anyway with \`hkb init --take-over --force\`.`,
      );
    }
    const r = this.git.takeOver(this.host);
    this.open();
    this.index.appendEvent({ kind: 'status', task_id: null, payload: { op: 'take-over', from: owner, to: this.host } });
    return { host: this.host, changed: r.changed, was: owner };
  }

  /**
   * Stamp this host and pid on the branch, so another host's `--take-over` can tell a live board
   * from an abandoned one. Written at most once per `HOST_LIVE_MS / 3`, because it is a commit.
   */
  markDispatcher(pid = process.pid) {
    const doc = this.git.readTree().board;
    const at = this.now();
    const last = Date.parse(doc?.dispatch?.at || '');
    if (doc?.dispatch?.host === this.host && Number.isFinite(last) && at.getTime() - last < HOST_LIVE_MS / 3) {
      return { stamped: false };
    }
    this.git.setBoard({ dispatch: { host: this.host, pid, at: at.toISOString() } });
    return { stamped: true };
  }

  // ---------- sync (§6.2: "Sync is git") ----------

  /**
   * Push `kb-board` to the remote and fast-forward the local ref from it.
   *
   * The branch has one writer, so anything that is not a fast-forward in either direction is a board
   * two hosts have written and this refuses to guess which is right. Offline is not a failure: the
   * remote copy is a backup and a reader's view, and the loop calls this on a laptop that spends its
   * day on and off a network.
   *
   * @param {{push?: boolean, fetch?: boolean}} [opts]
   * @returns {{ok: boolean, pushed: boolean, fastForwarded: boolean, offline: boolean, skipped: string|null, remote: string, branch: string, local: string|null, tracking: string|null, detail: string}}
   */
  sync({ push = true, fetch = true } = {}) {
    const remote = this.remote;
    const branch = this.branch;
    const answer = (over = {}) => ({
      ok: true, pushed: false, fastForwarded: false, offline: false, skipped: null,
      remote, branch, local: this.git.tip(), tracking: this._tracking(), detail: '', ...over,
    });
    if (this.board().settings?.sync?.push === false && push) return answer({ skipped: 'off', detail: `sync.push is false in ${branch}'s board.json` });
    if (!this._hasRemote()) return answer({ skipped: 'no-remote', detail: `no git remote "${remote}" in ${this.root}` });

    if (fetch) {
      const r = this._git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
      // A remote that simply has no such branch is not an error: this host is the first to push it.
      if (r.status !== 0 && !/couldn't find remote ref|not found in upstream/i.test(r.out)) {
        if (OFFLINE.test(r.out)) return answer({ offline: true, detail: gitSays(r.out) || 'offline' });
        throw fail(`\`git fetch ${remote} ${branch}\` failed: ${gitSays(r.out) || 'unknown error'} — check the remote with \`git -C ${this.root} remote -v\`.`);
      }
    }

    // The refs are read here rather than through the tier: `tip()` falls back to the remote-tracking
    // ref when there is no local branch, and this is the one place that must tell the two apart.
    const here = this._rev(`refs/heads/${branch}`);
    const there = this._rev(`refs/remotes/${remote}/${branch}`);

    if (there && !here) {
      // A clone that has read the board off `origin/kb-board` and now wants a local branch to write.
      this._git(['update-ref', `refs/heads/${branch}`, there]);
      this.git.forget();
      this.open();
      return answer({ fastForwarded: true, local: there, tracking: there, detail: `created ${branch} at ${there.slice(0, 7)}` });
    }
    if (here && there && here !== there) {
      if (this._ancestor(here, there)) {
        this._git(['update-ref', `refs/heads/${branch}`, there, here]);
        this.git.forget();
        this.open();
        return answer({ fastForwarded: true, local: there, tracking: there, detail: `fast-forwarded to ${there.slice(0, 7)}` });
      }
      if (!this._ancestor(there, here)) {
        throw fail(this._divergedMessage(here, there));
      }
    }
    if (!push) return answer({ detail: 'fetch only' });

    const from = this._rev(`refs/heads/${branch}`);
    if (!from) return answer({ skipped: 'no-branch', detail: `there is no ${branch} branch in ${this.root} — run \`hkb init\`` });
    if (from === this._rev(`refs/remotes/${remote}/${branch}`)) return answer({ local: from, tracking: from, detail: 'up to date' });

    const r = this._git(['push', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (r.status !== 0) {
      if (OFFLINE.test(r.out)) return answer({ offline: true, local: from, detail: gitSays(r.out) || 'offline' });
      if (/non-fast-forward|fetch first|rejected/i.test(r.out)) throw fail(this._divergedMessage(from, this._rev(`refs/remotes/${remote}/${branch}`)));
      throw fail(`\`git push ${remote} ${branch}\` failed: ${gitSays(r.out) || 'unknown error'}`);
    }
    this._git(['update-ref', `refs/remotes/${remote}/${branch}`, from]);
    return answer({ pushed: true, local: from, tracking: from, detail: `pushed ${from.slice(0, 7)} to ${remote}/${branch}` });
  }

  /** What a non-fast-forward means on a branch with one writer, and what to do about it. */
  _divergedMessage(here, there) {
    const owner = this.git.readTree().board?.host || 'another host';
    return (
      `${this.branch} and ${this.remote}/${this.branch} have diverged (${short(here)} vs ${short(there)}) — `
      + `the board has one writer (docs/local-first.md §6.2) and two hosts have written this one. `
      + `hkb will not merge them. Look at what each side decided with `
      + `\`git -C ${this.root} log --oneline ${this.branch} ${this.remote}/${this.branch}\`, keep one `
      + `(\`git -C ${this.root} update-ref refs/heads/${this.branch} <sha>\`), and make sure only host `
      + `"${owner}" writes it — \`hkb init --take-over\` on the host that should.`
    );
  }

  _git(args) { return runGit(this.root, args); }

  _rev(ref) {
    const r = this._git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.status === 0 && GIT_SHA_RE.test(r.stdout) ? r.stdout : null;
  }

  _tracking() { return this._rev(`refs/remotes/${this.remote}/${this.branch}`); }

  _ancestor(a, b) { return this._git(['merge-base', '--is-ancestor', a, b]).status === 0; }

  _hasRemote() { return this._git(['remote', 'get-url', this.remote]).status === 0; }
}

/** A label change that is about `kb:needs-human` is its own event kind; the rest are card changes. */
function labelKind(names = []) {
  return [].concat(names || []).includes(L.needsHuman) ? 'needs-human' : 'status';
}

function numberOf(task) {
  const n = Number(typeof task === 'object' && task ? task.number ?? task.id : task);
  return Number.isFinite(n) ? n : null;
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : 'nothing');

/**
 * Is another host's dispatcher stamp fresh enough to call it live? `null` when the stamp is this
 * host's, missing, unparseable or old.
 * @returns {{host: string, at: string, age: number}|null}
 */
export function liveDispatcher(board, host, now = new Date()) {
  const d = board?.dispatch;
  if (!d || !d.host || d.host === host) return null;
  const at = Date.parse(d.at || '');
  if (!Number.isFinite(at)) return null;
  const age = now.getTime() - at;
  if (age < 0 || age > HOST_LIVE_MS) return null;
  return { host: d.host, at: d.at, age };
}

/**
 * The local store for `ctx`, reconciled.
 *
 * `open()` runs here rather than in the constructor so a caller that wants the pieces without the
 * `rev-parse` (a test, `hkb doctor`'s probes) can build the class directly.
 * @param {any} ctx
 * @param {{git?: any, index?: any, host?: string, ref?: string, remote?: string, now?: () => Date, reconcile?: boolean}} [opts]
 */
export function openLocalStore(ctx, { reconcile = true, ...opts } = {}) {
  const store = new LocalStore(ctx, opts);
  if (reconcile) store.open();
  return store;
}

/**
 * Does this checkout have a local board at all? One `rev-parse`, and the question `openStore` asks
 * when nothing in `.kanban/board.json` says which store to use.
 */
export function localBoardExists(ctx, { ref = BOARD_REF } = {}) {
  const root = storeRoot(ctx);
  const branch = ref.replace(/^refs\/heads\//, '');
  for (const r of [ref, `refs/remotes/${(typeof ctx === 'object' && ctx?.cfg?.remote) || 'origin'}/${branch}`]) {
    if (runGit(root, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]).status === 0) return true;
  }
  return false;
}

/**
 * The one-writer guard, without opening the index (§6.2).
 *
 * Reads `board.json` off the branch and refuses when this host is not the one it names. The tier
 * refuses the write anyway, and this is the same answer one step earlier: `hkb dispatch` on the
 * wrong laptop should say so before it reads the board, picks a card and spawns a session that
 * cannot record what it did.
 *
 * A checkout with no branch yet — and a board nobody has claimed — is nobody's, so it passes.
 * @param {any} ctx
 * @param {string} verb  the verb being refused, for the sentence
 * @param {{tier?: any, host?: string}} [opts]
 */
export function assertLocalOwner(ctx, verb = 'this', { tier = null, host = null } = {}) {
  // `ctx.host` is this process's identity everywhere else in hkb (`makeContext`), so it is what the
  // guard answers to as well — a caller that says who it is must not be told about somebody else.
  const who = host || (ctx && typeof ctx === 'object' ? ctx.host : null);
  const t = tier || openGitTier(ctx, who ? { host: who } : {});
  if (!t.tip()) return null;
  const owner = t.readTree().board?.host ?? null;
  const me = who || t.host;
  if (!owner || owner === me) return null;
  throw fail(
    `\`hkb ${verb}\` writes the board, and this board belongs to host "${owner}" — this is "${me}". `
    + `The ${t.branch} branch has one writer (docs/local-first.md §6.2): read the board here `
    + '(`hkb list`, `hkb show <n>`, `hkb serve`), or move it to this host with `hkb init --take-over`.',
  );
}

// ---------- the loop's sync (§6.2) ----------

/**
 * Sync after a tick that made a durable write, at most once a `SYNC_THROTTLE_MS`, silent offline.
 *
 * The stamp lives in `.kanban/state.json` beside the loop's other per-host state, because it is
 * about this host's network and not about the board.
 * @param {any} ctx
 * @param {{store?: any, log?: (s: string) => void, now?: number, force?: boolean}} [opts]
 * @returns {{synced: boolean, why: string, result?: any}}
 */
export function syncAfterTick(ctx, { store = null, log = () => {}, now = Date.now(), force = false } = {}) {
  const root = storeRoot(ctx);
  const state = readState(root);
  const last = Number(state.sync_at || 0);
  if (!force && Number.isFinite(last) && now - last < SYNC_THROTTLE_MS) return { synced: false, why: 'throttled' };
  const s = store || openLocalStore(ctx);
  let result;
  try {
    result = s.sync();
  } catch (e) {
    // A divergence is worth saying once; it is not worth stopping a tick over.
    log(`sync: ${/** @type {Error} */ (e).message}`);
    writeState(root, { ...readState(root), sync_at: now });
    return { synced: false, why: 'refused' };
  }
  writeState(root, { ...readState(root), sync_at: now });
  if (result.offline) return { synced: false, why: 'offline', result };
  if (result.skipped) return { synced: false, why: result.skipped, result };
  if (result.pushed || result.fastForwarded) log(`sync: ${result.detail}`);
  return { synced: true, why: 'ok', result };
}

// ---------- the migration (§6, `hkb init --import`) ----------

/** Cards closed longer ago than this are left on GitHub: history, not board state. */
export const IMPORT_WINDOW_DAYS = 90;

/**
 * A card record for the branch, from a task in `fetchBoard`'s shape.
 *
 * §6.2's layout, and deliberately the same field names `src/store/git.js` writes: the hoisted
 * columns (`priority`, `paths`, `goal`, `scheduled_at`) on the card, every other `kb` key under
 * `kb`, and the labels that are not columns in `labels`. A card imported here has to read back
 * through `getTask()` exactly like one `createTask()` made, which is what the import test asserts.
 */
export function cardRecord(task, { at = new Date().toISOString() } = {}) {
  const kb = normalizeCardGrants({ ...DEFAULT_KB, ...(task.kb || {}) });
  /** @type {any} */ const rest = {};
  for (const [k, v] of Object.entries(kb)) if (!['priority', 'paths', 'goal', 'scheduled_at'].includes(k)) rest[k] = v;
  const closed = String(task.state || 'OPEN').toUpperCase() === 'CLOSED';
  return {
    id: Number(task.number),
    title: String(task.title || ''),
    body: String(task.bodyText ?? task.body ?? ''),
    status: task.status ?? null,
    agent: task.agent ?? null,
    priority: kb.priority ?? 0,
    paths: Array.isArray(kb.paths) ? kb.paths : [],
    goal: kb.goal ?? null,
    scheduled_at: kb.scheduled_at ?? null,
    rank: task.rank ?? null,
    suspended: task.suspended ?? null,
    needs_human: !!task.needsHuman,
    // Only what the columns above do not already say. `kb:board:*`, `kb:status:*`, `kb:agent:*` and
    // `kb:needs-human` are rebuilt from the card by `labelsOf`, so carrying them here would double them.
    labels: (task.labels || []).filter((l) => !/^kb:(board|status|agent):/.test(l) && l !== L.needsHuman),
    blocked_by: (task.blockedBy || []).map((b) => Number(b.number ?? b)).filter(Number.isFinite).sort((a, b) => a - b),
    state: closed ? 'CLOSED' : 'OPEN',
    state_reason: task.stateReason ?? null,
    closed_at: closed ? (task.updatedAt ?? at) : null,
    created_at: task.createdAt ?? at,
    updated_at: task.updatedAt ?? at,
    kb: rest,
  };
}

/**
 * Move a GitHub board onto the local store: every open card, every card closed inside the window,
 * with the issue number as the id.
 *
 * The budget is one paginated comments read per card (`listComments` memoizes on the context, so the
 * run record, the results and the notes all come out of the same read) and **two** commits for the
 * whole board — one for the cards, one for the run records — rather than one per card: `git log
 * kb-board` should say "the board arrived", not replay a year of issue history.
 *
 * Idempotent by refusal, not by merge: a branch that already exists is left exactly as it is (the
 * card's "re-running `init` never touches an existing branch or index"), because a second import
 * over a board that has since been worked would overwrite live state with GitHub's stale copy.
 *
 * @param {any} ctx
 * @param {{store?: any, from?: any, days?: number, log?: (s: string) => void, now?: () => Date, force?: boolean}} [opts]
 */
export async function importGithubBoard(ctx, { store = null, from = null, days = IMPORT_WINDOW_DAYS, log = () => {}, now = () => new Date(), force = false } = {}) {
  const s = store || openLocalStore(ctx, { reconcile: false });
  if (s.git.tip() && !force) {
    throw fail(
      `${s.branch} already exists in ${s.root} — \`hkb init --import\` migrates a GitHub board onto a *new* local board, `
      + `and re-importing over one that has been worked would overwrite it with GitHub's copy. `
      + `Look at what is there (\`git log --oneline ${s.branch}\`), and delete it deliberately if the import is what you want: `
      + `\`git -C ${s.root} branch -D ${s.branch} && rm -f ${s.index.file}*\`.`,
    );
  }
  const gh = from || openGithubStore(ctx);
  const at = now().toISOString();
  const cutoff = now().getTime() - Math.max(0, Number(days) || 0) * 86_400_000;

  const open = await gh.listTasks({ states: ['OPEN'] });
  const closed = (await gh.listClosedRecent({ first: 100 }))
    .filter((t) => { const d = Date.parse(t.updatedAt || ''); return !Number.isFinite(d) || d >= cutoff; });
  const tasks = [...open, ...closed]
    .filter((t, i, all) => all.findIndex((x) => x.number === t.number) === i)
    .sort((a, b) => a.number - b.number);
  log(`import: ${open.length} open card(s) and ${closed.length} closed in the last ${days} day(s)`);

  const slug = ctx?.board || 'default';
  const next = tasks.reduce((m, t) => Math.max(m, Number(t.number) || 0), 0) + 1;
  s.git.commit((t) => {
    t.board = t.board || { version: 1, slug, host: s.host, paused_at: null, paused_by: null, next_id: 1, settings: {} };
    t.board.next_id = Math.max(Number(t.board.next_id) || 1, next);
    for (const task of tasks) t.cards.set(Number(task.number), cardRecord(task, { at }));
  }, `hkb: import ${tasks.length} card(s) from ${ctx?.cfg?.repo || 'GitHub'}`, { allowMissing: true, allowForeignHost: true });

  // The run records, one paginated comments read per card. Read them all first, then land one commit:
  // an await inside a `commit()` mutation would run again on every CAS retry.
  /** @type {Map<number, any>} */ const runs = new Map();
  let withRuns = 0; let results = 0; let notes = 0;
  for (const [i, task] of tasks.entries()) {
    const n = Number(task.number);
    log(`import: run record ${i + 1}/${tasks.length} (#${n})`);
    const { run } = await gh.loadRun(n);
    const comments = await listComments(ctx, n);
    const file = { ...emptyRun(), ...run, results: [], notes: [] };
    for (const c of comments) {
      const body = String(c.body || '');
      if (body.startsWith(RUN_MARKER)) continue; // that is `run`, above
      if (body.startsWith(RESULT_MARKER)) {
        const parsed = parseResultComment(body);
        if (parsed) { file.results.push({ ...parsed, at: c.created_at ?? null }); results++; continue; }
      }
      file.notes.push({ id: c.id, at: c.created_at ?? null, actor: c.user?.login ?? null, text: body });
      notes++;
    }
    if (file.attempts?.length || file.results.length || file.notes.length || file.failures) withRuns++;
    runs.set(n, file);
  }
  s.git.commit((t) => { for (const [n, file] of runs) t.runs.set(n, file); }, `hkb: import ${withRuns} run record(s)`, { allowForeignHost: true });
  const loaded = s.open();

  // The leftovers of the GitHub protocol. A lock ref on the forge means nothing to a local board —
  // the locks are rows in the index now — and a beat chain is a mirror of one.
  const dropped = { locks: 0, chains: 0 };
  try {
    for (const l of await listLocks(ctx)) { if (await release(ctx, l.n, l.k)) dropped.locks++; }
  } catch (e) { log(`import: the lock refs on the remote were left alone (${/** @type {Error} */ (e).message})`); }
  for (const c of listBeatChains(s.root)) { if (dropBeatChain(s.root, c.n, c.k)) dropped.chains++; }

  const summary = {
    cards: tasks.length, open: open.length, closed: closed.length, runs: withRuns, results, notes,
    next_id: Math.max(next, 1), tip: s.git.tip(), branch: s.branch, indexed: loaded.counts?.tasks ?? 0, ...dropped,
  };
  log(`import: ${summary.cards} card(s), ${summary.runs} run record(s), ${summary.results} result(s), ${summary.notes} note(s) on ${s.branch}`);
  log(`import: deleted ${dropped.locks} lock ref(s) on the remote and ${dropped.chains} local beat chain(s)`);
  return summary;
}

// ---------- the mount probe (§6.3, `hkb doctor`) ----------

/** Filesystems the index must not live on: no working POSIX locking, so WAL corrupts or hangs. */
export const REFUSED_FS = ['9p', 'nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'fuseblk', 'afs', 'sshfs', 'vboxsf', 'virtiofs'];

/**
 * The filesystem type a path is on, read from `/proc/mounts` — the longest mount point that is a
 * prefix of it wins, which is how a `/mnt/c` under a `/` is answered with `9p` and not `ext4`.
 *
 * `null` means "this host does not have `/proc/mounts`" (macOS, Windows) or the file was
 * unreadable — a *different* answer from a type nobody recognises, and `hkb doctor` warns on both
 * rather than refusing something it could not check.
 * @param {string} target
 * @param {{mounts?: string}} [opts]
 * @returns {{type: string, mount: string, source: string}|null}
 */
export function mountFor(target, { mounts = '/proc/mounts' } = {}) {
  let text;
  try { text = fs.readFileSync(mounts, 'utf8'); } catch { return null; }
  const want = path.resolve(target);
  let best = null;
  for (const line of text.split('\n')) {
    const [source, point, type] = line.split(/\s+/);
    if (!point || !type) continue;
    // `/proc/mounts` escapes a space in a mount point as `\040`.
    const at = point.replace(/\\040/g, ' ');
    if (want !== at && !want.startsWith(at.endsWith('/') ? at : `${at}/`)) continue;
    if (!best || at.length > best.mount.length) best = { type, mount: at, source };
  }
  return best;
}
