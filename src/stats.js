// `hkb stats` — attempts, outcomes and spend per board, so a paid profile is never a surprise.
//
// Everything it reports is already recorded by the protocol; nothing new is stored and nothing is
// written back — not a label, not a comment, not a state file. One tick's worth of reads:
//
//   tasks per status      the `kb:status:*` labels on the board, as they are right now
//   attempts per outcome  the `<!-- kb-run -->` attempt rows whose activity falls in the window
//   duration              started_at → ended_at of the ended ones (mean, median, p90)
//   spawns today vs cap   .kanban/state.json, which the dispatcher tick keeps — a local read
//   spend per profile     `total_cost_usd` on the attempt row: what `claude -p --output-format json`
//                         signs off with, folded in by the dispatcher (or the Stop hook). A row that
//                         has none falls back to the worker's own log on disk, which is free.
//
// The cost is one board query plus the run comment of the tasks the window actually touched: a
// comment write bumps the issue's `updatedAt`, so "updated since" is exactly "has news". Tasks that
// are `running` are always read — a ref-CAS heartbeat leaves no trace on the issue, so a long
// attempt can be silent for hours and still be the thing you asked about.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchBoard, loadRun } from './tasks.js';
import { readState, stateFile } from './board.js';
import { STATUSES, OUTCOMES, parseSessionLog } from './model.js';

const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };

/** An attempt that ended with work in hand. `blocked` is neither this nor a failure. */
export const DELIVERED_OUTCOMES = ['completed', 'review_requested'];
/** An attempt the dispatcher had to write off. */
export const FAILED_OUTCOMES = ['crashed', 'timed_out', 'spawn_failed', 'reclaimed', 'protocol_violation', 'gave_up'];

// ---------- pure: the window ----------

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export const DEFAULT_SINCE = '7d';

/**
 * `--since` → where the window starts. A span (`90m`, `36h`, `7d`, `2w`), a date or timestamp
 * (`2026-08-01`, `2026-08-01T12:00:00Z`), or `all` for the whole history.
 * @returns {{since: string|null, window: string}} `since` is null for "all".
 */
export function parseSince(value, now = new Date()) {
  if (value === true) throw usage('--since needs a value, e.g. --since 7d (spans: 90m, 36h, 7d, 2w · or a date, or "all")');
  const raw = value === undefined || value === null || value === '' ? DEFAULT_SINCE : String(value).trim();
  if (/^(all|0)$/i.test(raw)) return { since: null, window: 'all' };
  const rel = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(raw);
  if (rel) {
    const span = Number(rel[1]) * UNITS[rel[2].toLowerCase()];
    if (!span) throw usage(`--since ${raw} is a zero-length window — use "all" for the whole history`);
    return { since: new Date(now.getTime() - span).toISOString(), window: `${rel[1]}${rel[2].toLowerCase()}` };
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw usage(`--since: cannot read "${raw}" — use a span (7d, 36h, 90m, 2w), a date (2026-08-01), or "all"`);
  return { since: at.toISOString(), window: at.toISOString() };
}

/** A timestamp as epoch ms, or null when it is missing or unreadable. Never throws. */
const at = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/**
 * Which tasks the window has news about: updated since the floor, or running — a ref-CAS
 * heartbeat writes nothing to the issue, so an active attempt need not have moved `updatedAt`.
 */
export function tasksInWindow(tasks, since = null) {
  if (!since) return [...tasks];
  const floor = Date.parse(since);
  return tasks.filter((t) => t.status === 'running' || (at(t.updatedAt) ?? -Infinity) >= floor);
}

// ---------- pure: attempts ----------

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * What an attempt cost, and where the number came from. The run record first — it is the shared
 * truth every host can read — then the worker's log, which only the host that ran it has.
 */
function priceOf(a, fromLog) {
  const row = finite(a.total_cost_usd);
  if (row !== null) return { cost_usd: row, num_turns: finite(a.num_turns), cost_source: 'run_record' };
  const session = a.ended_at ? fromLog(a) : null;
  const logged = finite(session?.total_cost_usd);
  if (logged !== null) return { cost_usd: logged, num_turns: finite(session.num_turns) ?? finite(a.num_turns), cost_source: 'worker_log' };
  return { cost_usd: null, num_turns: finite(a.num_turns), cost_source: null };
}

/**
 * The attempt rows of the window, flattened across tasks. An ended attempt is in the window when it
 * ended inside it; an open one always is — it is happening now, whenever it started. (Same reasoning
 * as `tasksInWindow`: a long attempt that has been quiet for hours is the one you asked about.)
 * @param {Map|object} runs   task number → run record
 * @param {(a) => object|null} cost  session fields from the worker's log, for a row that has none
 */
export function collectAttempts(tasks, runs, since = null, { cost = () => null } = {}) {
  const floor = since ? Date.parse(since) : null;
  const rows = [];
  for (const t of tasks) {
    const run = (typeof runs?.get === 'function' ? runs.get(t.number) : runs?.[t.number]) || null;
    for (const a of run?.attempts || []) {
      const started = at(a.started_at);
      const ended = at(a.ended_at);
      if (floor !== null && a.ended_at && (ended === null || ended < floor)) continue;
      if (floor !== null && !a.ended_at && started === null) continue; // no start, no end: nothing to place
      rows.push({
        number: t.number,
        attempt: a.attempt ?? null,
        profile: a.profile || 'unknown',
        outcome: a.ended_at ? (a.outcome || 'ended') : null,
        started_at: a.started_at || null,
        ended_at: a.ended_at || null,
        duration_ms: started !== null && ended !== null && ended >= started ? ended - started : null,
        // rows the dispatcher or a reviewer writes for the record (gave_up, changes_requested):
        // real outcomes, but zero-duration bookkeeping — they must not drag the averages down
        synthetic: !!a.synthetic,
        ...priceOf(a, cost),
      });
    }
  }
  return rows;
}

// ---------- pure: summaries ----------

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

const usdRound = (v) => Math.round(v * 10_000) / 10_000;

export function summarizeTasks(tasks, since = null) {
  const by_status = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let open = 0;
  let needs_human = 0;
  for (const t of tasks) {
    const key = t.status || 'none';
    by_status[key] = (by_status[key] || 0) + 1;
    if (String(t.state || 'OPEN').toUpperCase() === 'OPEN') open++;
    if (t.needsHuman) needs_human++;
  }
  return {
    total: tasks.length,
    open,
    closed: tasks.length - open,
    needs_human,
    updated_in_window: tasksInWindow(tasks, since).length,
    by_status,
  };
}

/** Counts per outcome, the delivered/blocked/failed split, and how long the ended ones took. */
export function summarizeAttempts(rows) {
  const by_outcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const tasks = new Set();
  let ended = 0;
  let active = 0;
  let delivered = 0;
  let blocked = 0;
  let failed = 0;
  const durations = [];
  for (const r of rows) {
    tasks.add(r.number);
    if (!r.outcome) { active++; continue; }
    ended++;
    by_outcome[r.outcome] = (by_outcome[r.outcome] || 0) + 1;
    if (DELIVERED_OUTCOMES.includes(r.outcome)) delivered++;
    else if (FAILED_OUTCOMES.includes(r.outcome)) failed++;
    else blocked++;
    if (!r.synthetic && r.duration_ms !== null) durations.push(r.duration_ms);
  }
  durations.sort((a, b) => a - b);
  const total = durations.reduce((s, d) => s + d, 0);
  return {
    total: rows.length,
    tasks: tasks.size,
    ended,
    active,
    delivered,
    blocked,
    failed,
    delivered_rate: ended ? Math.round((delivered / ended) * 100) / 100 : null,
    by_outcome,
    duration_ms: {
      count: durations.length,
      total,
      mean: durations.length ? Math.round(total / durations.length) : null,
      median: quantile(durations, 0.5),
      p90: quantile(durations, 0.9),
      max: durations.length ? durations[durations.length - 1] : null,
    },
  };
}

/**
 * Spend per profile. Only harnesses whose log ends in Claude's final JSON report a cost, so
 * `attempts_missing_cost` is part of the answer: a total is only as honest as its coverage.
 */
export function summarizeSpend(rows) {
  const by_profile = {};
  const sources = { run_record: 0, worker_log: 0 };
  let total_usd = 0;
  let attempts_with_cost = 0;
  let attempts_missing_cost = 0;
  for (const r of rows) {
    if (r.synthetic) continue;
    const p = (by_profile[r.profile] ||= { attempts: 0, with_cost: 0, total_usd: 0, mean_usd: null, max_usd: null, turns: 0 });
    p.attempts++;
    if (r.num_turns !== null) p.turns += r.num_turns;
    if (r.cost_usd === null) {
      if (r.outcome) attempts_missing_cost++;
      continue;
    }
    p.with_cost++;
    p.total_usd += r.cost_usd;
    p.max_usd = p.max_usd === null ? r.cost_usd : Math.max(p.max_usd, r.cost_usd);
    total_usd += r.cost_usd;
    attempts_with_cost++;
    if (r.cost_source) sources[r.cost_source] = (sources[r.cost_source] || 0) + 1;
  }
  for (const p of Object.values(by_profile)) {
    p.mean_usd = p.with_cost ? usdRound(p.total_usd / p.with_cost) : null;
    p.total_usd = usdRound(p.total_usd);
    if (p.max_usd !== null) p.max_usd = usdRound(p.max_usd);
  }
  return { total_usd: usdRound(total_usd), attempts_with_cost, attempts_missing_cost, sources, by_profile };
}

/**
 * Today's spawn count against the dispatcher's daily cap, out of `.kanban/state.json`.
 * The day is UTC, the same slice the tick uses, so a stale `spawn_day` reads as zero.
 * `state` is null when there is no dispatcher state here at all — a checkout that has never run a
 * tick (a worktree, a fresh clone) must say "unknown", not "zero".
 */
export function spawnBudget(state, cap, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const today = state?.spawn_day === day ? Number(state.spawned_today || 0) : 0;
  const limit = cap === null || cap === undefined || cap === '' ? null : finite(Number(cap));
  return {
    day,
    today,
    cap: limit,
    remaining: limit === null ? null : Math.max(0, limit - today),
    at_cap: limit !== null && today >= limit,
    known: state !== null && state !== undefined,
  };
}

/** The whole report, from data alone. Pure: same inputs, same object. */
export function computeStats({ board, repo, tasks = [], runs = new Map(), since = null, window = 'all', spawns = null, now = new Date(), cost = () => null }) {
  const rows = collectAttempts(tasks, runs, since, { cost });
  const read = typeof runs?.size === 'number' ? runs.size : Object.keys(runs || {}).length;
  return {
    board,
    repo: repo || null,
    generated_at: now.toISOString(),
    since,
    window,
    tasks: summarizeTasks(tasks, since),
    attempts: summarizeAttempts(rows),
    spawns: spawns || spawnBudget(null, null, now),
    spend: summarizeSpend(rows),
    reads: { board: 1, run_comments: read },
  };
}

// ---------- human output ----------

const usd = (v) => (v === null || v === undefined ? '—' : `$${v !== 0 && Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2)}`);

function dur(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** `completed 4 · crashed 1` — the counts that are not zero, in the order they were declared. */
const counts = (obj) => Object.entries(obj).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ');

const row = (label, text) => `${label.padEnd(10)} ${text}`;

export function formatStats(s) {
  const lines = [];
  const scope = s.window === 'all' ? 'all time' : `window ${s.window}`;
  lines.push(`board "${s.board}"${s.repo ? ` · ${s.repo}` : ''} · ${scope}${s.since ? ` (since ${s.since})` : ''}`);
  lines.push('');

  const t = s.tasks;
  lines.push(row('tasks', `${t.total} (${t.open} open${t.needs_human ? `, ${t.needs_human} needs-human` : ''}) · ${t.updated_in_window} with news in the window`));
  lines.push(row('', counts(t.by_status) || '(none on this board)'));

  const a = s.attempts;
  if (!a.total) {
    lines.push(row('attempts', 'none in the window'));
  } else {
    lines.push(row('attempts', `${a.total} over ${a.tasks} task${a.tasks === 1 ? '' : 's'} · ${a.ended} ended · ${a.active} active`));
    lines.push(row('', counts(a.by_outcome) || '(all still running)'));
    if (a.ended) lines.push(row('', `delivered ${a.delivered} (${Math.round(a.delivered_rate * 100)}%) · blocked ${a.blocked} · failed ${a.failed}`));
    const d = a.duration_ms;
    if (d.count) lines.push(row('duration', `mean ${dur(d.mean)} · median ${dur(d.median)} · p90 ${dur(d.p90)} · max ${dur(d.max)}  (${d.count} ended)`));
  }

  const sp = s.spawns;
  const budget = sp.cap === null
    ? `${sp.today} today (no daily cap set)`
    : `${sp.today} / ${sp.cap} today · ${sp.remaining} left${sp.at_cap ? ' · AT CAP — the dispatcher will claim nothing more today' : ''}`;
  lines.push(row('spawns', sp.known ? budget : `unknown here · cap ${sp.cap ?? 'none'} — no dispatcher state in this checkout, run \`hkb stats\` where \`hkb dispatch\` runs`));

  const m = s.spend;
  const profiles = Object.entries(m.by_profile).sort((x, y) => y[1].total_usd - x[1].total_usd);
  // coverage is against the attempts a worker actually ran — the dispatcher's own bookkeeping rows
  // never had a cost to record, so counting them would make every board look under-reported
  const priceable = m.attempts_with_cost + m.attempts_missing_cost;
  const worker = `${priceable} worker attempt${priceable === 1 ? '' : 's'}`;
  if (!m.attempts_with_cost) {
    if (priceable) lines.push(row('spend', `not recorded on any of the ${worker} — only a harness whose log ends in Claude's final JSON reports one`));
  } else {
    lines.push(row('spend', `${usd(m.total_usd)} · recorded on ${m.attempts_with_cost} of ${worker}`));
    for (const [name, p] of profiles) {
      if (!p.with_cost) continue;
      lines.push(row('', `${name.padEnd(12)} ${usd(p.total_usd).padStart(8)} · ${p.with_cost} attempt${p.with_cost === 1 ? '' : 's'} · mean ${usd(p.mean_usd)} · max ${usd(p.max_usd)}${p.turns ? ` · ${p.turns} turns` : ''}`));
    }
    if (m.attempts_missing_cost) lines.push(row('', `${m.attempts_missing_cost} worker attempt${m.attempts_missing_cost === 1 ? '' : 's'} recorded no cost — the real total is higher`));
  }
  lines.push('');
  lines.push(`read 1 board query + ${s.reads.run_comments} run record${s.reads.run_comments === 1 ? '' : 's'}; nothing was written.`);
  return lines.join('\n');
}

// ---------- the worker log, read locally ----------

const LOG_TAIL_BYTES = 256_000;

/** The tail of a file, without pulling a long log into memory. '' when it cannot be read. */
function readTail(file, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    if (!length) return '';
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * The session fields at the end of a worker's log — `claude -p --output-format json` signs off with
 * one JSON object holding `total_cost_usd`. Only the host that ran the attempt has the file, so this
 * is a bonus, never the source of truth: null whenever there is nothing to read.
 */
export function sessionFromLog(root, attempt) {
  if (!attempt?.log) return null;
  const text = readTail(path.join(root, attempt.log));
  if (!text) return null;
  try { return parseSessionLog(text); } catch { return null; }
}

// ---------- the command ----------

/**
 * Where the dispatcher's local artifacts live — its `state.json` and the worker logs. `.kanban/` is
 * per repository, not per checkout, so from a worker's worktree that is the main checkout, one
 * `git rev-parse` away. Anything unexpected (no git, a bare repo, no `.kanban` there) keeps `root`.
 */
export function dispatcherRoot(root) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return root;
  const common = path.resolve(root, r.stdout.trim());
  if (path.basename(common) !== '.git') return root;
  const main = path.dirname(common);
  return main !== root && fs.existsSync(path.join(main, '.kanban')) ? main : root;
}

export async function stats(ctx, flags = {}, deps = {}) {
  ctx.requireBoard();
  const now = deps.now ? new Date(deps.now) : new Date();
  const { since, window } = parseSince(flags.since, now);
  const write = deps.write || ((s) => process.stdout.write(s + '\n'));
  const local = deps.localRoot || dispatcherRoot(ctx.root);

  const tasks = await fetchBoard(ctx, { includeClosed: true });
  const runs = new Map();
  // every read is counted, empty or not: `reads.run_comments` is what this command cost
  for (const t of tasksInWindow(tasks, since)) runs.set(t.number, (await loadRun(ctx, t.number)).run);

  const report = computeStats({
    board: ctx.board,
    repo: ctx.repo?.nameWithOwner,
    tasks,
    runs,
    since,
    window,
    now,
    spawns: spawnBudget(fs.existsSync(stateFile(local)) ? readState(local) : null, ctx.cfg?.dispatch?.daily_spawn_cap, now),
    cost: (a) => sessionFromLog(local, a),
  });
  write(ctx.json ? JSON.stringify(report, null, 2) : formatStats(report));
  return 0;
}
