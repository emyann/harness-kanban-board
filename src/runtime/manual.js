// The `manual` runtime: a human in a terminal.
//
// `hkb claim <n>` with no `--spawn` writes a `manual` attempt row — somebody is working the card by
// hand, and there is no handle the dispatcher ever knew. `remote` is the same shape written by an
// hkb that still had the GitHub Actions runner: the mode went with ADR-006, but those rows live on
// in run records this release inherits, so they are read here even though nothing writes them.
//
// There is nothing local to inspect, so the heartbeat and `max_runtime` are the whole check. That
// is not a gap in this adapter — it is the reason the seam answers `alive: null` rather than
// `false`: the no-handle rules of the other two would call a perfectly live human crashed three
// minutes in.
import { NOT_IMPLEMENTED, UNKNOWN } from './contract.js';

export const MODE = 'manual';

/** Nothing to launch: a human claims the card, the dispatcher does not spawn one. */
export function launch(ctx, task) {
  const e = new Error(`#${task?.number ?? '?'} is on the manual runtime: a human claims it with \`hkb claim ${task?.number ?? '<n>'}\` and works it in their own terminal — there is nothing for the dispatcher to spawn`);
  e.exitCode = 2;
  throw e;
}

export function inspect() { return { ...UNKNOWN }; }

/** The human is the runtime. Stopping is a row change, which the caller owns. */
export function stop() { return false; }

export function pause() { return NOT_IMPLEMENTED; }
export function resume() { return NOT_IMPLEMENTED; }

export function postMortem() { return null; }
