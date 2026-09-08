---
title: The Job kind and its controller
summary: The first and only workload kind — one agent, one brief, run to completion — with a Kubernetes-shaped mapping (Job/Pod/Lease/Namespace) and a single reconcile pass that is safe to run repeatedly, interrupt, or run concurrently with another host.
category: architecture
kind: explanation
audience: [dev]
read_when: "adding a workload kind, changing retry or lease behaviour, or wondering why the DAG is not in the core"
covers:
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
  - path: src/controller.ts
    sha: 4f641c68ffb6006f4b8c393723bfdc2f0edf9fbd
  - path: src/db.ts
    sha: c759afb94b34e93ecefdb0384e06924bd772e836
generated_at_commit: d2d7f31
last_refreshed: 2026-09-08
related: [decisions/adr-007-workload-scheduler, architecture/runtime-layer, concepts/admission-control, features/rebase-and-verify, features/check, architecture/transitions]
---

# The Job kind and its controller

hkb takes a **workload** and executes it. A workload has a *kind*, and a kind is a
schema plus a controller that advances it. There is exactly one kind today.

## The mapping, and why it is written into the schema

The header comment of `prisma/schema.prisma` states the Kubernetes correspondence
deliberately, because it is what stops the second kind being invented twice:

| hkb | Kubernetes | Why the analogy holds |
|---|---|---|
| `Job` | Job | spec and status; the controller writes only status — and creates rows, but only from an approved proposal (`features/proposals`) |
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

The same insert now carries a second constraint doing the same job for a different
question. `Lease.slot` is the **concurrency ordinal** — the lowest non-negative
integer no other live lease holds, machine-wide — and it is `@unique`, so two
daemons that read the same set and compute the same free number cannot both take
it. The loser lands in the same catch, which is why adding it needed no new
handling: a claim that fails for either reason is a claim somebody else got, and
the next pass picks the Job up. It exists because a run needs to know *which of the
concurrent workers it is* — for a port, a display number, a database name — and
`jobId` is unique but unbounded. Kubernetes gives every Pod an IP and never asks;
hkb's workers share one machine. Frozen onto `Attempt.slot`, so it survives the
release and a past collision stays diagnosable.

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
  `lastSessionId`: `hkb retry <id> --max-budget <usd>` re-queues it with a bigger cap,
  records the raise on the event stream, and continues the session rather than
  re-buying what the first attempt already paid for.
- anything else → `crashed`, retried while budget remains.
- a **failed check** → `check_failed`, and it is the branch that outranks `completed`
  (`features/check`, ADR-016 §3). The runtime cannot report this outcome — as far as it is
  concerned the session ended — so the controller runs the command and hands the result back
  in: transient, retried while retries remain, and always **resumable**, because the session
  that wrote the code the check refused is the one worth continuing. It is the only argument
  `nextPhase` takes that is not a fact the runtime reported.

`maxRetries: 2` means two retries *after* the first go — three attempts in total.

Five outcomes are decided *outside* `nextPhase`, because none of them is a fact about
how the work went — the count was two when this page was written, the declared inputs
and outputs added a pair, and rebase-and-verify added the fifth:

- `lost` — the reclaim path above; nobody ever reported this attempt.
- `stopped` — the operator stopped the daemon mid-run.
- `no_output` — the session ended and something the Job **declared** is not there
  (ADR-008). The runtime thinks it succeeded; the board disagrees. It is also the outcome
  for a **proposal** the validator refused: the file arrived and was not what was promised
  (`features/proposals`).
- `no_input` — the run never started, because something the Job declared as an
  **input** could not be read (`src/inputs.ts`). The mirror of `no_output` and the
  cheap side of it: no session, no tokens. Terminal and not retried, because the same
  read fails identically next time.
- `conflicted` — the session ended, the work is real, and the branch no longer replays
  onto the base it will be merged into (`src/rebase.ts`, *features/rebase-and-verify*).
  Separate from `no_output` because the fault is in neither the work nor the spec: the
  base moved. Not retried either, and for a sharper reason — a resumed worker may not
  force-push, so it has no move a human does not have to make first.

`no_output` and `no_input` are the two that make `succeeded` mean more than "a session
ended" for FILES; `check_failed` above is the same question asked for behaviour.
**`stopped` does not spend a retry** — the attempt number `k`
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

Since then, **half of that second kind has arrived without being one.** A `--propose` Job
creates Jobs — the controller does, from an approved proposal — and it does so with no
ordering between them, which ADR-011 decision 6 reads as CronJob-shaped rather than
DAG-shaped (`features/proposals`). What is still missing is the edge: the graph is not
"creation by a controller", it is *ordering*, and nothing here has any.

## Triage: the phase before the queue

`pending` means **wants to run** — the claim query asks for it by name, so a daemon takes it. That
left nowhere to put *"I noticed this, do not run it yet"*, and the available answers were all board-wide
ones to a per-Job question: stop the board, or drain it to zero concurrency. So the choice was to file
work nobody had decided on, or to lose the note.

`Phase.triage` is that place, and it is the **only human-written phase that is an entry rather than an
exit**. Three surfaces, one concept:

| | |
|---|---|
| `hkb new "<what you saw>" --triage` | capture. The brief is optional here — the name *is* the brief until somebody decides what the work is, because a note that demanded a brief would not get written down |
| `hkb queue <id> ["<brief>"]` | it is work after all. The brief is rewritable at exactly this moment and no other: the note said what you saw, the brief has to say what to do |
| `hkb triage <id>` | the way back, for a Job filed in haste. Without it the only exit is `hkb cancel`, which is terminal and throws the note away with the decision |

**The guard costs nothing, which is why it is tested.** A Job in triage is never claimed because
`reconcile` asks for `phase: 'pending'` and always did — so the feature is free and the test is the
only thing standing between it and a query that changes. `test/controller.test.ts` runs the board to
rest and asserts the noted Job has no attempt and no cost.

ADR-011 named this gap and left it open. Half of it is closed: an **operator** now has somewhere to put
an undecided item. The **inbound** half — something arriving from outside that nobody has judged — is
still open, and is a different problem with a different authorisation model.

## The two phases a human writes

`done` and `cancelled` are the only states an operator asks for directly (`hkb done`,
`hkb cancel`, `src/hkb.ts`). They exist because the machinery cannot conclude every Job
it starts: a Job whose pull request was reviewed and merged while it sat `pending` on
a spent budget is finished, and nothing observable says so — the next reconcile would
spend the whole cap redoing merged work. The only verb that used to stop it was
`hkb rm`, which deletes the Job, its attempts and its events, so the choice was
between re-running landed work and destroying the record of it.

They are **not** `suspended`. That state is a *wait* — something is expected to happen
and then the Job goes on — so `hkb ls --phase suspended` is an inbox, and a Job
concluded by hand would sit in it for ever. The reasons even read in opposite tenses:
`suspendedFor` is what someone must still do, `endedFor` is what already happened.

The reconcile report carries that inbox too: a suspended Job goes in its own `suspended` list rather
than into `retrying`, and `hkb run` ends with *"N waiting for you"* (`src/controller.ts`,
`src/hkb.ts`). It was counted as a retry until a live run printed `1 to retry` about a Job nothing
was ever going to pick up — the one state only a person can clear, reported as the one thing that
needs nobody.

They are **two** values rather than one `ended` plus a column, because this enum
already splits its terminal states by what happened (`succeeded`, `failed`), and the
difference between "the PR was merged" and "we do not want this" is the entire content
of the operator's decision.

Both are recorded transitions, never silent updates: an Event whose actor is a person
rather than a `host/pid` holder, carrying the phase it moved from and the reason. Both
refuse a Job that is currently leased — that is a running worker — with the same rule
and the same way out as `hkb rm`.

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

## Defaults, and why they are not ceilings

A Board carries **spec defaults** beside its ceilings: `defaultModel`, `defaultEffort`,
`defaultMaxTurns`, `defaultMaxBudgetUsd`, `defaultMaxRetries`, `defaultAllowedTools`,
`defaultPluginPaths` and `defaultGuide`. A board that runs cheap, high-volume work can say so once
instead of on every `hkb new`.

> This list has gone stale three times. The controller used to read the Board through a hand-listed
> `select` that had the same problem, and `defaultPluginPaths` was missing from it — so ADR-012's
> board-level grant reached no worker at all and nothing said so. It reads the whole row now, and
> `test/controller.test.ts` asserts on the whole resolved spec rather than one field at a time.

The last two are the ones that are a *surface* rather than a number, and they point in opposite
directions. `defaultAllowedTools` narrows what a Job may **do**, and it is a board default a Job may
**widen**: the narrowing itself is enforced — `src/admission.ts` denies anything absent from the
resolved list — but what a board sets there is a default, not a ceiling.
`defaultPluginPaths` widens what a Job may **read**, granting the directories whose skills a worker
sees (*decisions/adr-012-skills-by-grant-not-by-settings*), and `defaultGuide` names the document it
is told to **follow** (*decisions/adr-013-the-guide-is-read-not-loaded*). None of the three touches
the others: a granted skill is prose, a guide is prose, and every tool either might suggest is still
refused unless `allowedTools` admits it.

They are separate columns from the ceilings, and the reason is who wins. A **ceiling** is a
limit a Job may not exceed, enforced in `gateClaim`. A **default** is a value a Job may
freely override, resolved in `src/spec.ts`, in three levels:

1. the Job's own value wins — `hkb new --model …`
2. the Board's default fills a null — `hkb boards set <slug> --model …`
3. the built-in is the last resort — `BUILT_IN` in `src/spec.ts`

That order only works if "unset" is legible, which is why `Job.maxTurns`, `maxBudgetUsd`
and `maxRetries` are nullable with no database default. A column that defaults to `20`
cannot tell *"the operator asked for 20"* from *"the operator said nothing"*, and under
that ambiguity every Job ever filed outranks its board — which is not a default at all.

`resolveSpec` returns each value tagged with where it came from, and `hkb show` prints the
tag. A spec you cannot trace is worse than one you have to repeat.

### The cap is frozen onto the Attempt

`committedUsd` above sums, over every attempt still open, what those runs could still cost.
Once `Job.maxBudgetUsd` is nullable that sum cannot read the Job's column — it is null for
exactly the Jobs that inherit their cap. Three ways out: resolve the spec per open attempt,
join the board's defaults into that query, or **freeze the resolved cap onto the Attempt at
claim time**. It is frozen, in `Attempt.maxBudgetUsd`, `Float` and not nullable.

The first two differ from the third only when a board's default changes while work is in
flight, and there they are both wrong. A live run is bound by the number handed to the
runtime when it was spawned; nothing re-reads it. So an operator who lowers
`defaultMaxBudgetUsd` mid-flight would have told the gate that three live runs have
committed a tenth of what they may actually still spend — and the gate would admit work
that takes the board past its ceiling, which is the exact failure `committedUsd` exists to
prevent.

It is also the shape one table over. Admission stamps a Pod with the limits a LimitRange
supplied; the scheduler then reads the Pod, and a LimitRange edited afterwards does not
rewrite what is already running. An Attempt is this system's Pod, and it already records
what *happened* — `costUsd`, `sessionId`, `branch`, `outcome` — rather than what is
configured.

The cost is that `hkb show` reports the frozen number for a past attempt rather than what
resolution says today. That is the feature: an attempt that stopped on `max_budget` is
only legible against the cap that actually stopped it, and `hkb retry`'s refusal — "the same
cap stops it in the same place" — is a claim about the failed attempt that no amount of
re-resolving can recover once the board has moved on. `hkb retry` therefore reads both: the
frozen cap for what happened, and today's resolution for what a retry would get, so a board
default raised after the failure is a real raise and is allowed through.

Only the budget is frozen. `maxTurns`, `model` and `effort` are read once, by the run
itself; nothing outside that run asks about them while it is live.

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
