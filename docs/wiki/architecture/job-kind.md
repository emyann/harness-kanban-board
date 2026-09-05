---
title: The Job kind and its controller
summary: The first and only workload kind — one agent, one brief, run to completion — with a Kubernetes-shaped mapping (Job/Pod/Lease/Namespace) and a single reconcile pass that is safe to run repeatedly, interrupt, or run concurrently with another host.
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a workload kind, changing retry or lease behaviour, or wondering why the DAG is not in the core"
covers:
  - path: prisma/schema.prisma
    sha: 7ddf7cc64bdec434ada83af9301a0d835f9d5af1
  - path: src/controller.ts
    sha: 455fc87adf4f4853fb1ef183b75f3552ccc79e60
  - path: src/db.ts
    sha: db126410edbcadf02b1d7ac200771620d1195d70
generated_at_commit: a659306
last_refreshed: 2026-09-05
related: [decisions/adr-007-workload-scheduler, architecture/runtime-layer, concepts/admission-control]
---

# The Job kind and its controller

hkb takes a **workload** and executes it. A workload has a *kind*, and a kind is a
schema plus a controller that advances it. There is exactly one kind today.

## The mapping, and why it is written into the schema

The header comment of `prisma/schema.prisma` states the Kubernetes correspondence
deliberately, because it is what stops the second kind being invented twice:

| hkb | Kubernetes | Why the analogy holds |
|---|---|---|
| `Job` | Job | spec and status; the controller writes only status |
| `Attempt` | Pod | one execution — the thing that actually dies |
| `Lease` | Lease (`coordination.k8s.io`) | holder identity plus a renew deadline |
| `Board` | Namespace | a name to group jobs under |

The split that matters is **Job vs Attempt**. Nobody creates bare Pods; the atomic
*workload* is a Job, which outlives the Pod it created and makes another if that
Pod dies. So "a worker agent doing a task" is the Job, and each run of it is an
Attempt.

**Where the analogy breaks**, and it breaks in three places worth knowing:

- **Pods are fungible; agent sessions are not.** Kubernetes reschedules an
  equivalent Pod anywhere. An agent session has accumulated context, so *resume is
  not restart* — which is why `lastSessionId` is a column and not a convenience
  (`prisma/schema.prisma`, `Job.lastSessionId`).
- **Pods are cheap; sessions cost money.** Backoff has to be budget-aware.
  `maxBudgetUsd` is on the Job spec for that reason.
- **You can reconcile placement, not result.** "3 replicas running" is checkable
  and restartable. "This card is done" is a judgement about non-deterministic work.
  The controller drives *scheduling* declaratively and stops there — see the gap
  note below.

## One reconcile pass

`reconcile()` (`src/controller.ts`) is the whole control plane for this kind:
reclaim expired leases, read `pending` jobs, compare-and-swap a lease, make the
attempt's checkout, run, read back what landed on the forge, record, release,
tidy. It is a reconciler rather than a queue consumer, which is what makes it safe
to run repeatedly, safe to interrupt, and safe to run while another host runs it.

**A worker never touches the operator's checkout.** `Job.isolate` (default on) makes
a git worktree per attempt on `kb-<jobId>-<k>`, and that is the controller's job
because the SDK has no isolation option for a top-level `query()` —
`isolation: "worktree"` is a parameter of the `Agent` tool and only reaches
subagents (`src/worktree.ts`). The brief gains a fixed protocol on top: commit on
the branch, push, open a **draft** pull request, never merge (`src/brief.ts`). The
human merges, which is what keeps this kind dumb.

A checkout that still holds work is never removed — if the push failed, that
directory is the only copy. It is also what a **resumed** attempt continues in: a
resumed session believes it is in the directory it was working in, so cutting a fresh
`kb-<jobId>-<k>` would wake it on a different branch with none of its own commits.
Resume is not restart, and that has to be true of the filesystem too.

**The claim is the `@@id` on `Lease`.** A second holder's insert fails against the
primary key, and that failure *is* the answer — the loser is recorded in
`report.skipped` and runs nothing (`src/controller.ts`, the `db.lease.create`
try/catch). This is ADR-004's compare-and-swap rule expressed as a table
constraint rather than a ref update.

**Liveness is the lease, not a heartbeat.** A holder that dies without releasing
leaves a lease with a past `expiresAt`; `reclaimExpired()` deletes it, marks the
orphaned attempt `lost`, and returns the Job to `pending` if it has retries left.
The `lost` outcome exists precisely to distinguish "nobody ever reported this"
from a reported failure.

**Where a Job runs is `Board.repoPath`, not anyone's cwd.** One daemon serves every
board on the machine (`~/.hkb/board.db`), so the repository has to be a fact on the
Board — which is also where it belongs, since a Job is inherently single-repo and the
Board's ceilings are already per-repo policy. `deps.cwd` in the controller is the
fallback for a board with no repo. Leadership of a board is a `Controller` row, the
same shape as `Lease`; see `architecture/the-loop`.

**But expiry alone does not authorise a reclaim.** A lapsed lease whose holder is
still a running process on this host is left alone (`src/liveness.ts`,
`reclaimExpired` in `src/controller.ts`) — a lease expires on the wall clock and a
run times out on a monotonic one, and across a laptop suspend those disagree. See
`architecture/the-loop` for the full rule, including why the answer is three-valued
rather than a boolean.

## The decision table is pure

`nextPhase()` (`src/controller.ts`) takes an outcome, the attempt number and the
retry budget, and returns the next phase — with no database and no model in it.
Everything interesting is there:

- `completed` → `succeeded`, not resumable.
- `max_turns` / `max_budget` → retry, and **resumable**: those two left a session
  worth continuing, so `lastSessionId` is kept and the next attempt resumes rather
  than starting cold.
- `refused` → `failed` immediately, never retried. The same brief gets the same
  answer, so a retry only spends money.
- anything else → `crashed`, retried while budget remains.

`maxRetries: 2` means two retries *after* the first go — three attempts in total.

Two outcomes are decided *outside* `nextPhase`, because neither is a fact about how
the work went: `lost` (the reclaim path above) and `stopped` (the operator stopped
the daemon mid-run). **`stopped` does not spend a retry** — the attempt number `k`
still advances, being half the Attempt's primary key, so `reconcile` counts the
retry budget separately from the attempt count (`src/controller.ts`). Without that
split a Job with `maxRetries: 0` could be made permanently unrunnable by nothing
but being turned off.

## Why there is no graph here

A dependency graph is a **second kind** whose controller creates Jobs, the way a
CronJob creates Jobs. Keeping it out is not deferral for its own sake: `Link` and
the `todo/ready/blocked` vocabulary describe a shape this kind cannot use, and a
reactive loop (`/kanban:operate`) has no edges at all while a propose-approve
workload (`/kanban:groom`, `/kanban:decompose`) has no graph. The generic core
should be extracted from two or three working controllers, not guessed from one.

`Phase.suspended` is already in the schema for that reason: groom and decompose
both stop for a human, and "waiting for an answer, resumable, with a proposal
pending" is a state no runtime can report and no session can hold.

## Ceilings, and where they are checked

Three rules decide whether another Job may start, and they are checked **before a
claim and never during a run** — a ceiling that could stop a running worker would
strand its worktree, while one that declines to start another is only a decision
(`gateClaim`, `src/limits.ts`). In order: the board's kill switch, then a
concurrency limit, then a rolling-24-hour USD ceiling.

The budget is judged against what the Job **could** cost — `spent24h + jobBudgetUsd`
— not against what it has cost. A cap that only notices after the money is gone is a
report, not a ceiling.

`gateClaim` is pure, and that is deliberate: every guard in this system that turned
out to be silently inert was inert because nothing tested that it *refused*.

The gate refuses contention it can see, before the compare-and-swap is attempted.
The CAS is still there for the race it cannot see — two hosts that both read "one
slot free" in the same instant — so both paths exist and both are tested.

## Known gaps

- The controller marks a Job `succeeded` when the *session* completed. Whether the
  work is any good is a judgement it does not make; a kind with a reviewer step
  would be where that goes.
