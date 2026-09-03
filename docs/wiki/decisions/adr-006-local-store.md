---
title: 'ADR-006: The source of truth is local and travels with a clone — a git branch plus a SQLite index; GitHub becomes a bridge later'
summary: "The board's state moves off GitHub into two local tiers (durable content on a dedicated git branch, live state and an index in node:sqlite under the common git dir); a board has one control plane; the Actions runner is removed; the GitHub store is retired and returns later as a bridge adapter under a strict direction rule; the Node floor becomes 22.13 and TypeScript ships transpiled."
category: decisions
kind: decision
audience: [dev]
read_when: "touching src/tasks.js, src/lock.js, the store seam, the board's location on disk, the Node floor, the release build, or proposing any sync with GitHub"
status: accepted
date: 2026-09-02
supersedes: ~
superseded_by: ~
covers:
  - path: src/store/index.js
    sha: ff18b848824f2370c915b5417fd6fe51d5c36f2f
  - path: src/store/github.js
    sha: e2708642df0ef4599f450e643b9b67eeeb0b2ad5
  - path: src/forge.js
    sha: 20dd384386ca63bc98d103b2e7728f29a95bc87c
  - path: src/board.js
    sha: 0e4a4ad473531aaea01d951afa45c21be1839cc3
  - path: package.json
    sha: e0c6c8eeda7d091e841f1a764486ad9a57edd0f5
generated_at_commit: 447b51e
last_refreshed: 2026-09-02
related: [decisions/adr-005-control-plane, decisions/adr-004-roles-and-adoption, architecture/overview, features/web-board, features/up-and-down]
---

# ADR-006: The source of truth is local and travels with a clone — a git branch plus a SQLite index; GitHub becomes a bridge later

## Context

GitHub Issues carried hkb a long way, and three limits have now been reached. The browser board cannot
order cards inside a lane, stream a change, or show a history, because the Issues schema and a
30-second conditional poll cannot carry them (`src/serve.js`, `web/index.html`). A GitHub outage
stops the board, not only the landing of code. And the maintainer wants a friend who clones the repo
to have the board.

The August 2026 study of a local backend said "not yet" to SQLite for one reason, Node 20, and named
the condition that would reopen it. Node 20 is end-of-life; on Node 24 `node:sqlite` loads with no flag
and no warning at release-candidate stability, and on 22 its `ExperimentalWarning` can be silenced
in-process. Hermes keeps its board in a local SQLite file, is "deliberately single-host", and has no
GitHub sync at all. Beads keeps its database out of the working tree and syncs it through a ref on the
git remote.

Counted at `7fd6cba`: `src/tasks.js` has 36 exports and `src/lock.js` 19; 29 direct transport call
sites live in six other files; 121 test assertion sites read the fake GitHub's internals. The pull
request half of the protocol — about a dozen functions — is tied to the forge, not to the board, and
cannot move. The Actions runner (`kanban-dispatch.yml`, the `claude-action` profile) reads the board
from GitHub and cannot read a file on a laptop; the maintainer does not use it.

## Decision

- **Two tiers, one store.** The durable half of a board — the board record, one file per card, one run
  record per card — lives on a dedicated git branch, `kb-board`, written with plumbing from any worktree
  and never checked out; it is what a `git clone` carries and what `git log` keeps as history. The live
  half — locks, open attempts' handles and pause fields, the events table — and an index of the branch
  live in `.git/hkb/index.db` (`node:sqlite`), rebuilt from the branch whenever its stored tip differs
  from the ref. `.kanban/state.json` keeps the host-local facts it has today. Design: `docs/local-first.md` §6.
- **One control plane per board.** `board.json` on the branch names the owning host; the dispatcher,
  `claim` and the verbs refuse elsewhere and name the takeover flag. A clone is a read-only view. Two
  writers are not supported in this version.
- **Sync is git.** `hkb sync` pushes and fast-forwards `kb-board`; the loop runs it after durable
  writes when a remote exists, throttled and offline-tolerant, with a `board.json` setting to turn it off.
- **The seam comes first.** A `Store` interface (`docs/local-first.md` §6.4) is extracted from
  `src/tasks.js` and `src/lock.js` with the GitHub bodies behind it and no behaviour change; the two
  tiers implement it; a driver-parametrised conformance suite runs both; the pull-request functions
  move to `src/forge.js` and stay on `src/gh.js`. *Landed:* `src/store/index.js`,
  `src/store/github.js`, `src/forge.js` and `test/store.test.js` exist and `src/tasks.js` /
  `src/lock.js` are re-export shims over them — see *architecture/store-seam*.
- **The Actions runner is removed**, not refused: templates, profile, `trigger` mode, `remote` liveness,
  docs. `--profiles` stays.
- **The GitHub store is retired** once every live board has been imported (`hkb init --import`), and the
  tests have moved onto a store double. **It returns later as a bridge adapter** under one rule: board
  state flows out, forge state flows in, nothing else crosses (`docs/local-first.md` §8). A human
  closing an issue on github.com is board state and becomes `needs_human`, never an archive.
- **The inbox is the triage lane**, with a quick-add on the web board and the MCP create tool now, and
  a human-opened issue as the bridge's one creation-only inbound exception later.
- **The Node floor is `>=22.13`**, 24 recommended, with the SQLite warning silenced in `bin/hkb.js`;
  CI runs 22, 24 and 26; 22 is dropped at its end of life (April 2027).
- **TypeScript ships transpiled.** Native `.ts` runs in a checkout; `prepack` in `release.yml` builds
  `dist/` for the tarball, because Node refuses to strip types under `node_modules`. `typescript` is a
  devDependency; "zero dependencies" keeps meaning none at runtime and none to run from a clone.

## Consequences

- "The board is the only state" becomes "the store is the only state"; every rule of ADR-005 holds
  with the address changed. A pause, a suspend and `pauses[]` are columns rather than a ref, a
  body-block key and a comment field.
- `CLAUDE.md`'s "any harness drives it through `gh`" is reworded to "through `hkb` verbs".
  `README.md` loses "Runs when the laptop is closed". `docs/EVALUATION.md` and `docs/status.md` stay
  as history.
- The orphan-lock sweep, the comment-mode heartbeat, `KB_LOCK_REF`, `lock_sha`, `hkb gc`'s
  duplicate-comment and beat-chain sweeps, and the run-comment format all leave with the GitHub store.
- What gets weaker: durability is the branch and its remote, not GitHub's database; laptop-closed
  dispatch is gone until a cloud story exists; a friend cannot write to the board without taking it over.
- The permanent "and on GitHub?" tax on every verb is paid only until the GitHub store is deleted;
  the bridge, when it comes, is one adapter behind a queue, not a second store.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. -->
