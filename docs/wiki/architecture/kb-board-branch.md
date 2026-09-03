---
title: The kb-board branch
summary: "The durable half of a local board lives on a dedicated git branch written with plumbing only — no checkout, no staging, no working-tree write — with update-ref as the compare-and-swap and a retry that replays the mutation."
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a durable store verb, debugging a board write that lost or refused, or wondering why a worker's worktree stays clean while the board moves"
covers:
  - path: src/store/git.js
    sha: a3a5f2ebb104f22bd196c78301036b61b1da2ac9
  - path: src/store/index.js
    sha: 918495a206540318480f3b0ce7cd0a8f559ae874
  - path: src/board.js
    sha: 5b2d5227aa6157021e68c1bd169a5019c79e6944
generated_at_commit: 90132a1
last_refreshed: 2026-09-03
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

"The common git directory's parent" is the right answer for *where the board's
checkout is* and the wrong one for *where a file inside the git directory goes*
— they differ in a submodule or a `--separate-git-dir` clone, where `.git` is a
file. Anything that wants a path in the git directory (the index, `.git/hkb/`)
asks `storeGitDir` (`src/board.js`) rather than joining `.git` back on.

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
That cuts both ways, and it is the branch's sharpest edge: **a path the write
does not list is a path deleted.** The tier owns exactly three file *names* —
`board.json`, `cards/<n>.json` and `runs/<n>.json`, the same patterns the read
parses — and carries every other entry across at the sha and mode it already had
(`isOwned` / `_land`, `src/store/git.js`). Without that, a `README.md` somebody
put on the branch disappeared on the first `setStatus`, and the no-op guard
(which compares only owned paths) reported that nothing had changed. Ownership
is by file name and not by directory for the same reason at one level down: a
`cards/README.md` is read by no parser, so claiming the whole `cards/` prefix
would delete it just as silently. A foreign path is never even decoded — the
write path only ever needs its sha and mode, and a blob on the branch may be
binary. Both directions are NUL-delimited for the same reason: git permits a
newline or a tab in a path name, `ls-tree -z` hands one back raw, and
`update-index -z --index-info` is what carries it back without one odd name
splitting the payload and corrupting every entry after it.

Reads are memoized on the tip sha, and a successful write leaves the tree it
just built behind it, parsed back out of the bytes that landed. So a tick that
asks about twenty cards decodes the tree once, and the `getTask` every verb does
after its own commit costs one `rev-parse`. The memo is keyed on the sha, so a
writer in another process invalidates it by definition.

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
should not appear in it. That holds only because `_patch` compares the card
before and after the mutation and leaves `updated_at` alone when nothing moved:
a timestamp stamped unconditionally makes every verb "a change", so `setStatus`
to the status a card already has would land a commit saying so. `closeTask` and
`addLabels` hold the same line — a closing time is stamped only on a card that
was open, and the label list is re-sorted only when the set actually moved.

The question is asked *before* either guard on writing — the one-writer check
and the writable-ref check both — so a verb that decides nothing costs nothing
even on a read-only clone. A reconcile pass re-asserting the state of twenty
cards is exactly the caller this makes free, and a clone is exactly where one
runs; a clone's host is also, by definition, not the host `board.json` names, so
asking the owner question first would have put the same exit 2 one line up.

## One writer per board

`board.json` names the owning host. Every write checks it against `hostId()`
and refuses on any other host with exit 2 naming `hkb init --take-over`
(`docs/local-first.md` §6.2). Reads are unrestricted, which is what makes a
clone useful: a friend who clones has no local `kb-board`, so the tier falls
back to `refs/remotes/<remote>/kb-board` and they get a read-only board.

Two hosts writing one branch is not supported in this version, and the reason
is **not** that ids would collide: a CAS refusal re-reads and replays the
mutation on the newer tree, so two writers racing to create a card get two
different numbers (`src/store/git.js`, `commit`; `test/store-git.test.js`, "a
concurrent writer makes the CAS refuse"). Allocation is also guarded — an id a
card already occupies is never handed out, whatever `board.json` says
(`nextId`, `src/store/git.js`).

What the rule really buys is everything *around* the branch: the index
(`.git/hkb/index.db`) is host-local, so is the dispatcher, and a second host
writing decisions into the branch would be making them against an index it
cannot see. `board.host` is the enforcement; the collision story was the wrong
justification for a right rule.

### A clone can read, and cannot write

A fresh clone has `refs/remotes/origin/kb-board` and no local branch. Reads fall
back to it; a **write refuses with the branch command that fixes it**, because
the compare-and-swap is on `refs/heads/kb-board` and there is nothing there to
swap. Git says `cannot lock ref … unable to resolve reference` for that, which
is one word away from what it says for real contention (`is at X but expected
Y`) — telling them apart is `classifyRefWrite` (`src/store/git.js`), and getting
it wrong turned "there is no branch here" into five retries and a message
blaming a writer on another host.

## What is *not* on the branch

Locks, heartbeats, the open attempts' pid/job/worktree, and the event log. Those
are host-local and live in the `.git/hkb/index.db` index
(`docs/local-first.md` §6.3): a lock on a branch would be a commit per beat, and
none of it means anything on another machine. So `src/store/git.js` is a
**tier**, not a `Store` — it implements the durable methods of the §6.4
interface and deliberately has no `claim`, `release`, `listLocks`,
`lockBeatAt`, `heartbeat` or `events`. `src/store/local.js` is what composes the
two into one driver, and `openStore(ctx)` (`architecture/store-seam`) is what
picks it; the rules that hold the halves together — reconcile on open, commit
then index then wake, live writes never touching git — are
`architecture/local-store`.

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

Two things a caller's task object carries that this tier cannot know: `prs` and
`url` are `src/forge.js`'s, and every verb here reads back a card with them
empty. The verbs therefore *merge* into the caller's task rather than replacing
it (`syncTask`, `src/store/git.js`) — `requestChanges` calls `setStatus` and
then reads `task.prs`, so a wholesale copy erased the open PR it was about to
continue and reported "no open PR" for a card that had one.

Notes and results share `runs/<id>.json`, and which one a body is gets decided
by `startsWith(RESULT_MARKER)` *and* a successful parse — a human note that
merely quotes the marker is a note. Filing it as a result loses it from
`listNotes` and makes `latestResult` hand the next worker an empty handoff.
