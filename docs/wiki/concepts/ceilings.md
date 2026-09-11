---
title: Ceilings — the three claim-time refusals
summary: The three claim-time refusals (stopped, concurrency, budget), why none of them may stop a running worker, and why committed-but-unspent budget has to be counted.
category: concepts
kind: explanation
audience: [dev, ops]
read_when: "touching gateClaim, adding a limit, changing what a claim is judged against, or explaining why a board claimed nothing"
covers:
  - path: src/limits.ts
    sha: 9c7bdc6c3fa037e11cd8ae52d1803d685d1af918
  - path: src/controller.ts
    sha: a50ac9ee35132bd67b57bb593e9771bd851fe741
  - path: prisma/schema.prisma
    sha: 364793f9a1174875c3bf644257b6d0cbdf94d25e
  - path: src/spec.ts
    sha: a83486dc8471b6e0358af03bafba75fa363c4032
  - path: src/hkb.ts
    sha: eb759e566ef71b11caa34cc0945a6e2ae30958cf
  - path: src/daemon.ts
    sha: d906e507fc36a20dc06070046faa301a23764576
generated_at_commit: ebf564a
last_refreshed: 2026-09-10
related: [architecture/the-board, architecture/the-loop, architecture/job-kind, concepts/leases-and-liveness]
---

# Ceilings — the three claim-time refusals

> A ceiling in hkb is a limit a Job **may not exceed**, as opposed to a default it may freely
> override (`src/spec.ts`). There are exactly three, they are answered by one pure function
> before every claim, and none of them ever touches a run already going. What follows is the
> reasoning that shape encodes — the shape itself is one short file.

## Three refusals, named rather than described

`gateClaim` answers with `{ ok: true }` or with a **named** limit plus operator prose
(`src/limits.ts:22-24`). The names are `stopped`, `concurrency`, `budget`, and the reason they are a
union rather than a message is that the caller has to *act* on them differently
(`src/limits.ts:13-21`):

- **`stopped`** — the board's kill switch is set (`Board.pausedAt`/`pausedBy`,
  `prisma/schema.prisma`). No amount of waiting un-stops it; only a person does.
- **`concurrency`** — every slot on the board is held (`liveLeases >= maxConcurrent`,
  `src/limits.ts:73-80`).
- **`budget`** — the board's rolling ceiling would be crossed by admitting this Job
  (`src/limits.ts:82-100`).

The last two are walls a reconciler can be standing at **because of its own runs in flight**. The
controller's claim loop is exactly that distinction, and it is one line: on a refusal it keeps
waiting for one of its own runs to settle, and it breaks out only when the limit is `stopped` or
when it has nothing in flight to wait for (`src/controller.ts`). A refusal a pass caused
itself is not news to report; it is a reason to wait for a slot (`src/controller.ts`). A pass
that reported *"2 of 2 slots in use"* while both slots were its own would end early and blame the
operator (`src/controller.ts`).

Under the daemon the same wall is met differently, because the runs are not the pass's to wait for:
it hands each one to a supervisor and returns (*architecture/the-loop*). "Its own runs" is then the
supervisor's count for that board (`Supervisor.running`), and a board full of them makes the pass stop
claiming **without a refusal** — no `refused` row, no line — leaving the asking to the pass a run's
end wakes. Written as a refusal it would be a row per tick for as long as a run lasts, about a slot
this very process is using (`src/controller.ts`, `test/daemon.test.ts`).

That branch cannot be written against a message. It needs the name.

The refusal that survives the loop is the pass's **outcome**, not something it did: it lands on
`ReconcileReport.refused` and on an `Event` of kind `refused`, and is deliberately *not* narrated
through `onEvent` — because the daemon asks this same question every 45s and only logs the answer
when it changes, and one narrated line silently undid that dedup (`src/controller.ts`). The
CLI renders it as one `refused: …` line (`src/hkb.ts`).

## Why the gate has no I/O in it

The module says why in its own docblock: **every guard in this system that turned out to be silently
inert was inert because nothing tested that it *refused*** — the admission gate under
`bypassPermissions`, and the worktree base that made a tree full of commits read as empty
(`src/limits.ts:1-11`). Both were guards that returned the permissive answer for the wrong reason,
and both looked fine from every test that exercised the *allowing* case.

A decision with no I/O in it can be tested exhaustively against the refusing case, which is the case
that matters. So `gateClaim` takes a plain record of six facts and returns a verdict; the three
queries that produce those facts live in the controller, where they can be wrong in ways a database
makes visible (`src/controller.ts`). The same reasoning shapes `resolveSpec`, whose failing
case is also silent (`src/spec.ts`), and `nextPhase` (`src/controller.ts`).

## Checked before a claim, never during a run

All three are checked before a claim and never mid-run (`src/limits.ts:9-10`,
`prisma/schema.prisma`). The reason is asymmetric cost: a ceiling that could stop a running
worker would strand its worktree, while one that declines to start another is only a decision.

State the price plainly: **a board taken past its ceiling by work already admitted is not clawed
back.** Stopping a board leaves the run in flight alone, and `hkb stop` says so in as many words
(`src/hkb.ts`; `prisma/schema.prisma`). Lowering `dailyBudgetUsd` mid-flight does not
reach into a running attempt either — the cap was handed to the runtime at spawn and nothing re-reads
it (`prisma/schema.prisma`). The ceiling binds admissions, not executions.

(Shutdown *is* different, and it is not a ceiling: `hkb down` aborts runs through an `AbortSignal`,
because a stop that took thirty minutes to return would not be a stop — `src/controller.ts`.)

## Budget is projected, not historical

The check is:

    spent-in-window + committed-in-flight + what THIS Job could cost  >  the board's ceiling

(`src/limits.ts:85-86`). The third term is the Job's **resolved** cap, not its raw column — the
column is null for every Job that inherits, and a gate judging a null against the ceiling would wave
through the commonest Job there is (`src/controller.ts`, `src/limits.ts:56-60`). The comment
that names the principle: *a cap that only notices after the money is gone is a report, not a
ceiling* (`src/limits.ts:83-84`).

So a board with $2.00 left and a $5.00 Job refuses the Job, having spent nothing on it. That is the
intended behaviour, and it is why the refusal text names all three terms
(`src/limits.ts:94-97`).

## `committedUsd` — why work in flight has to be charged

`spent24h` is summed from `Attempt.costUsd`, which only moves when an attempt **ends**
(`src/controller.ts`). While one Job ran at a time that was harmless. The moment two could
run at once it stopped being: N concurrent claims would each be judged against a spend none of them
had yet contributed to, and the board could commit N × its ceiling in the time the first one takes to
finish (`src/limits.ts:39-43`, `src/controller.ts`).

`committedUsd` closes it by applying the rule the ceiling already used for the claimant — charge what
a run *could* cost — to the runs already going (`src/limits.ts:37-43`).

### It is summed over the frozen cap, not over the spec

The sum is `_sum(Attempt.maxBudgetUsd)` over attempts with no `endedAt`
(`src/controller.ts`) — the cap each live attempt was **claimed under**, written onto the
Attempt row in the same breath as the claim and from the same resolved spec the gate was just judged
against (`src/controller.ts`). It is `Float`, never null (`prisma/schema.prisma`), which
is precisely the difference from `Job.maxBudgetUsd`, which is `Float?` (`prisma/schema.prisma`) —
**do not swap them**: the Job's column is nullable so board defaults can mean something; the
Attempt's cannot be, because another process reads it about someone else's run.

Re-resolving instead — per open attempt, or by joining the board's defaults into that one query — is
the tempting shortcut and it is wrong. The full argument, with all three options weighed and the
Kubernetes parallel, is the doc comment on the column (`prisma/schema.prisma`); distilled:

- The two answers **only differ when a board's `defaultMaxBudgetUsd` changes while work is in
  flight** — which is exactly the moment a ceiling is being leaned on.
- There they are wrong in the **admitting** direction when the default is *lowered*: three live runs
  that may still spend $3.00 total get charged $0.30, and the gate admits work that takes the board
  past its ceiling — reintroducing the exact failure `committedUsd` exists to prevent
  (`prisma/schema.prisma`).
- Raising the default is wrong in the harmless direction (over-charging, so the gate merely stalls) —
  but a ceiling that is only correct when nobody edits the board is not a ceiling.
- Kubernetes puts it one table over: admission stamps a Pod with the limits a LimitRange supplied,
  the scheduler then reads the Pod and never the namespace, and a LimitRange edited afterwards does
  not rewrite what is running (`prisma/schema.prisma`). An Attempt is this system's Pod.

Only the budget is frozen. `maxTurns`, `model` and `effort` are read once by the run itself and
nothing outside it asks (`prisma/schema.prisma`).

The frozen number also pays off away from the gate: `hkb retry` refuses to re-queue a budget-capped
Job under a cap that is not larger, and it compares against what the failed attempt *actually ran
under* rather than today's resolution — the two differ when the board was raised after the failure,
and there the retry genuinely buys something (`retryJob`, `src/transitions.ts:322-342`).

**A known over-charge, in the safe direction:** an orphaned attempt whose holder died still has no
`endedAt`, so it is counted as committed until the reclaim at the top of the next pass closes it
(`src/controller.ts`). Whether a holder is really gone is the lease question, not this one —
see *concepts/leases-and-liveness*.

## The window is rolling, not a day

`windowStart(now)` is `now - 24h` (`src/limits.ts:105-106`). The one-line reason is on the function
and on the column: **not a calendar day, because there is no timezone to get wrong**
(`prisma/schema.prisma`). There is no midnight, no reset, and no locale in the ceiling. Spend
ages out of the window continuously, which is why the refusal offers *"wait for the window to roll"*
as a real option (`src/limits.ts:89-91`). `hkb up --status` reads the same window from the same
function, so the status cannot disagree with the refusal it is meant to explain
(`src/daemon.ts`).

Attempts enter the window by `startedAt` (`src/controller.ts`).

## Where each ceiling is set, and by whom

All three live on the `Board` — the namespace — because they are already per-repo facts
(`prisma/schema.prisma`), and all three are the operator's to set:

| Ceiling | Column | Operator command | In the refusal |
|---|---|---|---|
| stopped | `pausedAt`/`pausedBy` | `hkb stop` / `hkb start` (`src/hkb.ts`) | `` `hkb start` to resume `` (`src/limits.ts:69`) |
| concurrency | `maxConcurrent`, default 1 | `hkb boards set <slug> --max-concurrent <n>` (`src/hkb.ts`) | raise it, or wait for a run to finish (`src/limits.ts:77-78`) |
| budget | `dailyBudgetUsd`, null = no ceiling | `hkb boards set <slug> --daily-budget <usd>\|none` (`src/hkb.ts`) | raise it, or wait for a run or the window (`src/limits.ts:87-97`) |

Two edges worth knowing. `--max-concurrent 0` **drains** a board without stopping it — a distinct
state from the kill switch, and a deliberate one (`prisma/schema.prisma`, and the `--max-concurrent` block in `hkb boards set`).
And `--daily-budget` accepts the literal `none` to clear the ceiling, because "no ceiling" and "a
ceiling of zero" are different configurations (`src/hkb.ts`).

## The fourth ceiling, and it is the only one that is not the board's

`Job.activeDeadlineSeconds` bounds **how long a Job's sessions may actually run**, summed across
every attempt — Kubernetes' `JobSpec.activeDeadlineSeconds`. It belongs on this page because it
behaves like the three above and not like a default: a Job may set it, but once past it, nothing the
Job says gets it another attempt.

**One deliberate deviation from the map, and the field's own name is the argument for it.**
Kubernetes measures from the Job's `startTime`, so a `Pending` Pod burns the clock — tolerable
there, where a Pod pends for seconds while the scheduler finds a node. An hkb Job pends for *hours*:
at `maxConcurrent: 1`, the shipped default, a Job whose first attempt crashed at 09:00 may not be
claimed again until 14:00. Counting that would fail a Job that used five minutes of compute because
the board was busy, which bounds luck rather than cost. So `activeMs` sums the attempts' own
durations, which is what *active* means (`src/limits.ts`).

It is checked **twice, and the first one is the one that saves money**: before a claim, so a Job
already over is refused before a slot or a session is spent on it; and again after the
run, because the run itself counts. A ceiling that only refuses after the money is gone is not a
ceiling.

An attempt that finished cleanly still has everything it **declared** collected before the verdict
lands — the exports, results and artifacts are gathered first and the deadline is applied last
(*architecture/the-loop* has the whole order). The
work was paid for; discarding a report because a clock expired thirty seconds earlier loses real
output and buys nothing. The Job still ends `deadline_exceeded`.

**It outranks the retry budget**, and *that* half is Kubernetes' rule rather than a choice made here:
*"once a Job reaches activeDeadlineSeconds, all of its running Pods are terminated and the Job
status will become type: Failed with reason: DeadlineExceeded."* ADR-016 decision 4 says the failure
semantics are Kubernetes' to decide, so `nextPhase` reads this **before** the completion check and
before `completed` — an attempt that finished cleanly after the Job's clock ran out still ended a
Job nobody may spend more wall time on. Ordering it lower would make the deadline mean "unless the
last attempt happened to work", which is a race with the scheduler rather than a ceiling.

The decision is pure and lives here rather than in the controller: `deadlineExceeded(activeMs,
seconds)` in `src/limits.ts`, with `activeMs(attempts, now)` beside it summing the attempts' own
durations and the controller supplying the rows and the clock. An attempt still open is counted up
to `now`, which is what makes the claim-time guard and the post-run verdict agree.

Null is the shipped default — no Job-wide deadline — which is Kubernetes' default too. A default
that silently ends work is not a default.

### Its per-attempt twin, which is a default rather than a ceiling

`Job.attemptDeadlineSeconds` (Kubernetes' `template.spec.activeDeadlineSeconds`) bounds **one
session**. A run that outruns it is stopped and the attempt is **retried** like any other failure —
`timed_out` is resumable and burns a retry. So it shapes work rather than ending it, resolves three
deep like every other default (`src/spec.ts`), and is frozen onto the `Attempt` at claim time so
raising it later cannot rewrite what stopped an earlier one.

The lease is derived from it — `attemptDeadlineSeconds + LEASE_GRACE_MS` — so a longer clock
lengthens the lease by exactly as much and a 60-minute Job is not reclaimed at 35
(*concepts/leases-and-liveness*).

Both are set with `hkb new`, `hkb job set` and `hkb boards set`, in **seconds**, and both refuse
zero and negatives by name: Kubernetes says the value must be a positive integer, and `0` reads to a
person as "no deadline" while meaning "already expired" to the arithmetic. Until card #53 neither
had a flag at all — `Job.timeoutMs` was non-nullable with a database default, so the only way to
change a Job's wall clock was `update Job set timeoutMs` in SQL.

`--max-budget` on `hkb boards set` is **not** a ceiling despite the neighbouring flags: it writes
`defaultMaxBudgetUsd`, a default a Job may override (`src/hkb.ts`,
`prisma/schema.prisma`). The per-Job cap resolves three deep — the Job's own value, the
board's default, then the built-in $1 (`src/spec.ts`).

## A Job that spends its own cap is not retried

Distinct from the board ceilings above, and the one that most often looks like a bug: when a run
stops at its own per-attempt cap the outcome is `max_budget`, and `nextPhase` does **not** treat it
as a transient fault — it fails the Job even with retries left (`src/controller.ts`).

The reason is that a retry gets the same cap and stops in the same place, at the same price. Resuming
helps only when the remaining work is smaller than the cap; nothing checks that, and when it is false
the retry builds the identical wall at full price. The comment records the measured case: job #6
spent $2.05, was retried, spent $2.02 stopping in the same place, and its third attempt was refused
by the board's daily ceiling — $4.07 for nothing (`src/controller.ts`). Raising a cap is a
change to the Job's **spec**, which belongs to whoever filed it and never to the controller.

So the Job fails carrying advice instead: what it spent, that it was not retried, and the exact
`hkb retry <id> --max-budget <usd>` that raises it (`src/controller.ts`). It stays
`resumable`, which is what keeps `lastSessionId` so that the deliberate retry continues rather than
starting cold (`src/controller.ts`).

## For ops

- `hkb up --status` prints, per board, `STOPPED …` if the kill switch is set, then
  `limits  <n> of <m> slots running, $X of $Y spent in 24h` (`src/hkb.ts`). Those are the
  same four facts a refusal cites (`src/daemon.ts`).
- "The daemon is up but nothing is claimed" is answered by that line before it is answered anywhere
  else — a stopped board with a healthy daemon otherwise reads as fine (`src/hkb.ts`).
- The status line reports **spent**, not the projection the gate actually charges, so a board can be
  refused on budget while its status shows headroom. Filed in `FINDINGS.md`.
- `hkb log` carries a `refused` event per refusal, with the same prose
  (`src/controller.ts`).

## Related

- [The board](../architecture/the-board.md) — the schema as a model, including what else is frozen
  onto an Attempt and why nearly every spec column is nullable.
- [The loop](../architecture/the-loop.md) — the reconcile pass these checks sit inside, and why an
  operator stop is its own outcome.
- [Leases and liveness](../concepts/leases-and-liveness.md) — what the `liveLeases` count is counting,
  and why a lapsed lease is evidence and not proof.
- [The Job kind](../architecture/job-kind.md) — the retry decision this page's last section is one
  branch of.
