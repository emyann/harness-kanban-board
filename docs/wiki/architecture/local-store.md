---
title: The local store — the two tiers as one board
summary: "How the kb-board branch and the .git/hkb index compose into one Store: what open() reconciles, the commit-index-wake order every durable verb follows, which reads go to which tier, and the one-writer rule that makes a clone a reader."
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a store verb, debugging an index that disagrees with the branch, wondering why a verb is refused on this host, or working on hkb sync / init --import"
covers:
  - path: src/store/local.js
    sha: d3eaf14329219a844433ea7c0d420aec9297ced0
  - path: src/store/index.js
    sha: c411c7f6f1c832c340b10f9c263b02adde998066
  - path: src/store/sqlite.js
    sha: 826f9c91a51e4f2d67a9b15736d221650661dcbd
  - path: src/init.js
    sha: e9da3dee1b67c4169bae70647d30012fba868f60
  - path: src/doctor.js
    sha: 4ed022c48ec21ba66b92f895fefa333b6c928133
generated_at_commit: 2ce39a7
last_refreshed: 2026-09-03
related: [architecture/kb-board-branch, architecture/store-seam, decisions/adr-006-local-store, features/up-and-down, features/web-board]
---

# The local store — the two tiers as one board

> Neither tier is a board. `src/store/git.js` has no locks and no event log;
> `src/store/sqlite.js` has no cards it did not copy from somewhere. The board
> is the composition, and `src/store/local.js` is where the rules that make it
> one thing live.

## Which store a board is on

`openStore(ctx)` (`src/store/index.js`) is the **only** place that decides, and
it asks two questions in order: `store` in `.kanban/board.json` (`"local"` or
`"github"`, and anything else is exit 2), then — when the key is absent — does
this repository have a `kb-board` branch, locally or as `<remote>/kb-board`.

The second question is what makes a plain `git clone` of a local board work
with no configuration at all: the branch is the declaration. It is also why a
board written by an older hkb stays on GitHub — no key, no branch, no change.
`hkb init` writes the key explicitly from then on (`resolveStore`,
`src/init.js`): a **new** board is local, an **existing** one keeps what it has,
and `--store github` is the escape hatch while the GitHub driver is still here.

## The three rules

Everything in `LocalStore` follows from these, and each exists because the
alternative loses something.

**1. `open()` reconciles.** The index stores the sha it was built from
(`tip_sha` on its `board` row). When that is not what `refs/heads/kb-board`
says, the whole tree is read and loaded. In the common case this is one
`rev-parse` and one indexed row, which is why every verb can afford it. A
missing branch loads *nothing* rather than an empty tree — `{tip: null}` would
delete the cards a `git fetch` is about to bring back.

**2. Commit, then index, then wake — in that order.** A durable verb lands its
commit on the branch first, reloads the index from the tree that landed, then
appends exactly one event and `SIGUSR1`s the dispatcher. A crash between the
commit and the index write leaves an index one commit behind, which rule 1
repairs on the next open. The reverse order would lose a decision instead.

The tip is read before and after the write, so a verb that wrote the same bytes
back — a reconcile pass re-asserting the state of twenty cards — lands no
commit, appends no event and wakes nobody. That is the same no-op check
`_patch` makes one layer down, read from the other end.

**3. A live write never touches git.** Claims, heartbeats and an open attempt's
pid/job/worktree are the index's alone. A lock on a branch would be a commit per
beat, and `git log kb-board` is meant to be a history of *decisions*.

## Which tier answers a read

Durable reads (`listTasks`, `getTask`, `loadRun`, `latestResult`, `listNotes`)
go to the **branch**, not to the index. The tier memoizes the decoded tree per
sha, so a tick that asks about twelve cards decodes it once, and — the real
reason — there is exactly one answer to "what does the board say" rather than
two that can disagree. The index answers the live half (`listLocks`,
`heartbeat`, `events`, the open attempts) and is what `hkb serve` reads.

This is a deliberate cost: the index has `tasks` and `runs` tables that no
`Store` read currently consults. They are there for `hkb serve`'s SQL and for
the reads that move onto the index in track C, and the reconcile in rule 1 is
what keeps them true.

## One writer, and what a clone gets

`board.json` on the branch names one owning host. Three layers enforce it, and
they are not redundant — each catches a different caller:

- `assertOwningHost(ctx, verb)` in the CLI, in front of every verb in
  `WRITES_BOARD` (`src/cli.js`) — before a dispatcher reads the board, picks a
  card and spawns a session that could not record what it did.
- `LocalStore.assertOwner()` for a caller that reached the store directly.
- The tier's own `_assertOwner`, which refuses the actual write.

A clone is therefore a **reader**: `hkb list`, `hkb show` and `hkb serve` work
with no setup, and a mutating verb exits 2 naming `hkb init --take-over`. A
clone that never made a local branch gets a second, more specific refusal from
the tier — there is no local ref to compare-and-swap against.

`takeOver()` rewrites `board.host`. It is refused while the old host's
dispatcher stamp on the branch is younger than `HOST_LIVE_MS`
(`liveDispatcher`), because a loop is ticking against it right now; `--force` is
the override for a laptop that is not coming back. The stamp itself is written
by `markDispatcher()` from the loop, throttled to a third of that window —
it is a commit, not a heartbeat.

## Sync is git

`sync()` fetches `<remote>/kb-board`, fast-forwards the local ref if it is
behind, then pushes if it is ahead. Anything that is not a fast-forward in
either direction is refused with the one-writer explanation and the commands to
look at both histories: the branch has one writer, so a divergence is two hosts
having written it, and hkb will not guess which is right.

Offline is not a failure. A `fetch`/`push` that fails on a network error comes
back `{offline: true}` and says nothing, because the remote copy is a backup and
a reader's view, not where the board lives. `syncAfterTick()` is what the
dispatcher loop calls after a tick that decided something
(`DURABLE_TICK_KEYS`, `src/dispatch.js`), throttled to once a minute against a
stamp in `.kanban/state.json` — this host's network, not the board's state.

## The migration off GitHub

`importGithubBoard()` moves a GitHub board onto the branch: every open card and
everything closed inside the 90-day window, with the **issue number as the card
id** and `next_id` past the highest of them. Two commits for the whole board —
one for the cards, one for the run records — rather than one per card, because
`git log kb-board` should say "the board arrived", not replay a year of issue
history. Per card it is one paginated comments read, which `listComments`
memoizes on the context, so the run record, the results and the human notes all
come out of the same request.

It is idempotent **by refusal**: a branch that already exists is left exactly as
it is. A second import over a board that has since been worked would overwrite
live state with GitHub's stale copy, so it says so and names the deliberate way
to start over. Afterwards it deletes the `refs/kb/locks/*` on the remote and the
local beat chains — a lock ref means nothing to a board whose locks are rows.

## What doctor asks

`checkLocalStore` (`src/doctor.js`) is three probes and one identity line: the
branch (present, whose, and fast-forwardable against the last fetch — doctor
never fetches), the index tip against the branch tip, and the **filesystem the
index is on**, read from `/proc/mounts` by longest matching mount point. `9p`,
NFS and CIFS are a refusal, not a warning: SQLite's WAL needs POSIX locking that
they do not give it, and the failure mode is a corrupt index or a hang that says
nothing about why. A host with no `/proc/mounts` (macOS) and a filesystem hkb
does not recognise both warn — "I could not check" is a different answer from
"this is wrong".

## Gotchas

- **Two stores in one repository share the index file.** It is keyed by the
  repository's common git dir, so a second `LocalStore` is not a second host —
  a test that wants a stale index has to move the branch with the *tier*, which
  writes no index at all.
- **`claim()` sets `tasks.status = 'running'` in the index** while the card's
  status is the branch's. The index is briefly ahead; the next reconcile fixes
  it. Do not read a card's status off the index expecting the branch's answer.
- **An imported card's `labels`** hold only what is *not* a column —
  `kb:board:*`, `kb:status:*`, `kb:agent:*` and `kb:needs-human` are rebuilt
  from the card, so carrying them would double them (`cardRecord`).
