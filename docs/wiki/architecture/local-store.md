---
title: The local store — the two tiers as one board
summary: "How the kb-board branch and the .git/hkb index compose into one Store: what open() reconciles, the commit-index-wake order every durable verb follows, which reads go to which tier, and the one-writer rule that makes a clone a reader."
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a store verb, debugging an index that disagrees with the branch, wondering why a verb is refused on this host, or working on hkb sync / init --import"
covers:
  - path: src/store/local.js
    sha: cf9ff6ab730eff06e7307938ed6ac88c41b8f1dc
  - path: src/store/index.js
    sha: 918495a206540318480f3b0ce7cd0a8f559ae874
  - path: src/store/sqlite.js
    sha: 097c56b38571a9d5cc954e4bb72126dc4a83328f
  - path: src/init.js
    sha: d41dc9ecf44f892d994c175ebad8565cfc0da690
  - path: src/doctor.js
    sha: 7cbbeb3b764af3b555a8c9afcbb0612747b56dbe
  - path: src/gc.js
    sha: 534f186975f37866642c551b23e83978b3c66ec2
  - path: src/cli.js
    sha: 1886720ccbb31128516095a0c7aa5e5b06c707e8
generated_at_commit: 90132a1
last_refreshed: 2026-09-03
related: [architecture/kb-board-branch, architecture/store-seam, decisions/adr-006-local-store, features/up-and-down, features/web-board]
---

# The local store — the two tiers as one board

> Neither tier is a board. `src/store/git.js` has no locks and no event log;
> `src/store/sqlite.js` has no cards it did not copy from somewhere. The board
> is the composition, and `src/store/local.js` is where the rules that make it
> one thing live.

**What is not true yet.** The store is complete and `hkb init` creates one, but
the *verbs* have not moved onto it: `src/cli.js`, `src/lifecycle.js`,
`src/dispatch.js`, `src/serve.js` and `src/context.js` still reach board state
through `src/tasks.js`/`src/lock.js`, which are the GitHub driver's re-exports.
Track C of `docs/local-first.md` §10 is that migration, and until it lands a
local board is written and read by the store, by `hkb sync`, by `hkb doctor` and
by nothing else. A checkout with no GitHub board behind it wants
`hkb init --store github` in the meantime, and `hkb init` says so.

## Which store a board is on

`openStore(ctx)` (`src/store/index.js`) is the **only** place that decides, and
it asks two questions in order: `store` in `.kanban/board.json` (`"local"` or
`"github"`, and anything else is exit 2), then — when the key is absent — does
this repository have a `kb-board` branch, locally or as `<remote>/kb-board`.

The second question is what makes a plain `git clone` of a local board work
with no configuration at all: the branch is the declaration. It is also why a
board written by an older hkb stays on GitHub — no key, no branch, no change.
`resolveStore` (`src/init.js`) answers the same two questions in the same order:
a **new** board is local, an **existing** one keeps what it has, and
`--store github` is the escape hatch while the GitHub driver is still here.

`hkb init` writes the key only when it is a **decision** — the human's
`--store`, a fresh board, or a board that already carries it. An inference is
left unwritten so question two goes on being asked; pinning it pinned `github`
onto every legacy board that re-ran init, including ones whose `kb-board`
branch was full of cards.

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

`board.json` on the branch names one owning host. **Two** layers enforce it, and
they are not redundant — each catches a different caller:

- `assertOwningHost(ctx, verb)` in the CLI, in front of every invocation that
  writes (`src/cli.js`) — before a dispatcher reads the board, picks a card and
  spawns a session that could not record what it did.
- The tier's own `_assertOwner`, which refuses the actual write.

There was a third, `LocalStore.assertOwner()`, and nothing in `src/` ever called
it: a copy of the sentence with no caller to keep it honest, and one that would
have refused a branchless board both other layers deliberately pass (its
`owner()` went through `git.board()`, which throws where `assertLocalOwner`
returns null). It is gone; `owner()` answers `null` on a board with no branch,
which is the answer both layers already agreed on.

The guard is on the **invocation**, not the verb (`invocationWritesBoard`).
`up` is on `WRITES_BOARD` because it starts a dispatcher, but `hkb up --status`
reads pid files and nothing else, and `hkb dispatch --dry-run` gates every write
behind the flag — refusing those meant somebody holding a clone could not ask
what was running on their own machine. `hkb up --serve` stays refused: it brings
a dispatcher up alongside the web server. Serving a clone read-only is
`hkb serve`, which is not on the list at all.

A clone is therefore a **reader**: the store reads the whole board there with no
setup, and a mutating verb exits 2 naming `hkb init --take-over`. (The reads
that reach a human — `hkb list`, `hkb show`, `hkb serve` — get there when the
verbs move onto the store; see the note at the top.) A clone that never made a
local branch gets a second, more specific refusal from the tier: there is no
local ref to compare-and-swap against, and the message says how to make one.

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

**Nothing in `sync()` reads the board document before the fetch.** The order is
refs, then network, then `board.json` — because the checkout the verb exists for
is the one that has no `kb-board` at all (a `git clone --single-branch`, or one
taken before the branch was first pushed), and reading the board first threw
"there is no kb-board branch" at exactly the person running the command to go
and get one. `hkb init` there then made a *second, empty* board.

`settings.sync.push: false` turns off the **push**, and only the push. A
checkout that does not publish its copy still fetches and fast-forwards; that is
how it reads what the owner published. `--no-push` is the same switch as a flag,
so the more restrictive spelling can never do strictly more work than the
default.

Offline is not a failure. A `fetch`/`push` that fails on a network error comes
back `{offline: true}` and says nothing, because the remote copy is a backup and
a reader's view, not where the board lives. `OFFLINE` matches node's `E*` codes
as well as git's prose: the two network calls go through `runGitAsync`
(`src/board.js`) on a 15-second leash, and what a killed git reports is
`ETIMEDOUT`, not "connection timed out". They are async rather than `spawnSync`
for the loop's sake — while a fetch is out, a finished worker still has to be
reaped, a wake still has to arrive, and `hkb down`'s SIGTERM still has to be
handled. `syncAfterTick()` is what the dispatcher loop calls after a tick that
decided something (`DURABLE_TICK_KEYS`, `src/dispatch.js`), throttled to once a
minute against a stamp in `.kanban/state.json` — this host's network, not the
board's state.

**Liveness is about the process, not about the tick.** The dispatcher *stamp*
(`markDispatcher`) goes on the same pass but is not gated on any of that: it
runs every tick, before the `DURABLE_TICK_KEYS` question and outside the try
that catches a failing tick. A loop idling on a quiet board, or one whose ticks
are all failing on a rate limit, is still a loop holding this board — and when
the stamp was gated, its liveness expired after `HOST_LIVE_MS` and another
host's `hkb init --take-over` took a board that was ticking right now, no
`--force` needed. `markDispatcher` throttles itself to one commit per
`HOST_LIVE_MS / 3`, so running it every tick costs a read of a memoized tree.
`liveDispatcher` clamps a *future* stamp to age zero for the same reason: the
two clocks are on different hosts, and reading ordinary skew as "nobody is
ticking" fails the guard open in the one direction it must not.

The wake is a real signal with a real receiver: `hkb dispatch --loop` installs a
`SIGUSR1` handler that ends the sleep (`src/dispatch.js`). Without one, node's
default action for SIGUSR1 is to **start the inspector** — every board write
opened a debugger on the dispatcher and woke nothing. `index.wake()` never
signals its own process, so a dispatcher writing through the store does not
tick per write.

## The migration off GitHub

`--import` is **two operations**, and `importGithubBoard()` dispatches on which
one this repository has. A board query that comes back empty means there is no
kb board here to migrate, and the flag means the other thing: `adoptOpenIssues()`
pulls the repository's open issues into *triage* as a new local board (one
commit, pull requests skipped, its own page ceiling named). The summary's `mode`
and the log both say which ran. Sharing one flag while only the migration could
answer is what made a repository with three hundred unlabelled issues import
zero cards, log `0 open card(s)` and create an empty board — the flag's own
documented behaviour, unreachable. `--import` also means the migration whatever
`"store"` in `board.json` says: reading the pinned value first made the
documented migration reachable only as `--store local --import`.

`importGithubBoard()` moves a GitHub board onto the branch: every open card and
everything closed inside the 90-day window, with the **issue number as the card
id** and `next_id` past the highest of them. Two commits for the whole board —
one for the cards, one for the run records — rather than one per card, because
`git log kb-board` should say "the board arrived", not replay a year of issue
history. Per card it is one paginated comments read, which `listComments`
memoizes on the context, so the run record, the results and the human notes all
come out of the same request.

Two things the migration will not do quietly, because it is the one operation
nobody re-runs:

- **It never guesses a card's blockers.** The open cards are read with
  `blockers: 'all'`, not the default — the default fills `blockedBy` in for the
  tick's lanes only (todo and blocked), so on a repo without the GraphQL
  `blockedBy` field every card in triage, ready, running or review would arrive
  with an empty list meaning "not asked". The branch has no third value for
  that, and `cardRecord` refuses rather than writing "nothing blocks it" over a
  board's whole dependency graph (`blockersKnown`, `src/store/github.js`).

  The refusal has a **way through**, per card, or it is only a louder silent
  failure. On a repo without the GraphQL field no read fills a *closed* card's
  blockers in at all (`fetchClosedRecent` never calls the REST fill-in), so
  refusing there dead-ended the whole migration on its first closed card. So:
  an open card is a refusal (a better read exists, and its edges decide whether
  it can ever dispatch); a closed card is imported with `blockers_unknown: true`
  on the record and its number in the summary's `unknown_blockers` (it is
  settled, and its own `blocked_by` gates nothing — what it *blocks* lives on
  the other card and is untouched). Writing `[]` and calling it an answer is
  what is never allowed.
- **It drops an edge to a card it is not importing, and lists it.** #40 blocked
  by #11, closed 200 days ago: keeping the edge leaves #40 blocked by an id that
  reads back as an open issue nobody can close — `blockerDone()` false forever,
  `computeReady()` never true, #40 undispatchable with nothing saying why. The
  edge is dropped, printed per card, and returned in the summary's
  `dropped_blockers`.

The closed cards are **one page of 100**, most recently updated first, by the
GitHub driver's own design. A full page back sets `closed_capped` in the summary
and prints a WARNING naming the oldest card that made it, because "100 closed in
the last 90 days" over a truncated set reads as the whole window. There are two
more ceilings and both are named the same way: the adoption path's ten pages of
open issues (`issues_capped`), and `listComments`'s five pages of 100 per card,
which leaves a very talkative card's oldest notes behind (`comments_capped`
lists the numbers). A ceiling that is not named reads as the whole thing.

It is idempotent **by refusal**: a branch that already exists is left exactly as
it is. A second import over a board that has since been worked would overwrite
live state with GitHub's stale copy, so it says so and names the deliberate way
to start over. Afterwards it deletes the `refs/kb/locks/*` on the remote and the
local beat chains — a lock ref means nothing to a board whose locks are rows.
Both of those sweeps are guarded (`dropGithubLeftovers`): they run *after* both
commits and the index load have succeeded, so a single ref that will not delete
must not exit a migration that landed non-zero and leave the human unable to
tell whether to re-run — which "idempotent by refusal" would then refuse anyway.

## What doctor asks

`checkLocalStore` (`src/doctor.js`) is three probes and one identity line: the
branch (present, whose, and fast-forwardable against the last fetch — doctor
never fetches), the index tip against the branch tip, and the **filesystem the
index is on**, read from `/proc/mounts` by longest matching mount point, and by
the *last* of two entries sharing one — `/proc/mounts` is in mount order, so a
network filesystem remounted over a local path (exactly what this catches) is
the later line. `9p`,
NFS and CIFS are a refusal, not a warning: SQLite's WAL needs POSIX locking that
they do not give it, and the failure mode is a corrupt index or a hang that says
nothing about why. A host with no `/proc/mounts` (macOS) and a filesystem hkb
does not recognise both warn — "I could not check" is a different answer from
"this is wrong".

These probes run before `hkb doctor` talks to the forge, and — since the round-2
sweep — they *survive* it: the GitHub half is one `githubChecks()` call inside a
try, so a 404 from a repo that was renamed or a `gh` that is logged out costs one
`github` finding rather than the whole report. It used to throw out of `doctor`
itself, which meant that on a local board with nothing behind it the human saw a
single 404 and none of the answers the probes had already computed.

The line that split is where a check *lives*, not what it is about, so a check
that reads only `ctx.cfg` belongs on the local side of it —
`checkPathOverlapGuard` sat inside `githubChecks` after the labels call that
throws first, so a malformed `dispatch.guards.path_overlap` went unreported on a
board with a stale `repo`, on a check that needs no network at all. It has moved
up. (`checkTrackProfile` is the one deliberate hybrid left: it answers from
`ctx.cfg` when a profile declares `track: true` and otherwise reads the board,
and it already degrades to a `warn` rather than throwing.)

## What gc does not sweep here

Four of `gc.sweep`'s passes are about how the *GitHub* store keeps a board, and
mean nothing once it does not (`docs/local-first.md` §7). The rule is that such
a sweep is either skipped with a line saying why, or it says why it found
nothing — what is never allowed is running structurally empty and reporting `0`
as a result:

- **duplicate run comments** and **beat chains** are skipped: a run record is one
  file on the branch, so there is no second comment to be a duplicate of, and a
  beat is a row in the index.
- **track branches** are skipped: a track branch lives on the forge, and listing
  them is a `gh api` request per gc and per `gc_every_ticks` tick for an answer
  that is structurally always empty.
- **agent worktrees** cannot be swept at all, and the sweep says so with a count.
  It removes an `agent-*` worktree once *its* pull request is merged or closed,
  and `GitTier.toTask` hands back `prs: []` for every card — the forge is not the
  store (§6.4). It reported `0 removed` on a checkout quietly accumulating them
  forever; now it names them and says to remove them by hand.

The store is chosen *before* the board is read (`storeKind` above `listTasks`),
because opening with the GitHub driver's read meant a genuinely local board threw
several sweeps before the skip message could be printed.

## Gotchas

- **Two stores in one repository share the index file.** It is keyed by the
  repository's common git dir, so a second `LocalStore` is not a second host —
  a test that wants a stale index has to move the branch with the *tier*, which
  writes no index at all.
- **`claim()` sets `tasks.status = 'running'` in the index** while the card's
  status is the branch's. The index is briefly ahead; the next reconcile fixes
  it. Do not read a card's status off the index expecting the branch's answer.
- **`storeKind` memoizes both answers**, invalidated by `forgetStore(ctx)` —
  which `hkb init` calls, since it is the one thing that creates the branch
  under its own feet. Leaving the negative uncached meant every board predating
  the `store` key re-spawned two `git rev-parse` per writing verb, per
  `gc.sweep` and per tick for an answer that could only be `github`.
  `resolveStore` is handed `localBoardExists(ctx)` rather than deciding on its
  own, so `hkb init` and `storeKind` cannot disagree.
- **An inferred store is never written back.** `hkb init` writes `"store"` only
  when the human chose it (`--store`), when the board is new, or when the key is
  already there. Pinning what `resolveStore` merely worked out turned every
  re-init of an older board into a permanent `"store": "github"` — including one
  whose `kb-board` branch was full of cards, which detached the board from its
  own branch for good.
- **An imported card's `labels`** hold only what is *not* a column —
  `kb:board:*`, `kb:status:*`, `kb:agent:*` and `kb:needs-human` are rebuilt
  from the card, so carrying them would double them (`cardRecord`).
