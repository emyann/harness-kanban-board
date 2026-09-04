// The runtime double: an in-memory adapter that records what the tick asked of it and spawns
// nothing. `test/fake-store.js` is the board, `test/fake-gh.js` the forge, and this is the runtime —
// the same split, for the same reason: a test that asserts on a launch should not need a `claude`
// binary on PATH, a worktree on disk, or a process to reap afterwards.
//
//   const rt = installRuntime();
//   t.after(rt.restore);
//   ... tick ...
//   assert.deepEqual(rt.launches.map((l) => l.task), [7]);
//
// It answers `runtimeFor` for **every** shape by default, so nothing in the tick reaches a real
// adapter. Pass `only` to fake one runtime and leave the others real.
import { setRuntime, NOT_IMPLEMENTED } from '../src/runtime/index.js';

/**
 * @param {object} [opts]
 * @param {(x: any) => boolean} [opts.only]     which shapes this double answers for (default: all)
 * @param {Array<any>} [opts.handles]           what `listing` reports this tick: [{id, task, raw}]
 * @param {(attempt: any) => any} [opts.liveness]  what `inspect` says about an attempt row
 * @param {(handle: any) => boolean} [opts.stopFails]  handles whose `stop` reports failure
 */
export function installRuntime({ only = null, handles = [], liveness = null, stopFails = () => false } = {}) {
  const launches = [];
  const stops = [];
  const pauses = [];
  const resumes = [];
  const inspected = [];
  let nextPid = 9000;

  const adapter = {
    MODE: 'fake',

    launch(ctx, task, k, opts = {}) {
      const pid = nextPid++;
      launches.push({ task: task.number, attempt: k, argv: opts.argv || [], cwd: opts.cwd || null, wt: opts.wt || null, name: opts.name || null, profile: opts.profileName || null, track: opts.track || null, pid });
      return {
        argv: opts.argv || [], pid, wt: opts.wt || null, logFile: opts.logFile || null,
        continued: opts.continued || null, tools_dropped: opts.toolsDropped || [],
        handle: { runtime: 'fake', pid },
        row: opts.wt ? { pid, wt: opts.wt } : { pid },
        describe: `fake pid ${pid}`,
      };
    },

    inspect(ctx, attempt, extra = {}) {
      inspected.push({ attempt: attempt?.attempt ?? null, jobs: extra.jobs ? [...extra.jobs.keys()] : [] });
      const said = liveness ? liveness(attempt, extra) : null;
      return { alive: null, working: null, handle: null, session: null, outcome: null, patch: null, ...(said || {}) };
    },

    stop(ctx, attempt) {
      const ok = !stopFails(attempt);
      stops.push({ attempt: attempt?.attempt ?? null, number: attempt?.number ?? null, ok });
      return ok;
    },

    pause(ctx, attempt) { pauses.push(attempt?.attempt ?? null); return NOT_IMPLEMENTED; },
    resume(ctx, attempt) { resumes.push(attempt?.attempt ?? null); return NOT_IMPLEMENTED; },
    postMortem() { return null; },

    listing() {
      return { ok: true, handles: handles.map((h) => ({ runtime: 'fake', id: h.id, task: h.task, raw: h.raw ?? h, label: `fake agent ${h.id}` })) };
    },

    stopHandle(ctx, handle) {
      const ok = !stopFails(handle);
      stops.push({ handle: handle.id, ok });
      return ok;
    },
  };

  const restore = setRuntime((x) => (only && !only(x) ? null : adapter));
  return { adapter, launches, stops, pauses, resumes, inspected, restore };
}
