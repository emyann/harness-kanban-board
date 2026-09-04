// The runtime seam. One interface over "how a worker actually runs", one module per runtime.
//
// `runtimeFor(x)` is the only place in hkb that knows a profile mode or a handle field by name. The
// tick asks it once and then talks to the adapter: `src/dispatch.js` has no `mode === 'claude-bg'`
// in it, and no `.job`/`.bg` either. See `./contract.js` for the verbs and their shapes, and
// docs/local-first.md §4 for why.
import * as processRuntime from './process.js';
import * as claudeBg from './claude-bg.js';
import * as manual from './manual.js';

export { NOT_IMPLEMENTED, UNKNOWN, REGISTER_GRACE } from './contract.js';

/** Every runtime, by the `mode` a profile writes in `.kanban/board.json`. */
export const RUNTIMES = { [processRuntime.MODE]: processRuntime, [claudeBg.MODE]: claudeBg, [manual.MODE]: manual };

/** @type {((x: any) => any)|null} */
let override = null;

/**
 * Put a runtime in front of the real ones, for a test that must not spawn anything (see
 * `test/fake-runtime.js`). Returns the restore function, exactly like `setStore`.
 *
 * The override is consulted first and may answer `null` for "not mine, use the real one", so a test
 * can fake one runtime and leave the others alone.
 */
export function setRuntime(fn) {
  const previous = override;
  override = fn || null;
  return () => { override = previous; };
}

/**
 * The adapter for a **profile** (which carries a `mode`), an **attempt row** (which carries a handle
 * instead), or a **handle** out of a listing (which names its runtime outright). One function,
 * because they are the same question asked at three points in one life: a row is what is left of the
 * profile that spawned it, and a handle is what the runtime can still see of the row.
 *
 * A row with nothing on it — no `manual`, no job, no pid — is a spawn that never recorded a handle,
 * and the process runtime is what it would have been: `inspect` gives it the registration grace and
 * then writes it off, which is what the tick has always done with that row.
 *
 * An unknown mode falls through to `process` rather than throwing: `undispatchable` (src/dispatch.js)
 * and `removedProfileHint` (src/board.js) are where a board.json that names a mode hkb no longer has
 * is told so, with the fix, and a liveness check is not the place to discover it.
 */
export function runtimeFor(x) {
  if (override) { const chosen = override(x); if (chosen) return chosen; }
  if (!x || typeof x !== 'object') return processRuntime;
  if (typeof x.mode === 'string') return RUNTIMES[x.mode] || processRuntime; // a profile
  if (typeof x.runtime === 'string') return RUNTIMES[x.runtime] || processRuntime; // a handle
  if (x.manual || x.remote) return manual;
  if (x.job || x.bg) return claudeBg;
  return processRuntime;
}

/** The distinct adapters this board's profiles can actually launch. */
function runtimesInUse(ctx) {
  const out = new Set();
  for (const p of Object.values(ctx?.cfg?.profiles || {})) out.add(runtimeFor(p));
  return out;
}

/**
 * Every live handle the runtimes of this board can see, once per tick.
 *
 * Only a runtime with a `listing` has anything to say (`claude agents --json`, one local subprocess),
 * and only when a profile on this board actually uses it — a board of `process` profiles pays
 * nothing. `byId` is what `inspect` matches an attempt's job id against; `all` is what the reap
 * walks, and every entry names its own runtime so stopping one needs no second lookup.
 *
 * @param {any} ctx
 * @param {{log?: (...a: any[]) => void}} opts
 * @returns {{byId: Map<string, any>, all: Array<{runtime: string, id: string, task: number, raw: any, label: string}>}}
 */
export function listHandles(ctx, { log = () => {} } = {}) {
  const byId = new Map();
  const all = [];
  for (const rt of runtimesInUse(ctx)) {
    if (typeof rt.listing !== 'function') continue;
    const r = rt.listing(ctx, log);
    for (const h of r.handles || []) { byId.set(h.id, h.raw); all.push(h); }
  }
  return { byId, all };
}

/** Stop a handle the listing found, rather than a row on the board. */
export function stopHandle(ctx, handle) {
  const rt = runtimeFor(handle);
  return typeof rt?.stopHandle === 'function' ? rt.stopHandle(ctx, handle) : false;
}

/**
 * Execute one card. The process-shaped adapters spawn a session; this is the level at which a
 * second implementation only has to answer "run this card".
 */
export function runCard(ctx, task, k, opts) {
  return runtimeFor(opts.profile).launch(ctx, task, k, opts);
}

/**
 * Execute a whole subgraph — a track root plus the nodes it is blocked by. For every adapter here
 * that is one runner session handed the subgraph's brief, so it is `launch`; an adapter that can run
 * a wave in one call overrides `runTrack` and reads `opts.track` ({nodes, waves, branch, mode})
 * instead of the rendered prompt. That is the shape that makes an SDK runtime a file in this
 * directory rather than a change to the tick.
 */
export function runTrack(ctx, root, k, opts) {
  const rt = runtimeFor(opts.profile);
  return (rt.runTrack || rt.launch)(ctx, root, k, opts);
}
