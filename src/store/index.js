// The store seam. One interface over board state, one driver behind it.
//
// `openStore(ctx)` is the only way a command should reach board state. There is **one** store now —
// the local one of docs/local-first.md §6 (`./local.js`: the `kb-board` branch and the
// `.git/hkb/index.db` index, as one `Store`). The GitHub driver is gone: GitHub Issues was the
// board until this release, and it comes back later as a *bridge* adapter, not as a second store
// (ADR-006). The seam stays, because the seam is what let it be replaced at all.
//
// **The method names below are the contract.** They are §6.4 verbatim. Do not rename one, and do
// not add one without adding it to the conformance suite in `test/store.test.js` — the suite is what
// says a driver implements the interface, and a method no scenario exercises is a method the next
// driver will get wrong.
//
// What is **not** in the store: pull requests. `openPrsByHead`, `mergedPrsByHead`, `fillPrs`,
// `prMergeStates`, `enableAutoMerge`, `branchProtection`, `mergePullRequest`, `prChecksState` and
// `finishPr` live in `src/forge.js` and go on calling `src/gh.js` — a local board still opens its
// work on a forge (§6.4), and the branch name `kb-<n>-<k>` is what ties a pull request to a card.

/** Forget any per-context store state — `hkb init` has just created the branch under its own feet. */
export async function forgetStore(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  closeStore(ctx);
  // Loaded on demand, not at module scope: `store/index.js` is imported by every verb, including
  // `hkb hook pretool`, and `local.js` pulls in `node:sqlite`.
  const { forgetGitTiers } = await import('./local.js');
  forgetGitTiers(ctx);
}

/**
 * Close the store this context is holding, if it opened one. Safe to call twice, and safe on a
 * context that never reached the seam.
 *
 * The long-lived processes call it where their context dies: `hkb serve` when the server closes,
 * `hkb dispatch` when the loop leaves, `hkb doctor` and the one-shot CLI in the `finally` around
 * `main()`. A verb that runs and exits need not — but nothing is *hurt* by it either, which is why
 * the call sites that have a natural `finally` use one.
 */
export function closeStore(ctx) {
  if (!ctx || typeof ctx !== 'object') return false;
  let closed = false;
  for (const slot of ['_store', '_storeRO']) {
    const held = ctx[slot];
    if (!held) continue;
    ctx[slot] = null;
    closed = true;
    try { held.close?.(); } catch { /* a handle we are done with: nothing to report and nobody to tell */ }
  }
  return closed;
}

/**
 * Which store a board uses. There is one, and this is where a board.json that still names the other
 * one is told so.
 *
 * `"store"` in `.kanban/board.json` is `"local"` or absent; `"github"` was the other answer until
 * the GitHub store was retired (ADR-006, docs/local-first.md §1 item 9) and is now an error that
 * names the migration rather than a mode that half-works. Absent means local: a `git clone` of a
 * board needs no configuration, and there is nothing else it could mean.
 *
 * The key is deliberately still read rather than assumed. A board on the old store is a real thing
 * somebody may still have on disk, and "your board is on a store this hkb no longer has, here is
 * how to move it" is the only honest thing to say to them.
 *
 * @param {any} ctx  a context from `makeContext`/`makeContextAt` (src/board.js)
 * @returns {string} always 'local'
 */
export function storeKind(ctx) {
  const declared = ctx?.cfg?.store;
  if (!declared || declared === 'local') return 'local';
  if (declared === 'github') {
    const e = /** @type {any} */ (new Error('this board is on the GitHub store, which hkb no longer has (ADR-006). Move it with `hkb init --import`, which reads the kb:* issues once and writes them to the kb-board branch; then drop "store" from .kanban/board.json.'));
    e.exitCode = 2;
    throw e;
  }
  const e = /** @type {any} */ (new Error(`"store": "${declared}" in .kanban/board.json is not a store — hkb has one, the local kb-board branch. Drop the key.`));
  e.exitCode = 2;
  throw e;
}

/**
 * `./local.js`, loaded the first time something actually needs board state.
 *
 * **Not a static import.** A static `import` of `local.js` here pulls `sqlite.js` into every command
 * that so much as mentions the seam, so on a node built without SQLite — or one still gating it
 * behind a flag — `hkb list`, `hkb show` and, worst, `hkb hook pretool` die with
 * `ERR_UNKNOWN_BUILTIN_MODULE` before `main()` runs, rather than where the board is read. The hook's
 * own contract is to stand aside rather than throw onto a worker's tool call.
 *
 * This is why `openStore` and `assertOwningHost` are async: `local.js` is reachable only through an
 * `await import`, the way `cli.js` and `init.js` already reach it.
 */
export function localModule() { return import('./local.js'); }

/**
 * The store the seam hands out, when something has replaced it — `setTransport`'s counterpart for
 * board state, and the only reason it exists is the test suite (`test/fake-store.js`).
 *
 * A test that asserts on *board behaviour* — "the lock was released", "nothing was written", "the
 * run record says three attempts" — should not have to know which driver answered, and until this
 * hook existed the only way to see those facts was to read the in-memory GitHub's REST log. That
 * made 121 assertion sites depend on `src/store/github.js` staying alive (docs/local-first.md §11).
 * With the override in place a test installs a `Store` and asserts on the interface instead.
 *
 * Production never sets it. It is deliberately *not* consulted by `storeKind`: what a board is kept
 * in is still `.kanban/board.json` and nothing else, so a test that overrides the store does not
 * also silently change what `hkb doctor`, `hkb gc` and `hkb init` say the board is.
 * @type {((ctx: any) => any)|null}
 */
let storeOverride = null;

/**
 * Install `fn` as the store `openStore`/`openStoreReadOnly` return. Returns the restore function,
 * the way `setTransport` (src/gh.js) does, so a test can `t.after(restore)`.
 * @param {((ctx: any) => any)|null} fn
 */
export function setStore(fn) {
  const previous = storeOverride;
  storeOverride = fn || null;
  return () => { storeOverride = previous; };
}

/**
 * The store for `ctx` — **one handle per context, for the life of that context**.
 *
 * The memo is not an optimisation, it is the fix for a class of bug this repo has already paid for
 * once: `gc.js` used to open a store per tick and *"leaked one handle per tick until the process hit
 * its file-descriptor limit"*. Every verb reaches board state through this function, and the
 * long-lived processes call several verbs per tick or per request — `hkb serve` alone opens four for
 * one `GET /task/42`, `hkb doctor` twenty for one run — so "close it in a `finally`" has to be
 * written correctly at every one of forty call sites or the leak comes back at the one that forgot.
 * Handing back the same handle means there is one thing to close, and `closeStore(ctx)` closes it.
 *
 * A local store is still **reconciled on every call**, which is what `openLocalStore` does for a
 * fresh one: one `rev-parse`, and nothing more when the branch tip has not moved. So a memoized
 * handle sees exactly what a fresh one would, and a second process's commit is never missed.
 *
 * @param {any} ctx  a context from `makeContext`/`makeContextAt` (src/board.js)
 * @returns {Promise<Store>}
 */
export async function openStore(ctx) {
  const cacheable = !!ctx && typeof ctx === 'object';
  const held = cacheable ? ctx._store : null;
  if (held) {
    // Reconcile, the way a freshly opened local store does. A double need not offer `open`.
    try { held.open?.(); } catch { /* a reconcile that cannot run leaves the last good index in place */ }
    return held;
  }
  // The override answers *inside* the memo, not in front of it: a double handed back before the
  // cache never enters it, `closeStore(ctx)` finds nothing to close, and the handle lifecycle every
  // verb depends on is the one part of this seam no test could exercise through a double.
  let store;
  if (storeOverride) store = storeOverride(ctx);
  else {
    storeKind(ctx); // a board.json naming a store hkb does not have says so here, before any I/O
    store = (await localModule()).openLocalStore(ctx);
  }
  if (cacheable) ctx._store = store;
  return store;
}

/**
 * A store for a reader that must never write — `hkb serve`'s connection.
 *
 * On the local driver this is `openIndexReadOnly` (`{readOnly: true, timeout: 0}`), the connection
 * `sqlite.js` and `doctor.js` both name as the server's: a read-write handle in a long-lived server
 * can block on the dispatcher's write transaction in the middle of a request, and a server has no
 * business reindexing the branch under the loop that owns it. It also does not reconcile, for the
 * same reason — the dispatcher's own store is what keeps the index current.
 *
 * @param {any} ctx
 * @returns {Promise<Store>}
 */
export async function openStoreReadOnly(ctx) {
  const cacheable = !!ctx && typeof ctx === 'object';
  if (cacheable && ctx._storeRO) return ctx._storeRO;
  // Same rule as `openStore`: the override lands in the memo, so the reader's handle is closed
  // through `closeStore` like a real one.
  if (storeOverride) {
    const store = storeOverride(ctx);
    if (cacheable) ctx._storeRO = store;
    return store;
  }
  storeKind(ctx); // a board.json naming a store hkb does not have says so here too
  const { openLocalStore } = await localModule();
  const store = openLocalStore(ctx, { reconcile: false, readOnly: true });
  // Its own slot, never `_store`. `hkb serve` reads through this one and *writes* through the
  // lifecycle verbs, which call `openStore(ctx)` on the same context — parking a read-only handle
  // where they look would make every drag on the web board fail as a refused write.
  if (cacheable) ctx._storeRO = store;
  return store;
}

/**
 * Refuse a verb that writes the board on a host that does not own it.
 *
 * The `kb-board` branch has exactly one writer (§6.2) and this is where every mutating verb finds
 * that out, before it spends anything.
 * @param {any} ctx
 * @param {string} verb
 */
export async function assertOwningHost(ctx, verb = 'this') {
  storeKind(ctx);
  const { assertLocalOwner } = await localModule();
  return assertLocalOwner(ctx, verb);
}

/**
 * Every method of the interface, in the order §6.4 lists them. The conformance suite asserts a
 * driver has all of them, so a driver that forgets one fails on the shape before any scenario runs.
 */
export const STORE_METHODS = Object.freeze([
  // `root()` is on the list because it was the one member two drivers once disagreed about — a
  // property on one, a function on the other — and the shape check could not say so about a name it
  // was not given. Every member of the interface belongs here, including the dull ones.
  'root', 'capabilities',
  'board', 'setBoard',
  'listTasks', 'listClosedRecent', 'getTask', 'createTask', 'updateBody', 'setKb',
  'setStatus', 'setAgent', 'addLabels', 'removeLabel', 'ensureLabels',
  'closeTask', 'reopenTask', 'addBlockedBy', 'removeBlockedBy',
  'loadRun', 'saveRun', 'latestResult', 'parentResults', 'addNote', 'listNotes',
  'claim', 'release', 'listLocks', 'lockBeatAt', 'heartbeat', 'lockRef',
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
 * @property {(opts?: {first?: number, since?: string|null}) => Promise<any[]>} listClosedRecent
 *   The closed cards, most recently updated first. `first` is a **total ceiling**, not a page size —
 *   a driver that pages walks as many as it takes — and `since` is a window (an ISO date): a card
 *   updated before it is history the caller did not ask for. A driver that stops early because
 *   `first` ran out with more still inside the window says so with `tagCapped` (src/model.js); a
 *   list nobody tagged was not cut short.
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
 * @property {(n: number, k: number) => string|null} lockRef
 *   Where this claim lives, when the store has a name for it. `null` on a store that keeps its
 *   claims in a table, which is every store hkb ships. The same optional `ref` `claim()` and
 *   `listLocks()` carry, asked for a claim the caller did not just make: `hkb heartbeat` prints it,
 *   and so does the LOCK_LOST error. A caller falls back to the attempt number, which every store
 *   has (`cli.js`'s `c.ref || \`attempt ${k}\``).
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
