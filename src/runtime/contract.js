// The runtime contract, in one file so an adapter can state it without importing the registry
// (`src/runtime/index.js` imports every adapter, so nothing an adapter needs may live there).
//
// A **runtime** is how a worker actually runs: a child process, a Claude Code background agent, a
// human in a terminal. The tick never asks which one it is looking at — it asks the adapter.
//
// Two levels, because "execute this card" and "execute this subgraph" are not the same shape:
//
//   runCard(ctx, task, k, opts)     execute one card            — every adapter (`launch`)
//   runTrack(ctx, root, k, opts)    execute a whole subgraph    — `launch` unless the adapter
//                                                                 has a better answer
//
// The process-shaped adapters here implement `launch` and let `runTrack` fall back to it: a track
// is one runner session handed the subgraph's brief, which from the spawn down *is* a worker. An
// adapter that can run a wave in one call (a harness SDK driving typed agent definitions) overrides
// `runTrack` and reads `opts.track` — that is meant to be a new file in this directory, not a
// refactor of the tick.
//
// Plus the lifecycle verbs, against whatever handle the launch returned:
//
//   inspect(ctx, attempt, {jobs, task, dryRun})  → Liveness
//   stop(ctx, attempt)                           → boolean   (graceful; SIGTERM→SIGKILL / `claude stop`)
//   pause(ctx, attempt)                          → {ok, why}
//   resume(ctx, attempt)                         → {ok, why} | handle
//
// and two optional ones a runtime implements only if it has them:
//
//   listing(ctx, log)          the runtime's one local listing per tick (claude-bg's `claude agents`)
//   stopHandle(ctx, handle)    stop something the listing found rather than a row on the board
//   postMortem(ctx, attempt)   what an ending attempt's own artefacts still have to say

/** `pause`/`resume` land in B3/B4 (docs/local-first.md §4); until then every adapter says so. */
export const NOT_IMPLEMENTED = Object.freeze({ ok: false, why: 'not implemented until B4' });

/**
 * What a runtime can see of one attempt right now.
 *
 * `alive` is deliberately three-valued. `true`/`false` are a *local* answer — this host holds the
 * handle and looked at it. `null` means the runtime has nothing to say (the attempt belongs to
 * another host, or to a human), and the tick falls back to the heartbeat, exactly as it always has:
 * the one rule that must never break is that "I cannot see it" is not "it is dead".
 *
 * @typedef {object} Liveness
 * @property {boolean|null} alive    true/false when this host holds the handle; null when unknown
 * @property {boolean|null} working  true when it is genuinely taking a turn (not parked on a prompt)
 * @property {{runtime: string, id?: string, pid?: number, wt?: string, raw?: any}|null} handle
 * @property {object|null} session   attempt-row session fields the runtime can name (`sessionUpdate` shape)
 * @property {string|null} outcome   'crashed' | 'protocol_violation' when the runtime is sure, else null
 * @property {object|null} patch     other attempt-row fields the tick should persist (a resolved job id)
 */

/** The "nothing to say" Liveness — a foreign host, or a runtime with no handle of its own. */
export const UNKNOWN = Object.freeze({ alive: null, working: null, handle: null, session: null, outcome: null, patch: null });

/**
 * How long a launch has to produce a handle before the tick writes it off. A `claude --bg` launch
 * that has to cold-start the session daemon has taken most of a minute; three is the grace the tick
 * has always given both a job that never registered and a spawn that never recorded a pid.
 */
export const REGISTER_GRACE = 180;
