---
title: Running the daemon under a supervisor
summary: Keep `kb up` alive across reboots — a systemd user unit or a launchd agent around `kb up --foreground`, where the log goes, and the restart-after-upgrade rule.
category: howto
kind: how-to
audience: [dev]
read_when: "installing kb on a machine that should keep reconciling without somebody logged in at a terminal"
covers:
  - path: src/daemon.ts
    sha: bc52944c00d0abf3bf340f39f94c07031276d8b8
  - path: src/kb.ts
    sha: 02e4527afcfe3565dd5e4503b03dbb3cd0e03384
  - path: src/db-url.ts
    sha: 83ad1e24bb34864843b0c731f9680c6cbc7de1ea
generated_at_commit: ae722cb
last_refreshed: 2026-09-05
related: [architecture/the-loop, architecture/job-kind, decisions/adr-007-workload-scheduler]
---

# Running the daemon under a supervisor

`kb up` detaches on its own: it spawns this same binary with `up --foreground`
and returns (`src/daemon.ts:360-388`). That is enough for a laptop and nothing
more — the child dies with the machine, and nothing brings it back.

`kb up --foreground` exists for the other case. It runs the loop in *this*
process (`src/kb.ts:388-409`), so a supervisor owns the lifecycle: it starts the
process, restarts it, captures its output, and stops it with a signal. This page
is the recipe. Why the loop looks the way it does — level-triggered, 45 seconds,
leadership as a row — is [architecture/the-loop](../architecture/the-loop.md);
none of it is repeated here.

## Before you write a unit

**One daemon serves every board on the machine.** Leadership is taken per board
through a `Controller` row, and a daemon re-reads the board list every tick
(`src/daemon.ts:281-285`), so a board created next week is picked up without a
restart. You want **one** unit, not one per repository.

**Point each board at its checkout.** A Job runs in `Board.repoPath`; the
daemon's own cwd is only the fallback for a board that has none
(`src/daemon.ts:195-196`, `src/kb.ts:405-407`). Run `kb boards add <slug> --repo
<path>` once per repository and the unit needs no meaningful working directory.

**Use an absolute path to `kb`.** A user service does not inherit the PATH your
shell builds — under nvm in particular, `kb` is on PATH only inside an
interactive shell. Take the answer from `command -v kb` and paste it in. `kb`
needs Node >= 22.18.0 (`package.json`), so if the unit runs a system Node that
is older, invoke the Node you mean by absolute path too.

## systemd (Linux), as a user unit

A user unit, not a system one: the board is `~/.hkb/board.db`
(`src/db-url.ts:20-28`) and workers run against your checkouts, your git
credentials and your agent auth. Write `~/.config/systemd/user/kb.service`:

```ini
[Unit]
Description=kb — reconcile every board on this machine
After=network-online.target

[Service]
Type=simple
ExecStart=/home/you/.local/share/nvm/versions/node/v22.18.0/bin/kb up --foreground
Restart=on-failure
RestartSec=30
TimeoutStopSec=180

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kb.service
systemctl --user status kb.service
```

Four choices in there are load-bearing:

- **`Type=simple`** — `--foreground` never forks or writes a pid file. The
  process systemd starts is the process that runs the loop (`src/kb.ts:405-408`).
- **No `ExecStop`.** SIGTERM is already the clean stop, and it is a *stop*, not a
  kill: the handler aborts the run in flight and deliberately does not exit,
  because the lease release is written on the way out of `reconcile`
  (`src/kb.ts:394-403`). The loop then unwinds, records `daemon_down` and
  releases its controller rows (`src/daemon.ts:335-342`). systemd's default kill
  action sends exactly that signal to the main process, so anything you add here
  can only make it worse.
- **`TimeoutStopSec` generous.** A clean stop includes interrupting a worker,
  which is not instant — `kb down` waits 60s by default and deliberately never
  escalates to SIGKILL, because killing a daemon mid-unwind trades a slow stop
  for a lost attempt row (`src/daemon.ts:436-455`). Give systemd at least as
  long before it does the escalation `kb down` refuses to do.
- **`Restart=on-failure`, not `always`.** A tick that throws is caught and logged
  and the loop carries on (`src/daemon.ts:322-327`), so an actual exit means
  something structural. A clean SIGTERM exits 0 (`src/kb.ts:408`), and
  `on-failure` leaves `systemctl --user stop kb` meaning stop.

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
`~/Library/LaunchAgents/dev.hkb.kb.plist`. `RunAtLoad` + `KeepAlive` with
`SuccessfulExit=false` is launchd's `Restart=on-failure`; a LaunchAgent is
already per-user, so there is no linger to enable.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.hkb.kb</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/kb</string>
    <string>up</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>180</integer>
  <key>StandardOutPath</key><string>/Users/you/.hkb/kb.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.hkb/kb.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.hkb.kb.plist
launchctl print gui/$(id -u)/dev.hkb.kb
launchctl bootout  gui/$(id -u)/dev.hkb.kb   # stop; SIGTERM, same clean path
```

`ExitTimeOut` is the launchd counterpart of `TimeoutStopSec`, and it matters for
the same reason: launchd SIGTERMs first and SIGKILLs when the timeout runs out.

A Mac that sleeps is fine — the loop detects the wall-clock jump and skips
reclaim for exactly that pass ([architecture/the-loop](../architecture/the-loop.md)).

## Where the log goes

Two different places, depending on who started the loop, and this trips people up:

- **`kb up` (detached).** The parent opens a file and hands it to the child as
  stdout and stderr (`src/daemon.ts:364-384`): `<boardDir>/kb.log` for a
  machine-wide daemon, `<boardDir>/kb-<slug>.log` when `--board` was given
  (`src/daemon.ts:52-54`).
- **`kb up --foreground` (under a supervisor).** The loop writes lines to
  stdout (`src/daemon.ts:242`), so the log is wherever your supervisor puts
  stdout — the journal for systemd, `StandardOutPath` for launchd.

`<boardDir>` is the directory holding the board file — `~/.hkb` unless
`HKB_DATABASE_URL` points elsewhere (`src/db-url.ts:20-32`) — and `kb up
--status` prints it for you when anything is running (`src/kb.ts:383`):

```bash
kb up --status              # names the log directory
journalctl --user -u kb -f  # systemd: the foreground loop's own output
tail -f ~/.hkb/kb.log       # launchd, or a detached `kb up`
```

`kb up --status` exits 1 when no board is being served (`src/kb.ts:385`), so it
doubles as a health check in a script.

If your unit sets `Environment=HKB_DATABASE_URL=...`, remember that it moves the
log directory with the board (`src/db-url.ts:26-32`) — and that your shell,
without that variable, is then looking at a different board entirely.

## The gotcha: a daemon runs the code it started with

Upgrading `kb` does **not** upgrade the running daemon. It has the old
controller, the old admission gate, the old runtime, until it is restarted. The
previous dispatcher had the same hazard and it was managed by remembering, which
is not a mechanism (`src/daemon.ts:56-71`).

So the daemon records the build it started from, and `kb up --status` compares
that against the checkout and prints a line when they differ
(`src/daemon.ts:184-185`, `src/kb.ts:376-379`):

```
default  up    host/12345@daemon  87 min, every 45s
         repo    /home/you/src/thing
         BEHIND  started from 741b855; the checkout is now a1b2c3d — `kb down && kb up` to pick it up
```

Under a supervisor the fix is the supervisor's restart, not `kb down && kb up`
(which would leave systemd to restart it anyway, or launchd to race you):

```bash
systemctl --user restart kb.service           # Linux
launchctl kickstart -k gui/$(id -u)/dev.hkb.kb  # macOS
```

**Make it part of the upgrade**, immediately after `npm i -g hkb-cli@latest` or
a `git pull` — the same command, every time. `BEHIND` is the safety net, not the
plan.

One honest limit: the build stamp is `git rev-parse --short HEAD` in the package
root, and it is `unknown` when that fails (`src/daemon.ts:63-71`). Status only
claims `BEHIND` when both sides are a real answer (`src/daemon.ts:184-185`), so
for a published install from npm — no git, no `HEAD` — the line never appears.
There, the restart-on-upgrade habit is the whole mechanism.

## Related

- [the-loop](../architecture/the-loop.md) — why the loop is level-triggered, why
  45 seconds, why leadership is a row, and why an operator stop is its own outcome.
- [job-kind](../architecture/job-kind.md) — what a tick actually reconciles.
