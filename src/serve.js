// `hkb serve` — a local web board over the live GitHub backend, for one checkout or several.
//
// Frugal by construction: every read is `fetchBoard` (one GraphQL query per board) cached for the poll
// interval and shared by every open tab; every write goes through the same lifecycle verb the CLI calls.
// So the page is authoritative, not a mirror — there is no second source of truth and no extra token scope.
// No auth: the server binds 127.0.0.1 and refuses cross-origin requests (see checkOrigin).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  fetchBoard as realFetchBoard, getTask as realGetTask, loadRun as realLoadRun,
  latestResult as realLatestResult, parentResults as realParentResults, addComment as realAddComment,
} from './tasks.js';
import { promote as realPromote, unblock as realUnblock, block as realBlock, requestChanges as realRequestChanges, archive as realArchive } from './lifecycle.js';
import { logsDir, kanbanDir, loadUserBoards, userBoardsFile, contextForPath } from './board.js';
import { pidAlive } from './dispatch.js';
import { computeReady, blockerDone, formatSession, resumeCommand, parseRepoSpecs, boardKey, uniqueKeys } from './model.js';

/** The columns of the web board. `archived` is a verb, not a column — archived tasks leave the board. */
export const COLUMNS = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done'];

export const DEFAULT_PORT = 4666;
export const DEFAULT_POLL = 30;

// ---------- drag & drop → verbs ----------

/**
 * The only column-to-column moves the protocol has a verb for. Anything else is refused with the
 * reason, so the board can never show a state no CLI command could have produced.
 * `needs` lists the fields the caller must supply; `note` explains a move that is not one-to-one.
 */
const MOVES = {
  'triage>todo': { steps: ['promote'] },
  'triage>ready': { steps: ['promote', 'promote'], note: 'promoted through todo' },
  'triage>blocked': { steps: ['block'], needs: ['reason'] },
  'todo>ready': { steps: ['promote'] },
  'todo>blocked': { steps: ['block'], needs: ['reason'] },
  'ready>blocked': { steps: ['block'], needs: ['reason'] },
  'running>blocked': { steps: ['block'], needs: ['reason'] },
  'review>blocked': { steps: ['block'], needs: ['reason'] },
  'blocked>ready': { steps: ['promote'], note: 'needs-human cleared' },
  'blocked>todo': { steps: ['unblock'], note: 'unblock puts a task back where its blockers say it belongs' },
  'review>ready': { steps: ['request-changes'], needs: ['reason'] },
  'review>todo': { steps: ['request-changes'], needs: ['reason'], note: 'request-changes lands in todo while blockers are open' },
};

/** Why a column can never be a drop target, whatever the card came from. */
const NO_SUCH_VERB = {
  running: 'only the dispatcher starts a task — run `hkb dispatch` (or `hkb claim <n> --spawn`)',
  done: 'a task becomes done when a worker calls `hkb complete` and its pull request merges',
  review: 'a task enters review when a worker calls `hkb complete` or `hkb request-review`',
  triage: 'nothing demotes a task back to triage — drop it on Blocked, or archive it',
};

/**
 * Which verb(s) a drag from one column to another maps to. Pure — no I/O, no GitHub.
 * @returns {{ok: true, steps: string[], needs: string[], note: string|null}} or {{ok: false, reason: string}}
 */
export function moveDecision(task, to) {
  if (!COLUMNS.includes(to)) return { ok: false, reason: `"${to}" is not a column (${COLUMNS.join(', ')})` };
  const from = task?.status ?? null;
  const n = task?.number ?? '?';
  if (!from) return { ok: false, reason: `#${n} has no kb:status:* label — run \`hkb adopt ${n}\` first` };
  if (from === to) return { ok: true, steps: [], needs: [], note: `#${n} is already ${to}` };
  if (from === 'done' || from === 'archived') {
    return { ok: false, reason: `#${n} is ${from} and its issue is closed — reopen it on GitHub, then \`hkb request-changes ${n} "why"\`` };
  }
  const move = MOVES[`${from}>${to}`];
  if (move) return { ok: true, steps: move.steps, needs: move.needs || [], note: move.note || null };
  if (NO_SUCH_VERB[to]) return { ok: false, reason: `#${n}: ${NO_SUCH_VERB[to]}` };
  if (from === 'ready' && to === 'todo') {
    return { ok: false, reason: `#${n}: no verb demotes ready → todo — give it a blocker with \`hkb link <parent> ${n}\`, or drop it on Blocked` };
  }
  return { ok: false, reason: `#${n}: no verb moves a task from ${from} to ${to}` };
}

// ---------- payloads ----------

/** The card the board page draws. Small on purpose: the issue body only travels on drawer open. */
export function cardOf(t) {
  return {
    number: t.number,
    title: t.title,
    status: t.status,
    agent: t.agent,
    priority: Number(t.kb?.priority ?? 0) || 0,
    paths: t.kb?.paths || [],
    goal: t.kb?.goal || null,
    scheduled_at: t.kb?.scheduled_at || null,
    needsHuman: !!t.needsHuman,
    ready: computeReady(t),
    state: t.state,
    url: t.url,
    updatedAt: t.updatedAt,
    blockedBy: (t.blockedBy || []).map((b) => ({ number: b.number, title: b.title || null, done: blockerDone(b) })),
    prs: (t.prs || []).map((p) => ({ number: p.number, state: p.state, isDraft: !!p.isDraft, merged: !!p.merged, url: p.url })),
  };
}

/** ETag over the meaningful representation only — `fetched_at` changes every tick and must not bust it. */
export function boardEtag(cards) {
  return '"' + crypto.createHash('sha1').update(JSON.stringify(cards)).digest('hex').slice(0, 32) + '"';
}

/** Is a dispatcher loop up on this repo? Local file + pid check, no network — so it is per board. */
export function dispatcherState(root) {
  try {
    const pid = Number(fs.readFileSync(path.join(kanbanDir(root), 'dispatch.pid'), 'utf8').trim());
    return { running: pidAlive(pid), pid: pid || null };
  } catch { return { running: false, pid: null }; }
}

// ---------- which boards this server holds ----------

/**
 * The contexts one `hkb serve` shows. The cwd board is always first — it is where the command was run
 * and `requireBoard()` has already vouched for it — then either `--repos` (explicit wins) or the
 * user-level list (`hkb serve` with no flags, so a set of repos survives a `cd`).
 *
 * A `--repos` path that is not an hkb checkout is fatal: you just typed it. A stale entry in the user
 * list is a warning and a skip, so a repo you deleted never breaks `hkb serve` everywhere.
 *
 * Called again on a cadence while the server runs (`reloadBoards`), so the user-level list is live:
 * a checkout added to it is served without a restart. It must stay pure enough to bear repeating —
 * no writes, and every message through `log`.
 */
export function serveContexts(ctx, flags = {}, log = () => {}) {
  const explicit = flags.repos !== undefined;
  if (flags.repos === true) { const e = new Error('--repos needs a value, e.g. --repos ../other-repo,../third'); e.exitCode = 2; throw e; }
  const file = userBoardsFile();
  const specs = explicit ? parseRepoSpecs(flags.repos) : (loadUserBoards(file) || []);
  const out = [ctx];
  for (const spec of specs) {
    try { out.push(contextForPath(spec.path, spec.board)); } catch (e) {
      if (explicit) throw e;
      log(`skipping "${spec.path}" from ${file}: ${e.message}`);
    }
  }
  return out;
}

/**
 * Give every board a stable, URL-safe key, and drop the duplicates: two checkouts of the same repo on
 * the same board are one board, and querying it twice per poll would buy nothing.
 */
export function keyBoards(contexts) {
  const byId = new Map();
  for (const c of contexts) {
    const id = `${c.repo.nameWithOwner}#${c.board}`;
    if (!byId.has(id)) byId.set(id, { id, ctx: c, repo: c.repo.nameWithOwner, board: c.board, root: c.root });
  }
  const entries = [...byId.values()];
  const keys = uniqueKeys(entries.map((e) => boardKey(e.repo, e.board)));
  return entries.map((e, i) => ({ key: keys[i], ...e }));
}

// ---------- worker logs ----------

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Absolute path of an attempt's log, or null when it would fall outside `.kanban/logs`.
 * The attempt number comes off the wire, so the containment check is the boundary, not a nicety.
 */
export function logPathFor(root, run, number, attempt) {
  const a = (run?.attempts || []).find((x) => x.attempt === attempt);
  const rel = a?.log || path.join('.kanban', 'logs', `${number}-${attempt}.log`);
  const dir = path.resolve(logsDir(root));
  const abs = path.resolve(root, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  return abs;
}

/** Last `bytes` of a file, ANSI stripped. Missing file → null (a worker may not have logged yet). */
export function tailFile(file, bytes = 20_000) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8').replace(ANSI_RE, ''), size, truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}

// ---------- request plumbing ----------

/**
 * `/api/boards/o~r~default/tasks/12/log` → { kind: 'log', number: 12, key: 'o~r~default' }.
 * The unscoped `/api/tasks/12/...` form is kept (`key: null`) — it is what a single-board server and
 * anything scripting against it use, and the handler refuses it when several boards make it ambiguous.
 * Unknown paths → null.
 */
export function parseRoute(pathname) {
  if (pathname === '/' || pathname === '/index.html') return { kind: 'page' };
  if (pathname === '/api/board') return { kind: 'board' };
  const scoped = /^\/api\/boards\/([A-Za-z0-9._~-]+)\/tasks\/(\d+)(?:\/([a-z-]+))?$/.exec(pathname);
  const plain = scoped ? null : /^\/api\/tasks\/(\d+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (!scoped && !plain) return null;
  if (scoped && scoped[1].includes('..')) return null; // a key is a name, never a path segment to walk
  const key = scoped ? scoped[1] : null;
  const number = Number(scoped ? scoped[2] : plain[1]);
  const tail = scoped ? scoped[3] : plain[2];
  if (!tail) return { kind: 'task', number, key };
  if (tail === 'log') return { kind: 'log', number, key };
  return { kind: 'verb', number, verb: tail, key };
}

/** Hostname out of a `Host:` header or an origin, brackets and port removed. null when unparsable. */
function hostnameOf(hostHeader) {
  try { return new URL(`http://${hostHeader}`).hostname.toLowerCase(); } catch { return null; }
}

export function isLoopback(host) {
  const h = hostnameOf(host) ?? String(host || '').toLowerCase();
  return h === 'localhost' || h === '[::1]' || h === '::1' || /^127\./.test(h);
}

/**
 * There is no auth, so the browser is the only thing between this board and any page the user has open.
 * Refuse anything not same-origin, and (when bound to loopback) a `Host` that is not loopback — that is
 * what stops DNS rebinding from turning `hkb serve` into a remote control for someone else's board.
 */
export function checkOrigin(headers, { loopback = true } = {}) {
  const host = String(headers.host || '');
  if (loopback && host && !isLoopback(host)) {
    return { ok: false, reason: `Host "${host}" is not loopback — hkb serve only answers http://localhost:<port>` };
  }
  const origin = headers.origin;
  if (origin && origin !== 'null') {
    let u;
    try { u = new URL(origin); } catch { return { ok: false, reason: `bad Origin header "${origin}"` }; }
    if (u.host.toLowerCase() !== host.toLowerCase()) {
      return { ok: false, reason: `cross-origin request from ${origin} refused (Host: ${host || 'none'}) — hkb serve has no auth and answers same-origin calls only` };
    }
  }
  return { ok: true };
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(Object.assign(new Error('request body too large'), { exitCode: 2 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  res.writeHead(status, { 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : buf);
}
const sendJson = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj, null, 2) + '\n', { 'content-type': 'application/json; charset=utf-8', ...headers });

/** Every error the page can provoke maps to a status a human can act on. */
const STATUS_BY_KIND = { auth: 502, ratelimit: 503, network: 503, notfound: 404, conflict: 409, validation: 400, server: 502 };
export function errorStatus(e) {
  if (e?.exitCode === 3) return 409;
  if (e?.exitCode === 2) return 400;
  return STATUS_BY_KIND[e?.kind] || 500;
}

// ---------- verbs ----------

const VERBS = {
  promote: { run: (d, ctx, n) => d.promote(ctx, n) },
  unblock: { run: (d, ctx, n) => d.unblock(ctx, n) },
  archive: { run: (d, ctx, n) => d.archive(ctx, n) },
  block: { needs: ['reason'], run: (d, ctx, n, b) => d.block(ctx, n, { reason: b.reason, kind: b.kind || 'needs_input' }) },
  'request-changes': { needs: ['reason'], run: (d, ctx, n, b) => d.requestChanges(ctx, n, { reason: b.reason }) },
  comment: { needs: ['text'], run: async (d, ctx, n, b) => ({ number: n, url: (await d.addComment(ctx, n, b.text)).html_url }) },
};

export const VERB_NAMES = Object.keys(VERBS);

/** Which of a verb's required fields the body did not supply. */
export function missingFields(needs, body) {
  return (needs || []).filter((k) => !body || typeof body[k] !== 'string' || !body[k].trim());
}

// ---------- the server ----------

const PAGE_FILE = new URL('../web/index.html', import.meta.url);

/**
 * Start the HTTP server and return it. `deps` exists so tests drive the whole surface without `gh`.
 * @returns {Promise<{server, url, port, host, poll}>}
 */
export async function startServer(ctx, flags = {}, log = () => {}, deps = {}) {
  const d = {
    fetchBoard: realFetchBoard, getTask: realGetTask, loadRun: realLoadRun, latestResult: realLatestResult,
    parentResults: realParentResults, addComment: realAddComment, promote: realPromote, unblock: realUnblock,
    block: realBlock, requestChanges: realRequestChanges, archive: realArchive, ...deps,
  };
  const value = (name, fallback) => {
    if (flags[name] === undefined) return fallback;
    if (flags[name] === true) { const e = new Error(`--${name} needs a value, e.g. --${name} ${fallback}`); e.exitCode = 2; throw e; }
    return flags[name];
  };
  const port = Number(value('port', DEFAULT_PORT));
  const host = String(value('host', '127.0.0.1'));
  const poll = Math.max(5, Number(value('poll', DEFAULT_POLL)) || DEFAULT_POLL);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { const e = new Error(`--port must be a port number, got "${flags.port}"`); e.exitCode = 2; throw e; }
  const loopback = isLoopback(host);
  const ttlMs = Math.max(2000, (poll - 2) * 1000);
  const now = deps.now || (() => Date.now()); // the reload clock, so a test can move it without waiting

  /**
   * Every read below resolves against the board the request names, never against a single ambient
   * `ctx` — that is the whole point: two repos on one page must not be able to read, tail or write
   * each other. `deps.contexts` is the test seam; resolution touches git and the filesystem, the
   * server below does not.
   *
   * `boards` and `byKey` are re-derived by `reloadBoards`, so everything below reads these bindings
   * on every call and never captures the array or the map they point at.
   */
  const staticBoards = flags.repos !== undefined || !!deps.contexts;
  let skipped = new Set(); // stale entries already reported, so a dead path is a line when it appears, not every poll
  let listError = null;

  /** Resolve the list, reporting each stale entry once — a reload must not re-log what it said last time. */
  function resolveBoards() {
    const seen = new Set();
    const entries = keyBoards(deps.contexts || serveContexts(ctx, flags, (m) => { seen.add(m); if (!skipped.has(m)) log(m); }));
    skipped = seen;
    return entries;
  }

  let boards = resolveBoards().map(boardState);
  let byKey = new Map(boards.map((b) => [b.key, b]));
  const keyList = () => boards.map((b) => b.key).join(', ');
  let listAt = now();

  /**
   * Re-read the user-level list, at most once per poll interval. It is a local file, so a board that
   * appears while the server runs costs no GitHub call to notice — and a board still in the list keeps
   * its state object: its cached cards, its `generation` counter and its detail cache all survive.
   * That is the difference between this and a restart.
   *
   * `--repos` never reloads: it is an explicit set the human typed for this run.
   */
  function reloadBoards() {
    if (staticBoards || now() - listAt < ttlMs) return;
    listAt = now();
    let entries;
    try { entries = resolveBoards(); } catch (e) {
      // A half-written boards.json must not take a running board down: say so once and keep what we have.
      if (e.message !== listError) log(`board list: ${e.message} — keeping the ${boards.length} board(s) this server holds`);
      listError = e.message;
      return;
    }
    listError = null;
    const next = entries.map((entry) => {
      const held = byKey.get(entry.key);
      return held && held.root === entry.root ? held : boardState(entry);
    });
    const added = next.filter((b) => !boards.includes(b));
    const dropped = boards.filter((b) => !next.includes(b));
    boards = next;
    byKey = new Map(next.map((b) => [b.key, b]));
    if (!added.length && !dropped.length) return; // a reorder is not a change worth a line
    const what = [added.map((b) => `+${b.key}`).join(' '), dropped.map((b) => `-${b.key}`).join(' ')].filter(Boolean).join(' ');
    log(`board list changed: ${what} — now ${boards.length} board${boards.length === 1 ? '' : 's'} (${userBoardsFile()})`);
  }

  // One board read per poll interval per board, shared by every open tab.
  function boardState(b) {
    let cache = null; // { at, cards, error, stale, dispatcher }
    let inflight = null;
    let generation = 0; // bumped by every write, so a read that straddled one is never cached
    const details = new Map(); // number -> { at, payload }

    async function snapshot(force = false) {
      if (!force && cache && Date.now() - cache.at < ttlMs) return cache;
      if (inflight) return inflight;
      const g = generation;
      inflight = (async () => {
        const prev = cache;
        let cards = [];
        let error = null;
        try {
          cards = (await d.fetchBoard(b.ctx)).map(cardOf).sort((x, y) => y.priority - x.priority || x.number - y.number);
        } catch (e) {
          // One unreachable repo must not blank the others: keep the last good cards and say why.
          // The failure is cached like a success, so a broken board is not retried on every request.
          error = e.message;
          cards = prev?.cards || [];
          log(`board ${b.key}: ${e.message}`);
        }
        const snap = { at: Date.now(), cards, error, stale: !!error && !!prev?.cards.length, dispatcher: dispatcherState(b.ctx.root) };
        if (g === generation) cache = snap;
        return snap;
      })().finally(() => { inflight = null; });
      return inflight;
    }

    function invalidate(number) {
      generation++;
      cache = null;
      if (number) { details.delete(number); delete b.ctx._cache[`comments:${number}`]; }
      else details.clear();
    }

    async function detail(number, force = false) {
      const hit = details.get(number);
      if (!force && hit && Date.now() - hit.at < ttlMs) return hit.payload;
      delete b.ctx._cache[`comments:${number}`];
      const task = await d.getTask(b.ctx, number);
      const { run } = await d.loadRun(b.ctx, number);
      const [result, parents] = await Promise.all([d.latestResult(b.ctx, number), d.parentResults(b.ctx, task)]);
      const payload = {
        ...cardOf(task),
        // #12 on two boards is two different tasks, so the drawer says which one it is showing.
        key: b.key,
        repo: b.repo,
        board: b.board,
        bodyText: task.bodyText,
        kb: task.kb,
        labels: task.labels,
        // Attempts carry what `hkb show` prints: the session line, and the command to attach to a live worker.
        run: { ...run, attempts: (run.attempts || []).map((a) => ({ ...a, session: formatSession(a), resume: resumeCommand(a, number) })) },
        result,
        parents: parents.map((p) => ({ number: p.number, title: p.title, state: p.state, summary: p.result?.summary || null })),
        logs: (run.attempts || []).map((a) => {
          const file = logPathFor(b.ctx.root, run, number, a.attempt);
          return { attempt: a.attempt, path: file ? path.relative(b.ctx.root, file) : null, exists: !!file && fs.existsSync(file) };
        }).filter((l) => l.exists),
      };
      details.set(number, { at: Date.now(), payload });
      return payload;
    }

    return { ...b, snapshot, invalidate, detail };
  }

  /** The board a request names, or the only one there is. Ambiguity is refused, never guessed. */
  function boardFor(route) {
    if (route.key) {
      const b = byKey.get(route.key);
      if (b) return b;
      const e = new Error(`no board "${route.key}" on this server — one of ${keyList()}`);
      e.kind = 'notfound';
      throw e;
    }
    if (boards.length === 1) return boards[0];
    const tail = route.kind === 'verb' ? `/${route.verb}` : route.kind === 'log' ? '/log' : '';
    const e = new Error(`#${route.number} is ambiguous: this server holds ${boards.length} boards — call /api/boards/<key>/tasks/${route.number}${tail} instead (keys: ${keyList()})`);
    e.exitCode = 2;
    throw e;
  }

  /** Every board, one GraphQL query each, read in parallel. `at` is the oldest read: the honest one. */
  async function boardsPayload(force = false) {
    const list = boards; // a concurrent request may reload the set mid-read; this payload is of one set
    const snaps = await Promise.all(list.map((b) => b.snapshot(force)));
    return {
      at: Math.min(...snaps.map((s) => s.at)),
      // `fetched_at` is deliberately not in here: it changes every tick and must not bust the ETag.
      list: list.map((b, i) => ({
        key: b.key, repo: b.repo, board: b.board, root: b.root,
        dispatcher: snaps[i].dispatcher, error: snaps[i].error, stale: snaps[i].stale, tasks: snaps[i].cards,
      })),
    };
  }

  async function runVerb(b, number, verb, body) {
    const spec = VERBS[verb];
    if (!spec) { const e = new Error(`unknown verb "${verb}" — one of ${VERB_NAMES.join(', ')}, or move`); e.exitCode = 2; throw e; }
    const missing = missingFields(spec.needs, body);
    if (missing.length) { const e = new Error(`${verb} needs ${missing.join(', ')}`); e.exitCode = 2; e.needs = missing; throw e; }
    const r = await spec.run(d, b.ctx, number, body);
    b.invalidate(number);
    return r;
  }

  async function move(b, number, body) {
    const to = String(body?.to || '');
    // A drag is a write, so the decision is made against a fresh read (one GraphQL query) of the
    // board the card came from, never against the cached snapshot the page happens to be showing.
    const card = cardOf(await d.getTask(b.ctx, number));
    const decision = moveDecision(card, to);
    if (!decision.ok) { const e = new Error(decision.reason); e.exitCode = 2; e.refused = true; throw e; }
    if (!decision.steps.length) return { number, status: card.status, unchanged: true, note: decision.note };
    const missing = missingFields(decision.needs, body);
    if (missing.length) { const e = new Error(`moving #${number} from ${card.status} to ${to} needs ${missing.join(', ')}`); e.exitCode = 2; e.needs = missing; throw e; }
    let last = null;
    for (const verb of decision.steps) last = await runVerb(b, number, verb, body);
    return { ...last, requested: to, note: decision.note, landed: last?.status === to ? null : `#${number} landed in ${last?.status}, not ${to}` };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = parseRoute(url.pathname);
    if (url.pathname === '/favicon.ico') return send(res, 204, '');
    if (!route) return sendJson(res, 404, { error: `no route for ${url.pathname}` });

    const guard = checkOrigin(req.headers, { loopback });
    if (!guard.ok) return sendJson(res, 403, { error: guard.reason });

    if (route.kind === 'page') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' });
      let html;
      try { html = fs.readFileSync(PAGE_FILE); } catch (e) {
        return sendJson(res, 500, { error: `the board page is missing (${e.code}) at ${PAGE_FILE.pathname} — reinstall hkb` });
      }
      return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
    }

    // The page polls, so the list is re-read on the same cadence — no timer, and nothing to re-read
    // while nobody is looking. Before routing, so a board that just appeared is addressable at once.
    reloadBoards();

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (route.kind === 'board') {
        const snap = await boardsPayload(url.searchParams.get('refresh') === '1');
        const etag = boardEtag(snap.list);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-store' }); res.end(); return; }
        return sendJson(res, 200, {
          host: ctx.host, columns: COLUMNS, poll,
          fetched_at: new Date(snap.at).toISOString(), boards: snap.list,
        }, { etag });
      }
      // "which board" only matters once the method is right, so the 405 comes first.
      if (route.kind !== 'task' && route.kind !== 'log') return sendJson(res, 405, { error: 'POST only' });
      const b = boardFor(route);
      if (route.kind === 'task') return sendJson(res, 200, await b.detail(route.number, url.searchParams.get('refresh') === '1'));
      { // route.kind === 'log'
        const attempt = Number(url.searchParams.get('attempt') || 0);
        if (!Number.isInteger(attempt) || attempt < 1) return sendJson(res, 400, { error: '?attempt=<k> is required' });
        const { run } = await d.loadRun(b.ctx, route.number);
        const file = logPathFor(b.ctx.root, run, route.number, attempt);
        if (!file) return sendJson(res, 400, { error: `attempt ${attempt} of #${route.number} logs outside ${b.repo}'s .kanban/logs — refusing to read it` });
        const rel = path.relative(b.ctx.root, file);
        const bytes = Math.min(200_000, Math.max(1000, Number(url.searchParams.get('bytes') || 20_000)));
        const t = tailFile(file, bytes);
        if (!t) return sendJson(res, 404, { error: `no log yet at ${rel} (${b.repo})`, path: rel, key: b.key });
        return sendJson(res, 200, { number: route.number, attempt, key: b.key, repo: b.repo, path: rel, ...t });
      }
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
    if (route.kind !== 'verb') return sendJson(res, 405, { error: 'POST only applies to /api/tasks/:n/<verb>' });
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/.test(ct)) return sendJson(res, 415, { error: 'POST bodies must be application/json' });
    const raw = await readBody(req);
    let body = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: `body is not JSON: ${e.message}` }); }
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'body must be a JSON object' });
    const b = boardFor(route);
    const r = route.verb === 'move' ? await move(b, route.number, body) : await runVerb(b, route.number, route.verb, body);
    log(`${route.verb} #${route.number} → ${r.status ?? 'ok'}${boards.length > 1 ? ` (${b.repo})` : ''}`);
    return sendJson(res, 200, { ok: true, key: b.key, ...r });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = errorStatus(e);
      if (status >= 500) log(`${req.method} ${req.url} → ${status}: ${e.stack || e.message}`);
      if (!res.headersSent) sendJson(res, status, { error: e.message, ...(e.needs ? { needs: e.needs } : {}), ...(e.refused ? { refused: true } : {}) });
      else res.end();
    });
  });
  server.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

  await new Promise((resolve, reject) => {
    const onError = (e) => reject(e.code === 'EADDRINUSE'
      ? Object.assign(new Error(`port ${port} is already in use — pass --port <n>, or stop the other hkb serve`), { exitCode: 2 })
      : e);
    server.once('error', onError);
    server.listen(port, host, () => { server.removeListener('error', onError); resolve(); });
  });
  const bound = server.address();
  const shown = bound.address === '::' || bound.address === '0.0.0.0' ? 'localhost' : bound.address.includes(':') ? `[${bound.address}]` : bound.address;
  return {
    server, port: bound.port, host, poll, url: `http://${shown}:${bound.port}`,
    boards: boards.map((b) => ({ key: b.key, repo: b.repo, board: b.board, root: b.root })),
  };
}

/** One board on the startup line: `owner/repo` alone reads best, the slug only when it says something. */
const boardLine = (b) => `${b.repo}${b.board === 'default' ? '' : ` board "${b.board}"`}`;

/** `hkb serve` — runs until the process is interrupted. */
export async function serve(ctx, flags = {}, log = () => {}, deps = {}) {
  const s = await startServer(ctx, flags, log, deps);
  if (!isLoopback(s.host)) {
    log(`WARNING: --host ${s.host} exposes this board beyond 127.0.0.1. hkb serve has NO auth: anyone who can`);
    log('         reach this port can promote, block and archive tasks with your GitHub credentials.');
  }
  if (s.boards.length === 1) {
    log(`hkb serve on ${s.url} — ${ctx.repo.nameWithOwner} board "${ctx.board}", polling every ${s.poll}s. Ctrl-C to stop.`);
  } else {
    log(`hkb serve on ${s.url} — ${s.boards.length} boards, polling every ${s.poll}s. Ctrl-C to stop.`);
    for (const b of s.boards) log(`  ${b.key}  ${boardLine(b)}  ${b.root}`);
  }
  await new Promise((resolve) => {
    const stop = () => { s.server.close(() => resolve()); s.server.closeAllConnections?.(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    s.server.once('close', resolve);
  });
  return 0;
}
