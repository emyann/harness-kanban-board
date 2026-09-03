// Worker-facing verbs: heartbeat, complete, block, unblock, request-review, request-changes.
// Every verb closes the open attempt in the run comment and releases the lock ref.
import fs from 'node:fs';
import { finishPr, prNodeId, prChecksState, mergePullRequest, fillPrs } from './forge.js';
import { GhError, isOffline } from './gh.js';
import { outboxFile, assertOnBoard } from './board.js';
import { openStore } from './store/index.js';
import { sessionForAttempt } from './hook.js';
import { sweepTask, pidAlive } from './gc.js';
import {
  openAttempt, computeReady, blockerDone, promoteDecision, serializeResultComment, hashReason,
  BLOCK_KINDS, DEFAULT_KB, L, mergePolicy, mergeDecision,
} from './model.js';
import { resolveTrack } from './track.js';

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
async function finishAttempt(ctx, store, task, rec, flags, outcome, extra = {}) {
  const { run } = rec;
  let a = pickAttempt(run, flags, task.number);
  if (!a) {
    a = { attempt: run.attempts.length + 1, profile: task.agent || 'human', host: ctx.host, started_at: nowIso(), synthetic: true };
    run.attempts.push(a);
  }
  a.ended_at = nowIso();
  a.outcome = outcome;
  Object.assign(a, extra);
  // The session that did the work, when this process IS that session — free here, because the row
  // is being written on the next line anyway. It is also the whole answer for the default profile:
  // a `claude --bg` worker never sees `KB_TASK`, so its Stop hook cannot record anything, and the
  // terminal verb is the one thing every worker runs. A track runner finishes each node from inside
  // its own session, so this is how a node ends up carrying the transcript that paid for it.
  // the profiles ride along so a `KB_TASK` this checkout contradicts is recognised as the leak it is
  // and stamps nothing (src/hook.js `whichAttempt`, #150)
  try { Object.assign(a, sessionForAttempt(ctx.root, task.number, a.attempt, a, { profiles: ctx.cfg?.profiles }) || {}); } catch { /* a session id is a bonus, never a reason a verb fails */ }
  await store.saveRun(task.number, rec); // rec.id is set on first create, so later saves update in place
  await store.release(task.number, a.attempt);
  store.dropBeat(task.number, a.attempt); // worktrees share one ref store: leave nothing behind
  return a;
}

// ---------- heartbeat ----------

/**
 * Where a claim lives, in words a person on *this* board can act on.
 *
 * A claim is a row in a table and has no name, so the attempt number — which every store has — is
 * the answer, and `lockRef` is on the interface for a store that does have one. This is `cli.js`'s
 * `c.ref || \`attempt ${k}\`` under one name. A `store` is optional so the fallback needs no lookup.
 */
const claimWhere = (store, n, k) => store?.lockRef?.(n, k) || `attempt ${k} of #${n}`;

/** The one error a worker must obey: the dispatcher took the task back. */
function lockLost(n, k, why = 'is gone — the dispatcher reclaimed this task', store = null) {
  const e = new Error(`LOCK_LOST: ${claimWhere(store, n, k)} ${why}. Stop now: do not commit, do not call complete.`);
  e.exitCode = 3;
  return e;
}

const refBeat = (store, n, k, cas, extra = {}) => ({ number: n, attempt: k, mode: 'claim', ref: store?.lockRef?.(n, k) ?? null, sha: cas.token, expected: cas.expected, ...extra });

/**
 * A rejected lease is strong evidence but not proof: a push that lands while the local `update-ref`
 * does not leaves this worktree's chain behind, and the next lease then fails against a ref we still
 * hold. So ask GitHub who holds the ref — gone means LOCK_LOST, still ours means resync and beat once
 * more. Returns the beat, throws LOCK_LOST, or returns null when it stayed ambiguous (caller falls back).
 */
async function resolveRejectedLease(store, n, k) {
  let token;
  try { token = await store.lockToken(n, k); } catch { return null; } // the store is unreachable: conclude nothing
  if (!token) throw lockLost(n, k, undefined, store);
  store.resyncBeat(n, k, token);
  const retry = await store.heartbeat(n, k, token);
  if (retry.result === 'ok') return refBeat(store, n, k, retry, { resynced: true });
  if (retry.result === 'unavailable') return null;
  let after;
  try { after = await store.lockToken(n, k); } catch { return null; }
  if (!after) throw lockLost(n, k, undefined, store);
  return null; // the claim is there and still refuses our lease — let the comment path have a say
}

/**
 * Say "still alive". One mechanism, with one fallback:
 *   claim  — a compare-and-swap on the claim the store holds: a reclaim is detected atomically by
 *            the rejected lease, and the lease *is* the check, so a beat costs the store nothing.
 *   record — a floored write to the run record, when the store could not make the swap at all.
 * A `--note` is content, so it always takes the record path.
 *
 * There is no profile switch any more. `heartbeat: "comment"` existed for a worker that could not
 * push to a lock ref on GitHub, which was the only way a *GitHub* board could hold a lease; a local
 * board's claim is a row in a table every verb on this host can write, so the mode that existed to
 * work around the ref is gone with it (docs/local-first.md 6.1).
 */
/**
 * @param {any} ctx
 * @param {number} number
 * @param {{note?: string, attempt?: number}} [opts]
 */
export async function heartbeat(ctx, number, { note, attempt } = {}) {
  const store = await openStore(ctx);
  const envK = Number(attempt || envAttempt(number) || 0);

  // Warm path: the lease *is* the check, so a worker that has beaten before costs the store nothing —
  // no task read, no run-record read, no write.
  if (envK && !note) {
    const chain = store.beatToken(number, envK);
    const cas = chain ? await store.heartbeat(number, envK, chain) : null;
    if (cas?.result === 'ok') return refBeat(store, number, envK, cas);
    if (cas?.result === 'lost') {
      const beat = await resolveRejectedLease(store, number, envK);
      if (beat) return beat;
    }
  }

  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  const rec = await store.loadRun(number);
  const { run } = rec;
  const a = openAttempt(run);
  if (!a) { const e = new Error(`#${number} has no active attempt (status: ${task.status})`); e.exitCode = 2; throw e; }

  let fallback = null;
  if (!note) {
    // the chain starts at the token the dispatcher's claim handed back
    const expected = store.beatToken(number, a.attempt) || (await store.lockToken(number, a.attempt));
    if (!expected) throw lockLost(number, a.attempt, undefined, store);
    const cas = await store.heartbeat(number, a.attempt, expected);
    if (cas.result === 'ok') return refBeat(store, number, a.attempt, cas);
    if (cas.result === 'lost') {
      const beat = await resolveRejectedLease(store, number, a.attempt);
      if (beat) return beat;
      fallback = `the lease on ${claimWhere(store, number, a.attempt)} was rejected but the store still shows the claim`;
    } else fallback = cas.detail;
    // the store could not make the swap at all — say so rather than record a beat as if it had
    process.stderr.write(`hkb: no lease heartbeat (${fallback}) — recording it on the run record instead\n`);
  }

  const held = (await store.lockToken(number, a.attempt)) !== null;
  if (!held) throw lockLost(number, a.attempt, undefined, store);
  const last = a.heartbeat_at ? new Date(a.heartbeat_at).getTime() : 0;
  const floorMs = 10 * 60_000; // frugal: a run-record write is a real write; 10-min floor
  if (Date.now() - last < floorMs && !note) return { number, attempt: a.attempt, mode: 'record', skipped: true, fallback, next_in_s: Math.ceil((floorMs - (Date.now() - last)) / 1000) };
  a.heartbeat_at = nowIso();
  if (note) a.note = String(note).slice(0, 200);
  await store.saveRun(number, rec);
  return { number, attempt: a.attempt, mode: 'record', heartbeat_at: a.heartbeat_at, fallback };
}

const SUMMARY_HINT = 'pass it with --summary ".." / --summary-file <path>, or as {"summary": ".."} on stdin with --from-stdin';

/**
 * @param {{summary?: any, metadata?: any, artifacts?: any}} payload
 * @param {string} what
 */
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

// `prNodeId`, `isGithubUser` and `finishPr` moved to `src/forge.js` with the rest of the
// pull-request half; they are imported at the top of this file and called exactly as before.

/** `pr` / `pr_head` for the attempt row, so the run record says which PR the attempt produced. */
export const prAttemptFields = (decision) => (decision.pr ? { pr: decision.pr.number, pr_head: decision.pr.headRefName || null } : {});

/**
 * What a missing PR does to `complete`: naming the fix, never a silent `done`. Pure.
 *
 * A worker's brief says "open a draft PR on the `kb-<n>-<k>` branch" — so a card `complete` reaches
 * with no PR (not even through the head-branch match `fillPrs` already tried) is either a protocol
 * violation or a card that genuinely needed no PR, and hkb cannot tell those apart from here (#234).
 * Silently picking "done" is the failure the values forbid — the two cases above shipped as *done*
 * with the work sitting in an unreferenced open PR. So without an explicit `noPr` override this
 * refuses to land in done: it records the attempt as `protocol_violation` and leaves the card where
 * a human (or the next attempt) will see it, instead of closing it out from under the missing work.
 */
/**
 * @param {number} number
 * @param {{noPr?: boolean, noPrReason?: string}} [opts]
 */
export function noPrDecision(number, { noPr, noPrReason } = {}) {
  if (noPr) return { ok: true, no_pr_reason: noPrReason ? String(noPrReason).slice(0, 300) : null };
  return {
    ok: false,
    reason: `no PR found for #${number} — no open pull request on this card's own branch ` +
      `(kb-${number}-*, worktree-kb-${number}-*, kb/${number}), which is the only thing that ties one to a ` +
      `card. Open it, or rename an existing PR's head branch onto one of those, and finish again; or if ` +
      `this card genuinely needed no PR, finish again with --no-pr "<why>".`,
  };
}

/**
 * @param {any} ctx
 * @param {number} number
 * @param {{summary?: string, metadata?: object, artifacts?: any[], attempt?: number, noPr?: boolean, noPrReason?: string}} [opts]
 */
export async function complete(ctx, number, { summary, metadata = {}, artifacts = [], attempt, noPr, noPrReason } = {}) {
  assertPayload({ summary, metadata, artifacts }, 'what changed, for the next worker');
  const store = await openStore(ctx);
  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  const runRec = await store.loadRun(number);
  // The card came from the store; its pull request comes from the forge, and the branch name is the
  // join (`fillPrs`, src/forge.js). Nothing on GitHub's side links the two any more.
  //
  // `required`: an unreachable forge must not read here as "this card has no PR". That answer costs
  // the worker its work — `noPrDecision` records a protocol violation and parks the card — for a
  // pull request that is sitting there, unread. Fail with the forge's own error instead.
  await fillPrs(ctx, task, { required: true });
  const decision = prReadyDecision(task.prs);
  if (!decision.pr) {
    const noPrCheck = noPrDecision(number, { noPr, noPrReason });
    if (!noPrCheck.ok) {
      const a = await finishAttempt(ctx, store, task, runRec, { attempt }, 'protocol_violation', { reason: noPrCheck.reason.slice(0, 400) });
      await store.saveRun(number, runRec);
      await store.addNote(number, `**Protocol violation** (attempt ${a.attempt}): ${noPrCheck.reason}`);
      await store.setStatus(task, 'blocked', { add: [L.needsHuman] });
      return { number, attempt: a.attempt, status: 'blocked', protocol_violation: true, reason: noPrCheck.reason };
    }
    metadata = { ...metadata, no_pr: true, ...(noPrCheck.no_pr_reason ? { no_pr_reason: noPrCheck.no_pr_reason } : {}) };
  }
  const a = await finishAttempt(ctx, store, task, runRec, { attempt }, 'completed', { summary: String(summary).slice(0, 400), ...prAttemptFields(decision) });
  runRec.run.failures = 0;
  await store.saveRun(number, runRec);
  // An attempt the dispatcher started to continue a PR the reviewer sent back carries `continues_pr`
  // (src/dispatch.js): the result comment names that PR and says it was continued, not opened, so a
  // reader of the thread can see one PR carrying two rounds of review rather than wonder (#153).
  const continued = !!(decision.pr && a.continues_pr === decision.pr.number);
  await store.addNote(number, serializeResultComment({ kind: 'result', attempt: a.attempt, summary, metadata, artifacts, pr: decision.pr?.number ?? null, pr_continued: continued, at: nowIso() }));
  if (decision.pr) {
    const pr = await finishPr(ctx, decision);
    await store.setStatus(task, 'review', { remove: [L.needsHuman] });
    const note = continued
      ? `continued PR #${decision.pr.number} — task waits in review until it merges`
      : 'open PR found — task waits in review until the PR merges';
    return { number, attempt: a.attempt, status: 'review', ...pr, pr_continued: continued, note };
  }
  await store.setStatus(task, 'done', { remove: [L.needsHuman] });
  await store.closeTask(number, 'completed');
  return { number, attempt: a.attempt, status: 'done' };
}

/**
 * @param {any} ctx
 * @param {number} number
 * @param {{reason?: string, kind?: string, attempt?: number}} [opts]
 */
export async function block(ctx, number, { reason, kind = 'generic', attempt } = {}) {
  if (!reason) { const e = new Error('a reason is required: hkb block <n> "why" [--kind dependency|needs_input|capability|transient], or --reason-file <path>, or {"reason": "..", "kind": ".."} on stdin with --from-stdin'); e.exitCode = 2; throw e; }
  if (!BLOCK_KINDS.includes(kind)) { const e = new Error(`--kind must be one of ${BLOCK_KINDS.join('|')}`); e.exitCode = 2; throw e; }
  const store = await openStore(ctx);
  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  const runRec = await store.loadRun(number);
  const limit = ctx.cfg?.dispatch?.block_recurrence_limit ?? 3;
  const h = hashReason(reason);
  runRec.run.block_loops[h] = (runRec.run.block_loops[h] || 0) + 1;
  const loops = runRec.run.block_loops[h];
  const a = await finishAttempt(ctx, store, task, runRec, { attempt }, 'blocked', { reason: String(reason).slice(0, 400), kind });
  await store.saveRun(number, runRec);
  await store.addNote(number, `**Blocked** (${kind}, attempt ${a.attempt}): ${reason}`);
  if (loops >= limit) {
    await store.setStatus(task, 'triage', { add: [L.needsHuman] });
    return { number, attempt: a.attempt, status: 'triage', block_loop_detected: true, recurrences: loops };
  }
  if (kind === 'dependency') {
    await store.setStatus(task, 'todo');
    return { number, attempt: a.attempt, status: 'todo', kind };
  }
  await store.setStatus(task, 'blocked', { add: kind === 'transient' ? [] : [L.needsHuman] });
  return { number, attempt: a.attempt, status: 'blocked', kind, recurrences: loops };
}

export async function unblock(ctx, number) {
  const store = await openStore(ctx);
  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  if (!['blocked', 'triage', 'todo'].includes(task.status)) { const e = new Error(`#${number} is ${task.status}, nothing to unblock`); e.exitCode = 2; throw e; }
  const runRec = await store.loadRun(number);
  runRec.run.failures = 0; // Hermes: unblock resets consecutive failures, keeps block_loops
  if (runRec.id) await store.saveRun(number, runRec);
  const last = runRec.run.attempts[runRec.run.attempts.length - 1];
  const target = last?.outcome === 'review_requested' || last?.outcome === 'changes_requested' ? 'review' : computeReady(task) ? 'ready' : 'todo';
  await store.setStatus(task, target, { remove: [L.needsHuman] });
  return { number, status: target };
}

/**
 * @param {any} ctx
 * @param {number} number
 * @param {{summary?: string, metadata?: object, reviewer?: string, attempt?: number}} [opts]
 */
export async function requestReview(ctx, number, { summary, metadata = {}, reviewer, attempt } = {}) {
  assertPayload({ summary, metadata }, 'what the reviewer should look at');
  const store = await openStore(ctx);
  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  const runRec = await store.loadRun(number);
  // `required`: the attempt row names the PR this review is on, and `finishPr` below has to reach
  // the forge anyway — a listing that failed must not record "reviewed, no PR".
  await fillPrs(ctx, task, { required: true });
  const decision = prReadyDecision(task.prs);
  const a = await finishAttempt(ctx, store, task, runRec, { attempt }, 'review_requested', { summary: String(summary).slice(0, 400), ...prAttemptFields(decision) });
  const continued = !!(decision.pr && a.continues_pr === decision.pr.number);
  await store.addNote(number, serializeResultComment({ kind: 'review', attempt: a.attempt, summary, metadata, reviewer: reviewer || null, pr: decision.pr?.number ?? null, pr_continued: continued, at: nowIso() }));
  const pr = await finishPr(ctx, decision, { reviewer });
  await store.setStatus(task, 'review', { remove: [L.needsHuman] });
  return { number, attempt: a.attempt, status: 'review', reviewer: reviewer || null, ...pr, pr_continued: continued };
}

/**
 * Send a reviewed card back for another round, on the same PR.
 *
 * The `changes_requested` row this writes is not just history: it is what exempts the card from the
 * `active_pr` guard on the next tick, so the dispatcher relaunches it instead of bouncing it back to
 * `review`, and the attempt it starts continues this PR rather than opening a second one
 * (`activePrGuard` in src/model.js, the claim loop in src/dispatch.js). The PR is deliberately left
 * exactly as it is — open, drafts and all: it is the continuation target.
 */
/**
 * @param {any} ctx
 * @param {number} number
 * @param {{reason?: string}} [opts]
 */
export async function requestChanges(ctx, number, { reason } = {}) {
  if (!reason) { const e = new Error('a reason is required: hkb request-changes <n> "what must change"'); e.exitCode = 2; throw e; }
  const store = await openStore(ctx);
  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  const runRec = await store.loadRun(number);
  const a = pickAttempt(runRec.run, {}, number) || { attempt: runRec.run.attempts.length };
  // record as its own zero-duration attempt so history reads review_requested → changes_requested.
  // Unlike the other terminal verbs, this reason is never truncated: it is the reviewer's note, and a
  // relaunched worker must see it in full rather than cut mid-sentence (#162).
  runRec.run.attempts.push({ attempt: runRec.run.attempts.length + 1, profile: 'reviewer', host: ctx.host, started_at: nowIso(), ended_at: nowIso(), outcome: 'changes_requested', reason: String(reason), synthetic: true });
  await store.saveRun(number, runRec);
  await store.addNote(number, `**Changes requested** (after attempt ${a.attempt}): ${reason}`);
  if (task.state === 'CLOSED') await store.reopenTask(number);
  const target = computeReady(task) ? 'ready' : 'todo';
  await store.setStatus(task, target);
  await fillPrs(ctx, task);
  const pr = (task.prs || []).find((p) => p && p.state === 'OPEN') || null;
  return {
    number,
    status: target,
    pr: pr?.number ?? null,
    note: pr ? `PR #${pr.number} stays open; the next attempt continues it` : 'no open PR — the next attempt starts a branch of its own',
  };
}

/**
 * `hkb merge <n>` — the verb `dispatch.merge.mode: "operator"` exists for (#189). A thin wrapper:
 * the policy check and the refusal wording are `mergeDecision` (pure, in src/model.js), so the
 * condition is enforced by code and not just remembered by whoever is driving the operator seat.
 * `summary`, when given, both satisfies `require.review_comment` (naming what was checked, when no
 * earlier `review_requested` row already named a reviewer) and becomes the review line in the
 * record comment. Never merges on a `manual` or `auto` board, and never on a red check — see
 * `mergeDecision`'s refusals for the exact wording of each.
 */
/**
 * @param {any} ctx
 * @param {number} number
 * @param {{summary?: string}} [opts]
 */
export async function mergeCard(ctx, number, { summary } = {}) {
  const store = await openStore(ctx);
  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  const policy = mergePolicy(ctx.cfg);
  const runRec = await store.loadRun(number);
  // `required`: `mergeDecision` refuses a card with no open PR, and "the listing failed" must not
  // reach the operator wearing that refusal's wording.
  await fillPrs(ctx, task, { required: true });
  const openPr = (task.prs || []).find((p) => p && p.state === 'OPEN') || null;
  let checksState = null;
  if (!policy.error && policy.mode === 'operator' && openPr) {
    checksState = policy.require.checks ? await prChecksState(ctx, openPr.number) : 'SUCCESS';
  }
  const decision = mergeDecision(task, runRec.run, policy, { summary, checksState });
  if (!decision.ok) { const e = new Error(decision.reason); e.exitCode = 2; throw e; }
  const nodeId = await prNodeId(ctx, decision.pr);
  if (!nodeId) { const e = new Error(`PR #${decision.pr.number} came back without a node id — merge refused`); e.exitCode = 2; throw e; }
  await mergePullRequest(ctx, { nodeId }, decision.mergeMethod);
  const attempt = [...runRec.run.attempts].reverse().find((a) => a.pr === decision.pr.number);
  if (attempt) { attempt.merged_by = 'operator'; await store.saveRun(number, runRec); }
  const checksNote = policy.require.checks ? 'green' : 'not required';
  await store.addNote(number, `**Merged by the operator seat** — review: ${decision.reviewDetail || 'not required'}, checks: ${checksNote}, method: ${decision.method}`);
  // The merge is what finishes the card, and this call knows it happened — so it says so here rather
  // than waiting for the reconcile pass to find the merged PR on the next tick. Nothing closes a
  // card behind hkb's back any more (docs/local-first.md §6.4): a card is moved by a verb or by the
  // tick, and this is the verb.
  await store.setStatus(task, 'done', { remove: [L.needsHuman] });
  if (task.state !== 'CLOSED') await store.closeTask(number, 'completed');
  // ...and because it does, the tick's reconcile pass never sees this card again — `done` is not a
  // `RECONCILE_STATUSES` status, and `sweepFinished` is driven by what that pass reconciled
  // (src/dispatch.js). Cleanup used to arrive that way, one tick later; now it has to happen here,
  // or a merged card's worktree and branch survive until the periodic full sweep — for ever on a
  // board whose dispatcher is not running. Same call the tick makes, with the same `keep`: a live
  // worker on this host keeps the checkout it is sitting in.
  const keep = runRec.run.attempts.filter((a) => !a.ended_at && a.host === ctx.host && a.pid && pidAlive(a.pid)).map((a) => a.attempt);
  let cleaned = null;
  try {
    const r = sweepTask(ctx, number, { keep });
    if (r.worktrees || r.branches) cleaned = r;
  } catch { /* local git only, and the next `hkb gc`/tick sweep retries it — never fail a merge on cleanup */ }
  return { number, pr: decision.pr.number, method: decision.method, merged: true, merged_by: 'operator', status: 'done', cleaned };
}

// ---------- board verbs (create, link) ----------

/**
 * Add a task to the board. The caller hands over an already-typed spec — the CLI parses its flags
 * into this shape, `hkb mcp` gets it as JSON — so this is the single place that decides the status a
 * new task starts in and refuses a cross-board blocker.
 * @param {object} [spec]
 * @param spec.kb overrides for the issue's kb block (priority, paths, scheduled_at, ...)
 * @param spec.parents task numbers this one is blocked by
 * @returns {Promise<{number: number, status: string, agent: string|null, blocked_by: number[], url: string, duplicate?: any}>}
 */
export async function createTask(ctx, { title = '', body = '', kb = {}, agent = null, parents = [], triage = false } = {}) {
  if (!title || typeof title !== 'string' || !title.trim()) { const e = new Error('a title is required: hkb create "title" [--body ..] [--blocked-by n,n]'); e.exitCode = 2; throw e; }
  const spec = { ...DEFAULT_KB, ...kb };
  if (spec.scheduled_at) {
    const at = new Date(spec.scheduled_at);
    if (Number.isNaN(at.getTime())) { const e = new Error(`scheduled_at "${spec.scheduled_at}" is not a date — use an ISO timestamp`); e.exitCode = 2; throw e; }
    spec.scheduled_at = at.toISOString();
  }
  const blockers = (parents || []).map((p) => Number(String(p).replace('#', ''))).filter(Boolean);

  const store = await openStore(ctx);
  if (spec.idempotency_key) {
    const dupe = (await store.listTasks({ states: ['OPEN', 'CLOSED'] })).find((t) => t.kb.idempotency_key === spec.idempotency_key);
    if (dupe) return { number: dupe.number, status: dupe.status, agent: dupe.agent, blocked_by: blockers, url: dupe.url, duplicate: true };
  }

  const profile = agent || Object.keys(ctx.cfg.profiles)[0] || 'claude';
  let status = 'triage';
  if (!triage) {
    if (!blockers.length) status = 'ready';
    else {
      // The blockers are read as *cards*, not as issues: `getTask` is what every store answers with,
      // and it already carries the board the card is on and the state a `blockerDone` reads.
      const ps = await Promise.all(blockers.map((n) => store.getTask(n)));
      for (const p of ps) if (p.board !== ctx.board) { const e = new Error(`#${p.number} is not on board "${ctx.board}" — cross-board links are refused`); e.exitCode = 2; throw e; }
      status = ps.every(blockerDone) ? 'ready' : 'todo';
    }
  }
  if (spec.scheduled_at && new Date(spec.scheduled_at) > new Date() && status === 'ready') status = 'todo';

  const card = await store.createTask({ title, body: body || '', kb: spec, status, agent: profile });
  for (const p of blockers) await store.addBlockedBy(card.number, p);
  return { number: card.number, status, agent: profile, blocked_by: blockers, url: card.url };
}

/**
 * `child` is blocked by `parent` (or, with `unlink`, no longer is). The child's status follows: a
 * ready task that gains an open blocker drops to todo, and one that loses its last blocker is ready.
 */
export async function linkTask(ctx, parent, child, { unlink = false } = {}) {
  const store = await openStore(ctx);
  const [p, c] = await Promise.all([store.getTask(parent), store.getTask(child)]);
  assertOnBoard(ctx, p); assertOnBoard(ctx, c);
  if (unlink) await store.removeBlockedBy(child, parent);
  else await store.addBlockedBy(child, parent);
  const fresh = await store.getTask(child);
  if (!unlink && fresh.status === 'ready' && !computeReady(fresh)) await store.setStatus(fresh, 'todo');
  if (unlink && fresh.status === 'todo' && computeReady(fresh)) await store.setStatus(fresh, 'ready');
  return { parent, child, status: fresh.status, linked: !unlink };
}

/**
 * Promote `number` and every task still blocking it (`resolveTrack`, #209) — the root plus its
 * subgraph, one call. A card with no open blockers left resolves to a track of one and gets exactly
 * today's single-card behaviour, forcing included; a real subgraph never forces a blocker to `ready` —
 * see `promoteDecision`. Returns one row per card the track touches, moved or not, so a cascade that
 * moves several cards never reports as if it moved one.
 *
 * `triageOnly` (#238) is the guard a batch promote wants: a card named on the command line can have
 * moved on — dispatched, hand-promoted — between the moment something decided to promote it and the
 * moment this call runs. Without the guard, promoting a card that is no longer in *triage* silently
 * forces it (a `todo` root has no open blockers of its own, so `allowForce` is true) and the caller had
 * to notice a `forced` line in the output after the fact to catch it. With it, a root that is not in
 * *triage* is skipped before anything is read or written — same shape as any other skip, so a batch
 * that mixes triage and already-moved cards gets one report, not a forced write to explain away.
 */
export async function promote(ctx, number, { triageOnly = false } = {}) {
  const n = Number(number);
  const store = await openStore(ctx);
  const byNumber = new Map((await fillPrs(ctx, await store.listTasks())).map((t) => [t.number, t]));
  let root = byNumber.get(n);
  if (!root) { root = await fillPrs(ctx, await store.getTask(n)); byNumber.set(n, root); }
  assertOnBoard(ctx, root);
  if (triageOnly && root.status !== 'triage') {
    return [{ number: root.number, status: root.status, unchanged: true, skipped: true, reason: `not in triage — already ${root.status}` }];
  }
  const track = resolveTrack(n, byNumber);
  const allowForce = track.nodes.length === 0; // no open blockers: a track of one, today's behaviour
  const results = [];
  for (const t of track.order) {
    const decision = promoteDecision(t, { allowForce });
    const from = t.status;
    if (decision.to === from) { results.push({ number: t.number, status: from, unchanged: true, skipped: !!decision.skipped, reason: decision.reason }); continue; }
    if (decision.to === 'ready') await store.removeLabel(t, L.needsHuman);
    await store.setStatus(t, decision.to);
    results.push({ number: t.number, status: decision.to, from, forced: !!decision.forced });
  }
  return results;
}

export async function archive(ctx, number) {
  const store = await openStore(ctx);
  const task = await store.getTask(number);
  assertOnBoard(ctx, task);
  // Read the status *before* archiving it: `setStatus` updates `task.status` in place (it is on the
  // interface that way, so a caller can go on reading the task it passed in), so asking afterwards
  // whether this card was done always answered "no" and every archived card closed NOT_PLANNED —
  // which `blockerDone` rejects, leaving anything blocked by an archived card in `todo` forever.
  const wasDone = task.status === 'done';
  await store.setStatus(task, 'archived');
  if (task.state !== 'CLOSED') await store.closeTask(number, wasDone ? 'completed' : 'not_planned');
  return { number, status: 'archived' };
}

// Nothing imports `addLabels` from here; `GhError` stays because `withOutbox`'s callers classify on it.
export { GhError };
