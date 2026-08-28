// The dispatcher: stateless, idempotent, deterministic. Never an LLM.
// Per tick: replay outbox → reclaim/crash/timeout → promote todo→ready → guards → claim + spawn.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchBoard, fetchClosedRecent, loadRun, saveRun, setStatus, addLabels, getTask, enableAutoMerge, branchProtection } from './tasks.js';
import { claim, release, listLocks, lockBeatAt, staleBaseSha, remoteName } from './lock.js';
import { logsDir, outboxFile, readState, writeState, ensureLocalDirs, ensureWorktree, worktreeOnBranch, pidFile, pidAlive, recordExit, clearExit } from './board.js';
import { activePrGuard, computeReady, openAttempt, lastAttempt, lastSignalAt, sortForDispatch, pathsOverlap, slugify, L, lockRef, classifyJob, parseBackgroundedId, parseSessionLog, sessionUpdate, formatSession, worktreePath, mergePolicy, autoMergeDecision, mergeGate, mergeGateFix } from './model.js';
import { workerContext } from './context.js';
import { planTracks, trackContext, trackPaths, trackAlreadyAttempted } from './track.js';
import { GhError } from './gh.js';
import { listKbJobs, readJobState, stopJob, matchJobByWorktree, jobSessionUpdate } from './jobs.js';
import { isMirrorConfigured, syncProject, projectError } from './projects.js';
import { tokenExpiryNotice, versionNotice } from './doctor.js';
import { sweep, sweepTask } from './gc.js';

const nowIso = () => new Date().toISOString();
const secondsSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 1000 : Infinity);

/** Ticks between full `hkb gc --yes` sweeps when board.json says nothing. 0 turns them off. */
export const GC_EVERY_TICKS = 30;

// `pidAlive` lives in board.js now, next to the pid files it answers about; re-exported here because
// this is where every caller has always imported it from.
export { pidAlive };

function killPid(pid) {
  if (!pidAlive(pid)) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  return true;
}

// ---------- outbox replay ----------

export function replayOutbox(ctx, log) {
  const file = outboxFile(ctx.root);
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return 0;
  const bin = fileURLToPath(new URL('../bin/hkb.js', import.meta.url));
  const remaining = [];
  let replayed = 0;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const res = spawnSync(process.execPath, [bin, ...entry.argv], { encoding: 'utf8', env: { ...process.env, KB_NO_OUTBOX: '1' } });
    if (res.status === 0) { replayed++; log(`outbox: replayed hkb ${entry.argv.join(' ')}`); }
    else { remaining.push(line); log(`outbox: still failing: hkb ${entry.argv.join(' ')} — ${(res.stderr || '').trim().split('\n').pop()}`); }
  }
  fs.writeFileSync(file, remaining.length ? remaining.join('\n') + '\n' : '');
  return replayed;
}

// ---------- worker spawn ----------

export function expandLaunch(template, vars, profile) {
  const out = [];
  for (const el of template) {
    if (el === '{allowed_tools}') { out.push(...(profile.allowed_tools || [])); continue; }
    // `--allow-tool={allowed_tools}` → one `--allow-tool <pattern>` pair per entry, for harnesses
    // that repeat the flag instead of taking a list (Copilot CLI).
    const perTool = /^(--[\w-]+)=\{allowed_tools\}$/.exec(el);
    if (perTool) { for (const t of profile.allowed_tools || []) out.push(perTool[1], t); continue; }
    if (el === '{model_args}') { if (vars.model) out.push('--model', vars.model); continue; }
    out.push(el.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')));
  }
  return out;
}

/**
 * Drop a harness's own worktree flag from an expanded launch. Claude Code's `--worktree kb-<n>-<k>`
 * asks it to make a checkout of its own, on a fresh branch; when the dispatcher has already made
 * that same checkout on a PR's branch and runs the harness inside it, a second one would put the
 * worker back where it must not be. Only `--worktree` goes — `codex exec -C {worktree}` names the
 * dispatcher's own directory and has to stay.
 */
export function withoutWorktreeFlag(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--worktree') { i++; continue; }
    if (String(argv[i]).startsWith('--worktree=')) continue;
    out.push(argv[i]);
  }
  return out;
}

/**
 * Launch one session for one attempt. `prompt` overrides the per-task worker context — a track
 * runner gets the whole subgraph's brief instead (see src/track.js); everything else about the
 * launch, the environment and the log is identical, because from here down a track *is* a worker.
 *
 * `continuePr` is the open PR this attempt must continue rather than duplicate (the card the
 * reviewer sent back with `hkb request-changes`; see `activePrGuard`). The dispatcher makes that
 * checkout itself, on the PR's head branch — every harness can be run in a directory, not all of
 * them can be told which branch to make one on — and takes the harness's own worktree flag off the
 * launch so there is one checkout, not two. When the branch cannot be had (still held by a live
 * session, no remote, gone) the attempt runs anyway, on an ordinary fresh worktree, and the brief
 * says which PR to continue and how: `continued` on the result records which of the two it was.
 */
export async function spawnWorker(ctx, task, profileName, attempt, { dryRun = false, keepRef = false, prompt: given = null, continuePr = null } = {}) {
  const profile = ctx.cfg.profiles[profileName];
  if (!profile?.launch) throw new Error(`profile "${profileName}" has no launch template in board.json`);
  const name = `kb-${task.number}-${attempt}`;
  const cont = !continuePr
    ? null
    : dryRun
      ? { ok: !!continuePr.headRefName, branch: continuePr.headRefName || null, dry: true, why: 'the board query returned no head branch for the PR' } // a dry run creates nothing, and prints the command it would run
      : worktreeOnBranch(ctx.root, name, continuePr.headRefName, { number: task.number, remote: remoteName(ctx), alive: pidAlive });
  const prompt = given ?? (await workerContext(ctx, task, attempt, {
    continuePr: continuePr && { number: continuePr.number, branch: continuePr.headRefName || null, base: continuePr.baseRefName || null, checkedOut: !!cont?.ok },
  }));
  // Harnesses without a worktree flag (Copilot CLI, Codex) declare `workspace: "worktree"`; the
  // dispatcher makes the checkout and runs them in it. Everything else runs at the board root and
  // isolates itself — unless this attempt continues a PR, where the dispatcher owns the checkout for
  // every harness. `{worktree}` is that directory as an absolute path, for a harness that wants it
  // as an argument too (`codex exec -C <dir>`) — known before the checkout exists, so `--dry-run`
  // prints the real command without creating anything.
  const ownsWt = profile.workspace === 'worktree';
  const wt = ownsWt || cont?.ok ? name : null;
  const vars = { n: task.number, k: attempt, slug: slugify(task.title), title: task.title.replace(/[\r\n]+/g, ' ').slice(0, 80), model: task.kb.model || profile.model || '', prompt, board: ctx.board, repo: ctx.repo.nameWithOwner, worktree: wt ? path.join(ctx.root, worktreePath(wt)) : ctx.root };
  const argv = cont?.ok && !ownsWt ? withoutWorktreeFlag(expandLaunch(profile.launch, vars, profile)) : expandLaunch(profile.launch, vars, profile);
  const continued = cont && { pr: continuePr.number, branch: cont.ok ? cont.branch : null, why: cont.ok ? null : cont.why };
  const env = {
    ...process.env,
    KB_TASK: String(task.number), KB_ATTEMPT: String(attempt), KB_BOARD: ctx.board, KB_REPO: ctx.repo.nameWithOwner,
    KB_LOCK_REF: lockRef(task.number, attempt), KB_ROOT: ctx.root, KB_PROFILE: profileName,
  };
  if (dryRun) return { argv, pid: null, continued };
  ensureLocalDirs(ctx.root);
  const cwd = wt ? ensureWorktree(ctx.root, wt) : ctx.root;
  const logFile = path.join(logsDir(ctx.root), `${task.number}-${attempt}.log`);
  if (profile.mode === 'trigger') {
    // The launch does not run the worker — it asks something else to (an Actions run, a cloud agent)
    // and exits. Run it to completion so a refusal is a spawn failure the caller can report, then
    // record the attempt as `remote`: there is no local pid or job, so the heartbeat and max_runtime
    // are its whole liveness check.
    const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    fs.appendFileSync(logFile, `# ${nowIso()} trigger ${argv.join(' ')}\n${out}\n`);
    if (r.error || r.status !== 0) throw new Error(`${argv[0]}: ${(r.error?.message || out || `exit ${r.status}`).split('\n').filter(Boolean).pop()}`);
    return { argv, pid: null, remote: true, logFile, continued };
  }
  if (profile.mode === 'claude-bg') {
    // Fire-and-forget: `claude --bg` prints "backgrounded · <id>" and exits, but a cold daemon
    // start can take a minute — never block the tick on it. Detach, log its output, and identify
    // the running job by its worktree on the next tick (cwd basename == kb-<n>-<k>).
    fs.appendFileSync(logFile, `# ${nowIso()} launch background agent for #${task.number} attempt ${attempt}\n`);
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => { /* surfaced next tick as crashed if the job never registers */ });
    fs.closeSync(fd);
    child.unref();
    return { argv, pid: null, bg: true, wt: name, logFile, continued };
  }
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `# ${nowIso()} spawn ${argv[0]} for #${task.number} attempt ${attempt}${wt ? ` in ${worktreePath(wt)}` : ''}\n`);
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', () => { /* handled via exit code below */ });
  fs.closeSync(fd); // the child holds its own copy
  if (!keepRef) child.unref(); // one-shot dispatch must not wait for the worker
  return { argv, pid: child.pid, child, wt, logFile, continued };
}

// ---------- reconcile closed issues ----------
// `Closes #n` in a merged PR closes the issue behind the dispatcher's back: it drops out of the
// open-board query still wearing kb:status:review. The label has to follow the state.

/** Live statuses — an issue closed while wearing one of these is out of sync with GitHub. */
export const RECONCILE_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review'];

/**
 * What a closed issue should become. Pure: `null` means "nothing to do".
 * Closed as completed → done; closed as not planned (or duplicate) → archived, same
 * reading of stateReason as `blockerDone`.
 */
export function reconcileDecision(task) {
  if (!task || String(task.state || '').toUpperCase() !== 'CLOSED') return null;
  if (!RECONCILE_STATUSES.includes(task.status)) return null;
  const reason = String(task.stateReason || task.state_reason || '').toUpperCase();
  if (reason === 'NOT_PLANNED' || reason === 'DUPLICATE') {
    return { status: 'archived', outcome: 'blocked', reason: `issue closed as ${reason.toLowerCase().replace('_', ' ')}` };
  }
  return { status: 'done', outcome: 'completed', reason: 'issue closed as completed' };
}

/**
 * Close the open attempt of a reconciled issue. Pure: mutates `run` in place and returns the
 * attempt it closed, or null when nothing was open — the normal case, where the worker already
 * finished with `complete`/`request-review` and only the label lagged behind.
 */
export function closeAttemptForReconcile(run, decision, at) {
  const a = openAttempt(run);
  if (!a) return null;
  a.ended_at = at;
  a.outcome = decision.outcome;
  a.reason = decision.reason;
  return a;
}

/** Cheap fingerprint of the open board: anything that changes it means "look again". */
export function boardSignature(tasks) {
  const list = tasks || [];
  let max = '';
  for (const t of list) if (t.updatedAt && t.updatedAt > max) max = t.updatedAt;
  return `${list.length}:${max}`;
}

/**
 * Gate for the extra query, so a quiet board costs nothing. Pure.
 * Look again when something could plausibly have closed: a task is in flight (review/running),
 * the last look found work, the board moved since then, or we have never looked.
 */
export function shouldReconcile(tasks, cache) {
  if ((tasks || []).some((t) => t.status === 'review' || t.status === 'running')) return { run: true, why: 'review/running tasks in flight' };
  if (!cache || !cache.checked_at) return { run: true, why: 'no cached reconcile state' };
  if (cache.found) return { run: true, why: 'the last check reconciled something' };
  if (cache.signature !== boardSignature(tasks)) return { run: true, why: 'the board changed since the last check' };
  return { run: false, why: 'nothing in flight and the board has not moved' };
}

async function reconcileClosed(ctx, tasks, state, { dryRun = false, log = () => {} } = {}) {
  const gate = shouldReconcile(tasks, state.reconcile);
  if (!gate.run) return { skipped: gate.why, reconciled: [] };
  // Capped at one page: a backlog larger than that drains a page per tick, because a tick
  // that found something always makes the next one look again.
  const closed = await fetchClosedRecent(ctx);
  const reconciled = [];
  for (const t of closed) {
    const d = reconcileDecision(t);
    if (!d) continue;
    if (dryRun) { reconciled.push({ number: t.number, from: t.status, status: d.status, dry: true }); log(`#${t.number}: [dry-run] ${t.status} → ${d.status} (${d.reason})`); continue; }
    const from = t.status;
    const runRec = await loadRun(ctx, t.number);
    const a = closeAttemptForReconcile(runRec.run, d, nowIso());
    if (a) {
      await saveRun(ctx, t.number, runRec);
      await release(ctx, t.number, a.attempt);
    }
    await setStatus(ctx, t, d.status, { remove: t.needsHuman ? [L.needsHuman] : [] });
    const entry = { number: t.number, from, status: d.status, outcome: d.outcome, attempt: a?.attempt ?? null };
    // The task is over, so its worktrees go — except one whose worker is somehow still alive here.
    if (a && a.host === ctx.host && a.pid && pidAlive(a.pid)) entry.keep = [a.attempt];
    reconciled.push(entry);
    log(`#${t.number}: ${from} → ${d.status} (${d.reason}${a ? `, attempt ${a.attempt} → ${d.outcome}` : ''})`);
  }
  if (!dryRun) state.reconcile = { checked_at: nowIso(), signature: boardSignature(tasks), found: reconciled.length };
  return { skipped: null, reconciled };
}

// ---------- the last step: GitHub's auto-merge ----------

/**
 * The merge gate for one base branch, read at most once per tick and only when there is actually a
 * PR to enable. A board on the default `manual` never gets here, so it costs nothing.
 */
async function gateFor(ctx, branch) {
  const cache = (ctx._cache.mergeGate ||= new Map());
  if (!cache.has(branch)) {
    try {
      cache.set(branch, mergeGate(await branchProtection(ctx, branch), branch));
    } catch (e) {
      cache.set(branch, { ok: false, detail: `${branch}'s protection could not be read: ${e.message}`, fix: mergeGateFix(branch) });
    }
  }
  return cache.get(branch);
}

/**
 * Hand the last step to GitHub, when the board says so (`dispatch.merge.mode: "auto"`).
 * One `enablePullRequestAutoMerge` per PR, at review time — GitHub does the rest: required checks,
 * required reviews and up-to-date branches are its gates to enforce, and hkb never has to answer
 * "is this safe to merge". A PR whose checks fail simply never merges, so there is nothing here to
 * poll, retry or reconcile. Runs after the claim loop so it sees the cards the `active_pr` guard
 * moved to review this same tick (`setStatus` mutates the task objects in place).
 *
 * The refusal is the point of the feature: auto-merge on an unprotected branch merges *immediately*,
 * which would mean landing agent-authored code unreviewed and untested. So a branch without a gate
 * is never enabled — it is reported, every tick, with the fix.
 */
export async function autoMergePass(ctx, tasks, { dryRun = false, log = () => {} } = {}) {
  const policy = mergePolicy(ctx.cfg);
  const out = [];
  if (policy.error) { log(`dispatch.merge ignored — the last step stays manual: ${policy.error}`); return out; }
  if (!policy.auto) return out;
  for (const t of tasks) {
    const d = autoMergeDecision(t, policy);
    if (!d.enable) continue;
    const branch = d.pr.baseRefName || ctx.cfg.default_branch || 'main';
    const gate = await gateFor(ctx, branch);
    if (!gate.ok) {
      out.push({ number: t.number, pr: d.pr.number, base: branch, ok: false, why: gate.detail, fix: gate.fix });
      log(`#${t.number}: auto-merge refused on PR #${d.pr.number}: ${gate.detail} → ${gate.fix}`);
      continue;
    }
    if (dryRun) { out.push({ number: t.number, pr: d.pr.number, base: branch, method: policy.method, ok: true, dry: true }); log(`#${t.number}: [dry-run] would enable auto-merge (${policy.method}) on PR #${d.pr.number}`); continue; }
    try {
      await enableAutoMerge(ctx, d.pr, policy.mergeMethod);
      out.push({ number: t.number, pr: d.pr.number, base: branch, method: policy.method, ok: true });
      log(`#${t.number}: auto-merge (${policy.method}) enabled on PR #${d.pr.number} — ${gate.detail}`);
    } catch (e) {
      out.push({ number: t.number, pr: d.pr.number, base: branch, ok: false, error: e.message });
      log(`#${t.number}: could not enable auto-merge on PR #${d.pr.number}: ${e.message}`);
    }
  }
  return out;
}

// ---------- reaping background agents ----------

/** An agent that is really taking its turn — not parked on a permission prompt. */
const jobWorking = (job) => job?.state === 'working' || job?.status === 'busy';

/** Statuses that mean the board is finished with the card, so nothing can be waiting for it. */
const FINISHED_STATUSES = ['done', 'archived'];

/**
 * Should the tick `claude stop` this background job? Pure. `task` is the job's card as the open
 * board read returned it, or null when its number is not on the board at all — a closed issue.
 * Returns why, or null to leave the job running.
 *
 * `jobAlive()` counts blocked/waiting as alive, because an agent sitting on a permission prompt is
 * a live worker (treating it as finished killed #14/2 and #3/2) — but that only holds while its
 * card is RUNNING. Once the card is closed, done or archived, nobody is ever going to answer that
 * prompt: kb #17 and #21 sat blocked for 15 hours after their PRs merged. So a finished card's
 * agent is stopped whatever it claims to be doing, a running card's agent belongs to the reclaim
 * step (which knows blocked means alive), and on any other live status the agent is spared only
 * while it is genuinely working — a worker that has just filed its terminal verb is still writing
 * its last turn, and must not be cut off mid-push.
 */
export function reapDecision(job, task) {
  if (!job || !job.pid) return null; // already gone: nothing to stop
  if (!task) return 'its task is closed';
  if (FINISHED_STATUSES.includes(task.status)) return `its task is ${task.status}`;
  if (task.status === 'running') return null; // the reclaim above owns a running card's agent
  if (jobWorking(job)) return null;
  return `its task is ${task.status || 'off the board'} and the agent is not working`;
}

// ---------- self-heal ----------
// `unknown` says nothing about the lock, so the tick backs off and retries. That is right for one
// tick and an outage when it never ends: on 2026-08-27 a 90-minute-old loop got 404 on every claim
// POST while a process started beside it claimed the same task at once — something in *that*
// process had rotted (a base sha the API no longer knew, a captured credential; it died before it
// could be autopsied). Hence the ladder: back off, then forget everything this process memoized,
// then remove the process loudly so a supervisor starts a clean one. A live loop doing nothing is
// the only failure nobody notices.

/** Consecutive unknown claims for one task: drop every cache at 3, give the process up at 6. */
export const SELF_HEAL = { dropAfter: 3, giveUpAfter: 6 };

/** Upstream conditions where waiting is the fix and a restart makes it worse: never escalated. */
const EXCUSED_KINDS = new Set(['ratelimit', 'network']);

/**
 * Record one claim outcome in the per-process health map (a Map keyed by issue number) and say what
 * the tick owes the operator. Pure apart from `health`; the map is per process on purpose — the
 * whole hypothesis is that a *fresh* process is fine, so this must never be persisted to the board.
 * @returns {{action:'none'|'drop_caches'|'exit', streak:number, error:string|null}}
 */
export function noteClaimResult(health, number, c, { dropAfter = SELF_HEAL.dropAfter, giveUpAfter = SELF_HEAL.giveUpAfter } = {}) {
  const none = (streak = 0, error = null) => ({ action: 'none', streak, error });
  if (!health) return none();
  if (c?.result !== 'unknown') { health.delete(number); return none(); } // claimed or held: healthy
  const prev = health.get(number);
  const kind = c.error?.kind || 'unknown';
  if (EXCUSED_KINDS.has(kind)) return none(prev?.streak || 0, prev?.error || null); // hold the streak
  const error = `${kind}: ${c.error?.message || 'no detail'}`.slice(0, 300);
  const entry = { streak: (prev?.streak || 0) + 1, dropped: !!prev?.dropped, error };
  health.set(number, entry);
  if (entry.streak >= giveUpAfter) return { action: 'exit', streak: entry.streak, error };
  if (entry.streak >= dropAfter && !entry.dropped) { entry.dropped = true; return { action: 'drop_caches', streak: entry.streak, error }; }
  return none(entry.streak, error);
}

/**
 * Forget everything this process memoized: the base sha and its etag, the capability probe, the
 * per-issue comment memos. None of it is state — the board is — so the next tick simply reads again.
 */
export function dropCaches(ctx) {
  ctx._cache = {};
  ctx.caps = {};
}

// ---------- tick ----------

async function failAttempt(ctx, task, runRec, outcome, note, { kill = true } = {}) {
  const a = openAttempt(runRec.run);
  if (a) {
    if (kill && a.host === ctx.host && a.job && !a.job_stopped) { stopJob(a.job); a.job_stopped = true; }
    else if (kill && a.host === ctx.host && a.pid) killPid(a.pid);
    a.ended_at = nowIso();
    a.outcome = outcome;
    if (note) a.reason = String(note).slice(0, 300);
    await release(ctx, task.number, a.attempt);
  }
  runRec.run.failures = (runRec.run.failures || 0) + 1;
  runRec.run.last_error = note || outcome;
  const limit = task.kb.max_retries ?? ctx.cfg.dispatch.failure_limit;
  if (runRec.run.failures > limit) {
    runRec.run.attempts.push({ attempt: runRec.run.attempts.length + 1, profile: 'dispatcher', host: ctx.host, started_at: nowIso(), ended_at: nowIso(), outcome: 'gave_up', reason: `${runRec.run.failures} consecutive failures (limit ${limit})`, synthetic: true });
    await saveRun(ctx, task.number, runRec);
    await setStatus(ctx, task, 'blocked', { add: [L.needsHuman] });
    return 'gave_up';
  }
  await saveRun(ctx, task.number, runRec);
  // back where readiness says it belongs, not blindly to `ready`: a track root is claimed while its
  // nodes are still open, and a failed track attempt must leave it in *todo* behind them.
  await setStatus(ctx, task, computeReady(task) ? 'ready' : 'todo');
  return outcome;
}

export async function tick(ctx, { max = Infinity, dryRun = false, children = null, profiles = null, log = () => {} } = {}) {
  ctx.requireBoard();
  const d = ctx.cfg.dispatch;
  const summary = { reconciled: [], reclaimed: [], promoted: [], guarded: [], claimed: [], spawn_failed: [], held: [], skipped: [], tracks: [], reaped: [], self_heal: [], auto_merge: [], fatal: null };
  // The tick is the lifetime of every read the tick memoizes: the base sha is revalidated (304 when
  // the branch has not moved) the first time a claim needs it, never inherited from an older tick.
  staleBaseSha(ctx);
  // A host claims only what it can launch. `--profiles` is how the Actions dispatcher takes the
  // `claude-action` tasks and leaves the laptop's `claude` ones alone; everything else in the tick —
  // reclaim, promote, reconcile, the orphan sweep — still covers the whole board.
  const dispatchable = (name) => !profiles || profiles.includes(name);
  const state = readState(ctx.root);
  const today = nowIso().slice(0, 10);
  if (state.spawn_day !== today) { state.spawn_day = today; state.spawned_today = 0; }
  state.profile_paused_until = state.profile_paused_until || {};
  // GitHub reads can lag writes by seconds. Remember what THIS host changed recently and refuse to
  // contradict it: a task touched < 90 s ago is skipped, a lock claimed < 15 min ago is never swept.
  state.touched = state.touched || {};
  state.claims = state.claims || {};
  for (const [k, v] of Object.entries(state.claims)) if (Date.now() - new Date(v).getTime() > 86_400_000) delete state.claims[k];
  const touchedRecently = (n) => state.touched[n] && Date.now() - new Date(state.touched[n]).getTime() < 90_000;
  const touch = (n) => { state.touched[n] = nowIso(); };

  if (!dryRun) replayOutbox(ctx, log);

  const tasks = await fetchBoard(ctx);
  const running = tasks.filter((t) => t.status === 'running');
  // Tracks, from the board read we already have. `covered` is every node a live runner owns: the
  // reclaim below leaves them alone (the root's own heartbeat is their liveness), they cost no
  // slot (a track is one session), and the selection at the end does not try to claim them.
  const plan = planTracks(tasks, ctx.cfg, { board: ctx.board });
  const coveredBy = plan.covered;

  // 0. reconcile issues GitHub closed behind our back (merged `Closes #n`). One extra query, gated.
  try {
    const r = await reconcileClosed(ctx, tasks, state, { dryRun, log });
    summary.reconciled = r.reconciled;
    if (r.skipped) summary.reconcile_skipped = r.skipped;
  } catch (e) {
    // never let a half-finished reconcile leave a clean cache behind: the next tick must look again
    delete state.reconcile;
    log(`reconcile failed (retrying next tick): ${e.message}`);
    summary.reconcile_error = e.message;
  }

  // Cleanup is part of the loop, not a chore. A task that leaves the open board takes its worktrees,
  // branches and beat chains with it right here — local git only, no API call — and the full sweep
  // runs every `gc_every_ticks` at the end of the tick. Whatever fails is retried by the next pass.
  const swept = new Set();
  const gcPending = new Set(state.gc_pending || []);
  const sweepFinished = (n, keep = []) => {
    if (dryRun || swept.has(n)) return;
    swept.add(n);
    try {
      const r = sweepTask(ctx, n, { keep, log });
      if (r.worktrees || r.branches) (summary.cleaned = summary.cleaned || []).push({ number: n, ...r });
      if (r.pending) gcPending.add(n); else gcPending.delete(n);
    } catch (e) { gcPending.add(n); log(`#${n}: cleanup skipped (${e.message}); the next tick retries it`); }
  };
  for (const r of summary.reconciled) if (!r.dry) sweepFinished(r.number, r.keep || []);
  for (const n of [...gcPending]) {
    // held by a live session last tick — try again, unless the task is back in flight: a retry that
    // caught a fresh attempt would delete the worktree a new worker is sitting in
    const t = tasks.find((x) => x.number === n);
    if (!t || ['done', 'archived'].includes(t.status)) sweepFinished(n);
  }

  // background-agent jobs on this host (one local `claude agents --json` per tick, only if any profile uses them)
  const usesBg = Object.values(ctx.cfg.profiles).some((p) => p.mode === 'claude-bg');
  const jobsById = new Map();
  if (usesBg) {
    const listing = listKbJobs(ctx.root);
    if (!listing.ok) log(`claude agents listing failed: ${listing.error}`);
    for (const j of listing.jobs) jobsById.set(j.id, j);
  }

  // The lock refs, read once for the whole tick: the reclaim check below reads the commit date of
  // the ref a stale-looking attempt holds (a ref-CAS heartbeat leaves no trace in the run comment),
  // and the orphan sweep walks the same list.
  let locks = null;
  try { locks = await listLocks(ctx); } catch (e) { log(`lock listing failed (reclaim falls back to the run comment): ${e.message}`); }
  const lockShaOf = (n, k) => (locks || []).find((l) => l.n === n && l.k === k)?.sha || null;

  // 1. reclaim stale / crashed / timed out / finished without a terminal verb
  for (const t of running) {
    if (touchedRecently(t.number)) continue; // our own transition may not be visible yet
    // a node inside a live track: its session is the root's, and the root's lock is what says
    // "alive". It has no pid and no job of its own, so every check below would call it crashed.
    if (coveredBy.has(t.number)) { log(`#${t.number}: node of running track #${coveredBy.get(t.number)} — the root's heartbeat covers it`); continue; }
    const runRec = await loadRun(ctx, t.number);
    const a = openAttempt(runRec.run);
    if (!a) {
      // running label but no open attempt: orphaned card → reconcile
      if (!dryRun) await setStatus(ctx, t, computeReady(t) ? 'ready' : 'todo');
      summary.reclaimed.push({ number: t.number, outcome: 'reconciled' });
      continue;
    }
    const maxRuntime = t.kb.max_runtime || d.max_runtime_default;
    let lastSignal = a.heartbeat_at || a.started_at;
    let outcome = null;
    // edits to the row that are not an outcome (the job id, the session behind it): saved once,
    // below, and only when nothing else is about to save the record anyway.
    let dirty = false;
    // Nothing local to inspect, for two reasons that answer the same way. `remote`: a `trigger`
    // profile handed this attempt to something that is not a process on any host we can see (an
    // Actions run). `manual`: a human claimed it by hand (`hkb claim <n>` with no `--spawn`) and is
    // working it in their own terminal — there is no pid the dispatcher ever knew. Either way
    // max_runtime and the heartbeat below are the whole check; the no-handle rules further down
    // would call a perfectly live attempt crashed three minutes in.
    if (a.remote || a.manual) { /* liveness is the heartbeat */ }
    else if (a.host === ctx.host && (a.job || a.bg)) {
      let job = a.job ? (jobsById.get(a.job) || readJobState(a.job)) : null;
      if (!job && a.bg && a.log) {
        // the launch log contains "backgrounded · <id>" — the reliable source for the job id
        let id = null;
        try { id = parseBackgroundedId(fs.readFileSync(path.join(ctx.root, a.log), 'utf8')); } catch { /* not yet written */ }
        if (id) { job = jobsById.get(id) || readJobState(id); if (!dryRun) { a.job = id; dirty = true; } }
      }
      if (!job && a.bg) job = matchJobByWorktree([...jobsById.values()], a.wt || `kb-${t.number}-${a.attempt}`);
      // The tick after the launch, name the session behind the job. A `claude --bg` worker records
      // its own identity from the terminal verb it runs (#135) — but the attempts that need it most
      // are the ones that never run one, and the job record already says everything they need.
      const session = dryRun ? null : jobSessionUpdate(a, job);
      if (session) {
        Object.assign(a, session);
        dirty = true;
        log(`#${t.number}: attempt ${a.attempt} ${formatSession(a)}`);
      }
      if (!job) {
        if (secondsSince(a.started_at) > 180) outcome = 'crashed'; // cold daemon start gets 3 min to register
      } else if (classifyJob(job) !== 'running' && secondsSince(a.started_at) > 30) outcome = 'protocol_violation';
    } else if (a.host === ctx.host && a.pid && !pidAlive(a.pid)) outcome = 'crashed';
    else if (a.host === ctx.host && !a.pid && !a.job && secondsSince(a.started_at) > 180) outcome = 'crashed'; // spawn never recorded a handle
    if (!outcome && secondsSince(a.started_at) > maxRuntime) outcome = 'timed_out';
    else if (!outcome && secondsSince(lastSignal) > d.stale_after) {
      // A ref-CAS worker writes nothing to the run comment, so its real last signal is the commit
      // its lock ref points at. One commit read, and only for an attempt that already looks stale.
      let beat = null;
      try { beat = await lockBeatAt(ctx, lockShaOf(t.number, a.attempt)); } catch (e) { log(`#${t.number}: lock ref beat unreadable (${e.message}); using the run comment`); }
      lastSignal = lastSignalAt(a, beat);
      if (secondsSince(lastSignal) > d.stale_after) outcome = 'reclaimed';
      else log(`#${t.number}: attempt ${a.attempt} beat on ${lockRef(t.number, a.attempt)} ${Math.round(secondsSince(lastSignal))}s ago — alive`);
    }
    if (!outcome) { if (dirty) await saveRun(ctx, t.number, runRec); continue; }
    if (dryRun) { summary.reclaimed.push({ number: t.number, outcome, dry: true }); continue; }
    // failAttempt saves the same record, so a row written off in the tick that named its session
    // costs one write, not two — and goes to its post-mortem carrying the session.
    const result = await failAttempt(ctx, t, runRec, outcome, `${outcome} after ${Math.round(secondsSince(a.started_at))}s`);
    touch(t.number);
    summary.reclaimed.push({ number: t.number, outcome: result });
    log(`#${t.number}: ${outcome}${result === 'gave_up' ? ' → gave_up (needs human)' : ' → ready'}`);
  }

  // reap the background agents the board is finished with — see reapDecision. `tasks` is the open
  // board with this tick's transitions already applied (setStatus mutates in place), so a card
  // reclaimed a few lines up is seen as ready here, not as still running.
  if (usesBg && !dryRun) {
    const byNumber = new Map(tasks.map((t) => [t.number, t]));
    for (const j of jobsById.values()) {
      const t = byNumber.get(j.task) || null;
      const why = reapDecision(j, t);
      if (!why) continue;
      if (!stopJob(j.id)) { log(`#${j.task}: could not stop background agent ${j.id} (${why}) — retrying next tick`); continue; }
      touch(j.task);
      summary.reaped.push({ number: j.task, job: j.id, why });
      log(`#${j.task}: stopped background agent ${j.id} — ${why}`);
      // Its checkout goes with it, unless the task is still waiting for another attempt — the
      // worktree of a crashed one is the post-mortem (`hkb show <n>` prints the resume command).
      if (!t || ['done', 'archived', 'review'].includes(t.status)) sweepFinished(j.task);
    }
  }

  // orphan lock sweep — NEVER a lock this host claimed < 15 min ago (a stale board read once made
  // this sweep delete a 30-second-old lock, letting the next tick double-claim the task: #15/3).
  try {
    for (const l of locks || []) {
      const claimedAt = state.claims[`${l.n}/${l.k}`];
      if (claimedAt && Date.now() - new Date(claimedAt).getTime() < 900_000) continue;
      if (touchedRecently(l.n)) continue;
      const t = tasks.find((x) => x.number === l.n);
      const runRec = t ? await loadRun(ctx, l.n) : null;
      const a = runRec ? runRec.run.attempts.find((x) => x.attempt === l.k) : null;
      const stale = !a || (a.ended_at && secondsSince(a.ended_at) > 600) || (!t && true);
      if (stale && !dryRun) { await release(ctx, l.n, l.k); log(`orphan lock ${l.ref} released`); }
    }
  } catch (e) { log(`lock sweep skipped: ${e.message}`); }

  // 2. promote todo → ready when all blockers are done
  for (const t of tasks.filter((x) => x.status === 'todo')) {
    if (!computeReady(t)) continue;
    if (!dryRun) await setStatus(ctx, t, 'ready');
    summary.promoted.push(t.number);
    log(`#${t.number}: todo → ready`);
  }

  // 3. select & claim
  // A track occupies one slot however many nodes it is holding — it is one session. Its nodes are
  // still real running tasks (that is what makes them checkpoints), so they are counted out here
  // rather than hidden: their paths still guard, they just do not spend capacity twice.
  const runningNow = tasks.filter((t) => t.status === 'running');
  const sessions = runningNow.filter((t) => !coveredBy.has(t.number));
  const perProfile = {};
  for (const t of sessions) perProfile[t.agent] = (perProfile[t.agent] || 0) + 1;
  let slots = Math.max(0, d.max_in_progress - sessions.length);
  let budget = Math.min(max, slots);
  const ready = sortForDispatch(tasks.filter((t) => t.status === 'ready'));
  const claimedPaths = runningNow.map((t) => t.kb.paths || []);

  // Claim health, per process and per task — see noteClaimResult. One verdict per task per tick, so
  // a root that is both a track candidate and its own frontier cannot count twice.
  const health = (ctx._health ||= new Map());
  const judged = new Set();
  const selfHeal = (number, c) => {
    if (judged.has(number)) return false;
    judged.add(number);
    const v = noteClaimResult(health, number, c);
    if (v.action === 'none') return false;
    summary.self_heal.push({ number, action: v.action, streak: v.streak, error: v.error });
    if (v.action === 'drop_caches') {
      dropCaches(ctx);
      log(`#${number}: self-heal: caches dropped after ${v.streak} unknown claim results in a row (${v.error}) — the next tick re-resolves everything from GitHub`);
      return false;
    }
    summary.fatal = { number, streak: v.streak, error: v.error };
    log(`#${number}: claim still unknown ${v.streak} ticks in, ${v.streak - SELF_HEAL.dropAfter} of them after the cache drop — this process cannot fix itself`);
    return true;
  };

  // 3a. track roots: one session for a whole subgraph, claimed on the ROOT lock. The nodes are
  //     claimed by the runner as it reaches each one, so a runner that dies never wedges the track.
  //     Before the ready loop on purpose — a track and its own frontier would otherwise race for the
  //     same slot, and the node would win, leaving the track un-runnable for as long as it ran.
  //     Same caps and the same guards, with the union of the nodes' paths standing in for the root's.
  const claimedTracks = new Set(); // a root taken here is not also dispatched as a node below
  for (const cand of plan.candidates) {
    const t = cand.root;
    const note = (why, extra = {}) => { summary.tracks.push({ root: t.number, nodes: cand.track.nodes.map((x) => x.number), ok: false, why, ...extra }); };
    if (!cand.ok) { note(cand.why); continue; }
    if (touchedRecently(t.number)) { note('touched recently (stale-read guard)'); continue; }
    if (budget <= 0) { note('no slot'); continue; }
    if ((state.spawned_today || 0) >= d.daily_spawn_cap) { note(`daily spawn cap ${d.daily_spawn_cap}`); continue; }
    const profileName = t.agent;
    const profile = ctx.cfg.profiles[profileName];
    if (!profile) { note(`unknown profile ${profileName} — \`hkb init --profiles ${profileName}\` adds it to board.json`); continue; }
    if (!dispatchable(profileName)) { note(`profile ${profileName} is not dispatched from this host`); continue; }
    if ((perProfile[profileName] || 0) >= (profile.max_in_progress ?? Infinity)) { note(`profile ${profileName} at cap`); continue; }
    const pausedUntil = state.profile_paused_until[profileName];
    if (pausedUntil && new Date(pausedUntil) > new Date()) { note('blocker_auth pause', { until: pausedUntil }); continue; }
    const runRec = await loadRun(ctx, t.number);
    // one go per root: a track attempt that ended without finishing the track hands the remaining
    // nodes back to the durable engine, which is the whole point of checkpointing every node.
    if (trackAlreadyAttempted(runRec.run)) { note('a track attempt already ran — node dispatch takes it from here'); continue; }
    const last = lastAttempt(runRec.run);
    if (last?.outcome === 'completed' && secondsSince(last.ended_at) < d.recent_success_window) { note('recent_success'); continue; }
    const paths = trackPaths(cand.track);
    if (d.path_guard && paths.length && claimedPaths.some((p) => p.length && pathsOverlap(p, paths))) { note('path_overlap'); continue; }

    const nodes = cand.track.nodes.map((x) => x.number);
    const k = runRec.run.attempts.length + 1;
    if (dryRun) {
      summary.tracks.push({ root: t.number, nodes, ok: true, attempt: k, profile: profileName, dry: true });
      claimedTracks.add(t.number);
      for (const nn of nodes) coveredBy.set(nn, t.number); // a dry run must report the same board as a real one
      log(`#${t.number}: [dry-run] would run track ${[...nodes, t.number].map((x) => `#${x}`).join(' → ')} as one ${profileName} session`);
      budget--;
      continue;
    }
    const c = await claim(ctx, t.number, k);
    if (selfHeal(t.number, c)) { note(`claim unknown: ${c.error?.kind}`); break; }
    if (c.result === 'claimed') { state.claims[`${t.number}/${k}`] = nowIso(); touch(t.number); }
    if (c.result === 'held') { summary.held.push(t.number); note('lock held elsewhere'); log(`#${t.number}: track lock held elsewhere, skipping`); continue; }
    if (c.result === 'unknown') {
      log(`#${t.number}: track claim result unknown (${c.error?.kind}: ${c.error?.message}); backing off this tick`);
      note(`claim unknown: ${c.error?.kind}`);
      if (c.error?.kind === 'ratelimit' || c.error?.kind === 'auth') break;
      continue;
    }
    const attempt = { attempt: k, profile: profileName, host: ctx.host, started_at: nowIso(), heartbeat_at: nowIso(), lock_sha: c.sha, pid: null, track: true, track_nodes: nodes };
    runRec.run.attempts.push(attempt);
    await saveRun(ctx, t.number, runRec);
    await setStatus(ctx, t, 'running', { remove: [L.needsHuman] });
    let spawned;
    try {
      spawned = await spawnWorker(ctx, t, profileName, k, {
        keepRef: !!children,
        prompt: trackContext({ repo: ctx.repo.nameWithOwner, board: ctx.board, track: cand.track, attempt: k, waves: cand.waves }),
      });
      if (!spawned.pid && !spawned.bg && !spawned.remote) throw new Error('spawn returned neither a pid nor a background launch');
    } catch (e) {
      log(`#${t.number}: track spawn failed: ${e.message}`);
      // the runner never started, so the fast engine has not had its go: drop the marker that
      // would otherwise hand the whole subgraph to node dispatch over a missing binary.
      delete attempt.track;
      attempt.track_spawn_failed = true;
      await failAttempt(ctx, t, runRec, 'spawn_failed', e.message, { kill: false });
      summary.spawn_failed.push({ number: t.number, error: e.message, track: true });
      // hold the nodes for one tick so the retry still has a track to run. A launch this host
      // cannot start eventually exhausts max_retries, parks the root for a human, and *then* the
      // nodes are free — falling back to node dispatch through the ordinary escalation.
      for (const nn of nodes) coveredBy.set(nn, t.number);
      continue;
    }
    attempt.pid = spawned.pid;
    if (spawned.bg) attempt.bg = true;
    if (spawned.remote) attempt.remote = true;
    if (spawned.wt) attempt.wt = spawned.wt;
    attempt.log = path.relative(ctx.root, spawned.logFile);
    await saveRun(ctx, t.number, runRec);
    state.spawned_today = (state.spawned_today || 0) + 1;
    perProfile[profileName] = (perProfile[profileName] || 0) + 1;
    claimedPaths.push(paths);
    for (const nn of nodes) coveredBy.set(nn, t.number); // the loop below must leave them to the runner
    claimedTracks.add(t.number);
    budget--;
    summary.tracks.push({ root: t.number, nodes, ok: true, attempt: k, profile: profileName, pid: spawned.pid, wt: spawned.wt || null });
    log(`#${t.number}: claimed track attempt ${k} → ${profileName}, ${nodes.length + 1} nodes ${[...nodes, t.number].map((x) => `#${x}`).join(' → ')} (log ${attempt.log})`);
    if (children && spawned.child) watchChild(ctx, t.number, k, spawned.child, children, state, profileName, log);
  }

  for (const t of ready) {
    if (summary.fatal) break; // the process is on its way out; claiming more would only orphan it
    if (t.status !== 'ready' || claimedTracks.has(t.number)) continue; // 3a took it: it is running its own track now
    if (coveredBy.has(t.number)) { summary.skipped.push({ number: t.number, why: `held for track #${coveredBy.get(t.number)}` }); continue; }
    if (touchedRecently(t.number)) { summary.skipped.push({ number: t.number, why: 'touched recently (stale-read guard)' }); continue; }
    // active_pr guard first: it must apply even when there is no slot, and for a card with no PR it
    // costs nothing. The one exemption is the card `hkb request-changes` produced — its latest
    // attempt is the reviewer's `changes_requested` row, and its open PR is what this attempt
    // continues (#153). Deciding that needs the run record, which the claim below reads anyway; a
    // card that is only guarded pays one read on the single tick where the guard fires and then
    // leaves `ready`, so a board where nothing was sent back is unchanged.
    let runRec = null;
    let continuePr = null;
    if ((t.prs || []).some((p) => p.state === 'OPEN')) {
      runRec = await loadRun(ctx, t.number);
      const g = activePrGuard(runRec.run.attempts, t.prs);
      if (g.guard) {
        if (!dryRun) await setStatus(ctx, t, 'review');
        summary.guarded.push({ number: t.number, guard: 'active_pr', pr: g.pr.number });
        log(`#${t.number}: open PR #${g.pr.number} → review (active_pr guard)`);
        continue;
      }
      continuePr = g.pr;
    }
    if (budget <= 0) { summary.skipped.push({ number: t.number, why: 'no slot' }); continue; }
    if ((state.spawned_today || 0) >= d.daily_spawn_cap) { summary.skipped.push({ number: t.number, why: `daily spawn cap ${d.daily_spawn_cap}` }); continue; }
    const profileName = t.agent || 'claude';
    const profile = ctx.cfg.profiles[profileName];
    if (!profile) { summary.skipped.push({ number: t.number, why: `unknown profile ${profileName} — \`hkb init --profiles ${profileName}\` adds it to board.json` }); continue; }
    if (!dispatchable(profileName)) { summary.skipped.push({ number: t.number, why: `profile ${profileName} is not dispatched from this host` }); continue; }
    if ((perProfile[profileName] || 0) >= (profile.max_in_progress ?? Infinity)) { summary.skipped.push({ number: t.number, why: `profile ${profileName} at cap` }); continue; }
    // remaining guards (these read the run comment, so only for tasks that could actually be claimed)
    const pausedUntil = state.profile_paused_until[profileName];
    if (pausedUntil && new Date(pausedUntil) > new Date()) { summary.guarded.push({ number: t.number, guard: 'blocker_auth', until: pausedUntil }); continue; }
    runRec = runRec || await loadRun(ctx, t.number);
    const last = lastAttempt(runRec.run);
    if (last?.outcome === 'completed' && secondsSince(last.ended_at) < d.recent_success_window) { summary.guarded.push({ number: t.number, guard: 'recent_success' }); continue; }
    if (d.path_guard && (t.kb.paths || []).length && claimedPaths.some((p) => p.length && pathsOverlap(p, t.kb.paths))) { summary.guarded.push({ number: t.number, guard: 'path_overlap' }); continue; }
    if (t.kb.scheduled_at && new Date(t.kb.scheduled_at) > new Date()) { summary.skipped.push({ number: t.number, why: 'scheduled later' }); continue; }

    const k = runRec.run.attempts.length + 1;
    const continues = continuePr ? { continues_pr: continuePr.number } : {};
    if (dryRun) { summary.claimed.push({ number: t.number, attempt: k, profile: profileName, dry: true, ...continues }); budget--; continue; }
    const c = await claim(ctx, t.number, k);
    if (selfHeal(t.number, c)) break;
    if (c.result === 'claimed') { state.claims[`${t.number}/${k}`] = nowIso(); touch(t.number); }
    if (c.result === 'held') { summary.held.push(t.number); log(`#${t.number}: lock held elsewhere, skipping`); continue; }
    if (c.result === 'unknown') {
      log(`#${t.number}: claim result unknown (${c.error?.kind}: ${c.error?.message}); backing off this tick`);
      if (c.error?.kind === 'ratelimit' || c.error?.kind === 'auth') break;
      continue;
    }
    // lock_sha starts the worker's heartbeat chain: the first `hkb heartbeat` leases on it
    const attempt = { attempt: k, profile: profileName, host: ctx.host, started_at: nowIso(), heartbeat_at: nowIso(), lock_sha: c.sha, pid: null, ...continues };
    runRec.run.attempts.push(attempt);
    await saveRun(ctx, t.number, runRec);
    await setStatus(ctx, t, 'running', { add: t.agent ? [] : [L.agent(profileName)], remove: [L.needsHuman] });
    let spawned;
    try {
      spawned = await spawnWorker(ctx, t, profileName, k, { keepRef: !!children, continuePr });
      if (!spawned.pid && !spawned.bg && !spawned.remote) throw new Error('spawn returned neither a pid nor a background launch');
    } catch (e) {
      log(`#${t.number}: spawn failed: ${e.message}`);
      await failAttempt(ctx, t, runRec, 'spawn_failed', e.message, { kill: false });
      summary.spawn_failed.push({ number: t.number, error: e.message });
      continue;
    }
    attempt.pid = spawned.pid;
    if (spawned.bg) attempt.bg = true;
    if (spawned.remote) attempt.remote = true;
    if (spawned.wt) attempt.wt = spawned.wt;
    // which of the two continuation paths this attempt took: the branch, when the dispatcher put the
    // checkout on the PR's own; nothing, when the brief is all that tells the worker to continue it
    if (spawned.continued?.branch) attempt.continues_branch = spawned.continued.branch;
    attempt.log = path.relative(ctx.root, spawned.logFile);
    await saveRun(ctx, t.number, runRec);
    state.spawned_today = (state.spawned_today || 0) + 1;
    perProfile[profileName] = (perProfile[profileName] || 0) + 1;
    claimedPaths.push(t.kb.paths || []);
    budget--;
    const handle = spawned.remote
      ? `started elsewhere by \`${spawned.argv.slice(0, 4).join(' ')}\` — its heartbeat is the only liveness`
      : spawned.bg
        ? `background agent in ${spawned.wt} (job id on next tick; claude agents to watch)`
        : `pid ${spawned.pid}${spawned.wt ? ` in ${worktreePath(spawned.wt)}` : ''}`;
    const continuing = !spawned.continued ? ''
      : spawned.continued.branch
        ? `, continuing PR #${spawned.continued.pr} on ${spawned.continued.branch}`
        : `, continuing PR #${spawned.continued.pr} from a fresh worktree (${spawned.continued.why}) — the brief says which PR to push to`;
    summary.claimed.push({ number: t.number, attempt: k, profile: profileName, pid: spawned.pid, wt: spawned.wt || null, ...continues });
    log(`#${t.number}: claimed attempt ${k} → ${profileName} ${handle}${continuing} (log ${attempt.log})`);
    if (children && spawned.child) watchChild(ctx, t.number, k, spawned.child, children, state, profileName, log);
  }

  // a task that left the open board takes its claim-health entry with it
  for (const n of health.keys()) if (!tasks.some((t) => t.number === n)) health.delete(n);

  // 3c. the last step, when the board asked GitHub to take it (`dispatch.merge.mode: "auto"`).
  //     After the claim loop, so a card the `active_pr` guard moved to review a few lines up is
  //     handed over on the same tick rather than the next one.
  try {
    summary.auto_merge = await autoMergePass(ctx, tasks, { dryRun, log });
  } catch (e) {
    summary.auto_merge_error = e.message;
    log(`auto-merge pass failed (the board is unaffected, and the next tick tries again): ${e.message}`);
  }

  // 4. mirror the labels onto the linked Projects v2 board (opt-in, one-way, never fatal).
  //    Last, so it sees every transition this tick: setStatus mutates the task objects in place.
  if (isMirrorConfigured(ctx.cfg)) {
    try {
      const extra = {};
      for (const r of summary.reconciled) if (r.status) extra[r.number] = r.status; // closed issues left `tasks`
      summary.project = await syncProject(ctx, tasks, { dryRun, extra, state, log });
    } catch (e) {
      const x = projectError(e);
      summary.project = { error: x.message, fix: x.fix };
      log(`project mirror failed (the board is unaffected): ${x.message}${x.fix ? ` → ${x.fix}` : ''}`);
    }
  }

  // 5. every `gc_every_ticks`, the full sweep — the same `sweep()` `hkb gc --yes` runs, so what the
  //    dispatcher cleans and what a human cleans can never diverge. One board read, then local git.
  if (!dryRun) state.gc_pending = [...gcPending].slice(-50);
  const every = d.gc_every_ticks ?? GC_EVERY_TICKS;
  if (!dryRun && every > 0) {
    state.ticks_since_gc = (state.ticks_since_gc || 0) + 1;
    if (state.ticks_since_gc >= every) {
      state.ticks_since_gc = 0;
      state.gc_scanned = state.gc_scanned || {};
      try {
        // the memo (issue → updatedAt already scanned for duplicate run comments) rides in the
        // state file the tick already writes, so a sweep of a quiet board reads no issue at all
        summary.gc = await sweep(ctx, { yes: true, memo: state.gc_scanned, log });
        log(`gc: ${summary.gc.worktrees} worktree(s), ${summary.gc.branches} branch(es), ${summary.gc.comments} duplicate comment(s), ${summary.gc.chains} beat chain(s), ${summary.gc.files} old file(s)`);
      } catch (e) {
        summary.gc = { error: e.message };
        log(`gc sweep skipped (retried in ${every} ticks): ${e.message}`);
      }
    }
  }

  writeState(ctx.root, state);
  return summary;
}

/** In loop mode we hold the child handle: exit without a terminal verb = protocol_violation. */
function watchChild(ctx, number, k, child, children, state, profileName, log) {
  children.set(`${number}/${k}`, child);
  child.on('exit', async (code) => {
    children.delete(`${number}/${k}`);
    try {
      const runRec = await loadRun(ctx, number);
      const a = runRec.run.attempts.find((x) => x.attempt === k);
      if (!a) return;
      // `claude -p --output-format json` signs off with the session id and what the run cost.
      // A malformed log must never cost us the reclaim below, so this is its own try.
      const logText = tailLog(ctx, a.log, 200_000);
      let session = null;
      try { session = sessionUpdate(a, parseSessionLog(logText)); } catch { /* unreadable log */ }
      if (session) Object.assign(a, session);
      if (a.ended_at) { // the worker finished properly — only the session numbers are new
        if (session) { await saveRun(ctx, number, runRec); log(`#${number}: attempt ${k} ${formatSession(a)}`); }
        return;
      }
      a.exit_code = code;
      const logTail = logText.slice(-4000);
      if (/429|rate limit|quota|401|unauthorized|not logged in/i.test(logTail)) {
        state.profile_paused_until[profileName] = new Date(Date.now() + ctx.cfg.dispatch.auth_pause * 1000).toISOString();
        writeState(ctx.root, state);
      }
      const t = await getTask(ctx, number);
      const r = await failAttempt(ctx, t, runRec, 'protocol_violation', `worker exited (${code}) without a terminal verb`, { kill: false });
      log(`#${number}: attempt ${k} exited ${code} without complete/block → ${r}${session ? ` (${formatSession(a)})` : ''}`);
    } catch (e) { log(`#${number}: post-exit handling failed: ${e.message}`); }
  });
}

function tailLog(ctx, rel, bytes = 4000) {
  try { const s = fs.readFileSync(path.join(ctx.root, rel), 'utf8'); return s.slice(-bytes); } catch { return ''; }
}

/** Exactly one dispatcher loop per board root. Two concurrent loops fight: one sweeps the other's
 * fresh locks and kills its workers (observed 2026-08-26 when wrapper-pid kills left node alive). */
function acquireLoopLock(ctx) {
  const file = pidFile(ctx.root, 'dispatch');
  try {
    const existing = Number(fs.readFileSync(file, 'utf8').trim());
    // `hkb up` writes the pid of the child it just spawned into this file, so a loop finding its own
    // pid here is finding its own claim, not a rival's.
    if (existing && existing !== process.pid && pidAlive(existing)) {
      const e = new Error(`another dispatcher loop is already running (pid ${existing}). If you are a worker session: never run the dispatcher. If you own this host and want to replace it, stop it yourself first (\`hkb down\`).`);
      e.exitCode = 2;
      throw e;
    }
  } catch (e) { if (e.exitCode) throw e; /* no or stale pidfile */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid) + '\n');
  clearExit(ctx.root, 'dispatch'); // a loop is running again: the last one's exit is no longer the news
  const drop = () => { try { if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file); } catch { /* gone */ } };
  process.on('exit', drop);
  return drop;
}

/**
 * The long-lived dispatcher. `sleeper` is the wait between ticks, injected so a test can run six
 * ticks in a millisecond. Throws (exit code 4) when a tick reports `fatal`: the self-heal ladder ran
 * out and the honest thing left is to die with a reason a supervisor and a human can both read.
 */
export async function loop(ctx, { interval, max, profiles = null, log, sleeper = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const dropLock = acquireLoopLock(ctx);
  log(`dispatcher pid ${process.pid} (singleton lock .kanban/dispatch.pid)`);
  const children = new Map();
  let stopping = false;
  let fatal = null;
  const stop = () => { stopping = true; log('stopping after this tick (workers keep running; next dispatcher reclaims or adopts them)'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  for (;;) {
    const started = Date.now();
    // Once a day, before the tick: the two things nobody tells the operator of a loop that has been
    // up for weeks — a KB_TOKEN about to lapse, and an hkb that npm has moved on from. Both
    // read-modify-write `.kanban/state.json`, which is why they are here and not inside `tick()`;
    // both are silent on a failed probe, so an offline loop runs exactly as it did without them.
    await tokenExpiryNotice(ctx, log);
    await versionNotice(ctx, log);
    try {
      const s = await tick(ctx, { max, children, profiles, log });
      const n = (k) => s[k].length;
      log(`tick: reconciled ${n('reconciled')} reclaimed ${n('reclaimed')} reaped ${n('reaped')} promoted ${n('promoted')} claimed ${n('claimed')} tracks ${s.tracks.filter((x) => x.ok).length} guarded ${n('guarded')} held ${n('held')} skipped ${n('skipped')}`);
      if (s.fatal) { fatal = s.fatal; break; }
    } catch (e) {
      if (e instanceof GhError && e.kind === 'network') log('GitHub unreachable — reclaim clock paused, retrying next tick');
      else log(`tick failed: ${e.message}`);
    }
    if (stopping) break;
    const wait = Math.max(5_000, interval * 1000 - (Date.now() - started));
    await sleeper(wait);
  }
  dropLock();
  if (fatal) {
    const e = new Error(`dispatcher exiting: #${fatal.number} claim came back unknown ${fatal.streak} ticks in a row, ${fatal.streak - SELF_HEAL.dropAfter} of them after this process dropped every cache it had. Last error: ${fatal.error}. Start a new dispatcher — fresh state is what fixes this; if it fails the same way the fault is upstream, so check \`gh auth status\` and \`hkb doctor\`. Running workers are untouched: the next dispatcher adopts or reclaims them.`);
    e.exitCode = 4;
    log(`FATAL ${e.message}`);
    // The pid file is gone (that is what `dropLock` means), so without this the next `hkb up --status`
    // could only say "stopped" — which is true and useless. Nothing reads this to restart anything.
    recordExit(ctx.root, 'dispatch', { code: 4, at: nowIso(), reason: e.message });
    throw e;
  }
}

export { addLabels };
