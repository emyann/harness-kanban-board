---
title: The store seam
summary: "One named interface over board state — openStore(ctx), which every verb in src/ goes through — plus src/forge.js for the pull-request half that is deliberately not part of it and is joined to it by branch name, and a driver-parametrised conformance suite that outlived the driver it was written to retire."
category: architecture
kind: explanation
audience: [dev]
read_when: "writing a verb that reads or writes board state, adding a store driver, or working out where a card's pull request comes from"
covers:
  - path: src/store/index.js
    sha: 38e2b0bd8634a9dacd68f419dfa25b3d7127894b
  - path: src/forge.js
    sha: 0e424d2844bee9b0fdd2f809f7e9ae4314d69e74
  - path: src/bridge/github-issues.js
    sha: 55b3b9a708e5d00bdc2cd02a221c0867b10aaea3
  - path: src/board.js
    sha: 64b0e3dc2c9f0290d8b33e4ba30223363abc58bf
  - path: src/store/git.js
    sha: a42bfffbc1d7cd3197051e7593135d11ab84d48b
  - path: src/store/local.js
    sha: c519ac05bf312c1ac65e1ebd95a2b1858302d163
  - path: src/cli.js
    sha: 2c842b6079cd6057056eef2a926edb85a8259d9d
  - path: src/lifecycle.js
    sha: af197411d2798847fdc6707c39ae3b60989dc9ed
  - path: src/dispatch.js
    sha: 3ef9a36eb027a8e916e18713f1614600857ead52
  - path: src/gc.js
    sha: cc129d307e845211036472a76ed7e0f456be1329
  - path: src/init.js
    sha: 4028fb041f86af1a44b47ad6ad864fb8ab5dbdb0
generated_at_commit: 8aaffbf
last_refreshed: 2026-09-03
related: [architecture/overview, decisions/adr-006-local-store, concepts/claims-and-leases, concepts/board-protocol]
---

# The store seam

> `openStore(ctx)` is the only way board state is reached — not a rule the code
> aspires to, a fact you can grep for. Behind it is one driver: the local store
> — a `kb-board` git branch plus a `node:sqlite` index, composed in
> `src/store/local.js` (`architecture/local-store`,
> `decisions/adr-006-local-store`). The seam is what let the *other* driver be
> deleted without editing a verb.

**The seam outlived the second driver, which is what it was for.** For one
release there were two: GitHub Issues and the local store, and every verb was
written once, against `STORE_METHODS`, rather than twice. Retiring the GitHub
one (ADR-006) was then a deletion — `src/store/github.js` and the
`src/tasks.js` / `src/lock.js` shims over it — with no caller changed. Keep the
seam for the same reason it existed: the *bridge* comes back through it.

**Which driver, and where that is decided.** `storeKind(ctx)` reads `store` in
`.kanban/board.json` and **nothing else**. `"local"` and an absent key both mean
the local store; `"github"` is refused **by name**, with the migration
(`hkb init --import`) in the message, because a board still on
issues is a real thing somebody may have on disk and "silently open something
else" is the one answer that helps nobody. Anything else is a usage error.

There used to be a second rule — *a repository with a `kb-board` (or
`<remote>/kb-board`) ref is a local board* — so that a clone needed no
configuration. It was removed in A6's sixth review round, because a rule that
reads the store off a **ref** can be reached by `git fetch`, and the checkout
then ran on the local store while board.json still pointed every verb at
GitHub. That half-migrated state produced a different destructive interaction in
three successive rounds: an `--import` that deleted live workers' lock refs; a
`gc.sweep` that read `[]` from the wrong store, concluded every card was
finished and destroyed worker worktrees with uncommitted work in them,
unattended, from the dispatcher's own `gc_every_ticks`; and one host's push
converting every collaborator's checkout on their next fetch, after which every
mutating verb was refused on a board of issues they had always owned. With one
store the question cannot be posed at all, and a clone still needs no
configuration.

There is no cache: the answer is a property read. `forgetStore(ctx)` remains,
and drops the memoized git *tiers* for a context — `hkb init` calls it because
it creates the branch under its own feet.

`hkb init` never writes back an answer nobody asked for: the `store` key appears
when the human passed `--store local`, when the board is new (the default *is*
the decision), when it was already there, or when `--import` migrates. A plain
re-init writes nothing — it used to write `"store": "local"` into a git-tracked
board.json as a side effect, which is the same change `--import` refuses to make
without `--force`.

A verb that writes is refused on a host that is not `board.host`
(`assertOwningHost`) — and the test is on the *invocation*, not the verb name:
`invocationWritesBoard` (`src/cli.js`) lets `hkb up --status` and `hkb dispatch
--dry-run` through on a clone, since neither writes anything.

## Why a seam and not a rewrite

The measurement that motivated it is in `docs/local-first.md` §11: at commit
`7fd6cba`, `src/tasks.js` had 36 exports and `src/lock.js` 19, and six other
files made 29 transport calls of their own. Every one of those is a place a
store swap would have had to touch. The verbs of the control plane (the
`start`/`pause`/`resume`/`stop` work that follows) would each have been written
against `src/tasks.js` and then migrated — twice the work and twice the chance
of a behavioural drift nobody notices.

So the bodies **moved, and were not rewritten**: `src/store/github.js` was
`src/tasks.js` plus `src/lock.js` verbatim with one wrapper at the bottom, and
the two originals became re-export shims, which is why the seam landed with no
test edited and no caller changed beyond import lines. All three are gone now —
a shim is deleted when its last importer is, and the last importer went with the
driver.

What survives of GitHub Issues is `src/bridge/github-issues.js`: the **read**
half, and only that — `fetchBoard`, `fetchClosedRecent`, `listComments`,
`loadRun`, and the `refs/kb/locks/*` reads the migration sweeps up afterwards.
It has no writes, no claims and no `openStore` branch, and its only caller is
`importGithubBoard` (`src/store/local.js`). It lives under `src/bridge/` because
that is where the bridge adapter goes when it comes back (`docs/local-first.md`
§8) — this is its read half, arrived early.

## Routing the verbs, and the three kinds of caller it sorted out

The seam landing did not by itself move a single call site — every verb still
reached the GitHub bodies through the shims, which is what made C1 (moving the
tests onto a store double) impossible and C2 (deleting the driver) premature.
Doing it split `src/`'s callers into three, and that split is the thing to know
before writing a verb:

1. **Board state → `openStore(ctx)`.** `src/cli.js`, `src/lifecycle.js`,
   `src/dispatch.js`, `src/context.js`, `src/stats.js`, `src/hook.js`,
   `src/init.js`, `src/mcp.js` and `src/serve.js` open a store and call methods
   on it. Nothing in `src/` imports a driver to read or write a card.
2. **The forge → `src/forge.js`.** Pull requests were always here; the
   repository's *own branches* joined them — `baseSha`/`staleBaseSha` (the head
   every claim and every track branch is cut at), `classifyClaimError`, and the
   four `kb/track-<root>` functions. A board kept in a branch on your laptop
   still cuts its work from a forge, so these are not store methods and a second
   driver never has to implement them.
3. **The GitHub store, by name.** Two `hkb gc` sweeps (duplicate run comments,
   dead local beat chains) and the `hkb doctor --api` lock-ref probe imported
   `src/store/github.js` directly, because they were *about* that driver. All
   three went with it: a run record is one document, so there is no second
   comment to be a duplicate of; a claim is a row, so there is no beat chain to
   go stale; and "can this host take the write lock" is now
   `BEGIN IMMEDIATE` + WAL + the mount check (`checkClaimLock`,
   `src/doctor.js`). The category is worth remembering even though it is empty:
   a check that is about *one* driver does not belong on the interface.

Five things that read nothing moved out of `src/store/github.js` on the way,
because a caller that needs them must not have to import a driver: `blockersOf`,
`blockersKnown` and `tagBlockers` to `src/model.js`, `assertOnBoard` and
`remoteName` to `src/board.js`. That move is why deleting the driver later cost
nothing.

### What the routing added to the interface

Six methods and two widened returns, each because a verb needed a shape §6.4 did
not have — and each with a scenario in `test/store.test.js`, which is the rule
for adding one at all:

| method | the verb that needed it |
|---|---|
| `setKb(task, kb, bodyText?)` | `hkb edit`, `hkb adopt` — `updateBody` replaces the *prose*, so the machine block was unreachable through the interface |
| `ensureLabels(names)` | `hkb track --off`, `hkb init` — on GitHub a label must exist before `addLabels` can apply it; where labels are columns the driver answers `[]` |
| `lockToken(n, k)` | `hkb heartbeat` — the authoritative "is this claim still ours", which used to be `lockSha`/`lockExists` |
| `beatToken(n, k)` | the heartbeat's warm path: what this host's next beat leases on, read locally, never throwing |
| `resyncBeat` / `dropBeat` | reconciling that local state after a rejected lease, and forgetting it when an attempt ends |
| `lockRef(n, k)` | `hkb heartbeat` and the LOCK_LOST error — where the claim lives *in words*, or `null` on a store that keeps its claims in a table. The same `ref` `claim`/`listLocks` already carried, asked for a claim the caller did not just make |
| `taskEvents(n)` | `hkb log` — one card's history. Unlike `events()` it is **never refused**: a driver with no log answers with whatever it does have |

`heartbeat` now answers `{result, token, expected, detail}`. `detail` is there
because `hkb heartbeat` prints *why* a beat could not be made before it falls
back to the run record, and a caller cannot see inside a driver to write that
sentence — a silent fallback is the failure the values forbid. `addNote` answers
the note (`{id, at, actor, text, url}`) rather than a raw GitHub comment: its
three readers all reached for `html_url`, which is a field a store that keeps
notes in a file has nothing to put in.

`claim` and `listLocks` carry an **optional** `ref` — where the claim lives when
the store has such a name. `hkb claim` and the dispatcher's orphan sweep print
the attempt number instead when there is none, and `lockRef(n, k)` is the same
answer for a caller that has no claim result in hand.

**`lockToken` and `beatToken` must be two reads, not one.** The local driver
answered both from `locks.token`, on the reasoning that one table cannot drift
from itself — but `heartbeat`'s compare-and-swap is `UPDATE locks SET token = ?
WHERE … AND token = ?`, so leasing on the value it compares against made the CAS
one that can never fail. `hkb heartbeat`'s warm path could not report `lost`, and
the only reason a reclaim was ever noticed is that `release()` happens to delete
the row. The mirror is now its own table (`beats`, schema version 3,
`src/store/sqlite.js`) — the exact counterpart of the GitHub driver's local
`refs/kb/locks/<n>/<k>` ref, seeded by `claim`, advanced by a successful beat,
moved by `resyncBeat`, forgotten by `dropBeat` — and it deliberately outlives a
released row, because a claim released and re-taken by somebody else is the
reclaim it exists to catch.

The attempt row carries **no copy of the token**. `lock_sha` used to ride there
so a worker's first heartbeat had something to lease on; the claim seeds
`beatToken` on the host that made it, and the store is authoritative for the
rest, so a second place for the same value is a second place for it to be wrong.
`KB_LOCK_REF` went the same way — a worker never needed the name.

### One handle per context

`openStore(ctx)` memoizes on the context and `closeStore(ctx)` is what lets go
(`src/store/index.js`). That is not an optimisation: `gc.js` documents what the
alternative cost — *"leaked one handle per tick until the process hit its
file-descriptor limit"* — and every verb reaches board state through this
function, so "close it in a `finally`" would have to be written correctly at
every one of forty call sites. `hkb serve` reads four times for one
`GET /task/42`, `hkb doctor` twenty times in a run and the dispatcher three-plus
times per tick. One handle means one thing to close, and the owners close it:
`main()`'s `finally` in `src/cli.js`, `loop()`'s `finally` in `src/dispatch.js`,
and the server's `close` event in `src/serve.js`. A local store is still
**reconciled on every call** (one `rev-parse` when the tip has not moved), so a
memoized handle sees exactly what a fresh one would.

`openStoreReadOnly(ctx)` is the server's: `openIndexReadOnly` with `{readOnly:
true, timeout: 0}`, the connection `src/store/sqlite.js` names as *"`hkb serve`'s
… the one that may not write"*. It fails a busy lock fast rather than parking a
request behind the dispatcher's write transaction, and it lives in its own slot
so the lifecycle verbs a drag on the web board runs still get a writable store.

### The driver disagreement it found

§6.4 says nothing about the `blockers` note `listTasks` hangs on the array it
returns, so the git tier hung none — and `blockersKnown` therefore answered
`false` for every card on a local board, so `hkb list` marked settled cards as
"blockers unread". `blocked_by` is a column on the card there, so every card
that comes back comes back with its real edges: the tier now tags
`{source: 'local', filled: true, scope: 'all'}`, and a scenario asserts the note
on both drivers. Same class as #315's `blocked_by`/`needsHuman` mismatch — a
shape the contract does not pin is a shape two drivers differ on silently.

One caller-visible consequence, worth knowing because it looks like a bug from
the outside: `hkb doctor` on a **local** board with an unreachable forge now
answers its board-backed checks instead of reporting "could not read the board".
Those checks used to call the GitHub driver's query, so a 404 from a repository
the board does not live in silenced three checks whose answers were on disk.

## The interface is the contract

`STORE_METHODS` in `src/store/index.js` is `docs/local-first.md` §6.4 verbatim,
and the local drivers are written against those names *in parallel with* the
GitHub one. That is the whole reason renaming a method is a breaking change
here and nowhere else in the codebase: the other implementer is not in the
repository yet and cannot be grepped for.

Two shapes are frozen along with the names, for the same reason: a `Task` keeps
today's GraphQL-dressed fields (`number`, `kb`, `status`, `agent`, `needsHuman`,
`blockedBy[]`, `prs[]`, `state`, `stateReason`, `createdAt`, `updatedAt`,
`url`), so `src/model.js` and every consumer read a local board without
knowing; and `loadRun`/`saveRun` keep `{ run, id }`, where `id` is the handle
the driver updates in place so a create is followed by updates and never by a
second create.

`capabilities()` is how a caller asks what a driver can do rather than assuming.
Today it carries one flag, `events`: a driver with no log hkb can tail
**refuses with exit 2** instead of answering an empty list. "Nothing happened"
and "I cannot tell you what happened" are different answers, and `hkb serve`
picks its feed on the difference. The local store has a log, so it answers.

## Importing the seam must not require a node that has SQLite

`src/store/index.js` reaches the local store so `openStore(ctx)` can open it,
and `openStore` is on the path of every command — including `hkb hook pretool`,
whose whole contract is to stand aside rather than throw onto a worker's tool
call. A static `import { DatabaseSync } from 'node:sqlite'` in
`src/store/sqlite.js` therefore made that entire graph fail to load with
`ERR_UNKNOWN_BUILTIN_MODULE` on a node built `--without-sqlite` — before
`main()` ran, rather than where the board is read.

The builtin is resolved on first use instead (`sqlite()`, via
`process.getBuiltinModule` — the synchronous form, since `openIndex` and
everything under it is synchronous), and a node without it gets a refusal that
names the node and the way out. Fixing it at the seam's two known importers
would have left the next one to rediscover it; fixing it at the builtin covers
every entry point at once. A test asserts both halves: the source carries no
static import, and a child process that loads `store/index.js`, `doctor.js` and
`cli.js` has nothing matching `sqlite` in `process.moduleLoadList`.

## What is deliberately *not* in the store — and how it is joined to it

Pull requests. `src/forge.js` holds `prsByHead`/`openPrsByHead`,
`mergedPrsByHead`, `branchFallbackPrs`, `fillPrs`, `prMergeStates`,
`enableAutoMerge`, `branchProtection`, `mergePullRequest`, `prChecksState`,
`prNodeId`, `isGithubUser` and `finishPr`, and calls `src/gh.js` — a board that
lives in a git branch on your laptop still opens its work as a PR on a forge.
Putting them behind the store would force every future driver to implement a
forge it does not have.

**`fillPrs` is the join, and the head branch is the key.** The store answers
with `prs: []` (`src/store/git.js`); `fillPrs(ctx, tasks)` reads the
repository's pull requests once and matches them against `taskBranchRe`
(`src/model.js`) — `kb-<n>-<k>`, `worktree-kb-<n>-<k>`, `kb/<n>`, and
`kb/track-<n>` for a track root's own PR. That is the *only* link: nothing on
GitHub's side associates a pull request with an hkb card, and the worker brief
(`src/context.js`) and the track brief (`src/track.js`) both say so in the
prompt. Two rules follow for callers:

- **A read that will judge a card by its PR must call `fillPrs` on it.** The tick
  does it on its board read, and the terminal verbs, `hkb show`, `hkb list`,
  `hkb gc` and `hkb serve` each do it on theirs. It is one listing per context,
  memoized on `ctx._cache` and dropped at the top of every tick, never one per
  card (#234).
- **`state: 'all'` is a different question.** `openPrsByHead` lists open PRs —
  the `active_pr` guard's question. `hkb gc` asks *"has this checkout's work
  landed"*, which only a **closed** PR answers, so it fills with `state: 'all'`
  into its own memo slot. A listing of open PRs can only say "not here", which
  is also what a card with no PR at all looks like.

The reconcile pass is the same key read the other way: `mergedPrsByHead` once
per tick, and a card in a live status whose branch is in it becomes `done`
(`reconcileDecision`, `src/dispatch.js`).

`src/forge.js` is also where `GhError` and `isOffline` are re-exported from, so
the two files that only *classify* a transport failure — `src/lifecycle.js`'s
outbox and `src/dispatch.js`'s reclaim clock — stop being direct `src/gh.js`
importers. After this the whole `src/` tree imports `gh.js` from a handful of files: the
forge, the bridge, and the ones that talk to GitHub about something other than
the board (`doctor.js`, `watch.js`, `board.js`).

## `storeRoot`, and the worktree trap

`storeRoot(ctx)` (`src/board.js`) is the one directory every driver agrees the
board lives under, and it resolves through `mainWorktree` — the *common* git
directory's parent — never `git rev-parse --show-toplevel`. In a linked
worktree (`.claude/worktrees/kb-99-1`) the toplevel is the throwaway checkout,
so a worker beating from one and the loop ticking in the main checkout would
open two boards that happen to share a name. It is settled here so the two tiers
cannot get it wrong independently.

## The conformance suite is what says a driver is done

`test/store.test.js` is one `SCENARIOS` array run against every entry in
`DRIVERS`, and a driver is finished when this file is green for it. `DRIVERS`
holds the **composed local** driver — a scratch repository opened through
`openStore`, so the seam itself is under test — and the in-memory double.
Neither local *tier* is registered on its own, and that is deliberate: a tier
has half the interface, so it would fail fifteen scenarios that are not about
it. A scenario may only touch the interface — that is what keeps it portable.

That portability is not a claim: the suite ran green against the GitHub driver
until the day it was deleted, and the deletion was one entry out of `DRIVERS`.

Three things a scenario legitimately needs but the interface does not offer are
asked of the *harness* instead, as optional hooks: `settleClaim` (make a claim
real for whatever transport the driver's heartbeat leases on — nothing on a
store that keeps its claims in a table), `reclaim` (what a dispatcher reclaim
looks like; defaults to `release`), and `recordBeat` (a beat somebody else
landed, as `lockBeatAt` reads it back).

The invariant the local drivers exist to satisfy — *every mutating call appends
an event* — is in the array, guarded by `capabilities().events`: one event per
mutation, id-ordered, with an exclusive `after` cursor, and for a driver without
a log it asserts the refusal instead.

A scenario asserts the **interface's** shape, never a tier's. The local store
widens what `src/store/sqlite.js`'s `heartbeat` returns to the §6.4 four fields
in `LocalStore.heartbeat` rather than in the index, because the index is a tier
with tests of its own and the interface is the composed class's contract.

`DRIVERS` carries a third entry, `test/fake-store.js` — the in-memory double the
rest of the suite asserts board behaviour through. It is not a product driver,
and it runs here for one reason: a double that answers a method differently from
the real drivers turns every assertion made through it into a lie that passes.

## `setStore`: how a test asserts on the board rather than on GitHub

`setStore(fn)` (`src/store/index.js`) replaces what `openStore` and
`openStoreReadOnly` hand back, and returns a restore function the way
`setTransport` (`src/gh.js`) does. Production never sets it; it exists for
`test/fake-store.js`.

The problem it solved is `docs/local-first.md` §11: 121 assertion sites in 21
test files found out things the protocol states in its own words — *the lock was
released*, *the run record was not rewritten*, *a check with nothing to check
costs nothing* — by reading the in-memory GitHub's REST log (`gh.calls`,
`gh.lockRefs()`). Every one of them pinned `src/store/github.js` in place, so
nothing under it could be deleted. Through the interface the same sentences are
`store.writes()`, `await store.locks()` and `store.callsOf('listTasks')`, and
they are true of any driver — which is what made the deletion possible.

The override answers **inside** the handle memo, not in front of it: `openStore`
looks in `ctx._store` first, and only then asks the override, so the double it
hands back is memoized on the context and `closeStore(ctx)` closes it like any
driver's handle (`openStoreReadOnly` does the same into `ctx._storeRO`). Put the
other way round — as it first was — an overridden store never enters the cache,
`closeStore` finds nothing, and the handle lifecycle the seam was rewritten for
(#326) is the one part of it no test can exercise through the double.

Two deliberate limits. The override is **not** consulted by `storeKind`: what a
board is kept in is still `"store"` in `.kanban/board.json` and nothing else, so
a test that swaps the store does not also change what `hkb doctor`, `hkb gc` and
`hkb init` say the board *is*. And the double covers board state only — a pull
request is `src/forge.js` on every board, so a test that asserts on one seeds it
on `test/fake-gh.js` and reads it back there.

**The two doubles are split the way `src/` is**, and `installDoubles(makeCtx)`
(`test/fake-store.js`) installs both with one LIFO teardown, because almost every
harness needs both: the tick joins cards to pull requests on every board, so a
suite with no forge double under it reaches a real `gh`. `test/fake-gh.js` is
now the **forge** — `pulls`, protection, rulesets, auto-merge, merges, the
repository's own branches — plus the bridge's read half, kept for the migration's
own tests and labelled as such. A card seeded there is a card the migration
reads, never a card the board has.

`test/verbs-portable.test.js` is the other half: the scenarios the migrated
files rewrote — a promote, a claim and its run record, a live worker left alone,
a reclaim, a dry run, a terminal verb — run unchanged against the double *and*
against the real local driver in a scratch repository. That is what says the
rewritten assertions are portable, rather than asserting that they are.

## Related

- [hkb at a glance](overview.md)
- [ADR-006 — the local store](../decisions/adr-006-local-store.md)
- [claims-and-leases](../concepts/claims-and-leases.md)
