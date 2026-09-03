// The index — the live half of the board, and a queryable copy of the durable half.
//
// docs/local-first.md §6.1 splits the store in two. The durable half is a git ref (`refs/kb/boards/<slug>`,
// node A4): every decision, one commit, readable by `git log` and carried by a `git clone`. This
// file is the other half — `.git/hkb/index.db`, a `node:sqlite` database inside the repository's
// *common* git directory, holding:
//
//   1. **what is live and host-local**: the locks, the open attempts' pid/job/worktree/heartbeat and
//      pause fields, and the events table. None of it belongs in a commit — a heartbeat every ten
//      minutes would make the branch's history a history of pings instead of a history of decisions.
//   2. **an index over the branch**, rebuilt by `load()` whenever the stored tip sha is not the
//      branch's. Four kinds of process (the loop, a worker's verbs, the hooks, `hkb serve`) need to
//      ask the board a question without reading a tree out of git for every answer.
//
// The seam this sits behind is `src/store/index.js` (§6.4). This module is **not** a `Store`: it
// implements the live methods of the interface (`claim`, `release`, `listLocks`, `lockBeatAt`,
// `heartbeat`, `events`, `capabilities`) and the reads an index can answer, and node A6 composes it
// with A4's branch into the driver that goes in `DRIVERS`. Durable writes are A4's; nothing here
// shells out to git, by design — the one git question (where is the common git dir) is `storeRoot`'s
// (src/board.js), asked once per context.
//
// Concurrency: WAL, a busy timeout on every writing connection, `0` on `hkb serve`'s read-only one
// (a busy wait inside a synchronous call would stall every request behind it). A claim is one
// `BEGIN IMMEDIATE` transaction, so two dispatchers racing for the same card cannot both win: the
// loser's insert hits `UNIQUE(task_id, k)` and reads back as `held`, which is the same answer the
// GitHub driver's 422 gives today. A heartbeat is one `UPDATE … WHERE token = ?` and zero rows
// updated is `LOCK_LOST` (exit 3), exactly as the ref lease says it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { storeGitDir, storeRoot, readPidFile, pidAlive } from '../board.js';
import { EVENT_KINDS } from '../watch.js';
import { BOARD_REF } from './git.js';

/**
 * `node:sqlite`, resolved on the first index open and never at import time.
 *
 * **The rule: importing this module must not require a node that has SQLite.** It is now two layers:
 * `src/store/index.js` reaches `local.js` through an `await import` so a GitHub board never loads
 * this module at all, *and* this module never touches the builtin at import time. Either one alone
 * would have been enough for the case that was reported (`hkb hook pretool`, whose whole contract is
 * to stand aside rather than throw onto a worker's tool call, dying with
 * `ERR_UNKNOWN_BUILTIN_MODULE` before `main()` ran) — but a static `import` anywhere on the graph
 * takes the whole graph down, and the graph has more entry points than the two that were noticed. A static `import ... from 'node:sqlite'` made that whole graph refuse to
 * load with `ERR_UNKNOWN_BUILTIN_MODULE` on a node built `--without-sqlite`, on a *GitHub* board that
 * never opens an index at all. Deferring the import to `openIndex` is the fix for every entry point
 * at once, rather than for the two that were noticed: nothing here touches the builtin until
 * somebody actually opens a local board's index, and then the refusal names the node it ran on.
 *
 * `process.getBuiltinModule` (node ≥ 22.3, and this package needs ≥ 22.13 for `node:sqlite` itself)
 * is the synchronous form; `await import()` would make every caller of `openIndex` async for a
 * module that is otherwise entirely synchronous.
 */
let SQLITE = null;
function sqlite() {
  if (SQLITE) return SQLITE;
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) {
    throw usage(
      `this node (${process.version}) has no \`node:sqlite\`, and a local board keeps its index in one. `
      + 'Use a node built with SQLite (>= 22.13 has it unflagged), or keep this board on the GitHub store '
      + '(`"store": "github"` in .kanban/board.json).',
    );
  }
  SQLITE = mod;
  return SQLITE;
}

/** Bumped when the schema below changes shape. A mismatch rebuilds rather than migrates: every
 *  table here is either live state a restart can lose or a copy of the branch `load()` restores.
 *  2: `links_blocked` replaces `events_kind` (the blocker lookup is by `blocked_id`; nothing ever
 *  queried an event by kind).
 *  3: `beats`, this checkout's mirror of where it left each beat chain — `beatToken` was an alias
 *  for `lockToken`, so every lease was checked against the value it leased on. */
export const SCHEMA_VERSION = 3;

/**
 * The kinds an event may carry: `hkb watch`'s vocabulary (so a stream reader learns nothing new)
 * plus the four the control plane adds (docs/local-first.md §3), plus the writes a local board can
 * make that GitHub's poller never saw as events of their own.
 *
 * That last group is why the list is not just `EVENT_KINDS`. A body edit, a blocked-by edge, a label
 * change, a settings write and a take-over were all filed as `status`, so `hkb watch --kinds status`
 * rendered them `none → none` — a card transition that never happened — and the two board-wide ones
 * carried `task_id: null`, which reads as card `#null`. A kind that names the write is legible even
 * to a reader that has no case for it (`describeEvent` falls through to the kind itself); a wrong
 * kind is not.
 */
export const LOCAL_EVENT_KINDS = Object.freeze([
  ...EVENT_KINDS,
  'paused', 'resumed', 'stopped', 'suspended',
  'body', 'blocked-by', 'unblocked-by', 'labels', 'board', 'take-over',
]);

/**
 * The live fields of an open attempt a caller may set. They are written here and nowhere else: a
 * pid is meaningless on another host, and a pause is over by the time anyone reads the branch.
 *
 * `heartbeat_at` is *not* on the list even though it is live state, because it is the lease's own
 * record: `heartbeat()` writes it in the same transaction that rotated the token, and only for a
 * caller that proved it holds the lock. Letting `setAttempt` write it meant a worker the dispatcher
 * had already declared lost could keep its attempt looking alive to the reap with no token at all.
 */
export const LIVE_ATTEMPT_FIELDS = Object.freeze(['pid', 'job', 'wt', 'paused_at', 'pauses_json']);

/** How many events the log keeps. A heartbeat is an event and a worker beats every ten minutes, so
 *  the table is the one thing here that grows without anyone deciding to write to it. */
const EVENT_RETENTION = 50_000;
/** Trim only now and then: the check is a row count on an AUTOINCREMENT id, not a scan. */
const TRIM_EVERY = 1000;

const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };

/** The durable tier's ref, when a caller did not say. Only error messages read it. */
const DEFAULT_BRANCH = BOARD_REF;

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const isUniqueViolation = (e) => e?.errcode === SQLITE_CONSTRAINT_UNIQUE || e?.errcode === SQLITE_CONSTRAINT_PRIMARYKEY;

const nowIso = () => new Date().toISOString();
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const unjson = (s, fallback = null) => { if (s === null || s === undefined) return fallback; try { return JSON.parse(s); } catch { return fallback; } };
const bool = (v) => (v ? 1 : 0);
/** A caller's count, with zero meaning zero. `Number(v) || fallback` reads `0` as "unset". */
const count = (v, fallback) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : fallback; };
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Where the index lives: `<common git dir>/hkb/index.db`, one file **per board**.
 *
 * `gitDir` is `storeGitDir(ctx)` (src/board.js) — the common git directory itself, not its parent
 * with `.git` joined back on. Those are the same path in an ordinary checkout and different ones in
 * a submodule or a `--separate-git-dir` clone, where `.git` is a *file*: joining gave
 * `<file>/hkb/index.db`, and every open there died with a raw `ENOTDIR`. A worker's linked worktree
 * and the loop's main checkout share a common git dir, so they still resolve to the same file (§6.2).
 *
 * The slug is in the *name* because `--repos` and the `{path, board}` entries in the user board list
 * are a documented way to keep two boards in one repository. With one file for both, opening as
 * `beta` handed back `alpha`'s cards under `alpha`'s slug — the board row's guard declined to
 * overwrite the slug and then read the wrong board anyway. The default board keeps the bare name so
 * nothing has to migrate.
 */
export function indexFileIn(gitDir, slug = null) {
  return path.join(indexDirIn(gitDir), slug && slug !== 'default' ? `index.${slugFile(slug)}.db` : 'index.db');
}

/**
 * The directory the index lives in, for `hkb doctor` and `hkb init`'s ignore list.
 *
 * `In` because the argument is the **common git dir**, not a repository root — every other path
 * helper in `src/board.js` (`kanbanDir`, `logsDir`, `pidFile`) takes a root, and a caller that
 * reached for the old name with `ctx.root` got `<root>/hkb` with no error to say so.
 */
export function indexDirIn(gitDir) { return path.join(gitDir, 'hkb'); }

/**
 * A board slug as a filename component, and injectively.
 *
 * The readable part is only for a human reading `ls .git/hkb`; the hash is what makes the name a
 * function of the slug alone. Squashing every non-word run to `-` collided `a/b` with `a-b`,
 * `Alpha` with `alpha` on a case-insensitive filesystem, and any two slugs sharing 64 characters —
 * and the collision error then told the operator to `hkb --board a/b`, which resolves to the file
 * they were already looking at.
 */
function slugFile(slug) {
  const text = String(slug);
  const readable = text.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';
  return `${readable}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

// ---------- the schema (§6.3) ----------

// `attempts` carries the columns §6.3 names one by one, and `extra_json` for the rest of what
// protocol.md's attempt row may hold. Naming every field would make each new attempt field a
// schema migration for a table whose durable copy is a JSON document on the branch anyway.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS board (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  slug          TEXT,
  host          TEXT,
  paused_at     TEXT,
  paused_by     TEXT,
  settings_json TEXT,
  tip_sha       TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  title         TEXT,
  body          TEXT,
  status        TEXT,
  agent         TEXT,
  priority      INTEGER,
  rank          TEXT,
  paths_json    TEXT,
  goal          TEXT,
  scheduled_at  TEXT,
  suspended_json TEXT,
  needs_human   INTEGER DEFAULT 0,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE TABLE IF NOT EXISTS links (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  UNIQUE(blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  task_id          INTEGER NOT NULL,
  k                INTEGER NOT NULL,
  profile          TEXT,
  host             TEXT,
  started_at       TEXT,
  ended_at         TEXT,
  outcome          TEXT,
  reason           TEXT,
  summary          TEXT,
  log              TEXT,
  pid              INTEGER,
  job              TEXT,
  wt               TEXT,
  session_id       TEXT,
  transcript_path  TEXT,
  lock_sha         TEXT,
  heartbeat_at     TEXT,
  total_cost_usd   REAL,
  num_turns        INTEGER,
  duration_ms      INTEGER,
  terminal_reason  TEXT,
  track            INTEGER,
  track_mode       TEXT,
  track_nodes_json TEXT,
  track_branch     TEXT,
  continues_pr     INTEGER,
  continues_branch TEXT,
  manual           INTEGER,
  synthetic        INTEGER,
  paused_at        TEXT,
  pauses_json      TEXT,
  extra_json       TEXT,
  PRIMARY KEY (task_id, k)
);
CREATE TABLE IF NOT EXISTS runs (
  task_id         INTEGER PRIMARY KEY,
  failures        INTEGER DEFAULT 0,
  block_loops_json TEXT,
  last_error      TEXT
);
CREATE TABLE IF NOT EXISTS locks (
  task_id INTEGER NOT NULL,
  k       INTEGER NOT NULL,
  token   TEXT NOT NULL,
  beat_at TEXT,
  at      TEXT,
  UNIQUE(task_id, k)
);
-- This checkout's mirror of where it left each beat chain — the local half of the two the interface
-- names (beatToken vs lockToken), and the exact counterpart of the GitHub driver's local
-- refs/kb/locks/<n>/<k> ref. It is *not* the authority and nothing reloads it from the branch:
-- locks.token is what a lease is checked against, and a mirror that were the same read would make
-- every compare-and-swap lease on the value it is comparing to — a CAS that can never say "lost".
-- Deliberately not cascaded off locks: a claim released and re-taken by somebody else is precisely
-- the reclaim this mirror exists to catch, so the stale token must outlive the row.
CREATE TABLE IF NOT EXISTS beats (
  task_id INTEGER NOT NULL,
  k       INTEGER NOT NULL,
  token   TEXT NOT NULL,
  at      TEXT,
  PRIMARY KEY (task_id, k)
);
CREATE TABLE IF NOT EXISTS results (
  task_id       INTEGER NOT NULL,
  k             INTEGER NOT NULL,
  summary       TEXT,
  metadata_json TEXT,
  artifacts_json TEXT,
  PRIMARY KEY (task_id, k)
);
CREATE TABLE IF NOT EXISTS notes (
  id      TEXT PRIMARY KEY,
  task_id INTEGER,
  at      TEXT,
  actor   TEXT,
  text    TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  task_id      INTEGER,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS attempts_open ON attempts (ended_at) WHERE ended_at IS NULL;
-- links is UNIQUE(blocker_id, blocked_id), and every read of it asks the other question: who
-- blocks *this* card. Without this index that lookup is a scan, once per card in listTaskRows().
CREATE INDEX IF NOT EXISTS links_blocked ON links (blocked_id);
`;

const ATTEMPT_COLUMNS = [
  'task_id', 'k', 'profile', 'host', 'started_at', 'ended_at', 'outcome', 'reason', 'summary', 'log',
  'pid', 'job', 'wt', 'session_id', 'transcript_path', 'lock_sha', 'heartbeat_at', 'total_cost_usd',
  'num_turns', 'duration_ms', 'terminal_reason', 'track', 'track_mode', 'track_nodes_json',
  'track_branch', 'continues_pr', 'continues_branch', 'manual', 'synthetic', 'paused_at',
  'pauses_json', 'extra_json',
];
const ATTEMPT_NAMED = new Set(ATTEMPT_COLUMNS.filter((c) => c !== 'extra_json'));
const ATTEMPT_BOOLEAN = new Set(['track', 'manual', 'synthetic']);

/**
 * The schema, created once and guarded by a `schema_version` row. An index written by an older hkb
 * is deleted rather than migrated: nothing in it is a source of truth — the live half is a crashed
 * host's leftovers and the rest is a copy `load()` rebuilds from the branch.
 */
function ensureSchema(db, file) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const found = readSchemaVersion(db);
  if (found === SCHEMA_VERSION) return false;
  if (found !== null) throw wrongSchema(file, found);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  db.prepare('INSERT OR IGNORE INTO board (id, slug) VALUES (1, ?)').run(null);
  return true;
}

/**
 * The `schema_version` row, or null when there is no `meta` table at all — an index written before
 * it existed, which is a version mismatch and reads as one.
 *
 * Only *that* error is swallowed. Catching everything meant a transient `SQLITE_BUSY` also read as
 * "no schema version", so `openIndexReadOnly` — `hkb serve`'s connection, the one that may not
 * repair anything — told the operator to `rm` a database that was current and healthy.
 */
function readSchemaVersion(db) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    return row ? Number(row.value) : null;
  } catch (e) {
    if (/no such table/i.test(/** @type {any} */ (e)?.message || '')) return null;
    throw e;
  }
}

function wrongSchema(file, found) {
  return usage(`index ${file} was written by schema version ${found ?? 'an older hkb'}, this hkb speaks ${SCHEMA_VERSION} — delete it and let the next tick rebuild it: rm ${file}*`);
}

// ---------- opening ----------

/**
 * The index for `ctx`, creating the file and the schema if they are not there.
 *
 * @param {any} ctx  a context from `makeContext`/`makeContextAt`, or a path
 * @param {{timeout?: number, file?: string, root?: string, gitDir?: string, slug?: string, branch?: string}} [opts]
 *   `timeout` is the busy timeout in ms for this writing connection (§6.3). `file`, `gitDir` and
 *   `root` override the location, for a test that wants an index outside a repository — pass `root`
 *   with either, since `root` is also where `wake()` looks for the dispatcher's pid file. `slug`
 *   names the board, and with it the file: one index per board (`indexFileIn`). `branch` is the
 *   durable tier's branch, and only so an error can name the right one to `git show`.
 */
export function openIndex(ctx, { timeout = 5000, file = null, root = null, gitDir = null, slug = null, branch = DEFAULT_BRANCH } = {}) {
  const board = boardSlug(ctx, slug);
  const { dir, dbFile } = locate(ctx, { file, root, gitDir, slug: board });
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new (sqlite().DatabaseSync)(dbFile, { timeout });
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(timeout) || 0}`);
    ensureSchema(db, dbFile);
    assertSameBoard(db, dbFile, board);
    // Inside the try, like every other statement here: a busy timeout thrown on this one leaked the
    // connection and its WAL/shm handles, which is the whole reason the rest is wrapped.
    if (board) db.prepare('UPDATE board SET slug = ? WHERE id = 1 AND slug IS NULL').run(board);
  } catch (e) { try { db.close(); } catch { /* the open error is the one worth reporting */ } throw e; }
  return makeIndex({ db, file: dbFile, root: dir, readOnly: false, branch });
}

/** The board this open is for: an explicit slug beats the context's. */
function boardSlug(ctx, slug) {
  if (slug) return String(slug);
  if (ctx && typeof ctx === 'object' && ctx.board) return String(ctx.board);
  return null;
}

/**
 * An index holds exactly one board, and says so rather than answering with another one's cards.
 * The file name already separates them (`indexFile`); this is the guard for a caller that named a
 * `file` by hand, and for an index written before the name carried the slug.
 */
function assertSameBoard(db, file, slug) {
  if (!slug) return;
  const found = db.prepare('SELECT slug FROM board WHERE id = 1').get()?.slug ?? null;
  if (found === null || found === slug) return;
  throw usage(`index ${file} holds board "${found}", not "${slug}" — one index per board. Open the other board's index (\`hkb --board ${found}\`), or delete this one and let the next tick rebuild it: rm ${file}*`);
}

/**
 * Where the file is and which root `wake()` looks in, from whatever the caller passed.
 *
 * An explicit `file` decides the root too, unless `root` says otherwise: the index lives at
 * `<root>/.git/hkb/index.db`, so its grandparent's parent is the root, and asking `storeRoot()` for
 * it instead would answer with `process.cwd()` — a *different* directory from the one the index is
 * in. `index.root()` and `wake()`'s pid file both come from here, and `wake()` swallows a miss and
 * returns false, so the dispatcher simply never got nudged. (Gating that on `ctx === null` meant
 * `openIndex(undefined, {file})` — the shape every test that passes a `file` uses — fell through.)
 */
function locate(ctx, { file, root, gitDir, slug }) {
  if (file) return { dir: root || path.dirname(path.dirname(path.dirname(file))), dbFile: file };
  return { dir: root || storeRoot(ctx), dbFile: indexFileIn(gitDir || storeGitDir(ctx), slug) };
}

/**
 * A read-only connection, for `hkb serve`.
 *
 * `timeout: 0` on purpose (§6.3): the server answers requests synchronously, so a connection that
 * waits on a writer's lock does not wait alone — it holds up every request queued behind it. Better
 * a `SQLITE_BUSY` the caller can retry on than a stalled server.
 */
export function openIndexReadOnly(ctx, { file = null, root = null, gitDir = null, slug = null, branch = DEFAULT_BRANCH } = {}) {
  const board = boardSlug(ctx, slug);
  const { dir, dbFile } = locate(ctx, { file, root, gitDir, slug: board });
  if (!fs.existsSync(dbFile)) {
    throw usage(`no board index at ${dbFile} — start the board first (\`hkb up\`), or run \`hkb doctor\` to see why it is missing`);
  }
  const db = new (sqlite().DatabaseSync)(dbFile, { readOnly: true, timeout: 0 });
  try {
    // The same two guards the writing connection runs. `hkb serve` reading an index another hkb
    // wrote is the case they exist for: it cannot create the schema, so it has to refuse instead.
    const found = readSchemaVersion(db);
    if (found !== SCHEMA_VERSION) throw wrongSchema(dbFile, found);
    assertSameBoard(db, dbFile, board);
  } catch (e) { try { db.close(); } catch { /* the open error is the one worth reporting */ } throw e; }
  return makeIndex({ db, file: dbFile, root: dir, readOnly: true, branch });
}

// ---------- the index ----------

function makeIndex({ db, file, root, readOnly, branch = DEFAULT_BRANCH }) {
  const refuseReadOnly = (what) => {
    throw usage(`${what}: this index is open read-only (\`hkb serve\`'s connection). Writes go through the dispatcher or a worker verb.`);
  };

  /** One event, one row. Every mutating method below calls this exactly once, and only when it
   *  really changed something — a heartbeat that lost its lease writes nothing and says nothing. */
  const append = (kind, taskId, payload) => {
    if (!LOCAL_EVENT_KINDS.includes(kind)) throw usage(`unknown event kind "${kind}" — one of: ${LOCAL_EVENT_KINDS.join(', ')}`);
    const at = nowIso();
    const r = db.prepare('INSERT INTO events (at, kind, task_id, payload_json) VALUES (?, ?, ?, ?)')
      .run(at, kind, taskId === null || taskId === undefined ? null : Number(taskId), json(payload ?? {}));
    const id = Number(r.lastInsertRowid);
    // The log is the one table nobody decides to write to: a beat every ten minutes per worker adds
    // a row forever. Trimming inside the append means the caller cannot forget to, and doing it once
    // every TRIM_EVERY rows keeps it off the hot path. `events()` is a cursor over ids, so a reader
    // whose cursor fell off the back gets the oldest rows that are left rather than an error.
    if (id % TRIM_EVERY === 0) trim(id);
    return { id, at, kind, number: taskId ?? null, payload: payload ?? {} };
  };

  /** Drop everything but the newest `keep` events. @returns {number} rows removed */
  const trim = (highest = null, keep = EVENT_RETENTION) => {
    const top = highest ?? Number(db.prepare('SELECT MAX(id) m FROM events').get()?.m ?? 0);
    if (!top || top <= keep) return 0;
    return Number(db.prepare('DELETE FROM events WHERE id <= ?').run(top - keep).changes);
  };

  const attemptRow = (row) => {
    if (!row) return null;
    const out = { ...row };
    for (const f of ATTEMPT_BOOLEAN) out[f] = row[f] === null ? null : !!row[f];
    out.n = row.task_id;
    out.attempt = row.k;
    out.track_nodes = unjson(row.track_nodes_json, null);
    out.pauses = unjson(row.pauses_json, null);
    Object.assign(out, unjson(row.extra_json, {}) || {});
    return out;
  };

  const index = {
    kind: 'sqlite-index',
    file,
    db,
    readOnly,
    root: () => root,
    capabilities: () => ({ events: true }),
    close() { try { db.close(); } catch { /* already closed */ } },

    // ---- the branch's tip ----

    /** The sha of the board commit this index was built from, or null before the first load. */
    tip() { return db.prepare('SELECT tip_sha FROM board WHERE id = 1').get()?.tip_sha ?? null; },
    /** Cheap enough to ask on every open: one row read against one `git rev-parse`. */
    needsLoad(sha) { return !sha || index.tip() !== String(sha); },

    /**
     * Rebuild the indexed tables from a tree of A4's shape (§6.2) and record its sha.
     *
     * What it replaces: `board`, `tasks`, `links`, `runs`, `results`, and the **closed** attempt
     * rows. What it leaves alone: the open attempt rows and their live fields, and `events`. That
     * split is the whole point — the branch is the durable half, and a rebuild that dropped what a
     * running worker holds would hand its card to the next tick to claim again.
     *
     * Locks are the one live table this *does* touch, and only to reconcile: a lock whose attempt
     * the branch says is closed, or whose card has left the branch, is a lock nobody holds. §6.1
     * retires the tick's orphan sweep, and this is the one place that can tell the difference.
     *
     * **The tree shape is the one A4's `readTree()` returns** (§6.2), and only that one: `cards` and
     * `runs` as `Map`s keyed by id (an array of the same records is also read, for a tree that has
     * been through JSON), card fields in the file's own snake_case, `blocked_by` as card numbers.
     * A4 and A5 were written in parallel and this used to read four shapes at once, which meant a
     * disagreement lost a field silently instead of saying so.
     *
     * @param {{tip?: string|null, branch?: string, board?: any, cards?: any, runs?: any}} tree
     */
    load(tree = {}) {
      if (readOnly) refuseReadOnly('load');
      // The tree says which branch it came off when it knows; otherwise this index's own.
      const from = tree.branch ? String(tree.branch) : branch;
      // A key the tree does not carry is a question it did not answer. `board` was already read that
      // way (a missing document must not null the board-wide pause); `cards` and `runs` are read the
      // same way now, because emptying their tables on a partial read is what made the lock sweep
      // below drop every live lock — `NOT IN (SELECT id FROM tasks)` is true for *every* row once
      // `tasks` is empty, so the running worker's next heartbeat came back `lost`.
      const hasCards = tree.cards !== null && tree.cards !== undefined;
      const hasRuns = tree.runs !== null && tree.runs !== undefined;
      const cards = collection(tree.cards, 'cards');
      const runs = collection(tree.runs, 'runs');
      const counts = { tasks: 0, links: 0, runs: 0, attempts: 0, attempts_held: 0, results: 0, locks_dropped: 0 };
      db.exec('BEGIN IMMEDIATE');
      try {
        if (hasCards) {
          db.exec('DELETE FROM tasks');
          db.exec('DELETE FROM links');
        }
        if (hasRuns) {
          db.exec('DELETE FROM runs');
          db.exec('DELETE FROM results');
          db.exec('DELETE FROM attempts WHERE ended_at IS NOT NULL');
        }

        // A tree with no `board` key is a partial read, not a board that lost its host: keeping only
        // the slug and nulling the rest is how a board-wide pause disappeared and the next tick read
        // the board as running. When the document *is* there, it is authoritative, nulls included —
        // except the slug, which says *which board this is*: a tree carrying another one repurposes
        // an index rather than filling it in, so it is refused here exactly as `assertSameBoard`
        // refuses it at open time.
        const b = tree.board;
        if (b !== null && b !== undefined && (typeof b !== 'object' || Array.isArray(b))) {
          // The same strictness `collection()` applies to `cards` and `runs`. `load({board: 'default'})`
          // — the slug where the document goes — used to fall through to the tip-only branch and
          // report success while leaving host, paused_at, paused_by and settings untouched.
          throw usage(`load: \`board\` is a ${b?.constructor?.name || typeof b}, and a tree carries it as the board.json document (what src/store/git.js readTree() returns)`);
        }
        if (b) {
          const held = db.prepare('SELECT slug FROM board WHERE id = 1').get()?.slug ?? null;
          const slug = b.slug ?? held;
          if (held !== null && slug !== null && slug !== held) {
            throw usage(`load: this index holds board "${held}" and the tree says "${slug}" — one index per board. Open the other board's index (\`hkb --board ${slug}\`), or delete this one and let the next tick rebuild it: rm ${file}*`);
          }
          db.prepare('UPDATE board SET slug = ?, host = ?, paused_at = ?, paused_by = ?, settings_json = ?, tip_sha = ? WHERE id = 1')
            .run(
              slug, b.host ?? null, b.paused_at ?? null, b.paused_by ?? null,
              json(b.settings ?? null), tree.tip ?? null,
            );
        } else {
          db.prepare('UPDATE board SET tip_sha = ? WHERE id = 1').run(tree.tip ?? null);
        }

        // Plain `INSERT`: `tasks` was emptied three lines up and the `seen` guard three lines down
        // calls a duplicate an error, so `OR REPLACE` was dead code that said the opposite.
        const insTask = db.prepare(`INSERT INTO tasks
          (id, title, body, status, agent, priority, rank, paths_json, goal, scheduled_at, suspended_json, needs_human, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insLink = db.prepare('INSERT OR IGNORE INTO links (blocker_id, blocked_id) VALUES (?, ?)');
        const seen = new Set();
        for (const card of cards) {
          const id = Number(card.id ?? card.number);
          if (!Number.isFinite(id)) continue;
          if (seen.has(id)) throw usage(`load: the tree has two cards numbered ${id} — one card is one file, so check \`git ls-tree -r ${from} cards/\` for a duplicate`);
          seen.add(id);
          try {
            insTask.run(
              id, card.title ?? '', card.body ?? '', card.status ?? null, card.agent ?? null,
              num(card.priority), card.rank ?? null, json(card.paths ?? null), card.goal ?? null,
              card.scheduled_at ?? null, json(card.suspended ?? null),
              bool(card.needs_human), card.created_at ?? null, card.updated_at ?? null,
            );
          } catch (e) { throw badRecord(from, `cards/${id}.json`, e); }
          counts.tasks++;
          for (const blocker of [].concat(card.blocked_by ?? [])) {
            const p = Number(blocker);
            if (!Number.isFinite(p)) continue;
            insLink.run(p, id);
            counts.links++;
          }
        }

        const insRun = db.prepare('INSERT OR REPLACE INTO runs (task_id, failures, block_loops_json, last_error) VALUES (?, ?, ?, ?)');
        const insResult = db.prepare('INSERT OR REPLACE INTO results (task_id, k, summary, metadata_json, artifacts_json) VALUES (?, ?, ?, ?, ?)');
        // The attempts somebody on this host is still *running*: open here, and with the lock still
        // held. That pair is the definition of live state, and it is what the guard below consults.
        //
        // Asking only whether the **tree's** row was closed let `hkb finish`'s own window through:
        // the attempt is written closed to the branch before `release()` runs, so a tick reloading
        // on the moved tip replaced the open row, wiped the pid/job/worktree the loop is watching,
        // and the sweep at the bottom then dropped the lock out from under a running worker, whose
        // next heartbeat came back `lost`. The lock is the half that makes this self-clearing:
        // `release()` drops it, and the next load indexes the branch's copy as it should.
        const live = new Set(
          hasRuns
            ? db.prepare(`SELECT a.task_id, a.k FROM attempts a
                          JOIN locks l ON l.task_id = a.task_id AND l.k = a.k
                          WHERE a.ended_at IS NULL`).all().map((r) => `${r.task_id}/${r.k}`)
            : [],
        );
        for (const rec of runs) {
          const id = Number(rec.id ?? rec.task_id ?? rec.number);
          if (!Number.isFinite(id)) continue;
          try {
            insRun.run(id, Number(rec.failures || 0), json(rec.block_loops ?? {}), rec.last_error ?? null);
            counts.runs++;
            for (const a of [].concat(rec.attempts || [])) {
              // Only closed rows come off the branch, and only onto an attempt this host is not
              // still running: an open row here is live state, and the branch is not its source.
              // `release()` is what closes it, and the next load then indexes the branch's copy.
              if (!a || !a.ended_at) continue;
              const k = Number(a.attempt ?? a.k ?? 0);
              if (live.has(`${id}/${k}`)) { counts.attempts_held++; continue; }
              writeAttempt(db, id, a);
              counts.attempts++;
            }
            for (const r of [].concat(rec.results || [])) {
              if (!r) continue;
              insResult.run(id, Number(r.attempt || 0), r.summary ?? null, json(r.metadata ?? {}), json(r.artifacts ?? []));
              counts.results++;
            }
          } catch (e) { throw badRecord(from, `runs/${id}.json`, e); }
        }

        // The orphan sweep, done where the answer is knowable: a lock with no open attempt behind it
        // (the branch closed that attempt) or on a card the branch no longer has.
        //
        // Each half runs only against a tree that answered its half. A tree that carried no `cards`
        // says nothing about which cards left the branch, and reading its silence as "none of them
        // are there" is how a partial load handed a running worker's card to the next tick.
        const orphaned = [];
        if (hasCards) orphaned.push('task_id NOT IN (SELECT id FROM tasks)');
        if (hasRuns) orphaned.push('NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id = locks.task_id AND a.k = locks.k AND a.ended_at IS NULL)');
        if (orphaned.length) {
          counts.locks_dropped = Number(db.prepare(`DELETE FROM locks WHERE ${orphaned.join(' OR ')}`).run().changes);
          // The beat mirrors of attempts the branch has closed go the same way. Not the ones whose
          // lock is merely gone — a released claim is what a stale mirror is *for* — only the ones
          // whose attempt the branch itself says ended, which nothing will ever beat on again.
          if (hasRuns) db.exec('DELETE FROM beats WHERE NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id = beats.task_id AND a.k = beats.k AND a.ended_at IS NULL)');
        }
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
        throw e;
      }
      // Deliberately no event: a rebuild is a repair, not a decision, and it runs on every open
      // whose tip moved. Whatever the branch recorded was evented when it was decided.
      return { tip: tree.tip ?? null, ...counts };
    },

    // ---- reads over the indexed half ----

    board() {
      const row = db.prepare('SELECT * FROM board WHERE id = 1').get() || {};
      return {
        slug: row.slug ?? null,
        host: row.host ?? null,
        paused_at: row.paused_at ?? null,
        paused_by: row.paused_by ?? null,
        settings: unjson(row.settings_json, null),
        tip_sha: row.tip_sha ?? null,
      };
    },

    /**
     * The indexed copy of one card, as a **row** — `blocked_by` is a list of numbers, `needs_human`
     * is snake_case, and there is no `kb`, no `labels` and no `prs`.
     *
     * Deliberately *not* called `getTask`/`listTasks`. Those names belong to the §6.4 interface,
     * where they answer `fetchBoard`'s shape (`blockedBy: [{number, state}]`, `needsHuman`, and
     * `listTasks({states})` meaning OPEN/CLOSED). Two methods with one name and different shapes is
     * the kind of disagreement a composed driver inherits without an error — it just forwards the
     * call and gets wrong rows — so the index's reads say what they are. A6 maps them.
     */
    getTaskRow(n) { return taskRow(db, db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(n))); },
    /** @param {{status?: string|null}} [opts] `status` is a *card* status (`ready`, `running`, …). */
    listTaskRows({ status = null } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id').all(String(status))
        : db.prepare('SELECT * FROM tasks ORDER BY id').all();
      // Grouped over the rows this query actually returned. Building the whole board's map for a
      // narrow `{status}` read — the dispatcher's every-tick call — made it slower than the N+1 it
      // replaced: 500 link rows grouped to answer about two cards.
      const blockers = blockerMap(db, status ? rows.map((r) => r.id) : null);
      return rows.map((r) => taskRow(db, r, blockers));
    },

    // ---- claims (§6.4) ----

    /**
     * One transaction: take the lock, open the attempt row, move the card to `running`, say so.
     *
     * `BEGIN IMMEDIATE` takes the write lock up front rather than on the first write, so two
     * dispatchers racing serialize here instead of one of them discovering halfway through that it
     * cannot commit. The loser's insert violates `UNIQUE(task_id, k)` and reads back as `held` —
     * the same word the GitHub driver returns for its 422.
     *
     * @returns {{result: 'claimed'|'held', token: string|null}}
     */
    claim(n, k, { profile = null, host = null, extra = null } = {}) {
      if (readOnly) refuseReadOnly('claim');
      const task = Number(n); const att = Number(k);
      const token = randomToken();
      const at = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO locks (task_id, k, token, beat_at, at) VALUES (?, ?, ?, NULL, ?)').run(task, att, token, at);
        // Seed this checkout's mirror: the claimer is where the chain starts, so its first beat
        // leases on the token the claim minted, exactly as the GitHub driver's `update-ref` does.
        db.prepare('INSERT OR REPLACE INTO beats (task_id, k, token, at) VALUES (?, ?, ?, ?)').run(task, att, token, at);
        db.prepare(`INSERT OR REPLACE INTO attempts (task_id, k, profile, host, started_at, extra_json) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(task, att, profile, host, at, json(extra ?? null));
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('running', at, task);
        append('attempt', task, { op: 'claim', k: att, profile, host });
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* nothing landed either way */ }
        if (isUniqueViolation(e)) return { result: 'held', token: null };
        throw e;
      }
      return { result: 'claimed', token };
    },

    /** Drop the lock. Releasing a lock nobody holds is not an error — it says nothing was there. */
    release(n, k) {
      if (readOnly) refuseReadOnly('release');
      const task = Number(n); const att = Number(k);
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = db.prepare('DELETE FROM locks WHERE task_id = ? AND k = ?').run(task, att);
        if (Number(r.changes) === 0) { db.exec('COMMIT'); return false; }
        append('attempt', task, { op: 'release', k: att });
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
      return true;
    },

    listLocks() {
      return db.prepare('SELECT task_id, k, token, beat_at FROM locks ORDER BY task_id, k').all()
        .map((r) => ({ n: r.task_id, k: r.k, token: r.token, beat_at: r.beat_at ?? null }));
    },

    lockBeatAt(n, k) {
      return db.prepare('SELECT beat_at FROM locks WHERE task_id = ? AND k = ?').get(Number(n), Number(k))?.beat_at ?? null;
    },

    /**
     * The claim's current token, or null when the claim is gone — the *authoritative* half of the
     * pair the interface names. Its mirror is `beatToken`, and the two must be separate reads: an
     * earlier version answered both from this row, which made `heartbeat`'s `WHERE token = ?` lease
     * on the value it was comparing against, so the CAS could not fail and no reclaim was ever
     * detected on a local board.
     */
    lockToken(n, k) {
      return db.prepare('SELECT token FROM locks WHERE task_id = ? AND k = ?').get(Number(n), Number(k))?.token ?? null;
    },

    /** Where *this checkout* left the chain — local state only, never a reason to conclude the claim
     *  is gone. `null` means only "nothing has beaten here". */
    beatToken(n, k) {
      return db.prepare('SELECT token FROM beats WHERE task_id = ? AND k = ?').get(Number(n), Number(k))?.token ?? null;
    },

    /** Point the mirror at `token`, after `lockToken` said the chain moved without us. */
    resyncBeat(n, k, token) {
      if (readOnly) refuseReadOnly('resyncBeat');
      if (!token) return false;
      db.prepare('INSERT OR REPLACE INTO beats (task_id, k, token, at) VALUES (?, ?, ?, ?)').run(Number(n), Number(k), String(token), nowIso());
      return true;
    },

    /** Forget the mirror for a finished attempt, so the next one does not lease on a dead chain. */
    dropBeat(n, k) {
      if (readOnly) refuseReadOnly('dropBeat');
      return Number(db.prepare('DELETE FROM beats WHERE task_id = ? AND k = ?').run(Number(n), Number(k)).changes) > 0;
    },

    /**
     * The worker side, as one `UPDATE … WHERE token = ?`.
     *
     * The token rotates on every beat, the way the lock ref's sha advances on every CAS: the caller
     * beats again on the token this beat handed back, and a beat that leases on a stale one is a
     * beat from a worker somebody reclaimed. Zero rows updated is `lost` — exit 3, `LOCK_LOST`.
     *
     * @returns {{result: 'ok'|'lost', token: string|null}}
     */
    heartbeat(n, k, expected) {
      if (readOnly) refuseReadOnly('heartbeat');
      if (!expected) throw usage('heartbeat: no token to lease on — pass the token the claim (or the previous beat) returned');
      const task = Number(n); const att = Number(k);
      const next = randomToken();
      const at = nowIso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = db.prepare('UPDATE locks SET token = ?, beat_at = ? WHERE task_id = ? AND k = ? AND token = ?')
          .run(next, at, task, att, String(expected));
        if (Number(r.changes) === 0) { db.exec('COMMIT'); return { result: 'lost', token: null }; }
        db.prepare('INSERT OR REPLACE INTO beats (task_id, k, token, at) VALUES (?, ?, ?, ?)').run(task, att, next, at);
        db.prepare('UPDATE attempts SET heartbeat_at = ? WHERE task_id = ? AND k = ?').run(at, task, att);
        append('attempt', task, { op: 'heartbeat', k: att, at });
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
      return { result: 'ok', token: next };
    },

    // ---- the open attempts' live fields ----

    getAttempt(n, k) {
      return attemptRow(db.prepare('SELECT * FROM attempts WHERE task_id = ? AND k = ?').get(Number(n), Number(k)));
    },
    openAttempts() {
      return db.prepare('SELECT * FROM attempts WHERE ended_at IS NULL ORDER BY task_id, k').all().map(attemptRow);
    },

    /**
     * Write the live fields of an open attempt — and only those (`LIVE_ATTEMPT_FIELDS`). Everything
     * else about an attempt is A4's: it goes on the branch, in the commit that decided it, and
     * writing it here would make the index a second source of truth for it.
     *
     * The event kind follows what changed: setting `paused_at` is a `paused`, clearing it a
     * `resumed`, anything else an `attempt`.
     */
    setAttempt(n, k, patch = {}) {
      if (readOnly) refuseReadOnly('setAttempt');
      const task = Number(n); const att = Number(k);
      const keys = Object.keys(patch);
      const bad = keys.filter((key) => !LIVE_ATTEMPT_FIELDS.includes(key));
      if (bad.length) throw usage(`setAttempt: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not live state — the closed attempt fields live on ${branch}. Live: ${LIVE_ATTEMPT_FIELDS.join(', ')}`);
      if (!keys.length) return index.getAttempt(task, att);
      const kind = 'paused_at' in patch ? (patch.paused_at ? 'paused' : 'resumed') : 'attempt';
      db.exec('BEGIN IMMEDIATE');
      try {
        const sets = keys.map((key) => `${key} = ?`).join(', ');
        const r = db.prepare(`UPDATE attempts SET ${sets} WHERE task_id = ? AND k = ?`)
          .run(...keys.map((key) => patch[key]), task, att);
        if (Number(r.changes) === 0) {
          db.exec('ROLLBACK');
          throw usage(`setAttempt: no attempt ${att} on #${task} in the index — claim it first, or reload the index from the branch`);
        }
        append(kind, task, { op: 'attempt-fields', k: att, ...patch });
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
      return index.getAttempt(task, att);
    },

    // ---- events (§6.3) ----

    /** The cursor `hkb serve` tails, and what `hkb watch` reads instead of polling the forge.
     *  `after` is exclusive, so a reader stores the last id it saw and passes it back. */
    events({ after = 0, limit = 500 } = {}) {
      const rows = db.prepare('SELECT id, at, kind, task_id, payload_json FROM events WHERE id > ? ORDER BY id LIMIT ?')
        .all(count(after, 0), count(limit, 500));
      return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, number: r.task_id ?? null, payload: unjson(r.payload_json, {}) }));
    },

    /**
     * One card's rows, **newest `limit` of them**, returned oldest-first — what `hkb log` prints.
     *
     * Not `events({limit})` filtered in JS: `events` is a forward cursor from id 0, so filtering its
     * first page for one card read the *oldest* rows in the log. Past the retention floor that
     * answered `[]` for every recent card and pre-history for an old one, with nothing saying rows
     * had been cut. Narrowing in SQL is also cheaper — a handful of payloads parsed instead of
     * thousands.
     */
    taskEvents(n, { limit = 500 } = {}) {
      const rows = db.prepare('SELECT id, at, kind, task_id, payload_json FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?')
        .all(Number(n), count(limit, 500));
      return rows.reverse().map((r) => ({ id: r.id, at: r.at, kind: r.kind, number: r.task_id ?? null, payload: unjson(r.payload_json, {}) }));
    },

    /** For a verb whose write is not one of the methods above — the control-plane four (`paused`,
     *  `resumed`, `stopped`, `suspended`) and A4's durable writes, which event *after* they commit.
     *  @param {{kind: string, task_id?: number|null, number?: number|null, payload?: any}} spec */
    appendEvent({ kind, task_id = null, number = null, payload = {} }) {
      if (readOnly) refuseReadOnly('appendEvent');
      return append(kind, task_id ?? number, payload);
    },

    /** Drop all but the newest `keep` events. `append` does this on its own every `TRIM_EVERY`
     *  rows; this is the handle for `hkb gc` and for a caller that wants a smaller log now. */
    trimEvents({ keep = EVENT_RETENTION } = {}) {
      if (readOnly) refuseReadOnly('trimEvents');
      // `Number(keep) || EVENT_RETENTION` is falsy on zero, so `hkb gc --keep 0` — "drop the whole
      // log" — kept fifty thousand rows instead. The same shape `nextId` was fixed for.
      return trim(null, count(keep, EVENT_RETENTION));
    },

    /**
     * Nudge the loop. `node:sqlite` has no change notification, so nothing wakes on a write by
     * itself: a verb that wrote the store signals the dispatcher, which is already listening.
     *
     * Never throws, and that is the contract, not laziness — a worker's `hkb finish` must not fail
     * because the loop happens to be down, and every reason it could fail (no pid file, a pid that
     * is gone, a pid this user may not signal) means exactly the same thing: nobody to wake.
     * @returns {boolean} whether a signal was actually sent
     */
    wake() {
      try {
        // `readPidFile` is the one reader of a pid file, and its `stale` is the difference between
        // signalling the dispatcher and signalling a stranger the kernel handed the pid to after a
        // reboot. Re-reading the file by hand here skipped that check.
        const { pid, stale } = readPidFile(root, 'dispatch');
        if (!pid || stale || !pidAlive(pid)) return false;
        // Never this process. The dispatcher writes the board through the store too, and a loop
        // signalling itself would end its own sleep on its own write — a tick per write, which is
        // the busy-wait the interval exists to avoid.
        if (pid === process.pid) return false;
        process.kill(pid, 'SIGUSR1');
        return true;
      } catch { return false; }
    },
  };
  return index;
}

// ---------- helpers ----------

/**
 * The cards or runs of a tree, as a list.
 *
 * A4's `readTree()` hands `Map`s keyed by id; an array of the same records is read too, because a
 * tree that has been through JSON has lost its `Map`s. Anything else — a plain object keyed by id,
 * a string, a number — is refused rather than half-read: it is a shape the branch does not write,
 * and the tolerant version of this quietly indexed nothing when it was handed a `Map`.
 */
function collection(v, what) {
  if (v === null || v === undefined) return [];
  // The key *is* the id, for a card as much as for a run: `cards/<id>.json` also carries an `id`
  // field, and preferring it meant a hand edit or a bad merge that left `cards/7.json` saying
  // `"id": 3` indexed card 7 as card 3 — `getTaskRow(7)` null, `claim(7, k)` matching no row, the
  // card on the branch and invisible to every index read. The file's name is its identity (the same
  // rule `ATTEMPT_IDENTITY` applies to an attempt's `task_id`), so the key wins and a record that
  // disagrees is simply overridden.
  if (v instanceof Map) {
    return [...v.entries()].filter(([, rec]) => rec).map(([id, rec]) => ({ ...rec, id: Number(id) }));
  }
  if (Array.isArray(v)) return v.filter(Boolean);
  throw usage(`load: \`${what}\` is a ${v?.constructor?.name || typeof v}, and a tree carries it as a Map keyed by id (what src/store/git.js readTree() returns) or as an array of the same records`);
}

/** One indexed card, with its blockers. `blockers` is the board-wide map when there is one. */
function taskRow(db, row, blockers = null) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    agent: row.agent,
    priority: row.priority,
    rank: row.rank,
    paths: unjson(row.paths_json, null),
    goal: row.goal,
    scheduled_at: row.scheduled_at,
    suspended: unjson(row.suspended_json, null),
    needs_human: !!row.needs_human,
    created_at: row.created_at,
    updated_at: row.updated_at,
    blocked_by: blockers
      ? (blockers.get(row.id) || [])
      : db.prepare('SELECT blocker_id FROM links WHERE blocked_id = ? ORDER BY blocker_id').all(row.id).map((l) => l.blocker_id),
  };
}

/**
 * The links that block these cards, grouped by the card they block — one query instead of one per
 * card. `ids` null means the whole board; a list restricts the scan to what the caller asked about.
 */
function blockerMap(db, ids = null) {
  /** @type {Map<number, number[]>} */ const out = new Map();
  if (ids && !ids.length) return out;
  const rows = ids
    ? db.prepare(`SELECT blocker_id, blocked_id FROM links WHERE blocked_id IN (${ids.map(() => '?').join(', ')}) ORDER BY blocked_id, blocker_id`).all(...ids)
    : db.prepare('SELECT blocker_id, blocked_id FROM links ORDER BY blocked_id, blocker_id').all();
  for (const l of rows) {
    const list = out.get(l.blocked_id) || [];
    list.push(l.blocker_id);
    out.set(l.blocked_id, list);
  }
  return out;
}

/**
 * A row the branch wrote that this schema cannot hold, reported with the file to go and look at.
 * `branch` is the durable tier's own — a board at `refs/kb/boards/beta` must not be told to read
 * `refs/kb/boards/default:cards/7.json`.
 */
function badRecord(branch, file, e) {
  if (e?.exitCode) return e;
  return usage(`load: ${file} on ${branch} does not fit the index (${e?.message || e}) — read it with \`git show ${branch}:${file}\` and fix the field it names`);
}

/**
 * The keys that say *which* attempt row this is. They come from the record's position in the tree —
 * `runs/<id>.json`, and the attempt's own `attempt` number — never from a field inside it. A record
 * carrying its own `task_id` (a hand-edited run file, a copied attempt) used to overwrite the id of
 * the run being loaded, and `INSERT OR REPLACE` then landed it on another card's attempt, silently
 * replacing it. `n` is `attemptRow`'s alias for the same thing, so a row read back out and written
 * again does not sprout it in `extra_json`.
 */
const ATTEMPT_IDENTITY = new Set(['task_id', 'k', 'attempt', 'n']);

/** One attempt row from a branch record: the columns §6.3 names, and the rest in `extra_json`. */
function writeAttempt(db, taskId, a) {
  const values = { task_id: taskId, k: Number(a.attempt ?? a.k ?? 0) };
  const extra = {};
  for (const [key, value] of Object.entries(a)) {
    if (ATTEMPT_IDENTITY.has(key)) continue;
    if (key === 'track_nodes') { values.track_nodes_json = json(value); continue; }
    if (key === 'pauses') { values.pauses_json = json(value); continue; }
    if (ATTEMPT_NAMED.has(key)) { values[key] = ATTEMPT_BOOLEAN.has(key) ? bool(value) : value; continue; }
    extra[key] = value;
  }
  if (Object.keys(extra).length) values.extra_json = json(extra);
  const cols = Object.keys(values);
  db.prepare(`INSERT OR REPLACE INTO attempts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => (values[c] === undefined ? null : values[c])));
}

/**
 * The lock token. Opaque on purpose: the GitHub driver's is a sha, this one is not, and no caller
 * may read either — it is only ever handed back to the next beat.
 *
 * The randomness is `node:crypto`'s, not `Math.random()`'s: the token *is* the lease, and the whole
 * of what stops a beat from a worker somebody already reclaimed. A builtin makes it free.
 */
function randomToken() {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(12).toString('hex')}`;
}
