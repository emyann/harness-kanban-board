// `hkb gc` — the cleanup sweeps: worktrees and branches of finished attempts, duplicate run
// comments, dead local beat chains, old logs and nudges. Destructive steps need --yes.
//
// Every sweep is a callable function because the dispatcher runs the same ones (src/dispatch.js):
// `sweepTask` the moment a task leaves the open board, and `sweep` — exactly what `hkb gc --yes`
// runs — every `dispatch.gc_every_ticks`. Manual and automatic cleanup can never diverge.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// Two of the sweeps below are about how the *GitHub* store keeps a board and mean nothing on any
// other (`sweepOpen` skips them outright when `storeKind(ctx) !== 'github'`): a run record kept as a
// comment can have duplicates, and a ref-CAS heartbeat leaves a local mirror behind. They call that
// driver by name for exactly that reason — routing a GitHub-only sweep through `openStore` would put
// a method on the interface that only one driver could ever mean anything by — and they go when it
// does (docs/local-first.md §7, C2). The beat-chain refs are also swept unconditionally in
// `sweepTask`, where they are simply refs this checkout may hold and finding none is the answer.
import { loadRun, deleteComment, listLocks, listBeatChains, dropBeatChain } from './store/github.js';
import { listTrackBranches, deleteTrackBranch } from './forge.js';
import { logsDir, kanbanDir } from './board.js';
import { storeKind, openStore } from './store/index.js';

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
    if (line.startsWith('worktree ')) { cur = /** @type {{path: string, branch?: string, locked?: string}} */ ({ path: line.slice(9) }); out.push(cur); }
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
 * The node a track's fanned-out subagent worktree belongs to. Its directory is `agent-<id>` — the
 * harness's own name, not hkb's — so nothing about the checkout says which task it is; the branch
 * does: a subagent that committed is on `kb/<n>` (`src/track.js`'s per-node brief). No attempt number
 * comes with it, so this is a second, narrower recognizer alongside `attemptOf` rather than a case of it.
 * @returns {{n:number, branch:string}|null}
 */
export function agentWorktreeNode(w) {
  if (!/^agent-/.test(path.basename(w.path || ''))) return null;
  const m = /^kb\/(\d+)$/.exec(String(w.branch || '').trim());
  return m ? { n: Number(m[1]), branch: w.branch } : null;
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
/**
 * @param {any} ctx
 * @param {{finished?: (n: number, k?: number) => boolean, only?: any, yes?: boolean, quiet?: boolean, label?: (n: number, k?: number) => string, log?: (...a: any[]) => void}} [opts]
 */
export function sweepWorktrees(ctx, { finished, only = null, yes = false, quiet = false, label = /** @type {(n: number) => string} */ (() => ''), log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
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
 * `agent-<id>` worktrees a track's fanned-out subagent left behind — recognised by `agentWorktreeNode`,
 * not `attemptOf`: a subagent that only read and returned is already gone (`docs/wiki/features/tracks.md`),
 * but one that committed keeps its worktree on `kb/<n>` until something notices its PR is done. `prByBranch`
 * answers that per node — a merged or closed PR means the branch's work is either landed or abandoned, so
 * the checkout has nothing left to protect; an open PR, or none yet, is still someone's in-flight work.
 */
/**
 * @param {any} ctx
 * @param {{prByBranch?: any, only?: any, yes?: boolean, quiet?: boolean, log?: (...a: any[]) => void}} [opts]
 */
export function sweepAgentWorktrees(ctx, { prByBranch, only = null, yes = false, quiet = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  const stats = { removed: 0, pending: 0, skipped: 0, failed: 0 };
  for (const w of listWorktrees(ctx.root)) {
    const at = agentWorktreeNode(w);
    if (!at) continue;
    if (only != null && at.n !== only) continue;
    const pr = prByBranch(at.n, at.branch);
    if (!pr || !['MERGED', 'CLOSED'].includes(pr.state)) continue;
    if (!yes) { stats.pending++; log(`would remove worktree ${w.path} (#${at.n}'s PR is ${pr.state.toLowerCase()}) — pass --yes`); continue; }
    const r = removeWorktree(ctx.root, w);
    if (r.result === 'removed') { stats.removed++; log(`removed worktree ${w.path} (#${at.n}'s PR is ${pr.state.toLowerCase()})`); }
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
export function sweepBranches(ctx, { finished = /** @type {(n: number, k?: number) => boolean} */ (() => false), keep = [], only = null, yes = false, quiet = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
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
 * Track branches (`kb/track-<root>`) whose root is settled — done or archived. Unlike every other
 * sweep here, the branch lives on GitHub, not this checkout, because `ensureTrackBranch` creates it
 * through the API rather than a local push (`src/lock.js`); this is the one sweep in the file that
 * costs a request instead of a `git` call. A root that is still open is never touched here even if
 * its last track attempt already ended without merging — that is `hkb doctor`'s `checkTrackBranches`
 * to flag, not this sweep's to delete, because the branch may still hold work a human wants back.
 */
export async function sweepTrackBranches(ctx, { finished = /** @type {(n: number, k?: number) => boolean} */ (() => false), yes = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  const stats = { removed: 0, pending: 0, skipped: 0 };
  let rows;
  try { rows = await listTrackBranches(ctx); } catch (e) { log(`track branches skipped: ${e.message}`); return stats; }
  for (const { branch, root } of rows) {
    if (!finished(root)) continue;
    if (!yes) { stats.pending++; log(`would delete track branch ${branch} (#${root} is settled) — pass --yes`); continue; }
    try {
      const removed = await deleteTrackBranch(ctx, root);
      if (removed) { stats.removed++; log(`deleted track branch ${branch} (#${root} is settled)`); }
    } catch (e) { stats.skipped++; log(`failed to delete track branch ${branch}: ${e.message}`); }
  }
  return stats;
}

/**
 * Older copies of the `<!-- kb-run -->` record, kept when two writers raced.
 * A task can only grow one while something writes to it, so a task whose issue has not been updated
 * since the last sweep is not read at all: `memo` is `{ "<n>": updatedAt }`, mutated in place, and
 * the caller decides where it lives. That is what makes this sweep affordable on every tick.
 */
export async function sweepRunComments(ctx, tasks, { yes = false, memo = null, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
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
export async function sweepBeatChains(ctx, { only = null, yes = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
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
export function sweepFiles(ctx, { days = 14, yes = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
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
export function sweepTask(ctx, n, { keep = [], log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  const kept = new Set((keep || []).map(Number));
  const finished = (num, k) => num === n && !kept.has(k);
  const opts = { finished, keep, only: n, yes: true, quiet: true };
  const wt = sweepWorktrees(ctx, opts);
  // #n itself has just left the open board — settled either way — so an `agent-<id>` worktree a
  // subagent left on `kb/<n>` is scrap now regardless of what its PR says: no `keep` applies, since
  // these carry no attempt number to keep.
  const aw = sweepAgentWorktrees(ctx, { prByBranch: () => ({ state: 'MERGED' }), only: n, yes: true, quiet: true, log });
  const br = sweepBranches(ctx, opts);
  let chains = 0;
  for (const c of listBeatChains(ctx.root)) if (c.n === n && !kept.has(c.k) && dropBeatChain(ctx.root, c.n, c.k)) chains++;
  const out = { worktrees: wt.removed + aw.removed, branches: br.removed, chains, pending: wt.skipped + wt.failed + aw.skipped + aw.failed + br.skipped };
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
export async function sweep(ctx, { yes = false, days = 14, memo = null, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  ctx.requireBoard();
  // The store is chosen *before* the board is read, not after. `fetchBoard` is the GitHub driver's
  // read, and calling it unconditionally meant a genuinely local board — one with no issues behind
  // it at all — threw here, several sweeps before the `stats.store` branch below could skip
  // anything. The skip message was therefore only ever reachable on a board that was also on
  // GitHub, which is the one board that did not need it.
  const kind = storeKind(ctx);
  // **This sweep no longer owns the handle, and must not close it.** The leak it used to guard
  // against — the local driver's SQLite connection, its WAL and its shm, one per tick because the
  // dispatcher runs this every `gc_every_ticks`, until the process hit its file-descriptor limit —
  // is now fixed one level up: `openStore(ctx)` hands back a single handle per context, so a
  // thousand ticks hold one. Closing it here would close the *loop's* store mid-tick and leave the
  // slot pointing at a dead connection. The owner closes it: `loop()`'s `finally` for the
  // dispatcher, `main()`'s for `hkb gc` run by hand.
  const store = await openStore(ctx);
  return sweepOpen(ctx, store, kind, { yes, days, memo, log });
}

/**
 * The sweep itself, with the store already open. Kept separate from `sweep()` so a caller that has
 * a store in hand — the dispatcher's end-of-tick pass — can run it without opening a second one.
 * @param {any} ctx @param {any} store @param {string} kind
 * @param {{yes: boolean, days: number, memo: any, log: (...a: any[]) => void}} opts
 */
async function sweepOpen(ctx, store, kind, { yes, days, memo, log }) {
  // `blockers: false` — no sweep here reads a dependency, and on a repo without the GraphQL field
  // filling them in is one REST call per card.
  const tasks = await store.listTasks({ states: ['OPEN', 'CLOSED'], blockers: false });
  const byNumber = new Map(tasks.map((t) => [t.number, t]));
  // **A board that returned nothing is a board that could not be read, not a board where everything
  // is done.** Every sweep below decides from `byNumber`, and a card that is not in it counts as
  // finished — which is right for one missing card and catastrophic for all of them: an empty read
  // made `finished(n)` true for every worker's worktree, and `sweep(ctx, {yes: true})` runs
  // unattended from the dispatcher every `gc_every_ticks`, so `git worktree remove --force` plus
  // `git branch -D` took uncommitted work with nobody typing `--yes`. It was reachable through a
  // store that read the wrong place, and it stays reachable through a `gh` that answers `[]`, a
  // board slug typo, or a branch a fetch has not brought in yet. So: no cards, no sweep. A board
  // that is genuinely empty has no worktrees to remove either, which is why this costs nothing.
  const empty = !tasks.length;
  if (empty) {
    log('gc: the board came back with no cards at all — nothing is swept. A board that returned nothing is a board that could not be read, '
      + 'not one where every card is done; `hkb list --all` and `hkb doctor` say which.');
  }
  const settled = (t) => ['done', 'archived'].includes(t.status) || t.state === 'CLOSED';
  // A worktree named after a task this board has never heard of is scrap either way. A *branch* of
  // one is not: another board in the same repo names its attempts the same, so that one has to
  // earn its deletion by being merged.
  const finished = (n) => { const t = byNumber.get(n); return !t || settled(t); };
  const finishedHere = (n) => { const t = byNumber.get(n); return !!t && settled(t); };
  const label = (n) => `task #${n} ${byNumber.get(n)?.status || 'not on board'}`;
  const stats = { worktrees: 0, branches: 0, track_branches: 0, comments: 0, chains: 0, files: 0, pending: 0, skipped: 0, days, applied: !!yes, store: kind, empty_board: empty };

  const none = () => ({ removed: 0, pending: 0, skipped: 0, failed: 0 });
  const wt = empty ? none() : sweepWorktrees(ctx, { finished, yes, label, log });

  // The **rule** the two sweeps below share with the two at the bottom of this function: a sweep
  // whose answer comes from GitHub is either skipped on a local board or it says why it found
  // nothing. What is not allowed is running structurally empty and reporting `0` as a result.
  //
  // A track branch lives on the forge and is listed with a `gh api` call; a local board has none of
  // its own, so that call is a request per gc — and per `gc_every_ticks` tick — for an answer that
  // can only be empty, plus a "skipped" line from its own catch on a checkout with no repo behind it.
  const tb = kind === 'local' || empty ? none() : await sweepTrackBranches(ctx, { finished: finishedHere, yes, log });
  if (kind === 'local') log('track branches: not swept on a local board — a track branch lives on the forge and this board does not keep one');

  // The agent worktrees are the harder half and the honest answer is to say so. This sweep removes
  // an `agent-*` worktree once *its PR* is merged or closed, and on a local board `GitTier.toTask`
  // hands back `prs: []` for every card — pull requests are the forge's and the forge is not the
  // store (§6.4). So `prByBranch` was always null, every worktree was skipped, and `hkb gc --yes`
  // reported `0 removed` on a checkout quietly accumulating them forever. Reporting nothing removed
  // as though nothing needed removing is the shape this whole review is about.
  const prByBranch = (n, branch) => (byNumber.get(n)?.prs || []).find((p) => p.headRefName === branch) || null;
  const aw = kind === 'local' || empty ? none() : sweepAgentWorktrees(ctx, { prByBranch, yes, log });
  if (kind === 'local') {
    const waiting = listWorktrees(ctx.root).filter((w) => agentWorktreeNode(w)).length;
    if (waiting) {
      log(`agent worktrees: ${waiting} not swept on a local board — this sweep removes one when its pull request is merged or closed, and a local card carries no pull request `
        + `(the forge is not the store). Remove them by hand with \`git -C ${ctx.root} worktree remove <path>\`, or track them on the forge and re-run gc there`);
    }
  }
  const br = empty ? none() : sweepBranches(ctx, { finished: finishedHere, yes, log });
  stats.worktrees = wt.removed + aw.removed;
  stats.branches = br.removed;
  stats.track_branches = tb.removed;
  stats.pending = wt.pending + aw.pending + br.pending + tb.pending;
  stats.skipped = wt.skipped + wt.failed + aw.skipped + aw.failed + br.skipped + tb.skipped;

  // Two sweeps that exist because of how the GitHub store keeps a board, and mean nothing once it
  // does not (docs/local-first.md §7): a run record is one file on the branch, so there is no second
  // comment to be a duplicate of, and a heartbeat is a row in the index, so there is no beat chain
  // to go stale. Skipped rather than run-and-find-nothing: both cost a listing per card.
  // `empty` is on this test for the same reason it is on the four above: `sweepRunComments` walks the
  // cards it was given, and a beat chain for a card the board did not return is exactly the "not on
  // the board, therefore scrap" judgement that must not be made from a read that came back with
  // nothing.
  if (empty) {
    log('duplicate run comments and beat chains: not swept — see above');
  } else if (stats.store === 'local') {
    log('duplicate run comments and beat chains: nothing to sweep on a local board — the run record is one file on the branch and a beat is a row in the index');
  } else {
    try { stats.comments = await sweepRunComments(ctx, tasks, { yes, memo: yes ? memo : null, log }); } catch (e) { log(`duplicate run comments skipped: ${e.message}`); }
    try { stats.chains = await sweepBeatChains(ctx, { yes, log }); } catch (e) { log(`beat chains skipped: ${e.message}`); }
  }
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
  else if (stats.store === 'local') log(`gc: ${stats.worktrees} worktree(s) removed, ${stats.branches} branch(es) deleted, ${stats.track_branches} track branch(es) deleted, ${stats.files} old file(s) pruned (retention ${stats.days}d)`);
  else log(`gc: ${stats.worktrees} worktree(s) removed, ${stats.branches} branch(es) deleted, ${stats.track_branches} track branch(es) deleted, ${stats.comments} duplicate run comment(s) deleted, ${stats.chains} local beat chain(s) dropped, ${stats.files} old file(s) pruned (retention ${stats.days}d)`);
  return 0;
}
