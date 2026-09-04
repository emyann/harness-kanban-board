---
title: The board's ref
summary: "The durable half of a local board lives at refs/kb/boards/<slug> — a git ref outside refs/heads, invisible to git branch — written with plumbing only, with update-ref as the compare-and-swap and a retry that replays the mutation."
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a durable store verb, debugging a board write that lost or refused, wondering why a worker's worktree stays clean while the board moves, or why a clone did not bring the board"
covers:
  - path: src/store/git.js
    sha: 756d59b84516862697b6d7d7cef20210878ca0ea
  - path: src/store/index.js
    sha: fed32f2f24ff0ecb5bbec064c26fcaa3f63fd7dc
  - path: src/board.js
    sha: 0337a17cf70442cac66fb457c880e4b27a52672e
generated_at_commit: 53ecf5a
last_refreshed: 2026-09-03
related: [architecture/store-seam, decisions/adr-006-local-store, decisions/adr-005-control-plane, concepts/claims-and-leases]
---

# The board's ref

> A local board is two tiers. This is the one that has to survive a `git clone`:
> the board document, one file per card, one run record per card, at
> `refs/kb/boards/<slug>`. `src/store/git.js` is the only thing that writes it.

## Why a git ref, and why not the working tree

The board must travel with the repository — a push and fetch bring the cards,
and `git log refs/kb/boards/default` *is* the board's history of decisions
(`docs/local-first.md` §6.1). A directory of JSON files in the checkout would
also travel, but it would be in everyone's `git status`, in everyone's diffs,
and in the way of every rebase. So the files live on a ref nobody checks
out, and `src/store/git.js` reaches them with plumbing.

## Why not `refs/heads` — and what that costs

The first cut put the board on `refs/heads/kb-board`, which meant a branch
nobody ever checks out showed up in `git branch`, in every branch picker and in
GitHub's branch list, among the branches that mean something. Nothing about the
design needed `refs/heads`: plumbing writes, `update-ref` as a compare-and-swap,
history, push and fetch all work on any namespace — hkb already keeps claims at
`refs/kb/locks/<n>/<k>` (*concepts/claims-and-leases*). So the board is at
`refs/kb/boards/<slug>` (`boardRef`, `src/store/git.js`), `refs/kb/boards/default`
unless `--board` said otherwise. Not `refs/kb/board` with `refs/kb/board/<slug>`
beside it: git forbids a ref being both a file and a directory prefix, so those
two could never coexist.

The slug is a ref path segment, so it is validated as one — letters, digits,
`.`, `_`, `-`, no leading dot, no `.lock` suffix (`boardRef`) — and two boards in
one repository get two refs and an index file each, where before they shared one
branch and one board silently became the other.

**The cost, and it is real:** a ref outside `refs/heads` is not carried by a
default `git clone` and is not visible in GitHub's web UI. Three things pay it
back, and all three are the operator's ordinary commands:

- `hkb init` **appends** `+refs/kb/boards/*:refs/kb/remotes/<remote>/boards/*` to
  `remote.<name>.fetch` (`ensureFetchRefspec`, `src/store/local.js`) — appended,
  never replacing the `+refs/heads/*` line, which is what makes the remote a
  remote for everything that is not hkb. Idempotent.
- `hkb doctor` reports the line when it is missing and names the fix
  (`REFSPEC_CHECK`, `src/doctor.js`).
- `hkb sync` passes that refspec **on the command line** rather than trusting
  config, and writes the config line while it is there (`sync`,
  `src/store/local.js`). A fresh clone has no such config, and that clone is
  exactly the case sync exists for — so restoring a board onto a new machine is
  still `git clone` then `hkb sync`, and nothing else.

The destination is `refs/kb/remotes/<remote>/boards/*`, and both halves of that
were learned the hard way.

Not `+refs/kb/*:refs/kb/*`, which would be shorter and would be a bug: the local
ref is the one the one-writer compare-and-swap leases, so a fetch writing it
would replace whatever this host had decided with the remote's older copy,
silently, on every fetch. (`hasFetchRefspec` therefore matches a config line on
its **destination**, not its source — matching the source called exactly that
line "present", so `hkb doctor` printed a green row about the one config that
destroys the board.)

And not `refs/remotes/<remote>/kb/boards/*`, which is where this landed first.
Git forbids a ref being both a file and a directory prefix, and
`refs/remotes/<remote>/` is full of refs named after other people's branches: on
a repository whose origin has a branch called `kb`, `refs/remotes/origin/kb`
exists, so `refs/remotes/origin/kb/boards/default` cannot — and every ordinary
`git fetch origin` in that repository then exits 1 with `cannot lock ref`,
because of a line hkb put in the operator's `.git/config`. That is the same
sin as replacing the `+refs/heads/*` line, one step removed. `refs/kb/remotes/`
is hkb's own namespace all the way down, so no branch name can reach it.

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
That cuts both ways, and it is the ref's sharpest edge: **a path the write
does not list is a path deleted.** The tier owns exactly three file *names* —
`board.json`, `cards/<n>.json` and `runs/<n>.json`, the same patterns the read
parses — and carries every other entry across at the sha and mode it already had
(`isOwned` / `_land`, `src/store/git.js`). Without that, a `README.md` somebody
put on the board's ref disappeared on the first `setStatus`, and the no-op guard
(which compares only owned paths) reported that nothing had changed. Ownership
is by file name and not by directory for the same reason at one level down: a
`cards/README.md` is read by no parser, so claiming the whole `cards/` prefix
would delete it just as silently. A foreign path is never even decoded — the
write path only ever needs its sha and mode, and a blob on the board may be
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

A refusal means another writer landed first. The tier re-reads the board and
**replays the mutation on the newer tree**, up to five times, then throws exit 2
naming the host that owns the board. This is why a mutation is a *callback*
rather than a diff: the callback is re-run against whatever the board became,
so the second writer's change is applied on top of the first writer's rather
than over it. A mutation that closes over state read before `commit()` was
called breaks that property — read what you need *inside* the callback.

A write whose bytes are identical to what is already there lands **no commit**.
The board's history is a history of decisions, and a verb that decided nothing
should not appear in it. That holds only because `_patch` compares the card
before and after the mutation and leaves `updated_at` alone when nothing moved:
a timestamp stamped unconditionally makes every verb "a change", so `setStatus`
to the status a card already has would land a commit saying so. `closeTask` and
`addLabels` hold the same line — a closing time is stamped only on a card that
was open, and the label list is re-sorted only when the set actually moved.

### The reflog is asked for, not assumed

`git update-ref` here passes `--create-reflog`. `core.logAllRefUpdates` at its
default logs `refs/heads`, `refs/remotes`, `refs/notes` and HEAD — and nothing
else — so moving the board out of `refs/heads` would otherwise have taken its
reflog with it: `git reflog refs/kb/boards/default` empty, `.git/logs/refs`
holding only `heads`. Two messages in the tier prescribe `git reflog <ref>`
(`_absentRefMessage`, and `_reconcileRefs` after three lost compare-and-swaps),
and more to the point a bad `update-ref`, a racing `hkb down` or a clobbering
fetch would stop being recoverable on the tier the design calls *durable*.
`hkb sync`'s own `update-ref` (`_setRef`) passes it for the same reason.
Tested by reading the reflog back (`test/store-git.test.js`).

The question is asked *before* either guard on writing — the one-writer check
and the writable-ref check both — so a verb that decides nothing costs nothing
even on a read-only clone. A reconcile pass re-asserting the state of twenty
cards is exactly the caller this makes free, and a clone is exactly where one
runs; a clone's host is also, by definition, not the host `board.json` names, so
asking the owner question first would have put the same exit 2 one line up.

## One writer per board

`board.json` names the owning host. Every write checks it against `hostId()`
and refuses on any other host with exit 2 naming `hkb init --take-over`
(`docs/local-first.md` §6.2). That guard is a **safety** property for a single
operator — it stops a second machine, a stale worktree or a second dispatcher
from writing the board concurrently — and not a collaboration feature;
multi-player is out of scope by decision.

Reads are unrestricted, which is what makes a *restore* work: a checkout that
has fetched but not synced has no local `refs/kb/boards/<slug>`, so the tier
falls back to `refs/kb/remotes/<remote>/boards/<slug>` (`trackingRefFor`) and the
board is readable before `hkb sync` creates the local ref.

Two hosts writing one board is not supported in this version, and the reason
is **not** that ids would collide: a CAS refusal re-reads and replays the
mutation on the newer tree, so two writers racing to create a card get two
different numbers (`src/store/git.js`, `commit`; `test/store-git.test.js`, "a
concurrent writer makes the CAS refuse"). Allocation is also guarded — an id a
card already occupies is never handed out, whatever `board.json` says
(`nextId`, `src/store/git.js`).

What the rule really buys is everything *around* the board's ref: the index
(`.git/hkb/index.db`) is host-local, so is the dispatcher, and a second host
writing decisions into the ref would be making them against an index it
cannot see. `board.host` is the enforcement; the collision story was the wrong
justification for a right rule.

### A clone can read, and cannot write

A clone that has fetched the namespace has `refs/kb/remotes/origin/boards/<slug>`
and no local ref. Reads fall back to it; a **write refuses with the
`update-ref` command that fixes it**, because the compare-and-swap is on
`refs/kb/boards/<slug>` and there is nothing there to swap. (A clone that has
*not* fetched it has neither, and reads as an empty board — `hkb sync` is what
turns that into a restore.) Git says
`cannot lock ref … unable to resolve reference` for the missing local ref, which
is one word away from what it says for real contention (`is at X but expected
Y`) — telling them apart is `classifyRefWrite` (`src/store/git.js`), and getting
it wrong turned "there is no board here" into five retries and a message
blaming a writer on another host.

### A board still on the old ref is named, not missed

Nothing was ever written to `refs/heads/kb-board` in this repository — measured
on the remote too, before the move — but that measurement covered *this*
repository. A checkout made between #326 (when local became the default store)
and the move has a whole board sitting there. So `findLocalBoardRef`
(`src/store/local.js`) probes three refs — the board's own, the remote's copy,
and `refs/heads/kb-board` — and `hkb doctor` reports the third by name with the
one-line `update-ref` that moves it. This is a safety net, not a migration:
nothing writes the old ref and nothing reads a board off it. Without the net,
the board reads as absent and doctor's own `hkb init` fix creates a *second,
empty* board beside the real one.

## What is *not* on the board's ref

Locks, heartbeats, the open attempts' pid/job/worktree, and the event log. Those
are host-local and live in the `.git/hkb/index.db` index
(`docs/local-first.md` §6.3): a lock on a ref would be a commit per beat, and
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
