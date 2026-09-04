// The `claude --bg` runtime: what `claude --bg` creates and `claude agents` lists.
//
// This was `src/jobs.js` until the runtime seam (docs/local-first.md §4). Everything about a
// background-agent job lives here now — the listing, the job record, the session behind it, and the
// four lifecycle verbs the tick calls through `runtimeFor`. One local listing per tick; state.json
// is read directly (no subprocess) when we know the id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { KB_JOB_NAME_RE, SESSION_FIELDS, sessionFromJobState, sessionUpdate, classifyJob, jobWorking, parseBackgroundedId, scrubKbEnv } from '../model.js';
import { NOT_IMPLEMENTED, UNKNOWN, REGISTER_GRACE } from './contract.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export const MODE = 'claude-bg';

const nowIso = () => new Date().toISOString();
const secondsSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 1000 : Infinity);

/**
 * A job that has registered but is not on a turn is not finished — it may be parked on a permission
 * prompt. Only a job that has *stopped taking turns* for this long is a protocol violation; the
 * short grace is what keeps a launch that is still handing over from being called one.
 */
const TURN_GRACE = 30;

export function jobsDir() { return path.join(os.homedir(), '.claude', 'jobs'); }

/**
 * The agent session THIS process is running inside, when the harness says so locally.
 *
 * Claude Code exports `CLAUDE_CODE_SESSION_ID` into every command a session runs, and for a
 * background agent `CLAUDE_JOB_DIR` names that job's record — the same `state.json` `readJobState`
 * parses below, which also holds the transcript. So a `claude --bg` worker CAN name its own session
 * and transcript, even though the launch environment never reaches it: the terminal verb it has to
 * run anyway records what the Stop hook could not (see src/hook.js).
 *
 * A bonus, never the source of truth: null whenever there is nothing here to read, and never throws.
 * `env` is what makes it reusable: `jobSession` below hands it the directory of a job this process is
 * NOT inside, which is the dispatcher's only way to read the same record.
 * @returns {{session_id?: string, transcript_path?: string}|null}
 */
export function currentSession(env = process.env) {
  const id = typeof env.CLAUDE_CODE_SESSION_ID === 'string' && env.CLAUDE_CODE_SESSION_ID ? env.CLAUDE_CODE_SESSION_ID : null;
  let state = null;
  if (env.CLAUDE_JOB_DIR) {
    try { state = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_JOB_DIR, 'state.json'), 'utf8')); } catch { /* no job record here */ }
  }
  const job = sessionFromJobState(state);
  // A job record describes the session running now — but a resumed job is one record over two
  // sessions, so a record naming a session we are not in is somebody else's transcript. Then the
  // only thing we are sure of is the id in the environment.
  if (job && (!id || !job.session_id || job.session_id === id)) return id ? { ...job, session_id: id } : job;
  return id ? { session_id: id } : null;
}

/** Read ~/.claude/jobs/<id>/state.json. Returns null when the job is unknown. */
export function readJobState(id) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(jobsDir(), id, 'state.json'), 'utf8'));
    const sessionId = s.linkScanPath ? path.basename(s.linkScanPath, '.jsonl') : null;
    return { id, state: s.state, detail: s.detail, tokens: s.tokens, result: s.output?.result, sessionId };
  } catch { return null; }
}

/**
 * The session behind a background job seen from OUTSIDE it — the dispatcher's side of the question
 * `currentSession` answers for the worker itself. All the dispatcher ever holds is the job, so it
 * reads the record Claude Code keeps at `~/.claude/jobs/<id>/state.json`; the listing's own
 * `sessionId` is the fallback while that record has nothing to say yet.
 *
 * One local file read, no subprocess, never a throw. `root` is for tests.
 * @returns {{session_id?: string, transcript_path?: string}|null}
 */
function jobSession(job, root = jobsDir()) {
  const record = job?.id ? currentSession({ CLAUDE_JOB_DIR: path.join(root, job.id) }) : null;
  const listed = typeof job?.sessionId === 'string' && job.sessionId ? { session_id: job.sessionId } : null;
  // one source or the other, never a blend: an id from the listing paired with a transcript from the
  // record can describe two different sessions of a resumed job.
  return record || listed;
}

/**
 * What the dispatcher should write onto the attempt row a background job is running, the first tick
 * it matches that job. #135 records these fields from the terminal verb; this is the same discipline
 * for the attempts no verb ever reaches — crashed, timed out, protocol_violation — which are exactly
 * the ones a human reopens with `claude --resume` and the ones `hkb stats` could not price.
 *
 * Blanks, and one correction. A row a verb has already stamped is left byte-identical — but a row
 * naming a *different* session than the job actually running this attempt is not a row to preserve:
 * the tick resolved that job from the attempt's own checkout, and a hook stamp can come from any
 * session that happened to have `KB_TASK` in its environment (#150 — a session daemon started by a
 * `claude --bg` launch handed #146's identity to an operator's conversation, whose Stop hook then
 * claimed the work). So the job wins, and the whole session goes with it: the fields the job cannot
 * name are cleared rather than left describing the session we just replaced.
 * @returns {{session_id?: string, transcript_path?: string}|null} null when there is nothing to write
 */
export function jobSessionUpdate(attempt, job, root = jobsDir()) {
  if (!job) return null;
  const found = jobSession(job, root);
  if (!found) return null;
  if (attempt?.session_id && found.session_id && attempt.session_id !== found.session_id) {
    const fix = sessionUpdate(attempt, found) || {};
    for (const k of SESSION_FIELDS) if (found[k] === undefined && attempt[k] !== undefined) fix[k] = undefined;
    return Object.keys(fix).length ? fix : null;
  }
  const blanks = {};
  for (const [k, v] of Object.entries(found)) if (attempt?.[k] === undefined) blanks[k] = v;
  return sessionUpdate(attempt, blanks);
}

/** `claude agents --json --all --cwd <root>` → kb jobs only: [{id, pid, name, status, state, cwd, task}]. */
export function listKbJobs(root) {
  const r = spawnSync('claude', ['agents', '--json', '--all', '--cwd', root], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return { ok: false, jobs: [], error: (r.stderr || r.stdout || '').replace(ANSI_RE, '').trim().split('\n').pop() };
  let arr = [];
  try { arr = JSON.parse(r.stdout || '[]'); } catch { return { ok: false, jobs: [], error: 'unparseable `claude agents --json` output' }; }
  const jobs = [];
  for (const x of arr) {
    if (x.kind !== 'background') continue;
    const m = KB_JOB_NAME_RE.exec(x.name || '');
    if (!m) continue;
    jobs.push({ id: x.id, pid: x.pid || null, name: x.name, status: x.status, state: x.state, cwd: x.cwd, sessionId: x.sessionId, task: Number(m[1]) });
  }
  return { ok: true, jobs };
}

export function stopJob(id) {
  const r = spawnSync('claude', ['stop', id], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0;
}

/** A launched job is identified by its worktree: cwd basename == kb-<n>-<k>. */
export function matchJobByWorktree(jobs, wtName) {
  return (jobs || []).find((j) => j.cwd && path.basename(j.cwd) === wtName) || null;
}

// ---------- the runtime verbs ----------

/**
 * Fire-and-forget: `claude --bg` prints "backgrounded · <id>" and exits, but a cold daemon start can
 * take a minute — never block the tick on it. Detach, log its output, and identify the running job
 * by its worktree on the next tick (cwd basename == kb-<n>-<k>).
 *
 * The launch environment is the worker's identity for every harness run as a child process: it dies
 * with that process. This one is the exception — it hands the request to Claude Code's session
 * daemon and exits, and a launch that finds no daemon *starts* one, which then keeps this
 * environment for its whole life and hands it to every session it hosts (#150). It reaches no
 * worker here anyway (#125: the checkout is that profile's identity), so it goes.
 */
export function launch(ctx, task, k, { argv, cwd, logFile, name, continued = null, toolsDropped = [] }) {
  fs.appendFileSync(logFile, `# ${nowIso()} launch background agent for #${task.number} attempt ${k}\n`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(argv[0], argv.slice(1), { cwd, env: scrubKbEnv(process.env), detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', () => { /* surfaced next tick as crashed if the job never registers */ });
  fs.closeSync(fd);
  child.unref();
  return {
    argv, pid: null, bg: true, wt: name, logFile, continued, tools_dropped: toolsDropped,
    handle: { runtime: MODE, wt: name },
    row: { pid: null, bg: true, wt: name },
    describe: `background agent in ${name} (job id on next tick; claude agents to watch)`,
  };
}

/**
 * The job behind this attempt, and what it says. Three ways to find it, in order of reliability:
 * the id already on the row, the "backgrounded · <id>" line the launch log carries, and finally the
 * worktree the job is sitting in.
 *
 * `classifyJob` counts blocked/waiting as running, because an agent on a permission prompt is a live
 * worker — treating it as finished killed #14/2 and #3/2.
 */
export function inspect(ctx, attempt, { jobs = new Map(), task = null, dryRun = false } = {}) {
  if (!attempt || attempt.host !== ctx.host) return { ...UNKNOWN };
  let job = attempt.job ? (jobs.get(attempt.job) || readJobState(attempt.job)) : null;
  const patch = {};
  if (!job && attempt.bg && attempt.log) {
    // the launch log contains "backgrounded · <id>" — the reliable source for the job id
    let id = null;
    try { id = parseBackgroundedId(fs.readFileSync(path.join(ctx.root, attempt.log), 'utf8')); } catch { /* not yet written */ }
    if (id) { job = jobs.get(id) || readJobState(id); if (!dryRun) patch.job = id; }
  }
  if (!job && attempt.bg) job = matchJobByWorktree([...jobs.values()], attempt.wt || `kb-${task?.number}-${attempt.attempt}`);
  // The tick after the launch, name the session behind the job. A `claude --bg` worker records its
  // own identity from the terminal verb it runs (#135) — but the attempts that need it most are the
  // ones that never run one, and the job record already says everything they need.
  const session = dryRun ? null : jobSessionUpdate(attempt, job);
  let outcome = null;
  if (!job) { if (secondsSince(attempt.started_at) > REGISTER_GRACE) outcome = 'crashed'; }
  else if (classifyJob(job) !== 'running' && secondsSince(attempt.started_at) > TURN_GRACE) outcome = 'protocol_violation';
  return {
    alive: job ? classifyJob(job) === 'running' : null,
    working: job ? jobWorking(job) : null,
    handle: job ? { runtime: MODE, id: attempt.job || job.id, raw: job } : null,
    session,
    outcome,
    patch: Object.keys(patch).length ? patch : null,
  };
}

/**
 * `claude stop <job>`. Once per attempt: the row records that the job was stopped so a card written
 * off twice does not ask the daemon twice, and a stop that failed is not retried here — the reap
 * comes back for it next tick.
 */
export function stop(ctx, attempt) {
  if (!attempt || attempt.host !== ctx.host || !attempt.job || attempt.job_stopped) return false;
  const ok = stopJob(attempt.job);
  attempt.job_stopped = true;
  return ok;
}

export function pause() { return NOT_IMPLEMENTED; }
export function resume() { return NOT_IMPLEMENTED; }

/** The job record already named the session during `inspect`; there is nothing left to read. */
export function postMortem() { return null; }

/**
 * This runtime's one local subprocess per tick.
 * @param {any} ctx
 * @param {(...a: any[]) => void} log
 */
export function listing(ctx, log = () => {}) {
  const r = listKbJobs(ctx.root);
  if (!r.ok) log(`claude agents listing failed: ${r.error}`);
  return {
    ok: r.ok,
    handles: r.jobs.map((j) => ({ runtime: MODE, id: j.id, task: j.task, raw: j, label: `background agent ${j.id}` })),
  };
}

/** Stop something the listing found, rather than a row on the board (the reap). */
export function stopHandle(ctx, handle) { return stopJob(handle.id); }
