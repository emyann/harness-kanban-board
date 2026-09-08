---
title: Ceilings — the three claim-time refusals
summary: The three claim-time refusals (stopped, concurrency, budget), why none of them may stop a running worker, and why committed-but-unspent budget has to be counted.
category: concepts
kind: explanation
audience: [dev, ops]
read_when: "touching gateClaim, adding a limit, changing what a claim is judged against, or explaining why a board claimed nothing"
covers:
  - path: src/limits.ts
    sha: 61b65c43e2fd7c28f952c403e02d073ca9907561
  - path: src/controller.ts
    sha: 4f641c68ffb6006f4b8c393723bfdc2f0edf9fbd
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
  - path: src/spec.ts
    sha: d3fba5cc6bb9a1cebeea496bf445f4165c3cecbc
  - path: src/hkb.ts
    sha: 45c571d3e74827c4648f2b13f16a5192863fe727
  - path: src/daemon.ts
    sha: 114665116363d28f7aeecf23e293f0fff050eadc
generated_at_commit: d2d7f31
last_refreshed: 2026-09-08
related: [architecture/the-board, architecture/the-loop, architecture/job-kind, concepts/leases-and-liveness]
---

# Ceilings — the three claim-time refusals

> A ceiling in hkb is a limit a Job **may not exceed**, as opposed to a default it may freely
> override (`src/spec.ts:12-14`). There are exactly three, they are answered by one pure function
> before every claim, and none of them ever touches a run already going. What follows is the
> reasoning that shape encodes — the shape itself is one short file.

## Three refusals, named rather than described

`gateClaim` answers with `{ ok: true }` or with a **named** limit plus operator prose
(`src/limits.ts:22-24`). The names are `stopped`, `concurrency`, `budget`, and the reason they are a
union rather than a message is that the caller has to *act* on them differently
(`src/limits.ts:13-21`):

- **`stopped`** — the board's kill switch is set (`Board.pausedAt`/`pausedBy`,
  `prisma/schema.prisma:113-116`). No amount of waiting un-stops it; only a person does.
- **`concurrency`** — every slot on the board is held (`liveLeases >= maxConcurrent`,
  `src/limits.ts:73-80`).
- **`budget`** — the board's rolling ceiling would be crossed by admitting this Job
  (`src/limits.ts:82-100`).

The last two are walls a reconciler can be standing at **because of its own runs in flight**. The
controller's claim loop is exactly that distinction, and it is one line: on a refusal it keeps
waiting for one of its own runs to settle, and it breaks out only when the limit is `stopped` or
when it has nothing in flight to wait for (`src/controller.ts:627-632`). A refusal a pass caused
itself is not news to report; it is a reason to wait for a slot (`src/controller.ts:76-78`). A pass
that reported *"2 of 2 slots in use"* while both slots were its own would end early and blame the
operator (`src/controller.ts:587-590`).

That branch cannot be written against a message. It needs the name.

The refusal that survives the loop is the pass's **outcome**, not something it did: it lands on
`ReconcileReport.refused` and on an `Event` of kind `refused`, and is deliberately *not* narrated
through `onEvent` — because the daemon asks this same question every 45s and only logs the answer
when it changes, and one narrated line silently undid that dedup (`src/controller.ts:635-647`). The
CLI renders it as one `refused: …` line (`src/hkb.ts:905`).

## Why the gate has no I/O in it

The module says why in its own docblock: **every guard in this system that turned out to be silently
inert was inert because nothing tested that it *refused*** — the admission gate under
`bypassPermissions`, and the worktree base that made a tree full of commits read as empty
(`src/limits.ts:1-11`). Both were guards that returned the permissive answer for the wrong reason,
and both looked fine from every test that exercised the *allowing* case.

A decision with no I/O in it can be tested exhaustively against the refusing case, which is the case
that matters. So `gateClaim` takes a plain record of six facts and returns a verdict; the three
queries that produce those facts live in the controller, where they can be wrong in ways a database
makes visible (`src/controller.ts:592-625`). The same reasoning shapes `resolveSpec`, whose failing
case is also silent (`src/spec.ts:16-20`), and `nextPhase` (`src/controller.ts:164-168`).

## Checked before a claim, never during a run

All three are checked before a claim and never mid-run (`src/limits.ts:9-10`,
`prisma/schema.prisma:118-119`). The reason is asymmetric cost: a ceiling that could stop a running
worker would strand its worktree, while one that declines to start another is only a decision.

State the price plainly: **a board taken past its ceiling by work already admitted is not clawed
back.** Stopping a board leaves the run in flight alone, and `hkb stop` says so in as many words
(`src/hkb.ts:1201-1202`; `prisma/schema.prisma:113-114`). Lowering `dailyBudgetUsd` mid-flight does not
reach into a running attempt either — the cap was handed to the runtime at spawn and nothing re-reads
it (`prisma/schema.prisma:466-469`). The ceiling binds admissions, not executions.

(Shutdown *is* different, and it is not a ceiling: `hkb down` aborts runs through an `AbortSignal`,
because a stop that took thirty minutes to return would not be a stop — `src/controller.ts:127-131`.)

## Budget is projected, not historical

The check is:

    spent-in-window + committed-in-flight + what THIS Job could cost  >  the board's ceiling

(`src/limits.ts:85-86`). The third term is the Job's **resolved** cap, not its raw column — the
column is null for every Job that inherits, and a gate judging a null against the ceiling would wave
through the commonest Job there is (`src/controller.ts:622-624`, `src/limits.ts:56-60`). The comment
that names the principle: *a cap that only notices after the money is gone is a report, not a
ceiling* (`src/limits.ts:83-84`).

So a board with $2.00 left and a $5.00 Job refuses the Job, having spent nothing on it. That is the
intended behaviour, and it is why the refusal text names all three terms
(`src/limits.ts:94-97`).

## `committedUsd` — why work in flight has to be charged

`spent24h` is summed from `Attempt.costUsd`, which only moves when an attempt **ends**
(`src/controller.ts:595-598`). While one Job ran at a time that was harmless. The moment two could
run at once it stopped being: N concurrent claims would each be judged against a spend none of them
had yet contributed to, and the board could commit N × its ceiling in the time the first one takes to
finish (`src/limits.ts:39-43`, `src/controller.ts:79-81`).

`committedUsd` closes it by applying the rule the ceiling already used for the claimant — charge what
a run *could* cost — to the runs already going (`src/limits.ts:37-43`).

### It is summed over the frozen cap, not over the spec

The sum is `_sum(Attempt.maxBudgetUsd)` over attempts with no `endedAt`
(`src/controller.ts:609-612`) — the cap each live attempt was **claimed under**, written onto the
Attempt row in the same breath as the claim and from the same resolved spec the gate was just judged
against (`src/controller.ts:696-702`). It is `Float`, never null (`prisma/schema.prisma:491`), which
is precisely the difference from `Job.maxBudgetUsd`, which is `Float?` (`prisma/schema.prisma:221`) —
**do not swap them**: the Job's column is nullable so board defaults can mean something; the
Attempt's cannot be, because another process reads it about someone else's run.

Re-resolving instead — per open attempt, or by joining the board's defaults into that one query — is
the tempting shortcut and it is wrong. The full argument, with all three options weighed and the
Kubernetes parallel, is the doc comment on the column (`prisma/schema.prisma:446-489`); distilled:

- The two answers **only differ when a board's `defaultMaxBudgetUsd` changes while work is in
  flight** — which is exactly the moment a ceiling is being leaned on.
- There they are wrong in the **admitting** direction when the default is *lowered*: three live runs
  that may still spend $3.00 total get charged $0.30, and the gate admits work that takes the board
  past its ceiling — reintroducing the exact failure `committedUsd` exists to prevent
  (`prisma/schema.prisma:467-473`).
- Raising the default is wrong in the harmless direction (over-charging, so the gate merely stalls) —
  but a ceiling that is only correct when nobody edits the board is not a ceiling.
- Kubernetes puts it one table over: admission stamps a Pod with the limits a LimitRange supplied,
  the scheduler then reads the Pod and never the namespace, and a LimitRange edited afterwards does
  not rewrite what is running (`prisma/schema.prisma:474-479`). An Attempt is this system's Pod.

Only the budget is frozen. `maxTurns`, `model` and `effort` are read once by the run itself and
nothing outside it asks (`prisma/schema.prisma:485-489`).

The frozen number also pays off away from the gate: `hkb retry` refuses to re-queue a budget-capped
Job under a cap that is not larger, and it compares against what the failed attempt *actually ran
under* rather than today's resolution — the two differ when the board was raised after the failure,
and there the retry genuinely buys something (`src/hkb.ts:989-1011`).

**A known over-charge, in the safe direction:** an orphaned attempt whose holder died still has no
`endedAt`, so it is counted as committed until the reclaim at the top of the next pass closes it
(`src/controller.ts:599-603`). Whether a holder is really gone is the lease question, not this one —
see *concepts/leases-and-liveness*.

## The window is rolling, not a day

`windowStart(now)` is `now - 24h` (`src/limits.ts:105-106`). The one-line reason is on the function
and on the column: **not a calendar day, because there is no timezone to get wrong**
(`prisma/schema.prisma:112`). There is no midnight, no reset, and no locale in the ceiling. Spend
ages out of the window continuously, which is why the refusal offers *"wait for the window to roll"*
as a real option (`src/limits.ts:89-91`). `hkb up --status` reads the same window from the same
function, so the status cannot disagree with the refusal it is meant to explain
(`src/daemon.ts:203-210`).

Attempts enter the window by `startedAt` (`src/controller.ts:597`).

## Where each ceiling is set, and by whom

All three live on the `Board` — the namespace — because they are already per-repo facts
(`prisma/schema.prisma:104-107`), and all three are the operator's to set:

| Ceiling | Column | Operator command | In the refusal |
|---|---|---|---|
| stopped | `pausedAt`/`pausedBy` | `hkb stop` / `hkb start` (`src/hkb.ts:1411-1438`) | `` `hkb start` to resume `` (`src/limits.ts:69`) |
| concurrency | `maxConcurrent`, default 1 | `hkb boards set <slug> --max-concurrent <n>` (`src/hkb.ts:1435-1441`) | raise it, or wait for a run to finish (`src/limits.ts:77-78`) |
| budget | `dailyBudgetUsd`, null = no ceiling | `hkb boards set <slug> --daily-budget <usd>\|none` (`src/hkb.ts:1442-1450`) | raise it, or wait for a run or the window (`src/limits.ts:87-97`) |

Two edges worth knowing. `--max-concurrent 0` **drains** a board without stopping it — a distinct
state from the kill switch, and a deliberate one (`prisma/schema.prisma:127`, `src/hkb.ts:1437-1440`).
And `--daily-budget` accepts the literal `none` to clear the ceiling, because "no ceiling" and "a
ceiling of zero" are different configurations (`src/hkb.ts:1444-1448`).

`--max-budget` on `hkb boards set` is **not** a ceiling despite the neighbouring flags: it writes
`defaultMaxBudgetUsd`, a default a Job may override (`src/hkb.ts:1362`,
`prisma/schema.prisma:130-135`). The per-Job cap resolves three deep — the Job's own value, the
board's default, then the built-in $1 (`src/spec.ts:83-87`, `src/spec.ts:181`).

## A Job that spends its own cap is not retried

Distinct from the board ceilings above, and the one that most often looks like a bug: when a run
stops at its own per-attempt cap the outcome is `max_budget`, and `nextPhase` does **not** treat it
as a transient fault — it fails the Job even with retries left (`src/controller.ts:274-277`).

The reason is that a retry gets the same cap and stops in the same place, at the same price. Resuming
helps only when the remaining work is smaller than the cap; nothing checks that, and when it is false
the retry builds the identical wall at full price. The comment records the measured case: job #6
spent $2.05, was retried, spent $2.02 stopping in the same place, and its third attempt was refused
by the board's daily ceiling — $4.07 for nothing (`src/controller.ts:258-273`). Raising a cap is a
change to the Job's **spec**, which belongs to whoever filed it and never to the controller.

So the Job fails carrying advice instead: what it spent, that it was not retried, and the exact
`hkb retry <id> --max-budget <usd>` that raises it (`src/controller.ts:181-191`). It stays
`resumable`, which is what keeps `lastSessionId` so that the deliberate retry continues rather than
starting cold (`src/controller.ts:278-281`).

## For ops

- `hkb up --status` prints, per board, `STOPPED …` if the kill switch is set, then
  `limits  <n> of <m> slots running, $X of $Y spent in 24h` (`src/hkb.ts:1283-1292`). Those are the
  same four facts a refusal cites (`src/daemon.ts:166-184`).
- "The daemon is up but nothing is claimed" is answered by that line before it is answered anywhere
  else — a stopped board with a healthy daemon otherwise reads as fine (`src/hkb.ts:1281-1285`).
- The status line reports **spent**, not the projection the gate actually charges, so a board can be
  refused on budget while its status shows headroom. Filed in `FINDINGS.md`.
- `hkb log` carries a `refused` event per refusal, with the same prose
  (`src/controller.ts:644-646`).

## Related

- [The board](../architecture/the-board.md) — the schema as a model, including what else is frozen
  onto an Attempt and why nearly every spec column is nullable.
- [The loop](../architecture/the-loop.md) — the reconcile pass these checks sit inside, and why an
  operator stop is its own outcome.
- [Leases and liveness](../concepts/leases-and-liveness.md) — what the `liveLeases` count is counting,
  and why a lapsed lease is evidence and not proof.
- [The Job kind](../architecture/job-kind.md) — the retry decision this page's last section is one
  branch of.
