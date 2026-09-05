import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Runtime, RunStatus, RuntimeEvent, WorkerOutcome, WorkerSpec } from './index.ts';
import { admissionHooks } from '../admission.ts';

/**
 * The Claude Agent SDK driver.
 *
 * The whole worker is one `for await` loop. That is the part worth noticing, because of what it
 * deletes from the old design: there is no pid to record, no background-job id to reconcile on
 * the next tick, and no worktree path to recover the worker's identity from. The loop either
 * yields or it throws, so liveness is the promise — not a heartbeat column and a 180-second
 * reclaim timer.
 *
 * That simplification is real but bounded, and the bound is why the session id is captured from
 * the `init` message rather than at the end: it holds only while THIS process lives. If the
 * runtime dies mid-run the iterator dies with it, and `resume: <sessionId>` is the only way back
 * to the work. The session id must be in hand before the run ends, not after it.
 */

/**
 * A worker's whole tool surface. Paired with `permissionMode: 'dontAsk'` this is a real allowlist:
 * anything not here is denied outright rather than prompted, which is the documented pairing for a
 * headless agent ("a fixed, explicit tool surface … a hard deny over silent reliance").
 *
 * `Agent` is deliberately absent. Phase 1 runs one agent against one brief; a worker that could
 * fan out would spawn work nothing has claimed. The admission gate that forces `isolation:
 * "worktree"` onto a spawn stays wired and tested for when a later kind allows it.
 */
const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'];

/** How long an interrupted turn is given to wind down and report before the transport is killed. */
const INTERRUPT_GRACE_MS = 20_000;

/**
 * Map the SDK's terminal states onto ours. The three resumable ones are the point.
 *
 * `terminal_reason` is read FIRST and it is not decoration. An interrupted turn can come back with
 * `subtype: 'success'` — which would be recorded as `completed`, the worst failure available on a
 * board whose entire claim is that `succeeded` means something. `aborted_streaming` / `aborted_tools`
 * are how the SDK says "this ended because somebody stopped it".
 */
function statusOf(result: SDKResultMessage | null, threw: boolean, timedOut: boolean): RunStatus {
  const aborted = result && 'terminal_reason' in result
    && (result.terminal_reason === 'aborted_streaming' || result.terminal_reason === 'aborted_tools');
  if (aborted || timedOut) return 'timeout';
  if (!result) return 'error';
  if (result.subtype === 'success') {
    return 'stop_reason' in result && result.stop_reason === 'refusal' ? 'refused' : 'completed';
  }
  if (result.subtype === 'error_max_turns') return 'max_turns';
  if (result.subtype === 'error_max_budget_usd') return 'max_budget';
  void threw;
  return 'error';
}

export const claudeRuntime: Runtime = {
  name: 'claude',

  async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
    let sessionId: string | null = null;
    let timedOut = false;
    let announced = false;
    let result: SDKResultMessage | null = null;
    let error: string | null = null;

    const tools = spec.allowedTools ?? DEFAULT_TOOLS;
    // The wall-clock stop, in two stages: ask, then insist.
    //
    // Aborting alone kills the transport before any result arrives, so `total_cost_usd` is never
    // reported and a stalled thirty-minute run contributed **nothing** to the board's spend
    // ceiling — a hole in the exact guard that exists for it. An interrupt ends the turn properly:
    // a result comes back, with real cost and a resumable session id.
    //
    // `interrupt()` is attempted, never depended on. The SDK's own comment says control requests
    // are "only supported when streaming input/output is used", but it was measured working on a
    // string prompt (stdin closes only at the first result, so the control channel stays writable).
    // Either way the abort still lands after the grace window, so an SDK that stops honouring this
    // degrades to exactly today's behaviour rather than to a hang.
    const abortController = new AbortController();
    let insist: ReturnType<typeof setTimeout> | null = null;
    const timer = spec.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          onEvent?.({ kind: 'text', taskId: spec.taskId, text: `wall clock reached — interrupting` });
          void Promise.resolve()
            .then(() => stream.interrupt())
            .catch(() => { /* unsupported, or the turn already ended */ })
            .finally(() => {
              insist = setTimeout(() => abortController.abort(), INTERRUPT_GRACE_MS);
              if (typeof insist.unref === 'function') insist.unref();
            });
        }, spec.timeoutMs)
      : null;
    const stream = query({
      prompt: spec.prompt,
      options: {
        cwd: spec.cwd,
        model: spec.model,
        maxTurns: spec.maxTurns,
        // The runaway-cost stop, and it covers subagent spend too. Without it an open-ended
        // card ("improve this codebase") has no ceiling but the turn count.
        maxBudgetUsd: spec.maxBudgetUsd,
        effort: spec.effort,
        // Auto-approved without consulting the gate. `Agent` is deliberately absent: a spawn is
        // exactly the call admission exists to mutate, so it must reach the callback.
        allowedTools: tools,
        resume: spec.resume,
        abortController,
        // Admission control, not instruction: every Agent spawn gets `isolation: "worktree"`
        // injected here, so a parent that forgets to ask for it still cannot skip it.
        hooks: admissionHooks({ forceIsolation: true, allow: tools, ...spec.admission }),
        // **`dontAsk`, not `bypassPermissions`.** A worker has nobody to answer a prompt, so both
        // modes avoid prompting — but they are not equivalent:
        //
        //   - `allowedTools` does NOT constrain `bypassPermissions`. The docs are explicit: listing
        //     Read alongside bypass "still approves every tool, including Bash, Write, and Edit".
        //     The allowlist above would be decoration.
        //   - Subagents inherit the parent's mode, and a definition cannot override `bypassPermissions`
        //     — so bypass would hand every future subagent full autonomous system access.
        //   - `dontAsk` denies anything unlisted instead of prompting, which is the documented
        //     pairing for a headless agent and what a denial should look like: visible in
        //     `permission_denials`, not a silent approval.
        //
        // The gate is unaffected either way: hooks run FIRST in the evaluation order, before deny
        // rules, ask rules, the mode and allow rules.
        permissionMode: 'dontAsk',
        // Do not inherit the operator's CLAUDE.md / settings into a worker: the card is the brief.
        // The cost of that choice is real and worth knowing — compaction summarises older history,
        // so on a long card the acceptance criteria in the opening prompt can be summarised away,
        // whereas CLAUDE.md is re-injected on every request. If cards start running long, this is
        // the line to revisit.
        settingSources: [],
      },
    });

    // `query()` yields the error result and THEN throws. Catching outside the loop would lose
    // the result we already have — including the session id, which is exactly what a resumable
    // failure needs. So the throw is caught and kept beside the result, not instead of it.
    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
        else if (!sessionId && 'session_id' in message && message.session_id) sessionId = message.session_id;

        if (!announced && sessionId) {
          announced = true;
          onEvent?.({ kind: 'started', taskId: spec.taskId, sessionId });
        }
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') onEvent?.({ kind: 'tool', taskId: spec.taskId, name: block.name });
            if (block.type === 'text' && block.text.trim()) {
              onEvent?.({ kind: 'text', taskId: spec.taskId, text: block.text.trim().slice(0, 160) });
            }
          }
        }
        // Do not break here: a few trailing system events arrive after the result.
        if (message.type === 'result') result = message;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (timer) clearTimeout(timer);
      if (insist) clearTimeout(insist);
    }

    const status = statusOf(result, error !== null, timedOut);
    onEvent?.({ kind: 'ended', taskId: spec.taskId, status });

    return {
      status,
      ok: status === 'completed',
      sessionId,
      // `result` is only present on the success variant.
      text: result && result.subtype === 'success' ? String(result.result ?? '') : '',
      costUsd: result?.total_cost_usd ?? 0,
      turns: result?.num_turns ?? 0,
      durationMs: result?.duration_ms ?? 0,
      stopReason: result && 'stop_reason' in result ? (result.stop_reason ?? null) : null,
      denials: result?.permission_denials?.length ?? 0,
      // A timed-out run that still reported keeps its real cost, which is the point of interrupting
      // rather than aborting: `costUsd` above comes from the result, and that is what reaches the
      // board's spend ceiling.
      error: timedOut ? `wall clock: ${spec.timeoutMs}ms${result ? ' (interrupted, reported)' : ' (aborted)'}` : error,
    };
  },
};
