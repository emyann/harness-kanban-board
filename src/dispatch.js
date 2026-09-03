// The dispatcher: stateless, idempotent, deterministic. Never an LLM.
// Per tick: replay outbox → reclaim/crash/timeout → promote todo→ready → guards → claim + spawn.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enableAutoMerge, branchProtection, openPrsByHead, mergedPrsByHead, prMergeStates, staleBaseSha, ensureTrackBranch, fillPrs } from './forge.js';
import { openStore, closeStore } from './store/index.js';
import { logsDir, outboxFile, readState, writeState, ensureLocalDirs, ensureWorktree, worktreeOnBranch, remoteName, pidFile, readPidFile, pidAlive, recordExit, clearExit, HOOK_SETTINGS_VAR } from './board.js';
import { workerHookSettings, PKG_ROOT, packageVersion } from './init.js';
import { activePrGuard, computeReady, openAttempt, lastAttempt, lastSignalAt, sortForDispatch, slugify, L, taskBranchRe, classifyJob, parseBackgroundedId, parseSessionLog, sessionUpdate, formatSession, authPauseReason, worktreePath, mergePolicy, autoMergeDecision, mergeGate, mergeGateFix, scrubKbEnv, modelArgs, effectiveTools, pathOverlapGuard, pathHolders, pathCollisions, attemptIdle, isTrackRoot, trackBranchConflict, buildDeniedTools, deniedToolsUpdate } from './model.js';
import { workerContext } from './context.js';
import { planTracks, trackContext, trackPaths, trackAlreadyAttempted, trackFanout } from './track.js';
import { GhError } from './gh.js';
import { listKbJobs, readJobState, stopJob, matchJobByWorktree, jobSessionUpdate } from './jobs.js';
import { tokenExpiryNotice, versionNotice } from './doctor.js';
import { sweep, sweepTask } from './gc.js';
import { deniedToolsFromTranscript } from './stats.js';

/**
 * #130: an attempt is ending (or has just been reaped) and its transcript, if it named one, is on
 * this host's disk — the Stop hook already tried this (src/hook.js), but a crashed or timed-out
 * attempt never fires one, so the dispatcher gets the same one chance here. `a.permission_denials`
 * covers the `--disallowedTools` shape #155 already reads out of the CLI's own result; only the
 * dontAsk-miss and worktree-guard shapes need the transcript read. Mutates `a` in place and reports
 * whether it changed anything, the same contract `sessionUpdate` + `Object.assign` already follow.
 */
function attachDeniedTools(ctx, a) {
  if (!a?.transcript_path) return false;
  const transcriptDenials = deniedToolsFromTranscript(ctx.root, a.transcript_path);
  const deniedTools = buildDeniedTools(a.permission_denials, transcriptDenials);
  const update = deniedToolsUpdate(a, deniedTools);
  if (!update) return false;
  Object.assign(a, update);
  return true;
}

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

/**
 * Render a profile's launch template. `{allowed_tools}` is *not* read off the profile here: the
 * tool list comes from `effectiveTools` (src/model.js), the one place that derives what a worker
 * may use. Pass the card and the board config as `ctx` and the card's narrowing applies; pass
 * neither — every existing caller — and the profile's grant expands exactly as it always did.
 * What the narrowing took away is `effectiveTools`'s `dropped`; `spawnWorker` reports it.
 */
export function expandLaunch(template, vars, profile, { task = null, board = null } = {}) {
  const { tools } = effectiveTools(profile, task, board);
  const out = [];
  for (const el of template) {
    if (el === '{allowed_tools}') { out.push(...tools); continue; }
    // `--allow-tool={allowed_tools}` → one `--allow-tool <pattern>` pair per entry, for harnesses
    // that repeat the flag instead of taking a list (Copilot CLI).
    const perTool = /^(--[\w-]+)=\{allowed_tools\}$/.exec(el);
    if (perTool) { for (const t of tools) out.push(perTool[1], t); continue; }
    if (el === '{model_args}') { out.push(...modelArgs(vars)); continue; }
    // hkb's hooks, on the launch instead of in a settings file every session in the repo reads
    // (#144). A flag pair or nothing, like `{model_args}`: an empty value would still be a `--settings`
    // Claude Code has to parse, and a board with no hkb to run has nothing to declare.
    if (el === HOOK_SETTINGS_VAR) { if (vars.hook_settings) out.push('--settings', vars.hook_settings); continue; }
    // Embedded rather than a bare element — `--settings={hook_settings}` — is refused rather than
    // silently mishandled: the generic substitution below would render a bare `--settings=` on a
    // board with no hkb to run, which is a flag Claude Code still has to parse.
    if (el.includes(HOOK_SETTINGS_VAR)) {
      const err = new Error(`launch template "${el}" embeds ${HOOK_SETTINGS_VAR} inside a larger token; ` +
        `use it as its own element ("--settings", "${HOOK_SETTINGS_VAR}") so an empty value drops the flag instead of rendering "--settings="`);
      err.exitCode = 2;
      throw err;
    }
    out.push(el.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')));
  }
  return out;
}

/**
 * Say what the card asked for and did not get. A worker under `--permission-mode dontAsk` meets a
 * narrowed grant as a silent refusal, so the tick names the drop at spawn time instead.
 */
function logDroppedTools(task, profileName, spawned, log) {
  const dropped = spawned?.tools_dropped || [];
  if (!dropped.length || typeof log !== 'function') return;
  log(`#${task.number}: dropped ${dropped.map((d) => `${d.tool} (${d.source})`).join(', ')} — the ${profileName} profile does not grant it; a card narrows, never widens`);
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
  /** @type {{ok: boolean, path?: string, branch?: string|null, freed?: string|null, stale?: string|null, dry?: boolean, why?: string}|null} */
  const cont = !continuePr
    ? null
    : dryRun
      ? { ok: !!continuePr.headRefName, branch: continuePr.headRefName || null, dry: true, why: 'the board query returned no head branch for the PR' } // a dry run creates nothing, and prints the command it would run
      : worktreeOnBranch(ctx.root, name, continuePr.headRefName, { number: task.number, remote: remoteName(ctx), alive: pidAlive });
  const prompt = given ?? (await workerContext(ctx, task, attempt, {
    continuePr: continuePr && { number: continuePr.number, branch: continuePr.headRefName || null, base: continuePr.baseRefName || null, checkedOut: !!cont?.ok && !cont.stale, stale: cont?.ok ? cont.stale : null },
  }));
  // Harnesses without a worktree flag (Copilot CLI, Codex) declare `workspace: "worktree"`; the
  // dispatcher makes the checkout and runs them in it. Everything else runs at the board root and
  // isolates itself — unless this attempt continues a PR, where the dispatcher owns the checkout for
  // every harness. `{worktree}` is that directory as an absolute path, for a harness that wants it
  // as an argument too (`codex exec -C <dir>`) — known before the checkout exists, so `--dry-run`
  // prints the real command without creating anything.
  const ownsWt = profile.workspace === 'worktree';
  const wt = ownsWt || cont?.ok ? name : null;
  // `hook_settings` is asked for only by a launch that carries the placeholder — it shells out to
  // find `hkb` on PATH, and a Copilot or Codex spawn has no use for the answer.
  const vars = {
    n: task.number, k: attempt, slug: slugify(task.title), title: task.title.replace(/[\r\n]+/g, ' ').slice(0, 80),
    model: task.kb.model || profile.model || '', effort: profile.effort || '', prompt, board: ctx.board, repo: ctx.repo.nameWithOwner,
    worktree: wt ? path.join(ctx.root, worktreePath(wt)) : ctx.root,
    hook_settings: (profile.launch || []).includes(HOOK_SETTINGS_VAR) ? workerHookSettings() : '',
  };
  // The card is part of the launch's tool derivation now (`effectiveTools`, src/model.js): it can
  // narrow the profile's grant, never widen it. `dropped` rides out on the result so the tick can
  // say what a card asked for and did not get, instead of a worker discovering it as a refusal.
  const launchCtx = { task, board: ctx.cfg };
  const { dropped: toolsDropped } = effectiveTools(profile, task, ctx.cfg);
  const argv = cont?.ok && !ownsWt
    ? withoutWorktreeFlag(expandLaunch(profile.launch, vars, profile, launchCtx))
    : expandLaunch(profile.launch, vars, profile, launchCtx);
  const continued = continuePr && { pr: continuePr.number, branch: cont?.ok ? cont.branch : null, why: cont ? (cont.ok ? cont.stale : cont.why) : null };
  // The launch environment is the worker's identity for every harness we run as a child process:
  // it dies with that process. `claude --bg` is the exception — it hands the request to Claude
  // Code's session daemon and exits, and a launch that finds no daemon *starts* one, which then
  // keeps this environment for its whole life and hands it to every session it hosts (#150). It
  // reaches no worker there anyway (#125: the checkout is that profile's identity), so it goes.
  const env = profile.mode === 'claude-bg' ? scrubKbEnv(process.env) : {
    ...process.env,
    KB_TASK: String(task.number), KB_ATTEMPT: String(attempt), KB_BOARD: ctx.board, KB_REPO: ctx.repo.nameWithOwner,
    KB_ROOT: ctx.root, KB_PROFILE: profileName,
  };
  if (dryRun) return { argv, pid: null, continued, tools_dropped: toolsDropped };
  ensureLocalDirs(ctx.root);
  const cwd = wt ? ensureWorktree(ctx.root, wt) : ctx.root;
  const logFile = path.join(logsDir(ctx.root), `${task.number}-${attempt}.log`);
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
    return { argv, pid: null, bg: true, wt: name, logFile, continued, tools_dropped: toolsDropped };
  }
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `# ${nowIso()} spawn ${argv[0]} for #${task.number} attempt ${attempt}${wt ? ` in ${worktreePath(wt)}` : ''}\n`);
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', () => { /* handled via exit code below */ });
  fs.closeSync(fd); // the child holds its own copy
  if (!keepRef) child.unref(); // one-shot dispatch must not wait for the worker
  return { argv, pid: child.pid, child, wt, logFile, continued, tools_dropped: toolsDropped };
}

// ---------- reconcile merged pull requests ----------
// A merged PR is what finishes a card, and nothing tells hkb about it: the board is local, no issue
// is linked to the pull request, and the merge happens on the forge — by `hkb merge`, by GitHub's
// auto-merge, or by a person pressing the button. So the tick looks: one listing of merged PRs,
// matched to cards by head branch, and a card still in a live status whose branch merged becomes
// `done` here.

/** Live statuses — a card wearing one of these whose PR has merged is behind the forge. */
export const RECONCILE_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review'];

/**
 * What a merged PR does to its card. Pure: `null` means "nothing to do".
 *
 * `mergedByHead` is `mergedPrsByHead(ctx)` (src/forge.js) and the match is `taskBranchRe` — the same
 * one definition of "this card's branch" the `active_pr` guard and the terminal verbs use. A card
 * that is already `done` or `archived` is not in `RECONCILE_STATUSES` and is left alone, so the pass
 * is idempotent: the second tick after a merge finds nothing to do.
 */
export function reconcileDecision(task, mergedByHead) {
  if (!task || !RECONCILE_STATUSES.includes(task.status)) return null;
  const re = taskBranchRe(task.number);
  for (const [head, pr] of mergedByHead || []) {
    if (!re.test(head)) continue;
    return { status: 'done', outcome: 'completed', reason: `PR #${pr.number} merged (${head})`, pr };
  }
  return null;
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

async function reconcileMerged(ctx, tasks, state, { dryRun = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  const gate = shouldReconcile(tasks, state.reconcile);
  if (!gate.run) return { skipped: gate.why, reconciled: [] };
  const store = await openStore(ctx);
  // One request, whatever the board's size. `mergedPrsByHead` reads a page of closed PRs
  // newest-updated first, which is where a PR that merged since the last tick is.
  const mergedByHead = await mergedPrsByHead(ctx);
  const reconciled = [];
  for (const t of tasks) {
    const d = reconcileDecision(t, mergedByHead);
    if (!d) continue;
    if (dryRun) { reconciled.push({ number: t.number, from: t.status, status: d.status, dry: true }); log(`#${t.number}: [dry-run] ${t.status} → ${d.status} (${d.reason})`); continue; }
    const from = t.status;
    const runRec = await store.loadRun(t.number);
    const a = closeAttemptForReconcile(runRec.run, d, nowIso());
    if (a) {
      await store.saveRun(t.number, runRec);
      await store.release(t.number, a.attempt);
    }
    await store.setStatus(t, d.status, { remove: t.needsHuman ? [L.needsHuman] : [] });
    if (t.state !== 'CLOSED') await store.closeTask(t.number, 'completed');
    const entry = { number: t.number, from, status: d.status, outcome: d.outcome, attempt: a?.attempt ?? null, pr: d.pr?.number ?? null };
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
export async function autoMergePass(ctx, tasks, { dryRun = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
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

/**
 * Two children conflicting on their way into a track branch, surfaced as a board event rather than
 * left for a human to discover in the PR list — the trigger the design settled on: a conflict is the
 * one thing that means the assembled whole needs a look, and it is a signal GitHub already computes
 * (`mergeable`/`mergeStateStatus`) rather than a judgement hkb has to make. One tick per running
 * track root that has a branch recorded, and at most once per attempt: `kb:needs-human` is the event
 * (`hkb watch`'s `needs-human` kind reports it the moment the label lands), and the comment is the
 * record a human resolving it will read.
 */
export async function trackConflictPass(ctx, tasks, { dryRun = false, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  const out = [];
  const roots = tasks.filter((t) => t.status === 'running' && !t.needsHuman && isTrackRoot(t, ctx.cfg, { board: tasks }).track);
  if (!roots.length) return out; // most ticks: no track root, so nothing here needs a store at all
  const store = await openStore(ctx);
  for (const root of roots) {
    const runRec = await store.loadRun(root.number);
    const last = lastAttempt(runRec.run);
    if (!last?.track || last.ended_at || !last.track_branch || last.track_conflict_notified) continue;
    const branch = last.track_branch;
    const byHead = await openPrsByHead(ctx);
    const candidates = [...byHead.values()].filter((p) => p.baseRefName === branch);
    if (candidates.length < 2) continue;
    const states = await prMergeStates(ctx, candidates.map((p) => p.number));
    const conflicting = trackBranchConflict(states);
    if (!conflicting) continue;
    const detail = `${conflicting.map((n) => `#${n}`).join(' and ')} conflict merging into \`${branch}\` — a human needs to reconcile them before more children land.`;
    if (dryRun) { out.push({ root: root.number, branch, conflicting, dry: true }); log(`#${root.number}: [dry-run] would flag a track conflict on ${branch}: ${conflicting.join(', ')}`); continue; }
    await store.addNote(root.number, `track conflict: ${detail}`);
    await store.addLabels(root, [L.needsHuman]);
    root.needsHuman = true;
    last.track_conflict_notified = true;
    await store.saveRun(root.number, runRec);
    out.push({ root: root.number, branch, conflicting });
    log(`#${root.number}: track conflict flagged on ${branch}: ${conflicting.join(', ')}`);
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
  /** @type {(streak?: number, error?: string|null) => {action:'none'|'drop_caches'|'exit', streak:number, error:string|null}} */
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

/**
 * Forget every card's comments memo at the top of a tick: `base` (the branch sha) and `mergeGate`
 * are legitimately per-process for the life of the loop, but `comments:<n>` is a run record, and a
 * long-lived loop must not judge card #n on comments it fetched three ticks ago. A worker's
 * `finish`/`block`, an operator's `request-changes`/`unblock`, all write from another process and
 * are otherwise invisible to a loop that already read #n once (see #195).
 */
export function dropCommentCaches(ctx) {
  for (const key of Object.keys(ctx._cache)) if (key.startsWith('comments:')) delete ctx._cache[key];
  // `prsByHead` is the same kind of thing: the open-PR listing behind `fillPrFallback`, memoized so
  // a verb that reads several cards pays for one. It is a tick's worth of truth, never a loop's —
  // a PR opened by a worker last tick must be visible to this one.
  delete ctx._cache.prsByHead;
  delete ctx._cache.prsByHeadAll;
}

// ---------- tick ----------

async function failAttempt(ctx, store, task, runRec, outcome, note, { kill = true } = {}) {
  const a = openAttempt(runRec.run);
  // `protocol_violation` means "no terminal verb landed" — but a worker that pushed and opened a
  // PR before losing its verb did the work; only the report failed. Stamping the PR onto the row
  // is what tells that apart from a genuine no-show (#116), and it must not spend the retry budget.
  const openPr = outcome === 'protocol_violation' ? (task.prs || []).find((p) => p.state === 'OPEN') : null;
  if (a) {
    if (kill && a.host === ctx.host && a.job && !a.job_stopped) { stopJob(a.job); a.job_stopped = true; }
    else if (kill && a.host === ctx.host && a.pid) killPid(a.pid);
    a.ended_at = nowIso();
    a.outcome = outcome;
    if (note) a.reason = String(note).slice(0, 300);
    if (openPr) a.pr = openPr.number;
    await store.release(task.number, a.attempt);
  }
  if (!openPr) runRec.run.failures = (runRec.run.failures || 0) + 1;
  runRec.run.last_error = note || outcome;
  const limit = task.kb.max_retries ?? ctx.cfg.dispatch.failure_limit;
  if (runRec.run.failures > limit) {
    runRec.run.attempts.push({ attempt: runRec.run.attempts.length + 1, profile: 'dispatcher', host: ctx.host, started_at: nowIso(), ended_at: nowIso(), outcome: 'gave_up', reason: `${runRec.run.failures} consecutive failures (limit ${limit})`, synthetic: true });
    await store.saveRun(task.number, runRec);
    await store.setStatus(task, 'blocked', { add: [L.needsHuman] });
    return 'gave_up';
  }
  await store.saveRun(task.number, runRec);
  // back where readiness says it belongs, not blindly to `ready`: a track root is claimed while its
  // nodes are still open, and a failed track attempt must leave it in *todo* behind them.
  await store.setStatus(task, computeReady(task) ? 'ready' : 'todo');
  return outcome;
}

export async function tick(ctx, { max = Infinity, dryRun = false, children = null, profiles = null, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  ctx.requireBoard();
  dropCommentCaches(ctx);
  const d = ctx.cfg.dispatch;
  const summary = { reconciled: [], reclaimed: [], promoted: [], guarded: [], claimed: [], spawn_failed: [], held: [], skipped: [], tracks: [], reaped: [], self_heal: [], auto_merge: [], fatal: null };
  const pog = pathOverlapGuard(ctx.cfg);
  if (pog.error) log(`dispatch.guards.path_overlap ignored — the guard stays off: ${pog.error}`);
  // The tick is the lifetime of every read the tick memoizes: the base sha is revalidated (304 when
  // the branch has not moved) the first time a claim needs it, never inherited from an older tick.
  staleBaseSha(ctx);
  // A host claims only what it can launch. `--profiles` is how one host takes the cards for the
  // harnesses it has installed and leaves the rest alone; everything else in the tick — reclaim,
  // promote, reconcile, the orphan sweep — still covers the whole board.
  const dispatchable = (name) => !profiles || profiles.includes(name);
  const state = readState(ctx.root);
  const today = nowIso().slice(0, 10);
  if (state.spawn_day !== today) { state.spawn_day = today; state.spawned_today = 0; }
  state.profile_paused_until = state.profile_paused_until || {};
  // GitHub reads can lag writes by seconds. Remember what THIS host changed recently and refuse to
  // contradict it: a task touched < 90 s ago is skipped, a lock claimed < 15 min ago is never swept.
  state.touched = state.touched || {};
  state.claims = state.claims || {};
  state.idle_logged = state.idle_logged || {}; // path_overlap idle line: once per attempt, not once per tick
  for (const [k, v] of Object.entries(state.claims)) if (Date.now() - new Date(v).getTime() > 86_400_000) delete state.claims[k];
  for (const [k, v] of Object.entries(state.idle_logged)) if (Date.now() - new Date(v).getTime() > 86_400_000) delete state.idle_logged[k];
  const touchedRecently = (n) => state.touched[n] && Date.now() - new Date(state.touched[n]).getTime() < 90_000;
  const touch = (n) => { state.touched[n] = nowIso(); };

  if (!dryRun) replayOutbox(ctx, log);

  const store = await openStore(ctx);
  // The board comes from the store; the pull requests come from the forge and are joined to it by
  // head branch (`fillPrs`, src/forge.js). One listing per tick, for the `active_pr` guard, the
  // auto-merge pass and every card the tick renders.
  const tasks = await fillPrs(ctx, await store.listTasks());
  // **Where else is absence a verdict?** Two sweeps below decide from a card *not being here* — the
  // reap (`reapDecision(j, null)` stops a background agent and sweeps its checkout) and the orphan
  // lock sweep (a lock whose card is missing is released, and a worker whose lock ref disappears
  // exits LOCK_LOST). That is the shape that made `gc.sweep` destructive on an empty read, and it
  // was audited here rather than waiting for a report. It is deliberately **not** guarded the same
  // way, because the precondition differs: `fetchBoard` returns the *open* board, so "no cards" is
  // an ordinary, correct state — a board whose last card just closed — and gating on it would stop
  // reaping exactly the agent that closing card left behind. `gc.sweep` reads OPEN *and* CLOSED,
  // where empty really is anomalous. What makes absence safe here is that `fetchBoard` throws on a
  // read it could not make rather than answering `[]`, and (since this round) no inference can point
  // this tick at a store the cards are not on.
  const running = tasks.filter((t) => t.status === 'running');
  // Tracks, from the board read we already have. `covered` is every node a live runner owns: the
  // reclaim below leaves them alone (the root's own heartbeat is their liveness), they cost no
  // slot (a track is one session), and the selection at the end does not try to claim them.
  const plan = planTracks(tasks, ctx.cfg, { board: ctx.board });
  const coveredBy = plan.covered;

  // 0. reconcile the cards whose pull request merged on the forge. One extra request, gated.
  try {
    const r = await reconcileMerged(ctx, tasks, state, { dryRun, log });
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
  try { locks = await store.listLocks(); } catch (e) { log(`lock listing failed (reclaim falls back to the run comment): ${e.message}`); }
  // `token`, not `sha`: §6.4 calls it a token because a store that is not GitHub does not keep one.
  const lockRowOf = (n, k) => (locks || []).find((l) => l.n === n && l.k === k) || null;
  /**
   * When this attempt last beat, out of the listing above — and **never a request the listing has
   * already paid for or made pointless**.
   *
   * No row means either the listing failed or this attempt holds no lock; either way there is
   * nothing to read, and asking anyway is one extra REST call per running card per tick, on exactly
   * the tick that already failed. A row that carries `beat_at` (the local store answers with it) is
   * the answer. Only GitHub's row — a token and no date — is worth the commit read.
   */
  const beatAtOf = async (n, k) => {
    const row = lockRowOf(n, k);
    if (!row) return null;
    if (row.beat_at) return row.beat_at;
    if (!row.token) return null;
    return store.lockBeatAt(n, k, row.token);
  };

  // 1. reclaim stale / crashed / timed out / finished without a terminal verb
  // `idleNumbers` doubles as the path_overlap guard's liveness check (#185): a running task whose
  // attempt has gone idle — no job, no live pid, and no heartbeat for well past its cadence — must
  // never hold its paths against another card, whatever the guard's mode. Computed here because the
  // job record, pid, and heartbeat are already in hand for every running task this loop visits; a
  // track node (covered by its root) never enters this loop, so it is never marked idle — the
  // root's own heartbeat is its liveness, same as everywhere else in the tick.
  const idleNumbers = new Set();
  for (const t of running) {
    if (touchedRecently(t.number)) continue; // our own transition may not be visible yet
    // a node inside a live track: its session is the root's, and the root's lock is what says
    // "alive". It has no pid and no job of its own, so every check below would call it crashed.
    if (coveredBy.has(t.number)) { log(`#${t.number}: node of running track #${coveredBy.get(t.number)} — the root's heartbeat covers it`); continue; }
    const runRec = await store.loadRun(t.number);
    const a = openAttempt(runRec.run);
    if (!a) {
      // running label but no open attempt: orphaned card → reconcile
      if (!dryRun) await store.setStatus(t, computeReady(t) ? 'ready' : 'todo');
      summary.reclaimed.push({ number: t.number, outcome: 'reconciled' });
      continue;
    }
    const maxRuntime = t.kb.max_runtime || d.max_runtime_default;
    let lastSignal = a.heartbeat_at || a.started_at;
    let outcome = null;
    // edits to the row that are not an outcome (the job id, the session behind it): saved once,
    // below, and only when nothing else is about to save the record anyway.
    let dirty = false;
    // Nothing local to inspect, so the heartbeat and max_runtime are the whole check — the no-handle
    // rules further down would call a perfectly live attempt crashed three minutes in. `manual` means
    // a human claimed it by hand (`hkb claim <n>` with no `--spawn`) and is working it in their own
    // terminal, so there is no pid the dispatcher ever knew. `remote` is the same shape written by an
    // hkb that still had the Actions runner: the mode is gone but those rows live in run records this
    // release inherits, so they are read here even though nothing writes them any more.
    let job = null; // the matched background-agent job, when this attempt has one — the idle check below reuses it
    if (a.manual || a.remote) { /* liveness is the heartbeat */ }
    else if (a.host === ctx.host && (a.job || a.bg)) {
      job = a.job ? (jobsById.get(a.job) || readJobState(a.job)) : null;
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
        // The job the tick matched to this attempt outranks whatever stamped the row: a hook fires
        // in whichever session had `KB_TASK` in its environment, and that is not always this one
        // (#150). Say so when it happens — a rewritten session id is the kind of correction an
        // operator must be able to find afterwards.
        const wrong = a.session_id && session.session_id && session.session_id !== a.session_id ? a.session_id : null;
        Object.assign(a, session);
        dirty = true;
        log(`#${t.number}: attempt ${a.attempt} ${formatSession(a)}${wrong ? ` — corrected: the row named session ${wrong}, which is not the session job ${a.job || job.id} is running` : ''}`);
      }
      if (!job) {
        if (secondsSince(a.started_at) > 180) outcome = 'crashed'; // cold daemon start gets 3 min to register
      } else if (classifyJob(job) !== 'running' && secondsSince(a.started_at) > 30) outcome = 'protocol_violation';
    } else if (a.host === ctx.host && a.pid && !pidAlive(a.pid)) outcome = 'crashed';
    else if (a.host === ctx.host && !a.pid && !a.job && secondsSince(a.started_at) > 180) outcome = 'crashed'; // spawn never recorded a handle
    // A live pid is as authoritative as a live job (#185, second pass): a `process` worker never
    // touches the run comment either between heartbeats, so `lastSignal` alone would call it idle on
    // the same schedule a bg attempt was. `process.kill(pid, 0)` costs nothing and settles it outright.
    const livePid = a.host === ctx.host && !!a.pid && pidAlive(a.pid);
    if (!outcome && secondsSince(a.started_at) > maxRuntime) outcome = 'timed_out';
    else if (!outcome && secondsSince(lastSignal) > d.stale_after) {
      // A ref-CAS worker writes nothing to the run comment, so its real last signal is the commit
      // its lock ref points at. One commit read, and only for an attempt that already looks stale.
      let beat = null;
      try { beat = await beatAtOf(t.number, a.attempt); } catch (e) { log(`#${t.number}: lock ref beat unreadable (${e.message}); using the run comment`); }
      lastSignal = lastSignalAt(a, beat);
      if (secondsSince(lastSignal) > d.stale_after) outcome = 'reclaimed';
      else log(`#${t.number}: attempt ${a.attempt} beat on ${store.lockRef?.(t.number, a.attempt) || `claim ${t.number}/${a.attempt}`} ${Math.round(secondsSince(lastSignal))}s ago — alive`);
    }
    // A no-job, no-pid attempt (manual, or a bg job on another host) has nothing but its
    // heartbeat to ask, and the ref-CAS default never touches the run comment until the reclaim
    // check above already thought it looked stale — which only fires past `stale_after`. Give the
    // idle threshold, well inside `stale_after`, the same fresher read: one lock-ref commit read,
    // only for an attempt that would otherwise be called idle on a stale run-comment timestamp.
    const idleThreshold = Math.max(d.interval, 1200);
    if (!outcome && !job && !livePid && secondsSince(lastSignal) > idleThreshold && secondsSince(lastSignal) <= d.stale_after) {
      let beat = null;
      try { beat = await beatAtOf(t.number, a.attempt); } catch (e) { log(`#${t.number}: lock ref beat unreadable for the idle check (${e.message}); using the run comment`); }
      lastSignal = lastSignalAt(a, beat);
    }
    if (!outcome) {
      // A job-bearing attempt's liveness comes from the job record; a pid-bearing one from the pid
      // itself. Only an attempt with neither falls back to timing a signal — the two-tick-plus
      // threshold matches the ~10-minute heartbeat floor a `comment`-mode worker beats on.
      if (attemptIdle(job, lastSignal, idleThreshold, Date.now(), livePid)) {
        idleNumbers.add(t.number);
        const key = `${t.number}/${a.attempt}`;
        if (!state.idle_logged[key]) {
          // A dry run must never persist this — it would silence the real loop's one log line for
          // an attempt it never actually saw go idle (#185, second pass).
          if (!dryRun) state.idle_logged[key] = nowIso();
          log(`#${t.number}: attempt ${a.attempt} idle since ${lastSignal || a.started_at} — path_overlap will not hold its paths`);
        }
      } else if (!dryRun) {
        delete state.idle_logged[`${t.number}/${a.attempt}`];
      }
      if (dirty) await store.saveRun(t.number, runRec);
      continue;
    }
    if (dryRun) { summary.reclaimed.push({ number: t.number, outcome, dry: true }); continue; }
    // A pid-mode attempt has no job record to name its session (line ~593 above does that for a bg
    // one) — but its own log ends the same way, so a `crashed`/`timed_out` row gets session and cost
    // the way a `--bg` row has since #137, and now `terminal_reason` too (#155).
    if (a.host === ctx.host && a.pid && !job && a.log) {
      let session = null;
      try { session = sessionUpdate(a, parseSessionLog(tailLog(ctx, a.log, 200_000))); } catch { /* unreadable log */ }
      if (session) Object.assign(a, session);
      try { attachDeniedTools(ctx, a); } catch { /* unreadable transcript */ }
    }
    // failAttempt saves the same record, so a row written off in the tick that named its session
    // costs one write, not two — and goes to its post-mortem carrying the session.
    const result = await failAttempt(ctx, store, t, runRec, outcome, `${outcome} after ${Math.round(secondsSince(a.started_at))}s`);
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
      const runRec = t ? await store.loadRun(l.n) : null;
      const a = runRec ? runRec.run.attempts.find((x) => x.attempt === l.k) : null;
      const stale = !a || (a.ended_at && secondsSince(a.ended_at) > 600) || (!t && true);
      // `ref` names where the claim lived on a store that has such a name; the attempt is the answer
      // every store can give, so the line reads the same on a board that keeps its locks in a table.
      if (stale && !dryRun) { await store.release(l.n, l.k); log(`orphan lock ${l.ref || `#${l.n} attempt ${l.k}`} released`); }
    }
  } catch (e) { log(`lock sweep skipped: ${e.message}`); }

  // 2. promote todo → ready when all blockers are done
  for (const t of tasks.filter((x) => x.status === 'todo')) {
    if (!computeReady(t)) continue;
    if (!dryRun) await store.setStatus(t, 'ready');
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
  // a running *track* spends the track profile's slot, not its card's: an inferred root keeps
  // `kb:agent:claude` while its session is the claude-track launch, and the cap that has to hold is
  // the one whose launch is running.
  for (const t of sessions) {
    const p = (t.status === 'running' && plan.profiles.get(t.number)) || t.agent;
    perProfile[p] = (perProfile[p] || 0) + 1;
  }
  let slots = Math.max(0, d.max_in_progress - sessions.length);
  let budget = Math.min(max, slots);
  const ready = sortForDispatch(tasks.filter((t) => t.status === 'ready'));
  // path_overlap's holders, under the board's effective mode — see `pathOverlapGuard`. `idleNumbers`
  // (computed in the reclaim pass above) already drops a running task whose attempt has gone idle;
  // a card just claimed this same tick is pushed on below, always a holder, never idle.
  const claimedPaths = pathHolders(tasks, pog.mode, idleNumbers).map((t) => ({ number: t.number, paths: t.kb.paths || [] }));

  // Why this card cannot be dispatched, or null. A profile hkb removed (ADR-006) names the re-point;
  // an unknown one names the flag that adds it; a profile with no launch template would otherwise be
  // claimed and then spawn-fail every tick until the retry budget is gone.
  const undispatchable = (t, profileName, profile) => {
    const removed = (ctx.cfg.removed_profiles || []).find((r) => r.name === profileName);
    if (removed) return `profile ${profileName} was removed: ${removed.why} — \`hkb adopt ${t.number} --agent claude --status ${t.status}\` re-points this card`;
    if (!profile) return `unknown profile ${profileName} — \`hkb init --profiles ${profileName}\` adds it to board.json`;
    if (!(profile.launch || []).length) return `profile ${profileName} has no launch template in board.json — nothing to spawn`;
    return null;
  };
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
    const note = (why, extra = {}) => { summary.tracks.push({ root: t.number, nodes: cand.track.nodes.map((x) => x.number), ok: false, why, mode: cand.mode || 'none', ...extra }); };
    if (!cand.ok) { note(cand.why); continue; }
    if (touchedRecently(t.number)) { note('touched recently (stale-read guard)'); continue; }
    if (budget <= 0) { note('no slot'); continue; }
    if ((state.spawned_today || 0) >= d.daily_spawn_cap) { note(`daily spawn cap ${d.daily_spawn_cap}`); continue; }
    // an inferred track runs on the board's track profile while the card keeps its own agent label:
    // the label is what node dispatch reads if this ever falls back, so the decision never rewrites it.
    const profileName = cand.profile || t.agent;
    const profile = ctx.cfg.profiles[profileName];
    const trackWhy = undispatchable(t, profileName, profile);
    if (trackWhy) { note(trackWhy); continue; }
    if (!dispatchable(profileName)) { note(`profile ${profileName} is not dispatched from this host`); continue; }
    if ((perProfile[profileName] || 0) >= (profile.max_in_progress ?? Infinity)) { note(`profile ${profileName} at cap`); continue; }
    const pausedUntil = state.profile_paused_until[profileName];
    if (pausedUntil && new Date(pausedUntil) > new Date()) { note('blocker_auth pause', { until: pausedUntil }); continue; }
    const runRec = await store.loadRun(t.number);
    // one go per root: a track attempt that ended without finishing the track hands the remaining
    // nodes back to the durable engine, which is the whole point of checkpointing every node.
    if (trackAlreadyAttempted(runRec.run)) { note('a track attempt already ran — node dispatch takes it from here'); continue; }
    const last = lastAttempt(runRec.run);
    if (last?.outcome === 'completed' && secondsSince(last.ended_at) < d.recent_success_window) { note('recent_success'); continue; }
    const paths = trackPaths(cand.track);
    const collides = pog.mode !== 'off' && paths.length ? pathCollisions(paths, claimedPaths) : [];
    if (collides.length) {
      note('path_overlap', { collides_with: collides });
      log(`#${t.number}: track guarded (path_overlap, ${pog.mode}) — collides with ${collides.map((c) => `#${c.number} (${c.paths.join(', ')})`).join('; ')}`);
      continue;
    }

    const nodes = cand.track.nodes.map((x) => x.number);
    const k = runRec.run.attempts.length + 1;
    if (dryRun) {
      summary.tracks.push({ root: t.number, nodes, ok: true, attempt: k, profile: profileName, mode: cand.mode, dry: true });
      claimedTracks.add(t.number);
      for (const nn of nodes) coveredBy.set(nn, t.number); // a dry run must report the same board as a real one
      log(`#${t.number}: [dry-run] would run track ${[...nodes, t.number].map((x) => `#${x}`).join(' → ')} as one ${profileName} session (${cand.mode})`);
      budget--;
      continue;
    }
    const c = await store.claim(t.number, k);
    if (selfHeal(t.number, c)) { note(`claim unknown: ${c.error?.kind}`); break; }
    if (c.result === 'claimed') { state.claims[`${t.number}/${k}`] = nowIso(); touch(t.number); }
    if (c.result === 'held') { summary.held.push(t.number); note('lock held elsewhere'); log(`#${t.number}: track lock held elsewhere, skipping`); continue; }
    if (c.result === 'unknown') {
      log(`#${t.number}: track claim result unknown (${c.error?.kind}: ${c.error?.message}); backing off this tick`);
      note(`claim unknown: ${c.error?.kind}`);
      if (c.error?.kind === 'ratelimit' || c.error?.kind === 'auth') break;
      continue;
    }
    // The track branch is created here, at claim time, from the default branch — before anything
    // is spawned, so a node's own brief can name it outright rather than derive it. It is recorded
    // on the attempt row (`track_branch`) so a runner that dies never strands work nothing can find:
    // the board, not the runner's head, is where the branch lives (docs/wiki/features/tracks.md).
    let trackBranch;
    try {
      trackBranch = await ensureTrackBranch(ctx, t.number);
    } catch (e) {
      log(`#${t.number}: track branch could not be created: ${e.message}`);
      await store.release(t.number, k);
      note(`track branch: ${e.message}`);
      continue;
    }
    const attempt = /** @type {HkbAttempt} */ ({ attempt: k, profile: profileName, host: ctx.host, started_at: nowIso(), heartbeat_at: nowIso(), pid: null, track: true, track_mode: cand.mode, track_nodes: nodes, track_branch: trackBranch });
    runRec.run.attempts.push(attempt);
    await store.saveRun(t.number, runRec);
    await store.setStatus(t, 'running', { remove: [L.needsHuman] });
    let spawned;
    try {
      spawned = await spawnWorker(ctx, t, profileName, k, {
        keepRef: !!children,
        prompt: trackContext({ repo: ctx.repo.nameWithOwner, board: ctx.board, track: cand.track, attempt: k, waves: cand.waves, fanout: trackFanout(ctx.cfg, profileName, t), trackBranch, defaultBranch: ctx.cfg.default_branch || 'main' }),
      });
      if (!spawned.pid && !spawned.bg) throw new Error('spawn returned neither a pid nor a background launch');
    } catch (e) {
      log(`#${t.number}: track spawn failed: ${e.message}`);
      // the runner never started, so the fast engine has not had its go: drop the marker that
      // would otherwise hand the whole subgraph to node dispatch over a missing binary.
      delete attempt.track;
      attempt.track_spawn_failed = true;
      await failAttempt(ctx, store, t, runRec, 'spawn_failed', e.message, { kill: false });
      summary.spawn_failed.push({ number: t.number, error: e.message, track: true });
      // hold the nodes for one tick so the retry still has a track to run. A launch this host
      // cannot start eventually exhausts max_retries, parks the root for a human, and *then* the
      // nodes are free — falling back to node dispatch through the ordinary escalation.
      for (const nn of nodes) coveredBy.set(nn, t.number);
      continue;
    }
    attempt.pid = spawned.pid;
    if (spawned.bg) attempt.bg = true;
    if (spawned.wt) attempt.wt = spawned.wt;
    attempt.log = path.relative(ctx.root, spawned.logFile);
    await store.saveRun(t.number, runRec);
    state.spawned_today = (state.spawned_today || 0) + 1;
    perProfile[profileName] = (perProfile[profileName] || 0) + 1;
    claimedPaths.push({ number: t.number, paths });
    for (const nn of nodes) coveredBy.set(nn, t.number); // the loop below must leave them to the runner
    claimedTracks.add(t.number);
    budget--;
    summary.tracks.push({ root: t.number, nodes, ok: true, attempt: k, profile: profileName, mode: cand.mode, pid: spawned.pid, wt: spawned.wt || null });
    log(`#${t.number}: claimed track attempt ${k} → ${profileName} (${cand.mode}), ${nodes.length + 1} nodes ${[...nodes, t.number].map((x) => `#${x}`).join(' → ')} (log ${attempt.log})`);
    logDroppedTools(t, profileName, spawned, log);
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
      runRec = await store.loadRun(t.number);
      const g = activePrGuard(runRec.run.attempts, t.prs);
      if (g.guard) {
        if (!dryRun) await store.setStatus(t, 'review');
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
    const why = undispatchable(t, profileName, profile);
    if (why) { summary.skipped.push({ number: t.number, why }); continue; }
    if (!dispatchable(profileName)) { summary.skipped.push({ number: t.number, why: `profile ${profileName} is not dispatched from this host` }); continue; }
    if ((perProfile[profileName] || 0) >= (profile.max_in_progress ?? Infinity)) { summary.skipped.push({ number: t.number, why: `profile ${profileName} at cap` }); continue; }
    // remaining guards (these read the run comment, so only for tasks that could actually be claimed)
    const pausedUntil = state.profile_paused_until[profileName];
    if (pausedUntil && new Date(pausedUntil) > new Date()) { summary.guarded.push({ number: t.number, guard: 'blocker_auth', until: pausedUntil }); continue; }
    runRec = runRec || await store.loadRun(t.number);
    const last = lastAttempt(runRec.run);
    if (last?.outcome === 'completed' && secondsSince(last.ended_at) < d.recent_success_window) { summary.guarded.push({ number: t.number, guard: 'recent_success' }); continue; }
    const pathCollides = pog.mode !== 'off' && (t.kb.paths || []).length ? pathCollisions(t.kb.paths, claimedPaths) : [];
    if (pathCollides.length) {
      summary.guarded.push({ number: t.number, guard: 'path_overlap', collides_with: pathCollides });
      log(`#${t.number}: guarded (path_overlap, ${pog.mode}) — collides with ${pathCollides.map((c) => `#${c.number} (${c.paths.join(', ')})`).join('; ')}`);
      continue;
    }
    if (t.kb.scheduled_at && new Date(t.kb.scheduled_at) > new Date()) { summary.skipped.push({ number: t.number, why: 'scheduled later' }); continue; }

    const k = runRec.run.attempts.length + 1;
    const continues = continuePr ? { continues_pr: continuePr.number } : {};
    if (dryRun) { summary.claimed.push({ number: t.number, attempt: k, profile: profileName, dry: true, ...continues }); budget--; continue; }
    const c = await store.claim(t.number, k);
    if (selfHeal(t.number, c)) break;
    if (c.result === 'claimed') { state.claims[`${t.number}/${k}`] = nowIso(); touch(t.number); }
    if (c.result === 'held') { summary.held.push(t.number); log(`#${t.number}: lock held elsewhere, skipping`); continue; }
    if (c.result === 'unknown') {
      log(`#${t.number}: claim result unknown (${c.error?.kind}: ${c.error?.message}); backing off this tick`);
      if (c.error?.kind === 'ratelimit' || c.error?.kind === 'auth') break;
      continue;
    }
    // The claim already seeded this host's beat chain (`claim` writes the local mirror `beatToken`
    // reads), so the worker's first `hkb heartbeat` has a token to lease on without carrying one on
    // the row — which is why the row no longer does.
    const attempt = /** @type {HkbAttempt} */ ({ attempt: k, profile: profileName, host: ctx.host, started_at: nowIso(), heartbeat_at: nowIso(), pid: null, ...continues });
    runRec.run.attempts.push(attempt);
    await store.saveRun(t.number, runRec);
    await store.setStatus(t, 'running', { add: t.agent ? [] : [L.agent(profileName)], remove: [L.needsHuman] });
    let spawned;
    try {
      spawned = await spawnWorker(ctx, t, profileName, k, { keepRef: !!children, continuePr });
      if (!spawned.pid && !spawned.bg) throw new Error('spawn returned neither a pid nor a background launch');
    } catch (e) {
      log(`#${t.number}: spawn failed: ${e.message}`);
      await failAttempt(ctx, store, t, runRec, 'spawn_failed', e.message, { kill: false });
      summary.spawn_failed.push({ number: t.number, error: e.message });
      continue;
    }
    attempt.pid = spawned.pid;
    if (spawned.bg) attempt.bg = true;
    if (spawned.wt) attempt.wt = spawned.wt;
    // which of the two continuation paths this attempt took: the branch, when the dispatcher put the
    // checkout on the PR's own; nothing, when the brief is all that tells the worker to continue it
    if (spawned.continued?.branch) attempt.continues_branch = spawned.continued.branch;
    // the checkout landed on the branch but could not be fast-forwarded to its remote head — the
    // brief falls back to the recipe block, and the row says why rather than claiming a clean continue
    if (spawned.continued?.branch && spawned.continued.why) attempt.continues_branch_stale = spawned.continued.why;
    attempt.log = path.relative(ctx.root, spawned.logFile);
    await store.saveRun(t.number, runRec);
    state.spawned_today = (state.spawned_today || 0) + 1;
    perProfile[profileName] = (perProfile[profileName] || 0) + 1;
    claimedPaths.push({ number: t.number, paths: t.kb.paths || [] });
    budget--;
    const handle = spawned.bg
      ? `background agent in ${spawned.wt} (job id on next tick; claude agents to watch)`
      : `pid ${spawned.pid}${spawned.wt ? ` in ${worktreePath(spawned.wt)}` : ''}`;
    const continuing = !spawned.continued ? ''
      : spawned.continued.branch
        ? spawned.continued.why
          ? `, continuing PR #${spawned.continued.pr} on ${spawned.continued.branch} (${spawned.continued.why}) — the brief says how to catch it up`
          : `, continuing PR #${spawned.continued.pr} on ${spawned.continued.branch}`
        : `, continuing PR #${spawned.continued.pr} from a fresh worktree (${spawned.continued.why}) — the brief says which PR to push to`;
    summary.claimed.push({ number: t.number, attempt: k, profile: profileName, pid: spawned.pid, wt: spawned.wt || null, ...continues });
    log(`#${t.number}: claimed attempt ${k} → ${profileName} ${handle}${continuing} (log ${attempt.log})`);
    logDroppedTools(t, profileName, spawned, log);
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

  // 3d. a running track's children conflicting on the way into its branch — surfaced once, not
  //     rediscovered every tick.
  try {
    summary.track_conflicts = await trackConflictPass(ctx, tasks, { dryRun, log });
  } catch (e) {
    summary.track_conflicts_error = e.message;
    log(`track conflict pass failed (the board is unaffected, and the next tick tries again): ${e.message}`);
  }

  // 4. the Projects v2 mirror used to run here — one GraphQL read plus a mutation per transition,
  //    mirroring `kb:status:*` labels onto a linked project. It went with the labels: a card's status
  //    is a column on the card now, there is no issue to add to a project, and a one-way mirror of a
  //    board GitHub cannot see is a bridge feature (docs/local-first.md §8), not a store one.

  // 5. every `gc_every_ticks`, the full sweep — the same `sweep()` `hkb gc --yes` runs, so what the
  //    dispatcher cleans and what a human cleans can never diverge. One board read, then local git.
  if (!dryRun) state.gc_pending = [...gcPending].slice(-50);
  const every = d.gc_every_ticks ?? GC_EVERY_TICKS;
  if (!dryRun && every > 0) {
    state.ticks_since_gc = (state.ticks_since_gc || 0) + 1;
    if (state.ticks_since_gc >= every) {
      state.ticks_since_gc = 0;
      try {
        summary.gc = await sweep(ctx, { yes: true, log });
        log(`gc: ${summary.gc.worktrees} worktree(s), ${summary.gc.branches} branch(es), ${summary.gc.track_branches} track branch(es), ${summary.gc.files} old file(s)`);
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
      const store = await openStore(ctx);
      const runRec = await store.loadRun(number);
      const a = runRec.run.attempts.find((x) => x.attempt === k);
      if (!a) return;
      // `claude -p --output-format json` signs off with the session id, what the run cost, and —
      // since #155 — why it ended. A malformed log must never cost us the reclaim below, so this is
      // its own try.
      const logText = tailLog(ctx, a.log, 200_000);
      const parsed = parseSessionLog(logText);
      let session = null;
      try { session = sessionUpdate(a, parsed); } catch { /* unreadable log */ }
      if (session) Object.assign(a, session);
      let deniedDirty = false;
      try { deniedDirty = attachDeniedTools(ctx, a); } catch { /* unreadable transcript */ }
      // `api_error_status` on the result says outright what the log-tail regex below only guessed
      // at; the regex now runs only when there was no JSON result line to read a status from.
      const pauseReason = authPauseReason(parsed, logText.slice(-4000));
      if (pauseReason) {
        state.profile_paused_until[profileName] = new Date(Date.now() + ctx.cfg.dispatch.auth_pause * 1000).toISOString();
        writeState(ctx.root, state);
        log(`#${number}: profile ${profileName} paused (${pauseReason})`);
      }
      if (a.ended_at) { // the worker finished properly — only the session numbers are new
        if (session || deniedDirty) { await store.saveRun(number, runRec); log(`#${number}: attempt ${k} ${formatSession(a)}`); }
        return;
      }
      a.exit_code = code;
      const t = await fillPrs(ctx, await store.getTask(number));
      const r = await failAttempt(ctx, store, t, runRec, 'protocol_violation', `worker exited (${code}) without a terminal verb`, { kill: false });
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
    // `hkb up` writes the pid of the child it just spawned into this file, so a loop finding its own
    // pid here is finding its own claim, not a rival's. A file that predates the boot is no claim at
    // all — after a reboot that pid belongs to a stranger (`readPidFile`).
    const { pid: existing, stale } = readPidFile(ctx.root, 'dispatch');
    if (!stale && existing && existing !== process.pid && pidAlive(existing)) {
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
 * A fingerprint of the hkb this process would load if it started right now — read fresh every call,
 * never cached, because that is the whole point: modules are loaded once at process start, so this
 * is the only thing in the loop that ever sees a change on disk. `PKG_ROOT` is the running code's own
 * directory (`init.js`'s `import.meta.url`); when the global `hkb` is a symlink into a git checkout —
 * the case this guards, `hkb dispatch --loop` outliving a merge to `main` or a `git pull` — that
 * checkout's HEAD moves on every such upgrade even when nobody bumps `package.json`, which only
 * happens at release (`docs/releasing.md`). A real `npm i -g` replaces the package wholesale with no
 * `.git` at all, so falls back to the version, which *does* change on every release by definition.
 * Local `git rev-parse` only — no network, no GitHub call — so calling it every tick costs nothing
 * an operator would notice.
 */
export function installStamp() {
  const r = spawnSync('git', ['-C', PKG_ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', timeout: 5_000 });
  if (!r.error && r.status === 0 && r.stdout) return r.stdout.trim();
  return packageVersion();
}

/**
 * The long-lived dispatcher. `sleeper` is the wait between ticks, injected so a test can run six
 * ticks in a millisecond; the default one is interruptible, so SIGTERM ends the loop between ticks
 * rather than after another. `installStamp` is injected the same way, so a test can move it without
 * touching a real git checkout. Throws (exit code 4) when a tick reports `fatal` — the self-heal
 * ladder ran out — or when the code on disk has moved past what this process loaded: either way the
 * honest thing left is to die with a reason a supervisor and a human can both read.
 */
/**
 * Did this tick decide anything the branch has to record? Only then is there something to push.
 *
 * `tracks` and `spawn_failed` are on the list for the same reason as `claimed`: a track-root
 * dispatch does `saveRun` and `setStatus(t, 'running')`, and a spawn that failed writes the card
 * back — both durable, both reported nowhere else. Leaving them off meant a board driven entirely by
 * track dispatch never pushed and, worse, never re-stamped: after `HOST_LIVE_MS` another host's
 * `hkb init --take-over` sees no live dispatcher and takes a board that is ticking right now, which
 * is the two-writers case the one-writer rule exists to prevent, reached from the inside.
 * `track_conflicts` is the same shape, found by the test below: it comments, labels and saves a run.
 *
 * The test asserts this list against a real tick's summary rather than a copy of it, so a new key
 * that reports a decision has to be classified here rather than defaulting to "not durable".
 */
export const DURABLE_TICK_KEYS = ['reconciled', 'reclaimed', 'reaped', 'promoted', 'claimed', 'guarded', 'auto_merge', 'self_heal', 'tracks', 'spawn_failed', 'track_conflicts'];

/**
 * The loop's end-of-tick sync (docs/local-first.md §6.2, "Sync is git").
 *
 * Only on a local board, only after a tick that wrote something durable, at most once a minute
 * (`syncAfterTick`'s own throttle) and silent when the laptop is offline. The dispatcher stamp goes
 * on the same pass: it is what another host's `hkb init --take-over` reads to tell a board somebody
 * is still ticking from one whose laptop is not coming back.
 */
/**
 * @param {any} ctx
 * @param {any} summary  the tick's own summary; `{}` for a caller that only wants the stamp
 * @param {(s: string) => void} [log]
 */
export async function syncPass(ctx, summary, log = () => {}) {
  try {
    const { storeKind } = await import('./store/index.js');
    if (storeKind(ctx) !== 'local') return;
    const { openLocalStore, syncAfterTick } = await import('./store/local.js');
    // `reconcile: false`, and the store opens its SQLite connection lazily (`LocalStore.index`), so
    // the common tick — throttled stamp, nothing durable decided — costs a `rev-parse` against a
    // memoized tree and no database open at all. Building the whole store every tick meant a fresh
    // `DatabaseSync`, `ensureSchema` and `assertSameBoard` every five seconds at the interval floor.
    const store = openLocalStore(ctx, { reconcile: false });
    try {
      // The stamp is unconditional, and the ordering is the whole fix. **Liveness must not depend
      // on whether the tick decided anything**: a dispatcher idling on a quiet board is precisely
      // the case another host's `hkb init --take-over` has to be able to see, and gating the stamp
      // on `DURABLE_TICK_KEYS` meant an idle loop stopped re-stamping, its liveness expired after
      // `HOST_LIVE_MS`, and host B took a board host A was actively ticking — with no `--force` and
      // no warning. `markDispatcher` throttles itself to one commit per `HOST_LIVE_MS / 3`, so
      // running it every tick costs a `_read()` of a tree already in memo on all but a few ticks.
      store.markDispatcher();
      // The push, on the other hand, is only worth making when something was decided: the remote
      // copy is a backup of the branch, and a tick that moved no commit has nothing to back up.
      if (!DURABLE_TICK_KEYS.some((k) => (summary?.[k] || []).length)) return;
      await syncAfterTick(ctx, { store, log });
    } finally { store.close(); }
  } catch (e) {
    // A tick that decided something has already landed on the branch; the copy on the remote is a
    // backup, and failing to make one is never a reason to stop dispatching.
    log(`sync skipped: ${/** @type {Error} */ (e).message}`);
  }
}

export async function loop(ctx, { interval, max, profiles = null, dryRun = false, log, sleeper = null, installStamp: stamp = installStamp }) {
  const dropLock = acquireLoopLock(ctx);
  log(`dispatcher pid ${process.pid} (singleton lock .kanban/dispatch.pid)`);
  const loaded = stamp();
  const children = new Map();
  let stopping = false;
  let fatal = null;
  let upgrade = null;
  // The wait between ticks has to be interruptible, or a SIGTERM landing one second into a 60-second
  // sleep buys a *whole further tick*: the loop would wake, run it, and only then notice it was asked
  // to stop — while `hkb down` had already reported it stopped and `hkb up` had started its
  // replacement. Two loops, one board, and the singleton lock never saw it coming. So `stop` resolves
  // the sleep it is racing, and the loop leaves between ticks instead of through one. The default
  // sleep is owned here rather than closed over, so the pending timer can be cleared with it.
  let timer = null;
  let wake = null;
  const nap = sleeper || ((ms) => new Promise((resolve) => { timer = setTimeout(resolve, ms); }));
  const stop = () => {
    stopping = true;
    log(wake ? 'stopping now (workers keep running; next dispatcher reclaims or adopts them)'
      : 'stopping after this tick (workers keep running; next dispatcher reclaims or adopts them)');
    if (timer) { clearTimeout(timer); timer = null; }
    if (wake) wake();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  // SIGUSR1 is the local store's nudge: `node:sqlite` has no change notification, so a verb that
  // wrote the board signals the dispatcher instead (`index.wake()`, src/store/sqlite.js) and the
  // loop ticks now rather than at the end of the interval.
  //
  // **Installing this handler is what makes the signal a nudge at all.** Node's default action for
  // SIGUSR1 is to start the inspector, so before there was a listener here every `hkb finish` on a
  // local board opened `Debugger listening on ws://127.0.0.1:9229/…` on the dispatcher — the one
  // process that must not stop — and woke nothing. It only ends the *sleep*: a signal arriving
  // during a tick is dropped on purpose, because that tick is already about to read the board.
  const nudge = () => {
    if (stopping || !wake) return;
    log('woken by a board write');
    if (timer) { clearTimeout(timer); timer = null; }
    wake();
  };
  process.on('SIGUSR1', nudge);
  // **The teardown is a `finally`, and it takes every listener this loop installed.**
  // `tokenExpiryNotice`/`versionNotice` are awaited at the top of the tick and outside its own try,
  // so a throw from either unwound straight past `dropLock()` and past `process.off('SIGUSR1', …)`:
  // the pid file stayed, and a later `wake()` reached a listener with no sleep to end instead of
  // falling through to node's default. The same held for the SIGINT/SIGTERM pair, which nothing ever
  // removed at all — the invariant is that a loop that has stopped leaves no listener behind, and it
  // is one `finally` for all four rather than a line per exit.
  try {
    for (;;) {
      const started = Date.now();
      // Once a day, before the tick: the two things nobody tells the operator of a loop that has been
      // up for weeks — a KB_TOKEN about to lapse, and an hkb that npm has moved on from. Both
      // read-modify-write `.kanban/state.json`, which is why they are here and not inside `tick()`;
      // both are silent on a failed probe, so an offline loop runs exactly as it did without them.
      await tokenExpiryNotice(ctx, log);
      await versionNotice(ctx, log);
      let summary = null;
      try {
        // `dryRun` is threaded through rather than dropped here: `hkb dispatch --loop N --dry-run`
        // promised a loop that decides nothing and ran a real claiming, spawning, stamping one.
        const s = await tick(ctx, { max, children, profiles, dryRun, log });
        summary = s;
        const n = (k) => s[k].length;
        log(`tick: reconciled ${n('reconciled')} reclaimed ${n('reclaimed')} reaped ${n('reaped')} promoted ${n('promoted')} claimed ${n('claimed')} tracks ${s.tracks.filter((x) => x.ok).length} guarded ${n('guarded')} held ${n('held')} skipped ${n('skipped')}`);
      } catch (e) {
        if (e instanceof GhError && e.kind === 'network') log('GitHub unreachable — reclaim clock paused, retrying next tick');
        else log(`tick failed: ${e.message}`);
      }
      // Outside the try, and for the same reason the stamp is outside `DURABLE_TICK_KEYS`: **liveness
      // is about the process, not about the tick**. A loop whose ticks are all failing is still a loop
      // holding this board, and leaving the stamp inside meant a run of failures — a rate limit, a
      // flaky network — expired this host's claim on the branch while it was very much still here.
      // `syncPass` catches its own failures, so it cannot turn a survivable tick into a dead loop.
      // …and skipped entirely on a dry run: the stamp is a commit on `kb-board` and the push publishes
      // it, so a loop that promised to decide nothing must not write either.
      if (!dryRun) await syncPass(ctx, summary || {}, log);
      if (summary?.fatal) { fatal = summary.fatal; break; }
      if (stopping) break;
      const current = stamp();
      if (current !== loaded) { upgrade = { loaded, current }; break; }
      const wait = Math.max(5_000, interval * 1000 - (Date.now() - started));
      await Promise.race([nap(wait), new Promise((resolve) => { wake = resolve; })]);
      wake = null; timer = null; // the race is over: a signal from here on waits for the next tick
      if (stopping) break;
    }
  } finally {
    dropLock();
    // The store the ticks shared. `openStore` hands one handle back per context — that is what
    // keeps a loop designed to run forever from opening one per tick — so this is where it closes.
    closeStore(ctx);
    process.off('SIGUSR1', nudge);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (timer) { clearTimeout(timer); timer = null; }
  }
  if (upgrade) {
    const e = new Error(`hkb: this loop is running ${upgrade.loaded}, the installed hkb is ${upgrade.current} — restarting. Running workers are untouched: the next dispatcher adopts or reclaims them.`);
    e.exitCode = 4;
    log(`FATAL ${e.message}`);
    recordExit(ctx.root, 'dispatch', { code: 4, at: nowIso(), reason: e.message });
    throw e;
  }
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

