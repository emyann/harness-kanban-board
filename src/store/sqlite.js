// The index — the live half of the board, and a queryable copy of the durable half.
//
// docs/local-first.md §6.1 splits the store in two. The durable half is a git branch (`kb-board`,
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
import { DatabaseSync } from 'node:sqlite';
import { storeRoot, pidFile, pidAlive } from '../board.js';
import { EVENT_KINDS } from '../watch.js';

/** Bumped when the schema below changes shape. A mismatch rebuilds rather than migrates: every
 *  table here is either live state a restart can lose or a copy of the branch `load()` restores. */
export const SCHEMA_VERSION = 1;

/**
 * The kinds an event may carry: `hkb watch`'s vocabulary (so a stream reader learns nothing new)
 * plus the four the control plane adds (docs/local-first.md §3).
 */
export const LOCAL_EVENT_KINDS = Object.freeze([...EVENT_KINDS, 'paused', 'resumed', 'stopped', 'suspended']);

/** The live fields of an open attempt. They are written here and nowhere else: a pid is meaningless
 *  on another host, and a pause is over by the time anyone reads the branch. */
export const LIVE_ATTEMPT_FIELDS = Object.freeze(['pid', 'job', 'wt', 'heartbeat_at', 'paused_at', 'pauses_json']);

const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const isUniqueViolation = (e) => e?.errcode === SQLITE_CONSTRAINT_UNIQUE || e?.errcode === SQLITE_CONSTRAINT_PRIMARYKEY;

const nowIso = () => new Date().toISOString();
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const unjson = (s, fallback = null) => { if (s === null || s === undefined) return fallback; try { return JSON.parse(s); } catch { return fallback; } };
const bool = (v) => (v ? 1 : 0);
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Where the index lives: `<common git dir>/hkb/index.db`. `root` is `storeRoot(ctx)` — the common
 *  git directory's *parent*, so a worker's linked worktree and the loop's main checkout resolve to
 *  the same file rather than to two boards that happen to share a name (§6.2). */
export function indexFile(root) { return path.join(root, '.git', 'hkb', 'index.db'); }

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
CREATE INDEX IF NOT EXISTS events_kind ON events (kind);
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
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  const found = row ? Number(row.value) : null;
  if (found === SCHEMA_VERSION) return false;
  if (found !== null && found !== SCHEMA_VERSION) {
    const e = usage(`index ${file} was written by schema version ${found}, this hkb speaks ${SCHEMA_VERSION} — delete it and let the next tick rebuild it: rm ${file}*`);
    throw e;
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  db.prepare('INSERT OR IGNORE INTO board (id, slug) VALUES (1, ?)').run(null);
  return true;
}

// ---------- opening ----------

/**
 * The index for `ctx`, creating the file and the schema if they are not there.
 *
 * @param {any} ctx  a context from `makeContext`/`makeContextAt`, or a path
 * @param {{timeout?: number, file?: string, root?: string, slug?: string}} [opts]
 *   `timeout` is the busy timeout in ms for this writing connection (§6.3). `file` and `root`
 *   override the location, for a test that wants an index outside a repository — pass both, since
 *   `root` is also where `wake()` looks for the dispatcher's pid file.
 */
export function openIndex(ctx, { timeout = 5000, file = null, root = null, slug = null } = {}) {
  const dir = root || (file ? path.dirname(path.dirname(path.dirname(file))) : storeRoot(ctx));
  const dbFile = file || indexFile(dir);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile, { timeout });
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(timeout) || 0}`);
    ensureSchema(db, dbFile);
  } catch (e) { try { db.close(); } catch { /* the open error is the one worth reporting */ } throw e; }
  const board = ctx && typeof ctx === 'object' ? (slug || ctx.board || null) : slug;
  if (board) db.prepare('UPDATE board SET slug = ? WHERE id = 1 AND (slug IS NULL OR slug = ?)').run(board, board);
  return makeIndex({ db, file: dbFile, root: dir, readOnly: false });
}

/**
 * A read-only connection, for `hkb serve`.
 *
 * `timeout: 0` on purpose (§6.3): the server answers requests synchronously, so a connection that
 * waits on a writer's lock does not wait alone — it holds up every request queued behind it. Better
 * a `SQLITE_BUSY` the caller can retry on than a stalled server.
 */
export function openIndexReadOnly(ctx, { file = null, root = null } = {}) {
  const dir = root || (file ? path.dirname(path.dirname(path.dirname(file))) : storeRoot(ctx));
  const dbFile = file || indexFile(dir);
  if (!fs.existsSync(dbFile)) {
    throw usage(`no board index at ${dbFile} — start the board first (\`hkb up\`), or run \`hkb doctor\` to see why it is missing`);
  }
  const db = new DatabaseSync(dbFile, { readOnly: true, timeout: 0 });
  return makeIndex({ db, file: dbFile, root: dir, readOnly: true });
}

// ---------- the index ----------

function makeIndex({ db, file, root, readOnly }) {
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
    return { id: Number(r.lastInsertRowid), at, kind, number: taskId ?? null, payload: payload ?? {} };
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

    /** The sha of the `kb-board` commit this index was built from, or null before the first load. */
    tip() { return db.prepare('SELECT tip_sha FROM board WHERE id = 1').get()?.tip_sha ?? null; },
    /** Cheap enough to ask on every open: one row read against one `git rev-parse`. */
    needsLoad(sha) { return !sha || index.tip() !== String(sha); },

    /**
     * Rebuild the indexed tables from a tree of A4's shape (§6.2) and record its sha.
     *
     * What it replaces: `board`, `tasks`, `links`, `runs`, `results`, and the **closed** attempt
     * rows. What it leaves alone: `locks`, the open attempt rows and their live fields, and
     * `events`. That split is the whole point — the branch is the durable half, and a rebuild that
     * dropped the locks would hand every running card to the next tick to claim again.
     *
     * The tree is read tolerantly (`cards` as an array or as a map keyed by id, `needs_human` or
     * `needsHuman`) because A4 writes it and this reads it: a shape disagreement should cost a
     * field, not the board.
     *
     * @param {{tip?: string|null, board?: any, cards?: any, runs?: any}} tree
     */
    load(tree = {}) {
      if (readOnly) refuseReadOnly('load');
      const cards = collection(tree.cards);
      const runs = collection(tree.runs);
      const counts = { tasks: 0, links: 0, runs: 0, attempts: 0, results: 0 };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM tasks');
        db.exec('DELETE FROM links');
        db.exec('DELETE FROM runs');
        db.exec('DELETE FROM results');
        db.exec('DELETE FROM attempts WHERE ended_at IS NOT NULL');

        const b = tree.board || {};
        db.prepare(`UPDATE board SET slug = ?, host = ?, paused_at = ?, paused_by = ?, settings_json = ?, tip_sha = ? WHERE id = 1`)
          .run(
            b.slug ?? db.prepare('SELECT slug FROM board WHERE id = 1').get()?.slug ?? null,
            b.host ?? null, b.paused_at ?? null, b.paused_by ?? null,
            json(b.settings ?? null), tree.tip ?? null,
          );

        const insTask = db.prepare(`INSERT INTO tasks
          (id, title, body, status, agent, priority, rank, paths_json, goal, scheduled_at, suspended_json, needs_human, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insLink = db.prepare('INSERT OR IGNORE INTO links (blocker_id, blocked_id) VALUES (?, ?)');
        for (const card of cards) {
          const id = Number(card.id ?? card.number);
          if (!Number.isFinite(id)) continue;
          insTask.run(
            id, card.title ?? '', card.body ?? '', card.status ?? null, card.agent ?? null,
            num(card.priority), card.rank ?? null, json(card.paths ?? null), card.goal ?? null,
            card.scheduled_at ?? null, json(card.suspended ?? null),
            bool(card.needs_human ?? card.needsHuman), card.created_at ?? null, card.updated_at ?? null,
          );
          counts.tasks++;
          for (const blocker of [].concat(card.blocked_by ?? card.blockedBy ?? [])) {
            const p = Number(typeof blocker === 'object' ? (blocker?.id ?? blocker?.number) : blocker);
            if (!Number.isFinite(p)) continue;
            insLink.run(p, id);
            counts.links++;
          }
        }

        const insRun = db.prepare('INSERT OR REPLACE INTO runs (task_id, failures, block_loops_json, last_error) VALUES (?, ?, ?, ?)');
        const insResult = db.prepare('INSERT OR REPLACE INTO results (task_id, k, summary, metadata_json, artifacts_json) VALUES (?, ?, ?, ?, ?)');
        for (const rec of runs) {
          const id = Number(rec.id ?? rec.task_id ?? rec.number);
          if (!Number.isFinite(id)) continue;
          insRun.run(id, Number(rec.failures || 0), json(rec.block_loops ?? {}), rec.last_error ?? null);
          counts.runs++;
          for (const a of [].concat(rec.attempts || [])) {
            // Only closed rows come off the branch; an open one is this host's, and it is already
            // here. Writing it from the tree would clobber the pid the loop is watching.
            if (!a || !a.ended_at) continue;
            writeAttempt(db, id, a);
            counts.attempts++;
          }
          for (const r of [].concat(rec.results || [])) {
            if (!r) continue;
            insResult.run(id, Number(r.attempt || 0), r.summary ?? null, json(r.metadata ?? {}), json(r.artifacts ?? []));
            counts.results++;
          }
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

    getTask(n) { return taskRow(db, db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(n))); },
    listTasks({ status = null } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY id').all(String(status))
        : db.prepare('SELECT * FROM tasks ORDER BY id').all();
      return rows.map((r) => taskRow(db, r));
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
      if (bad.length) throw usage(`setAttempt: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not live state — the closed attempt fields live on the kb-board branch. Live: ${LIVE_ATTEMPT_FIELDS.join(', ')}`);
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
        .all(Number(after) || 0, Number(limit) || 500);
      return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, number: r.task_id ?? null, payload: unjson(r.payload_json, {}) }));
    },

    /** For a verb whose write is not one of the methods above — the control-plane four (`paused`,
     *  `resumed`, `stopped`, `suspended`) and A4's durable writes, which event *after* they commit.
     *  @param {{kind: string, task_id?: number|null, number?: number|null, payload?: any}} spec */
    appendEvent({ kind, task_id = null, number = null, payload = {} }) {
      if (readOnly) refuseReadOnly('appendEvent');
      return append(kind, task_id ?? number, payload);
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
        const file = pidFile(root, 'dispatch');
        const pid = Number(fs.readFileSync(file, 'utf8').trim());
        if (!pid || !pidAlive(pid)) return false;
        process.kill(pid, 'SIGUSR1');
        return true;
      } catch { return false; }
    },
  };
  return index;
}

// ---------- helpers ----------

/** A tree may hand a collection as an array or as a map keyed by id. Read both. */
function collection(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v !== 'object') return [];
  return Object.entries(v).map(([id, value]) => {
    if (!value || typeof value !== 'object') return null;
    const out = { ...value };
    if (out.id === undefined || out.id === null) out.id = Number(id);
    return out;
  }).filter(Boolean);
}

function taskRow(db, row) {
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
    blocked_by: db.prepare('SELECT blocker_id FROM links WHERE blocked_id = ? ORDER BY blocker_id').all(row.id).map((l) => l.blocker_id),
  };
}

/** One attempt row from a branch record: the columns §6.3 names, and the rest in `extra_json`. */
function writeAttempt(db, taskId, a) {
  const values = { task_id: taskId, k: Number(a.attempt ?? a.k ?? 0) };
  const extra = {};
  for (const [key, value] of Object.entries(a)) {
    if (key === 'attempt' || key === 'k') continue;
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

/** The lock token. Opaque on purpose: the GitHub driver's is a sha, this one is not, and no caller
 *  may read either — it is only ever handed back to the next beat. */
function randomToken() {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The directory the index lives in, for `hkb doctor` and `hkb init`'s ignore list. */
export function indexDir(root) { return path.join(root, '.git', 'hkb'); }
