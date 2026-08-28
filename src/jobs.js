// Background-agent jobs: what `claude --bg` creates and `claude agents` lists.
// One local listing per tick; state.json is read directly (no subprocess) when we know the id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KB_JOB_NAME_RE, sessionFromJobState } from './model.js';

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
