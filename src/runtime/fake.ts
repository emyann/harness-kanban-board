import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { admissionCallback } from '../admission.ts';
import { admissionPolicy } from './surface.ts';
import type { Runtime, RuntimeEvent, WorkerOutcome, WorkerSpec } from './index.ts';

/**
 * A runtime that spends nothing.
 *
 * It exists because the graph machinery — readiness, waves, claims, terminal writes — is the part
 * that has to be right, and none of it is about Claude. Exercising it against a real model would
 * make the test suite cost money and stop being deterministic.
 *
 * It answers the same `WorkerOutcome` shape as the real driver, including a session id, so the
 * store never learns which runtime ran the card.
 *
 * **It goes through the real admission gate**, built by `./surface.ts` from the spec exactly as the
 * Agent SDK driver builds it. That is what makes the SHIPPED DEFAULT testable: the default surface
 * only existed inside the driver, so every test of the gate passed an `allow` list of its own and
 * proved the code rather than the product. Here a Job that named no surface can be asked what it
 * may call, for free, and be REFUSED.
 */

/** One gate decision, for a test to read. `reason` is the gate's own words to the model. */
export type FakeDecision = { taskId: number; tool: string; allowed: boolean; reason: string | null };

export function fakeRuntime(
  opts: {
    failTasks?: number[];
    /** Jobs that spend their whole cap and stop with work left — the stop a retry cannot change. */
    capTasks?: number[];
    delayMs?: number;
    /**
     * The tool calls this worker attempts, each put through the gate. `Edit` alone by default,
     * which is the one call this runtime has always claimed to make.
     */
    calls?: string[];
  } = {},
): Runtime & { decisions: FakeDecision[] } {
  const fail = new Set(opts.failTasks ?? []);
  const capped = new Set(opts.capTasks ?? []);
  const decisions: FakeDecision[] = [];
  return {
    name: 'fake',
    decisions,
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      const sessionId = `fake-${spec.taskId}-${spec.attempt}`;
      onEvent?.({ kind: 'started', taskId: spec.taskId, sessionId });
      // The delay is what makes a shutdown testable — something has to be in flight to interrupt.
      if (opts.delayMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, opts.delayMs);
          function done() {
            clearTimeout(timer);
            spec.signal?.removeEventListener('abort', done);
            resolve();
          }
          spec.signal?.addEventListener('abort', done, { once: true });
        });
      }
      if (spec.signal?.aborted) {
        // Stopped mid-run: still a session, because the controller resumes it. `status` is what a
        // runtime saw happen, not why — the controller owns "why", and it knows it did this.
        onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'timeout' });
        return {
          status: 'timeout', ok: false, sessionId, text: '', costUsd: 0, turns: 0,
          durationMs: 0, stopReason: 'aborted', denials: 0, error: 'stopped by the operator',
        };
      }
      if (capped.has(spec.taskId)) {
        // The whole cap, and no `error`: the SDK stopping a session on its own budget is not a
        // fault it reports a message for. Whatever the operator reads afterwards is the
        // controller's own words.
        onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'max_budget' });
        return {
          status: 'max_budget', ok: false, sessionId, text: `got partway through #${spec.taskId}`,
          costUsd: spec.maxBudgetUsd ?? 0, turns: 1, durationMs: 0, stopReason: 'max_budget',
          denials: 0, error: null,
        };
      }
      // The tool calls, through the gate this run's spec builds — a denied call is a call this
      // worker never makes, and it is counted the way the SDK counts `permission_denials` rather
      // than failing the run: being refused a tool is not a broken loop.
      const gate = admissionCallback(admissionPolicy(spec));
      let denied = 0;
      for (const [i, name] of (opts.calls ?? ['Edit']).entries()) {
        const input: PreToolUseHookInput = {
          session_id: sessionId,
          transcript_path: '',
          cwd: spec.cwd,
          permission_mode: 'dontAsk',
          hook_event_name: 'PreToolUse',
          tool_name: name,
          tool_input: {},
          tool_use_id: `${sessionId}-${i}`,
        };
        const out = await gate(input);
        const said = 'hookSpecificOutput' in out ? out.hookSpecificOutput : undefined;
        const allowed = !(said && 'permissionDecision' in said && said.permissionDecision === 'deny');
        decisions.push({
          taskId: spec.taskId,
          tool: name,
          allowed,
          reason: said && 'permissionDecisionReason' in said ? said.permissionDecisionReason ?? null : null,
        });
        if (allowed) onEvent?.({ kind: 'tool', taskId: spec.taskId, name });
        else denied += 1;
      }
      const ok = !fail.has(spec.taskId);
      const status = ok ? ('completed' as const) : ('error' as const);
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status });
      return {
        status,
        ok,
        sessionId,
        text: ok ? `did #${spec.taskId}` : `could not do #${spec.taskId}`,
        costUsd: 0,
        turns: 1,
        durationMs: opts.delayMs ?? 0,
        stopReason: 'end_turn',
        denials: denied,
        error: ok ? null : 'fake failure',
      };
    },
  };
}
