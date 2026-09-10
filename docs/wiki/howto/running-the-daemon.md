---
title: Running the daemon under a supervisor
summary: Keep `hkb up` alive across reboots — a systemd user unit or a launchd agent around `hkb up --foreground`, where the log goes, and the restart-after-upgrade rule.
category: howto
kind: how-to
audience: [dev]
read_when: "installing hkb on a machine that should keep reconciling without somebody logged in at a terminal"
covers:
  - path: src/daemon.ts
    sha: 22f946c6625de1f566d4301e098873050b23ac12
  - path: src/workspaces.ts
    sha: b709212e781376f570a613907a209648dab91526
  - path: src/hkb.ts
    sha: eb759e566ef71b11caa34cc0945a6e2ae30958cf
  - path: src/runtime/claude.ts
    sha: e3afb9de9e34d90f222e7bf9865cbad39e99044b
  - path: src/db-url.ts
    sha: 075e55c592c972b3505f106ac670a277996f0615
generated_at_commit: 2b8902f
last_refreshed: 2026-09-10
related: [architecture/the-loop, architecture/job-kind, decisions/adr-007-workload-scheduler, decisions/adr-018-the-boundary]
---

# Running the daemon under a supervisor

`hkb up` detaches on its own: it spawns this same binary with `up --foreground`
and returns (`src/daemon.ts:503-531`). That is enough for a laptop and nothing
more — the child dies with the machine, and nothing brings it back.

`hkb up --foreground` exists for the other case. It runs the loop in *this*
process (`src/hkb.ts:1284-1305`), so a supervisor owns the lifecycle: it starts the
process, restarts it, captures its output, and stops it with a signal. This page
is the recipe. Why the loop looks the way it does — level-triggered, 45 seconds,
leadership as a row — is [architecture/the-loop](../architecture/the-loop.md);
none of it is repeated here.

## Before you write a unit

**One daemon serves every board on the machine.** Leadership is taken per board
through a `Controller` row, and a daemon re-reads the board list every tick
(`src/daemon.ts:354-360`), so a board created next week is picked up without a
restart. You want **one** unit, not one per repository.

**Point each board at its checkout.** A Job runs in `Board.repoPath`; the
daemon's own cwd is only the fallback for a board that has none
(`src/daemon.ts:383-386`, `src/hkb.ts:1301-1303`). Run `hkb boards add <slug> --repo
<path>` once per repository and the unit needs no meaningful working directory.

**Use an absolute path to `hkb`.** A user service does not inherit the PATH your
shell builds — under nvm in particular, `hkb` is on PATH only inside an
interactive shell. Take the answer from `command -v hkb` and paste it in. `hkb`
needs Node >= 22.18.0 (`package.json`), so if the unit runs a system Node that
is older, invoke the Node you mean by absolute path too.

## systemd (Linux), as a user unit

A user unit, not a system one: the board is `~/.hkb/board.db`
(`src/db-url.ts:19-24`) and workers run against your checkouts, your git
credentials and your agent auth. Write `~/.config/systemd/user/hkb.service`:

```ini
[Unit]
Description=hkb — reconcile every board on this machine
After=network-online.target

[Service]
Type=simple
ExecStart=/home/you/.local/share/nvm/versions/node/v22.18.0/bin/hkb up --foreground
Restart=on-failure
RestartSec=30
TimeoutStopSec=180

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now hkb.service
systemctl --user status hkb.service
```

Four choices in there are load-bearing:

- **`Type=simple`** — `--foreground` never forks or writes a pid file. The
  process systemd starts is the process that runs the loop (`src/hkb.ts:1285`, `src/hkb.ts:1301-1304`).
- **No `ExecStop`.** SIGTERM is already the clean stop, and it is a *stop*, not a
  kill: the handler aborts the run in flight and deliberately does not exit,
  because the lease release is written on the way out of `reconcile`
  (`src/hkb.ts:1290-1299`). The loop then unwinds, records `daemon_down` and
  releases its controller rows (`src/daemon.ts:478-484`). systemd's default kill
  action sends exactly that signal to the main process, so anything you add here
  can only make it worse.
- **`TimeoutStopSec` generous.** A clean stop includes interrupting a worker,
  which is not instant — `hkb down` waits 60s by default and deliberately never
  escalates to SIGKILL, because killing a daemon mid-unwind trades a slow stop
  for a lost attempt row (`src/daemon.ts:589-597`). Give systemd at least as
  long before it does the escalation `hkb down` refuses to do.
- **`Restart=on-failure`, not `always`.** A tick that throws is caught and logged
  and the loop carries on (`src/daemon.ts:465-470`), so an actual exit means
  something structural. A clean SIGTERM exits 0 (`src/hkb.ts:1304`), and
  `on-failure` leaves `systemctl --user stop hkb` meaning stop.

Add `--board <slug>` to `ExecStart` only if you deliberately want this daemon to
serve one board and leave the rest unserved.

### Surviving logout

A user manager is normally torn down when your last session ends, which takes
the daemon with it. Once, per machine:

```bash
loginctl enable-linger "$USER"
```

That starts your user manager at boot and keeps it after logout — which is what
makes `WantedBy=default.target` mean "at boot" rather than "at next login".

## launchd (macOS)

The equivalent is a LaunchAgent at
`~/Library/LaunchAgents/dev.hkb.hkb.plist`. `RunAtLoad` + `KeepAlive` with
`SuccessfulExit=false` is launchd's `Restart=on-failure`; a LaunchAgent is
already per-user, so there is no linger to enable.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.hkb.hkb</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/hkb</string>
    <string>up</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>180</integer>
  <key>StandardOutPath</key><string>/Users/you/.hkb/hkb.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.hkb/hkb.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.hkb.hkb.plist
launchctl print gui/$(id -u)/dev.hkb.hkb
launchctl bootout  gui/$(id -u)/dev.hkb.hkb   # stop; SIGTERM, same clean path
```

`ExitTimeOut` is the launchd counterpart of `TimeoutStopSec`, and it matters for
the same reason: launchd SIGTERMs first and SIGKILLs when the timeout runs out.

A Mac that sleeps is fine — the loop detects the wall-clock jump and skips
reclaim for exactly that pass ([architecture/the-loop](../architecture/the-loop.md)).

## Where the log goes

Two different places, depending on who started the loop, and this trips people up:

- **`hkb up` (detached).** The parent opens a file and hands it to the child as
  stdout and stderr (`src/daemon.ts:507-527`): `<boardDir>/hkb.log` for a
  machine-wide daemon, `<boardDir>/hkb-<slug>.log` when `--board` was given
  (`src/daemon.ts:70-71`).
- **`hkb up --foreground` (under a supervisor).** The loop writes lines to
  stdout (`src/daemon.ts:311`), so the log is wherever your supervisor puts
  stdout — the journal for systemd, `StandardOutPath` for launchd.

`<boardDir>` is the directory holding the board file — `~/.hkb` unless
`HKB_DATABASE_URL` points elsewhere (`src/db-url.ts:19-24`) — and `hkb up
--status` prints it for you when anything is running (`src/hkb.ts:1279`):

```bash
hkb up --status              # names the log directory
journalctl --user -u hkb -f  # systemd: the foreground loop's own output
tail -f ~/.hkb/hkb.log       # launchd, or a detached `hkb up`
```

`hkb up --status` exits 1 when no board is being served (`src/hkb.ts:1281`), so it
doubles as a health check in a script.

### What the loop says, and what it says only once

Most of a tick is silent. The lines that appear are the ones that **changed**:
a board it cannot lead, a refusal from a ceiling, a workspace git would not take
back, and a **run that cannot go on** — a step behind a failed predecessor, or
one whose workflow file was deleted after the run was cut. All four go through
one helper that remembers the last thing it said for that key and stays quiet
until the answer differs (`src/daemon.ts`), which is what lets a standing fact be
reported at all: a reconciler recomputes it every tick, so logging it per pass
would fill the file with one sentence.

The consequence worth knowing: **a stalled run is announced once.** If you start
tailing the log after it happened you will not see it — `hkb run` in the
foreground recomputes and prints the current list, which is the way to ask.

If your unit sets `Environment=HKB_DATABASE_URL=...`, remember that it moves the
log directory with the board (`src/db-url.ts:26-29`) — and that your shell,
without that variable, is then looking at a different board entirely.

⚠️ Two boards over the **same repository** is not currently safe, and the reason
changed shape with ADR-018 rather than going away. A workspace is named
`kb-<jobId>` — per Job, not per attempt (`workspaceName`, `src/workspaces.ts:25`)
— and `Board.repoPath` carries no unique constraint (`prisma/schema.prisma`,
`model Board`), so two boards may point at one checkout. The sweep then asks the
board about every `kb-*` worktree it finds in that repository, filtered to *its
own* `boardId`, and treats a name it cannot match as a Job whose row is gone —
collectable immediately, with no TTL to wait out (`src/daemon.ts:419-440`). Board
A therefore deletes board B's workspaces. A run in flight is saved by the `git
worktree lock` the runtime holds and by nothing else. One board per repository
until that is fixed.

## The tick also collects workspaces — `ttlSecondsAfterFinished`, and nothing else

A worker installs the target repository's dependencies to run its tests, so each
workspace costs about what that repository costs — Phase 5 left 6.1 GB for ten
Jobs. The daemon takes them back every 10 minutes, after reconciling each board
(`SWEEP_EVERY_MS`, `src/daemon.ts:57`; the block itself is
`src/daemon.ts:396-463`). The first tick sweeps, so a restart reclaims
immediately rather than ten minutes later.

**What it no longer does is look inside a tree.** The old sweep asked each
checkout whether it held uncommitted or unpushed work, and kept it if so — a
question that only had an answer while the core required a push, and one that was
wrong in both directions: it kept a tree for ever when a branch was never pushed,
and it had no opinion at all about age. ADR-018 replaced it with `batch/v1`'s own
answer: **a finished Job's workspace is collectable once its TTL has elapsed**,
and a Job that has not finished keeps its workspace whatever its age, because a
later attempt resumes *in* it (`collectable`, `src/workspaces.ts:119-128`).

Four things a workspace is kept for, and they are the whole rule:

- the Job has not finished (`finishedAt` is null) — `pending`, `running` and
  `suspended` are all in that set;
- it finished less than **an hour** ago (`BUILT_IN_TTL_SECONDS`,
  `src/workspaces.ts:48`) — the window an operator has to go and look at what a
  run left;
- it is **resumable** and inside the longer window: `phase === 'failed'` with a
  session id still on the row gets `RESUMABLE_TTL_SECONDS` — a day — instead of the
  hour, so `hkb retry <id>` continues in the tree that session's transcript describes
  (`src/daemon.ts`, `src/workspaces.ts`). A cancelled Job and a `done` one keep a
  session id too and neither counts, which is what makes this narrower than "has a
  session";
- **it belongs to another board.** `Board.repoPath` has no unique constraint, so two
  boards can share a checkout; existence is asked across every board and ownership
  second, and a workspace whose Job belongs elsewhere is not this sweep's to consider;
- git refuses. `removeWorkspace` runs plain `git worktree remove` and **never**
  `--force` (`src/workspaces.ts:150-170`), so a locked tree — the runtime holds a
  `git worktree lock` for the length of a run — or one holding uncommitted or
  untracked work is left on disk and named.

> **Being resumable delays collection; it does not veto it.** An earlier version of this made a
> resumable Job permanently uncollectable, which is unbounded — a board that accumulates failures
> accumulates a full checkout each, for ever, with no time term anywhere. A retry window has to be a
> window: generous, because the operator was told to retry and may read the advice tomorrow, but
> finite. Past it the workspace goes and a retry starts cold — the session id is still on the Job, so
> it resumes the transcript and simply works in a fresh checkout.
> `ttlSecondsAfterFinished` becoming a real spec field is where a board would get to say otherwise.

The sweep starts from **one `git worktree list --porcelain`** per board and then
asks the board about the names it found, never the other way round
(`existingWorkspaces`, `src/workspaces.ts:63-83`). Only `kb-<n>` directories are
candidates, so a worktree you made yourself is never one however old it is; and
the path git reported is the path that is removed, rather than one rebuilt from a
convention — hkb does not decide where a workspace lands. The harness does, under
`.claude/worktrees/<name>` (`src/runtime/claude.ts:71-89`).

Two kinds of line come out of it, into the same log as everything else:

```
swept kb-12 — its Job finished more than 60 minutes ago
kept  kb-9 — fatal: 'kb-9' is a locked working tree — something is still using it
```

A `kept` line is printed **once**, not every ten minutes, the same way a refusal
is (`src/daemon.ts:459`) — so it reappears only when the reason changes. A `swept`
line is also an `Event` on the board, so `hkb watch` sees it
(`src/daemon.ts:452-454`).

Nothing here reads the remote any more, which retires the whole
`SSH_AUTH_SOCK`-under-systemd warning this section used to carry: the sweep's
proof was once `git ls-remote`, and the sweep now runs entirely against the local
worktree list. Your unit may still want credentials that survive a logout —
workers push over that transport — but the daemon's own housekeeping no longer
depends on it.

## The gotcha: a daemon runs the code it started with

Upgrading `hkb` does **not** upgrade the running daemon. It has the old
controller, the old admission gate, the old runtime, until it is restarted. The
previous dispatcher had the same hazard and it was managed by remembering, which
is not a mechanism (`src/daemon.ts:73-88`).

So the daemon records the build it started from, and `hkb up --status` compares
that against the checkout and prints a line when they differ
(`src/daemon.ts:243-244`, `src/hkb.ts:1271-1275`):

```
default  up    host/12345@daemon  87 min, every 45s
         repo    /home/you/src/thing
         BEHIND  started from 741b855; the checkout is now a1b2c3d — `hkb down && hkb up` to pick it up
```

Under a supervisor the fix is the supervisor's restart, not `hkb down && hkb up`
(which would leave systemd to restart it anyway, or launchd to race you):

```bash
systemctl --user restart hkb.service           # Linux
launchctl kickstart -k gui/$(id -u)/dev.hkb.hkb  # macOS
```

**Make it part of the upgrade**, immediately after `npm i -g hkb-cli@latest` or
a `git pull` — the same command, every time. `BEHIND` is the safety net, not the
plan.

One honest limit: the build stamp is `git rev-parse --short HEAD` in the package
root, and it is `unknown` when that fails (`src/daemon.ts:80-88`). Status only
claims `BEHIND` when both sides are a real answer (`src/daemon.ts:243-244`), so
for a published install from npm — no git, no `HEAD` — the line never appears.
There, the restart-on-upgrade habit is the whole mechanism.

## Related

- [the-loop](../architecture/the-loop.md) — why the loop is level-triggered, why
  45 seconds, why leadership is a row, and why an operator stop is its own outcome.
- [job-kind](../architecture/job-kind.md) — what a tick actually reconciles.
