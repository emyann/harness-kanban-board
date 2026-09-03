---
title: The store seam
summary: "One named interface over board state — openStore(ctx) with the GitHub bodies behind it — plus src/forge.js for the pull-request half that is deliberately not part of it, and a driver-parametrised conformance suite that says when a new driver is done."
category: architecture
kind: explanation
audience: [dev]
read_when: "writing a verb that reads or writes board state, adding a store driver, or wondering why tasks.js and lock.js are two lines long"
covers:
  - path: src/store/index.js
    sha: 6f80ab71e9efca230d89d25f1b6d9186576ef522
  - path: src/store/github.js
    sha: 57a69a45c3a7998c74f53442a6756873f198f8af
  - path: src/forge.js
    sha: 6fb1fd64643a3762f54b9c68c3b51b03c199e017
  - path: src/tasks.js
    sha: a135544bc265b07a25bd5ea2cd5d2235687bac2f
  - path: src/lock.js
    sha: cfb7eaf1a75003826cf610ee136a08dc0d4ff281
  - path: src/board.js
    sha: 5b2d5227aa6157021e68c1bd169a5019c79e6944
generated_at_commit: 29d0d25
last_refreshed: 2026-09-03
related: [architecture/overview, decisions/adr-006-local-store, concepts/claims-and-leases, concepts/board-protocol]
---

# The store seam

> `openStore(ctx)` is the only way board state should be reached. Behind it are
> two drivers: the GitHub one, and the local one — a `kb-board` git branch plus
> a `node:sqlite` index, composed in `src/store/local.js`
> (`architecture/local-store`, `decisions/adr-006-local-store`). The seam exists
> so that the verbs written between them are written **once**.

**Which driver, and where that is decided.** `storeKind(ctx)` reads `store` in
`.kanban/board.json` (`"local"` | `"github"`) and **nothing else**. An absent
key is `github`. Nothing in hkb branches on the store anywhere else, and there
is no way to force a driver at the call site: `hkb init --import`, which reads
GitHub and writes local, opens each driver by name for exactly that reason. A
new board is local as of A6; an existing board keeps what it has.

There used to be a second rule — *a repository with a `kb-board` (or
`<remote>/kb-board`) ref is a local board* — so that a clone needed no
configuration. It was removed in A6's sixth review round, because a rule that
reads the store off a **ref** can be reached by `git fetch`, and the checkout
then runs on the local store while board.json still points every verb at
GitHub. That half-migrated state produced a different destructive interaction in
three successive rounds: an `--import` that deleted live workers' lock refs; a
`gc.sweep` that read `[]` from the wrong store, concluded every card was
finished and destroyed worker worktrees with uncommitted work in them,
unattended, from the dispatcher's own `gc_every_ticks`; and one host's push
converting every collaborator's checkout on their next fetch, after which every
mutating verb was refused on a board of issues they had always owned. The key
cannot arrive over the network, cannot be written by another host, and cannot
disagree with what the verbs do. A clone still needs no configuration — the key
rides in the tracked `board.json` — and a checkout that has the branch but not
the key is told so in words by `hkb init` and `hkb doctor`, which is a message
and never a behaviour.

There is no cache: the answer is a property read. `forgetStore(ctx)` remains,
and drops the memoized git *tiers* for a context — `hkb init` calls it because
it creates the branch under its own feet.

`hkb init` never writes back an answer nobody asked for: the `store` key appears
when the human passed `--store`, when the board is new (the default *is* the
decision), when it was already there, or when `--import` migrates. A plain
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

So the bodies **moved, and were not rewritten**. `src/store/github.js` is
`src/tasks.js` plus `src/lock.js`, verbatim, with one wrapper at the bottom;
`src/tasks.js` and `src/lock.js` are re-export shims, which is why this landed
with no test edited and no caller changed beyond import lines. A shim is
deleted when its last importer is, not before.

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
Today it carries one flag, `events`: GitHub has no log hkb can tail, so its
`events()` **refuses with exit 2** instead of answering an empty list. "Nothing
happened" and "I cannot tell you what happened" are different answers, and
`hkb serve` picks its feed on the difference.

## Importing the seam must not require a node that has SQLite

`src/store/index.js` imports the local store so `openStore(ctx)` can pick it,
and `openStore` is on the path of every command — including `hkb hook pretool`,
whose whole contract is to stand aside rather than throw onto a worker's tool
call. A static `import { DatabaseSync } from 'node:sqlite'` in
`src/store/sqlite.js` therefore made that entire graph fail to load with
`ERR_UNKNOWN_BUILTIN_MODULE` on a node built `--without-sqlite`, on a **GitHub**
board that never opens an index at all.

The builtin is resolved on first use instead (`sqlite()`, via
`process.getBuiltinModule` — the synchronous form, since `openIndex` and
everything under it is synchronous), and a node without it gets a refusal that
names the node and the way out. Fixing it at the seam's two known importers
would have left the next one to rediscover it; fixing it at the builtin covers
every entry point at once. A test asserts both halves: the source carries no
static import, and a child process that loads `store/index.js`, `doctor.js` and
`cli.js` has nothing matching `sqlite` in `process.moduleLoadList`.

## What is deliberately *not* in the store

Pull requests. `src/forge.js` holds `openPrsByHead`, `branchFallbackPrs`,
`prMergeStates`, `enableAutoMerge`, `branchProtection`, `mergePullRequest`,
`prChecksState`, `prNodeId`, `isGithubUser` and `finishPr`, and goes on calling
`src/gh.js` whatever the board is kept in — a board that lives in a git branch
on your laptop still opens its work as a PR on a forge. Putting them behind the
store would have forced every future driver to implement a forge it does not
have.

`src/forge.js` is also where `GhError` and `isOffline` are re-exported from, so
the two files that only *classify* a transport failure — `src/lifecycle.js`'s
outbox and `src/dispatch.js`'s reclaim clock — stop being direct `src/gh.js`
importers. After this the whole `src/` tree imports `gh.js` from exactly seven
files: the store, the forge, and the five that talk to GitHub about something
other than the board (`doctor.js`, `projects.js`, `init.js`, `watch.js`,
`board.js`).

## `storeRoot`, and the worktree trap

`storeRoot(ctx)` (`src/board.js`) is the one directory every driver agrees the
board lives under, and it resolves through `mainWorktree` — the *common* git
directory's parent — never `git rev-parse --show-toplevel`. In a linked
worktree (`.claude/worktrees/kb-99-1`) the toplevel is the throwaway checkout,
so a worker beating from one and the loop ticking in the main checkout would
open two boards that happen to share a name. The GitHub driver ignores the
value — its board is the repo on GitHub — but it is settled here so the local
tiers cannot get it wrong independently.

## The conformance suite is what says a driver is done

`test/store.test.js` is one `SCENARIOS` array run against every entry in
`DRIVERS`, and a driver is finished when this file is green for it. `DRIVERS`
holds two: the GitHub driver backed by `test/fake-gh.js`, and the **composed
local** driver — a scratch repository whose `.kanban/board.json` says
`"store": "local"`, opened through `openStore` so the seam itself is under test.
Neither local *tier* is registered on its own, and that is deliberate: a tier
has half the interface, so it would fail fifteen scenarios that are not about
it. A scenario may only touch the interface — that is what keeps it portable.

Three things a scenario legitimately needs but the interface does not offer are
asked of the *harness* instead, as optional hooks: `settleClaim` (make a claim
real for whatever transport the driver's heartbeat leases on — for GitHub,
push the lock ref to the real `origin`), `reclaim` (what a dispatcher reclaim
looks like; defaults to `release`), and `recordBeat` (a beat somebody else
landed, as `lockBeatAt` reads it back). The GitHub harness therefore runs
against a **real** git repository with a real remote: only git can say whether
a `--force-with-lease` really held, so the heartbeat scenario would be theatre
without one.

The invariant the local drivers exist to satisfy — *every mutating call appends
an event* — is in the array already, guarded by `capabilities().events`. For
GitHub it asserts the refusal; for a driver with a log it asserts one event per
mutation, id-ordered, with an exclusive `after` cursor.

## Related

- [hkb at a glance](overview.md)
- [ADR-006 — the local store](../decisions/adr-006-local-store.md)
- [claims-and-leases](../concepts/claims-and-leases.md)
