// The dispatcher: stateless, idempotent, deterministic. Never an LLM.
// Per tick: replay outbox → reclaim/crash/timeout → promote todo→ready → guards → claim + spawn.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchBoard, loadRun, saveRun, setStatus, addLabels, getTask } from './tasks.js';
import { claim, release, listLocks } from './lock.js';
import { logsDir, outboxFile, readState, writeState, ensureLocalDirs } from './board.js';
import { computeReady, openAttempt, lastAttempt, sortForDispatch, pathsOverlap, slugify, L, lockRef, classifyJob, jobAlive } from './model.js';
import { workerContext } from './context.js';
import { GhError } from './gh.js';
import { listKbJobs, readJobState, stopJob, matchJobByWorktree } from './jobs.js';

const nowIso = () => new Date().toISOString();
const secondsSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 1000 : Infinity);

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

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

function expandLaunch(template, vars, profile) {
  const out = [];
  for (const el of template) {
    if (el === '{allowed_tools}') { out.push(...(profile.allowed_tools || [])); continue; }
    if (el === '{model_args}') { if (vars.model) out.push('--model', vars.model); continue; }
    out.push(el.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')));
  }
  return out;
}

export async function spawnWorker(ctx, task, profileName, attempt, { dryRun = false, keepRef = false } = {}) {
  const profile = ctx.cfg.profiles[profileName];
  if (!profile?.launch) throw new Error(`profile "${profileName}" has no launch template in board.json`);
  const prompt = await workerContext(ctx, task, attempt);
  const vars = { n: task.number, k: attempt, slug: slugify(task.title), title: task.title.replace(/[\r\n]+/g, ' ').slice(0, 80), model: task.kb.model || profile.model || '', prompt, board: ctx.board, repo: ctx.repo.nameWithOwner };
  const argv = expandLaunch(profile.launch, vars, profile);
  const env = {
    ...process.env,
    KB_TASK: String(task.number), KB_ATTEMPT: String(attempt), KB_BOARD: ctx.board, KB_REPO: ctx.repo.nameWithOwner,
    KB_LOCK_REF: lockRef(task.number, attempt), KB_ROOT: ctx.root, KB_PROFILE: profileName,
  };
  if (dryRun) return { argv, pid: null };
  ensureLocalDirs(ctx.root);
  const logFile = path.join(logsDir(ctx.root), `${task.number}-${attempt}.log`);
  if (profile.mode === 'claude-bg') {
    // Fire-and-forget: `claude --bg` prints "backgrounded · <id>" and exits, but a cold daemon
    // start can take a minute — never block the tick on it. Detach, log its output, and identify
    // the running job by its worktree on the next tick (cwd basename == kb-<n>-<k>).
    fs.appendFileSync(logFile, `# ${nowIso()} launch background agent for #${task.number} attempt ${attempt}\n`);
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(argv[0], argv.slice(1), { cwd: ctx.root, env, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => { /* surfaced next tick as crashed if the job never registers */ });
    fs.closeSync(fd);
    child.unref();
    return { argv, pid: null, bg: true, wt: `kb-${task.number}-${attempt}`, logFile };
  }
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `# ${nowIso()} spawn ${argv[0]} for #${task.number} attempt ${attempt}\n`);
  const child = spawn(argv[0], argv.slice(1), { cwd: ctx.root, env, detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', () => { /* handled via exit code below */ });
  fs.closeSync(fd); // the child holds its own copy
  if (!keepRef) child.unref(); // one-shot dispatch must not wait for the worker
  return { argv, pid: child.pid, child, logFile };
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
  await setStatus(ctx, task, 'ready');
  return outcome;
}

export async function tick(ctx, { max = Infinity, dryRun = false, children = null, log = () => {} } = {}) {
  ctx.requireBoard();
  const d = ctx.cfg.dispatch;
  const summary = { reclaimed: [], promoted: [], guarded: [], claimed: [], spawn_failed: [], held: [], skipped: [] };
  const state = readState(ctx.root);
  const today = nowIso().slice(0, 10);
  if (state.spawn_day !== today) { state.spawn_day = today; state.spawned_today = 0; }
  state.profile_paused_until = state.profile_paused_until || {};

  if (!dryRun) replayOutbox(ctx, log);

  const tasks = await fetchBoard(ctx);
  const running = tasks.filter((t) => t.status === 'running');

  // background-agent jobs on this host (one local `claude agents --json` per tick, only if any profile uses them)
  const usesBg = Object.values(ctx.cfg.profiles).some((p) => p.mode === 'claude-bg');
  const jobsById = new Map();
  if (usesBg) {
    const listing = listKbJobs(ctx.root);
    if (!listing.ok) log(`claude agents listing failed: ${listing.error}`);
    for (const j of listing.jobs) jobsById.set(j.id, j);
  }

  // 1. reclaim stale / crashed / timed out / finished without a terminal verb
  for (const t of running) {
    const runRec = await loadRun(ctx, t.number);
    const a = openAttempt(runRec.run);
    if (!a) {
      // running label but no open attempt: orphaned card → reconcile
      if (!dryRun) await setStatus(ctx, t, computeReady(t) ? 'ready' : 'todo');
      summary.reclaimed.push({ number: t.number, outcome: 'reconciled' });
      continue;
    }
    const maxRuntime = t.kb.max_runtime || d.max_runtime_default;
    const lastSignal = a.heartbeat_at || a.started_at;
    let outcome = null;
    if (a.host === ctx.host && (a.job || a.bg)) {
      let job = a.job ? (jobsById.get(a.job) || readJobState(a.job)) : null;
      if (!job && a.bg) {
        job = matchJobByWorktree([...jobsById.values()], a.wt || `kb-${t.number}-${a.attempt}`);
        if (job && !dryRun) { a.job = job.id; await saveRun(ctx, t.number, runRec); } // backfill once
      }
      if (!job) {
        if (secondsSince(a.started_at) > 180) outcome = 'crashed'; // cold daemon start gets 3 min to register
      } else if (classifyJob(job) !== 'running' && secondsSince(a.started_at) > 30) outcome = 'protocol_violation';
    } else if (a.host === ctx.host && a.pid && !pidAlive(a.pid)) outcome = 'crashed';
    else if (a.host === ctx.host && !a.pid && !a.job && secondsSince(a.started_at) > 180) outcome = 'crashed'; // spawn never recorded a handle
    if (!outcome && secondsSince(a.started_at) > maxRuntime) outcome = 'timed_out';
    else if (!outcome && secondsSince(lastSignal) > d.stale_after) outcome = 'reclaimed';
    if (!outcome) continue;
    if (dryRun) { summary.reclaimed.push({ number: t.number, outcome, dry: true }); continue; }
    const result = await failAttempt(ctx, t, runRec, outcome, `${outcome} after ${Math.round(secondsSince(a.started_at))}s`);
    summary.reclaimed.push({ number: t.number, outcome: result });
    log(`#${t.number}: ${outcome}${result === 'gave_up' ? ' → gave_up (needs human)' : ' → ready'}`);
  }

  // reap finished background agents: a kb job that is done and whose task is no longer running → claude stop
  if (usesBg && !dryRun) {
    const runningNumbers = new Set(tasks.filter((t) => t.status === 'running').map((t) => t.number));
    for (const j of jobsById.values()) {
      if (!j.pid || jobAlive(j)) continue;
      if (runningNumbers.has(j.task)) continue; // handled above (or a fresh attempt still starting)
      if (stopJob(j.id)) { summary.reaped = summary.reaped || []; summary.reaped.push({ number: j.task, job: j.id }); log(`#${j.task}: stopped finished background agent ${j.id}`); }
    }
  }

  // orphan lock sweep: refs with no matching open attempt older than 10 min
  try {
    const locks = await listLocks(ctx);
    for (const l of locks) {
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
  const runningNow = tasks.filter((t) => t.status === 'running');
  const perProfile = {};
  for (const t of runningNow) perProfile[t.agent] = (perProfile[t.agent] || 0) + 1;
  let slots = Math.max(0, d.max_in_progress - runningNow.length);
  let budget = Math.min(max, slots);
  const ready = sortForDispatch(tasks.filter((t) => t.status === 'ready'));
  const claimedPaths = runningNow.map((t) => t.kb.paths || []);

  for (const t of ready) {
    // active_pr guard first: it needs no extra call and must apply even when there is no slot
    const openPrEarly = (t.prs || []).find((p) => p.state === 'OPEN');
    if (openPrEarly) {
      if (!dryRun) await setStatus(ctx, t, 'review');
      summary.guarded.push({ number: t.number, guard: 'active_pr', pr: openPrEarly.number });
      log(`#${t.number}: open PR #${openPrEarly.number} → review (active_pr guard)`);
      continue;
    }
    if (budget <= 0) { summary.skipped.push({ number: t.number, why: 'no slot' }); continue; }
    if ((state.spawned_today || 0) >= d.daily_spawn_cap) { summary.skipped.push({ number: t.number, why: `daily spawn cap ${d.daily_spawn_cap}` }); continue; }
    const profileName = t.agent || 'claude';
    const profile = ctx.cfg.profiles[profileName];
    if (!profile) { summary.skipped.push({ number: t.number, why: `unknown profile ${profileName}` }); continue; }
    if ((perProfile[profileName] || 0) >= (profile.max_in_progress ?? Infinity)) { summary.skipped.push({ number: t.number, why: `profile ${profileName} at cap` }); continue; }
    // remaining guards (these read the run comment, so only for tasks that could actually be claimed)
    const pausedUntil = state.profile_paused_until[profileName];
    if (pausedUntil && new Date(pausedUntil) > new Date()) { summary.guarded.push({ number: t.number, guard: 'blocker_auth', until: pausedUntil }); continue; }
    const runRec = await loadRun(ctx, t.number);
    const last = lastAttempt(runRec.run);
    if (last?.outcome === 'completed' && secondsSince(last.ended_at) < d.recent_success_window) { summary.guarded.push({ number: t.number, guard: 'recent_success' }); continue; }
    if (d.path_guard && (t.kb.paths || []).length && claimedPaths.some((p) => p.length && pathsOverlap(p, t.kb.paths))) { summary.guarded.push({ number: t.number, guard: 'path_overlap' }); continue; }
    if (t.kb.scheduled_at && new Date(t.kb.scheduled_at) > new Date()) { summary.skipped.push({ number: t.number, why: 'scheduled later' }); continue; }

    const k = runRec.run.attempts.length + 1;
    if (dryRun) { summary.claimed.push({ number: t.number, attempt: k, profile: profileName, dry: true }); budget--; continue; }
    const c = await claim(ctx, t.number, k);
    if (c.result === 'held') { summary.held.push(t.number); log(`#${t.number}: lock held elsewhere, skipping`); continue; }
    if (c.result === 'unknown') {
      log(`#${t.number}: claim result unknown (${c.error?.kind}: ${c.error?.message}); backing off this tick`);
      if (c.error?.kind === 'ratelimit' || c.error?.kind === 'auth') break;
      continue;
    }
    const attempt = { attempt: k, profile: profileName, host: ctx.host, started_at: nowIso(), heartbeat_at: nowIso(), pid: null };
    runRec.run.attempts.push(attempt);
    await saveRun(ctx, t.number, runRec);
    await setStatus(ctx, t, 'running', { add: t.agent ? [] : [L.agent(profileName)], remove: [L.needsHuman] });
    let spawned;
    try {
      spawned = await spawnWorker(ctx, t, profileName, k, { keepRef: !!children });
      if (!spawned.pid && !spawned.bg) throw new Error('spawn returned neither a pid nor a background launch');
    } catch (e) {
      log(`#${t.number}: spawn failed: ${e.message}`);
      await failAttempt(ctx, t, runRec, 'spawn_failed', e.message, { kill: false });
      summary.spawn_failed.push({ number: t.number, error: e.message });
      continue;
    }
    attempt.pid = spawned.pid;
    if (spawned.bg) { attempt.bg = true; attempt.wt = spawned.wt; }
    attempt.log = path.relative(ctx.root, spawned.logFile);
    await saveRun(ctx, t.number, runRec);
    state.spawned_today = (state.spawned_today || 0) + 1;
    perProfile[profileName] = (perProfile[profileName] || 0) + 1;
    claimedPaths.push(t.kb.paths || []);
    budget--;
    const handle = spawned.bg ? `background agent in ${spawned.wt} (job id on next tick; claude agents to watch)` : `pid ${spawned.pid}`;
    summary.claimed.push({ number: t.number, attempt: k, profile: profileName, pid: spawned.pid, wt: spawned.wt || null });
    log(`#${t.number}: claimed attempt ${k} → ${profileName} ${handle} (log ${attempt.log})`);
    if (children && spawned.child) watchChild(ctx, t.number, k, spawned.child, children, state, profileName, log);
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
      const t = await getTask(ctx, number);
      const runRec = await loadRun(ctx, number);
      const a = runRec.run.attempts.find((x) => x.attempt === k);
      if (!a || a.ended_at) return; // worker finished properly
      a.exit_code = code;
      const logTail = tailLog(ctx, a.log);
      if (/429|rate limit|quota|401|unauthorized|not logged in/i.test(logTail)) {
        state.profile_paused_until[profileName] = new Date(Date.now() + ctx.cfg.dispatch.auth_pause * 1000).toISOString();
        writeState(ctx.root, state);
      }
      const r = await failAttempt(ctx, t, runRec, 'protocol_violation', `worker exited (${code}) without a terminal verb`, { kill: false });
      log(`#${number}: attempt ${k} exited ${code} without complete/block → ${r}`);
    } catch (e) { log(`#${number}: post-exit handling failed: ${e.message}`); }
  });
}

function tailLog(ctx, rel) {
  try { const s = fs.readFileSync(path.join(ctx.root, rel), 'utf8'); return s.slice(-4000); } catch { return ''; }
}

export async function loop(ctx, { interval, max, log }) {
  const children = new Map();
  let stopping = false;
  const stop = () => { stopping = true; log('stopping after this tick (workers keep running; next dispatcher reclaims or adopts them)'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  for (;;) {
    const started = Date.now();
    try {
      const s = await tick(ctx, { max, children, log });
      const n = (k) => s[k].length;
      log(`tick: reclaimed ${n('reclaimed')} promoted ${n('promoted')} claimed ${n('claimed')} guarded ${n('guarded')} held ${n('held')} skipped ${n('skipped')}`);
    } catch (e) {
      if (e instanceof GhError && e.kind === 'network') log('GitHub unreachable — reclaim clock paused, retrying next tick');
      else log(`tick failed: ${e.message}`);
    }
    if (stopping) break;
    const wait = Math.max(5_000, interval * 1000 - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

export { addLabels };
