---
title: Starting and stopping a board (`hkb up` / `hkb down`)
summary: The two long-running processes as one idempotent verb — pid files as the whole protocol, why only their writer may delete one, why the child gets no KB_*, and the line between reporting exit 4 and supervising it.
category: features
kind: explanation
audience: [dev, ops]
read_when: "touching hkb up/down, the dispatcher's singleton lock, the serve pid file, or anything that has to know whether a board is running"
covers:
  - path: src/up.js
    sha: ea8dbb2e04f73de5c05e87e9a56929a86f78a785
  - path: src/model.js
    sha: 05d5005975c54ed17d366d6816bdb81231c9e121
  - path: src/board.js
    sha: 531dea5f01d7a5f6ea4b85ac525bbc2e7e0e8b3f
  - path: src/dispatch.js
    sha: 32409502ada00707c59aead46b3b8cdb9ed3a2cb
  - path: src/serve.js
    sha: 5565e6d7d79d189d7e62000065340848c669ab38
generated_at_commit: 82910a4
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
and the file is not older than the boot — `processState` (`src/board.js:212-226`)
is the single reader, and `hkb up`, `hkb up --status`, `hkb down`, `hkb doctor`
(`checkDispatcher`, `src/doctor.js:82-88`) and the web board's dispatcher dot
(`dispatcherState`, `src/serve.js:106-109`) all go through it. `since` is the pid
file's **mtime**: the process wrote that file as it started, so the filesystem
already remembers when, and nothing has to be serialised into the file. One pid
per line stays the format, because the dispatcher's own lock has always written
exactly that.

Two writers exist for each file, which is the one subtlety worth carrying:

- **The process itself.** The dispatcher writes its pid inside `acquireLoopLock`
  (`src/dispatch.js:918-937`) — that lock predates `up` and is what actually makes
  two loops impossible. The server does the same through `claimServePid`
  (`src/serve.js:122-135`).
- **`hkb up`, for the child it just spawned** (`claimPid`, `src/up.js:79-86`).
  Without this, two `hkb up`s a millisecond apart would both find nothing and both
  spawn, because a freshly spawned child has not booted far enough to claim
  anything. The pre-write closes that window, and the child finding *its own* pid
  in the file is why neither claimant refuses (`src/dispatch.js:924`).

A live pid that is **not** ours is never overwritten by either writer, so a race
that one child loses cannot leave the file pointing at the loser — and the loser
says so rather than reporting a start it did not win (`src/up.js:122-125`).

**Nothing else deletes these files.** Each process removes its own on exit, and
that is the invariant every other rule here rests on; see *`down` waits* below for
what happened when `down` did not respect it.

## Why the server's claim refuses nothing

The dispatcher's lock is a genuine singleton: two loops against one board sweep
each other's fresh locks and kill each other's workers, which is a real incident
this repo already had. The server has no such property — two boards on two ports
out of one checkout is a legitimate thing to want, and the port is the real
singleton. So `claimServePid` never refuses; it only declines to *overwrite* a
live claim, and says whose it is, so `hkb down --serve` can never be pointed at
the wrong process in silence (`src/serve.js:122-135`).

The same asymmetry explains the `EADDRINUSE` message. A taken port is usually the
operator's own board, and saying so is the difference between "fix this" and
"nothing to fix" — but only the pid file can tell that apart from a stranger's
process, so `portInUse` (`src/serve.js:622-628`) upgrades to *"already up on port
N (pid M)"* only when the file names a live process that is not this one, and
otherwise keeps the old, generic advice.

## The child is this hkb, and is nobody's worker

Two properties of the spawn (`startProcess`, `src/up.js:99-127`) are load-bearing:

**Same code, no PATH lookup.** The child is `process.execPath` plus this
package's own `bin/hkb.js`, resolved from the module itself (`hkbBin`,
`src/up.js:46`). A checkout therefore starts the checkout's dispatcher and a
global install starts the global one, with no chance of a source tree handing its
board to whatever `hkb` a login shell happens to find. (`process.argv[1]` would
usually agree, but not when hkb is driven as a library, through a loader, or under
`node --test`.)

**No `KB_*`.** `detachedEnv` (`src/model.js:788-792`) strips every `KB_*` except
`KB_CONFIG_HOME`, and the board is passed as `--board` on the command line
instead of inherited through `KB_BOARD` (`childArgv`, `src/up.js:49-54`). The
reason is the failure this guards against, not tidiness: `KB_TASK` et al. are what
the dispatcher exports onto a *worker's* launch (`src/dispatch.js:128`), a
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
(`src/dispatch.js:991-1000`). `hkb up` is not that supervisor and must not become
one: it never restarts, never polls, never forks a watchdog. Everything it does
happens once, and then it exits.

But an operator (or an agent session) still needs to see that death in one call,
and the pid file cannot tell them — the loop removed it on the way out, so the
honest-but-useless answer would be "stopped". Hence the **exit record**:
`recordExit` writes `{code, at, reason}` into `.kanban/state.json` under `exits`
(`src/board.js:192-196`), the loop writes it as it throws
(`src/dispatch.js:998`), and `acquireLoopLock` clears it when a loop is running
again (`src/dispatch.js:933`), as does a fresh `up` (`src/up.js:116`). `--status`
then reports `dispatch exited (4) at 19:02 — hkb up restarts it`
(`processLine`, `src/model.js:853-867`) — a sentence that names the fix without
performing it.

It lives in `state.json` rather than a file of its own on purpose: `state.json` is
already local, already gitignored, and a new dot-file would have meant a new
`.gitignore` line in every repo hkb has ever `init`ed.

## `down` waits, and the pid file is not `down`'s to delete

`down` sends `SIGTERM` to what the pid files name and then **waits for the process
to actually be gone** before it reports `stopped` (`down`, `src/up.js:198-234`;
`waitGone`, `src/up.js:174-182`). It never touches workers: a running attempt belongs to the board,
and the next dispatcher reclaims or adopts it — which is exactly what the loop's
own SIGTERM handler already says as it stops.

The first cut did neither: it signalled and `rmSync`'d the pid file in the same
breath. That is the bug the #151 review measured, and it is worth keeping,
because it is the whole reason this page's first section says the pid file *is*
the protocol. Removing the file the instant the signal is sent tells the very next
`hkb up` that nothing is running — while the old loop, which had only set a
`stopping` flag checked *after its next tick*, was still alive. Measured: `down`,
then `--status` reporting `running: false` beside a live pid A; `up` starting B at
+2.9 s; A running a complete tick at +6.4 s next to B. Two dispatchers, one board,
and the singleton lock could not see it, because **the lock is that file**.

The fix is in both halves, and both were needed:

- **The loop can hear the signal.** The wait between ticks is a
  `Promise.race` against a resolver the SIGTERM handler holds (`loop`,
  `src/dispatch.js:945-990`), so a signal landing one second into a sixty-second sleep
  ends the loop *there* rather than buying it another full tick. A tick already in
  flight still finishes — that is deliberate, a half-written claim is worse than a
  slow stop — so the log distinguishes `stopping now` from `stopping after this
  tick`.
- **`down` does not lie, and does not delete.** Each process drops its own pid
  file on exit (`acquireLoopLock`, `src/dispatch.js:934-936`; `claimServePid`,
  `src/serve.js:132-134`); `down` waits, bounded by `stopWaitMs` (two of the
  loop's own intervals, floored at 5 s and capped at 120 s,
  `src/model.js:825-829`), for `pidAlive` to go false. Only then does it tidy a
  file the dead process left behind, and only if it still names the same pid. If
  the wait runs out, the claim stands — because the claim is true — and `down`
  says so and exits non-zero.

Whatever `down` could not do is in the payload as well as the prose:
`--json` carries `failed: [{name, pid, error}]` next to `stopped`, for the signal
that threw and for the process that outlived the wait, and the exit code is 1.
A human line that says "stop it yourself" while the JSON says `{stopped: []}` and
exits 0 is a silent failure, which Value 5 forbids.

`down` stops the dispatcher; `down --serve` stops both. A board server left
running by the asymmetry is not silent about it — `down` names it and the flag
that would stop it — which is the compromise between the flag symmetry with `up`
and never leaving a process the operator forgot about.

## A pid file older than the boot is not a claim

`.kanban/*.pid` is a plain file. It survives a reboot, and after one the pid it
names belongs to whoever the kernel handed it to next — so `kill(pid, 0)` says
"alive", `--status` says "running", and `down` would SIGTERM a stranger's process.

The guard is arithmetic, which is what a zero-dependency CLI can afford: a pid
file whose mtime predates `Date.now() - os.uptime() * 1000` was written by a
machine that has since rebooted, so it cannot name a live process of ours
(`pidFileStale`, `src/model.js:812-817`; read by `readPidFile`,
`src/board.js:176-183`). Every caller that acts on a pid reads that flag as *no
claim here* — `processState`, the dispatcher's singleton lock, the server's claim
and `portInUse`. The slack
(`PID_BOOT_SLACK_MS`) errs towards **believing** a pid file, because the two
clocks differ in kind (mtime is wall time, uptime is monotonic) and calling a live
dispatcher stale is how you get the two loops this whole mechanism exists to
prevent.

## `up` looks again before it says "started"

`spawn` returning a pid means the fork succeeded, not that the process lived.
`started pid 3843` about a child that died in the same millisecond is worse than
an error, because the operator walks away believing the board is up. So
`startProcess` rechecks `pidAlive` after `SPAWN_CHECK_MS` (300 ms,
`src/up.js:120-121`) and, if the child is gone, says `exited immediately (pid N) —
see .kanban/logs/dispatch.log`, which is where the child's own refusal landed. The
same recheck reports the losing side of a `claimPid` race rather than discarding
it.

## Known limits

- **Windows** gets `detached` + `unref` + `windowsHide` and a plain
  `process.kill(pid)` for this first cut. There is no job-object teardown, so a
  child's own children are not guaranteed to go with it; `hkb up --status` is the
  source of truth there. `down`'s wait is the same everywhere, because it only
  asks `pidAlive`.
- The **stale-pid guard is per machine, not per container**: `os.uptime()` is the
  host's, so a pid file written inside a container that has since been recreated
  on a host that never rebooted still reads as a live claim. `pidAlive` and the
  process's own lock remain the second line of defence.
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
  (`startLogLine`, `src/model.js:881-883`). A child that died on startup left its
  reason in there, under that header — and `up` says `exited immediately` rather
  than letting you find it later.
- `dispatch exited (4)` means the loop asked to be restarted, and nothing did:
  `hkb up` is the restart. A repeat within minutes is upstream — check
  `gh auth status` and `hkb doctor`.
- `hkb down` returning non-zero means it could not finish: `--json` names what in
  `failed`. `still running Ns after SIGTERM` is a tick in flight, not a hang —
  `hkb up --status` a moment later says whether it went. A `down` that says
  `stopped` has actually watched the process go.
- `stopped (pid file predates this boot)` after a reboot is expected: the file
  outlived the machine. `hkb up` replaces it; nothing needs deleting by hand.

## Related

- [architecture/overview](../architecture/overview.md)
- [features/web-board](web-board.md)
