---
title: Telling an adopter their hkb is old
summary: Updates are pull-only, so something has to say there is something to pull — one npm GET a day, in doctor and the dispatcher loop, and why a stale CLI hides a stale skill.
category: features
kind: explanation
audience: [dev, ops]
read_when: "touching the daily version check, doctor's version or skill lines, the day stamps in .kanban/state.json, or anything that would put a network call on an ordinary command"
covers:
  - path: src/registry.js
    sha: a9bee54d56c6b9351bc4e6cab3d0a4d29d0c422f
  - path: src/doctor.js
    sha: 1bf85debb35d283881c5aa72ac1179445e5913c2
  - path: src/dispatch.js
    sha: 0cdcd4fea6cdc34ea29807ca292f5de26bd03019
  - path: src/board.js
    sha: 7e895ff3e7e8380a61fd275e609d93dfce2140e1
  - path: src/init.js
    sha: c4aeb61643f9b6457e3307e9663ade2543f75dba
related: [architecture/overview, features/auto-merge, gotchas/long-lived-process-rot]
generated_at_commit: 8005801
last_refreshed: 2026-08-27
---

# Telling an adopter their hkb is old

> hkb has no push channel and should not have one: it is a CLI over `gh`, with
> no service and nothing that phones home. Updates are pull-only — which works
> only if something tells you there is something to pull. That something is one
> `GET https://registry.npmjs.org/hkb-cli` a day (`src/registry.js`), read in
> the two places that have an audience for it and nowhere else.

## The bug was the green line, not the missing one

The skill half already worked: `hkb init` re-copies the packaged skill, and
`checkSkill` (`src/doctor.js`) compares the *installed* copy's `SKILL.md`
version against the *packaged* one and warns with `hkb init` as the fix.

The compound is what made it urgent. A stale CLI carries a stale packaged
skill, so `installed` and `packaged` agree, `checkSkill` reports `✓ skill`, and
doctor prints "All good" on an install months behind — including behind fixes
to the very paths it is checking. The one check that existed was silently
disarmed by the one that did not. `test/update.test.js` asserts exactly that
pair: skill green, version warning, on one checkout.

## The shape: `tokenExpiryNotice`, copied on purpose

The daily-probe pattern already existed for KB_TOKEN expiry
(`tokenExpiryNotice`, `src/doctor.js`) and was copied rather than reinvented —
read `.kanban/state.json`, compare a `*_day` stamp, do nothing if it already
ran today, **stamp only on success** so a failure retries next time.
`dailyLatest` (`src/doctor.js`) is that shape with its own key, plus one
addition: it stamps the *answer* (`version_latest`) as well as the day
(`version_check_day`), so a second `hkb doctor` the same day still names what
npm has without a second call.

The precedent needed one repair on the way. `tokenExpiryNotice` was written for
the loop in #44 and never called from it, so no long-running dispatcher had
ever warned about a lapsing KB_TOKEN; #93 wired both notices at the same call
site in `loop` (`src/dispatch.js`). A daily probe with no caller is a check
that reports nothing — the same shape of silence this page is about.

Four properties are load-bearing, and each has a test:

- **Never on the hot path.** Only `checkVersion` (doctor) and `versionNotice`
  (the loop) call `dailyLatest`. `hkb list` waits on npm for nothing — asserted
  end-to-end through `main(['list'])`.
- **Offline is not a failure.** A rejected fetch means no notice, no error and
  no stamp: the finding degrades to the installed version alone, which is what
  an install with no check at all would print. `src/registry.js` follows no
  redirects and never retries; a timeout bounds the whole thing.
- **UTC days.** `utcDay()` slices an ISO string, never `toLocale*`, so two
  hosts dispatching one board in two zones probe once between them rather than
  twice — the same reason the token stamp does it (`src/doctor.js`).
- **A pinned install is a choice.** `"version_check": false` in
  `.kanban/board.json` (`DEFAULT_BOARD`, `src/board.js`) stops the ask
  entirely; doctor then says the installed version once, with nothing to fix.

## Two audiences, two voices

`hkb doctor` prints the line on every run — someone running doctor is asking
"is this healthy", and "you are five releases behind" is part of that answer.
Being *ahead* of the registry (a git checkout, a release in flight) is reported
as a fact, not a problem; only behind is a warning, and a warning does not
change doctor's exit code.

The dispatcher loop logs one line on the first tick of a day it is behind, and
on no other tick (`loop`, `src/dispatch.js`) — a loop that has been up for
weeks is exactly the install most likely to be stale, and its operator is not
running doctor. It is called outside `tick()` because it read-modify-writes
`.kanban/state.json`, and it never throws, so a tick cannot be lost to it.

An Actions dispatcher needs neither: the generated workflow installs
`npm i -g hkb-cli` unpinned on every run (`actionsFiles`, `src/init.js`), so it
is current by construction — and it runs a single tick, not the loop.

## Why there is no `hkb update`

Value 4 says one command beats two, and the upgrade is two:
`npm i -g hkb-cli@latest && hkb init`. It stays two.

hkb cannot know how it was installed — a global npm, an npx cache, a pnpm or
volta shim, a git checkout — so a self-installer would guess at the prefix, the
permissions and the package manager, and getting that wrong breaks the tool
doing the guessing while it is running out of the directory being replaced.
`upgradeCommand` (`src/doctor.js`) does the one adaptation it can defend: an
hkb running from an npx cache is told `npx -y hkb-cli@latest init`, because
`npm i -g` is not what that user did (`isEphemeralPath`, `src/init.js`).

The second command is not overhead either. A new CLI ships a new skill, and
`hkb init` is what copies it into the checkout — the same idempotent init that
`checkSkill` already points at. Printing both is the honest answer.

## For ops

- **Where it surfaces:** a `hkb version` line in `hkb doctor`, and at most one
  `hkb version: ...` line a day in the dispatcher log.
- **To silence it:** `"version_check": false` in `.kanban/board.json`.
- **If you never see it:** the stamp is per checkout, so a board that is
  dispatched from a laptop tells that laptop; a colleague on another clone
  hears it on their own first run of the day. Someone driving the board by hand
  (`docs/manual-mode.md`) runs neither doctor nor the loop and is told nothing —
  a known gap, and the reason `hkb doctor` remains worth running occasionally.

## Related

- [hkb at a glance](../architecture/overview.md)
- [The last step — `dispatch.merge` and GitHub's auto-merge](./auto-merge.md)
