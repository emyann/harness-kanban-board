---
title: The path_overlap guard — three modes, and never behind an idle attempt
summary: Why the guard exists (the merge conflict, not the worktree one), the off/running/unmerged modes and their merge.mode defaults, and how idleness — job, pid, or lock-ref beat — keeps it from holding a card hostage.
category: features
kind: explanation
audience: [dev]
read_when: "touching the path_overlap guard, dispatch.guards.path_overlap, attemptIdle, or why two cards did or did not run in parallel"
covers:
  - path: src/model.js
    sha: 27854e20c9e609f08ab2c49afd2f83eb0fdf08c1
  - path: src/dispatch.js
    sha: 90ed0ce8799b29e82a2e96f4cde8f0bb98c6dc00
  - path: src/doctor.js
    sha: 03a19a3c5f2cab7dcae844c9290ed34c03637b80
generated_at_commit: 237bb61
last_refreshed: 2026-09-02
related: [features/tracks, features/review-loop, concepts/worker-identity]
---

# The path_overlap guard — three modes, and never behind an idle attempt

> Every worker runs in its own worktree, so `path_overlap` was never about two
> workers touching one file at once — it exists to avoid the *merge* conflict
> when two open PRs both touch the same files (#185). Measured on a real
> board before this: it released at *review*, not at merge, so on a `manual`
> board (the default) it serialized almost everything and every card still
> conflicted on landing anyway.

## Three modes, `pathOverlapGuard` (`src/model.js`)

`dispatch.guards.path_overlap` in `.kanban/board.json` picks which open-board
tasks count as "still in the way" of a claim candidate whose `kb.paths`
overlap theirs — computed by `pathHolders` (`src/model.js`):

- `"off"` — nothing holds anything.
- `"running"` — a `running` card does (the pre-#185 behaviour, kept for
  boards that want it back).
- `"unmerged"` — `"running"`, plus a card in `review` whose PR is still
  `OPEN` — the honest serial-landing reading: it has not merged, so the
  collision the guard exists to avoid is still ahead of it.

`pathOverlapGuard` resolves the effective mode with this precedence: an
explicit `dispatch.guards.path_overlap` always wins; failing that, the legacy
`dispatch.path_guard: true|false` boolean (`true` → `"running"`, `false` →
`"off"`); failing that, the default follows `mergePolicy(cfg).auto` — `"off"`
for `merge.mode: "manual"` (a human sits between review and merge, so
"another card is running" never approximated "not merged yet"), `"unmerged"`
for `"auto"` (`review → merged` is immediate, so it does). Any mode that is
not recognized as `"auto"` — including `merge.mode: "operator"` (#189) —
defaults to `"off"` too, same reasoning as `"manual"`. `hkb doctor` prints the
effective mode and its source (`PATH_OVERLAP_CHECK`, `src/doctor.js`).

A guard hit — `--dry-run`, the tick log, or a plain dispatch claim attempt —
names the card and paths it collided with via `pathCollisions`
(`src/model.js`), not just `guarded: path_overlap`.

## Never behind an idle attempt

Whatever the mode, a card must never hold its paths behind an attempt whose
session has gone idle without crashing — a slow human reviewer in `review` is
expected friction; a stuck agent session in `running` holding other cards
hostage is not. `attemptIdle` (`src/model.js`) is the pure predicate; the tick
(`src/dispatch.js`, the reclaim loop) computes `idleNumbers` once per tick and
feeds it to `pathHolders`.

Three liveness sources, most to least authoritative:

1. **A job record** (`claude-bg` attempts): `jobAlive(job)` — the daemon
   itself says whether the turn is still going. A live job holds no matter
   how stale its `lastSignal` looks, because the default heartbeat is a
   ref-CAS that never touches the run comment at all — `lastSignal` sits at
   `started_at` for the attempt's whole life.
2. **A live pid** (`process`-mode attempts): `pidAlive(a.pid)`, just as
   authoritative for the same reason — a `process` attempt's heartbeat never
   touches the run comment between beats either.
3. **Neither** (`manual`, a legacy `remote` row, or a `claude-bg` job on another host):
   falls back to timing `lastSignal` against an idle threshold
   (`Math.max(d.interval, 1200)` — well above the ~10-minute floor a
   `comment`-mode heartbeat beats on), refreshed by the same lock-ref
   commit-date read the reclaim check uses for `stale_after`, just triggered
   at the lower idle threshold instead.

This never reclaims or ends the attempt — that stays the reclaim pass's own
`stale_after`/`max_runtime` logic (#136 owns it). It only tells `path_overlap`
to skip over the attempt when deciding what still holds its paths. The idle
line is logged once per attempt (`state.idle_logged`, pruned like
`state.claims` after 24h) — a `--dry-run` tick computes idleness the same way
but never persists the log-dedup key, so it cannot silence the real loop's
first sighting of an attempt going idle.

## Related

- [tracks](tracks.md) — a track's `path_overlap` collision uses
  `trackPaths`, the union of every node's `kb.paths`, not the root's own.
- [review-loop](review-loop.md) — why `review` holding its paths under
  `"unmerged"` does not conflict with the `active_pr` exemption a
  continuation attempt gets.
