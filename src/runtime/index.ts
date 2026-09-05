/**
 * The runtime layer: what actually runs a card.
 *
 * The store answers "what work exists and who owns it". The runtime answers "run this one".
 * They meet at exactly two facts — the claim (before) and the outcome (after) — and the rule
 * that shapes this whole file is:
 *
 *     STORE WHAT SURVIVES THE RUNTIME PROCESS. DERIVE EVERYTHING ELSE.
 *
 * The Agent SDK already keeps the transcript, the per-model token usage, the turn count and the
 * wall-clock, all reachable later from one string — the session id. So the session id is the
 * only SDK fact worth a column; copying the rest into SQLite would be a second, staler source
 * of truth for numbers the SDK can always recompute.
 */

/** What the runtime is asked to do. Assembled from the card; never persisted as-is. */
export type WorkerSpec = {
  taskId: number;
  attempt: number;
  prompt: string;
  cwd: string;
  model?: string;
  /** Turn ceiling. Hitting it is `max_turns`, which is resumable — not a failure. */
  maxTurns?: number;
  /** Hard spend ceiling in USD, subagent spend included. The runaway-cost stop. */
  maxBudgetUsd?: number;
  /** Reasoning depth. `low` is the right default for read-only cards. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  allowedTools?: string[];
  /** Resume a previous session instead of starting cold — the retry path. */
  resume?: string;
};

/**
 * How a run ended.
 *
 * Deliberately not a boolean. The SDK distinguishes five terminal states and three of them are
 * *resumable* — a run that hit its turn cap has done real work and left a session to continue
 * from, which is a different thing from a loop that broke. Collapsing them into ok/failed throws
 * away the only information that decides whether to retry, resume, or give up.
 */
export type RunStatus =
  | 'completed'    // the loop finished on its own
  | 'max_turns'    // hit maxTurns — resumable
  | 'max_budget'   // hit maxBudgetUsd — resumable
  | 'refused'      // the model declined
  | 'error';       // the loop broke

/**
 * What a run produced.
 *
 * `sessionId` is the pointer, and it is the reason the rest of these fields do not need to be
 * columns: `getSessionMessages(sessionId)` gives the transcript back, and the numbers below are
 * on the SDK's own result message. They ride out here so a caller can *log* them cheaply, not
 * so the store can keep them.
 *
 * `status` says how the *session* ended. Whether the card is done is a judgement the caller
 * makes — no SDK field expresses it.
 */
export type WorkerOutcome = {
  status: RunStatus;
  ok: boolean;
  sessionId: string | null;
  text: string;
  /** Whole-tree estimate (subagents included). Zeroed on a crash result — do not trust it there. */
  costUsd: number;
  turns: number;
  durationMs: number;
  stopReason: string | null;
  denials: number;
  /** The failure text `query()` threw, when it threw. */
  error: string | null;
};

/** A progress line, for the operator's console. Nothing here is stored. */
export type RuntimeEvent =
  | { kind: 'started'; taskId: number; sessionId: string | null }
  | { kind: 'tool'; taskId: number; name: string }
  | { kind: 'text'; taskId: number; text: string }
  | { kind: 'ended'; taskId: number; status: RunStatus };

export interface Runtime {
  readonly name: string;
  run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome>;
}
