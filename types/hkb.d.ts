// The one thing the whole codebase agrees on that plain JavaScript cannot say: an hkb error is an
// `Error` carrying a few extra fields. CLAUDE.md states the rule ("throw `Error` with `.exitCode`"),
// every `throw` site follows it and every `catch` reads it back, so the fields are declared here once
// rather than re-annotated at ~60 call sites. Runtime is untouched — this file emits nothing.
declare global {
  interface Error {
    /** Process exit code: 2 = usage/state, 3 = LOCK_LOST, 4 = the dispatch loop asking for a restart. */
    exitCode?: number;
    /** Message shown to a human instead of `message` when the raw one would not name a fix. */
    userMessage?: string;
    /** A machine-readable tag for the failure, where a caller branches on the kind rather than the text. */
    kind?: string;
    /** Errno-style code, from Node's own errors and from the ones hkb raises alongside them. */
    code?: string;
    /** What the caller would have to be allowed to do for this to succeed (tool posture refusals). */
    needs?: string[];
    /** Set when a harness refused the command rather than the command failing. */
    refused?: boolean;
    /** Set when the work was accepted but deferred rather than done now. */
    queued?: boolean;
    /** The JSON-RPC error object this was raised from, when it crossed the MCP boundary. */
    rpc?: unknown;
  }

  /**
   * One row of a card's run record — the protocol's attempt, as it is written to the run comment.
   * Most fields are filled in after the row is first pushed (a pid once the worker spawns, an
   * outcome once it ends), so nearly everything is optional; inference from any single construction
   * site would see only that site's half.
   */
  interface HkbAttempt {
    attempt: number;
    profile?: string;
    host?: string;
    started_at?: string;
    heartbeat_at?: string;
    ended_at?: string;
    lock_sha?: string | null;
    pid?: number | null;
    /** launched as a background job rather than a foreground process */
    bg?: boolean;
    /** the worktree path this attempt was given */
    wt?: string;
    /** relative path of the attempt's log file */
    log?: string;
    /** claimed by a human rather than spawned by the tick */
    manual?: boolean;
    /** Legacy: written by an hkb that still had the Actions runner (ADR-006). Read, never written. */
    remote?: boolean;
    /** this attempt continues an existing PR / its branch */
    continues_pr?: number;
    continues_branch?: string;
    continues_branch_stale?: string;
    /** track roots only: the subgraph this attempt runs */
    track?: boolean;
    track_mode?: string;
    track_nodes?: number[];
    track_branch?: string;
    outcome?: string;
    terminal_reason?: string;
    exit_code?: number;
    session_id?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    artifacts?: unknown[];
    pr?: number;
    no_pr?: boolean;
    reason?: string;
    kind?: string;
    reviewer?: string;
    job?: string;
    job_stopped?: boolean;
    [extra: string]: unknown;
  }
}

export {};
