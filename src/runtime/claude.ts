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

/** Map the SDK's terminal states onto ours. The three resumable ones are the point. */
function statusOf(result: SDKResultMessage | null, threw: boolean): RunStatus {
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
    let announced = false;
    let result: SDKResultMessage | null = null;
    let error: string | null = null;

    const tools = spec.allowedTools ?? DEFAULT_TOOLS;
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
    }

    const status = statusOf(result, error !== null);
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
      error,
    };
  },
};
