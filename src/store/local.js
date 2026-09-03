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
import { storeRoot, storeGitDir, hostId, runGit, runGitAsync, gitSays, GIT_SHA_RE, readState, writeState, normalizeCardGrants } from '../board.js';
import { RESULT_MARKER, RUN_MARKER, DEFAULT_KB, L, emptyRun, parseResultComment, isResultComment, blockersOf, blockersKnown } from '../model.js';
import { openGitTier, BOARD_BRANCH, BOARD_REF } from './git.js';
import { openIndex, openIndexReadOnly, indexFileIn } from './sqlite.js';
// The read half of the retired GitHub protocol, and the only thing that still speaks it: the
// migration reads a board that is still on issues once, then deletes the lock refs it left behind.
import { openGithubIssues, listComments, listLocks, lockBeatAt, release, listBeatChains, dropBeatChain } from '../bridge/github-issues.js';
import { rest } from '../gh.js';

export { BOARD_BRANCH, BOARD_REF };

/** How often the loop may push, at most (§6.2: "throttled and offline-tolerant"). */
export const SYNC_THROTTLE_MS = 60_000;

/** How fresh another host's dispatcher stamp has to be for `--take-over` to refuse. */
export const HOST_LIVE_MS = 15 * 60_000;

/** How long `git fetch`/`git push` may hold the dispatcher's tick before it is treated as offline. */
export const SYNC_NET_TIMEOUT_MS = 15_000;

/**
 * Why a `git fetch`/`git push` failed with no network. Silent when the loop hits one of these, and
 * an error the human can read when they ran `hkb sync` themselves.
 *
 * The `E*` codes are the second half and the one that is easy to miss: a git that never answers is
 * killed on `SYNC_NET_TIMEOUT_MS`, and what comes back then is not git's prose but node's
 * `ETIMEDOUT`/`ECONNRESET`. A laptop that walks out of wifi mid-fetch produces exactly that, and
 * calling it a broken remote would point the human at a remote that is fine.
 */
export const OFFLINE = /could not resolve host|could not read from remote|unable to access|network is unreachable|no route to host|connection timed out|connection refused|temporary failure in name resolution|operation timed out|the remote end hung up|\bE(TIMEDOUT|CONNRESET|CONNREFUSED|NETUNREACH|HOSTUNREACH|AI_AGAIN|NOTFOUND)\b/i;

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
   * @param {{git?: any, index?: any, host?: string, ref?: string, remote?: string, now?: () => Date, readOnly?: boolean}} [opts]
   *   `readOnly` opens the index through `openIndexReadOnly` — `hkb doctor`'s reader, which must
   *   diagnose an index rather than create one.
   */
  constructor(ctx, { git = null, index = null, host = null, ref = BOARD_REF, remote = null, now = null, readOnly = false } = {}) {
    this.ctx = ctx;
    this._root = storeRoot(ctx);
    // The context's own identity, when it has one: `makeContext` sets `host` and every other verb
    // reads it from there, so the store must not answer to a different name than the process does.
    this.host = host || (ctx && typeof ctx === 'object' ? ctx.host : null) || hostId();
    this.now = now || (() => new Date());
    // Shared with `assertLocalOwner` and with every other store built on this context, so the
    // one-writer guard and the verb behind it decode the tree once between them rather than twice.
    // `now` is forwarded only when the caller gave one — an injected clock is a test's, and
    // `gitTierFor` deliberately refuses to cache (or hand out) a tier built on one.
    this.git = git || gitTierFor(ctx, { ref, remote, host: this.host, ...(now ? { now } : {}) });
    this._index = index || null;
    this._readOnlyIndex = !!readOnly;
    this.remote = this.git.remote;
  }

  /**
   * The index, opened on first use.
   *
   * **Opening a SQLite connection is not free and not every caller needs one.** The dispatcher's
   * end-of-tick pass builds a store every tick to reach `markDispatcher()`, which touches git and
   * nothing else on all but one tick in five minutes; at the interval floor that was a fresh
   * `DatabaseSync`, `ensureSchema` and `assertSameBoard` every five seconds for an answer nobody
   * read. Deferring the open to the first live method — or to the reindex a stamp that *did* land
   * needs — costs a caller that uses the index nothing, and costs one that does not everything it
   * was paying.
   */
  get index() {
    if (!this._index) {
      const opts = { branch: this.git.branch };
      this._index = this._readOnlyIndex ? openIndexReadOnly(this.ctx, opts) : openIndex(this.ctx, opts);
    }
    return this._index;
  }

  /** Has the index been opened? `close()` and the doctor's probes ask before making one. */
  get indexOpen() { return !!this._index; }

  /**
   * The store's root — the common git dir's parent, never a linked worktree.
   *
   * **A method, because that is what the interface says** (`STORE_METHODS`). This was a property
   * here and a function on the GitHub driver, which is precisely the disagreement `STORE_METHODS`
   * exists to catch and could not, because `root` was not on the list. It is now.
   */
  root() { return this._root; }

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

  /** Close the index's connection, if one was ever opened. The git tier holds nothing open. */
  close() { if (this._index) this._index.close(); }

  capabilities() { return { events: true, durable: true }; }

  // ---------- the durable half ----------

  /**
   * Run one durable verb: commit, then index, then wake (§6.1's order).
   *
   * The tip is read before and after so the index and the log see exactly what the branch saw: a
   * verb that wrote the same bytes back lands no commit, and so appends no event and wakes nobody.
   * That is what keeps a reconcile pass — a tick re-asserting the state of twenty cards — free.
   *
   * `number` and `payload` may each be a function of the verb's own return value: `createTask` is
   * the card that only exists once the commit has landed, and an event that could not say which card
   * appeared — or what status it appeared in — would be the one event nobody can act on.
   */
  _durable(kind, number, run, payload = {}) {
    const before = this.git.tip();
    const value = run();
    const after = this._landedTip();
    if (after === before) return value;
    const n = typeof number === 'function' ? number(value) : number;
    const body = typeof payload === 'function' ? payload(value) : payload;
    this._reindex();
    this.index.appendEvent({ kind, task_id: n ?? null, payload: { ...body, tip: after } });
    this.index.wake();
    return value;
  }

  /**
   * A card's status/agent before a write, off the memoized tree — for the event's `from`.
   *
   * Tolerant on purpose: `getTask` throws on a card the branch does not have, and this runs *before*
   * the verb. Letting it throw would answer "no such card" with a read's message where the write's
   * own — the authoritative one — belongs, and would do it for a lookup that is only ever
   * best-effort decoration on an event.
   */
  _was(n) { try { return n ? this.git.getTask(n) : null; } catch { return null; } }

  /**
   * The tip after a write, without asking git again.
   *
   * `GitTier.commit()` re-parses the tree it just landed into the tier's memo, so the sha is already
   * in this process — and a verb that wrote nothing leaves the memo on the sha it read. Only a tier
   * that has never read anything (nothing to memoize) is worth a `rev-parse`.
   */
  _landedTip() {
    const snap = this.git._snap;
    return snap && snap.tip !== undefined ? snap.tip : this.git.tip();
  }

  /**
   * Rebuild the index from the branch as it is now.
   *
   * The tier's *memo* is handed over rather than `readTree()`'s copy: `load()` reads the tree and
   * writes rows, and a `structuredClone` of every card and run on the board — per verb — to hand a
   * reader something it never mutates is the one cost this composition can drop outright.
   */
  _reindex() {
    return this.index.load({ ...this.git._read(), branch: this.branch });
  }

  board() { return this.git.board(); }

  /**
   * **An event's kind names the write, and its payload carries what a reader renders.**
   *
   * Six different writes used to be filed as `status` with an `op` key nothing reads: a settings
   * write, a body edit, a blocked-by edge in either direction, an ordinary label change and a
   * take-over. `hkb watch --kinds status` rendered every one of them `none → none` — a card
   * transition that did not happen — and the two board-wide ones said `task_id: null`, which renders
   * as card `#null`. `needs-human` was worse than vague: adding and clearing the flag were the same
   * kind with the same payload, so a raised flag read as a cleared one.
   *
   * So each op below has a kind of its own (`LOCAL_EVENT_KINDS`, src/store/sqlite.js) and every
   * kind `describeEvent` (src/watch.js) has a case for carries the fields that case reads — `from`
   * and `to` on a status or an agent change, `to` on `needs-human` and on a card appearing, the
   * attempt on a run, the summary on a result.
   */
  setBoard(patch = {}) {
    return this._durable('board', null, () => this.git.setBoard(patch), { op: 'settings', keys: Object.keys(patch || {}) });
  }

  listTasks(opts) { return this.git.listTasks(opts); }
  listClosedRecent(opts) { return this.git.listClosedRecent(opts); }
  getTask(n) { return this.git.getTask(n); }

  createTask(spec) {
    return this._durable(
      KIND.createTask, (task) => task?.number ?? null, () => this.git.createTask(spec),
      (task) => ({ to: task?.status ?? spec?.status ?? 'triage', agent: task?.agent ?? null }),
    );
  }

  updateBody(n, body) {
    return this._durable('body', Number(n), () => this.git.updateBody(n, body), { bytes: String(body ?? '').length });
  }

  /** The machine block, kept as columns here — the write `hkb edit` and `hkb adopt` make. */
  setKb(task, kb, bodyText = undefined) {
    const n = numberOf(task);
    return this._durable('body', n, () => this.git.setKb(task, kb, bodyText), { kb: Object.keys(kb || {}).sort() });
  }

  setStatus(task, status, opts) {
    const n = numberOf(task);
    const from = this._was(n)?.status ?? null;
    return this._durable(KIND.setStatus, n, () => this.git.setStatus(task, status, opts), { from, to: status });
  }

  setAgent(task, agent) {
    const n = numberOf(task);
    const from = this._was(n)?.agent ?? null;
    return this._durable(KIND.setAgent, n, () => this.git.setAgent(task, agent), { from, to: agent });
  }

  /**
   * **A label write reports every label it wrote.**
   *
   * `[L.needsHuman, 'urgent', 'triage-me']` used to be filed as one `needs-human` event carrying
   * `{to: true}` and nothing else, so `hkb watch --kinds labels` showed *nothing at all* for a write
   * that changed three labels — the same event-fidelity defect as the six writes that were once all
   * `status`. The kind is `needs-human` only when the flag is the whole of the write; anything mixed
   * is a `labels` event, and either way the payload carries the full list.
   */
  addLabels(task, names) {
    const n = numberOf(task);
    const add = [].concat(names || []);
    const human = add.includes(L.needsHuman);
    const only = human && add.length === 1;
    return this._durable(only ? 'needs-human' : 'labels', n, () => this.git.addLabels(task, names),
      only ? { to: true } : { add, ...(human ? { to: true } : {}) });
  }

  removeLabel(task, name) {
    const n = numberOf(task);
    const human = name === L.needsHuman;
    return this._durable(human ? 'needs-human' : 'labels', n, () => this.git.removeLabel(task, name), human ? { to: false } : { remove: [name] });
  }

  closeTask(n, reason) {
    return this._durable(KIND.closeTask, Number(n), () => this.git.closeTask(n, reason), { reason: reason ?? 'completed' });
  }

  reopenTask(n) {
    return this._durable(KIND.reopenTask, Number(n), () => this.git.reopenTask(n), {});
  }

  addBlockedBy(child, parent) {
    return this._durable('blocked-by', Number(child), () => this.git.addBlockedBy(child, parent), { blocker: Number(parent) });
  }

  removeBlockedBy(child, parent) {
    return this._durable('unblocked-by', Number(child), () => this.git.removeBlockedBy(child, parent), { blocker: Number(parent) });
  }

  loadRun(n) { return this.git.loadRun(n); }

  saveRun(n, rec) {
    // A run record is `{run, id}` (`loadRun`'s shape, and what every caller passes straight back),
    // so the attempts are `rec.run.attempts`. Reading `rec.attempts` made every attempt event on a
    // local board carry `{attempt: null, profile: null, host: null}` — which is what `hkb log`
    // renders. `rec.attempts` stays in the chain for a caller that hands the bare run in.
    const a = [].concat(rec?.run?.attempts || rec?.attempts || []).slice(-1)[0] || null;
    return this._durable(KIND.saveRun, Number(n), () => this.git.saveRun(n, rec), {
      attempt: a?.attempt ?? null, profile: a?.profile ?? null, host: a?.host ?? null,
    });
  }

  latestResult(n) { return this.git.latestResult(n); }
  parentResults(task) { return this.git.parentResults(task); }

  /**
   * A note is a comment; a worker's handoff arriving through the same call is a result (`git.js`).
   *
   * The kind is decided with `isResultComment` — the marker *and* a parse that succeeds — because
   * that is the predicate the tier files the body with. Deciding it here on the marker alone made a
   * malformed result body a `result` event on `hkb watch --kinds result` and in serve's stream,
   * announcing a handoff that the tier had stored as a note and `latestResult(n)` would never
   * return. Two code paths answering "is this a result" differently is the whole defect; there is
   * one predicate now, in `src/model.js`, and both ask it.
   */
  addNote(n, text) {
    const parsed = isResultComment(text) ? parseResultComment(text) : null;
    return this._durable(
      parsed ? 'result' : 'comment', Number(n), () => this.git.addNote(n, text),
      parsed ? { attempt: parsed.attempt ?? null, summary: parsed.summary ?? null } : { text: String(text ?? '').slice(0, 200) },
    );
  }

  listNotes(n) { return this.git.listNotes(n); }

  /**
   * Labels are columns on a card here, so there is nothing to create before one can be applied and
   * this answers with the empty list. The call stays the caller's: on GitHub a label that does not
   * exist makes `addLabels` fail, and a verb must not have to know which store it is talking to.
   */
  ensureLabels() { return []; }

  // ---------- the live half ----------

  claim(n, k, opts = {}) { return this.index.claim(n, k, { host: this.host, ...opts }); }
  release(n, k) { return this.index.release(n, k); }
  listLocks() { return this.index.listLocks(); }
  lockBeatAt(n, k) { return this.index.lockBeatAt(n, k); }
  /**
   * The index's beat, widened to the §6.4 shape: `expected` and `detail` ride along so a caller can
   * say *why* a beat could not be made before it falls back to the run record. The tier itself keeps
   * the narrow `{result, token}` — the interface is this class's contract, not the index's.
   */
  heartbeat(n, k, expected) {
    const r = this.index.heartbeat(n, k, expected);
    return {
      ...r,
      expected: String(expected ?? ''),
      detail: r.result === 'lost' ? 'the lease was rejected: this claim has been reclaimed' : '',
    };
  }
  /** A claim here is a row in `locks`, not a ref, so it has no name a message could print (§6.4). */
  lockRef() { return null; }
  lockToken(n, k) { return this.index.lockToken(n, k); }
  // Two reads, not one. `locks.token` is the claim; `beats.token` is where *this checkout* left the
  // chain — the counterpart of the GitHub driver's local `refs/kb/locks/<n>/<k>` mirror. Aliasing
  // them made `heartbeat`'s lease check its token against itself, so the warm path could never
  // report `lost` and a reclaim went unnoticed until `release()` happened to delete the row.
  beatToken(n, k) { return this.index.beatToken(n, k); }
  resyncBeat(n, k, token) { return this.index.resyncBeat(n, k, token); }
  dropBeat(n, k) { return this.index.dropBeat(n, k); }
  events(opts) { return this.index.events(opts); }

  /**
   * One card's history, out of the event log this store keeps — the same rows `events()` streams,
   * narrowed to `n` and rendered in the four fields `hkb log` prints.
   */
  taskEvents(n) {
    return this.index.taskEvents(n)
      .map((e) => ({ at: e.at, kind: e.kind, detail: detailOf(e.payload), actor: e.payload?.host ?? null }));
  }
  appendEvent(spec) { return this.index.appendEvent(spec); }
  getAttempt(n, k) { return this.index.getAttempt(n, k); }
  openAttempts() { return this.index.openAttempts(); }
  setAttempt(n, k, patch) { return this.index.setAttempt(n, k, patch); }

  // ---------- one writer (§6.2) ----------

  /**
   * The host `board.json` names, or null on a board that has never been written.
   *
   * A checkout with no branch answers `null` rather than throwing: a board nobody has created is
   * nobody's, which is the same answer `assertLocalOwner` gives, and the two guards must not
   * disagree about a board one of them would pass and the other refuse.
   *
   * There is deliberately no `assertOwner()` method beside this. The refusal has **two** layers and
   * naming a third that nothing called was worse than having two: `assertOwningHost` (src/cli.js,
   * before the verb spends anything) and `GitTier._assertOwner` (inside the write, where the branch
   * actually moves). A store method in between would have been a third copy of the sentence with no
   * caller to keep it honest.
   */
  owner() { return this.git.tip() ? this.git.board().host ?? null : null; }

  /** Is this host the one the branch says writes this board? */
  owns() { const o = this.owner(); return !o || o === this.host; }

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
    const doc = this.git._read().board;
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
    this.index.appendEvent({ kind: 'take-over', task_id: null, payload: { from: owner, to: this.host } });
    return { host: this.host, changed: r.changed, was: owner };
  }

  /**
   * Stamp this host and pid on the branch, so another host's `--take-over` can tell a live board
   * from an abandoned one. Written at most once per `HOST_LIVE_MS / 3`, because it is a commit.
   */
  markDispatcher(pid = process.pid) {
    const doc = this.git._read().board;
    const at = this.now();
    const last = Date.parse(doc?.dispatch?.at || '');
    if (doc?.dispatch?.host === this.host && throttled(at.getTime(), last, HOST_LIVE_MS / 3)) {
      return { stamped: false, tip: this._landedTip() };
    }
    const stamp = { host: this.host, pid, at: at.toISOString() };
    // Committed here rather than through `setBoard()` so the message says what it is: `git log
    // kb-board` is meant to read as the board's decisions, and "hkb: board settings" every few
    // minutes reads as a decision nobody made.
    const r = this.git.commit((t) => {
      if (!t.board) throw fail(`there is no ${this.branch} branch in ${this.root()} — run \`hkb init\` to create the board`);
      t.board.dispatch = stamp;
    }, `hkb: dispatcher on host ${this.host} (pid ${pid})`);
    // The index's *tip* is moved even though the stamp is not a decision (so: no event). Skipping it
    // left `index.tip()` behind `git.tip()` from the very first stamp, which is exactly the shape
    // `hkb doctor` reports as a broken index — a permanent warning on a healthy board.
    //
    // Only the tip: `load({tip})` with no `cards`/`runs` keys leaves both tables alone (§load's own
    // "a key the tree does not carry is a question it did not answer"), which is the whole of what
    // this commit changed. A full `_reindex()` here dropped and re-inserted every task, link, run and
    // result on the board every five minutes, for a field the index's `board` table does not even
    // hold.
    if (r.changed) this.index.load({ tip: r.tip, branch: this.branch });
    return { stamped: r.changed, tip: r.tip };
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
   * **Nothing here reads the board document before the fetch.** A `--single-branch` clone, or one
   * taken before the branch was first pushed, has no `kb-board` at all — and that checkout is the
   * whole point of `hkb sync`: "if a friend clones the repo, I want them to have the board as
   * well". Asking `board()` first threw `there is no kb-board branch` at exactly the person who ran
   * the command to get one. The ref state comes first, the fetch second, and the board document is
   * only read once there is one to read.
   *
   * `settings.sync.push: false` turns off **pushing**, and nothing else: a host that does not
   * publish its copy still has to be able to read a co-worker's. `--no-push` is the same switch as
   * a flag, so the two cannot disagree about what "push" means.
   *
   * @param {{push?: boolean, fetch?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, pushed: boolean, fastForwarded: boolean, offline: boolean, skipped: string|null, remote: string, branch: string, local: string|null, tracking: string|null, detail: string}>}
   */
  async sync({ push = true, fetch = true } = {}) {
    const remote = this.remote;
    const branch = this.branch;
    // **The refs are read once.** `answer()` used to re-`rev-parse` both of them on every return
    // path — including `no-remote` and `offline`, which do no work at all — so the sync the loop
    // runs after every decisive tick spawned five git processes to report that it had done nothing.
    // Every path that *moves* a ref passes what it moved it to, which it already knows.
    let here = this._rev(`refs/heads/${branch}`);
    let there = this._tracking();
    const answer = (over = {}) => ({
      ok: true, pushed: false, fastForwarded: false, offline: false, skipped: null,
      remote, branch, local: here, tracking: there, detail: '', ...over,
    });
    if (!this._hasRemote()) return answer({ skipped: 'no-remote', detail: `no git remote "${remote}" in ${this.root()}` });

    if (fetch) {
      const r = await this._netGit(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
      // A remote that simply has no such branch is not an error: this host is the first to push it.
      if (r.status !== 0 && !/couldn't find remote ref|not found in upstream/i.test(r.out)) {
        if (OFFLINE.test(r.out)) return answer({ offline: true, detail: gitSays(r.out) || 'offline' });
        throw fail(`\`git fetch ${remote} ${branch}\` failed: ${gitSays(r.out) || 'unknown error'} — check the remote with \`git -C ${this.root()} remote -v\`.`);
      }
    }

    // The fetch may have moved the tracking ref, and only that one.
    if (fetch) there = this._tracking();
    const moved = this._reconcileRefs();
    if (moved) {
      // A checkout that had no local branch now has one. That does **not** change which store this
      // board is on — `storeKind` reads `"store"` in board.json and nothing else, precisely so a ref
      // arriving over the network can never flip a checkout onto a store its verbs are not using —
      // but the tier's memo and the index's tip are both built on a ref that just moved, and
      // `_afterRefMoved` is what rebuilds them.
      here = moved.local; there = this._tracking();
      return answer({ fastForwarded: true, detail: moved.detail });
    }
    if (!push) return answer({ detail: 'fetch only' });

    const from = here;
    if (!from) return answer({ skipped: 'no-branch', detail: `there is no ${branch} branch in ${this.root()} and none on ${remote} — run \`hkb init\`` });
    if (this.pushDisabled({ exists: true })) return answer({ skipped: 'off', detail: `sync.push is false in ${branch}'s board.json` });
    if (from === there) return answer({ detail: 'up to date' });

    const r = await this._netGit(['push', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (r.status !== 0) {
      if (OFFLINE.test(r.out)) return answer({ offline: true, detail: gitSays(r.out) || 'offline' });
      if (/non-fast-forward|fetch first|rejected/i.test(r.out)) throw fail(this._divergedMessage(from, this._rev(`refs/remotes/${remote}/${branch}`)));
      throw fail(`\`git push ${remote} ${branch}\` failed: ${gitSays(r.out) || 'unknown error'}`);
    }
    // The remote's copy is now `from`, and the tracking ref is told so under the same compare-and-swap
    // as the rest: `there` is what this pass read. If somebody's `git fetch` moved it in between, the
    // CAS loses and the ref is already right — so the answer reports what the ref *is*, re-read,
    // rather than what this call meant to write.
    const upd = this._setRef(`refs/remotes/${remote}/${branch}`, from, there);
    there = upd.status === 0 ? from : this._tracking();
    return answer({ pushed: true, detail: `pushed ${from.slice(0, 7)} to ${remote}/${branch}` });
  }

  /**
   * Bring `refs/heads/<branch>` up to the remote-tracking ref, or answer null when there is nothing
   * to bring: no tracking ref, already equal, or a local branch that is *ahead* (the push publishes
   * that one).
   *
   * **Every `update-ref` here is a compare-and-swap and its exit status is read.** Ignoring it
   * reported `fastForwarded: true` with the remote's sha as `local` on a ref that had not moved at
   * all — a lost race (another `hkb sync`, a `git fetch`, a worker's verb) exiting 0 and saying the
   * board caught up. A lost CAS re-reads and tries again, because the refs it compared are stale by
   * definition; three losses in a row is a checkout something else is driving, and that is a refusal.
   * @returns {{local: string, detail: string, created: boolean}|null}
   */
  _reconcileRefs(tries = 3) {
    const branch = this.branch;
    for (let i = 0; i < tries; i++) {
      // Read through git rather than the tier: `tip()` falls back to the remote-tracking ref when
      // there is no local branch, and this is the one place that must tell the two apart.
      const here = this._rev(`refs/heads/${branch}`);
      const there = this._tracking();
      if (!there || here === there) return null;
      if (!here) {
        // A clone that has read the board off `origin/kb-board` and now wants a local branch to
        // write. `''` as the old value is git's "this ref must not exist" — the CAS for a create.
        if (this._setRef(`refs/heads/${branch}`, there, '').status !== 0) continue;
        this._afterRefMoved();
        return { local: there, detail: `created ${branch} at ${short(there)}`, created: true };
      }
      if (this._ancestor(here, there)) {
        if (this._setRef(`refs/heads/${branch}`, there, here).status !== 0) continue;
        this._afterRefMoved();
        return { local: there, detail: `fast-forwarded to ${short(there)}`, created: false };
      }
      if (!this._ancestor(there, here)) throw fail(this._divergedMessage(here, there));
      return null; // local is ahead of the remote: the push below is what publishes it
    }
    throw fail(
      `refs/heads/${branch} moved while \`hkb sync\` was fast-forwarding it, ${tries} times in a row — `
      + `something else in this checkout is writing the branch. Look at \`git -C ${this.root()} reflog ${branch}\`, `
      + 'stop the other writer (`hkb down`), and run `hkb sync` again.',
    );
  }

  /** One compare-and-swap on a ref. `from` may be `''` for "must not exist" and null for no check. */
  _setRef(ref, to, from) {
    return this._git(['update-ref', ref, to, ...(from === null || from === undefined ? [] : [from])]);
  }

  /** The branch moved under the tier's memo and the index's tip: both are rebuilt from what is there. */
  _afterRefMoved() { this.git.forget(); this.open(); }

  /**
   * Has this board turned pushing off? False on a board with no branch yet — there is nothing to
   * have said so on, and the caller is about to find that out with a better sentence.
   * @param {{exists?: boolean}} [opts]  `exists: true` from a caller that has already read the refs
   *   and knows there is a branch, so this does not read them a second time.
   */
  pushDisabled({ exists = false } = {}) {
    if (!exists && !this._rev(`refs/heads/${this.branch}`) && !this._tracking()) return false;
    return this.git._read().board?.settings?.sync?.push === false;
  }

  /** What a non-fast-forward means on a branch with one writer, and what to do about it. */
  _divergedMessage(here, there) {
    const owner = this.git._read().board?.host || 'another host';
    return (
      `${this.branch} and ${this.remote}/${this.branch} have diverged (${short(here)} vs ${short(there)}) — `
      + `the board has one writer (docs/local-first.md §6.2) and two hosts have written this one. `
      + `hkb will not merge them. Look at what each side decided with `
      + `\`git -C ${this.root()} log --oneline ${this.branch} ${this.remote}/${this.branch}\`, keep one `
      + `(\`git -C ${this.root()} update-ref refs/heads/${this.branch} <sha>\`), and make sure only host `
      + `"${owner}" writes it — \`hkb init --take-over\` on the host that should.`
    );
  }

  _git(args) { return runGit(this.root(), args); }

  /**
   * The two git calls that touch the network, off the event loop and on a short leash.
   *
   * `spawnSync` would hold the dispatcher's loop for the whole timeout, and the loop is the thing
   * that has to stay responsive: a worker's exit, a wake, a SIGTERM from `hkb down`.
   */
  _netGit(args) { return runGitAsync(this.root(), args, { timeout: SYNC_NET_TIMEOUT_MS }); }

  _rev(ref) {
    const r = this._git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.status === 0 && GIT_SHA_RE.test(r.stdout) ? r.stdout : null;
  }

  _tracking() { return this._rev(`refs/remotes/${this.remote}/${this.branch}`); }

  _ancestor(a, b) { return this._git(['merge-base', '--is-ancestor', a, b]).status === 0; }

  _hasRemote() { return this._git(['remote', 'get-url', this.remote]).status === 0; }
}

function numberOf(task) {
  const n = Number(typeof task === 'object' && task ? task.number ?? task.id : task);
  return Number.isFinite(n) ? n : null;
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : 'nothing');

/**
 * **Every throttle in hkb, and the one rule they share: a stamp is fresh if it is inside the window
 * *on either side of now*.**
 *
 * There are two families of elapsed-time test on a board two hosts can see, and they are not the
 * same question:
 *
 *   · a **liveness** guard (`liveDispatcher`, `lockIsLive`) asks "is somebody there?" and answers a
 *     stamp from the future with *yes*, because saying no walks over a running dispatcher;
 *   · a **throttle** (here, `markDispatcher`, `syncAfterTick`) asks "did I just do this?" and must
 *     answer a stamp from the future with *yes* as well — for a different reason, and this is the
 *     one that was wrong. A clock corrected backwards (NTP, a VM or WSL resync, a laptop waking)
 *     makes `now - last` negative, and `delta >= 0 && delta < window` then read that as **due**: the
 *     dispatcher committed a stamp on `kb-board` and pushed it on *every* tick until real time
 *     caught up, on a branch documented as a history of decisions. It also made a live flaky test.
 *
 * The clamp the previous round put on `liveDispatcher` was the same fix applied to one side of the
 * thing it was about; this is the other side, and it is a shared function so a third site cannot
 * disagree with the first two. Nothing is lost by throttling a future stamp: a stamp in the future
 * is exactly what every *reader* of it already treats as live.
 *
 * The tolerance is the window itself, in both directions. A stamp further ahead than that is not
 * skew, it is a broken record, and rewriting it once (with `now`, which then throttles normally) is
 * the only thing that repairs it.
 *
 * @param {number} now  ms since the epoch
 * @param {number} last `Date.parse` of the stamp, or NaN when there is none
 * @param {number} window  how long the stamp stays fresh
 */
export function throttled(now, last, window) {
  if (!Number.isFinite(last)) return false;
  return Math.abs(now - last) < window;
}

/**
 * Is another host's dispatcher stamp fresh enough to call it live? `null` when the stamp is this
 * host's, missing, unparseable or old.
 *
 * **A stamp in the future is live, not absent.** This guard decides whether `--take-over` may move a
 * board out from under a running dispatcher, so the two clocks it compares are on *different hosts*
 * and ordinary skew — a laptop a minute ahead, an RTC that drifted — is the normal case, not the
 * pathological one. Reading a future stamp as "no live dispatcher" failed the guard open in exactly
 * the direction it must not: two hosts writing one branch. A negative age is clamped to zero, so a
 * stamp from next year reads as freshly written and the human is told to stop the other loop.
 * @returns {{host: string, at: string, age: number}|null}
 */
export function liveDispatcher(board, host, now = new Date()) {
  const d = board?.dispatch;
  if (!d || !d.host || d.host === host) return null;
  const at = Date.parse(d.at || '');
  if (!Number.isFinite(at)) return null;
  const age = Math.max(0, now.getTime() - at);
  if (age > HOST_LIVE_MS) return null;
  return { host: d.host, at: d.at, age };
}

/**
 * The git tiers already built for a context, so one command decodes the board's tree once.
 *
 * `assertOwningHost` opens a tier to read one string out of `board.json`, and the verb behind it
 * then opens the store — two `ls-tree -r` plus two `cat-file --batch` over the whole board, per
 * write verb, with the memo on the tier each of them threw away. The tier memoizes per sha, so
 * sharing one is the whole fix; keyed on what makes two tiers *different* (a branch, a remote, an
 * identity), and skipped entirely when the caller injected a clock, because that tier is a test's
 * and must not be handed to anything else.
 * @type {WeakMap<object, Map<string, any>>}
 */
const TIERS = new WeakMap();

/** @param {any} ctx @param {{ref?: string, remote?: string, host?: string, now?: () => Date}} [opts] */
export function gitTierFor(ctx, opts = {}) {
  if (!ctx || typeof ctx !== 'object' || opts.now) return openGitTier(ctx, opts);
  const key = `${opts.ref || BOARD_REF} ${opts.remote || ''} ${opts.host || ''}`;
  let byKey = TIERS.get(ctx);
  if (!byKey) { byKey = new Map(); TIERS.set(ctx, byKey); }
  let tier = byKey.get(key);
  if (!tier) { tier = openGitTier(ctx, opts); byKey.set(key, tier); }
  return tier;
}

/** Drop the memoized tiers for a context — `hkb init` creates the branch under its own feet. */
export function forgetGitTiers(ctx) {
  if (ctx && typeof ctx === 'object') TIERS.delete(ctx);
}

/**
 * A one-line rendering of an event's payload, for `taskEvents`. The log's payloads are small and
 * differ per kind, so this says what happened without pretending every kind has the same fields.
 * @param {any} payload
 */
function detailOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const p = /** @type {any} */ (payload);
  if (p.to !== undefined) return p.from !== undefined && p.from !== null ? `${p.from} \u2192 ${p.to}` : String(p.to ?? '');
  if (p.summary) return String(p.summary);
  if (p.text) return String(p.text);
  if (p.op) return p.k !== undefined ? `${p.op} attempt ${p.k}` : String(p.op);
  // Only the keys that carry something: a payload whose fields are all null says nothing, and
  // printing `attempt=null profile=null host=null` says it at length.
  const keys = Object.keys(p).filter((k) => p[k] !== null && p[k] !== undefined);
  return keys.length ? keys.map((k) => `${k}=${JSON.stringify(p[k])}`).join(' ').slice(0, 200) : '';
}

/**
 * The local store for `ctx`, reconciled.
 *
 * `open()` runs here rather than in the constructor so a caller that wants the pieces without the
 * `rev-parse` (a test, `hkb doctor`'s probes) can build the class directly.
 * @param {any} ctx
 * @param {{git?: any, index?: any, host?: string, ref?: string, remote?: string, now?: () => Date, reconcile?: boolean, readOnly?: boolean}} [opts]
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
  const t = tier || gitTierFor(ctx, who ? { host: who } : {});
  if (!t.tip()) return null;
  const owner = t._read().board?.host ?? null;
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
 * @returns {Promise<{synced: boolean, why: string, result?: any}>}
 */
export async function syncAfterTick(ctx, { store = null, log = () => {}, now = Date.now(), force = false } = {}) {
  const root = storeRoot(ctx);
  const state = readState(root);
  const last = Number(state.sync_at || 0);
  // The third elapsed-time test on this file's list, and a *throttle* — so it answers a clock that
  // moved the same way `markDispatcher` does. One function, so the three cannot disagree.
  if (!force && throttled(now, last || NaN, SYNC_THROTTLE_MS)) return { synced: false, why: 'throttled' };
  const s = store || openLocalStore(ctx);
  let result;
  try {
    result = await s.sync();
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

/** How fresh a lock's beat has to be for the migration to call the worker holding it alive. */
export const LOCK_LIVE_S = 30 * 60;

/** GitHub's page ceiling, and the whole of what `listClosedRecent` can answer in one query. */
export const CLOSED_PAGE = 100;

/** The REST page size and how many pages the adoption path will walk before it names the ceiling. */
export const ISSUE_PAGE = 100;
export const ISSUE_PAGES = 10;

/**
 * A card record for the branch, from a task in `fetchBoard`'s shape.
 *
 * §6.2's layout, and deliberately the same field names `src/store/git.js` writes: the hoisted
 * columns (`priority`, `paths`, `goal`, `scheduled_at`) on the card, every other `kb` key under
 * `kb`, and the labels that are not columns in `labels`. A card imported here has to read back
 * through `getTask()` exactly like one `createTask()` made, which is what the import test asserts.
 */
export function cardRecord(task, { at = new Date().toISOString(), blockersKnown: known = true, keep = null, onUnknown = 'refuse' } = {}) {
  // An empty `blockedBy` on a card nobody looked up means "not asked", never "nothing blocks it"
  // (`blockersKnown`, src/store/github.js) — and the branch has no third value for it. Writing the
  // guess would erase the board's dependency graph silently and permanently, on the one operation
  // nobody re-runs.
  //
  // `onUnknown` is what makes that a rule rather than a dead end. A refusal with no way through is
  // a different silent failure — louder and equally unusable — and the import hit exactly that on
  // every repo without the GraphQL `blockedBy` field, where a *closed* card's blockers cannot be
  // filled in by any read at all. So there are two answers, and the caller says which is honest for
  // the card it is holding: `refuse` where a better read exists (an open card: read it again with
  // `blockers: "all"`), `drop` where none does — and `drop` is only ever chosen where the edge
  // cannot gate anything, with the import summary naming every card it was chosen for. What is
  // never allowed is writing `[]` and calling it an answer.
  if (!known) {
    if (onUnknown !== 'drop') {
      throw fail(
        `cannot import card #${task?.number}: its blockers were never looked up, and writing "no blockers" `
        + 'would erase the dependency graph of a board that cannot be re-imported. Read the board with '
        + '`listTasks({states: ["OPEN"], blockers: "all"})`, which fills them in on a repo without the '
        + 'GraphQL blocked-by field, and import that.',
      );
    }
    return { ...cardRecord({ ...task, blockedBy: [] }, { at, keep }), blockers_unknown: true };
  }
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
    // `keep` is the set of ids this import is actually writing. An edge to a card that is not being
    // imported resolves, on read, to an open issue nobody can close — `blockerDone()` is false
    // forever and `computeReady()` never returns true, so the card can never be dispatched again.
    // Dropped here and reported by `importGithubBoard`; a silent one is the failure that matters.
    blocked_by: (task.blockedBy || []).map((b) => Number(b.number ?? b))
      .filter((n) => Number.isFinite(n) && (!keep || keep.has(n)))
      .sort((a, b) => a - b),
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
 * **`--import` is two operations, and this is where they part.** Migrating a kb board onto the local
 * store and adopting a repository's issues onto a new one are different jobs that have always shared
 * the flag, and the migration answered for both: its `listTasks` filters on `kb:board:<slug>`, so a
 * repository with three hundred *unlabelled* issues and no kb board at all imported zero cards,
 * logged `0 open card(s)` and created an empty board — while the README promised the command "pulls
 * your existing open issues onto the board as triage". So the dispatch is on the thing that actually
 * distinguishes them: whether there is a kb board here to migrate. No cards on the board query means
 * there is nothing to migrate, and the adoption is what the operator asked for. The summary's `mode`
 * says which ran, and so does the log.
 *
 * @param {any} ctx
 * @param {{store?: any, from?: any, days?: number, log?: (s: string) => void, now?: () => Date, force?: boolean, leftovers?: any, issues?: any}} [opts]
 */
export async function importGithubBoard(ctx, { store = null, from = null, days = IMPORT_WINDOW_DAYS, log = () => {}, now = () => new Date(), force = false, leftovers = {}, issues = null } = {}) {
  const s = store || openLocalStore(ctx, { reconcile: false });
  if (s.git.tip() && !force) {
    // **A diagnosis does not create what it describes**, and neither does a refusal. `s.index.file`
    // reads through the lazy `index` getter, which `mkdir`s the directory, creates `index.db` and
    // runs the schema — so a refusal that exists to leave the board untouched created a file,
    // leaked its connection, and on a node without `node:sqlite` threw a different error in place of
    // this sentence. The path is computed instead; that is what `indexFileIn` is for.
    const file = indexFileIn(storeGitDir(ctx), ctx?.board || null);
    throw fail(
      `${s.branch} already exists in ${s.root()} — \`hkb init --import\` migrates a GitHub board onto a *new* local board, `
      + `and re-importing over one that has been worked would overwrite it with GitHub's copy. `
      + `Look at what is there (\`git log --oneline ${s.branch}\`), and delete it deliberately if the import is what you want: `
      + `\`git -C ${s.root()} branch -D ${s.branch} && rm -f ${file}*\`.`,
    );
  }
  const gh = from || openGithubIssues(ctx);
  const at = now().toISOString();
  const cutoff = now().getTime() - Math.max(0, Number(days) || 0) * 86_400_000;

  // `blockers: 'all'` and not the default: the default fills `blockedBy` in for the *tick's* lanes
  // only (todo and blocked), so on a repo without the GraphQL field every card in triage, ready,
  // running or review would arrive with an empty list that means "not asked". §6.2's branch has no
  // way to say that, and `cardRecord` refuses to guess.
  const open = await gh.listTasks({ states: ['OPEN'], blockers: 'all' });
  const closedPage = await gh.listClosedRecent({ first: CLOSED_PAGE });
  // One page, by the GitHub driver's own design ("One query, no paging", `fetchClosedRecent`). A
  // full page back means there may be more, and a summary that said "N closed in the last 90 days"
  // over a truncated set would read as the whole window.
  const capped = closedPage.length >= CLOSED_PAGE;
  const closed = closedPage
    .filter((t) => { const d = Date.parse(t.updatedAt || ''); return !Number.isFinite(d) || d >= cutoff; });
  const tasks = [...open, ...closed]
    .filter((t, i, all) => all.findIndex((x) => x.number === t.number) === i)
    .sort((a, b) => a.number - b.number);
  // Nothing on the board query is not "an empty migration": it is a repository that has no kb board
  // to migrate, and `--import` there means the other operation. Decided before the first commit, so
  // the two never half-run over each other.
  if (!tasks.length) return adoptOpenIssues(ctx, { store: s, log, now, issues });
  log(`import: migrating the \`${L.board(ctx?.board || 'default')}\` board on ${ctx?.cfg?.repo || 'GitHub'} onto ${s.branch}`);
  log(`import: ${open.length} open card(s) and ${closed.length} closed in the last ${days} day(s)`);
  if (capped) {
    // "May be": a page that comes back exactly full says nothing about whether a next one exists,
    // and `listClosedRecent` is one query by the GitHub driver's own design (`fetchClosedRecent`),
    // so unlike the adoption path there is no page after it to ask. The same rule either way — a
    // ceiling is only reported as reached when it is known to be — and here that means saying "may".
    log(`import: WARNING the closed cards came back as one full page of ${CLOSED_PAGE}, most recently updated first — there may be more, `
      + `and anything closed before #${closedPage[closedPage.length - 1]?.number} would stay on GitHub rather than move to the local board`);
  }

  // A card's blockers are a real answer only where somebody looked them up. `listTasks` says so for
  // the open cards; `listClosedRecent` fills nothing in of its own, so a closed card's list is real
  // only when it rode the board query (the GraphQL `blockedBy` field).
  //
  // On a repo *without* that field there is no read that fills a closed card's blockers in — the
  // REST fill-in runs inside `fetchBoard` and `fetchClosedRecent` never calls it — so refusing the
  // import there dead-ends the only migration path this card exists to provide. The two answers are
  // not symmetric and that is why the policy is per card, not per board:
  //   · an open card whose blockers are unknown is a **refusal**: a better read exists (that is
  //     what `blockers: 'all'` above is), and its edges gate whether the card can ever dispatch.
  //   · a closed card's are **dropped and reported**: a closed card is settled, nothing schedules
  //     it, and its own `blocked_by` gates nothing on the migrated board. What it blocks is the
  //     other direction and is unaffected — that edge lives on the *blocked* card.
  const closedFilled = blockersOf(closedPage).filled || !!ctx?.caps?.blockedByGql;
  const isClosed = (t) => String(t.state || 'OPEN').toUpperCase() === 'CLOSED';
  const knownFor = (t) => (isClosed(t) ? closedFilled : blockersKnown(open, t));
  const policyFor = (t) => (isClosed(t) ? 'drop' : 'refuse');
  /** Closed cards imported with their blockers marked unknown rather than guessed at. */
  const unknownBlockers = tasks.filter((t) => !knownFor(t) && policyFor(t) === 'drop').map((t) => Number(t.number));
  if (unknownBlockers.length) {
    log(`import: ${unknownBlockers.length} closed card(s) imported with their blockers UNKNOWN, not empty — `
      + `this repository has no GraphQL blockedBy field and no read fills a closed card's blockers in. `
      + `They are recorded as \`"blockers_unknown": true\` on the card and gate nothing (a closed card is settled): `
      + `${unknownBlockers.slice(0, 20).map((n) => `#${n}`).join(', ')}${unknownBlockers.length > 20 ? ` +${unknownBlockers.length - 20} more` : ''}`);
  }

  const keep = new Set(tasks.map((t) => Number(t.number)));

  // **Nothing is written while a worker is still running against this board.**
  // The migration's last step deletes the GitHub protocol's lock refs, and a worker whose lock ref
  // disappears heartbeats into a missing ref and exits 3, LOCK_LOST — mid-task, having pushed
  // nothing. So the locks are read *before* the first commit and a live one stops the whole thing:
  // half a migration with two dead workers is not a state anybody can reason about, and the command
  // that does it is the documented adoption path. `--force` is the human's override for a board
  // whose workers are known to be gone.
  /** @type {{n: number, k: number, at: string}[]} */ let held = [];
  try {
    held = await liveLocks(ctx, { keep, now, ...(leftovers.locks ? { list: leftovers.locks.list, beatAt: leftovers.locks.beatAt } : {}) });
  } catch (e) {
    // A listing this read cannot do is one `dropGithubLeftovers` cannot do either, and that half is
    // already guarded: nothing is deleted, so nothing is lost. Said out loud rather than treated as
    // "no locks", which is the answer that would justify deleting them.
    log(`import: could not read the lock refs to check for running workers (${/** @type {Error} */ (e).message}) — no lock will be deleted below either. Make sure \`hkb up --status\` shows nothing running before you rely on this board`);
  }
  if (held.length && !force) {
    throw fail(
      `${held.length} card(s) on this board are claimed by a running worker (${held.map((l) => `#${l.n} attempt ${l.k}, beat ${l.at}`).join('; ')}) — `
      + `\`hkb init --import\` deletes the lock refs those workers heartbeat on, and each one would exit LOCK_LOST mid-task. `
      + `Stop the dispatcher (\`hkb down\`) and let them finish, or wait out their leases, then run the import again. `
      + `\`hkb init --import --force\` migrates anyway, killing them.`,
    );
  }
  if (held.length) log(`import: --force: migrating over ${held.length} live claim(s) (${held.map((l) => `#${l.n}/${l.k}`).join(', ')}); those workers will exit LOCK_LOST`);

  /** @type {{card: number, blocker: number}[]} */ const droppedEdges = [];
  for (const t of tasks) {
    for (const b of t.blockedBy || []) {
      const n = Number(b.number ?? b);
      if (Number.isFinite(n) && !keep.has(n)) droppedEdges.push({ card: Number(t.number), blocker: n });
    }
  }
  for (const e of droppedEdges) {
    log(`import: #${e.card} was blocked by #${e.blocker}, which is not being imported (closed outside the ${days}-day window, or not on this board) — the edge is dropped, and #${e.card} is NOT held back by it on the local board`);
  }

  const slug = ctx?.board || 'default';
  const next = tasks.reduce((m, t) => Math.max(m, Number(t.number) || 0), 0) + 1;
  s.git.commit((t) => {
    t.board = t.board || { version: 1, slug, host: s.host, paused_at: null, paused_by: null, next_id: 1, settings: {} };
    t.board.next_id = Math.max(Number(t.board.next_id) || 1, next);
    for (const task of tasks) t.cards.set(Number(task.number), cardRecord(task, { at, blockersKnown: knownFor(task), onUnknown: policyFor(task), keep }));
  }, `hkb: import ${tasks.length} card(s) from ${ctx?.cfg?.repo || 'GitHub'}`, { allowMissing: true, allowForeignHost: true });

  // The run records, one paginated comments read per card. Read them all first, then land one commit:
  // an await inside a `commit()` mutation would run again on every CAS retry.
  /** @type {Map<number, any>} */ const runs = new Map();
  /** @type {number[]} */ const truncatedComments = [];
  let withRuns = 0; let results = 0; let notes = 0;
  for (const [i, task] of tasks.entries()) {
    const n = Number(task.number);
    log(`import: run record ${i + 1}/${tasks.length} (#${n})`);
    const { run } = await gh.loadRun(n);
    const comments = await listComments(ctx, n);
    // The third ceiling, found by sweeping for the shape rather than the instance: `listComments`
    // stops after five pages of 100 and says nothing, so a long-running card's oldest notes would
    // be missing from the branch with the summary calling the card imported. Named, not fixed here
    // — paging further is `listComments`'s decision to change, and the operator can go and read
    // the issue. What is not acceptable is the silence.
    if (comments.length >= 500) truncatedComments.push(n);
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
  const dropped = await dropGithubLeftovers(ctx, s.root(), { log, keep, now, ...leftovers });

  const summary = {
    cards: tasks.length, open: open.length, closed: closed.length, runs: withRuns, results, notes,
    next_id: Math.max(next, 1), tip: s.git.tip(), branch: s.branch, indexed: loaded.counts?.tasks ?? 0,
    closed_capped: capped, closed_page: CLOSED_PAGE, dropped_blockers: droppedEdges,
    unknown_blockers: unknownBlockers, comments_capped: truncatedComments, mode: 'migrate', ...dropped,
  };
  if (truncatedComments.length) {
    log(`import: WARNING ${truncatedComments.length} card(s) had more comments than one read returns (500), so their oldest notes stayed on GitHub: `
      + truncatedComments.map((n) => `#${n}`).join(', '));
  }
  log(`import: ${summary.cards} card(s), ${summary.runs} run record(s), ${summary.results} result(s), ${summary.notes} note(s) on ${s.branch}`);
  if (droppedEdges.length) log(`import: ${droppedEdges.length} blocker edge(s) dropped because the blocking card was not imported (listed above)`);
  log(`import: deleted ${dropped.locks} lock ref(s) on the remote and ${dropped.chains} local beat chain(s)`);
  return summary;
}

/**
 * The other half of `--import`: a repository's open issues onto a **new** local board, as triage.
 *
 * This is what the README has always promised the flag does ("pulls your existing open issues onto
 * the board as triage"), and on the GitHub store it is a label write per issue. Here there are no
 * labels to write: a card is a file on the branch, so adoption is one commit for the whole set.
 *
 * A pull request is not an issue and never becomes a card. Blockers are written as `[]` and that is
 * a real answer rather than a guess — an issue that has never been on a kb board has no board
 * dependency graph to erase, which is exactly what makes it different from the migration's closed
 * cards; nothing was looked up because there was nothing to look up.
 *
 * @param {any} ctx
 * @param {{store?: any, log?: (s: string) => void, now?: () => Date, issues?: any, pages?: number}} [opts]
 */
export async function adoptOpenIssues(ctx, { store = null, log = () => {}, now = () => new Date(), issues = null, pages = ISSUE_PAGES } = {}) {
  const s = store || openLocalStore(ctx, { reconcile: false });
  const at = now().toISOString();
  const slug = ctx?.board || 'default';
  const read = issues || ((page) => rest('GET', `repos/${ctx?.cfg?.repo}/issues?state=open&per_page=${ISSUE_PAGE}&page=${page}`));
  log(`import: there is no \`${L.board(slug)}\` board on ${ctx?.cfg?.repo || 'GitHub'} to migrate — adopting this repository's open issues into triage instead`);

  /** @type {any[]} */ const found = [];
  let more = false;
  for (let page = 1; page <= pages; page++) {
    const batch = (await read(page)) || [];
    for (const i of batch) if (!i.pull_request) found.push(i);
    if (batch.length < ISSUE_PAGE) break;
    // **A ceiling is only real if there is something above it.** `more = page === pages` called a
    // repository with exactly `pages × ISSUE_PAGE` open issues truncated — the last allowed page
    // came back full, which says nothing about whether a next one exists — and told the operator
    // that issues they had all adopted were left off. So the last full page is followed by one
    // read of the page after it, and *that* is the answer. One extra request, in the one case
    // where the honest answer cannot be worked out from what has already been read.
    if (page === pages) more = ((await read(page + 1)) || []).length > 0;
  }
  // Said out loud rather than reported as the whole repository: the same shape as the migration's
  // closed-card cap. There is no "run it again" to offer — the second run finds the branch and the
  // import refuses — so the ceiling names what is missing and leaves the cards to `hkb create`.
  if (more) log(`import: WARNING stopped at ${pages} page(s) of ${ISSUE_PAGE} open issues (${found.length} adopted) — this repository has more open issues and they are NOT on the board; add the ones you want with \`hkb create\``);

  const tasks = found.map((i) => ({
    number: Number(i.number),
    title: String(i.title || ''),
    body: String(i.body || ''),
    status: 'triage',
    agent: null,
    kb: {},
    needsHuman: false,
    blockedBy: [],
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
    state: 'OPEN',
    stateReason: null,
    createdAt: i.created_at ?? at,
    updatedAt: i.updated_at ?? at,
  })).sort((a, b) => a.number - b.number);

  const next = tasks.reduce((m, t) => Math.max(m, t.number), 0) + 1;
  s.git.commit((t) => {
    t.board = t.board || { version: 1, slug, host: s.host, paused_at: null, paused_by: null, next_id: 1, settings: {} };
    t.board.next_id = Math.max(Number(t.board.next_id) || 1, next);
    for (const task of tasks) t.cards.set(task.number, cardRecord(task, { at }));
  }, `hkb: adopt ${tasks.length} open issue(s) from ${ctx?.cfg?.repo || 'GitHub'} into triage`, { allowMissing: true, allowForeignHost: true });
  const loaded = s.open();

  log(`import: adopted ${tasks.length} open issue(s) into triage on ${s.branch}`);
  return {
    mode: 'adopt', cards: tasks.length, open: tasks.length, closed: 0, runs: 0, results: 0, notes: 0,
    next_id: Math.max(next, 1), tip: s.git.tip(), branch: s.branch, indexed: loaded.counts?.tasks ?? 0,
    issues_capped: more, issue_page: ISSUE_PAGE, closed_capped: false, closed_page: CLOSED_PAGE,
    dropped_blockers: [], unknown_blockers: [], locks: 0, chains: 0,
  };
}

/**
 * Is a worker still holding this lock? `{at, age}` when its last beat is inside `staleAfter`, null
 * when it is older, unreadable or absent.
 *
 * A lock ref whose beat cannot be read is **not** treated as live: a ref with no commit behind it is
 * litter, and the import's own refusal (`liveLocks`) is the guard that matters — this is the
 * per-ref check that stops a deletion of something that was never verified dead.
 * @param {any} ctx
 * @param {{n: number, k: number, sha?: string}} lock
 * @param {{beatAt?: Function, staleAfter?: number, now?: () => Date}} [opts]
 */
export async function lockIsLive(ctx, lock, { beatAt = lockBeatAt, staleAfter = LOCK_LIVE_S, now = () => new Date() } = {}) {
  let at = null;
  try { at = await beatAt(ctx, lock.sha); } catch { return null; }
  const t = Date.parse(at || '');
  if (!Number.isFinite(t)) return null;
  // Clamped, like every other elapsed-time test here: a beat stamped a minute in the future by a
  // host whose clock runs fast is as live as a beat stamped now, never "older than the window".
  const age = Math.max(0, now().getTime() - t) / 1000;
  return age <= staleAfter ? { at, age } : null;
}

/**
 * The locks a migration must not walk over: held on a card it is about to move, and beating.
 * @param {any} ctx
 * @param {{keep?: Set<number>|null, list?: Function, beatAt?: Function, staleAfter?: number, now?: () => Date}} [opts]
 */
export async function liveLocks(ctx, { keep = null, list = listLocks, beatAt = lockBeatAt, staleAfter = LOCK_LIVE_S, now = () => new Date() } = {}) {
  /** @type {{n: number, k: number, at: string}[]} */ const live = [];
  for (const l of await list(ctx)) {
    if (keep && !keep.has(Number(l.n))) continue;
    const held = await lockIsLive(ctx, l, { beatAt, staleAfter, now });
    if (held) live.push({ n: Number(l.n), k: Number(l.k), at: held.at });
  }
  return live;
}

/**
 * Delete what the GitHub protocol leaves behind: the lock refs on the forge and the local beat
 * chains that mirror them. A lock is a row in the index on a local board, and a beat is a column of
 * that row, so neither ref means anything once the board has moved.
 *
 * **Both halves are guarded, and that is the point.** This runs after the migration's two commits
 * and the index load have all succeeded — the board *has* moved. A single ref that will not delete
 * (somebody else's lock, a read-only remote, a ref hkb cannot write) throwing out of here would
 * exit `hkb init --import` non-zero on a board that migrated perfectly, and leave the human unable
 * to tell whether to run it again — which the import's "idempotent by refusal" rule would then
 * refuse anyway. A leftover ref is litter; a failed migration nobody can re-run is not.
 *
 * @param {any} ctx
 * @param {string} root
 * @param {{log?: (s: string) => void, locks?: any, chains?: any, keep?: Set<number>|null, staleAfter?: number, now?: () => Date}} [deps]
 */
export async function dropGithubLeftovers(ctx, root, { log = () => {}, locks = null, chains = null, keep = null, staleAfter = LOCK_LIVE_S, now = () => new Date() } = {}) {
  const L2 = locks || { list: listLocks, release, beatAt: lockBeatAt };
  const C = chains || { list: listBeatChains, drop: dropBeatChain };
  const dropped = { locks: 0, chains: 0, locks_kept: /** @type {any[]} */ ([]), locks_foreign: 0, chains_foreign: 0 };
  // **Scoped to the cards this migration actually moved, and verified dead one by one.**
  // `refs/kb/locks/<n>/<k>` has no board segment in it, so `listLocks(ctx)` enumerates the whole
  // repository's namespace: migrating board `alpha` deleted board `beta`'s live locks and beta's
  // workers lost their claims on their next heartbeat. A lock on a card this import did not touch is
  // somebody else's, and so is a lock whose beat says a worker is still holding it — the import
  // refuses outright when it finds one of those (`liveLocks`), and this is the second check, on the
  // rule that a lock is never deleted unless it was *seen* to be dead.
  try {
    for (const l of await L2.list(ctx)) {
      if (keep && !keep.has(Number(l.n))) { dropped.locks_foreign++; continue; }
      const live = await lockIsLive(ctx, l, { beatAt: L2.beatAt || lockBeatAt, staleAfter, now });
      if (live) { dropped.locks_kept.push({ n: l.n, k: l.k, beat_at: live.at }); continue; }
      if (await L2.release(ctx, l.n, l.k)) dropped.locks++;
    }
    if (dropped.locks_foreign) log(`import: ${dropped.locks_foreign} lock ref(s) belong to cards this import did not move (another board in this repository) and were left alone`);
    for (const k of dropped.locks_kept) log(`import: lock #${k.n}/${k.k} was NOT deleted — it beat at ${k.beat_at}, so a worker is still holding it`);
  } catch (e) { log(`import: the lock refs on the remote were left alone (${/** @type {Error} */ (e).message}) — they mean nothing to a local board; delete them with \`git push origin --delete\` if they bother you`); }
  try {
    for (const c of C.list(root)) {
      if (keep && !keep.has(Number(c.n))) { dropped.chains_foreign++; continue; }
      if (C.drop(root, c.n, c.k)) dropped.chains++;
    }
  // `refs/kb/locks/`, which is where `listBeatChains`/`dropBeatChain` actually read and write
  // (src/store/github.js): a beat chain is a *local* commit chain on the lock's own ref name, not a
  // ref namespace of its own. The message said `refs/kb/beats/`, and an operator following it found
  // nothing at all — advice that names a path that does not exist is worse than no advice.
  } catch (e) { log(`import: the local beat chains were left alone (${/** @type {Error} */ (e).message}) — they are local refs under refs/kb/locks/ (\`git -C ${root} for-each-ref refs/kb/locks/\`) and nothing reads them now`); }
  return dropped;
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
    // `>=`, not `>`: `/proc/mounts` is in mount order, and when two entries share a mount point the
    // *last* is the filesystem in effect. A network filesystem bind-mounted over a local path is
    // precisely what this probe exists to catch, and keeping the first entry reads it as the ext4
    // underneath.
    if (!best || at.length >= best.mount.length) best = { type, mount: at, source };
  }
  return best;
}
