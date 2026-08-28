---
title: Starting and stopping a board (`hkb up` / `hkb down`)
summary: The two long-running processes as one idempotent verb — pid files as the whole protocol, why the child gets no KB_*, and the line between reporting exit 4 and supervising it.
category: features
kind: explanation
audience: [dev, ops]
read_when: "touching hkb up/down, the dispatcher's singleton lock, the serve pid file, or anything that has to know whether a board is running"
covers:
  - path: src/up.js
    sha: e5961d2a1f306e059ca30c53dbbdd8d97be8b83c
  - path: src/model.js
    sha: 712380d3b6cf6ffd77490cdfe299685362f628c3
  - path: src/board.js
    sha: 80cc7f328c1c7081d1f32a418af16675bef9b223
  - path: src/dispatch.js
    sha: 94d758e2fabfc4897bce2a5a1c855b1909c800ca
  - path: src/serve.js
    sha: 2d846a589a4ea4fc7f86b814bcb1646ad8f12cc7
generated_at_commit: 616f0b7
last_refreshed: 2026-08-28
related: [architecture/overview, features/web-board, concepts/roles-and-seats, architecture/dispatcher-tick]
---

# Starting and stopping a board (`hkb up` / `hkb down`)

> Every piece of this existed before the verb did: the dispatcher's singleton
> lock, `pidAlive`, the web board reading that lock to draw its dot, `logsDir()`,
> and the detached-spawn pattern the dispatcher uses for workers. What was
> missing was one command that put them together — so "make sure the board is
> running" was a shell recipe (`setsid nohup … &`, a redirect, a log directory
> nobody would find next week), different on every machine and **unwritable for a
> harness that vets a command line word by word**. `hkb up` is that recipe as a
> verb; `hkb down` is its inverse (#148).

## The pid file is the whole protocol

There is no daemon registry, no state machine and no supervisor process. A
process is running if `.kanban/<name>.pid` names a pid that answers `kill(pid, 0)`
— `processState` (`src/board.js:181-194`) is the single reader, and `hkb up`,
`hkb up --status`, `hkb down`, `hkb doctor` (`src/doctor.js:82-87`) and the web
board's dispatcher dot (`dispatcherState`, `src/serve.js:106-109`) all go through
it. `since` is the pid file's **mtime**: the process wrote that file as it
started, so the filesystem already remembers when, and nothing has to be
serialised into the file. One pid per line stays the format, because the
dispatcher's own lock has always written exactly that.

Two writers exist for each file, which is the one subtlety worth carrying:

- **The process itself.** The dispatcher writes its pid inside `acquireLoopLock`
  (`src/dispatch.js:863-881`) — that lock predates `up` and is what actually makes
  two loops impossible. The server does the same through `claimServePid`
  (`src/serve.js:122-134`).
- **`hkb up`, for the child it just spawned** (`claimPid`, `src/up.js:68-75`).
  Without this, two `hkb up`s a millisecond apart would both find nothing and both
  spawn, because a freshly spawned child has not booted far enough to claim
  anything. The pre-write closes that window, and the child finding *its own* pid
  in the file is why neither claimant refuses (`src/dispatch.js:869`).

A live pid that is **not** ours is never overwritten by either writer, so a race
that one child loses cannot leave the file pointing at the loser.

## Why the server's claim refuses nothing

The dispatcher's lock is a genuine singleton: two loops against one board sweep
each other's fresh locks and kill each other's workers, which is a real incident
this repo already had. The server has no such property — two boards on two ports
out of one checkout is a legitimate thing to want, and the port is the real
singleton. So `claimServePid` never refuses; it only declines to *overwrite* a
live claim, and says whose it is, so `hkb down --serve` can never be pointed at
the wrong process in silence (`src/serve.js:122-134`).

The same asymmetry explains the `EADDRINUSE` message. A taken port is usually the
operator's own board, and saying so is the difference between "fix this" and
"nothing to fix" — but only the pid file can tell that apart from a stranger's
process, so `portInUse` (`src/serve.js:621-627`) upgrades to *"already up on port
N (pid M)"* only when the file names a live process that is not this one, and
otherwise keeps the old, generic advice.

## The child is this hkb, and is nobody's worker

Two properties of the spawn (`startProcess`, `src/up.js:83-102`) are load-bearing:

**Same code, no PATH lookup.** The child is `process.execPath` plus this
package's own `bin/hkb.js`, resolved from the module itself (`hkbBin`,
`src/up.js:35`). A checkout therefore starts the checkout's dispatcher and a
global install starts the global one, with no chance of a source tree handing its
board to whatever `hkb` a login shell happens to find. (`process.argv[1]` would
usually agree, but not when hkb is driven as a library, through a loader, or under
`node --test`.)

**No `KB_*`.** `detachedEnv` (`src/model.js:721-725`) strips every `KB_*` except
`KB_CONFIG_HOME`, and the board is passed as `--board` on the command line
instead of inherited through `KB_BOARD` (`childArgv`, `src/up.js:38-43`). The
reason is the failure this guards against, not tidiness: `KB_TASK` et al. are what
the dispatcher exports onto a *worker's* launch (`src/dispatch.js:90-94`), a
process carrying them believes it is that worker, and `hkb up` may well be typed
inside such a session. A daemon that outlives the session and believes it is
working on task #148 is a leak with teeth — the dispatcher would refuse to run at
all (`refuseIfWorker`, `src/cli.js:232-235`), and any hook inside it would write
to a stranger's card. `KB_CONFIG_HOME` survives because it is a location, not an
identity: dropping it would send a test's or a smoke run's server at the real
`~/.config/hkb/boards.json`.

## Reporting exit 4 is not supervising it

Exit code 4 is the dispatcher loop deliberately giving itself up: the self-heal
ladder ran out and a *fresh process* is what fixes it, so the loop dies with a
reason for a supervisor — cron, systemd, Actions, or a human — to act on
(`src/dispatch.js:918-926`). `hkb up` is not that supervisor and must not become
one: it never restarts, never polls, never forks a watchdog. Everything it does
happens once, and then it exits.

But an operator (or an agent session) still needs to see that death in one call,
and the pid file cannot tell them — the loop removed it on the way out, so the
honest-but-useless answer would be "stopped". Hence the **exit record**:
`recordExit` writes `{code, at, reason}` into `.kanban/state.json` under `exits`
(`src/board.js:161-175`), the loop writes it as it throws
(`src/dispatch.js:924`), and `acquireLoopLock` clears it when a loop is running
again (`src/dispatch.js:877`), as does a fresh `up` (`src/up.js:99`). `--status`
then reports `dispatch exited (4) at 19:02 — hkb up restarts it`
(`processLine`, `src/model.js:749-760`) — a sentence that names the fix without
performing it.

It lives in `state.json` rather than a file of its own on purpose: `state.json` is
already local, already gitignored, and a new dot-file would have meant a new
`.gitignore` line in every repo hkb has ever `init`ed.

## What `down` deliberately does not do

`down` sends `SIGTERM` to what the pid files name and removes them
(`src/up.js:150-174`). It never touches workers: a running attempt belongs to the
board, and the next dispatcher reclaims or adopts it — which is exactly what the
loop's own SIGTERM handler already says as it stops. The loop finishes its current
tick before exiting, so "stopping" is the honest word in the output, and the pid
file is removed immediately rather than being waited for.

`down` stops the dispatcher; `down --serve` stops both. A board server left
running by the asymmetry is not silent about it — `down` names it and the flag
that would stop it — which is the compromise between the flag symmetry with `up`
and never leaving a process the operator forgot about.

## Known limits

- **Windows** gets `detached` + `unref` and a plain `process.kill(pid)` for this
  first cut. There is no job-object teardown, so a child's own children are not
  guaranteed to go with it; `hkb up --status` is the source of truth there.
- A **second server on another port** claims nothing, so `hkb down --serve` stops
  the one that holds the pid file, not that one. It is reported at claim time, not
  discovered later.
- `up` does not forward `--profiles`, so a host that dispatches only some profiles
  still wants `hkb dispatch --loop` under a supervisor.

## For ops

- `hkb up --serve` after `hkb doctor`; `hkb up --status` (add `--json` for a
  script) to see pids, start times and the two log paths; `hkb down --serve` to
  stop. All of it is local: pid files and `kill(0)`, no GitHub call, no cost.
- Logs are `.kanban/logs/dispatch.log` and `.kanban/logs/serve.log`, appended
  across restarts with one `# <ISO> started pid N — hkb …` header per start
  (`startLogLine`, `src/model.js:774`). A child that died on startup left its
  reason in there, under that header.
- `dispatch exited (4)` means the loop asked to be restarted, and nothing did:
  `hkb up` is the restart. A repeat within minutes is upstream — check
  `gh auth status` and `hkb doctor`.

## Related

- [architecture/overview](../architecture/overview.md)
- [features/web-board](web-board.md)
