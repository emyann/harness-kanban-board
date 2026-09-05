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
    sha: 4bec802ac597bdbba089915e9ddb4124acc8394f
  - path: src/db.ts
    sha: db126410edbcadf02b1d7ac200771620d1195d70
generated_at_commit: f0b5bbd
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

**By default a worker works on a branch, not in the operator's checkout.**
`Job.isolate` (default on) makes a git worktree per attempt on `kb-<jobId>-<k>`,
and that is the controller's job because the SDK has no isolation option for a
top-level `query()` — `isolation: "worktree"` is a parameter of the `Agent` tool
and only reaches subagents (`src/worktree.ts`). The brief gains a fixed protocol on
top: commit on the branch, push, open a **draft** pull request, never merge
(`src/brief.ts`). The human merges, which is what keeps this kind dumb.

`isolate: false` is a supported way to run, not a read-only escape hatch — a Job
whose deliverable is an uncommitted change in the operator's working tree is what
it is for. What it gives up is the branch and everything that hangs off it: no
diff, no pull request, nothing to revert, and no safety at `maxConcurrent > 1`,
where two un-isolated attempts edit the same files with no lock between them. It
also changes what the Job's subagents may do — a workload with no worktree of its
own cannot give one to a subagent, so admission refuses a spawn that asks for one
(*concepts/admission-control*).

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
- `max_turns` → retry, and **resumable**: it left a session worth continuing, so
  `lastSessionId` is kept and the next attempt resumes rather than starting cold.
- `refused` → `failed` immediately, never retried. The same brief gets the same
  answer, so a retry only spends money.
- `max_budget` → `failed` immediately as well, and for the same reason one level
  down: the same brief gets the same **cap**. Resuming is right in principle — the
  next attempt continues where this one stopped — but it only helps when the work
  left is smaller than the cap, and nothing checks that. Measured at the shipped
  defaults: job #6 spent $2.05, was retried, spent $2.02 stopping in the same place,
  and its third attempt was refused by the board's daily ceiling. $4.07 for nothing.
  Raising the cap is a change to the Job's **spec**, which belongs to whoever filed
  it and never to the controller, so the Job stops here with `lastError` naming the
  cap and the command that changes it. It stays **resumable**, which is what keeps
  `lastSessionId`: `kb retry <id> --max-budget <usd>` re-queues it with a bigger cap,
  records the raise on the event stream, and continues the session rather than
  re-buying what the first attempt already paid for.
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

## The two phases a human writes

`done` and `cancelled` are the only states an operator asks for directly (`kb done`,
`kb cancel`, `src/kb.ts`). They exist because the machinery cannot conclude every Job
it starts: a Job whose pull request was reviewed and merged while it sat `pending` on
a spent budget is finished, and nothing observable says so — the next reconcile would
spend the whole cap redoing merged work. The only verb that used to stop it was
`kb rm`, which deletes the Job, its attempts and its events, so the choice was
between re-running landed work and destroying the record of it.

They are **not** `suspended`. That state is a *wait* — something is expected to happen
and then the Job goes on — so `kb ls --phase suspended` is an inbox, and a Job
concluded by hand would sit in it for ever. The reasons even read in opposite tenses:
`suspendedFor` is what someone must still do, `endedFor` is what already happened.

They are **two** values rather than one `ended` plus a column, because this enum
already splits its terminal states by what happened (`succeeded`, `failed`), and the
difference between "the PR was merged" and "we do not want this" is the entire content
of the operator's decision.

Both are recorded transitions, never silent updates: an Event whose actor is a person
rather than a `host/pid` holder, carrying the phase it moved from and the reason. Both
refuse a Job that is currently leased — that is a running worker — with the same rule
and the same way out as `kb rm`.

## Ceilings, and where they are checked

Three rules decide whether another Job may start, and they are checked **before a
claim and never during a run** — a ceiling that could stop a running worker would
strand its worktree, while one that declines to start another is only a decision
(`gateClaim`, `src/limits.ts`). In order: the board's kill switch, then a
concurrency limit, then a rolling-24-hour USD ceiling.

The budget is judged against what the Job **could** cost — `spent24h + committedUsd +
jobBudgetUsd` — not against what it has cost. A cap that only notices after the money
is gone is a report, not a ceiling. `committedUsd` is the same rule applied to the runs
already going: an attempt with no `endedAt` has reported no cost, so without it a board
running several Jobs at once could commit its ceiling several times over in the time the
first one takes to finish.

## `maxConcurrent` is a parallelism setting

One reconcile pass starts up to `maxConcurrent` Jobs and waits for them together. For one
release it did not: the loop awaited each run in turn, so the ceiling only ever bound
*between* reconcilers, and an operator raising it from 1 to 2 got exactly what they had.

The cheap fix was to rename it an admission ceiling and document that throughput comes
from running more reconcilers. That is not the Kubernetes shape, and the giveaway is one
table over: `Controller` is keyed `@@id(boardId)`, so `acquireBoard` elects **one leader
per board** and a second daemon on the same board is refused. Kubernetes scales controllers
for availability, never throughput; the throughput knob on a Kubernetes Job is
`parallelism`, honoured by starting that many Pods. "Run more reconcilers" would have
documented something the leader election forbids.

What that costs, all of it in `src/controller.ts`:

- **Admission stays serial.** The gate, the compare-and-swap and the worktree happen one
  Job at a time; only the run overlaps. Two claims can never read the same `liveLeases`.
- **A ceiling the pass is itself filling is not a refusal.** It waits for one of its own
  runs to end and asks again. `ClaimLimit` (`src/limits.ts`) is what tells "somebody else
  holds the slots" apart from "we do" — a stopped board is never waited out.
- **Every operator-facing line is tagged `#<job>`.** Indentation grouped lines under a
  claim, which only reads as grouping while one Job is speaking. The daemon already tags
  per board, so a busy log reads `[board] #12 …`.
- **Shutdown stops all of them.** One `AbortSignal` reaches every run in flight, and the
  pass does not return until each has recorded its own attempt — each `stopped`, which
  spends no retry.

`gateClaim` is pure, and that is deliberate: every guard in this system that turned
out to be silently inert was inert because nothing tested that it *refused*.

The gate refuses contention it can see, before the compare-and-swap is attempted.
The CAS is still there for the race it cannot see — two hosts that both read "one
slot free" in the same instant — so both paths exist and both are tested.

## Known gaps

- The controller marks a Job `succeeded` when the *session* completed. Whether the
  work is any good is a judgement it does not make; a kind with a reviewer step
  would be where that goes.
