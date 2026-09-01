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
//                         has none falls back to the worker's own log on disk, then to the session
//                         transcript — both free, both local, both read only when the cheaper
//                         source above them came back empty. A transcript is read once and counted
//                         once however many attempts name it: a track is one session over N nodes.
//
// Three answers, and never one dressed as another. `claude-bg` — the default profile, the free path —
// writes a launch banner and no final JSON, so out of the box the first two sources hold nothing and
// the transcript is all there is. What a board's spend line is showing is therefore one of:
//
//   reported   `total_cost_usd`, off the run record or the worker log. A number Claude signed off on.
//   estimate   the transcript's tokens priced at the `stats.rates` of `.kanban/board.json`. Derived,
//              and always says so: written `~$…` and labelled an estimate.
//   usage      the transcript's tokens, unpriced — turns in, tokens out, which beat nothing.
//
// The cost is one board query plus the run comment of the tasks the window actually touched: a
// comment write bumps the issue's `updatedAt`, so "updated since" is exactly "has news". Tasks that
// are `running` are always read — a ref-CAS heartbeat leaves no trace on the issue, so a long
// attempt can be silent for hours and still be the thing you asked about.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawnSync } from 'node:child_process';
import { fetchBoard, loadRun } from './tasks.js';
import { readState, stateFile } from './board.js';
import { STATUSES, OUTCOMES, parseSessionLog, denialDisplayTool } from './model.js';

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

// ---------- pure: the tokens a session transcript holds ----------

const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** The counters a transcript can fill, all at zero. The shape is fixed so `--json` is stable. */
const zeroUsage = () => ({ turns: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

const tokens = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Add one usage-shaped object into an accumulator, counting only what is really a number. */
function addUsage(into, u) {
  if (u) for (const k of Object.keys(into)) into[k] += tokens(u[k]);
  return into;
}

/**
 * Token usage summed out of a Claude session transcript — the JSONL at `transcript_path`, one JSON
 * object per line. `lines` is any iterable, so the reader below streams a file through it without
 * ever holding it.
 *
 * Two things stop this from being "add up every `usage` you see":
 *  - one assistant message is written once per content block (the thinking, the text, each tool
 *    call), and every copy repeats the SAME `usage`. The message id is the unit — count a message
 *    once however many lines it spans, or a long turn is billed four and five times over.
 *  - a session can span models (a Haiku subagent under an Opus session) and they are not priced
 *    alike, so the total is kept per model as well as in aggregate.
 * Sidechain lines (Task subagents) are counted: their tokens are on the same bill.
 *
 * @returns null when there is no usage in it at all — an empty file, a truncated one, or a log that
 *   was never a transcript. Never throws: a spend report must not die on a malformed line.
 */
export function parseTranscriptUsage(lines) {
  const total = zeroUsage();
  const by_model = {};
  const seen = new Set();
  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw.trim() : '';
    // the cheap gates first: most lines of a transcript are user turns and tool results
    if (line[0] !== '{' || !line.includes('"usage"')) continue;
    const msg = tryJson(line)?.message;
    if (!msg?.usage || typeof msg.usage !== 'object') continue;
    if (typeof msg.id === 'string' && msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    const model = typeof msg.model === 'string' && msg.model ? msg.model : 'unknown';
    const per = (by_model[model] ||= zeroUsage());
    total.turns++;
    per.turns++;
    addUsage(total, msg.usage);
    addUsage(per, msg.usage);
  }
  return total.turns ? { ...total, by_model } : null;
}

// ---------- #130: the two denial shapes only a transcript carries ----------
//
// Neither shape is a `PreToolUse` denial — both are `tool_result` blocks Claude Code writes back into
// the transcript once a tool call it refused returns. An assistant `tool_use` names the tool; the
// `tool_result` that answers it only carries the tool_use_id, so a single pass keeps a small map from
// id to name as it goes, the same trick `permission_denials` needs `tool_use_id` for (#155).

const DONTASK_RE = /Permission to use (\S+) has been denied because Claude Code is running in don't ask mode/;
const WORKTREE_GUARD_RE = /can.t be verified to stay inside the worktree/;

/** The text of a `tool_result` block, whichever shape its `content` came in. */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/**
 * The dontAsk-miss and worktree-guard denials in a transcript — the two shapes #130 exists for,
 * neither of which lands in `permission_denials` (see `buildDeniedTools`, src/model.js). One pass:
 * an assistant message's `tool_use` blocks name the tool a later `tool_result` only carries by id.
 * @returns {Array<{tool, kind, first_seen}>|null} one entry per denial, in transcript order — null
 *   when the transcript held none (an empty file, a truncated one, one with nothing to report).
 */
export function parseTranscriptDenials(lines) {
  const toolNameById = new Map();
  const found = [];
  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw.trim() : '';
    if (line[0] !== '{') continue;
    const obj = tryJson(line);
    const msg = obj?.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      for (const block of msg.content) if (block?.type === 'tool_use' && block.id) toolNameById.set(block.id, block.name);
      continue;
    }
    if (msg.role !== 'user') continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_result') continue;
      const text = toolResultText(block.content);
      if (!text) continue;
      const dontAsk = text.match(DONTASK_RE);
      if (dontAsk) { found.push({ tool: dontAsk[1], kind: 'dontask-miss', first_seen: obj.timestamp || null }); continue; }
      if (WORKTREE_GUARD_RE.test(text)) {
        found.push({ tool: toolNameById.get(block.tool_use_id) || 'Bash', kind: 'worktree-guard', first_seen: obj.timestamp || null });
      }
    }
  }
  return found.length ? found : null;
}

// ---------- pure: an estimate, when the board has said what its tokens cost ----------

/**
 * The rate for a model out of `stats.rates` in `.kanban/board.json` — USD per MILLION tokens:
 *
 *   "stats": { "rates": { "claude-opus-5": { "input": 5, "output": 25 },
 *                         "claude-haiku":  { "input": 1, "output": 5 } } }
 *
 * hkb ships no table of its own on purpose: a price it invented would be indistinguishable in the
 * output from one Claude reported, and published prices move under a checkout that does not.
 *
 * A key matches a model exactly, else as its longest prefix, else `"default"`. `input` and `output`
 * are required — a rate missing either is no rate. `cache_write` and `cache_read` are optional and
 * fall back to Anthropic's published multipliers on `input` (write 1.25×, read 0.1×); set them
 * where your plan differs.
 */
export function ratesFor(rates, model) {
  if (!rates || typeof rates !== 'object') return null;
  let pick = rates[model];
  if (!pick) {
    let key = null;
    for (const k of Object.keys(rates)) {
      if (k === 'default' || !String(model).startsWith(k)) continue;
      if (key === null || k.length > key.length) key = k;
    }
    pick = key === null ? rates.default : rates[key];
  }
  if (!pick || typeof pick !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const input = n(pick.input);
  const output = n(pick.output);
  if (input === null || output === null) return null;
  return { input, output, cache_write: n(pick.cache_write) ?? input * 1.25, cache_read: n(pick.cache_read) ?? input * 0.1 };
}

/**
 * What a session's tokens would have cost at those rates. null when ANY model that actually spent
 * something has no rate: a figure that priced half a session would not be a low estimate, it would
 * be a wrong number. A model with nothing on the clock cannot be mispriced, so it is skipped —
 * Claude Code files an interrupted turn under the model `<synthetic>` with every counter at zero,
 * and one of those must not cost a whole board its estimate.
 */
export function estimateCost(usage, rates) {
  if (!usage?.by_model || !rates) return null;
  let total = 0;
  for (const [model, u] of Object.entries(usage.by_model)) {
    if (!(u.input_tokens || u.output_tokens || u.cache_creation_input_tokens || u.cache_read_input_tokens)) continue;
    const r = ratesFor(rates, model);
    if (!r) return null;
    total += (u.input_tokens * r.input + u.output_tokens * r.output
      + u.cache_creation_input_tokens * r.cache_write + u.cache_read_input_tokens * r.cache_read) / 1_000_000;
  }
  return usdRound(total);
}

/** An attempt with no session transcript behind it — the ordinary case, and the empty answer. */
const NO_SESSION = Object.freeze({ usage: null, session: null });

/**
 * What an attempt cost, and where the number came from. The run record first — it is the shared
 * truth every host can read — then the worker's log, then the session transcript, both of which
 * only the host that ran the attempt has. Each source is consulted only because the one above it
 * came back empty, so the transcript (the expensive read) is opened once, for the attempts that
 * have nothing else, and never for one still running.
 *
 * `cost_usd` from the transcript is an ESTIMATE and says so in `cost_source`; when the board has no
 * rate for the models it used there is no estimate at all, only `usage` — turns and tokens.
 *
 * `session` is set only on a row whose tokens came out of a transcript, and says whether this row is
 * the one carrying them: a session shared with other attempts is counted on exactly one of them.
 */
function priceOf(a, fromLog, fromTranscript, rates) {
  const row = finite(a.total_cost_usd);
  if (row !== null) return { cost_usd: row, num_turns: finite(a.num_turns), cost_source: 'run_record', usage: null, session: null };
  const logged = a.ended_at ? fromLog(a) : null;
  const cost = finite(logged?.total_cost_usd);
  if (cost !== null) return { cost_usd: cost, num_turns: finite(logged.num_turns) ?? finite(a.num_turns), cost_source: 'worker_log', usage: null, session: null };
  const { usage, session } = a.ended_at ? fromTranscript(a) : NO_SESSION;
  // another attempt already carries this session: its tokens are counted there, and only there
  if (session && !session.counted) return { cost_usd: null, num_turns: null, cost_source: null, usage: null, session };
  const estimate = usage ? estimateCost(usage, rates) : null;
  return { cost_usd: estimate, num_turns: finite(a.num_turns), cost_source: estimate === null ? null : 'estimate', usage, session };
}

/**
 * The transcript reader, made to answer once per FILE instead of once per attempt row.
 *
 * A `claude-track` runner claims every node of its subgraph from inside the session already running,
 * so the root's row and all of its nodes' rows carry the same `transcript_path`. Read per row, that
 * one session's tokens land in the board's total once per node — a track of five reporting five
 * times what it spent. So the file is opened once, the first row to ask carries its usage, and every
 * other row of the same session is handed `counted: false`: the tokens are over there, not here.
 *
 * Reading once matters on its own account — a transcript is the largest thing hkb ever opens.
 *
 * `attempts` (how many rows share the session) is only knowable once every row is in; `collectAttempts`
 * stamps it on these objects at the end, so a report can say "one session across N nodes".
 */
function transcriptOnce(read, sessions) {
  return (a) => {
    const file = typeof a?.transcript_path === 'string' && a.transcript_path ? a.transcript_path : null;
    // no file names this row's session, so there is nothing to share it by: priced on its own
    if (!file) return { usage: read(a) || null, session: null };
    let s = sessions.get(file);
    if (!s) sessions.set(file, (s = { usage: read(a) || null, rows: [] }));
    if (!s.usage) return NO_SESSION; // an absent or empty transcript shares nothing out
    const session = { id: typeof a.session_id === 'string' && a.session_id ? a.session_id : null, attempts: 1, counted: !s.rows.length };
    s.rows.push(session);
    return { usage: session.counted ? s.usage : null, session };
  };
}

/**
 * The attempt rows of the window, flattened across tasks. An ended attempt is in the window when it
 * ended inside it; an open one always is — it is happening now, whenever it started. (Same reasoning
 * as `tasksInWindow`: a long attempt that has been quiet for hours is the one you asked about.)
 * @param {Map|object} runs   task number → run record
 * @param {(a) => object|null} cost   session fields from the worker's log, for a row that has none
 * @param {(a) => object|null} usage  token totals from the session transcript, for a row with neither
 *   — called at most once per distinct `transcript_path`, however many attempts name it
 * @param {object|null} rates         `stats.rates`, which turns those tokens into an estimate
 */
export function collectAttempts(tasks, runs, since = null, { cost = () => null, usage = () => null, rates = null } = {}) {
  const floor = since ? Date.parse(since) : null;
  const rows = [];
  const sessions = new Map(); // transcript path → the one reading of it, and the rows that share it
  const transcript = transcriptOnce(usage, sessions);
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
        denied_tools: Array.isArray(a.denied_tools) && a.denied_tools.length ? a.denied_tools : null,
        ...priceOf(a, cost, transcript, rates),
      });
    }
  }
  // how wide a session spread is only known once every row is in — the objects on the rows are shared
  for (const s of sessions.values()) for (const r of s.rows) r.attempts = s.rows.length;
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
 * Spend per profile — and, kept strictly apart from it, what was only estimated and what is only
 * tokens. `total_usd` is reported money and nothing else; an estimate lives in `estimated_usd`, so
 * no caller can add the two by accident. `basis` is the one-word answer to "which of the three am I
 * looking at": `reported`, `estimate`, `usage`, or null for a board with none of them.
 *
 * Coverage is the rest of the answer: a total is only as honest as the share of attempts it covers,
 * so `worker_attempts` (every attempt that ended, bookkeeping rows excluded) is the denominator and
 * `attempts_missing_cost` counts the ones that yielded nothing at all — no cost, not even tokens.
 * `attempts_shared_session` is the third bucket: attempts that spent their tokens inside a session
 * another attempt already carries (a track's nodes), counted once there and never again here.
 */
export function summarizeSpend(rows) {
  const by_profile = {};
  const sources = { run_record: 0, worker_log: 0, estimate: 0 };
  const usage = zeroUsage();
  let total_usd = 0;
  let estimated_usd = 0;
  let worker_attempts = 0;
  let attempts_with_cost = 0;
  let attempts_estimated = 0;
  let attempts_with_usage = 0;
  let attempts_shared_session = 0;
  let attempts_missing_cost = 0;
  for (const r of rows) {
    if (r.synthetic) continue;
    const p = (by_profile[r.profile] ||= { attempts: 0, with_cost: 0, total_usd: 0, mean_usd: null, max_usd: null, turns: 0, estimated: 0, estimated_usd: 0, usage: null });
    p.attempts++;
    if (r.outcome) worker_attempts++;
    // one session, one bill: this row's tokens are on the attempt that carries the transcript
    if (r.session && !r.session.counted) { attempts_shared_session++; continue; }
    if (r.num_turns !== null) p.turns += r.num_turns;
    if (r.usage) {
      attempts_with_usage++;
      addUsage(usage, r.usage);
      addUsage((p.usage ||= zeroUsage()), r.usage);
    }
    if (r.cost_source === 'estimate') {
      attempts_estimated++;
      sources.estimate++;
      estimated_usd += r.cost_usd;
      p.estimated++;
      p.estimated_usd += r.cost_usd;
      continue;
    }
    if (r.cost_usd === null) {
      if (r.outcome && !r.usage) attempts_missing_cost++;
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
    p.estimated_usd = usdRound(p.estimated_usd);
    if (p.max_usd !== null) p.max_usd = usdRound(p.max_usd);
  }
  return {
    total_usd: usdRound(total_usd),
    estimated_usd: usdRound(estimated_usd),
    basis: attempts_with_cost ? 'reported' : attempts_estimated ? 'estimate' : attempts_with_usage ? 'usage' : null,
    worker_attempts,
    attempts_with_cost,
    attempts_estimated,
    attempts_with_usage,
    attempts_shared_session,
    attempts_missing_cost,
    sources,
    usage,
    by_profile,
  };
}

/**
 * "Tools workers wanted and could not use" — `denied_tools` (#130) summed across every attempt in the
 * window, grouped by tool+kind, most-denied first. `attempts` is how many distinct attempts hit that
 * tool at all — a worker that hit the same rule nine times in one attempt and one that hit it once in
 * nine attempts read very differently to an operator deciding whether to widen an allowlist.
 * `[]` when nothing in the window carries a ledger yet — an unpopulated board reads as "none seen",
 * not as an error.
 */
export function summarizeDeniedTools(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r.denied_tools) continue;
    for (const d of r.denied_tools) {
      const key = `${d.kind} ${d.tool}`;
      const row = byKey.get(key) || { tool: d.tool, kind: d.kind, count: 0, attempts: 0 };
      row.count += d.count;
      row.attempts += 1;
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((x, y) => y.count - x.count || x.tool.localeCompare(y.tool));
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
export function computeStats({ board, repo, tasks = [], runs = new Map(), since = null, window = 'all', spawns = null, now = new Date(), cost = () => null, usage = () => null, rates = null }) {
  const rows = collectAttempts(tasks, runs, since, { cost, usage, rates });
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
    denied_tools: summarizeDeniedTools(rows),
    reads: { board: 1, run_comments: read },
  };
}

// ---------- human output ----------

const usd = (v) => (v === null || v === undefined ? '—' : `$${v !== 0 && Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2)}`);

/** `842` · `37k` · `1.4M` — token counts at a glance; the exact figures are in `--json`. */
function tok(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

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
  const worker = `${m.worker_attempts} worker attempt${m.worker_attempts === 1 ? '' : 's'}`;
  const some = (n) => `${n} worker attempt${n === 1 ? '' : 's'}`;
  const noFinalJson = "only a harness whose log ends in Claude's final JSON reports one";
  if (m.attempts_with_cost) {
    lines.push(row('spend', `${usd(m.total_usd)} reported · on ${m.attempts_with_cost} of ${worker}`));
    for (const [name, p] of profiles) {
      if (!p.with_cost) continue;
      lines.push(row('', `${name.padEnd(12)} ${usd(p.total_usd).padStart(8)} · ${p.with_cost} attempt${p.with_cost === 1 ? '' : 's'} · mean ${usd(p.mean_usd)} · max ${usd(p.max_usd)}${p.turns ? ` · ${p.turns} turns` : ''}`));
    }
    if (m.attempts_estimated) lines.push(row('', `~${usd(m.estimated_usd)} estimated on top, for ${some(m.attempts_estimated)} priced from their transcripts — an estimate, not a reported cost`));
    if (m.attempts_missing_cost) lines.push(row('', `${some(m.attempts_missing_cost)} priced nothing at all — the real total is higher`));
  } else if (m.attempts_estimated) {
    lines.push(row('spend', `~${usd(m.estimated_usd)} ESTIMATED on ${m.attempts_estimated} of ${worker} — the tokens below at your \`stats.rates\`; nothing here reported a cost`));
  } else if (m.attempts_with_usage) {
    lines.push(row('spend', `no cost reported on any of the ${worker} — ${noFinalJson}; the usage below is all there is`));
  } else if (m.worker_attempts) {
    lines.push(row('spend', `not recorded on any of the ${worker} — ${noFinalJson}`));
  } else {
    // nothing ended here, so there is nothing to price — but say so. A blank where the spend line
    // belongs reads like a failure, and this report's whole job is to be believable about money.
    lines.push(row('spend', `nothing to price — no worker attempt ended in ${s.window === 'all' ? 'this board\'s history' : `the last ${s.window}`}`));
  }
  if (m.attempts_with_usage) {
    const u = m.usage;
    const files = `${m.attempts_with_usage} transcript${m.attempts_with_usage === 1 ? '' : 's'}`;
    const over = m.attempts_shared_session ? ` over ${some(m.attempts_with_usage + m.attempts_shared_session)}` : '';
    lines.push(row('usage', `${u.turns} turns · in ${tok(u.input_tokens)} · out ${tok(u.output_tokens)} · cache ${tok(u.cache_creation_input_tokens)} written / ${tok(u.cache_read_input_tokens)} read  (${files}${over})`));
  }
  if (m.attempts_shared_session) lines.push(row('', `${some(m.attempts_shared_session)} ran inside a session another attempt carries — counted once, there, not once per node`));
  if (m.attempts_with_usage && !m.attempts_estimated) lines.push(row('', 'no price: put `"stats": {"rates": {"<model>": {"input": <$/Mtok>, "output": <$/Mtok>}}}` in .kanban/board.json for an estimate'));

  if (s.denied_tools.length) {
    const byDisplay = new Map();
    for (const d of s.denied_tools) { const t = denialDisplayTool(d.tool); byDisplay.set(t, (byDisplay.get(t) || 0) + d.count); }
    const grouped = [...byDisplay].sort((x, y) => y[1] - x[1]);
    const top = grouped.slice(0, 5).map(([tool, n]) => `${tool} ×${n}`).join(', ');
    lines.push(row('denied', `${top}${grouped.length > 5 ? `, +${grouped.length - 5} more` : ''} — tools workers wanted and could not use; \`hkb doctor\` proposes the allowlist edit`));
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

const TRANSCRIPT_CHUNK_BYTES = 262_144;

/**
 * The lines of a file, one at a time. A transcript is the largest thing hkb ever reads — a long
 * session runs to tens of megabytes — and only its `usage` fields are wanted, so it is walked a
 * chunk at a time and never held whole. A `StringDecoder` carries a multi-byte character across a
 * chunk boundary instead of splitting it into two replacement characters and losing that line.
 * Yields nothing at all when the file cannot be opened or read.
 */
function* readLines(file, chunkBytes = TRANSCRIPT_CHUNK_BYTES) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const buf = Buffer.alloc(chunkBytes);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (;;) {
      let n;
      try { n = fs.readSync(fd, buf, 0, chunkBytes, null); } catch { return; }
      if (!n) break;
      const parts = (rest + decoder.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      yield* parts;
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * The tokens an attempt's session spent, out of its transcript. `transcript_path` is recorded once
 * by the Stop hook and is an absolute path on the host that ran the attempt — the same bonus-not-
 * truth deal as `sessionFromLog`: read from disk or not at all, and null whenever there is nothing
 * here to read, so a board reported from another machine simply falls back to today's message.
 */
export function usageFromTranscript(root, attempt) {
  const p = attempt?.transcript_path;
  if (!p || typeof p !== 'string') return null;
  return parseTranscriptUsage(readLines(path.isAbsolute(p) ? p : path.join(root, p)));
}

/**
 * `parseTranscriptDenials` over a transcript on disk — `transcript_path` may be relative to `root`,
 * same convention as `usageFromTranscript`. The dispatcher (src/dispatch.js) and the Stop hook
 * (src/hook.js) call this once, at the point they already have the path in hand (an attempt ending,
 * or a reap), and hand the result to `buildDeniedTools` (src/model.js) to merge with whatever
 * `permission_denials` the row already carries. null when there is nothing here to read.
 */
export function deniedToolsFromTranscript(root, transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  return parseTranscriptDenials(readLines(path.isAbsolute(transcriptPath) ? transcriptPath : path.join(root, transcriptPath)));
}

/**
 * The MCP servers a transcript actually called a tool from — out of its `tool_use` blocks, the
 * `mcp__<server>__` ones only. `hkb doctor` (#130) uses this to tell "configured in `.mcp.json`" from
 * "reached a worker at all": a server that never starts under a `--bg dontAsk` launch (wrong cwd,
 * missing env, a `.mcp.json` the daemon never re-reads) leaves the denied-tools ledger empty for the
 * wrong reason — nobody denied it, it was simply never there to deny.
 */
export function transcriptMcpServers(lines) {
  const servers = new Set();
  for (const raw of lines) {
    const line = typeof raw === 'string' ? raw.trim() : '';
    if (line[0] !== '{' || !line.includes('tool_use')) continue;
    const msg = tryJson(line)?.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      const m = /^mcp__([^_]+)__/.exec(block.name);
      if (m) servers.add(m[1]);
    }
  }
  return servers;
}

/** `transcriptMcpServers` over a transcript on disk — same path convention as `usageFromTranscript`. */
export function mcpServersFromTranscript(root, transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return new Set();
  return transcriptMcpServers(readLines(path.isAbsolute(transcriptPath) ? transcriptPath : path.join(root, transcriptPath)));
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
    usage: (a) => usageFromTranscript(local, a),
    rates: ctx.cfg?.stats?.rates || null,
  });
  write(ctx.json ? JSON.stringify(report, null, 2) : formatStats(report));
  return 0;
}
