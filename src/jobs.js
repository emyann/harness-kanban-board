// Background-agent jobs: what `claude --bg` creates and `claude agents` lists.
// One local listing per tick; state.json is read directly (no subprocess) when we know the id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KB_JOB_NAME_RE, SESSION_FIELDS, sessionFromJobState, sessionUpdate } from './model.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

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
