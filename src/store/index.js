// The store seam. One interface over board state, one driver behind it.
//
// `openStore(ctx)` is the only way a command should reach board state. Today it always returns the
// GitHub driver (`./github.js`); the two local tiers of docs/local-first.md §6 — the `kb-board`
// branch and the `.git/hkb/index.db` index — arrive as further drivers behind this same call, and
// `hkb up` makes one of them the default without a caller changing.
//
// **The method names below are the contract.** They are §6.4 verbatim, and the local drivers are
// written against them in parallel with this file. Do not rename one, and do not add one without
// adding it to the conformance suite in `test/store.test.js` — the suite is what says a driver
// implements the interface, and a method no scenario exercises is a method the next driver will
// get wrong.
//
// What is **not** in the store: pull requests. `openPrsByHead`, `prMergeStates`, `enableAutoMerge`,
// `branchProtection`, `mergePullRequest`, `prChecksState` and `finishPr` live in `src/forge.js` and
// go on calling `src/gh.js` whatever the board is kept in — a local board still opens its work on a
// forge (§6.4).
import { openGithubStore } from './github.js';
import { openLocalStore, localBoardExists, assertLocalOwner, forgetGitTiers } from './local.js';

/**
 * The answer `storeKind` already gave for a context.
 *
 * Two `git rev-parse` is not much, but `storeKind` is on the path of every board-writing verb, every
 * `gc.sweep` and every dispatcher tick, and on a GitHub board it buys nothing at all. A board does
 * not change store while a process runs — except in `hkb init`, which creates the branch under its
 * own feet and calls `forgetStore` when it does.
 * @type {WeakMap<object, string>}
 */
const KINDS = new WeakMap();

/** Forget what `storeKind` answered for `ctx` — `hkb init` has just changed the answer. */
export function forgetStore(ctx) {
  if (ctx && typeof ctx === 'object') { KINDS.delete(ctx); forgetGitTiers(ctx); }
}

/**
 * Which store a board uses, and **the only place that decides it** (the card's contract).
 *
 * Two answers, in this order:
 *   1. `store` in `.kanban/board.json` — `"local"` or `"github"`. `hkb init` writes `"local"` on a
 *      new board and `hkb init --store github` writes the other; an existing board that has never
 *      heard of the key is left to (2), so no board changes store by being read by a newer hkb.
 *   2. the `kb-board` branch: if this repository has one (or a `<remote>/kb-board` to read), the
 *      board is local. That is what makes a `git clone` of a local board work with no config at all.
 *
 * @param {any} ctx  a context from `makeContext`/`makeContextAt` (src/board.js)
 * @returns {string} 'local' | 'github'
 */
export function storeKind(ctx) {
  const declared = ctx?.cfg?.store;
  if (declared === 'local' || declared === 'github') return declared;
  if (declared) {
    const e = /** @type {any} */ (new Error(`"store": "${declared}" in .kanban/board.json is not a store — hkb has "local" (the kb-board branch) and "github" (issues).`));
    e.exitCode = 2;
    throw e;
  }
  const cached = ctx && typeof ctx === 'object' ? KINDS.get(ctx) : null;
  if (cached) return cached;
  const kind = localBoardExists(ctx) ? 'local' : 'github';
  // **Both** answers are remembered. `local` cannot go stale — a branch that exists does not stop
  // existing while a process runs — and `github` was left uncached out of a worry that `hkb init`
  // creates the branch under its own feet, which is real and is already handled: init calls
  // `forgetStore(ctx)` the moment it does. Leaving the negative uncached meant every board that
  // predates the `store` key — the common one, and this repository's own — re-spawned two `git
  // rev-parse` per board-writing verb, per `gc.sweep` and per dispatcher tick, to reach an answer
  // that could only ever come back `github`. Anything else that creates the branch mid-process
  // invalidates the same way init does.
  if (ctx && typeof ctx === 'object') KINDS.set(ctx, kind);
  return kind;
}

/**
 * The store for `ctx`.
 * @param {any} ctx  a context from `makeContext`/`makeContextAt` (src/board.js)
 * @param {{kind?: string}} [opts]  `kind` forces a driver — `hkb init --import`, which reads one
 *   store and writes the other, is the caller that needs it.
 * @returns {Store}
 */
export function openStore(ctx, { kind = null } = {}) {
  return (kind || storeKind(ctx)) === 'local' ? openLocalStore(ctx) : openGithubStore(ctx);
}

/**
 * Refuse a verb that writes the board on a host that does not own it.
 *
 * A no-op on the GitHub store — its board is a repository, and every collaborator writes it. On the
 * local store the `kb-board` branch has exactly one writer (§6.2) and this is where every mutating
 * verb finds that out, before it spends anything.
 * @param {any} ctx
 * @param {string} verb
 */
export function assertOwningHost(ctx, verb = 'this') {
  if (storeKind(ctx) !== 'local') return null;
  return assertLocalOwner(ctx, verb);
}

/**
 * Every method of the interface, in the order §6.4 lists them. The conformance suite asserts a
 * driver has all of them, so a driver that forgets one fails on the shape before any scenario runs.
 */
export const STORE_METHODS = Object.freeze([
  'capabilities',
  'board', 'setBoard',
  'listTasks', 'listClosedRecent', 'getTask', 'createTask', 'updateBody',
  'setStatus', 'setAgent', 'addLabels', 'removeLabel',
  'closeTask', 'reopenTask', 'addBlockedBy', 'removeBlockedBy',
  'loadRun', 'saveRun', 'latestResult', 'parentResults', 'addNote', 'listNotes',
  'claim', 'release', 'listLocks', 'lockBeatAt', 'heartbeat',
  'events',
]);

/**
 * The interface, as a type. Written out rather than inferred from the GitHub driver on purpose:
 * the contract is what A4 and A5 implement, not what one driver happens to return.
 *
 * @typedef {object} Store
 * @property {() => {events: boolean}} capabilities
 *   What this driver can do. `events: false` means `events()` refuses — GitHub has no log to tail.
 * @property {() => {slug: string, host: string|null, paused_at: string|null, paused_by: string|null, settings: any}} board
 * @property {(patch: any) => any} setBoard
 * @property {(opts?: {states?: string[], blockers?: boolean|'all'}) => Promise<any[]>} listTasks
 *   Today's `fetchBoard` shape: number, title, body, kb, status, agent, needsHuman, blockedBy[],
 *   prs[], state, stateReason, createdAt, updatedAt, url. `src/model.js` reads it unchanged.
 * @property {(opts?: {first?: number}) => Promise<any[]>} listClosedRecent
 * @property {(n: number) => Promise<any>} getTask
 * @property {(spec: {title: string, body?: string, kb?: any, status?: string, agent?: string|null}) => Promise<any>} createTask
 * @property {(n: number, body: string) => Promise<any>} updateBody
 * @property {(task: any, status: string, opts?: {add?: string[], remove?: string[]}) => Promise<any>} setStatus
 * @property {(task: any, agent: string) => Promise<any>} setAgent
 * @property {(task: any, names: string[]) => Promise<any>} addLabels
 * @property {(task: any, name: string) => Promise<any>} removeLabel
 * @property {(n: number, reason?: string) => Promise<any>} closeTask
 * @property {(n: number) => Promise<any>} reopenTask
 * @property {(child: number, parent: number) => Promise<any>} addBlockedBy
 * @property {(child: number, parent: number) => Promise<any>} removeBlockedBy
 * @property {(n: number) => Promise<{run: any, id: any}>} loadRun
 * @property {(n: number, runRec: any) => Promise<any>} saveRun
 * @property {(n: number) => Promise<any>} latestResult
 * @property {(task: any) => Promise<any[]>} parentResults
 * @property {(n: number, text: string) => Promise<any>} addNote
 * @property {(n: number) => Promise<{id: any, at: string, actor: string|null, text: string}[]>} listNotes
 * @property {(n: number, k: number) => Promise<{result: 'claimed'|'held'|'unknown', token: string|null}>} claim
 * @property {(n: number, k: number) => Promise<boolean>} release
 * @property {() => Promise<{n: number, k: number, token: string|null, beat_at: string|null}[]>} listLocks
 * @property {(n: number, k: number, token?: string|null) => Promise<string|null>} lockBeatAt
 *   When the attempt last beat. `token` is the sha `listLocks` already handed back: pass it and this
 *   costs one read instead of two.
 * @property {(n: number, k: number, expected: string) => {result: 'ok'|'lost'|'unavailable', token: string|null}|Promise<{result: 'ok'|'lost'|'unavailable', token: string|null}>} heartbeat
 *   One compare-and-swap on the claim, leased on where this worker left it. Returns the verdict AND
 *   the token the next beat leases on — a worker beats every ten minutes, so a bare verdict makes the
 *   second beat lease on the first one's `expected` and read back as `lost`.
 * @property {(opts?: {after?: number, limit?: number}) => Promise<{id: number, at: string, kind: string, number: number|null, payload: any}[]>} events
 */
