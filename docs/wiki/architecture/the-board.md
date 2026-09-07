---
title: The board — the schema as a model
summary: What a row of each table means, why nearly every spec column is nullable, what is frozen onto an Attempt at claim time and why, and the self-bootstrapping migration path that makes the first command on a fresh machine work.
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a column, deciding whether something belongs on the Job or the Attempt, writing a migration, or explaining why a board refuses to open"
covers:
  - path: prisma/schema.prisma
    sha: 888751eac2c7ae7c2bea8f57dd0dce7a1e084b05
  - path: src/schema.ts
    sha: ee1920b789eb96be121c8bba20cc92e452ddf818
  - path: src/db.ts
    sha: c759afb94b34e93ecefdb0384e06924bd772e836
  - path: src/db-url.ts
    sha: 075e55c592c972b3505f106ac670a277996f0615
  - path: src/spec.ts
    sha: df1e8d90a8b3070313b06dd4d47af39ec3f48ca7
generated_at_commit: 1ff10a0
last_refreshed: 2026-09-06
related:
  [
    architecture/job-kind,
    architecture/the-loop,
    architecture/overview,
    concepts/node-floor-and-type-check,
    decisions/adr-007-workload-scheduler,
  ]
---

# The board — the schema as a model

> One SQLite file per **machine**, with a row per **repository** inside it (`src/db-url.ts`). Six
> tables, and almost every interesting decision in them is about *where a fact lives* and *what a
> null means*. `architecture/job-kind` covers the Kubernetes mapping and the Job's own lifecycle;
> this page is about the shape underneath — the keys that do the work of logic, the columns that are
> frozen on purpose, and how a board that nobody created comes into existence.

## Six tables, and what one row of each is

| Table | One row is | Keyed by |
|---|---|---|
| `Board` | a repository's namespace: its ceilings, its spec defaults, and where its Jobs run | `id`, `slug` unique |
| `Job` | a unit of work — its spec *and* its status, in one table | `id` |
| `Attempt` | one execution of a Job: the thing that dies | `(jobId, k)` |
| `Lease` | who holds a Job **right now**, and until when | `jobId` |
| `Controller` | which daemon leads one board | `boardId` |
| `Event` | what happened, in order | `id` |

`Board.repoPath` is the fact that keeps the daemon honest: one daemon serves every board, so
*"wherever the operator was standing"* stopped being a definition of anything, and the repository a
Job runs in is read off its board rather than off `process.cwd()` (`prisma/schema.prisma`,
`src/controller.ts`). It is nullable so a board can exist before it is pointed anywhere — which is
what tests and `hkb run` in a checkout use.

Every child cascades from its parent (`onDelete: Cascade` throughout), which is why `hkb rm` can be
one delete and why the migration path below has to be so careful about `DROP TABLE`.

## Why almost every spec column is nullable

`Job.model`, `effort`, `maxTurns`, `maxBudgetUsd`, `maxRetries`, `allowedTools`, `pluginPaths` are
all nullable, and that is not laziness about defaults — **null is the value that means "nobody
said"**, and it is what makes a board default mean anything (`src/spec.ts`). Three levels resolve in
one fixed order: the Job's own value wins, the Board's default fills a null, the built-in is the last
resort.

The distinction that decides who wins is *default* versus *ceiling*. A default is a value a Job may
freely override, resolved in `src/spec.ts`. A ceiling is a limit a Job may not exceed, enforced at
claim time in `src/limits.ts`. `Board.defaultMaxBudgetUsd` is the first; `Board.dailyBudgetUsd` and
`maxConcurrent` are the second, and no Job column overrides them.

A Job that recorded `maxTurns: 20` because nobody said otherwise would outrank its board's default
for ever — so the columns stay null, and `hkb show` prints where each resolved value came from,
because a spec you cannot trace is worse than one you have to repeat.

`Job.labels` is the exception that proves the rule, and it is worth knowing it is one: it is neither
spec nor status but **metadata for selection**, the first column on this table that exists to make a
*set* of Jobs askable rather than to say anything about one (`src/labels.ts`, `features/labels`).
Null there means "no labels", which is the same fact as an empty map and is stored as the absence.

The `Json?` columns are read defensively for the same reason: `toolList` treats both null *and* "not
a list of strings" as unset, so a malformed column cannot silently narrow a Job's tool surface to
nothing — which would look exactly like a deliberate read-only Job and fail in a way nobody could
read (`src/spec.ts`).

## What is frozen onto an Attempt, and why

An Attempt is history. Once written, its columns describe a run that happened, so several of them are
**copies taken at claim time rather than lookups**:

- **`maxBudgetUsd`** — the resolved cap this attempt was admitted under, never null and never
  re-derived. The reason is a specific reader: `gateClaim` sums what the runs already in flight could
  still cost (`committedUsd`, `src/limits.ts`), and reading `Job.maxBudgetUsd` there would read null
  for exactly the Jobs that inherit their cap. Resolving the spec per open attempt, or joining the
  board's defaults into that query, would both be *wrong in the same way*: the board's default may
  have moved since — possibly because of this very attempt. The frozen number is the only one that
  keeps `$0.31 of $2.00` readable a week later (`prisma/schema.prisma`).
- **`slot`** — the concurrency ordinal, copied off the Lease so it survives the release.
- **`branch`, `prNumber`, `prUrl`** — what the run produced on the forge. History, so it belongs on
  the row; the pull request's *state* stays on GitHub, because that is live and a copy could only go
  stale.
- **`results`, `artifacts`, `inputs`, `proposal`** — what the run was given and what it handed back.
  `inputs` and `artifacts` are catalogues (name, source or kind, size) rather than content: the
  content is in the prompt and in the transcript the `sessionId` points at.

`sessionId` is the whole of why those columns are as few as they are. Whole categories of attempt
state — pid, worktree path, transcript path — do not exist, because the SDK keeps the transcript and
one id recovers it (`decisions/adr-007-workload-scheduler`).

## The keys are the logic

A theme worth naming, because it recurs and because it is what keeps the controller simple: **where a
database constraint can refuse, nothing in the code has to be right.**

- `Lease.jobId` is `@id`, and that *is* the compare-and-swap. Two hosts computing the same claim both
  insert; the loser's insert fails and the pass moves on (`src/controller.ts`).
- `Lease.slot` is `@unique`, and that is the slot allocator. Two daemons reading the same set compute
  the same lowest free integer, and the constraint decides between them.
- `Attempt` is keyed `(jobId, k)`, so an attempt number is never invented twice and a resumed attempt
  cannot collide with the one it resumed.
- `Job(proposedByJobId, proposedByK, proposalIndex)` is unique, which is what makes applying an
  approved proposal idempotent (`features/proposals`).

In every case the failure path is the same shape: catch, count it as *somebody else got there*, and
let the next level-triggered pass sort it out.

### The read that had the opposite problem

Constraints refuse loudly; a hand-listed `select` fails silently. The controller used to read the
Board through one, and every spec default the board gained had to be added to it — so when
`defaultPluginPaths` was not, ADR-012's board-level grant resolved to `undefined`, fell through to
the built-in, and reached no worker at all. Nothing errored. The grant just did not exist. It reads
the whole row now (`src/controller.ts`), because a Board row is a handful of small scalars and a
list somebody has to remember to extend is not a saving.

## Nullability is a migration decision as often as a modelling one

SQLite has no `ALTER COLUMN`, so Prisma implements most column changes as **`RedefineTables`** — copy
the table, `DROP` the original, rename the copy over it. Against a live board that is a much bigger
event than the schema diff suggests, and it is why:

- `Lease.slot` is `Int?` rather than `Int`. A required column emits a table rebuild against a table a
  running daemon may be holding leases in; a nullable one is a plain `ADD COLUMN`. SQLite counts
  NULLs as *distinct* under a unique index, so leases claimed by an older hkb coexist with new ones
  that each take a slot (`prisma/migrations/20260906075500_lease_slot/migration.sql`).
- `Job.proposes` is a nullable string rather than a boolean, for the same reason plus one more: the
  string names the closed set of things that may be proposed, so a second member costs no migration.

The rule of thumb the schema has arrived at: **add nullable, and check the generated SQL before
committing it.** `npx prisma migrate diff --from-migrations prisma/migrations --to-schema
prisma/schema.prisma --script` prints exactly what will run without needing a TTY, which
`prisma migrate dev` does need once a board has drifted.

## A board creates and migrates itself

`openBoard()` calls `assertNotFromTheFuture` and then `ensureSchema` on every open (`src/db.ts`).
Idempotent: with nothing to do it is one indexed read.

This exists because a machine-level default is only frictionless if the *first* command on a fresh
machine works. "Go and run `prisma migrate deploy`" fails that twice over — it is the "yes, by hand"
answer this project treats as a bug report, and `prisma` is a devDependency a global install does not
have. So the committed SQL under `prisma/migrations` is applied through the SQLite driver hkb already
ships, writing the same `_prisma_migrations` rows Prisma writes, so `prisma migrate status` and
`prisma migrate dev` keep working in a checkout (`src/schema.ts`). That is also why
`prisma/migrations` is in `files` in `package.json` and why `npm run smoke` checks it.

**The bug this path has already produced once is worth knowing about.** Every `RedefineTables` block
opens with `PRAGMA foreign_keys=OFF`, precisely because `DROP TABLE` performs an implicit `DELETE`
that fires `ON DELETE CASCADE` on every child. SQLite documents that pragma as a **no-op inside a
transaction** — so wrapped in `BEGIN`, it did nothing, and redefining `Job` deleted every Attempt,
Lease and Event on the board. The fix is to set it outside the transaction, and `foreign_key_check`
now runs before each commit so a migration that leaves a dangling row rolls back instead of being
found weeks later as a crash in a join (`src/schema.ts`). Nothing had noticed, because the two
migrations that redefine `Job` shipped before anyone had a board with rows in it — the test that
keeps this true migrates a *populated* board and counts what survived (`test/schema.test.ts`).

The backward direction cannot be handled the same way, so it is refused: a board carrying a migration
this build does not know about produces a message naming the migration and the two ways out, rather
than a Prisma error naming a column (`assertNotFromTheFuture`, `src/schema.ts`).

**Which is why a checkout may create a board and may not rewrite one.** The forward direction used to
be unguarded in the other sense: running any command from a feature branch applied that branch's
migrations to `~/.hkb/board.db`, after which every other checkout refused it — the exact workflow this
project is built around, developing hkb from a checkout while using hkb. `mayMigrate` now takes three
facts (`src/schema.ts`): a **new** board is created and migrated with no ceremony, because the first
command on a fresh machine has to work; an **installed** build migrating on upgrade is ordinary; and a
**checkout** meeting a board that already exists refuses, naming the pending migrations and
`hkb migrate`. An `npm link` install counts as a checkout, and should — the bin's realpath is the
working copy (`IS_CHECKOUT`, `src/paths.ts`).

## What the board deliberately does not hold

- **No `Link` table and no `todo`/`ready`/`blocked`.** A dependency graph is a second kind whose
  controller creates Jobs; keeping its vocabulary out of a core that cannot use it is
  `decisions/adr-007-workload-scheduler` decision 5.
- **No transcript, no token counts, no pid.** The SDK holds them and `sessionId` recovers them.
- **No pull-request state.** The forge is live; a copy could only go stale.
- **No generic `Workload` table.** Everything added since ADR-007 arrived as columns and enum values
  on `Job` and `Attempt`, which is the evidence that the abstraction is not needed yet.

## Related

- [job-kind](job-kind.md) — the Kubernetes mapping and the Job's lifecycle
- [the-loop](the-loop.md) — who writes these rows, and in what order
- [adr-007-workload-scheduler](../decisions/adr-007-workload-scheduler.md) — why SQLite behind Prisma
