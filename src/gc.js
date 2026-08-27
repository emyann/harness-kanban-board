// `hkb gc` — the cleanup sweeps: worktrees and branches of finished attempts, duplicate run
// comments, dead local beat chains, old logs and nudges. Destructive steps need --yes.
//
// Every sweep is a callable function because the dispatcher runs the same ones (src/dispatch.js):
// `sweepTask` the moment a task leaves the open board, and `sweep` — exactly what `hkb gc --yes`
// runs — every `dispatch.gc_every_ticks`. Manual and automatic cleanup can never diverge.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchBoard, loadRun, deleteComment } from './tasks.js';
import { listLocks, listBeatChains, dropBeatChain } from './lock.js';
import { logsDir, kanbanDir } from './board.js';

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const lastLine = (s) => String(s || '').trim().split('\n').pop() || '';

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * What an attempt leaves on the host is named after it: the worktree directory is `kb-<n>-<k>`,
 * the branch either `kb-<n>-<k>` (dispatcher-made checkout) or `worktree-kb-<n>-<k>` (Claude Code).
 * @returns {{n:number,k:number}|null}
 */
export function attemptOf(name) {
  const m = /^(?:worktree-)?kb-(\d+)-(\d+)$/.exec(String(name || '').trim());
  return m ? { n: Number(m[1]), k: Number(m[2]) } : null;
}

/** Every worktree of this checkout: [{path, branch, locked}]. */
export function listWorktrees(root) {
  const r = git(root, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; out.push(cur); }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('locked') && cur) cur.locked = line.slice(6).trim() || 'locked';
  }
  return out;
}

/** The attempt a worktree belongs to — its directory name, or the branch it has checked out. */
export function worktreeAttempt(w) {
  return attemptOf(path.basename(w.path || '')) || attemptOf(w.branch || '');
}

/**
 * Remove one worktree and the branch it had checked out.
 * Claude Code locks the worktrees it creates ("claude session kb-1-1 (pid N ...)"); the lock is
 * lifted only once that pid is gone, so a live session is never swept out from under itself.
 * @returns {{result:'removed'|'locked'|'failed', pid?:number, error?:string}}
 */
export function removeWorktree(root, w) {
  if (w.locked) {
    const pm = /pid (\d+)/.exec(w.locked);
    if (pm && pidAlive(Number(pm[1]))) return { result: 'locked', pid: Number(pm[1]) };
    git(root, ['worktree', 'unlock', w.path]);
  }
  const r = git(root, ['worktree', 'remove', '--force', w.path]);
  if (r.status !== 0) return { result: 'failed', error: lastLine(r.stderr) || `exit ${r.status}` };
  if (w.branch) git(root, ['branch', '-D', w.branch]);
  return { result: 'removed' };
}

/** Every local attempt branch: [{branch, n, k, checkedOut}]. `checkedOut` = a worktree still holds it. */
export function listBranches(root) {
  const r = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (r.status !== 0) return [];
  const held = new Set(listWorktrees(root).map((w) => w.branch).filter(Boolean));
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const branch = line.trim();
    const at = attemptOf(branch);
    if (at) out.push({ branch, ...at, checkedOut: held.has(branch) });
  }
  return out;
}

/** What "already merged" is measured against: the default branch, as this clone has it. */
export function baseRefs(root, cfg) {
  const branch = cfg?.default_branch || 'main';
  const remote = cfg?.remote || 'origin';
  return [branch, `refs/remotes/${remote}/${branch}`]
    .filter((ref) => git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0);
}

/** Is `branch` contained in one of `bases`? A squash-merged branch is not — the task status is. */
export function isMerged(root, branch, bases) {
  return (bases || []).some((base) => git(root, ['merge-base', '--is-ancestor', branch, base]).status === 0);
}

// ---------- the sweeps ----------
// Each takes `yes` (destructive steps only with it), `only` (one task, for the tick's incremental
// pass), and `quiet` (skip/failure lines suppressed — the tick retries them next pass anyway).

/**
 * Worktrees of finished attempts, and the branch each had checked out.
 * `finished(n, k)` decides; nothing else is touched.
 */
export function sweepWorktrees(ctx, { finished, only = null, yes = false, quiet = false, label = () => '', log = () => {} } = {}) {
  const stats = { removed: 0, pending: 0, skipped: 0, failed: 0 };
  for (const w of listWorktrees(ctx.root)) {
    const at = worktreeAttempt(w);
    if (!at) continue;
    if (only != null && at.n !== only) continue;
    if (!finished(at.n, at.k)) continue;
    if (!yes) { stats.pending++; log(`would remove worktree ${w.path} (${label(at.n, at.k)}) — pass --yes`); continue; }
    const r = removeWorktree(ctx.root, w);
    if (r.result === 'removed') { stats.removed++; log(`removed worktree ${w.path}`); }
    else if (r.result === 'locked') { stats.skipped++; if (!quiet) log(`skip ${w.path}: still locked by a live session (pid ${r.pid})`); }
    else { stats.failed++; if (!quiet) log(`failed to remove ${w.path}: ${r.error}`); }
  }
  if (yes) git(ctx.root, ['worktree', 'prune']);
  return stats;
}

/**
 * Attempt branches no worktree holds any more: a finished task's (its worktree is gone, or never
 * existed on this host), and any that is already an ancestor of the default branch — that one
 * carries no work a merge has not taken, whatever the task is doing.
 */
export function sweepBranches(ctx, { finished = () => false, keep = [], only = null, yes = false, quiet = false, log = () => {} } = {}) {
  const stats = { removed: 0, pending: 0, skipped: 0 };
  const kept = new Set((keep || []).map(Number)); // attempts of `only` that must survive, merged or not
  const bases = baseRefs(ctx.root, ctx.cfg);
  for (const b of listBranches(ctx.root)) {
    if (only != null && b.n !== only) continue;
    if (kept.has(b.k)) continue;
    if (b.checkedOut) continue; // a worktree still holds it; sweepWorktrees decides that one
    const why = finished(b.n, b.k) ? `task #${b.n} is finished` : isMerged(ctx.root, b.branch, bases) ? 'already merged into the default branch' : null;
    if (!why) continue;
    if (!yes) { stats.pending++; log(`would delete branch ${b.branch} (${why}) — pass --yes`); continue; }
    const r = git(ctx.root, ['branch', '-D', b.branch]);
    if (r.status === 0) { stats.removed++; log(`deleted branch ${b.branch} (${why})`); }
    else { stats.skipped++; if (!quiet) log(`failed to delete branch ${b.branch}: ${lastLine(r.stderr)}`); }
  }
  return stats;
}

/**
 * Older copies of the `<!-- kb-run -->` record, kept when two writers raced.
 * A task can only grow one while something writes to it, so a task whose issue has not been updated
 * since the last sweep is not read at all: `memo` is `{ "<n>": updatedAt }`, mutated in place, and
 * the caller decides where it lives. That is what makes this sweep affordable on every tick.
 */
export async function sweepRunComments(ctx, tasks, { yes = false, memo = null, log = () => {} } = {}) {
  let deleted = 0;
  for (const t of tasks) {
    if (memo && t.updatedAt && memo[t.number] === t.updatedAt) continue;
    const rec = await loadRun(ctx, t.number);
    let clean = true;
    for (const id of rec.duplicates || []) {
      if (!yes) { clean = false; log(`would delete duplicate run comment ${id} on #${t.number} — pass --yes`); continue; }
      if (await deleteComment(ctx, t.number, id)) { deleted++; log(`deleted duplicate run comment ${id} on #${t.number}`); }
      else clean = false; // still there: look again next sweep
    }
    if (memo && clean && t.updatedAt) memo[t.number] = t.updatedAt;
  }
  if (memo) { const on = new Set(tasks.map((t) => String(t.number))); for (const k of Object.keys(memo)) if (!on.has(k)) delete memo[k]; }
  return deleted;
}

/**
 * Local mirrors of lock refs GitHub no longer has: an attempt that ended without its worker
 * (reclaimed, crashed) leaves one behind, and every worktree shares this ref store.
 */
export async function sweepBeatChains(ctx, { only = null, yes = false, log = () => {} } = {}) {
  const live = new Set((await listLocks(ctx)).map((l) => `${l.n}/${l.k}`));
  let dropped = 0;
  for (const c of listBeatChains(ctx.root)) {
    if (only != null && c.n !== only) continue;
    if (live.has(`${c.n}/${c.k}`)) continue;
    if (!yes) { log(`would drop the local beat chain ${c.ref} (attempt #${c.n}/${c.k} is over) — pass --yes`); continue; }
    if (dropBeatChain(ctx.root, c.n, c.k)) { dropped++; log(`dropped local ref ${c.ref}`); }
  }
  return dropped;
}

/** Logs and nudges older than the retention window. */
export function sweepFiles(ctx, { days = 14, yes = false, log = () => {} } = {}) {
  let pruned = 0;
  if (!Number.isFinite(days) || days < 0) return pruned; // a broken retention must never mean "delete everything"
  const cutoff = Date.now() - days * 86400_000;
  for (const dir of [logsDir(ctx.root), path.join(kanbanDir(ctx.root), 'nudges')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(p); } catch { continue; }
      if (stat.mtimeMs >= cutoff) continue;
      if (!yes) { log(`would prune ${path.relative(ctx.root, p)} (older than ${days}d) — pass --yes`); continue; }
      try { fs.rmSync(p, { recursive: true }); pruned++; } catch { /* held open elsewhere: next sweep */ }
    }
  }
  return pruned;
}

// ---------- the two entry points ----------

/**
 * Everything task #n left on this host, minus the attempts in `keep` (an open one, never swept).
 * Local only — no API call — so the tick can run it the moment a task leaves the open board.
 * Failures (a worktree a live session still holds) are silent and counted in `pending`: the caller
 * asks again next pass, which is how a session that outlives its task still gets cleaned up.
 */
export function sweepTask(ctx, n, { keep = [], log = () => {} } = {}) {
  const kept = new Set((keep || []).map(Number));
  const finished = (num, k) => num === n && !kept.has(k);
  const opts = { finished, keep, only: n, yes: true, quiet: true };
  const wt = sweepWorktrees(ctx, opts);
  const br = sweepBranches(ctx, opts);
  let chains = 0;
  for (const c of listBeatChains(ctx.root)) if (c.n === n && !kept.has(c.k) && dropBeatChain(ctx.root, c.n, c.k)) chains++;
  const out = { worktrees: wt.removed, branches: br.removed, chains, pending: wt.skipped + wt.failed + br.skipped };
  if (out.worktrees || out.branches) log(`#${n}: cleaned up ${out.worktrees} worktree(s), ${out.branches} branch(es)`);
  return out;
}

/**
 * The full sweep: one board read, then every sweep in order (worktrees first, so the branch sweep
 * only sees what is left). This is what both `hkb gc --yes` and the dispatcher tick run.
 * `memo` is the caller's `{ "<n>": updatedAt }` of tasks already scanned for duplicate run comments
 * — the dispatcher passes the one in `.kanban/state.json`, so a tick that sweeps a quiet board reads
 * no issue at all; a human running `hkb gc` passes none and gets the thorough pass.
 * @returns stats, for `--json` and for the tick summary
 */
export async function sweep(ctx, { yes = false, days = 14, memo = null, log = () => {} } = {}) {
  ctx.requireBoard();
  const tasks = await fetchBoard(ctx, { includeClosed: true });
  const byNumber = new Map(tasks.map((t) => [t.number, t]));
  const settled = (t) => ['done', 'archived'].includes(t.status) || t.state === 'CLOSED';
  // A worktree named after a task this board has never heard of is scrap either way. A *branch* of
  // one is not: another board in the same repo names its attempts the same, so that one has to
  // earn its deletion by being merged.
  const finished = (n) => { const t = byNumber.get(n); return !t || settled(t); };
  const finishedHere = (n) => { const t = byNumber.get(n); return !!t && settled(t); };
  const label = (n) => `task #${n} ${byNumber.get(n)?.status || 'not on board'}`;
  const stats = { worktrees: 0, branches: 0, comments: 0, chains: 0, files: 0, pending: 0, skipped: 0, days, applied: !!yes };

  const wt = sweepWorktrees(ctx, { finished, yes, label, log });
  const br = sweepBranches(ctx, { finished: finishedHere, yes, log });
  stats.worktrees = wt.removed;
  stats.branches = br.removed;
  stats.pending = wt.pending + br.pending;
  stats.skipped = wt.skipped + wt.failed + br.skipped;

  try { stats.comments = await sweepRunComments(ctx, tasks, { yes, memo: yes ? memo : null, log }); } catch (e) { log(`duplicate run comments skipped: ${e.message}`); }
  try { stats.chains = await sweepBeatChains(ctx, { yes, log }); } catch (e) { log(`beat chains skipped: ${e.message}`); }
  stats.files = sweepFiles(ctx, { days, yes, log });
  return stats;
}

export async function gc(ctx, flags, log) {
  const raw = flags['log-retention-days'];
  const days = raw === undefined || raw === true ? 14 : Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    const e = new Error(`--log-retention-days takes a number of days (got "${raw}"). Try \`hkb gc --yes --log-retention-days 14\`.`);
    e.exitCode = 2;
    throw e;
  }
  const stats = await sweep(ctx, { yes: !!flags.yes, days, log });
  if (ctx.json) process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  else if (!stats.applied) log(`gc: nothing done — ${stats.pending} worktree/branch(es) and everything listed above would go. Re-run with --yes.`);
  else log(`gc: ${stats.worktrees} worktree(s) removed, ${stats.branches} branch(es) deleted, ${stats.comments} duplicate run comment(s) deleted, ${stats.chains} local beat chain(s) dropped, ${stats.files} old file(s) pruned (retention ${stats.days}d)`);
  return 0;
}
