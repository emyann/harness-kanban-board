// Worker-facing verbs: heartbeat, complete, block, unblock, request-review, request-changes.
// Every verb closes the open attempt in the run comment and releases the lock ref.
import fs from 'node:fs';
import { GhError, isOffline, graphql, rest } from './gh.js';
import { outboxFile, api } from './board.js';
import {
  getTask, assertOnBoard, loadRun, saveRun, setStatus, addLabels, removeLabel, addComment, closeIssue, reopenIssue,
  fetchBoard, createIssue, ensureLabels, issueDatabaseId, addBlockedBy, removeBlockedBy,
} from './tasks.js';
import { release, lockExists, lockSha, localBeatSha, casHeartbeat, resyncBeatChain, dropBeatChain, remoteName } from './lock.js';
import {
  openAttempt, computeReady, blockerDone, serializeResultComment, serializeBodyBlock, hashReason,
  heartbeatMode, lockRef, BLOCK_KINDS, DEFAULT_KB, L,
} from './model.js';

const nowIso = () => new Date().toISOString();

/** Queue a write for replay when GitHub is unreachable (laptop loop only). */
export function queueOutbox(ctx, argv) {
  fs.mkdirSync(require_dirname(outboxFile(ctx.root)), { recursive: true });
  fs.appendFileSync(outboxFile(ctx.root), JSON.stringify({ at: nowIso(), argv }) + '\n');
}
function require_dirname(p) { return p.slice(0, p.lastIndexOf('/')); }

export function withOutbox(ctx, argv, fn) {
  return fn().catch((e) => {
    if (isOffline(e) && argv) {
      queueOutbox(ctx, argv);
      const err = new Error(`GitHub unreachable — queued for replay in .kanban/outbox.jsonl: hkb ${argv.join(' ')}`);
      err.exitCode = 0;
      err.queued = true;
      throw err;
    }
    throw e;
  });
}

/**
 * `KB_ATTEMPT` belongs to `KB_TASK` and to nothing else. A plain worker only ever acts on its own
 * task, so this is the same value it always was — but a track runner claims and finishes several
 * tasks from one session, and their attempt numbers are their own. Reading the root's attempt
 * number onto a node would synthesize a phantom row and release a lock the node never held.
 */
export function envAttempt(number) {
  return String(process.env.KB_TASK || '') === String(number) ? process.env.KB_ATTEMPT || null : null;
}

/** Resolve the attempt this call acts on: explicit --attempt, KB_ATTEMPT env, else the open attempt. */
function pickAttempt(run, flags, number) {
  const k = Number(flags.attempt || envAttempt(number) || 0);
  if (k) return run.attempts.find((a) => a.attempt === k) || null;
  return openAttempt(run);
}

/** Close the current attempt (or synthesize a zero-duration one, like Hermes) and release its lock. */
async function finishAttempt(ctx, task, rec, flags, outcome, extra = {}) {
  const { run } = rec;
  let a = pickAttempt(run, flags, task.number);
  if (!a) {
    a = { attempt: run.attempts.length + 1, profile: task.agent || 'human', host: ctx.host, started_at: nowIso(), synthetic: true };
    run.attempts.push(a);
  }
  a.ended_at = nowIso();
  a.outcome = outcome;
  Object.assign(a, extra);
  await saveRun(ctx, task.number, rec); // rec.id is set on first create, so later saves update in place
  await release(ctx, task.number, a.attempt);
  dropBeatChain(ctx.root, task.number, a.attempt); // worktrees share one ref store: leave nothing behind
  return a;
}

// ---------- heartbeat ----------

/** The one error a worker must obey: the dispatcher took the task back. */
function lockLost(n, k, why = 'is gone — the dispatcher reclaimed this task') {
  const e = new Error(`LOCK_LOST: ${lockRef(n, k)} ${why}. Stop now: do not commit, do not call complete.`);
  e.exitCode = 3;
  return e;
}

const refBeat = (n, k, cas, extra = {}) => ({ number: n, attempt: k, mode: 'ref', ref: lockRef(n, k), sha: cas.sha, expected: cas.expected, ...extra });

/**
 * A rejected lease is strong evidence but not proof: a push that lands while the local `update-ref`
 * does not leaves this worktree's chain behind, and the next lease then fails against a ref we still
 * hold. So ask GitHub who holds the ref — gone means LOCK_LOST, still ours means resync and beat once
 * more. Returns the beat, throws LOCK_LOST, or returns null when it stayed ambiguous (caller falls back).
 */
async function resolveRejectedLease(ctx, n, k, opts) {
  let sha;
  try { sha = await lockSha(ctx, n, k); } catch { return null; } // GitHub unreachable: conclude nothing
  if (!sha) throw lockLost(n, k);
  resyncBeatChain(ctx.root, n, k, sha);
  const retry = casHeartbeat(ctx.root, n, k, sha, opts);
  if (retry.result === 'ok') return refBeat(n, k, retry, { resynced: true });
  if (retry.result === 'unavailable') return null;
  let after;
  try { after = await lockSha(ctx, n, k); } catch { return null; }
  if (!after) throw lockLost(n, k);
  return null; // the ref is there and still refuses our lease — let the comment path have a say
}

/**
 * Say "still alive". Two ways, chosen by the attempt's profile (`heartbeat` in board.json):
 *   ref (default) — a compare-and-swap on the lock ref: no API call at all, and a reclaim is
 *                   detected atomically by the rejected lease.
 *   comment       — a floored write to the run record, for workers that cannot push refs.
 * A `--note` is content, so it always takes the comment path.
 */
export async function heartbeat(ctx, number, { note, attempt } = {}) {
  const opts = { remote: remoteName(ctx) };
  const envK = Number(attempt || envAttempt(number) || 0);

  // Warm path: the lease *is* the check, so a worker that has beaten before costs GitHub nothing —
  // no task read, no run-record read, no write.
  if (envK && !note && heartbeatMode(ctx.cfg, process.env.KB_PROFILE) !== 'comment') {
    const chain = localBeatSha(ctx.root, number, envK);
    const cas = chain ? casHeartbeat(ctx.root, number, envK, chain, opts) : null;
    if (cas?.result === 'ok') return refBeat(number, envK, cas);
    if (cas?.result === 'lost') {
      const beat = await resolveRejectedLease(ctx, number, envK, opts);
      if (beat) return beat;
    }
  }

  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const rec = await loadRun(ctx, number);
  const { run } = rec;
  const a = openAttempt(run);
  if (!a) { const e = new Error(`#${number} has no active attempt (status: ${task.status})`); e.exitCode = 2; throw e; }

  let fallback = null;
  const mode = heartbeatMode(ctx.cfg, a.profile || process.env.KB_PROFILE);
  if (mode !== 'comment' && !note) {
    // the chain starts at the sha the dispatcher created the ref with, recorded on the attempt
    const expected = localBeatSha(ctx.root, number, a.attempt) || a.lock_sha || (await lockSha(ctx, number, a.attempt));
    if (!expected) throw lockLost(number, a.attempt);
    const cas = casHeartbeat(ctx.root, number, a.attempt, expected, opts);
    if (cas.result === 'ok') return refBeat(number, a.attempt, cas);
    if (cas.result === 'lost') {
      const beat = await resolveRejectedLease(ctx, number, a.attempt, opts);
      if (beat) return beat;
      fallback = `the lease on ${lockRef(number, a.attempt)} was rejected but GitHub still shows the ref`;
    } else fallback = cas.detail;
    // a fallback is normal for `auto` and a misconfiguration for `ref`, but never silent either way
    process.stderr.write(`hkb: no ref heartbeat (${fallback}) — recording it in the run comment instead\n`);
  }

  const held = await lockExists(ctx, number, a.attempt);
  if (!held) throw lockLost(number, a.attempt);
  const last = a.heartbeat_at ? new Date(a.heartbeat_at).getTime() : 0;
  const floorMs = 10 * 60_000; // frugal: comment edits count as content writes; 10-min floor
  if (Date.now() - last < floorMs && !note) return { number, attempt: a.attempt, mode: 'comment', skipped: true, fallback, next_in_s: Math.ceil((floorMs - (Date.now() - last)) / 1000) };
  a.heartbeat_at = nowIso();
  if (note) a.note = String(note).slice(0, 200);
  await saveRun(ctx, number, rec);
  return { number, attempt: a.attempt, mode: 'comment', heartbeat_at: a.heartbeat_at, fallback };
}

const SUMMARY_HINT = 'pass it with --summary ".." / --summary-file <path>, or as {"summary": ".."} on stdin with --from-stdin';

function assertPayload({ summary, metadata, artifacts }, what) {
  if (!summary || typeof summary !== 'string') { const e = new Error(`a summary is required (${what}) — ${SUMMARY_HINT}`); e.exitCode = 2; throw e; }
  if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) { const e = new Error('metadata must be a JSON object'); e.exitCode = 2; throw e; }
  if (artifacts !== undefined && !Array.isArray(artifacts)) { const e = new Error('artifacts must be a list of strings'); e.exitCode = 2; throw e; }
}

// ---------- the task's PR ----------

/**
 * What a terminal verb owes the task's pull request. Pure — no I/O.
 * Workers open drafts, and a draft cannot be merged, so the open PR must come out of draft
 * when the task leaves the worker's hands. Already ready → leave it; no open PR → nothing to do.
 * Closed and merged PRs are never touched.
 */
export function prReadyDecision(prs) {
  const pr = (prs || []).find((p) => p && p.state === 'OPEN') || null;
  if (!pr) return { pr: null, markReady: false, reason: 'no open PR' };
  if (!pr.isDraft) return { pr, markReady: false, reason: `PR #${pr.number} is already ready for review` };
  return { pr, markReady: true, reason: `PR #${pr.number} is a draft and cannot merge` };
}

/** The PR's node id: from the board read when the GraphQL field is there, else one REST lookup. */
async function prNodeId(ctx, pr) {
  if (pr.nodeId) return pr.nodeId;
  const p = await rest('GET', api(ctx, `/pulls/${pr.number}`));
  return p?.node_id || null;
}

/** True when the profile name is also a GitHub user login — profiles like `claude` are not. */
async function isGithubUser(ctx, login) {
  try {
    const u = await rest('GET', `users/${encodeURIComponent(login)}`);
    return u?.type === 'User';
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return false;
    throw e;
  }
}

/**
 * Leave the PR mergeable: take it out of draft, and (request-review) put the reviewer on it.
 * Never throws — the attempt is already closed by the time this runs, so trouble here is
 * reported on the result object and on stderr, not raised.
 */
async function finishPr(ctx, decision, { reviewer } = {}) {
  const pr = decision.pr;
  const out = { pr: pr?.number ?? null, pr_head: pr?.headRefName ?? null, pr_ready: pr ? !pr.isDraft : null };
  if (!pr) return out;
  if (decision.markReady) {
    try {
      const id = await prNodeId(ctx, pr);
      if (!id) throw new Error('could not resolve its node id');
      await graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { number isDraft } } }', { id });
      pr.isDraft = false;
      out.pr_ready = true;
    } catch (e) {
      out.pr_ready = false;
      out.pr_error = `PR #${pr.number} is still a draft: ${e.message}. Run \`gh pr ready ${pr.number}\` before merging.`;
      process.stderr.write(`hkb: ${out.pr_error}\n`);
    }
  }
  if (reviewer) {
    try {
      if (await isGithubUser(ctx, reviewer)) {
        await rest('POST', api(ctx, `/pulls/${pr.number}/requested_reviewers`), { body: { reviewers: [String(reviewer)] } });
        out.reviewer_requested = String(reviewer);
      } else {
        out.reviewer_note = `"${reviewer}" is not a GitHub user — no reviewer requested on PR #${pr.number}`;
      }
    } catch (e) {
      out.reviewer_note = `could not request ${reviewer} on PR #${pr.number}: ${e.message}`;
      process.stderr.write(`hkb: ${out.reviewer_note}\n`);
    }
  }
  return out;
}

/** `pr` / `pr_head` for the attempt row, so the run record says which PR the attempt produced. */
export const prAttemptFields = (decision) => (decision.pr ? { pr: decision.pr.number, pr_head: decision.pr.headRefName || null } : {});

export async function complete(ctx, number, { summary, metadata = {}, artifacts = [], attempt } = {}) {
  assertPayload({ summary, metadata, artifacts }, 'what changed, for the next worker');
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const runRec = await loadRun(ctx, number);
  const decision = prReadyDecision(task.prs);
  const a = await finishAttempt(ctx, task, runRec, { attempt }, 'completed', { summary: String(summary).slice(0, 400), ...prAttemptFields(decision) });
  runRec.run.failures = 0;
  await saveRun(ctx, number, runRec);
  await addComment(ctx, number, serializeResultComment({ kind: 'result', attempt: a.attempt, summary, metadata, artifacts, at: nowIso() }));
  if (decision.pr) {
    const pr = await finishPr(ctx, decision);
    await setStatus(ctx, task, 'review', { remove: [L.needsHuman] });
    return { number, attempt: a.attempt, status: 'review', ...pr, note: 'open PR found — task waits in review until the PR merges' };
  }
  await setStatus(ctx, task, 'done', { remove: [L.needsHuman] });
  await closeIssue(ctx, number, 'completed');
  return { number, attempt: a.attempt, status: 'done' };
}

export async function block(ctx, number, { reason, kind = 'generic', attempt } = {}) {
  if (!reason) { const e = new Error('a reason is required: hkb block <n> "why" [--kind dependency|needs_input|capability|transient], or --reason-file <path>, or {"reason": "..", "kind": ".."} on stdin with --from-stdin'); e.exitCode = 2; throw e; }
  if (!BLOCK_KINDS.includes(kind)) { const e = new Error(`--kind must be one of ${BLOCK_KINDS.join('|')}`); e.exitCode = 2; throw e; }
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const runRec = await loadRun(ctx, number);
  const limit = ctx.cfg?.dispatch?.block_recurrence_limit ?? 3;
  const h = hashReason(reason);
  runRec.run.block_loops[h] = (runRec.run.block_loops[h] || 0) + 1;
  const loops = runRec.run.block_loops[h];
  const a = await finishAttempt(ctx, task, runRec, { attempt }, 'blocked', { reason: String(reason).slice(0, 400), kind });
  await saveRun(ctx, number, runRec);
  await addComment(ctx, number, `**Blocked** (${kind}, attempt ${a.attempt}): ${reason}`);
  if (loops >= limit) {
    await setStatus(ctx, task, 'triage', { add: [L.needsHuman] });
    return { number, attempt: a.attempt, status: 'triage', block_loop_detected: true, recurrences: loops };
  }
  if (kind === 'dependency') {
    await setStatus(ctx, task, 'todo');
    return { number, attempt: a.attempt, status: 'todo', kind };
  }
  await setStatus(ctx, task, 'blocked', { add: kind === 'transient' ? [] : [L.needsHuman] });
  return { number, attempt: a.attempt, status: 'blocked', kind, recurrences: loops };
}

export async function unblock(ctx, number) {
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  if (!['blocked', 'triage', 'todo'].includes(task.status)) { const e = new Error(`#${number} is ${task.status}, nothing to unblock`); e.exitCode = 2; throw e; }
  const runRec = await loadRun(ctx, number);
  runRec.run.failures = 0; // Hermes: unblock resets consecutive failures, keeps block_loops
  if (runRec.id) await saveRun(ctx, number, runRec);
  const last = runRec.run.attempts[runRec.run.attempts.length - 1];
  const target = last?.outcome === 'review_requested' || last?.outcome === 'changes_requested' ? 'review' : computeReady(task) ? 'ready' : 'todo';
  await setStatus(ctx, task, target, { remove: [L.needsHuman] });
  return { number, status: target };
}

export async function requestReview(ctx, number, { summary, metadata = {}, reviewer, attempt } = {}) {
  assertPayload({ summary, metadata }, 'what the reviewer should look at');
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const runRec = await loadRun(ctx, number);
  const decision = prReadyDecision(task.prs);
  const a = await finishAttempt(ctx, task, runRec, { attempt }, 'review_requested', { summary: String(summary).slice(0, 400), ...prAttemptFields(decision) });
  await addComment(ctx, number, serializeResultComment({ kind: 'review', attempt: a.attempt, summary, metadata, reviewer: reviewer || null, at: nowIso() }));
  const pr = await finishPr(ctx, decision, { reviewer });
  await setStatus(ctx, task, 'review', { remove: [L.needsHuman] });
  return { number, attempt: a.attempt, status: 'review', reviewer: reviewer || null, ...pr };
}

export async function requestChanges(ctx, number, { reason } = {}) {
  if (!reason) { const e = new Error('a reason is required: hkb request-changes <n> "what must change"'); e.exitCode = 2; throw e; }
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const runRec = await loadRun(ctx, number);
  const a = pickAttempt(runRec.run, {}, number) || { attempt: runRec.run.attempts.length };
  // record as its own zero-duration attempt so history reads review_requested → changes_requested
  runRec.run.attempts.push({ attempt: runRec.run.attempts.length + 1, profile: 'reviewer', host: ctx.host, started_at: nowIso(), ended_at: nowIso(), outcome: 'changes_requested', reason: String(reason).slice(0, 400), synthetic: true });
  await saveRun(ctx, number, runRec);
  await addComment(ctx, number, `**Changes requested** (after attempt ${a.attempt}): ${reason}`);
  if (task.state === 'CLOSED') await reopenIssue(ctx, number);
  const target = computeReady(task) ? 'ready' : 'todo';
  await setStatus(ctx, task, target);
  return { number, status: target };
}

// ---------- board verbs (create, link) ----------

/**
 * Add a task to the board. The caller hands over an already-typed spec — the CLI parses its flags
 * into this shape, `hkb mcp` gets it as JSON — so this is the single place that decides the status a
 * new task starts in and refuses a cross-board blocker.
 * @param spec.kb overrides for the issue's kb block (priority, paths, scheduled_at, ...)
 * @param spec.parents task numbers this one is blocked by
 * @returns {{number, status, agent, blocked_by, url, duplicate?}}
 */
export async function createTask(ctx, { title, body = '', kb = {}, agent = null, parents = [], triage = false } = {}) {
  if (!title || typeof title !== 'string' || !title.trim()) { const e = new Error('a title is required: hkb create "title" [--body ..] [--blocked-by n,n]'); e.exitCode = 2; throw e; }
  const spec = { ...DEFAULT_KB, ...kb };
  if (spec.scheduled_at) {
    const at = new Date(spec.scheduled_at);
    if (Number.isNaN(at.getTime())) { const e = new Error(`scheduled_at "${spec.scheduled_at}" is not a date — use an ISO timestamp`); e.exitCode = 2; throw e; }
    spec.scheduled_at = at.toISOString();
  }
  const blockers = (parents || []).map((p) => Number(String(p).replace('#', ''))).filter(Boolean);

  if (spec.idempotency_key) {
    const dupe = (await fetchBoard(ctx, { includeClosed: true })).find((t) => t.kb.idempotency_key === spec.idempotency_key);
    if (dupe) return { number: dupe.number, status: dupe.status, agent: dupe.agent, blocked_by: blockers, url: dupe.url, duplicate: true };
  }

  const profile = agent || Object.keys(ctx.cfg.profiles)[0] || 'claude';
  let status = 'triage';
  if (!triage) {
    if (!blockers.length) status = 'ready';
    else {
      const ps = await Promise.all(blockers.map((n) => issueDatabaseId(ctx, n)));
      for (const p of ps) if (!p.labels.includes(L.board(ctx.board))) { const e = new Error(`#${p.number} is not on board "${ctx.board}" — cross-board links are refused`); e.exitCode = 2; throw e; }
      status = ps.every((p) => blockerDone({ state: p.state, stateReason: p.state_reason })) ? 'ready' : 'todo';
    }
  }
  if (spec.scheduled_at && new Date(spec.scheduled_at) > new Date() && status === 'ready') status = 'todo';

  await ensureLabels(ctx, [L.agent(profile)]);
  const issue = await createIssue(ctx, { title, body: serializeBodyBlock(spec, body || ''), labels: [L.board(ctx.board), L.status(status), L.agent(profile)] });
  for (const p of blockers) await addBlockedBy(ctx, issue.number, p);
  return { number: issue.number, status, agent: profile, blocked_by: blockers, url: issue.html_url };
}

/**
 * `child` is blocked by `parent` (or, with `unlink`, no longer is). The child's status follows: a
 * ready task that gains an open blocker drops to todo, and one that loses its last blocker is ready.
 */
export async function linkTask(ctx, parent, child, { unlink = false } = {}) {
  const [p, c] = await Promise.all([getTask(ctx, parent), getTask(ctx, child)]);
  assertOnBoard(ctx, p); assertOnBoard(ctx, c);
  if (unlink) await removeBlockedBy(ctx, child, parent);
  else await addBlockedBy(ctx, child, parent);
  const fresh = await getTask(ctx, child);
  if (!unlink && fresh.status === 'ready' && !computeReady(fresh)) await setStatus(ctx, fresh, 'todo');
  if (unlink && fresh.status === 'todo' && computeReady(fresh)) await setStatus(ctx, fresh, 'ready');
  return { parent, child, status: fresh.status, linked: !unlink };
}

export async function promote(ctx, number) {
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  if (task.status === 'triage') { await setStatus(ctx, task, 'todo'); return { number, status: 'todo' }; }
  if (['todo', 'blocked'].includes(task.status)) {
    await removeLabel(ctx, task, L.needsHuman);
    await setStatus(ctx, task, 'ready');
    return { number, status: 'ready', forced: !computeReady(task) };
  }
  return { number, status: task.status, unchanged: true };
}

export async function archive(ctx, number) {
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  await setStatus(ctx, task, 'archived');
  if (task.state !== 'CLOSED') await closeIssue(ctx, number, task.status === 'done' ? 'completed' : 'not_planned');
  return { number, status: 'archived' };
}

export { addLabels, GhError };
