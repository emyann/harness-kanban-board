---
title: The store — hkb's one piece of durable truth
summary: "A board is whatever openStore(ctx) answers: one driver, two tiers — a git branch that records decisions and a local index that answers questions — and every other process holds a cache, never the truth."
category: concepts
kind: explanation
audience: [dev]
read_when: "orienting on where board state actually lives, before diving into architecture/store-seam or architecture/local-store for the mechanics"
covers:
  - path: src/store/index.js
    sha: fed32f2f24ff0ecb5bbec064c26fcaa3f63fd7dc
  - path: src/store/local.js
    sha: b11fe32cf346862b8423450d43680708d70eb37a
  - path: src/store/git.js
    sha: 756d59b84516862697b6d7d7cef20210878ca0ea
  - path: src/store/sqlite.js
    sha: 109968690b1068b0edf2ab028e3440a7ca97dcee
generated_at_commit: 53ecf5a
last_refreshed: 2026-09-03
related: [architecture/store-seam, architecture/local-store, architecture/board-ref, architecture/overview, decisions/adr-006-local-store]
---

# The store — hkb's one piece of durable truth

> Everything else in hkb — the dispatcher, the workers, `hkb serve` — holds a
> cache. The store is the one thing that does not: crash any process at any
> moment and the next one re-derives itself from what the store answers.
> `openStore(ctx)` (`src/store/index.js`) is the single door to it; nothing in
> `src/` reaches board state any other way (*architecture/store-seam*).

## One interface, one driver

There is one store, and it is local: the board's own git ref
(`refs/kb/boards/<slug>`) and the index beside it. `storeKind` (`src/store/index.js`) still *reads* `store` in
`.kanban/board.json`, but only to answer `local` for `"local"` and for the key
being absent, and to refuse `"github"` by name with the migration
(`hkb init --import`) rather than half-opening something that is no longer
there. A board still on GitHub Issues is a real thing somebody may have on
disk; telling them so is the whole reason the key is read at all.

The key being *absent* is the harder half, and the driver answers it rather
than `storeKind`: an unmigrated board.json has no `store` key, so it resolves
to *local* and then finds no board ref. The read path refuses there
too — `listTasks` and `getTask` (`src/store/git.js`) throw `noBoardHere`
(`src/model.js`), naming the ref it looked for and then `hkb init`,
`hkb init --import` and `hkb sync`, because the three ways to be boardless have
three different fixes. It names the *ref*, not a branch: since the board moved
out of `refs/heads` (*architecture/board-ref*), "no kb-board branch" would send
the reader to `git branch`, where a healthy board is invisible too. Reads used to
answer `[]`, which made a board that was never created indistinguishable from
an empty one to `hkb list` and to the dispatcher.

The interface survived the driver it was extracted from, which is the point of
having had one: `src/store/github.js` was deleted rather than rewritten, and no
verb changed, because every verb was already written against
`STORE_METHODS`. What is left of GitHub Issues is `src/bridge/github-issues.js`
— read-only, and reachable only from `importGithubBoard`.

The local driver is a composition of two tiers, and that composition is the
concept worth carrying in your head.

## The local store's two tiers, and why there are two

A single file (or a single git ref) cannot be both a **history** and a
**query engine** without compromising one of them — a git branch has no
index and no locking, a live claim has no reason to be a commit. So the local
driver (`src/store/local.js`) splits the work:

- **The board's ref is the record.** One file per card, one run record
  per card, written with plumbing (`hash-object`, `write-tree`,
  `commit-tree`, `update-ref <new> <expected-old>`) so no working tree is
  ever touched (`src/store/git.js`). Its `git log` is a history of
  *decisions* — every status change, every claim's outcome — because nothing
  that isn't a decision is allowed to land there.
- **`.git/hkb/index.db` is the cache.** A `node:sqlite` database
  (`src/store/sqlite.js`) that mirrors the branch as queryable tables and
  additionally holds what has no business being a commit: locks, an open
  attempt's pid/job/worktree, and the event log `hkb watch` and `hkb serve`
  stream from.

Neither tier alone is a board — the branch has no locks, the index has
nothing it did not copy from the branch. `LocalStore` is where the rule that
makes them one thing lives, and it comes down to three invariants:

1. **The index is rebuilt from the branch whenever it disagrees.** It stores
   the sha it was built from; a fresh `open()` compares that to
   `refs/kb/boards/<slug>` and reloads on any mismatch. This is what makes the
   split safe — the index is disposable, the branch is not.
2. **A durable verb commits, then indexes, then wakes — in that order.** A
   crash between the commit and the index write leaves the index one commit
   behind, which invariant 1 repairs on the next open. The branch is never
   behind the index; that direction of staleness cannot happen.
3. **A live write never touches git.** Claims and heartbeats are index rows,
   not commits, because a lock is not a decision anyone needs a history of.

## One writer

`board.json` on the branch names the host that may write it. Every mutating
verb checks that before it spends anything (`assertOwningHost`,
`src/store/index.js`, backed by `assertLocalOwner`,
`src/store/local.js`) — a laptop that is not the named host gets told to
`hkb init --take-over` rather than being allowed to race the real owner. A
plain `git clone` still gets the whole board with no setup, because
`.kanban/board.json` is a tracked file and travels with the clone: it reads
freely and every write is refused, which is what makes a friend's clone a
*reader* rather than a second writer. `hkb sync` is the only thing that moves
bytes between hosts — a fast-forward-only push/fetch of the board's
branch — and refusing anything else is what keeps "one writer" true even
across a network.

## What this buys, concretely

- **Offline is normal, not degraded.** Every read and write is local; `hkb
  sync` is the one operation that touches the network, and it fails soft.
- **A crash loses at most one write.** There is no window where the store
  itself is wrong — only a window, closed by invariant 1, where the index is
  a commit behind the branch.
- **One protocol to reason about.** Every verb was written twice while there
  were two stores — once against issues and labels, once against the branch —
  and the second one is now the only one. A claim is a `BEGIN IMMEDIATE`
  transaction, a heartbeat is a compare-and-swap on its token, and neither has
  a GitHub spelling any more.

## What is deliberately not the store

Pull requests. A board kept locally still opens its work on a forge, so
everything about a PR — the listings, auto-merge, branch protection, the merge
mutation — lives in `src/forge.js`, calling `src/gh.js`, next to the store
rather than inside it. A card comes out of the store with `prs: []`
(`src/store/git.js`), and `fillPrs` (`src/forge.js`) is the **join**: one
listing of the repository's pull requests, matched to cards by *head branch*.

That match is the whole link. There is no issue for a pull request to
reference, so `kb-<n>-<k>` — and the `worktree-kb-<n>-<k>`, `kb/<n>` and
`kb/track-<n>` spellings hkb also creates (`taskBranchRe`, `src/model.js`) — is
what says which card a PR belongs to. Two consequences worth keeping in mind:
a caller that reads `task.prs` must have called `fillPrs` on that read, and a
pull request on any other branch name is one hkb cannot see at all.

## Related

- [The store seam](../architecture/store-seam.md) — the interface itself,
  `openStore(ctx)`, and the conformance suite that keeps both drivers honest.
- [The local store — the two tiers as one board](../architecture/local-store.md) —
  the mechanics: which tier answers which read, the two claim tokens, sync,
  the migration off GitHub, what `hkb doctor` and `hkb gc` do and do not do
  here.
- [The board's ref](../architecture/board-ref.md) — the plumbing
  that writes it.
- [ADR-006: the local store](../decisions/adr-006-local-store.md) — why this
  shape was chosen over the alternatives.
