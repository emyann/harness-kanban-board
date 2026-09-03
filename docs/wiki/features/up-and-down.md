---
title: Starting and stopping a board (`hkb up` / `hkb down`)
summary: The two long-running processes as one idempotent verb — pid files as the whole protocol, why only their writer may delete one, why the child gets no KB_*, and the line between reporting exit 4 and supervising it.
category: features
kind: explanation
audience: [dev, ops]
read_when: "touching hkb up/down, the dispatcher's singleton lock, the serve pid file, or anything that has to know whether a board is running"
covers:
  - path: src/up.js
    sha: 015e0ff4ffa48e110400065f3d496db7ebd4b730
  - path: src/model.js
    sha: 27854e20c9e609f08ab2c49afd2f83eb0fdf08c1
  - path: src/board.js
    sha: 5b2d5227aa6157021e68c1bd169a5019c79e6944
  - path: src/dispatch.js
    sha: 4fbf0d410edd19916fb7ee27ed77648da12f994d
  - path: src/serve.js
    sha: fe50acf9c37de567f1a90fd802e682ab746f6d50
  - path: src/doctor.js
    sha: 2aa97ad82ea530151019ecacb89112607d9163c0
generated_at_commit: b6b4cd7
last_refreshed: 2026-09-03
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
and the file is not older than the boot — `processState` (`src/board.js:225-239`)
is the single reader, and `hkb up`, `hkb up --status`, `hkb down`, `hkb doctor`
(`checkDispatcher`, `src/doctor.js:82-88`) and the web board's dispatcher dot
(`dispatcherState`, `src/serve.js:106-109`) all go through it. `since` is the pid
file's **mtime**: the process wrote that file as it started, so the filesystem
already remembers when, and nothing has to be serialised into the file. One pid
per line stays the format, because the dispatcher's own lock has always written
exactly that.

Two writers exist for each file, which is the one subtlety worth carrying:

- **The process itself.** The dispatcher writes its pid inside `acquireLoopLock`
  (`src/dispatch.js:953-972`) — that lock predates `up` and is what actually makes
  two loops impossible. The server does the same through `claimServePid`
  (`src/serve.js:122-135`).
- **`hkb up`, for the child it just spawned** (`claimPid`, `src/up.js:79-86`).
  Without this, two `hkb up`s a millisecond apart would both find nothing and both
  spawn, because a freshly spawned child has not booted far enough to claim
  anything. The pre-write closes that window, and the child finding *its own* pid
  in the file is why neither claimant refuses (`src/dispatch.js:959`).

A live pid that is **not** ours is never overwritten by either writer, so a race
that one child loses cannot leave the file pointing at the loser — and the loser
says so rather than reporting a start it did not win (`src/up.js:144-147`).

**Nothing else deletes these files.** Each process removes its own on exit, and
that is the invariant every other rule here rests on; see *`down` waits* below for
what happened when `down` did not respect it.

## The server's URL rides the same pre-write/correct pattern (#204)

Before #204, nothing printed the URL a running `hkb serve` answers on — the
only way to it was the first line of `.kanban/logs/serve.log`, a log grep for
a fact the process already knows. `.kanban/serve.url` fixes that with the same
two-writer shape the pid file already has:

- **`hkb up`, before the child boots.** `--port` is a flag on `up`, so the
  origin is in hand at spawn time — `serveOrigin(flags)` in `src/up.js` writes
  `http://127.0.0.1:<port>` (default `DEFAULT_PORT` from `src/serve.js`) the
  moment it wins the pid claim, mirroring `claimPid`'s own pre-write.
- **`hkb serve`, once the port is actually bound.** `claimServePid` (now
  `(root, log, url)`, `src/serve.js:122-135`) overwrites the guess with the
  real bound origin — the one place a raced default, or `--port 0`, could have
  differed from it.

Both writers drop the file together with the pid claim (`dropServeUrl`,
`src/board.js`), so a stopped server never leaves a stale URL behind.
`processState(root, 'serve')` (`src/board.js`) reads it back only while
`running` is true, and `processLine` (`src/model.js`) renders it inline —
`serve running pid N since HH:MM · http://127.0.0.1:4666 · log ...` — so `hkb
up --serve`, `hkb up --status --json` (`serve.url`) and `hkb doctor`'s `serve`
line (`checkServe`, `src/doctor.js`) all name it without a log grep. This is
what closes the opening report's first gap (`skills/kanban/SKILL.md` step 1):
the board and its URL, from one command each.

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

Two properties of the spawn (`startProcess`, `src/up.js:114-149`) are load-bearing:

**Same code, no PATH lookup.** The child is `process.execPath` plus this
package's own `bin/hkb.js`, resolved from the module itself (`hkbBin`,
`src/up.js:46`). A checkout therefore starts the checkout's dispatcher and a
global install starts the global one, with no chance of a source tree handing its
board to whatever `hkb` a login shell happens to find. (`process.argv[1]` would
usually agree, but not when hkb is driven as a library, through a loader, or under
`node --test`.)

**No `KB_*`.** `detachedEnv` (`src/model.js:984-988`) strips every `KB_*` except
`KB_CONFIG_HOME`, and the board is passed as `--board` on the command line
instead of inherited through `KB_BOARD` (`childArgv`, `src/up.js:49-54`). The
reason is the failure this guards against, not tidiness: `KB_TASK` et al. are what
the dispatcher exports onto a *worker's* launch (`src/dispatch.js:151`), a
process carrying them believes it is that worker, and `hkb up` may well be typed
inside such a session. A daemon that outlives the session and believes it is
working on task #148 is a leak with teeth — the dispatcher would refuse to run at
all (`refuseIfWorker`, `src/cli.js:235-238`), and any hook inside it would write
to a stranger's card. `KB_CONFIG_HOME` survives because it is a location, not an
identity: dropping it would send a test's or a smoke run's server at the real
`~/.config/hkb/boards.json`.

## Reporting exit 4 is not supervising it

Exit code 4 is the dispatcher loop deliberately giving itself up: the self-heal
ladder ran out and a *fresh process* is what fixes it, so the loop dies with a
reason for a supervisor — cron, systemd, launchd, or a human — to act on
(`src/dispatch.js:1027-1035`). `hkb up` is not that supervisor and must not become
one: it never restarts, never polls, never forks a watchdog. Everything it does
happens once, and then it exits.

But an operator (or an agent session) still needs to see that death in one call,
and the pid file cannot tell them — the loop removed it on the way out, so the
honest-but-useless answer would be "stopped". Hence the **exit record**:
`recordExit` writes `{code, at, reason}` into `.kanban/state.json` under `exits`
(`src/board.js:205-208`), the loop writes it as it throws
(`src/dispatch.js:1033`), and `acquireLoopLock` clears it when a loop is running
again (`src/dispatch.js:968`), as does a fresh `up` (`src/up.js:131`). `--status`
then reports `dispatch exited (4) at 19:02 — hkb up restarts it`
(`processLine`, `src/model.js:1049-1063`) — a sentence that names the fix without
performing it.

It lives in `state.json` rather than a file of its own on purpose: `state.json` is
already local, already gitignored, and a new dot-file would have meant a new
`.gitignore` line in every repo hkb has ever `init`ed.

## `down` waits, and the pid file is not `down`'s to delete

`down` sends `SIGTERM` to what the pid files name and then **waits for the process
to actually be gone** before it reports `stopped` (`down`, `src/up.js:221-280`;
`waitGone`, `src/up.js:197-205`). It never touches workers: a running attempt belongs to the board,
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
  `src/dispatch.js:992-1025`), so a signal landing one second into a sixty-second sleep
  ends the loop *there* rather than buying it another full tick. A tick already in
  flight still finishes — that is deliberate, a half-written claim is worse than a
  slow stop — so the log distinguishes `stopping now` from `stopping after this
  tick`.
- **`down` does not lie, and does not delete.** Each process drops its own pid
  file on exit (`acquireLoopLock`, `src/dispatch.js:969-970`; `claimServePid`,
  `src/serve.js:132-134`); `down` waits, bounded by `stopWaitMs` (two of the
  loop's own intervals, floored at 5 s and capped at 120 s,
  `src/model.js:1021-1025`), for `pidAlive` to go false. Only then does it tidy a
  file the dead process left behind, and only if it still names the same pid. If
  the wait runs out, the claim stands — because the claim is true — and `down`
  says so and exits non-zero.

Whatever `down` could not do is in the payload as well as the prose:
`--json` carries `failed: [{name, pid, error}]` next to `stopped`, for the signal
that threw and for the process that outlived the wait, and the exit code is 1.
A human line that says "stop it yourself" while the JSON says `{stopped: []}` and
exits 0 is a silent failure, which Value 5 forbids.

Two edges of the same tidy-up (#164): a signal that throws `ESRCH` means the
process died between `processState`'s liveness check and the `kill` call —
`down` was asked for it to be gone, and it is, so that counts as `stopped`, not
`failed` (`src/up.js:252-257`). And a pid file naming a process that is simply
dead — crashed without dropping its own claim, never signalled at all — no
longer sits there forever: `down` tidies it in the same branch that reports
"not running" (`src/up.js:235-246`), the same way it tidies the file of a
process it watched die. A stale pid file goes through the same branch, and the
line names what actually happened — `removed`, not the generic `--status`
phrasing `hkb up replaces it`, when `down` is the one that dropped it.

That tidy-up still has to respect the one invariant (#177): the pid file
`processState` read as dead a moment ago is not necessarily dead *now* — a
concurrent `hkb up`, or the very process racing its own `claimServePid`/
`acquireLoopLock`, can have rewritten it to a fresh live pid in between. So the
removal is never keyed off the `processState` snapshot; `dropDeadPidFile`
(`src/up.js:95-100`) takes a **fresh** read right before the `rmSync` and only
deletes when that read still shows no live claim. `startProcess` uses the same
helper for the symmetric case on the writer's side: a child dead at the
`SPAWN_CHECK_MS` recheck is reported `failed`, and if `up` still owns that
claim it tidies `serve.pid` there rather than leaving it naming the corpse it
just reported (`src/up.js:136-143`) — the bug observed as a stale live-looking
`serve.pid` after a refused port.

`down` stops the dispatcher; `down --serve` stops both. A board server left
running by the asymmetry is not silent about it — `down` names it and the flag
that would stop it — which is the compromise between the flag symmetry with `up`
and never leaving a process the operator forgot about.

## A pid file older than the boot is not a claim

`.kanban/*.pid` is a plain file. It survives a reboot, and after one the pid it
names belongs to whoever the kernel handed it to next — so `kill(pid, 0)` says
"alive", `--status` says "running", and `down` would SIGTERM a stranger's process.

The first guard is arithmetic, which is what a zero-dependency CLI can afford: a
pid file whose mtime predates the boot instant was written by a machine that has
since rebooted, so it cannot name a live process of ours (`pidFileStale`,
`src/model.js:1192`). Boot, in turn, prefers a kernel-reported instant over a
derived one — `/proc/stat`'s `btime` on Linux, `sysctl -n kern.boottime` on
macOS — falling back to `Date.now() - os.uptime() * 1000` where neither is
available (`bootInstantMs`, `src/model.js:1175`; the `/proc`/`sysctl` reads
happen in `readPidFile`, `src/board.js:240-266`, and are injected so tests never
touch a real `/proc`). The slack (`PID_BOOT_SLACK_MS`) errs towards
**believing** a pid file, because the two clocks differ in kind (mtime is wall
time, uptime is monotonic) and calling a live dispatcher stale is how you get
the two loops this whole mechanism exists to prevent.

**The arithmetic alone is not enough on WSL2** (#205). The WSL2 VM's clock is
resynced against the Windows host across every suspend/resume while
`/proc/uptime` keeps counting on its own, so the derived boot instant (and, on
the one machine measured, `btime` too) walks forward past pid files `hkb up`
itself wrote earlier in the same session — ten minutes of skew, unbounded, far
past any slack that wouldn't defeat the guard. So a stale verdict is
**corroborated before it is acted on**, not trusted on its own: if the pid is
alive *and* `/proc/<pid>/cmdline` still names our own `hkb dispatch --loop` /
`hkb serve`, the claim is ours whatever the arithmetic concluded
(`pidClaimStale`, `src/model.js:1229`; the match itself, `cmdlineIsOurs`,
`src/model.js:1207`). Corroboration only ever *rescues* a stale verdict — a pid
file the arithmetic already believes is never checked against `/proc` at all,
and a live pid whose cmdline does **not** match stays refused, which is what
keeps the mirror bug (#202, a pid file surviving a *real* reboot and naming a
pid the kernel has since reissued to a stranger) failing closed. Where there is
no `/proc` to ask (macOS), the timestamp verdict stands on its own, same as
before this fix.

Every caller that acts on a pid reads `stale` as *no claim here* —
`processState`, the dispatcher's singleton lock, the server's claim and
`portInUse` — and none of them had to change: the corroboration lives entirely
inside `readPidFile`, so `hkb up`'s own spawn gate (`startProcess` →
`claimPid`, `src/up.js:79-86`) refuses a rival the same way it always did, just
off a verdict that is now right on WSL2 too.

## `up` looks again before it says "started"

`spawn` returning a pid means the fork succeeded, not that the process lived.
`started pid 3843` about a child that died in the same millisecond is worse than
an error, because the operator walks away believing the board is up. So
`startProcess` rechecks `pidAlive` after `SPAWN_CHECK_MS` (300 ms,
`src/up.js:135`) and, if the child is gone, says `exited immediately (pid N) —
see .kanban/logs/dispatch.log`, which is where the child's own refusal landed. The
same recheck reports the losing side of a `claimPid` race rather than discarding
it.

A dead-at-recheck child goes into `--json`'s `failed: [{name, pid, log}]`, not
`started` — the pure call is `deadAtRecheck` (`src/model.js:1088-1090`, beside
`startDecision`) — and `up`'s exit code is 1 whenever `failed` is non-empty
(`src/up.js:162-189`). The first cut (#151) reported this exact case as
`started`, exit 0, no error field under `--json`: a script driving `hkb up
--serve --port 80` against a refused port saw a clean run for a board that was
not up (#164, second-pass review). The fix changes only what `up` reports —
the process it just watched die is still gone, and `up` still does not restart
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
- The **`SPAWN_CHECK_MS` recheck window is 300 ms, not zero**: a child that dies
  *after* the recheck (`src/up.js:135`) is reported `started`, exit 0 — `up` only
  ever watches the one beat past the fork, not the process's whole startup. A
  crash a few hundred milliseconds later still lands in the log under its
  `# … started pid N` header, but `up`'s own report will have already said the
  board is up.

## For ops

- `hkb up --serve` after `hkb doctor`; `hkb up --status` (add `--json` for a
  script) to see pids, start times and the two log paths; `hkb down --serve` to
  stop. All of it is local: pid files and `kill(0)`, no GitHub call, no cost.
- Logs are `.kanban/logs/dispatch.log` and `.kanban/logs/serve.log`, appended
  across restarts with one `# <ISO> started pid N — hkb …` header per start
  (`startLogLine`, `src/model.js:1077-1079`). A child that died on startup left its
  reason in there, under that header — and `up` says `exited immediately` rather
  than letting you find it later.
- `dispatch exited (4)` means the loop asked to be restarted, and nothing did:
  `hkb up` is the restart. A repeat within minutes is upstream — check
  `gh auth status` and `hkb doctor`.
- `hkb down` returning non-zero means it could not finish: `--json` names what in
  `failed`. `still running Ns after SIGTERM` is a tick in flight, not a hang —
  `hkb up --status` a moment later says whether it went. A `down` that says
  `stopped` has actually watched the process go.
- `hkb up` returning non-zero means a child died at the recheck: `--json` names
  it in `failed: [{name, pid, log}]`, with the log to read. Any process that did
  start is still in `started`, and `up` does not retry the one that did not.
- `stopped (pid file predates this boot)` after a reboot is expected: the file
  outlived the machine. `--status` says `hkb up replaces it`; a `down` that ran
  against it says `removed` instead, because that run is the one that dropped
  it — nothing needs deleting by hand either way.

## On a local board the loop also syncs, and stamps whose it is

Two things ride the end of a tick when the board is on the local store
(`syncPass`, `src/dispatch.js`), and neither runs on a GitHub board:

- **`syncAfterTick`** pushes `kb-board` to the remote and fast-forwards from it
  — but only after a tick that decided something (`DURABLE_TICK_KEYS`), at most
  once a minute (a stamp in `.kanban/state.json`, this host's network rather
  than the board's state), and silently when the laptop is offline. A tick that
  reclaimed nothing and claimed nothing has nothing to push, and a board that
  cannot reach its remote is not a board that stops dispatching. A divergence is
  logged once and never merged: the branch has one writer.
- **`markDispatcher`** writes `{host, pid, at}` into the branch's `board.json`,
  throttled to a third of `HOST_LIVE_MS`. That stamp is the *only* thing that
  lets another machine's `hkb init --take-over` tell a board somebody is still
  ticking from one whose laptop is not coming back — and it is a commit, which
  is why it is throttled and why it rides a tick rather than the beat. It
  reloads the index behind itself: a commit the index has not seen is exactly
  the shape `hkb doctor` reports as a broken index, and skipping it put a
  permanent warning on a perfectly healthy board.

`DURABLE_TICK_KEYS` is what "decided something" means, and it is every key of
the tick's summary that is a list of decisions — `tracks` and `spawn_failed`
and `track_conflicts` included. A track-root dispatch does `saveRun` and
`setStatus(t, 'running')` and reports it under `tracks` alone, so a board driven
by track dispatch that left those keys off never pushed and never re-stamped:
after `HOST_LIVE_MS` another host's `--take-over` sees no live dispatcher and
takes a board that is ticking right now. A test asserts the list against a real
tick's summary rather than a copy of it.

Both are wrapped: a failure here logs `sync skipped: …` and the loop carries
on. The decision has already landed on the branch; the copy on the remote is a
backup. The two git calls that reach the network run through `runGitAsync`
(`src/board.js`) with a 15-second leash rather than `spawnSync`: while a fetch
or a push is out, the loop still has to be able to reap a finished worker, wake
on an event and handle `hkb down`'s SIGTERM.

`hkb sync` is the same push and fast-forward, by hand, on demand. Two things it
is careful about:

- It reads the refs and fetches **before** it reads the board document, so it
  works in a checkout that has no `kb-board` yet — a `--single-branch` clone, or
  one taken before the branch was first pushed. That checkout is the whole
  reason the verb exists, and asking `board()` first threw "there is no kb-board
  branch" at exactly the person running the command to go and get one.
- `settings.sync.push: false` turns off the **push** and nothing else. A host
  that does not publish its copy still has to be able to read a co-worker's, and
  `--no-push` is the same switch as a flag, so the more restrictive spelling can
  never do more work than the default.

It refuses on a GitHub board naming the store the cards are actually on, because
"sync" there would be a verb with nothing to do.

## Related

- [architecture/overview](../architecture/overview.md)
- [architecture/local-store](../architecture/local-store.md)
- [features/web-board](web-board.md)
