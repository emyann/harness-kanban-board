// The store seam. One interface over board state, one driver behind it.
//
// `openStore(ctx)` is the only way a command should reach board state, and the only place that
// decides which driver answers: the GitHub one (`./github.js`) or the local store of
// docs/local-first.md §6 (`./local.js` — the `kb-board` branch and the `.git/hkb/index.db` index as
// one `Store`). The decision is `"store"` in `.kanban/board.json` and nothing else; see `storeKind`.
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

/** Forget any per-context store state — `hkb init` has just created the branch under its own feet. */
export async function forgetStore(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  // Loaded on demand, not at module scope: `store/index.js` is imported by every verb, including
  // `hkb hook pretool` on a plain GitHub board, and `local.js` pulls in `node:sqlite`.
  const { forgetGitTiers } = await import('./local.js');
  forgetGitTiers(ctx);
}

/**
 * Which store a board uses, and **the only place that decides it** (the card's contract).
 *
 * **One answer: `store` in `.kanban/board.json`.** `"local"` is the `kb-board` branch, anything else
 * — including the key being absent — is GitHub. `hkb init` writes the key when it creates a local
 * board, and that write is the opt-in.
 *
 * There used to be a second rule: *a repository with a `kb-board` (or `<remote>/kb-board`) ref is a
 * local board*. It was there so a `git clone` of a local board needed no config, and it is gone,
 * because a rule that infers the store from a **ref** can be reached by `git fetch` — by another
 * host's push, by a colleague's experiment — and it flips a checkout onto the local store while
 * `.kanban/board.json` still points every verb at GitHub. That half-migrated state produced a
 * destructive interaction in each of the last three reviews:
 *
 *   · `hkb init --import` inferred `local`, migrated, and deleted the lock refs of live workers;
 *   · `gc.sweep` read the board through the local store, got `[]` because the cards were still
 *     issues, concluded every card was finished and destroyed worker worktrees — uncommitted work
 *     included — unattended, from the dispatcher's own `gc_every_ticks`;
 *   · one host pushing `kb-board` converted every collaborator on their next fetch, and
 *     `assertOwningHost` then refused every write verb on a board whose cards they had always owned.
 *
 * Each was patched where it surfaced; the cause was this inference, so the inference is what is
 * fixed. An explicit key cannot arrive by fetch, cannot be written by another host, and cannot
 * disagree with what the verbs do. A clone still gets the board with no configuration — it reads
 * the key out of the tracked `.kanban/board.json`, which is *more* deterministic than inferring it
 * from whichever refs that clone happens to carry. A checkout that has the branch but not the key is
 * told so in words (`hkb init`, `hkb doctor`), which is a message and never a behaviour.
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
  return 'github';
}

/**
 * `./local.js`, loaded the first time a local board actually needs it.
 *
 * **A GitHub board must not load `node:sqlite`.** A static `import` of `local.js` here pulled
 * `sqlite.js` into every command that reaches the store seam, so on a node built without SQLite —
 * or one still gating it behind a flag — `hkb list`, `hkb show` and, worst, `hkb hook pretool` died
 * with `ERR_UNKNOWN_BUILTIN_MODULE` before `main()` ran, on a board that has nothing to do with it.
 * The hook's own contract is to stand aside rather than throw onto a worker's tool call.
 *
 * This is why `openStore` and `assertOwningHost` are async: `local.js` is reachable only through an
 * `await import`, the way `cli.js` and `init.js` already reach it.
 */
export function localModule() { return import('./local.js'); }

/**
 * The store for `ctx`.
 * @param {any} ctx  a context from `makeContext`/`makeContextAt` (src/board.js)
 * @returns {Promise<Store>}
 */
export async function openStore(ctx) {
  if (storeKind(ctx) !== 'local') return openGithubStore(ctx);
  const { openLocalStore } = await localModule();
  return openLocalStore(ctx);
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
export async function assertOwningHost(ctx, verb = 'this') {
  if (storeKind(ctx) !== 'local') return null;
  const { assertLocalOwner } = await localModule();
  return assertLocalOwner(ctx, verb);
}

/**
 * Every method of the interface, in the order §6.4 lists them. The conformance suite asserts a
 * driver has all of them, so a driver that forgets one fails on the shape before any scenario runs.
 */
export const STORE_METHODS = Object.freeze([
  // `root()` is on the list because it was the one member the drivers disagreed about — a property
  // on the local store, a function on the GitHub one — and the shape check could not say so about a
  // name it was not given. Every member of the interface belongs here, including the dull ones.
  'root', 'capabilities',
  'board', 'setBoard',
  'listTasks', 'listClosedRecent', 'getTask', 'createTask', 'updateBody', 'setKb',
  'setStatus', 'setAgent', 'addLabels', 'removeLabel', 'ensureLabels',
  'closeTask', 'reopenTask', 'addBlockedBy', 'removeBlockedBy',
  'loadRun', 'saveRun', 'latestResult', 'parentResults', 'addNote', 'listNotes',
  'claim', 'release', 'listLocks', 'lockBeatAt', 'heartbeat',
  'lockToken', 'beatToken', 'resyncBeat', 'dropBeat',
  'events', 'taskEvents',
]);

/**
 * The interface, as a type. Written out rather than inferred from the GitHub driver on purpose:
 * the contract is what A4 and A5 implement, not what one driver happens to return.
 *
 * @typedef {object} Store
 * @property {() => string} root
 *   The store's root: the common git dir's parent, never a linked worktree.
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
 * @property {(task: any, kb: any, bodyText?: string) => Promise<any>} setKb
 *   The other half of `updateBody`: replace the machine block, keep the prose. `hkb edit` and
 *   `hkb adopt` write the kb block and nothing else, and on GitHub the two travel in one field —
 *   so a driver that only offered "replace the prose" made the kb block unreachable through the
 *   interface. The task passed in is updated in place, the way `setStatus` updates it.
 * @property {(task: any, status: string, opts?: {add?: string[], remove?: string[]}) => Promise<any>} setStatus
 * @property {(task: any, agent: string) => Promise<any>} setAgent
 * @property {(task: any, names: string[]) => Promise<any>} addLabels
 * @property {(task: any, name: string) => Promise<any>} removeLabel
 * @property {(names: string[]) => string[]|Promise<string[]>} ensureLabels
 *   Make these label names applicable, and answer with the ones that had to be created. A driver
 *   whose labels are columns on a card has nothing to create and answers `[]` — the call is still
 *   the caller's, because on GitHub a label must exist before `addLabels` can put it on an issue.
 * @property {(n: number, reason?: string) => Promise<any>} closeTask
 * @property {(n: number) => Promise<any>} reopenTask
 * @property {(child: number, parent: number) => Promise<any>} addBlockedBy
 * @property {(child: number, parent: number) => Promise<any>} removeBlockedBy
 * @property {(n: number) => Promise<{run: any, id: any}>} loadRun
 * @property {(n: number, runRec: any) => Promise<any>} saveRun
 * @property {(n: number) => Promise<any>} latestResult
 * @property {(task: any) => Promise<any[]>} parentResults
 * @property {(n: number, text: string) => Promise<{id: any, at: string|null, actor: string|null, text: string, url: string|null}>} addNote
 *   The note as it landed. `url` is where a person can read it, or null on a store that has no page
 *   for one — `hkb comment` and the MCP tool both answer with it.
 * @property {(n: number) => Promise<{id: any, at: string, actor: string|null, text: string}[]>} listNotes
 * @property {(n: number, k: number) => Promise<{result: 'claimed'|'held'|'unknown', token: string|null, ref?: string|null, error?: any}>} claim
 *   `token` is what the first heartbeat leases on. `ref` is optional and names *where* the claim
 *   lives when the store has such a name (the lock ref on GitHub); a store that keeps its claims in
 *   a table has none, so a caller that prints it falls back to the attempt number.
 * @property {(n: number, k: number) => Promise<boolean>} release
 * @property {() => Promise<{n: number, k: number, token: string|null, beat_at: string|null, ref?: string|null}[]>} listLocks
 *   One row per live claim. `ref` is optional for the same reason it is on `claim`.
 * @property {(n: number, k: number, token?: string|null) => Promise<string|null>} lockBeatAt
 *   When the attempt last beat. `token` is the sha `listLocks` already handed back: pass it and this
 *   costs one read instead of two.
 * @property {(n: number, k: number, expected: string) => {result: 'ok'|'lost'|'unavailable', token: string|null, expected: string, detail: string}|Promise<{result: 'ok'|'lost'|'unavailable', token: string|null, expected: string, detail: string}>} heartbeat
 *   One compare-and-swap on the claim, leased on where this worker left it. Returns the verdict AND
 *   the token the next beat leases on — a worker beats every ten minutes, so a bare verdict makes the
 *   second beat lease on the first one's `expected` and read back as `lost`. `detail` says why an
 *   `unavailable` beat could not be made, because `hkb heartbeat` prints that sentence before it
 *   falls back to the run record.
 * @property {(n: number, k: number) => string|null|Promise<string|null>} lockToken
 *   The claim's token as the *store* has it, or null when the claim is gone (= reclaimed). The
 *   authoritative read: a rejected lease is evidence, this is the answer.
 * @property {(n: number, k: number) => string|null} beatToken
 *   The token this host's next beat should lease on, from local state only — no network, no
 *   throw. `null` means "this host has not beaten on this claim", never "the claim is gone".
 * @property {(n: number, k: number, token: string) => boolean} resyncBeat
 *   Point this host's local beat state at `token`, after `lockToken` said the claim moved without us.
 * @property {(n: number, k: number) => boolean} dropBeat
 *   Forget this host's local beat state for a finished attempt. Worktrees share one ref store, so a
 *   terminal verb that leaves one behind makes the next attempt's first beat lease on a dead chain.
 * @property {(opts?: {after?: number, limit?: number}) => Promise<{id: number, at: string, kind: string, number: number|null, payload: any}[]>} events
 * @property {(n: number) => Promise<{at: string, kind: string, detail: string, actor: string|null}[]>} taskEvents
 *   One card's history as the store kept it, oldest first — what `hkb log` interleaves with the run
 *   record's attempts. Unlike `events()` this is never refused: a driver with no log answers with
 *   whatever it does have, which for GitHub is the issue timeline.
 */
