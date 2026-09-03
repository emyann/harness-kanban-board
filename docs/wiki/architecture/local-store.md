---
title: The local store — the two tiers as one board
summary: "How the kb-board branch and the .git/hkb index compose into one Store: what open() reconciles, the commit-index-wake order every durable verb follows, which reads go to which tier, and the one-writer rule that makes a clone a reader."
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a store verb, debugging an index that disagrees with the branch, wondering why a verb is refused on this host, or working on hkb sync / init --import"
covers:
  - path: src/store/local.js
    sha: 32b68ad027f4ded44074909cda42bf93b7235f75
  - path: src/store/index.js
    sha: b67a89674aea78c2540b86c7868607dd4bb92863
  - path: src/store/sqlite.js
    sha: ab60bab80331ff0a2ac66141062eb3518a0b4fee
  - path: src/init.js
    sha: 986db0bb9f95179b12c7c012b61e2d9f3e20a7e8
  - path: src/doctor.js
    sha: d9df9b7620a2be2d04e0ca59597cfc075381ac60
  - path: src/gc.js
    sha: cc129d307e845211036472a76ed7e0f456be1329
  - path: src/cli.js
    sha: a4d80e1fb0fdf6e8e3c0e57494423720775af950
generated_at_commit: 0c4e2e6
last_refreshed: 2026-09-03
related: [architecture/kb-board-branch, architecture/store-seam, decisions/adr-006-local-store, features/up-and-down, features/web-board]
---

# The local store — the two tiers as one board

> Neither tier is a board. `src/store/git.js` has no locks and no event log;
> `src/store/sqlite.js` has no cards it did not copy from somewhere. The board
> is the composition, and `src/store/local.js` is where the rules that make it
> one thing live.

**The verbs are on it.** `src/cli.js`, `src/lifecycle.js`, `src/dispatch.js`,
`src/serve.js`, `src/context.js` and the rest reach board state through
`openStore(ctx)` — `grep -rn "from './tasks.js'\|from './lock.js'" src` is empty
outside `src/store/` — so `hkb create` → `hkb list` → `hkb claim` → `hkb finish`
runs end to end on a local board, and `hkb init` makes one by default again
(*architecture/store-seam*, "Routing the verbs").

**What is still not true.** Pull requests are not board state and never will be
(`src/forge.js`, §6.4), so a local card carries `prs: []` and every check that
reads one — the `active_pr` guard, the agent-worktree sweep, `hkb merge` — has
nothing to read on a local board. The GitHub driver is gone (ADR-006); what a
card's pull request is now comes from the head-branch join in `src/forge.js`.

## Which store a board is on

`storeKind(ctx)` (`src/store/index.js`) is the **only** place that decides, and
it asks exactly one question: `store` in `.kanban/board.json` — `"local"` or
absent both mean the local store, `"github"` is refused by name with
`hkb init --import` in the message, anything else is exit 2. A board.json with
no key that turns out to have no `kb-board` branch either is the unmigrated
case, and the driver's own read path says so (`noBoardHere`, `src/model.js`;
see *concepts/store*).

There *was* a second question — does this repository have a `kb-board` branch,
locally or as `<remote>/kb-board` — so that a plain `git clone` needed no
configuration. It was removed in A6's last review round, because a rule that
reads the store off a **ref** can be reached by `git fetch`, which put a
checkout on the local store while board.json still pointed every verb at GitHub;
*architecture/store-seam* has the three destructive interactions that followed.
A clone still needs no configuration: the key rides in the tracked board.json.
`resolveStore` (`src/init.js`) answers for a new board — local — and an existing
one keeps what it has; `--store github` is refused there too, by name, so a
human who types the flag the old README taught them is told what happened to it
rather than being handed a board hkb cannot make.

`hkb init` writes the key only when it is a **decision** — the human's
`--store`, a fresh board (the default *is* the decision), a board that already
carries it, or an `--import` that migrates. A plain re-init writes nothing.

**And a board that declares nothing is asked about.** Writing nothing is the
right answer for the *key*, but it is not an answer about the **cards**:
`resolveStore` refuses a board.json that says `"store": "github"`, and the
board.json most repositories actually have was written before that key existed
and says nothing at all. Absent resolves to `local`, nothing is written, and
`setUpLocalBoard` would create an empty `kb-board` branch beside every card
still on the forge — an empty `hkb list` and no message, from the command an
operator runs *because* `hkb list` went quiet. So `needsMigrationProbe`
(`src/init.js`) puts one condition in front of it: an existing config, no
`store` key, no `--import`, no branch yet. When all four hold, `init` asks the
forge — one `GET /issues?labels=kb:board:<slug>&state=all` through
`countBoardIssues` (`src/bridge/github-issues.js`), the bridge's read half, not
`fetchBoard` — and `migrationVerdict` decides: no cards is a fresh repository and
proceeds silently; cards found is exit 2 naming the count and `hkb init
--import`; a forge that **could not be asked** is also exit 2, in its own
sentence, because creating the branch is the irreversible half and an unknown
answer must not be read as "none". `--force` proceeds either way and says what
it is walking away from. A repository with no board.json at all is never probed,
which is what keeps `hkb init --repo owner/name --no-labels` — the offline
adoption path — working on a new repo.

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

**The event's kind names the write, and its payload carries what a reader
renders.** A status change is `status` with `from` and `to`; `needs-human`
raised and cleared are one kind with `to: true`/`to: false`; a body edit, a
blocked-by edge either way, an ordinary label change, a settings write and a
take-over each have a kind of their own (`LOCAL_EVENT_KINDS`,
`src/store/sqlite.js`). Filing all six as `status` with an `op` key nothing
reads made `hkb watch --kinds status` render every one of them `none → none`,
and the two board-wide ones carried `task_id: null`, which renders as card
`#null`. `describeEvent` (`src/watch.js`) is the reader those payloads are
written for.

**3. A live write never touches git.** Claims, heartbeats and an open attempt's
pid/job/worktree are the index's alone. A lock on a branch would be a commit per
beat, and `git log kb-board` is meant to be a history of *decisions*.

A durable verb's event carries what it decided, and `saveRun`'s is the attempt it
just wrote: `rec.run.attempts`, not `rec.attempts` — a run record is `{run, id}`
(`loadRun`'s shape, and what every caller hands straight back), and reading the
outer object put `{attempt: null, profile: null, host: null}` on every attempt
event a local board ever appended. `hkb log` is what renders those fields.

### The two claim tokens

`locks.token` is the claim; `beats.token` is where **this checkout** left the
chain. They are separate tables on purpose, and the reason is the shape of
`heartbeat`: `UPDATE locks SET token = ? WHERE task_id = ? AND k = ? AND token =
?`. Answering `beatToken` from `locks` made every lease check its token against
itself — a compare-and-swap that cannot fail, so `hkb heartbeat`'s warm path
could never report `lost` and nothing detected a reclaim except `release()`
deleting the row out from under it. `beats` is the counterpart of the GitHub
driver's local `refs/kb/locks/<n>/<k>` ref: seeded by `claim`, advanced by a
successful beat, moved by `resyncBeat`, dropped by `dropBeat`, never reloaded
from the branch, and deliberately *not* cascaded off `locks` — a claim released
and re-taken by somebody else is exactly the reclaim a stale mirror catches.
Adding it bumped `SCHEMA_VERSION` to 3, which rebuilds rather than migrates.

## Which tier answers a read

Durable reads (`listTasks`, `getTask`, `loadRun`, `latestResult`, `listNotes`)
go to the **branch**, not to the index. The tier memoizes the decoded tree per
sha, so a tick that asks about twelve cards decodes it once, and — the real
reason — there is exactly one answer to "what does the board say" rather than
two that can disagree. The index answers the live half (`listLocks`,
`heartbeat`, `events`, the open attempts) and is what `hkb serve` reads.

One process holds **one** of these connections, because `openStore(ctx)` memoizes
the store on the context and `closeStore(ctx)` is what closes it (see
[the store seam](store-seam.md)). `hkb serve` reads through
`openStoreReadOnly(ctx)` instead — `openIndexReadOnly`, `{readOnly: true,
timeout: 0}` — so a request fails a busy lock fast rather than parking behind the
dispatcher's write transaction.

`hkb log` narrows in SQL: `index.taskEvents(n, {limit})` is `WHERE task_id = ?
ORDER BY id DESC LIMIT ?`, returned oldest-first. It used to be
`events({limit: 5000})` filtered in JavaScript, and `events` is a forward cursor
from id 0 — so on a board past the retention floor it read the log's *oldest*
page: `[]` for a recent card, pre-history for an old one, and nothing saying rows
had been cut.

The index's connection is opened **lazily** (`LocalStore.index`, a getter), and
`close()` is a no-op when nothing opened it. A caller that only wants the durable
half — the dispatcher's end-of-tick stamp, `hkb doctor`'s branch probe — pays no
`DatabaseSync`, no `ensureSchema` and no `assertSameBoard`. That matters at the
interval floor, where the stamp is throttled on all but one tick in five
minutes.

This is a deliberate cost: the index has `tasks` and `runs` tables that no
`Store` read currently consults. They are there for `hkb serve`'s SQL and for
the reads that may yet move onto the index, and the reconcile in rule 1 is
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
reads pid files and nothing else, and a one-shot `hkb dispatch --dry-run` gates
every write behind the flag — refusing those meant somebody holding a clone
could not ask what was running on their own machine. `hkb up --serve` stays
refused: it brings a dispatcher up alongside the web server.

Two exceptions to that exception, both of the same shape — *a flag that promises
a read must actually deliver one*:

- **`hkb dispatch --loop --dry-run` is a write.** A loop stamps this host onto
  the branch and pushes it every few minutes, which no per-tick flag gates; and
  `--dry-run` was not even threaded into `loop()`, so the pair removed the guard
  and then ran a real claiming, spawning, stamping loop. It is threaded now
  (`tick(…, {dryRun})`, and `syncPass` is skipped), and the invocation counts as
  a write regardless.
- **`hkb serve` is a write.** The page's drag-and-drop calls the same mutating
  verbs; leaving `serve` off the list gave a non-owning host a writable UI whose
  every drag died inside the tier with a raw exit 2. A read-only rendering is a
  UI the server does not have yet, so it refuses at start-up instead.

A clone is therefore a **reader**: the store reads the whole board there with no
setup, and a mutating verb exits 2 naming `hkb init --take-over`. (The reads
that reach a human — `hkb list`, `hkb show`, `hkb graph`, `hkb watch` — get
there when the verbs move onto the store; see the note at the top.) A clone that never made a
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

**Every ref move is a compare-and-swap and its exit status is read.** Creating
the local branch passes `''` as the old value (git's "must not exist"), a
fast-forward passes the sha just read, the tracking-ref update after a push
passes what the fetch saw (`_reconcileRefs`, `_setRef`). Ignoring the status
reported `fastForwarded: true` with the remote's sha as `local` on a ref that had
not moved — a lost race exiting 0 and saying the board caught up. A lost CAS
re-reads and retries; three in a row is a refusal naming the reflog. A sync that
*creates* the branch rebuilds the tier's memo and the index's tip
(`_afterRefMoved`) and changes nothing else: which store the checkout is on is
`"store"` in board.json, never a ref that arrived over the network
(`architecture/store-seam`).

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
documented migration reachable only by naming the store as well as the flag.

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
  board's whole dependency graph (`blockersKnown`, `src/model.js`).

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

The closed cards are read **to the window, not to a page**: `fetchClosedRecent`
pages on `pageInfo.hasNextPage` ordered by `updatedAt` descending and stops at
the first card older than the 90 days, which is the scope the migration was
given. It was one query of 100 before, which made the page size the ceiling by
accident — measured on this repository's own board, 131 cards were closed inside
the window and 31 of them would have stayed on GitHub while the local board
became the source of truth without them (and `next_id` was computed from the
truncated set). `CLOSED_MAX` (5000) is the runaway stop behind the window, far
above any board a migration will meet.

`closed_capped` therefore means **a real ceiling was hit**: `CLOSED_MAX` reached
*and* one more read showing a card behind it that is still inside the window. A
full page proves nothing about what follows it, which is why the adoption path's
`issues_capped` reads the page after its last full one too. The third ceiling is
`listComments`'s five pages of 100 per card, which leaves a very talkative card's
oldest notes behind (`comments_capped` lists the numbers). A ceiling that is not
named reads as the whole thing; one that is named when it was not reached trains
the reader to ignore it.

It is idempotent **by refusal**: a branch that already exists is left exactly as
it is. A second import over a board that has since been worked would overwrite
live state with GitHub's stale copy, so it says so and names the deliberate way
to start over.

### It does not run over live state

The migration's last step deletes the GitHub protocol's leftovers, and that step
is where an adoption path turned into a data-loss path. Three rules now hold, and
all three are about the same thing — *this command is run on a board that is
still working*:

- **A live claim stops it before the first commit.** `liveLocks()` reads each
  lock ref's last beat; a beat inside `LOCK_LIVE_S` means a worker is holding
  that card, and deleting its ref would make its next heartbeat come back
  `LOCK_LOST` (exit 3) mid-task. The refusal names the cards and
  `hkb init --import --force`, which migrates anyway and says what it costs.
- **The sweep is scoped to the cards this import moved.** `refs/kb/locks/<n>/<k>`
  carries no board segment, so `listLocks(ctx)` enumerates the whole
  repository's namespace: migrating board `alpha` deleted board `beta`'s live
  locks and beta's workers lost their claims. Same for the beat chains.
- **A lock is never deleted unless it was seen to be dead.** `lockIsLive()` runs
  again per ref inside `dropGithubLeftovers()`, and one that is still beating is
  kept and reported in `locks_kept` rather than swept.

Both sweeps stay guarded: they run *after* both commits and the index load have
succeeded, so a single ref that will not delete must not exit a migration that
landed non-zero and leave the human unable to tell whether to re-run — which
"idempotent by refusal" would then refuse anyway. A lock *listing* that fails is
said out loud rather than read as "no locks", which is the answer that would
justify deleting them.

And the store key is a decision about a shared file. `hkb init` writes
`"store": "local"` into `.kanban/board.json` **after** the migration has landed,
so a refusal leaves the board exactly where it was; and when that file is
tracked by git it refuses to write the key at all without `--force`, because the
key is every collaborator's next `git pull`, not just this checkout's.

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

**A diagnosis does not create what it is diagnosing.** The probe opens the index
through `openIndexReadOnly` (`readOnly: true` on `openLocalStore`): timeout 0,
every write refused, and no file created. Opening the writing connection meant
doctor `mkdir`ed the directory, created the database and ran the schema — then
reported "board index: empty — no verb has opened this board here yet" about a
file it had just made, after waiting out the busy timeout against a dispatcher
mid-`load()`. The path in the identity line is computed (`indexFileIn`) rather
than read off an open index, because on the commonest failure here there is no
index to ask.

`checkClaimLock` — `hkb doctor --api`'s one claim probe, and what replaced the
lock-ref probe the GitHub store needed — follows the same rule the long way
round. It *cannot* use a read-only handle, because `BEGIN IMMEDIATE` is a write
and a connection that refuses writes would fail the probe for a reason that has
nothing to do with the board. So it computes the path, `existsSync`es it, and
warns ("nothing to probe — no verb has opened this board on this host") without
ever touching the lazy `s.index` getter that would have created one. Its two
statements also get a `try` each: sharing one made a throwing `ROLLBACK` report
as *"the index would not give this process the write lock"*, which is false — it
had just given it — and left the write transaction open on that handle.

`checkLocalStore` emits a line even when the store is not `local`. Returning
bare made the store check *vanish* from the report, and a skipped check that
looks like a passing one is the one thing doctor may never produce. Nothing
answers anything but `local` today; `kind` is a caller-supplied override and the
seam a second driver would arrive through.

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
- **`storeKind` reads one key and caches nothing** — there is nothing to work
  out. `forgetStore(ctx)` remains and drops the memoized git *tiers*, which
  `hkb init` calls because it creates the branch under its own feet.
  `resolveStore` (`src/init.js`) takes the same single input, so `hkb init` and
  `storeKind` cannot disagree about a checkout.
- **A store nobody chose is never written back.** `hkb init` writes `"store"`
  only when the human chose it (`--store`), when the board is new, when the key
  is already there, or when `--import` migrates. A plain re-init used to write
  `"store": "local"` into a git-tracked board.json as a side effect — the same
  change `--import` refuses to make without `--force`.
- **And a board that says `"store": "github"` is refused outright, not pinned.**
  The rule above has a hole exactly where it matters most: the key *is* already
  there, so `hkb init` pinned it — rewriting a tracked `github` to `local` and
  creating an empty `kb-board` branch beside every real card, so the next
  `hkb list` reported an empty board while the work sat unreachable on the forge.
  Silent abandonment, from the command a human runs to fix things. `resolveStore`
  takes the board.json on disk as its second argument for this one reason and
  answers with `storeKind`'s message, which names `hkb init --import` — the flag
  that *is* the human asking, and the one way through.
- **An imported card's `labels`** hold only what is *not* a column —
  `kb:board:*`, `kb:status:*`, `kb:agent:*` and `kb:needs-human` are rebuilt
  from the card, so carrying them would double them (`cardRecord`).
