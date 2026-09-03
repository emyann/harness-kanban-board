---
title: The kb-board branch
summary: "The durable half of a local board lives on a dedicated git branch written with plumbing only — no checkout, no staging, no working-tree write — with update-ref as the compare-and-swap and a retry that replays the mutation."
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a durable store verb, debugging a board write that lost or refused, or wondering why a worker's worktree stays clean while the board moves"
covers:
  - path: src/store/git.js
    sha: d14687668a4fe389a5df367c0ead56a6f8cb1166
  - path: src/store/index.js
    sha: 8bbf72f8391d88be9ae35eec0c79501b657cc41d
  - path: src/board.js
    sha: 86496d859ba1af4f78d539ff99f8707805129458
generated_at_commit: 5d3bc73
last_refreshed: 2026-09-02
related: [architecture/store-seam, decisions/adr-006-local-store, decisions/adr-005-control-plane, concepts/claims-and-leases]
---

# The kb-board branch

> A local board is two tiers. This is the one that has to survive a `git clone`:
> the board document, one file per card, one run record per card, on
> `refs/heads/kb-board`. `src/store/git.js` is the only thing that writes it.

## Why a branch, and why not the working tree

The board must travel with the repository — a clone brings the cards, and
`git log kb-board` *is* the board's history of decisions
(`docs/local-first.md` §6.1). A directory of JSON files in the checkout would
also travel, but it would be in everyone's `git status`, in everyone's diffs,
and in the way of every rebase. So the files live on a branch nobody checks
out, and `src/store/git.js` reaches them with plumbing.

The consequence worth internalising: **a board write moves a ref and nothing
else.** A worker committing a card from `.claude/worktrees/kb-99-1` leaves
`git status --porcelain` empty in that worktree *and* in the main checkout,
because no index and no working tree was ever involved. That is what makes it
safe for the dispatcher in the main checkout and five workers in five linked
worktrees to write the same board while each is mid-edit on its own branch.

## Which git, and where

Every call runs at `storeRoot(ctx)` — the **common** git directory's parent,
via `mainWorktree` (`src/board.js`) — never `git rev-parse --show-toplevel`,
which inside a linked worktree answers with the throwaway directory and would
give each worker a private board that happens to share a name.

`src/store/git.js` also *unsets* `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`
and their relatives before every call. A hook runs with those exported; one of
them leaking through is how a store write would end up staging somebody's
files instead of building its own tree.

## The shape of a read and the shape of a write

Both are bounded, and neither scales with the number of cards in processes
spawned:

- **read** — `ls-tree -r` for the paths and shas, then **one**
  `cat-file --batch` fed every sha at once. Two processes for a board of any
  size; never one per file. The read hands back the blob sha of every file it
  parsed, which is what makes the write cheap.
- **write** — one chain: `hash-object -w --stdin-paths` for *only* the files
  whose bytes changed (the rest keep the sha the read returned),
  `update-index --index-info` against a temporary `GIT_INDEX_FILE` in a scratch
  directory, `write-tree`, `commit-tree`, `update-ref`.

The temporary index is rebuilt from nothing on every write, so a deleted card
is simply a card that is not listed — there is no delete path to get wrong.

## `update-ref` is the concurrency story

`git update-ref <ref> <new> <expected-old>` takes the ref lock, checks the old
value, and refuses a mismatch. That is the entire compare-and-swap: no lock
file of hkb's own, no advisory protocol, and the same mechanism the GitHub
store's heartbeat leases on (`concepts/claims-and-leases`).

A refusal means another writer landed first. The tier re-reads the branch and
**replays the mutation on the newer tree**, up to five times, then throws exit 2
naming the host that owns the board. This is why a mutation is a *callback*
rather than a diff: the callback is re-run against whatever the board became,
so the second writer's change is applied on top of the first writer's rather
than over it. A mutation that closes over state read before `commit()` was
called breaks that property — read what you need *inside* the callback.

A write whose bytes are identical to what is already there lands **no commit**.
The branch's history is a history of decisions, and a verb that decided nothing
should not appear in it.

## One writer per board

`board.json` names the owning host. Every write checks it against `hostId()`
and refuses on any other host with exit 2 naming `hkb init --take-over`
(`docs/local-first.md` §6.2). Reads are unrestricted, which is what makes a
clone useful: a friend who clones has no local `kb-board`, so the tier falls
back to `refs/remotes/<remote>/kb-board` and they get a read-only board.

Two hosts writing one branch is not supported in this version — integer ids
allocated from `board.json.next_id` would collide.

## What is *not* on the branch

Locks, heartbeats, the open attempts' pid/job/worktree, and the event log. Those
are host-local and live in the `.git/hkb/index.db` index
(`docs/local-first.md` §6.3): a lock on a branch would be a commit per beat, and
none of it means anything on another machine. So `src/store/git.js` is a
**tier**, not a `Store` — it implements the durable methods of the §6.4
interface and deliberately has no `claim`, `release`, `listLocks`,
`lockBeatAt`, `heartbeat` or `events`. `openStore(ctx)`
(`architecture/store-seam`) is what composes the two into one driver.

## Where the card's machine block went

On GitHub a card's dispatch fields ride in a `<!-- kb: {...} -->` comment at the
top of the issue body, and the standing hazard is a body rewrite that drops it.
Here they are columns: `priority`, `paths`, `goal` and `scheduled_at` are hoisted
onto `cards/<id>.json` so they are legible in a diff, and every other `kb` key
stays under a `kb` object on the same file. Nothing dispatch reads travels
through prose, so `updateBody` cannot lose it — but the method still exists,
because a caller must not have to know which store answered.

Labels get the same treatment: `kb:status:*`, `kb:agent:*`, `kb:board:*` and
`kb:needs-human` are columns, and anything else a caller adds (`kb:no-track`, a
human's own label) is carried verbatim so `getTask` gives it back.
