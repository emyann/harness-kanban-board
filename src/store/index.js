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

/**
 * The store for `ctx`. Today: always the GitHub one.
 * @param {any} ctx  a context from `makeContext`/`makeContextAt` (src/board.js)
 * @returns {Store}
 */
export function openStore(ctx) {
  return openGithubStore(ctx);
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
 * @property {(n: number, k: number) => Promise<string|null>} lockBeatAt
 * @property {(n: number, k: number, expected: string) => 'ok'|'lost'|'unavailable'|Promise<'ok'|'lost'|'unavailable'>} heartbeat
 * @property {(opts?: {after?: number, limit?: number}) => Promise<{id: number, at: string, kind: string, number: number|null, payload: any}[]>} events
 */
