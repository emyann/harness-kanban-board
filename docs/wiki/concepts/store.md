---
title: The store — hkb's one piece of durable truth
summary: "The concept underneath both drivers: a board is whatever openStore(ctx) answers, one of two tiers on the local driver does the writing and the other does the indexing, and a process holds a cache, never the truth."
category: concepts
kind: explanation
audience: [dev]
read_when: "orienting on where board state actually lives, before diving into architecture/store-seam or architecture/local-store for the mechanics"
covers:
  - path: src/store/index.js
    sha: d440f1432159b01433599dd285c26dceae2596a3
  - path: src/store/local.js
    sha: 74fc6228a29d959c65472b83ba99e6e343fc8099
  - path: src/store/github.js
    sha: 7b384d0c64870f7b33c209325359b8e2630856ad
  - path: src/store/git.js
    sha: ffcc9df59f85f18b58875350cffa057ef8d31681
  - path: src/store/sqlite.js
    sha: ad2e80d73391c5e7c0602c1786ca645604616887
generated_at_commit: 103ecf4
last_refreshed: 2026-09-03
related: [architecture/store-seam, architecture/local-store, architecture/kb-board-branch, architecture/overview, decisions/adr-006-local-store]
---

# The store — hkb's one piece of durable truth

> Everything else in hkb — the dispatcher, the workers, `hkb serve` — holds a
> cache. The store is the one thing that does not: crash any process at any
> moment and the next one re-derives itself from what the store answers.
> `openStore(ctx)` (`src/store/index.js`) is the single door to it; nothing in
> `src/` reaches board state any other way (*architecture/store-seam*).

## One interface, driven by `storeKind`

A board is on exactly one driver, decided by one field: `store` in
`.kanban/board.json` — `"local"` or `"github"`, absent means `github`
(`storeKind`, `src/store/index.js`). Both drivers answer the same shape —
tasks, blockers, runs, claims, notes — so a verb written against the interface
never branches on which one it is talking to; only `hkb init --import`, which
moves a board *from* one *to* the other, opens a driver by name on purpose.
The GitHub driver is one thing: issues, labels and two structured comments,
behind `src/store/github.js`. The local driver is a composition of two tiers,
and that composition is the concept worth carrying in your head.

## The local store's two tiers, and why there are two

A single file (or a single git ref) cannot be both a **history** and a
**query engine** without compromising one of them — a git branch has no
index and no locking, a live claim has no reason to be a commit. So the local
driver (`src/store/local.js`) splits the work:

- **The `kb-board` branch is the record.** One file per card, one run record
  per card, written with plumbing (`hash-object`, `write-tree`,
  `commit-tree`, `update-ref <new> <expected-old>`) so no working tree is
  ever touched (`src/store/git.js`). `git log kb-board` is a history of
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
   `refs/heads/kb-board` and reloads on any mismatch. This is what makes the
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
bytes between hosts — a fast-forward-only push/fetch of the `kb-board`
branch — and refusing anything else is what keeps "one writer" true even
across a network.

## What this buys, concretely

- **Offline is normal, not degraded.** Every read and write is local; `hkb
  sync` is the one operation that touches the network, and it fails soft.
- **A crash loses at most one write.** There is no window where the store
  itself is wrong — only a window, closed by invariant 1, where the index is
  a commit behind the branch.
- **The GitHub driver keeps working, unmodified, behind the same interface.**
  This repository's own board still runs on it; retiring it is track C
  (`docs/local-first.md` §10), not this change.

## What is deliberately not the store

Pull requests. A board kept locally still opens its work on a forge, so
everything about a PR — reads, auto-merge, branch protection, the merge
mutation — lives in `src/forge.js`, calling `src/gh.js`, next to the store
rather than inside it. A local card's `prs` field is `[]`: the store has
nothing to say about where the code review happens.

## Related

- [The store seam](../architecture/store-seam.md) — the interface itself,
  `openStore(ctx)`, and the conformance suite that keeps both drivers honest.
- [The local store — the two tiers as one board](../architecture/local-store.md) —
  the mechanics: which tier answers which read, the two claim tokens, sync,
  the migration off GitHub, what `hkb doctor` and `hkb gc` do and do not do
  here.
- [The kb-board branch](../architecture/kb-board-branch.md) — the plumbing
  that writes it.
- [ADR-006: the local store](../decisions/adr-006-local-store.md) — why this
  shape was chosen over the alternatives.
