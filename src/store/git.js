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
import { spawnSync } from 'node:child_process';
import { storeRoot, hostId } from '../board.js';
import {
  DEFAULT_KB, L, STATUSES, emptyRun, parseResultComment, serializeBodyBlock,
  RESULT_MARKER, RUN_MARKER, statusOf, agentOf,
} from '../model.js';

export const BOARD_BRANCH = 'kb-board';
export const BOARD_REF = `refs/heads/${BOARD_BRANCH}`;
const ZERO_OID = '0'.repeat(40);
const SHA_RE = /^[0-9a-f]{40}$/;
const BLOB_MODE = '100644';
const MAX_CAS_RETRIES = 5;

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

/** The two lines of git output worth putting in an error message. */
function short(s) {
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const loud = lines.filter((l) => /^(fatal|error|warning|!)/i.test(l));
  return (loud.length ? loud : lines).slice(0, 2).join(' ').slice(0, 200);
}

// ---------- git ----------

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'hkb', GIT_AUTHOR_EMAIL: 'hkb@local',
  GIT_COMMITTER_NAME: 'hkb', GIT_COMMITTER_EMAIL: 'hkb@local',
  GIT_TERMINAL_PROMPT: '0', // nobody is here to answer a credential prompt
};

// Anything a hook, a `git` alias or a parent process may have exported that would silently point our
// plumbing at another repository — or at somebody else's index. `hkb`'s own Stop hook runs inside
// `git` sometimes; `GIT_INDEX_FILE` leaking in is how a store write ends up staging a worker's files.
const GIT_UNSET = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

function gitEnv(extra = {}) {
  const env = { ...process.env, ...GIT_ENV, ...extra };
  for (const k of GIT_UNSET) if (!(k in extra)) delete env[k];
  return env;
}

/**
 * Run git at the store root. Never throws — the caller reads `status` and classifies.
 * @returns {{status: number|null, out: string, stdout: string, buffer: Buffer|null}}
 */
function git(root, args, { input = null, env = {}, timeout = 30_000, binary = false } = {}) {
  const res = spawnSync('git', args, {
    cwd: root, input, timeout, env: gitEnv(env),
    // `undefined` is spawnSync's own default, and the only way to get Buffers back while still
    // handing it a string on stdin — the literal 'buffer' encodes the *input* too, and throws.
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = binary
    ? `${res.stderr ? String(res.stderr) : ''}`
    : `${res.stdout || ''}${res.stderr || ''}`;
  if (res.error) return { status: null, out: `${out}${res.error.message}`, stdout: '', buffer: null };
  return {
    status: res.status,
    out,
    stdout: binary ? '' : String(res.stdout || '').trim(),
    buffer: binary ? /** @type {any} */ (res.stdout) : null,
  };
}

// ---------- the file format ----------

/** Sorted keys, all the way down; arrays keep their order. */
function sortDeep(v) {
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

/** Same dedupe `src/store/github.js` applies to a card's grant lists — never a widening guess. */
function normalizeGrants(kb) {
  for (const key of ['tools', 'mcp']) {
    if (!Array.isArray(kb?.[key])) continue;
    kb[key] = [...new Set(kb[key].filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))];
  }
  return kb;
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
  return normalizeGrants(kb);
}

/** Split a `kb` into the hoisted columns and what is left. */
function splitKb(kb = {}) {
  const full = normalizeGrants({ ...DEFAULT_KB, ...kb });
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

function runFileOf(runs, id) {
  return { ...emptyRunFile(), ...(runs.get(id) || {}) };
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
  }

  /** @param {string[]} args */
  _git(args, opts) {
    if (this.trace.length > 500) this.trace.length = 0;
    this.trace.push(args[0]);
    return git(this.root, args, opts);
  }

  /** The commit the board is at, or null when the branch does not exist here or on the remote. */
  tip() {
    const local = this._git(['rev-parse', '--verify', '--quiet', `${this.ref}^{commit}`]);
    if (local.status === 0 && SHA_RE.test(local.stdout)) return local.stdout;
    // A friend who cloned has `origin/kb-board` and no local branch: the board reads, and `commit()`
    // refuses anyway because `board.json` names another host (§6.2, "One writer").
    const tracked = this._git(['rev-parse', '--verify', '--quiet', `refs/remotes/${this.remote}/${BOARD_BRANCH}^{commit}`]);
    return tracked.status === 0 && SHA_RE.test(tracked.stdout) ? tracked.stdout : null;
  }

  /** Has the board been created here at all? */
  exists() { return this.tip() !== null; }

  /**
   * The whole board, at one commit.
   *
   * One `ls-tree -r` for the paths and one `cat-file --batch` for the bytes — two processes for a
   * board of any size, and never one per file.
   * @returns {{tip: string|null, board: any, cards: Map<number, any>, runs: Map<number, any>, files: Map<string, {sha: string, text: string}>}}
   */
  readTree() {
    const tip = this.tip();
    const empty = { tip: null, board: null, cards: new Map(), runs: new Map(), files: new Map() };
    if (!tip) return empty;

    const listed = this._git(['ls-tree', '-r', '-z', tip]);
    if (listed.status !== 0) throw fail(`cannot read ${this.ref} at ${tip.slice(0, 7)}: ${short(listed.out) || 'git ls-tree failed'} — check the branch with \`git log ${BOARD_BRANCH}\``);

    /** @type {{sha: string, file: string}[]} */
    const entries = [];
    for (const row of listed.stdout.split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const [, type, sha] = row.slice(0, tab).split(/\s+/);
      if (type !== 'blob') continue;
      entries.push({ sha, file: row.slice(tab + 1) });
    }

    const files = new Map();
    if (entries.length) {
      const batch = this._git(['cat-file', '--batch'], { input: `${entries.map((e) => e.sha).join('\n')}\n`, binary: true });
      if (batch.status !== 0 || !batch.buffer) throw fail(`cannot read the board's blobs at ${tip.slice(0, 7)}: ${short(batch.out) || 'git cat-file --batch failed'}`);
      const texts = parseBatch(batch.buffer, entries.length);
      entries.forEach((e, i) => files.set(e.file, { sha: e.sha, text: texts[i] ?? '' }));
    }

    const parse = (file) => {
      const hit = files.get(file);
      if (!hit) return null;
      try { return JSON.parse(hit.text); } catch (e) {
        throw fail(`${file} on ${BOARD_BRANCH} is not JSON (${/** @type {Error} */ (e).message}) — inspect it with \`git show ${BOARD_BRANCH}:${file}\``);
      }
    };

    const board = parse('board.json');
    const cards = new Map();
    const runs = new Map();
    for (const file of files.keys()) {
      const card = /^cards\/(\d+)\.json$/.exec(file);
      if (card) { cards.set(Number(card[1]), parse(file)); continue; }
      const run = /^runs\/(\d+)\.json$/.exec(file);
      if (run) runs.set(Number(run[1]), parse(file));
    }
    return { tip, board, cards, runs, files };
  }

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
        throw fail(`there is no ${BOARD_BRANCH} branch in ${this.root} — run \`hkb init\` to create the board`);
      }
      if (!allowForeignHost) this._assertOwner(snap.board);

      const tree = { board: snap.board, cards: snap.cards, runs: snap.runs };
      const value = mutate(tree);
      const want = this._serialize(tree);

      // Nothing to say. A verb that writes the same bytes back must not put a commit on the board's
      // history — `git log kb-board` is the board's history of *decisions* (§6.1).
      if (sameTree(want, snap.files)) return { tip: snap.tip, changed: false, value };

      const text = typeof message === 'function' ? message(value, tree) : message;
      const landed = this._land(want, snap, text);
      if (landed.ok) return { tip: landed.sha, changed: true, value };
      last = landed.detail;
      if (!landed.contended) throw fail(`cannot write ${BOARD_BRANCH}: ${landed.detail}`);
    }
    const at = this.tip();
    const owner = this.readTree().board?.host || 'unknown';
    throw fail(
      `${BOARD_BRANCH} moved under this write ${MAX_CAS_RETRIES} times — another hkb on host "${owner}" is writing this board `
      + `(${this.ref} is at ${at ? at.slice(0, 7) : 'nothing'}${last ? `; git said: ${last}` : ''}). `
      + 'Wait for it to finish, or stop it with `hkb down`, then run this again.',
    );
  }

  /** `board.json` names one owning host; every other host reads (§6.2, "One writer"). */
  _assertOwner(board) {
    const owner = board?.host ?? null;
    if (!owner || owner === this.host) return;
    throw fail(
      `this board belongs to host "${owner}" and this is "${this.host}" — the ${BOARD_BRANCH} branch has one writer. `
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
   * @returns {{ok: boolean, sha: string|null, contended: boolean, detail: string}}
   */
  _land(want, snap, message) {
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
      /** @type {Map<string, string>} */ const shas = new Map();
      for (const [file, hit] of snap.files) if (want.has(file)) shas.set(file, hit.sha);
      if (tmpPaths.length) {
        const hashed = this._git(['hash-object', '-w', '-t', 'blob', '--stdin-paths'], { input: `${tmpPaths.join('\n')}\n` });
        const lines = hashed.stdout.split('\n').filter(Boolean);
        if (hashed.status !== 0 || lines.length !== fresh.length) {
          return { ok: false, sha: null, contended: false, detail: short(hashed.out) || 'git hash-object failed' };
        }
        fresh.forEach((file, n) => shas.set(file, lines[n]));
      }

      // 2. the tree, built in a temporary index that no working tree is attached to. The index is
      //    rebuilt from nothing every time, so a deleted card is a card that is simply not listed.
      const index = path.join(scratch, 'index');
      const info = [...want.keys()].sort().map((file) => `${BLOB_MODE} ${shas.get(file)}\t${file}`).join('\n');
      const added = this._git(['update-index', '--add', '--index-info'], { input: `${info}\n`, env: { GIT_INDEX_FILE: index } });
      if (added.status !== 0) return { ok: false, sha: null, contended: false, detail: short(added.out) || 'git update-index failed' };

      const wrote = this._git(['write-tree'], { env: { GIT_INDEX_FILE: index } });
      if (wrote.status !== 0 || !SHA_RE.test(wrote.stdout)) {
        return { ok: false, sha: null, contended: false, detail: short(wrote.out) || 'git write-tree failed' };
      }

      // 3. the commit, and 4. the compare-and-swap. `update-ref <ref> <new> <old>` is the whole of the
      //    concurrency story: git takes the ref lock, checks the old value and refuses a mismatch.
      const args = ['commit-tree', wrote.stdout, '-m', message];
      if (snap.tip) args.push('-p', snap.tip);
      const made = this._git(args);
      if (made.status !== 0 || !SHA_RE.test(made.stdout)) {
        return { ok: false, sha: null, contended: false, detail: short(made.out) || 'git commit-tree failed' };
      }

      const cas = this._git(['update-ref', '-m', message, this.ref, made.stdout, snap.tip || ZERO_OID]);
      if (cas.status === 0) return { ok: true, sha: made.stdout, contended: false, detail: '' };
      return { ok: false, sha: null, contended: isContended(cas.out), detail: short(cas.out) || 'git update-ref failed' };
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
    const snap = this.readTree();
    if (snap.tip && snap.board) return { created: false, tip: snap.tip, board: snap.board };
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
      if (!t.board) throw fail(`there is no ${BOARD_BRANCH} branch in ${this.root} — run \`hkb init\` first`);
      t.board.host = host;
    }, `hkb: board moved to host ${host}`, { allowForeignHost: true });
    return { host, changed: r.changed, tip: r.tip };
  }

  // ---------- §6.4: the board document ----------

  capabilities() { return { events: false, durable: true }; }

  board() {
    const b = this.readTree().board;
    if (!b) throw fail(`there is no ${BOARD_BRANCH} branch in ${this.root} — run \`hkb init\` to create the board`);
    return {
      slug: b.slug,
      host: b.host ?? null,
      paused_at: b.paused_at ?? null,
      paused_by: b.paused_by ?? null,
      settings: b.settings || {},
    };
  }

  setBoard(patch = {}) {
    this.commit((t) => {
      if (!t.board) throw fail(`there is no ${BOARD_BRANCH} branch in ${this.root} — run \`hkb init\` to create the board`);
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
    const snap = this.readTree();
    const slug = snap.board?.slug || 'default';
    return [...snap.cards.values()]
      .filter((c) => c && want.includes(String(c.state || 'OPEN').toUpperCase()))
      .map((c) => toTask(c, slug, snap.cards))
      .sort((a, b) => a.number - b.number);
  }

  listClosedRecent({ first = 50 } = {}) {
    return this.listTasks({ states: ['CLOSED'] })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, first);
  }

  getTask(n) {
    const snap = this.readTree();
    const card = snap.cards.get(Number(n));
    if (!card) throw fail(`card #${n} is not on the ${BOARD_BRANCH} board in ${this.root} — \`hkb list\` shows what is`);
    return toTask(card, snap.board?.slug || 'default', snap.cards);
  }

  /** @param {{title: string, body?: string, kb?: any, status?: string, agent?: string|null}} spec */
  createTask({ title, body = '', kb = {}, status = 'triage', agent = null }) {
    if (!title || !String(title).trim()) throw fail('createTask: a card needs a title');
    if (!STATUSES.includes(status)) throw fail(`createTask: invalid status "${status}" — one of ${STATUSES.join(', ')}`);
    const at = this.now().toISOString();
    const { value: id } = this.commit((t) => {
      const next = Number(t.board?.next_id) || nextFree(t.cards);
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
      card.state = 'CLOSED';
      card.state_reason = String(reason || 'completed').toUpperCase();
      card.closed_at = at;
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
      const card = need(t.cards, c, this.root);
      need(t.cards, p, this.root);
      const list = new Set(card.blocked_by || []);
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
    const file = runFileOf(this.readTree().runs, Number(n));
    return { run: runOf(file), id: Number(n) };
  }

  saveRun(n, rec) {
    const id = Number(n);
    const run = rec?.run || emptyRun();
    this.commit((t) => {
      need(t.cards, id, this.root);
      const file = runFileOf(t.runs, id);
      for (const k of Object.keys(emptyRun())) if (run[k] !== undefined) file[k] = run[k];
      t.runs.set(id, file);
    }, `hkb: #${id} run record`);
    if (rec && typeof rec === 'object') rec.id = id;
    return { run, id };
  }

  /** The last structured handoff a worker left, with when it landed. */
  latestResult(n) {
    const file = runFileOf(this.readTree().runs, Number(n));
    const results = Array.isArray(file.results) ? file.results : [];
    if (!results.length) return null;
    const last = results[results.length - 1];
    return { ...last, at: last.at ?? null, url: null };
  }

  /** `## Parent task results` — what the worker prompt puts in front of the next node. */
  parentResults(task) {
    const snap = this.readTree();
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
   */
  addNote(n, text) {
    const id = Number(n);
    const at = this.now().toISOString();
    const body = String(text ?? '');
    const note = { id: null, at, actor: null, text: body };
    this.commit((t) => {
      need(t.cards, id, this.root);
      const file = runFileOf(t.runs, id);
      if (body.includes(RESULT_MARKER)) {
        const parsed = parseResultComment(body);
        file.results = [...(file.results || []), { ...(parsed || {}), at }];
      } else if (body.includes(RUN_MARKER)) {
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
    const file = runFileOf(this.readTree().runs, Number(n));
    return (file.notes || []).map((x) => ({ id: x.id, at: x.at, actor: x.actor ?? null, text: x.text || '' }));
  }

  // ---------- internals ----------

  /** One card, patched and committed. */
  _patch(n, fn, message) {
    const id = Number(n);
    return this.commit((t) => {
      const card = need(t.cards, id, this.root);
      fn(card);
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

/** Did the mutation actually change any bytes? */
function sameTree(want, files) {
  const had = [...files.keys()].filter((f) => f === 'board.json' || f.startsWith('cards/') || f.startsWith('runs/'));
  if (had.length !== want.size) return false;
  for (const [file, text] of want) if (files.get(file)?.text !== text) return false;
  return true;
}

/** A run file with nothing in it is a file the branch does not need to carry. */
function isEmptyRunFile(run) {
  return !(run.attempts || []).length && !(run.results || []).length && !(run.notes || []).length
    && !run.failures && !run.last_error && !Object.keys(run.block_loops || {}).length;
}

/** `update-ref` refusing because somebody else moved the branch first — the CAS doing its job. */
function isContended(out) {
  return /cannot lock ref|unable to lock|is at [0-9a-f]+ but expected|reference already exists|ref .* is at/i.test(String(out || ''));
}

function nextFree(cards) {
  let max = 0;
  for (const id of cards.keys()) if (id > max) max = id;
  return max + 1;
}

function need(cards, id, root) {
  const card = cards.get(id);
  if (!card) throw fail(`card #${id} is not on the ${BOARD_BRANCH} board in ${root} — \`hkb list\` shows what is`);
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
  card.labels = [...extra].sort();
}

/**
 * Bring the caller's task object up to date in place. Every verb on the GitHub store does this — a
 * caller holds one task through a whole tick and reads `task.status` after moving it — so a driver
 * that returned a fresh object and left the old one stale would break them silently.
 */
function syncTask(task, read) {
  for (const k of Object.keys(read)) task[k] = read[k];
  return task;
}
