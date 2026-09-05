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
 */
export function fakeRuntime(
  opts: {
    failTasks?: number[];
    /** Jobs that spend their whole cap and stop with work left — the stop a retry cannot change. */
    capTasks?: number[];
    delayMs?: number;
  } = {},
): Runtime {
  const fail = new Set(opts.failTasks ?? []);
  const capped = new Set(opts.capTasks ?? []);
  return {
    name: 'fake',
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
      onEvent?.({ kind: 'tool', taskId: spec.taskId, name: 'Edit' });
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
        denials: 0,
        error: ok ? null : 'fake failure',
      };
    },
  };
}
