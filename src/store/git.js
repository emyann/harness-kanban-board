// The git tier: the durable half of the board, on the `kb-board` branch.
//
// docs/local-first.md §6.1–§6.2. Everything a `git clone` must carry — the board document, one card
// per file, one run record per card — lives as a tree on `refs/heads/kb-board` and is written with
// plumbing only: `hash-object -w`, `update-index` against a temporary index (`GIT_INDEX_FILE`),
// `write-tree`, `commit-tree`, and `update-ref <new> <expected-old>` as the compare-and-swap. There is
// no `checkout`, no `git add`, and no write into anybody's working tree: a worker committing a card
// from `.claude/worktrees/kb-99-1` leaves `git status --porcelain` empty in that worktree and in the
// main checkout, because the only thing that moved was a ref.
//
// What is **not** here: locks, heartbeats and the event log. Those are host-local and live in the
// `.git/hkb/index.db` index (§6.3, node A5) — a lock on a branch would be a commit per beat. So this
// module is a *tier*, not a `Store`: it implements the durable methods of §6.4 and no others, and A6
// composes it with the index behind one `openStore(ctx)`.
//
// Cost, and why the shape is what it is:
//   - a read is one `git ls-tree -r` to enumerate the tree and one `git cat-file --batch` for every
//     blob in it — never one process per file, however many cards the board has;
//   - a write is one chain — `hash-object` (only for the files whose bytes actually changed; the rest
//     keep the blob sha the read already handed back), `update-index --index-info`, `write-tree`,
//     `commit-tree`, `update-ref` — and a CAS refusal re-reads and replays the mutation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storeRoot, hostId, runGit, gitSays as short, GIT_SHA_RE as SHA_RE, normalizeCardGrants } from '../board.js';
import {
  DEFAULT_KB, L, STATUSES, emptyRun, parseResultComment, serializeBodyBlock,
  RESULT_MARKER, RUN_MARKER, statusOf, agentOf,
} from '../model.js';

export const BOARD_BRANCH = 'kb-board';
export const BOARD_REF = `refs/heads/${BOARD_BRANCH}`;
const ZERO_OID = '0'.repeat(40);
const BLOB_MODE = '100644';
/** The two file names this tier writes and reads. `isOwned` and `_parseFiles` share them on
 *  purpose: a path the parser skips but the writer claims is a path the writer deletes. */
const CARD_FILE = /^cards\/(\d+)\.json$/;
const RUN_FILE = /^runs\/(\d+)\.json$/;
const MAX_CAS_RETRIES = 5;
/** How many git sub-commands `trace` keeps. The *last* 500 — the ones that just failed. */
const TRACE_CAP = 500;

/**
 * The methods of §6.4 this tier owns. The rest of the interface — `claim`, `release`, `listLocks`,
 * `lockBeatAt`, `heartbeat`, `events` — is the index's (A5), and a caller that wants a whole `Store`
 * wants `openStore(ctx)`, not this.
 */
export const DURABLE_METHODS = Object.freeze([
  'board', 'setBoard',
  'listTasks', 'listClosedRecent', 'getTask', 'createTask', 'updateBody',
  'setStatus', 'setAgent', 'addLabels', 'removeLabel',
  'closeTask', 'reopenTask', 'addBlockedBy', 'removeBlockedBy',
  'loadRun', 'saveRun', 'latestResult', 'parentResults', 'addNote', 'listNotes',
]);

// ---------- errors ----------

/** @returns {Error & {exitCode: number}} */
function fail(message, exitCode = 2) {
  const e = /** @type {any} */ (new Error(message));
  e.exitCode = exitCode;
  return e;
}

// ---------- the file format ----------

/**
 * Sorted keys, all the way down; arrays keep their order.
 *
 * `toJSON` is honoured before descending, because `JSON.stringify` would have honoured it: without
 * that, a `Date` in an attempt field is an object with no own enumerable keys, so it sorts to `{}`
 * and the branch records `"started_at": {}` where the caller wrote a timestamp.
 */
function sortDeep(v) {
  if (v && typeof v === 'object' && typeof (/** @type {any} */ (v).toJSON) === 'function') {
    return sortDeep(/** @type {any} */ (v).toJSON());
  }
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    /** @type {any} */ const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

/** §6.2's on-branch format: sorted keys, two-space JSON, one trailing newline. */
export function fileJson(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

// ---------- the card record ----------

// §6.2 hoists the fields the index also has columns for (priority, paths, goal, scheduled_at) out of
// the machine block and onto the card, so a human reading `cards/12.json` in a diff sees them. Every
// *other* `kb` key — v, workspace, max_runtime, max_retries, model, skills, idempotency_key, and
// whatever a profile adds — stays under `kb`, because dropping it would silently reset a dispatch
// field on the next read, which is exactly the bug `updateBody` exists to prevent.
const HOISTED = ['priority', 'paths', 'goal', 'scheduled_at'];

/** The card's `kb`, reassembled from the hoisted columns and the rest. */
function kbOf(card) {
  const kb = { ...DEFAULT_KB, ...(card.kb || {}) };
  for (const k of HOISTED) if (card[k] !== undefined) kb[k] = card[k];
  return normalizeCardGrants(kb);
}

/** Split a `kb` into the hoisted columns and what is left. */
function splitKb(kb = {}) {
  const full = normalizeCardGrants({ ...DEFAULT_KB, ...kb });
  /** @type {any} */ const rest = {};
  for (const [k, v] of Object.entries(full)) if (!HOISTED.includes(k)) rest[k] = v;
  return {
    rest,
    priority: full.priority ?? 0,
    paths: Array.isArray(full.paths) ? full.paths : [],
    goal: full.goal ?? null,
    scheduled_at: full.scheduled_at ?? null,
  };
}

/** Every label the card carries, in the order `src/model.js` expects to find them. */
function labelsOf(card, slug) {
  const out = [L.board(slug)];
  if (card.status) out.push(L.status(card.status));
  if (card.agent) out.push(L.agent(card.agent));
  if (card.needs_human) out.push(L.needsHuman);
  for (const l of card.labels || []) if (!out.includes(l)) out.push(l);
  return out;
}

/**
 * A card as `src/model.js` reads it — `fetchBoard`'s shape (`toTask` in src/store/github.js), so a
 * caller cannot tell which store answered. `url` is null and `prs` empty: a local board has neither,
 * and the forge half (`src/forge.js`) is what knows about pull requests.
 */
function toTask(card, slug, byId) {
  const kb = kbOf(card);
  const labels = labelsOf(card, slug);
  const bodyText = card.body || '';
  return {
    number: card.id,
    nodeId: null,
    databaseId: card.id,
    title: card.title,
    body: serializeBodyBlock(kb, bodyText),
    bodyText,
    kb,
    labels,
    status: card.status ?? null,
    agent: card.agent ?? null,
    board: slug,
    needsHuman: !!card.needs_human,
    state: card.state || 'OPEN',
    stateReason: card.state_reason ?? null,
    updatedAt: card.updated_at ?? null,
    createdAt: card.created_at ?? null,
    url: null,
    blockedBy: (card.blocked_by || []).map((n) => {
      const b = byId?.get(n);
      return {
        number: n,
        state: b ? (b.state || 'OPEN') : 'OPEN',
        stateReason: b ? (b.state_reason ?? null) : null,
        title: b ? b.title : null,
      };
    }),
    prs: [],
    rank: card.rank ?? null,
    suspended: card.suspended ?? null,
  };
}

/** The run file, with every key §6.2 names present even on a card nothing has happened to yet. */
function emptyRunFile() {
  return { ...emptyRun(), results: [], notes: [] };
}

/**
 * One run record, as a copy. The read accessors hand its `attempts`, `results` and `notes` straight
 * out, and the record they come from may be the memoized tree's, so the copy is the deep one.
 */
function runFileOf(runs, id) {
  return { ...emptyRunFile(), ...structuredClone(runs.get(id) || {}) };
}

/** `loadRun`'s half of the file: exactly `emptyRun()`'s keys, never the results or the notes. */
function runOf(file) {
  const run = emptyRun();
  for (const k of Object.keys(run)) if (file[k] !== undefined) run[k] = file[k];
  run.attempts = Array.isArray(run.attempts) ? run.attempts : [];
  return run;
}

// ---------- the tier ----------

export class GitTier {
  /**
   * @param {any} ctx  a context from `makeContext`/`makeContextAt`, or a path
   * @param {{ref?: string, remote?: string, host?: string, now?: () => Date}} [opts]
   */
  constructor(ctx, { ref = BOARD_REF, remote = null, host = null, now = () => new Date() } = {}) {
    this.ctx = ctx;
    /** The common git dir's parent — never `--show-toplevel` (§6.2). */
    this.root = storeRoot(ctx);
    this.ref = ref;
    this.remote = remote || ctx?.cfg?.remote || 'origin';
    this.host = host || hostId();
    this.now = now;
    /** Every git sub-command this tier ran, newest last. Capped; `hkb doctor` and the tests read it. */
    this.trace = [];
    /** The last tree read, keyed by the sha it was read at. See `readTree`. */
    this._snap = null;
  }

  /** @param {string[]} args */
  _git(args, opts) {
    if (this.trace.length >= TRACE_CAP) this.trace.splice(0, this.trace.length - TRACE_CAP + 1);
    this.trace.push(args[0]);
    return runGit(this.root, args, opts);
  }

  /** The branch this tier's ref names — `refs/heads/kb-board` is `kb-board`. */
  get branch() { return this.ref.replace(/^refs\/heads\//, ''); }

  /**
   * Where the board is, and whether that is a ref this host may write.
   *
   * `local: false` means the only copy here is the remote-tracking one — a fresh clone. The board
   * *reads* from there; a write must not, because the compare-and-swap is on `this.ref`, and CASing
   * a local ref against a sha only `refs/remotes/...` has fails with git's absent-ref message, which
   * is not contention however much it looks like it (`classifyRefWrite`).
   * @returns {{sha: string|null, local: boolean}}
   */
  _tip() {
    const local = this._git(['rev-parse', '--verify', '--quiet', `${this.ref}^{commit}`]);
    if (local.status === 0 && SHA_RE.test(local.stdout)) return { sha: local.stdout, local: true };
    const tracked = this._git(['rev-parse', '--verify', '--quiet', `refs/remotes/${this.remote}/${this.branch}^{commit}`]);
    if (tracked.status === 0 && SHA_RE.test(tracked.stdout)) return { sha: tracked.stdout, local: false };
    return { sha: null, local: false };
  }

  /** The commit the board is at, or null when the branch does not exist here or on the remote. */
  tip() { return this._tip().sha; }

  /** Has the board been created here at all? */
  exists() { return this.tip() !== null; }

  /**
   * The whole board, at one commit.
   *
   * One `ls-tree -r` for the paths and one `cat-file --batch` for the bytes — two processes for a
   * board of any size, and never one per file. Both are skipped entirely when the branch has not
   * moved since the last read: the tree is memoized on the sha `_tip()` answers with, so a tick that
   * asks about twelve cards decodes the tree once instead of twelve times, and a verb's `getTask`
   * after its own commit reads the tree the commit already built. The caller gets a copy, so a
   * mutation of what it hands back cannot poison the next reader.
   *
   * @returns {{tip: string|null, local: boolean, board: any, cards: Map<number, any>, runs: Map<number, any>, files: Map<string, {sha: string, mode: string, text: string|null}>}}
   */
  readTree() { return cloneTree(this._read()); }

  /**
   * The memoized tree itself — never handed out.
   *
   * `readTree()` copies it whole, which is what a mutation needs and what a *read* does not: a
   * `getTask` on a 500-card board deep-cloned a thousand records to return one, twice per verb
   * (once for the read, once for the `getTask` after the commit). The read accessors below go
   * through here and copy only the record they are about to return; `commit()` is the one caller
   * that still takes the whole tree, because it edits it.
   * @returns {any}
   */
  _read() {
    const { sha: tip, local } = this._tip();
    if (!tip) return { tip: null, local: false, board: null, cards: new Map(), runs: new Map(), files: new Map() };
    if (this._snap && this._snap.tip === tip && this._snap.local === local) return this._snap;

    const listed = this._git(['ls-tree', '-r', '-z', tip]);
    if (listed.status !== 0) throw fail(`cannot read ${this.ref} at ${tip.slice(0, 7)}: ${short(listed.out) || 'git ls-tree failed'} — check the branch with \`git log ${this.branch}\``);

    /** @type {{sha: string, mode: string, type: string, file: string}[]} */
    const entries = [];
    for (const row of listed.stdout.split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, sha] = row.slice(0, tab).split(/\s+/);
      entries.push({ mode, type, sha, file: row.slice(tab + 1) });
    }

    /** @type {Map<string, {sha: string, mode: string, text: string|null}>} */
    const files = new Map();
    // Only this tier's own blobs are decoded. A gitlink (mode 160000) has no bytes to read, and a
    // foreign path — a README, somebody's notes directory, an image — is carried across by `{sha,
    // mode}` alone: `_land` and `sameTree` never look at its text, so decoding it as UTF-8 would
    // both mangle a binary file and pin every byte of it in `_snap` for the life of the process.
    // Every entry is still in `files`, which is what keeps it on the branch.
    const blobs = entries.filter((e) => e.type === 'blob' && isOwned(e.file));
    let texts = [];
    if (blobs.length) {
      const batch = this._git(['cat-file', '--batch'], { input: `${blobs.map((e) => e.sha).join('\n')}\n`, binary: true });
      if (batch.status !== 0 || !batch.buffer) throw fail(`cannot read the board's blobs at ${tip.slice(0, 7)}: ${short(batch.out) || 'git cat-file --batch failed'}`);
      texts = parseBatch(batch.buffer, blobs.length);
    }
    let blob = 0;
    for (const e of entries) {
      const owned = e.type === 'blob' && isOwned(e.file);
      files.set(e.file, { sha: e.sha, mode: e.mode, text: owned ? (texts[blob++] ?? '') : null });
    }

    this._snap = this._parseFiles(files, tip, local);
    return this._snap;
  }

  /** The board, the cards and the runs a set of file bytes holds. @returns {any} */
  _parseFiles(files, tip, local) {
    const parse = (file) => {
      const hit = files.get(file);
      if (!hit || hit.text === null || hit.text === undefined) return null;
      try { return JSON.parse(hit.text); } catch (e) {
        throw fail(`${file} on ${this.branch} is not JSON (${/** @type {Error} */ (e).message}) — inspect it with \`git show ${this.branch}:${file}\``);
      }
    };
    const board = parse('board.json');
    const cards = new Map();
    const runs = new Map();
    for (const file of files.keys()) {
      const card = CARD_FILE.exec(file);
      if (card) { cards.set(Number(card[1]), parse(file)); continue; }
      const run = RUN_FILE.exec(file);
      if (run) runs.set(Number(run[1]), parse(file));
    }
    return { tip, local, board, cards, runs, files };
  }

  /** Forget the memoized tree. Only a test that moves the branch behind this tier's back needs it. */
  forget() { this._snap = null; }

  // ---------- writing ----------

  /**
   * Apply `mutate` to the board and land it as one commit.
   *
   * `mutate({board, cards, runs})` edits the in-memory copy in place and may return a value, which
   * comes back as `.value`. It runs again from a fresh read on every CAS refusal, so it must be a
   * function of the tree it is handed and nothing else — the retry is the whole reason a mutation is
   * a callback rather than a diff.
   *
   * @param {(tree: {board: any, cards: Map<number, any>, runs: Map<number, any>}) => any} mutate
   * @param {string | ((value: any, tree: any) => string)} message
   * @param {{allowForeignHost?: boolean, allowMissing?: boolean}} [opts]
   * @returns {{tip: string|null, changed: boolean, value: any}}
   */
  commit(mutate, message, { allowForeignHost = false, allowMissing = false } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
      const snap = this.readTree();
      if (!snap.tip && !allowMissing) {
        throw fail(`there is no ${this.branch} branch in ${this.root} — run \`hkb init\` to create the board`);
      }
      const tree = { board: snap.board, cards: snap.cards, runs: snap.runs };
      const value = mutate(tree);
      const want = this._serialize(tree);

      // Nothing to say. A verb that writes the same bytes back must not put a commit on the board's
      // history — `git log kb-board` is the board's history of *decisions* (§6.1).
      //
      // This is asked *before* either guard on writing, because a write that isn't one needs
      // neither: on a read-only clone, `setStatus` to the status a card already has and
      // `addLabels(task, [])` used to hard-fail with exit 2 where they had returned `{changed:
      // false}` before. A reconcile pass that re-asserts current state is exactly what the early
      // return exists to make free, and a clone is exactly where one runs — and a clone's host is
      // by definition not the board's owner, so asking the owner question first put the same exit 2
      // back one line up.
      if (sameTree(want, snap.files)) return { tip: snap.tip, changed: false, value };
      if (!allowForeignHost) this._assertOwner(snap.board);
      this._assertWritableRef(snap);

      const text = typeof message === 'function' ? message(value, tree) : message;
      const landed = this._land(want, snap, text);
      if (landed.ok) {
        // The tree this write just built *is* the branch now, so the `getTask` every verb does after
        // its commit reads it from here instead of spawning another `ls-tree`/`cat-file` pair. It is
        // parsed back out of the bytes that landed, not taken from the mutation's own objects: a
        // caller that wrote a `Date` must read back what the branch says, which is a string.
        this._snap = this._parseFiles(landed.files, /** @type {string} */ (landed.sha), true);
        return { tip: landed.sha, changed: true, value };
      }
      last = landed.detail;
      if (landed.verdict === 'absent') throw fail(this._absentRefMessage(landed.detail));
      if (landed.verdict !== 'contended') throw fail(`cannot write ${this.branch}: ${landed.detail}`);
      this.forget(); // somebody else moved the ref: the memo is a tree that no longer exists
    }
    const at = this.tip();
    const owner = this._read().board?.host || 'unknown';
    throw fail(
      `${this.branch} moved under this write ${MAX_CAS_RETRIES} times — another hkb on host "${owner}" is writing this board `
      + `(${this.ref} is at ${at ? at.slice(0, 7) : 'nothing'}${last ? `; git said: ${last}` : ''}). `
      + 'Wait for it to finish, or stop it with `hkb down`, then run this again.',
    );
  }

  /**
   * A write needs a *local* ref to compare-and-swap. On a clone there is only
   * `refs/remotes/<remote>/kb-board`, which reads fine and cannot be CASed: the update-ref would
   * lease `refs/heads/kb-board` against a sha that ref has never held, git would answer "unable to
   * resolve reference", and — before this — that read as contention, so the write retried five times
   * and blamed a writer that does not exist.
   */
  _assertWritableRef(snap) {
    if (!snap.tip || snap.local) return;
    throw fail(this._absentRefMessage());
  }

  /**
   * Why there was no ref to compare-and-swap against.
   *
   * Git says "unable to resolve reference" for two different things: this clone never had the local
   * branch, and somebody deleted it between the read and the CAS (`git branch -D kb-board`, an
   * `hkb down` racing a verb). Only the first is the read-only-clone story, and prescribing
   * `git branch kb-board origin/kb-board` for the second is advice that fails on its own terms —
   * "not a valid object name" — when there is no remote-tracking ref either. So the clone message
   * is reached only after re-reading the ref and finding it really is only the remote's.
   */
  _absentRefMessage(detail = '') {
    const { sha, local } = this._tip();
    if (sha && !local) {
      return `the board here is a read-only copy: ${this.remote}/${this.branch} exists but ${this.ref} does not, `
        + `so there is nothing to compare-and-swap against. Create the local branch with `
        + `\`git -C ${this.root} branch ${this.branch} ${this.remote}/${this.branch}\`, then take the board over `
        + `with \`hkb init --take-over\` if this host should be the one writing it${detail ? ` (git said: ${detail})` : ''}.`;
    }
    return `${this.ref} went away while this write was landing — something deleted the ${this.branch} branch in `
      + `${this.root} under it${detail ? ` (git said: ${detail})` : ''}. Check \`git reflog ${this.branch}\` for what `
      + 'moved it, then run this again; `hkb init` recreates the board if it is really gone.';
  }

  /** `board.json` names one owning host; every other host reads (§6.2, "One writer"). */
  _assertOwner(board) {
    const owner = board?.host ?? null;
    if (!owner || owner === this.host) return;
    throw fail(
      `this board belongs to host "${owner}" and this is "${this.host}" — the ${this.branch} branch has one writer. `
      + 'Read it here with `hkb list`, or move it to this host with `hkb init --take-over`.',
    );
  }

  /** The bytes the branch should hold after a mutation. @returns {Map<string, string>} */
  _serialize({ board, cards, runs }) {
    /** @type {Map<string, string>} */ const want = new Map();
    if (board) want.set('board.json', fileJson(board));
    for (const [id, card] of cards) if (card) want.set(`cards/${id}.json`, fileJson(card));
    for (const [id, run] of runs) {
      if (!run) continue;
      // A run file that says nothing is a file nobody needs; leaving it out keeps a fresh board's
      // tree to `board.json` plus one blob per card.
      if (isEmptyRunFile(run)) continue;
      want.set(`runs/${id}.json`, fileJson(run));
    }
    return want;
  }

  /**
   * One chain: hash the changed blobs, build a tree against a throwaway index, commit it, CAS the ref.
   * @returns {{ok: boolean, sha: string|null, verdict: 'ok'|'contended'|'absent'|'error', detail: string, files: Map<string, {sha: string, mode: string, text: string|null}>}}
   */
  _land(want, snap, message) {
    /** @type {(verdict: 'contended'|'absent'|'error', detail: string) => any} */
    const no = (verdict, detail) => ({ ok: false, sha: null, verdict, detail, files: snap.files });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-tree-'));
    try {
      // 1. blobs — only for the files whose bytes actually changed. `--stdin-paths` hashes them all
      //    in one process; the unchanged ones keep the sha the read already handed back.
      /** @type {string[]} */ const fresh = [];
      /** @type {string[]} */ const tmpPaths = [];
      let i = 0;
      for (const [file, text] of want) {
        if (snap.files.get(file)?.text === text) continue;
        const tmp = path.join(scratch, `b${i++}`);
        fs.writeFileSync(tmp, text);
        fresh.push(file);
        tmpPaths.push(tmp);
      }
      /** @type {Map<string, {sha: string, mode: string, text: string|null}>} */
      const entries = new Map();
      for (const [file, hit] of snap.files) {
        // Everything the tier does not own — a README somebody put on the branch, a `.gitattributes`,
        // a whole directory of notes — is carried across at the sha and mode it already had. The
        // index below is rebuilt from nothing, so a path left out here is a path *deleted*, silently.
        if (!isOwned(file)) { entries.set(file, hit); continue; }
        if (want.has(file)) entries.set(file, { sha: hit.sha, mode: BLOB_MODE, text: hit.text });
      }
      if (tmpPaths.length) {
        const hashed = this._git(['hash-object', '-w', '-t', 'blob', '--stdin-paths'], { input: `${tmpPaths.join('\n')}\n` });
        const lines = hashed.stdout.split('\n').filter(Boolean);
        if (hashed.status !== 0 || lines.length !== fresh.length) {
          return no('error', short(hashed.out) || 'git hash-object failed');
        }
        fresh.forEach((file, n) => entries.set(file, { sha: lines[n], mode: BLOB_MODE, text: want.get(file) ?? null }));
      }

      // 2. the tree, built in a temporary index that no working tree is attached to. The index is
      //    rebuilt from nothing every time, so a deleted card is a card that is simply not listed.
      //
      //    `-z` terminates each record with a NUL instead of a newline. Git permits a newline in a
      //    path name and `ls-tree -z` hands it back raw, so a foreign `notes/a\nb.md` carried across
      //    verbatim would have split one record into two and corrupted every entry after it. Only
      //    this tier's own three name patterns used to reach this line, which is what made the plain
      //    form safe until foreign paths started travelling through it.
      const index = path.join(scratch, 'index');
      const info = [...entries.keys()].sort().map((file) => `${entries.get(file)?.mode || BLOB_MODE} ${entries.get(file)?.sha}\t${file}`).join('\0');
      const added = this._git(['update-index', '-z', '--add', '--index-info'], { input: `${info}\0`, env: { GIT_INDEX_FILE: index } });
      if (added.status !== 0) return no('error', short(added.out) || 'git update-index failed');

      const wrote = this._git(['write-tree'], { env: { GIT_INDEX_FILE: index } });
      if (wrote.status !== 0 || !SHA_RE.test(wrote.stdout)) {
        return no('error', short(wrote.out) || 'git write-tree failed');
      }

      // 3. the commit, and 4. the compare-and-swap. `update-ref <ref> <new> <old>` is the whole of the
      //    concurrency story: git takes the ref lock, checks the old value and refuses a mismatch.
      const args = ['commit-tree', wrote.stdout, '-m', message];
      if (snap.tip) args.push('-p', snap.tip);
      const made = this._git(args);
      if (made.status !== 0 || !SHA_RE.test(made.stdout)) {
        return no('error', short(made.out) || 'git commit-tree failed');
      }

      const cas = this._git(['update-ref', '-m', message, this.ref, made.stdout, snap.tip || ZERO_OID]);
      if (cas.status === 0) return { ok: true, sha: made.stdout, verdict: 'ok', detail: '', files: entries };
      return no(classifyRefWrite(cas.out), short(cas.out) || 'git update-ref failed');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---------- init ----------

  /**
   * Create the branch when it is not there. Idempotent: an existing board is left exactly as it is,
   * including its owning host — moving that is `takeOver()`, and it is a decision, not a side effect.
   * @returns {{created: boolean, tip: string|null, board: any}}
   */
  init(slug = 'default', host = this.host, { settings = {} } = {}) {
    const snap = this._read();
    if (snap.tip && snap.board) return { created: false, tip: snap.tip, board: structuredClone(snap.board) };
    const doc = {
      version: 1,
      slug,
      host,
      paused_at: null,
      paused_by: null,
      next_id: 1,
      settings,
    };
    const r = this.commit((t) => { t.board = doc; }, `hkb: create board "${slug}"`, { allowForeignHost: true, allowMissing: true });
    return { created: r.changed, tip: r.tip, board: doc };
  }

  /** Move the board to this host. §6.2: the branch has one writer, and this is how the writer changes. */
  takeOver(host = this.host) {
    const r = this.commit((t) => {
      if (!t.board) throw fail(`there is no ${this.branch} branch in ${this.root} — run \`hkb init\` first`);
      t.board.host = host;
    }, `hkb: board moved to host ${host}`, { allowForeignHost: true });
    return { host, changed: r.changed, tip: r.tip };
  }

  // ---------- §6.4: the board document ----------

  capabilities() { return { events: false, durable: true }; }

  board() {
    const b = this._read().board;
    if (!b) throw fail(`there is no ${this.branch} branch in ${this.root} — run \`hkb init\` to create the board`);
    return {
      slug: b.slug,
      host: b.host ?? null,
      paused_at: b.paused_at ?? null,
      paused_by: b.paused_by ?? null,
      settings: structuredClone(b.settings || {}),
    };
  }

  setBoard(patch = {}) {
    this.commit((t) => {
      if (!t.board) throw fail(`there is no ${this.branch} branch in ${this.root} — run \`hkb init\` to create the board`);
      // `settings` merges, everything else is replaced: a caller patching one setting must not have
      // to read the whole document back and hand it in again.
      const { settings, ...rest } = patch;
      Object.assign(t.board, rest);
      if (settings) t.board.settings = { ...(t.board.settings || {}), ...settings };
    }, 'hkb: board settings');
    return this.board();
  }

  // ---------- §6.4: cards ----------

  /** @param {{states?: string[], blockers?: boolean|'all'}} [opts] */
  listTasks({ states = ['OPEN'] } = {}) {
    const want = states.map((x) => String(x).toUpperCase());
    for (const x of want) {
      if (x !== 'OPEN' && x !== 'CLOSED') throw fail(`listTasks: unknown state "${x}" — a store knows OPEN and CLOSED`);
    }
    const snap = this._read();
    const slug = snap.board?.slug || 'default';
    return [...snap.cards.values()]
      .filter((c) => c && want.includes(String(c.state || 'OPEN').toUpperCase()))
      // The copy is per *returned* card: `toTask` hoists `paths`, `kb` and `suspended` straight off
      // the record, so handing them out uncopied would let a caller edit the memo.
      .map((c) => toTask(structuredClone(c), slug, snap.cards))
      .sort((a, b) => a.number - b.number);
  }

  listClosedRecent({ first = 50 } = {}) {
    return this.listTasks({ states: ['CLOSED'] })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, first);
  }

  getTask(n) {
    const snap = this._read();
    const card = snap.cards.get(Number(n));
    if (!card) throw fail(`card #${n} is not on the ${this.branch} board in ${this.root} — \`hkb list\` shows what is`);
    return toTask(structuredClone(card), snap.board?.slug || 'default', snap.cards);
  }

  /** @param {{title: string, body?: string, kb?: any, status?: string, agent?: string|null}} spec */
  createTask({ title, body = '', kb = {}, status = 'triage', agent = null }) {
    if (!title || !String(title).trim()) throw fail('createTask: a card needs a title');
    if (!STATUSES.includes(status)) throw fail(`createTask: invalid status "${status}" — one of ${STATUSES.join(', ')}`);
    const at = this.now().toISOString();
    const { value: id } = this.commit((t) => {
      if (!t.board) throw fail(`there is no board.json on ${this.branch} in ${this.root} — run \`hkb init\` to create the board`);
      const next = nextId(t.board, t.cards);
      t.board.next_id = next + 1;
      const { rest, priority, paths, goal, scheduled_at } = splitKb(kb);
      t.cards.set(next, {
        id: next,
        title: String(title),
        body: String(body || ''),
        status,
        agent: agent || null,
        priority, paths, goal, scheduled_at,
        rank: null,
        suspended: null,
        needs_human: false,
        labels: [],
        blocked_by: [],
        state: 'OPEN',
        state_reason: null,
        closed_at: null,
        created_at: at,
        updated_at: at,
        kb: rest,
      });
      return next;
    }, (n) => `hkb: create #${n} ${String(title).slice(0, 60)}`);
    return this.getTask(id);
  }

  /**
   * Replace the prose, keep the machine block. The `kb` fields never travel through `body` in this
   * store — they are columns on the card — so the bug this guards against on GitHub cannot happen
   * here; the method stays because the interface has it and a caller must not have to know which.
   */
  updateBody(n, body) {
    this._patch(n, (card) => { card.body = String(body ?? ''); }, `hkb: #${n} body`);
    return this.getTask(n);
  }

  setStatus(task, status, { add = [], remove = [] } = {}) {
    if (!STATUSES.includes(status)) throw fail(`invalid status ${status} — one of ${STATUSES.join(', ')}`);
    const n = numberOf(task);
    this._patch(n, (card) => {
      card.status = status;
      applyLabels(card, { add, remove });
    }, `hkb: #${n} → ${status}`);
    const read = this.getTask(n);
    if (task && typeof task === 'object') syncTask(task, read);
    return task && typeof task === 'object' ? task : read;
  }

  setAgent(task, agent) {
    const n = numberOf(task);
    this._patch(n, (card) => { card.agent = agent || null; }, `hkb: #${n} agent ${agent}`);
    const read = this.getTask(n);
    if (task && typeof task === 'object') syncTask(task, read);
    return task && typeof task === 'object' ? task : read;
  }

  addLabels(task, names) {
    const n = numberOf(task);
    this._patch(n, (card) => applyLabels(card, { add: names }), `hkb: #${n} labels`);
    const read = this.getTask(n);
    if (task && typeof task === 'object') syncTask(task, read);
    return task && typeof task === 'object' ? task : read;
  }

  removeLabel(task, name) {
    const n = numberOf(task);
    this._patch(n, (card) => applyLabels(card, { remove: [name] }), `hkb: #${n} labels`);
    const read = this.getTask(n);
    if (task && typeof task === 'object') syncTask(task, read);
    return task && typeof task === 'object' ? task : read;
  }

  closeTask(n, reason = 'completed') {
    const at = this.now().toISOString();
    this._patch(n, (card) => {
      // Only a card that was open gets a closing time: re-stamping it made closing an already-closed
      // card a byte change, so `_patch` saw a decision where there was none and committed. Same hole
      // as `updated_at`, one method further along.
      if (card.state !== 'CLOSED') card.closed_at = at;
      card.state = 'CLOSED';
      card.state_reason = String(reason || 'completed').toUpperCase();
    }, `hkb: close #${n} (${reason})`);
    return this.getTask(n);
  }

  reopenTask(n) {
    this._patch(n, (card) => {
      card.state = 'OPEN';
      card.state_reason = null;
      card.closed_at = null;
    }, `hkb: reopen #${n}`);
    return this.getTask(n);
  }

  addBlockedBy(child, parent) {
    const c = Number(child); const p = Number(parent);
    if (c === p) throw fail(`#${c} cannot block itself`);
    this.commit((t) => {
      const card = need(t.cards, c, this.root, this.branch);
      need(t.cards, p, this.root, this.branch);
      const list = new Set(card.blocked_by || []);
      if (list.has(p)) return; // already linked — see `_patch` on why that is not a commit
      list.add(p);
      card.blocked_by = [...list].sort((x, y) => x - y);
      card.updated_at = this.now().toISOString();
    }, `hkb: #${c} blocked by #${p}`);
    return this.getTask(c);
  }

  removeBlockedBy(child, parent) {
    const c = Number(child); const p = Number(parent);
    this._patch(c, (card) => { card.blocked_by = (card.blocked_by || []).filter((x) => x !== p); }, `hkb: #${c} no longer blocked by #${p}`);
    return this.getTask(c);
  }

  // ---------- §6.4: runs, results, notes ----------

  /** `{run, id}` — `id` is the card, the handle `saveRun` writes back through. */
  loadRun(n) {
    const file = runFileOf(this._read().runs, Number(n));
    return { run: runOf(file), id: Number(n) };
  }

  saveRun(n, rec) {
    const id = Number(n);
    const run = rec?.run || emptyRun();
    this.commit((t) => {
      need(t.cards, id, this.root, this.branch);
      const file = runFileOf(t.runs, id);
      for (const k of Object.keys(emptyRun())) if (run[k] !== undefined) file[k] = run[k];
      t.runs.set(id, file);
    }, `hkb: #${id} run record`);
    if (rec && typeof rec === 'object') rec.id = id;
    return { run, id };
  }

  /** The last structured handoff a worker left, with when it landed. */
  latestResult(n) {
    const file = runFileOf(this._read().runs, Number(n));
    const results = Array.isArray(file.results) ? file.results : [];
    if (!results.length) return null;
    const last = results[results.length - 1];
    return { ...last, at: last.at ?? null, url: null };
  }

  /** `## Parent task results` — what the worker prompt puts in front of the next node. */
  parentResults(task) {
    const snap = this._read();
    const out = [];
    const blockers = Array.isArray(task?.blockedBy)
      ? task.blockedBy
      : (snap.cards.get(numberOf(task))?.blocked_by || []).map((n) => ({ number: n }));
    for (const b of blockers) {
      const card = snap.cards.get(Number(b.number));
      const file = runFileOf(snap.runs, Number(b.number));
      const results = Array.isArray(file.results) ? file.results : [];
      const last = results.length ? results[results.length - 1] : null;
      out.push({
        number: Number(b.number),
        title: b.title ?? card?.title ?? null,
        state: b.state ?? card?.state ?? 'OPEN',
        result: last ? { ...last, at: last.at ?? null, url: null } : null,
      });
    }
    return out;
  }

  /**
   * A note is what a *person* wrote. hkb's own records arrive here too — `hkb finish` hands the
   * result through the same call the GitHub store posts a comment with — so a body carrying the
   * result marker is parsed and filed as a result instead, which is what `latestResult` reads.
   *
   * The test is `startsWith`, and the parse has to succeed. `includes` filed *any* note quoting the
   * marker — a human writing "the `<!-- hkb:result -->` block was empty" — as a result: the note
   * vanished from `listNotes`, and `latestResult` handed the next worker `{at, url: null}` as its
   * parent's handoff, because `parseResultComment` had returned null and the spread of null is `{}`.
   * The GitHub store filters its comments with `startsWith` for the same reason.
   */
  addNote(n, text) {
    const id = Number(n);
    const at = this.now().toISOString();
    const body = String(text ?? '');
    const note = { id: null, at, actor: null, text: body };
    const parsed = body.startsWith(RESULT_MARKER) ? parseResultComment(body) : null;
    this.commit((t) => {
      need(t.cards, id, this.root, this.branch);
      const file = runFileOf(t.runs, id);
      if (parsed) {
        file.results = [...(file.results || []), { ...parsed, at }];
      } else if (body.startsWith(RUN_MARKER)) {
        // The run record has a file of its own; a run comment arriving as a note is a caller that has
        // not been moved onto `saveRun` yet, and swallowing it silently would lose an attempt.
        throw fail(`addNote: #${id} — the run record is not a note; use saveRun(${id}, rec)`);
      } else {
        const notes = file.notes || [];
        note.id = notes.length ? Number(notes[notes.length - 1].id) + 1 : 1;
        file.notes = [...notes, { ...note }];
      }
      t.runs.set(id, file);
    }, `hkb: #${id} note`);
    return note;
  }

  listNotes(n) {
    const file = runFileOf(this._read().runs, Number(n));
    return (file.notes || []).map((x) => ({ id: x.id, at: x.at, actor: x.actor ?? null, text: x.text || '' }));
  }

  // ---------- internals ----------

  /**
   * One card, patched and committed — and *only* committed if the patch decided something.
   *
   * `updated_at` used to be stamped unconditionally, which made every verb a commit whether or not
   * it changed anything: `setStatus` to the status the card already has, `addLabels` with a label
   * that is on it, `removeLabel` for one that never was. `git log kb-board` is meant to be the
   * board's history of decisions (§6.1), and a tick that re-asserts the state of twenty cards would
   * have written twenty commits saying nothing. The GitHub store returns early in the same places.
   */
  _patch(n, fn, message) {
    const id = Number(n);
    return this.commit((t) => {
      const card = need(t.cards, id, this.root, this.branch);
      const before = fileJson(card);
      fn(card);
      if (fileJson(card) === before) return; // nothing decided, so nothing to record
      card.updated_at = this.now().toISOString();
    }, message);
  }
}

/** The git tier for `ctx`. @param {{ref?: string, remote?: string, host?: string, now?: () => Date}} [opts] */
export function openGitTier(ctx, opts = {}) {
  return new GitTier(ctx, opts);
}

// ---------- helpers ----------

/**
 * Split `git cat-file --batch`'s output: `<oid> SP <type> SP <size> LF <contents> LF`, repeated.
 * Sizes are bytes, so the walk is over the Buffer and the slice is decoded once at the end.
 * @returns {string[]}
 */
function parseBatch(buf, expected) {
  /** @type {string[]} */ const out = [];
  let at = 0;
  while (at < buf.length && out.length < expected) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.toString('utf8', at, nl);
    const parts = header.split(' ');
    if (parts.length < 3) throw fail(`git cat-file --batch answered "${header.slice(0, 80)}" — the board's tree is not readable`);
    const size = Number(parts[2]);
    const start = nl + 1;
    out.push(buf.toString('utf8', start, start + size));
    at = start + size + 1; // the LF git writes after the contents
  }
  return out;
}

/**
 * The paths this tier owns and rewrites. Everything else on the branch is somebody's — a README, a
 * `.gitattributes`, a directory of notes — and the write path carries it across untouched.
 *
 * It matches the *files*, not the directories: `_parseFiles` only ever recognises `cards/<digits>
 * .json`, so claiming the whole `cards/` prefix meant a `cards/README.md` was read by nobody and
 * deleted by the first write. It also fooled the no-op guard — `sameTree` counted that file in
 * `had` and never in `want`, so a verb that decided nothing landed a commit whose only effect was
 * to remove it.
 */
export function isOwned(file) {
  return file === 'board.json' || CARD_FILE.test(file) || RUN_FILE.test(file);
}

/** Did the mutation actually change any bytes? Only the tier's own paths can have. */
function sameTree(want, files) {
  const had = [...files.keys()].filter(isOwned);
  if (had.length !== want.size) return false;
  for (const [file, text] of want) if (files.get(file)?.text !== text) return false;
  return true;
}

/**
 * A copy of a read tree, so the memo cannot be edited by whoever it was handed to.
 *
 * `files` is shared by reference: its values are `{sha, mode, text}` of immutable strings and
 * nothing writes to them. The card and run records are what a mutation edits in place.
 */
function cloneTree(snap) {
  return {
    tip: snap.tip,
    local: snap.local,
    board: snap.board ? structuredClone(snap.board) : snap.board,
    cards: new Map([...snap.cards].map(([id, c]) => [id, c ? structuredClone(c) : c])),
    runs: new Map([...snap.runs].map(([id, r]) => [id, r ? structuredClone(r) : r])),
    files: new Map(snap.files),
  };
}

/** A run file with nothing in it is a file the branch does not need to carry. */
function isEmptyRunFile(run) {
  return !(run.attempts || []).length && !(run.results || []).length && !(run.notes || []).length
    && !run.failures && !run.last_error && !Object.keys(run.block_loops || {}).length;
}

/**
 * Why `update-ref` refused, from what git said. Measured against git 2.43:
 *
 *   contended — `cannot lock ref 'refs/heads/kb-board': is at <sha> but expected <sha>`
 *   absent    — `cannot lock ref 'refs/heads/nope': unable to resolve reference 'refs/heads/nope'`
 *
 * Both start "cannot lock ref", which is why matching that alone read a branch that is *not there*
 * as a writer that is: the retry then replayed five times and blamed a host nobody is running on.
 * A missing ref is a fact about this clone, and retrying cannot change it.
 * @returns {'contended'|'absent'|'error'}
 */
export function classifyRefWrite(out) {
  const text = String(out || '');
  if (/unable to resolve reference|reference is missing but/i.test(text)) return 'absent';
  if (/cannot lock ref|unable to lock|is at [0-9a-f]+ but expected|reference already exists|ref .* is at/i.test(text)) return 'contended';
  return 'error';
}

function nextFree(cards) {
  let max = 0;
  for (const id of cards.keys()) if (id > max) max = id;
  return max + 1;
}

/**
 * The next id to hand out: `board.json`'s `next_id`, but never one a card already occupies.
 *
 * `next_id` is a number in a file the design invites a human to read and a merge to touch. Trusting
 * it made `createTask` overwrite card #1 — no error, no trace, the card simply became the new one —
 * whenever it had been rewound by hand or by a bad merge. `nextFree` was already here as the
 * NaN fallback; it is the guard on every allocation now. (`Number(x) || nextFree(...)` was also
 * falsy on `next_id: 0`, which is exactly the value a truncated file has.)
 */
function nextId(board, cards) {
  const free = nextFree(cards);
  const want = Number(board?.next_id);
  return Number.isInteger(want) && want > 0 ? Math.max(want, free) : free;
}

/** `branch` is the tier's own — the constructor takes `ref`, so no message here may name `kb-board`. */
function need(cards, id, root, branch = BOARD_BRANCH) {
  const card = cards.get(id);
  if (!card) throw fail(`card #${id} is not on the ${branch} board in ${root} — \`hkb list\` shows what is`);
  return card;
}

function numberOf(task) {
  const n = Number(typeof task === 'object' && task ? task.number ?? task.id : task);
  if (!Number.isInteger(n)) throw fail(`expected a card number, got ${JSON.stringify(task)}`);
  return n;
}

/**
 * Labels, as columns. `kb:status:*`, `kb:agent:*`, `kb:board:*` and `kb:needs-human` are fields on
 * the card and are set through them; anything else — `kb:no-track`, a human's own label — is carried
 * as-is, so a caller that adds one gets it back from `getTask`.
 */
function applyLabels(card, { add = [], remove = [] } = {}) {
  const extra = new Set(card.labels || []);
  for (const l of remove) {
    if (l === L.needsHuman) { card.needs_human = false; continue; }
    if (l.startsWith('kb:status:')) { if (L.status(card.status) === l) card.status = null; continue; }
    if (l.startsWith('kb:agent:')) { if (agentOf([l]) === card.agent) card.agent = null; continue; }
    if (l.startsWith('kb:board:')) continue;
    extra.delete(l);
  }
  for (const l of add) {
    if (l === L.needsHuman) { card.needs_human = true; continue; }
    if (l.startsWith('kb:status:')) { card.status = statusOf([l]); continue; }
    if (l.startsWith('kb:agent:')) { card.agent = agentOf([l]); continue; }
    if (l.startsWith('kb:board:')) continue;
    extra.add(l);
  }
  // Sorted, but only written back when the set actually moved: re-sorting unconditionally turned
  // `addLabels(task, [])` on a card whose stored `labels` happen to be out of order into a byte
  // change, and so into a commit that decided nothing.
  const next = [...extra].sort();
  const prev = [...(card.labels || [])].sort();
  if (prev.length !== next.length || next.some((l, i) => l !== prev[i])) card.labels = next;
}

/**
 * What `src/forge.js` fills in and this tier cannot: the branch has no pull requests and no issue
 * URL. `toTask` hardcodes them empty, so copying them over a caller's task *erases* them.
 */
const FORGE_FIELDS = ['prs', 'url', 'nodeId'];

/**
 * Bring the caller's task object up to date in place. Every verb on the GitHub store does this — a
 * caller holds one task through a whole tick and reads `task.status` after moving it — so a driver
 * that returned a fresh object and left the old one stale would break them silently.
 *
 * It *merges*: a field this tier does not know about keeps the value the caller already had.
 * Replacing wholesale is how `requestChanges` broke — it calls `setStatus` and then reads
 * `task.prs`, and the empty `prs` from a fresh read had just overwritten the open PR it was about
 * to continue, so it reported "no open PR" for a card that had one.
 */
function syncTask(task, read) {
  for (const k of Object.keys(read)) {
    if (FORGE_FIELDS.includes(k) && isEmptyForgeValue(read[k]) && !isEmptyForgeValue(task[k])) continue;
    task[k] = read[k];
  }
  return task;
}

function isEmptyForgeValue(v) {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}
