// Background-agent jobs: what `claude --bg` creates and `claude agents` lists.
// One local listing per tick; state.json is read directly (no subprocess) when we know the id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KB_JOB_NAME_RE } from './model.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function jobsDir() { return path.join(os.homedir(), '.claude', 'jobs'); }

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
