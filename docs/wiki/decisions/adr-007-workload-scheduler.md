---
title: 'ADR-007: hkb is a workload scheduler — one SQLite board behind Prisma, a runtime seam over the Agent SDK, and Job as the first kind'
summary: "The two-tier store of ADR-006 collapses into one SQLite file behind Prisma; the kb block becomes columns; workers run on the Claude Agent SDK behind a runtime seam; the first workload kind is a Job (one agent, one brief, run to completion) with a reconcile loop and an admission gate; the kanban DAG becomes a second kind that does not exist yet; zero-dependency and the no-build-step rule end."
category: decisions
kind: decision
audience: [dev]
read_when: "touching the store, the runtime, the controller, dependency policy, or asking why the DAG is not in the core"
status: accepted
date: 2026-09-05
supersedes: decisions/adr-006-local-store
superseded_by: ~
covers:
  - path: prisma/schema.prisma
    sha: ad64832b62693fca2c4237a03dc399a6c2f78cf7
  - path: src/db.ts
    sha: bf646fb9e9310a7550ad610aba36fdc0d00fb787
  - path: src/controller.ts
    sha: e1c07b17352ca5087f2d0ce66c186b9728d045c3
  - path: src/admission.ts
    sha: 8b1987ff3533ee61f4d73d4bc3234875f332f11c
  - path: src/runtime/index.ts
    sha: cfdf28fd7555fd7c553e188eaa1dd828a6d93049
  - path: package.json
    sha: fdb07ef571e5af4a0540eb8215d2e3bb699c5c12
generated_at_commit: fc5452a
last_refreshed: 2026-09-05
related: [decisions/adr-006-local-store, architecture/job-kind, architecture/runtime-layer, concepts/admission-control, architecture/store-seam]
---

# ADR-007: hkb is a workload scheduler

## Context

ADR-006 put the board in two tiers: durable content on `refs/kb/boards/<slug>`
(`src/store/git.js`) and live state in `.git/hkb/index.db` (`src/store/sqlite.js`),
composed behind one `Store` (`src/store/local.js`). It worked. The cost showed up
elsewhere: in the 24 hours before this decision, six merged pull requests produced
roughly ninety review findings, and most were about *interactions between layers* —
a driver disagreeing with the interface it implements, a caller reaching around a
seam, a monitor outliving the store it read. Complexity that generates its own
defects is not paying for itself.

Three constraints made the shape obvious once they were stated together:

- **A card's settings were parsed prose.** The `kb` block is JSON inside an HTML
  comment inside the markdown body (`src/model.js`, `DEFAULT_KB`), re-parsed on
  every read, with `_malformed` as a real state the grooming report has to
  explain.
- **The store's live/durable split was load-bearing only because the ref was.**
  Locks, heartbeats and events lived in SQLite because a lock on a branch would be
  a commit per beat. Remove the branch and the reason goes with it.
- **Worker identity was reconstructed, not held.** A detached `claude --bg` worker
  could not be told `KB_TASK`, so identity came from the worktree path, liveness
  came from a heartbeat, and a reclaim timer decided when a silence meant death.

Meanwhile the framing changed. hkb is not a kanban tool that happens to run agents;
it is a thing that takes a **workload** and executes it. The kanban DAG is one
workload shape. `/kanban:groom` and `/kanban:decompose` are another (propose →
approve → apply, blocking on a human). `/kanban:operate` is a third (a reactive
loop that does not terminate). Designing a generic workload API from the one that
exists would fit none of them.

## Decision

**We will treat hkb as a workload scheduler, and build the smallest kind first.**

1. **One SQLite file is the board.** `.kanban/board.db`, outside `.git/` because it
   is durable state now rather than a disposable index (`src/db-url.ts`). The git
   tier and the index tier are both gone from the core; `Event` is the history.
2. **Prisma is the data layer**, version 7.10.0 with the `better-sqlite3` driver
   adapter (`prisma/schema.prisma`, `src/db.ts`). Prisma 8 exists only as a release
   candidate and `@prisma/client` publishes no `8.0.0-rc`, so the pair cannot be
   installed; the schema needs no change when it ships.
3. **The `kb` block becomes columns**, and the closed sets become enums the
   database checks (`Phase`, `Outcome` in `prisma/schema.prisma`).
4. **A runtime is a seam** (`src/runtime/index.ts`): `run(spec) -> WorkerOutcome`,
   with the Claude Agent SDK as the first driver (`src/runtime/claude.ts`) and a
   fake that spends nothing (`src/runtime/fake.ts`).
5. **The first kind is a Job** — one agent, one brief, run to completion, with a
   retry budget — and its controller is one reconcile pass (`src/controller.ts`).
   The DAG is a *second* kind whose controller creates Jobs, so `Link` and the
   `todo/ready/blocked` vocabulary stay out of a core that cannot use them.
6. **Invariants live at admission, never in a prompt** (`src/admission.ts`).
7. **Zero dependencies and "no build step" end.** Runtime dependencies are
   `@prisma/client`, `@prisma/adapter-better-sqlite3` and
   `@anthropic-ai/claude-agent-sdk` (`package.json`). There is still no build step:
   Node runs the `.ts` sources natively, and `importFileExtension = "ts"` on the
   generator is what makes the generated client resolve without a compile.

The pre-ADR-007 system is **not migrated**. `src/store/*`, `src/dispatch.js` and the
CLI verbs still run against the git-ref board; the two coexist.

## Consequences

**Easier.** A card's settings are columns a query can filter on. Liveness is a
promise rather than a heartbeat plus a reclaim timer, because the worker is an
async iterator this process holds. Whole categories of attempt state — `pid`,
`job`, `worktree`, `transcriptPath` — disappear, because the SDK keeps the
transcript and one `sessionId` recovers it (measured: `getSessionMessages()`
returns the messages, `getSessionInfo()` the prompt, cwd and branch).

**Harder, and accepted.**

- **The board no longer travels with a `git clone`, and there is no `git log` of
  decisions.** That was ADR-006's headline property. Backup is a file copy;
  `Event` is the history. `.kanban/*.db` is gitignored — a binary SQLite file
  cannot be merged.
- **`node_modules` is ~364 MB and one dependency is native.** `better-sqlite3`
  needs a prebuilt binary or `node-gyp` per platform. There is no `node:sqlite`
  Prisma adapter.
- **`src/generated/` is committed.** `npm run smoke` packs with an empty
  `node_modules` by design, so no install-time hook may run; a gitignored client
  would pack a tarball with no client in it.
- **`package-lock.json` is still gitignored** with a comment that says TypeScript
  is the only dependency. Direct dependencies are pinned exactly; transitives are
  not. Fixing it needs a CI change too.
- **Two systems in one repo until the migration lands.** 193 cards, 151 run
  records, 155 results and 173 notes remain on `refs/kb/boards/default`, reachable
  only by the old code.

**What we deliberately did not decide.** No generic `Workload` table. The second
kind — most cheaply `/kanban:groom`, because it is a one-shot with a human gate and
therefore the least like a DAG — is what will show which parts generalise. Building
the abstraction from one example fits nothing.
