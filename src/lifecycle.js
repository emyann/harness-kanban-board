// Worker-facing verbs: heartbeat, complete, block, unblock, request-review, request-changes.
// Every verb closes the open attempt in the run comment and releases the lock ref.
import fs from 'node:fs';
import { GhError, isOffline } from './gh.js';
import { outboxFile } from './board.js';
import { getTask, assertOnBoard, loadRun, saveRun, setStatus, addLabels, removeLabel, addComment, closeIssue, reopenIssue } from './tasks.js';
import { release, lockExists } from './lock.js';
import { openAttempt, computeReady, serializeResultComment, hashReason, BLOCK_KINDS, L } from './model.js';

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
      const err = new Error(`GitHub unreachable — queued for replay in .kanban/outbox.jsonl: ghk ${argv.join(' ')}`);
      err.exitCode = 0;
      err.queued = true;
      throw err;
    }
    throw e;
  });
}

/** Resolve the attempt this call acts on: explicit --attempt, KB_ATTEMPT env, else the open attempt. */
function pickAttempt(run, flags) {
  const k = Number(flags.attempt || process.env.KB_ATTEMPT || 0);
  if (k) return run.attempts.find((a) => a.attempt === k) || null;
  return openAttempt(run);
}

/** Close the current attempt (or synthesize a zero-duration one, like Hermes) and release its lock. */
async function finishAttempt(ctx, task, rec, flags, outcome, extra = {}) {
  const { run } = rec;
  let a = pickAttempt(run, flags);
  if (!a) {
    a = { attempt: run.attempts.length + 1, profile: task.agent || 'human', host: ctx.host, started_at: nowIso(), synthetic: true };
    run.attempts.push(a);
  }
  a.ended_at = nowIso();
  a.outcome = outcome;
  Object.assign(a, extra);
  await saveRun(ctx, task.number, rec); // rec.id is set on first create, so later saves update in place
  await release(ctx, task.number, a.attempt);
  return a;
}

export async function heartbeat(ctx, number, { note } = {}) {
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const rec = await loadRun(ctx, number);
  const { run } = rec;
  const a = openAttempt(run);
  if (!a) { const e = new Error(`#${number} has no active attempt (status: ${task.status})`); e.exitCode = 2; throw e; }
  const held = await lockExists(ctx, number, a.attempt);
  if (!held) {
    const e = new Error(`LOCK_LOST: refs/kb/locks/${number}/${a.attempt} is gone — the dispatcher reclaimed this task. Stop now: do not commit, do not call complete.`);
    e.exitCode = 3;
    throw e;
  }
  const last = a.heartbeat_at ? new Date(a.heartbeat_at).getTime() : 0;
  const floorMs = 10 * 60_000; // frugal: comment edits count as content writes; 10-min floor
  if (Date.now() - last < floorMs && !note) return { number, attempt: a.attempt, skipped: true, next_in_s: Math.ceil((floorMs - (Date.now() - last)) / 1000) };
  a.heartbeat_at = nowIso();
  if (note) a.note = String(note).slice(0, 200);
  await saveRun(ctx, number, rec);
  return { number, attempt: a.attempt, heartbeat_at: a.heartbeat_at };
}

export async function complete(ctx, number, { summary, metadata = {}, artifacts = [], attempt } = {}) {
  if (!summary) { const e = new Error('--summary is required (what changed, for the next worker)'); e.exitCode = 2; throw e; }
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const runRec = await loadRun(ctx, number);
  const a = await finishAttempt(ctx, task, runRec, { attempt }, 'completed', { summary: String(summary).slice(0, 400) });
  runRec.run.failures = 0;
  await saveRun(ctx, number, runRec);
  await addComment(ctx, number, serializeResultComment({ kind: 'result', attempt: a.attempt, summary, metadata, artifacts, at: nowIso() }));
  const openPr = (task.prs || []).find((p) => p.state === 'OPEN');
  if (openPr) {
    await setStatus(ctx, task, 'review', { remove: [L.needsHuman] });
    return { number, attempt: a.attempt, status: 'review', pr: openPr.number, note: 'open PR found — task waits in review until the PR merges' };
  }
  await setStatus(ctx, task, 'done', { remove: [L.needsHuman] });
  await closeIssue(ctx, number, 'completed');
  return { number, attempt: a.attempt, status: 'done' };
}

export async function block(ctx, number, { reason, kind = 'generic', attempt } = {}) {
  if (!reason) { const e = new Error('a reason is required: ghk block <n> "why" [--kind dependency|needs_input|capability|transient]'); e.exitCode = 2; throw e; }
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
  if (!summary) { const e = new Error('--summary is required'); e.exitCode = 2; throw e; }
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const runRec = await loadRun(ctx, number);
  const a = await finishAttempt(ctx, task, runRec, { attempt }, 'review_requested', { summary: String(summary).slice(0, 400) });
  await addComment(ctx, number, serializeResultComment({ kind: 'review', attempt: a.attempt, summary, metadata, reviewer: reviewer || null, at: nowIso() }));
  await setStatus(ctx, task, 'review', { remove: [L.needsHuman] });
  return { number, attempt: a.attempt, status: 'review', reviewer: reviewer || null };
}

export async function requestChanges(ctx, number, { reason } = {}) {
  if (!reason) { const e = new Error('a reason is required: ghk request-changes <n> "what must change"'); e.exitCode = 2; throw e; }
  const task = await getTask(ctx, number);
  assertOnBoard(ctx, task);
  const runRec = await loadRun(ctx, number);
  const a = pickAttempt(runRec.run, {}) || { attempt: runRec.run.attempts.length };
  // record as its own zero-duration attempt so history reads review_requested → changes_requested
  runRec.run.attempts.push({ attempt: runRec.run.attempts.length + 1, profile: 'reviewer', host: ctx.host, started_at: nowIso(), ended_at: nowIso(), outcome: 'changes_requested', reason: String(reason).slice(0, 400), synthetic: true });
  await saveRun(ctx, number, runRec);
  await addComment(ctx, number, `**Changes requested** (after attempt ${a.attempt}): ${reason}`);
  if (task.state === 'CLOSED') await reopenIssue(ctx, number);
  const target = computeReady(task) ? 'ready' : 'todo';
  await setStatus(ctx, task, target);
  return { number, status: target };
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
