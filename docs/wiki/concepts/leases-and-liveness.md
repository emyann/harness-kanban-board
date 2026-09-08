---
title: Leases and liveness — why a lapsed lease is evidence, not proof
summary: "Why a lapsed lease is evidence and not proof: the three-valued alive/dead/unknown answer, the boot-time check, and why a wall clock cannot decide this across a suspend."
category: concepts
kind: explanation
audience: [dev]
read_when: "changing reclaim, the lease duration, the renewal or release fences, or anything that asks whether a holder is still running"
covers:
  - path: src/liveness.ts
    sha: d95719ee29dbd91d6b8a0e702faef3fcf3573d29
  - path: src/controller.ts
    sha: 90455e098974f28f31a507c7141a13f5309ee3b4
  - path: src/daemon.ts
    sha: 114665116363d28f7aeecf23e293f0fff050eadc
  - path: src/worktree.ts
    sha: 0fd70150e01756dd5ace7b862e094b3746f285d0
  - path: src/limits.ts
    sha: 61b65c43e2fd7c28f952c403e02d073ca9907561
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
generated_at_commit: 26814cb
last_refreshed: 2026-09-08
related: [architecture/the-loop, architecture/the-board, architecture/job-kind, concepts/ceilings]
---

# Leases and liveness — why a lapsed lease is evidence, not proof

> A lease answers "who holds this Job right now, and until when". The second half
> of that answer is written on the **wall clock**, and the wall clock is not the
> clock the run itself is being timed on. This page is about the gap between those
> two clocks, what fills it, and why the filling is deliberately allowed to say
> *I don't know*. The reconcile pass that calls all of this is
> *architecture/the-loop*; the tables are *architecture/the-board*.

## Two clocks, and only one of them sleeps

A lease row carries an `expiresAt` (`prisma/schema.prisma:608-638`). A run carries
a `timeoutMs`, which becomes a `setTimeout` — and Node's timers are monotonic: on
Linux they do not advance while the machine is suspended
(`src/liveness.ts:5-16`). The two therefore disagree across a laptop sleep. A
worker five minutes into a thirty-minute Job wakes up correctly believing it has
twenty-five minutes left, while its lease row says it lapsed an hour and a half
ago.

Reclaiming on expiry alone would mark that **live** attempt `lost` and start a
second one — the same double run an earlier lease fix closed, arriving by a
different road (`src/liveness.ts:5-16`, `src/controller.ts:499-504`).

So expiry is *evidence*: it says nobody has renewed. It is not *proof* that
nobody is running. `src/liveness.ts` exists to supply the proof where it can be
had, and to say plainly when it cannot.

## Reclaim needs two independent things to be true

The clock says the lease lapsed **and** the holder is not observably running
(`src/controller.ts:285-304`). A lapsed lease whose holder is a live local pid is
logged and left alone; only then does reclaim mark the open attempt `lost`,
decide the Job's next phase against its resolved retry budget, and write a
`reclaimed` event (`src/controller.ts:311-336`).

The delete itself is **fenced on the expiry** it read: between the `findMany` and
the `deleteMany` the holder may have renewed, and an unconditional delete would
take a live claim — precisely what reclaim exists to avoid
(`src/controller.ts:306-309`).

## Three answers, because a boolean would have to guess

`holderLiveness` returns `alive`, `dead` or `unknown` (`src/liveness.ts:18-21`):

- **`alive`** — a running process on this machine. Do not touch its lease; its
  expiry means the machine slept, not that anything failed.
- **`dead`** — the holder was on this machine and is gone. Reclaimable *without*
  waiting for the clock, which is what makes a crashed host cheap rather than
  expensive.
- **`unknown`** — the holder names another host. A pid on another machine is a
  number with no referent here, so the answer falls back to the clock
  (`src/liveness.ts:60-71`).

The third value is the whole design. Collapsing it either way is a bug in a
different direction: guessing `dead` double-runs the Job, guessing `alive`
strands it forever (`src/liveness.ts:64-66`). `unknown` is an honest answer, and
the clock-only fallback it degrades to is all a Kubernetes lease ever has
(`src/daemon.ts:99-106`).

Callers are expected to *decide* what to do with `unknown`, and they differ. The
Job reclaim treats only `alive` as a veto, so `unknown` reclaims on expiry
(`src/controller.ts:301`). The worktree sweep keeps anything that is not
provably `dead`, because deleting a checkout another host is working in is
unrecoverable (`src/worktree.ts:896-905`). `hkb down` refuses outright: a daemon
it cannot see is a daemon it cannot signal, and it says "stop it there"
(`src/daemon.ts:522-527`).

## The boot check is about pid recycling, not about suspend

`holderLiveness` takes the moment the holder *took* the row, and calls the lease
`dead` if that moment predates this machine's boot (`src/liveness.ts:55-71`). It
is easy to read that as more suspend handling. It is not — it is the answer to a
different problem: **a pid is unique only until it is recycled**, and the cheapest
available proof that a pid was recycled is that the machine rebooted after the
lease was acquired (`src/liveness.ts:46-54`).

Get the direction right. Without this check the failure is not a double run but
its opposite: a lease taken at pid 4242 before a reboot reads `alive` the moment
anything else lands on 4242, and the Job is never reclaimed at all — stuck rather
than doubled (`src/liveness.ts:46-54`).

Two details follow from that:

- The clock used is `os.uptime()`, projected back from now
  (`src/liveness.ts:35-41`). It is the kernel's boot clock, and it **does** count
  time spent suspended — which is exactly the property the wall clock lacked
  above. The module needs a clock that sleep does not fool, and this is it.
- Boot time so derived is a measurement, so a lease is only called pre-boot when
  it clearly is: a 5-second slop margin (`src/liveness.ts:43-44,69`).

The timestamp passed in is the one recording when *this holder* first took the
row — `Lease.acquiredAt` (`src/controller.ts:301`) and `Controller.startedAt`
(`src/daemon.ts:101`) — never `renewedAt`. The question being asked is whether
the pid was handed out before the reboot, which is a fact about acquisition; a
renewal timestamp would answer a weaker question about the row.

A caller with no acquisition timestamp loses this half of the check and nothing
else. The worktree lock has none, so it passes `now()`, and says so: a recycled
pid then reads `alive`, which keeps a checkout that could have gone — an error in
the safe direction, cleared by the next sweep after that pid exits
(`src/worktree.ts:899-903`).

## Why the holder is `<hostname>/<pid>@<runtime>`

Because the host is what makes the pid mean anything (`src/liveness.ts:23-26`).
The string is parsed on the way back in, so its shape is load-bearing rather than
cosmetic: a bare pid cannot be checked for liveness at all
(`src/controller.ts:496-498`, `src/liveness.ts:28-33`). An unparseable holder is
`unknown`, not a crash (`src/liveness.ts:60-61`).

The probe is signal 0 — ask the kernel whether the pid could be signalled, send
nothing. `EPERM` counts as **alive**: it means the process exists and belongs to
somebody else, and existence is the only question being asked
(`src/liveness.ts:74-87`).

## The duration is derived from the run, never chosen

`leaseFor(timeoutMs) = timeoutMs + LEASE_GRACE_MS`, with the grace at five
minutes (`src/controller.ts:463,153-155`). The invariant is **the lease outlives
the run**.

This is the one number in the system that must not be picked independently, and
the history says why: a fixed 15 minutes against a 30-minute `timeoutMs` meant
every long Job's lease expired *while the run was alive*, reclaim marked the live
attempt `lost` and re-queued the Job — a double run at the shipped defaults
(`src/controller.ts:499-504`). The grace is sized off measured teardown (an 8s
timeout observed ending at ~10s) plus the record writes, so it is margin rather
than a guess (`src/controller.ts:159-161`).

`ControllerDeps.leaseMs` overrides the derivation wholesale
(`src/controller.ts:103,433`); no shipped path sets it — the daemon's call site
passes runtime, cwd, board, clock, `reclaim`, signal and `readPr`, and no
duration (`src/daemon.ts:381-392`).

## Renewal, and what a failed renewal means

The claim writes a `token` alongside the holder (`src/controller.ts:665-689`).
Deriving the duration already makes expiry-while-alive impossible; **renewal is
what makes a dead holder cheap to reclaim**, since without it a host that dies a
minute into a thirty-minute Job holds the claim for the full thirty-five
(`src/controller.ts:885-887`).

The cadence is a third of the lease, floored at one second — two renewals may
fail before anything expires, and at the real default the floor never binds
(`src/controller.ts:892-895`). Each renewal is an `updateMany` fenced on the
token, so it writes **nothing** if somebody else now holds the lease; a zero
count is how a running holder learns it lost one
(`src/controller.ts:889-909`). A renewal that could not be written at all is
simply retried on the next tick (`src/controller.ts:908`).

Losing the lease mid-run does not stop the work, it changes what the worker is
allowed to write. The Attempt row is uncontended — keyed `(jobId, k)`, and no
other holder uses this `k` — so it is still recorded; the **Job** row is the
contended one, and a holder that did not keep its lease leaves it alone and emits
`lease_lost` instead (`src/controller.ts:1561-1571`).

## The fence: verify, write, delete

Release is `deleteMany` fenced on the token, not `delete` by `jobId`
(`src/controller.ts:1621`). The unfenced version deleted whoever's lease was
there — so a stale holder finishing late removed the *new* holder's claim and
then overwrote its outcome. The token was already being written at claim and
never read; making it the fence is what closed that.

**Order matters, and it is the opposite of what it once was.** The lease used to
be deleted as soon as the runtime returned — before the rebase, the completion
check and the record writes. Everything after that ran with the Job `running`, an
attempt still open, and *no Lease row*, and every verb that looks into that
window got a wrong answer: `hkb cancel` was accepted (the guard in
`whileUnleased` refuses only when a Lease row exists) and then silently undone by
the outcome written on the way out; `hkb rm` cascaded the rows away and turned
the `attempt.update` into a P2025 that aborted the whole reconcile pass; and a
daemon killed in that window stranded the Job `running` for ever, because
`reclaimExpired` scans Lease rows and there was none to find. With a ten-minute
completion check in that stretch (`features/check`), the window was up to ten
minutes long.

So the claim is now **held to the end** and the fence is a *read*: the token is
compared against the live row, the attempt and Job rows are written, and only
then is the row deleted. The renewer keeps ticking throughout, which is what
makes the verified claim a live one rather than an expiring one, and it is why a
ten-minute check fits inside a five-minute `LEASE_GRACE_MS` — the grace is the
margin for teardown, not the budget for the check. `heldToTheEnd` finally means
what its name says; an earlier read still catches a lost lease before anything
contended is written.

### The release is a `finally`, and that is the whole of it

Holding the claim to the end put the `clearInterval` and the fenced delete about
three hundred lines below the runtime call, reached **only on the way through**.
Anything that threw in between — a `SQLITE_BUSY` on the fence read, an fs error
in `collectResults`, a rejection out of `runCheck` — skipped both: the renewer
went on pushing the Lease row forward every `leaseMs / 3` for the rest of the
daemon's life, so the Job stayed `running`, `reclaimExpired` never found an
expired lease to take, and `whileUnleased` refused `hkb cancel` and `hkb rm`
*because* a Lease row was there. Nothing on the machine could end it short of
deleting the row by hand. Measured with a three-second lease: it was still
advancing minutes after the pass had thrown.

A lease is a claim with a deadline, and a claim whose holder has stopped must
lapse — which is a property of the **release**, not of the happy path arriving at
it. So **the `try` begins at the renewer** — everything from the line after
`setInterval` to the release is under it, the pre-run reads included: a first
version began the `try` after them, ~330 lines past the renewer, and a throw in
the approval read or a file where the results directory should be still made the
immortal lease. The renewer is cleared and the fenced `deleteMany` run in a
`finally`, unconditionally, on every path including the `!heldToTheEnd` early
return (where the token no longer matches, so it deletes nothing — which is
exactly right).

The `catch` beside it follows three rules. It closes the attempt with `crashed`
and the error text, because an attempt row left open is a Job that reads as
`running` for ever. It touches the **Job row only as the holder** — the body's
rule that a lease taken mid-run means another holder is writing that row does not
lapse because the path here is an exception. And **once the outcome is recorded
it rewrites nothing**: a `recorded` flag is set the moment the Job row carries
the outcome, and a failure past it — the event write losing a race, a closed log
pipe on the final line — is raised without turning a `completed` attempt into
`crashed` and a `succeeded` Job back into `pending`, which bought a second paid
session for work already delivered. A resumed attempt that crashed before its
runtime ran keeps its session (`src/controller.ts`). The error is then re-thrown,
so the pass still reports it.

## The daemon's belt and braces: skip one reclaim after a wake

The loop measures wall-clock drift against its own interval, and calls a jump
beyond two intervals plus 30s a suspend rather than a slow pass
(`src/daemon.ts:56-61,331-349`). For exactly that pass it passes `reclaim: false`
into reconcile (`src/daemon.ts:388`, `src/controller.ts:117-124,436`), and logs
that it did.

This is **not** a duplicate of the pid check. `holderLiveness` already refuses to
take a lease off a running *local* process; the drift check is the half that also
covers a holder on **another machine**, which no pid check on this host can see
(`src/daemon.ts:335-342`). Two independent guards, because at that instant every
lease on the board looks expired and not one of them expired for a reason
anybody chose.

Note the scope: the skip lives in the daemon, so a foreground reconcile
(`hkb run`) has no suspend detection of its own — `reclaim` defaults on
(`src/controller.ts:507`) and the pid check is its only guard, which covers every
local holder and no remote one.

## Two leases, and they are not the same lease

| | per-Job `Lease` | per-board `Controller` row |
|---|---|---|
| What it decides | who runs this Job | which daemon leads this board |
| Key / CAS | `jobId` `@id` | `boardId` `@id` |
| Duration | `timeoutMs + 5min` (`src/controller.ts:504`) | `max(3 × intervalMs, 90s)` (`src/daemon.ts:63-64`) |
| Acquisition stamp read for the boot check | `acquiredAt` | `startedAt` |
| Fence | `token` (renew and release) | the `holder` read a moment earlier (`src/daemon.ts:131-137`) |

Shared: the holder string, the three-valued liveness rule, and the insert-as-
compare-and-swap where losing is a normal outcome rather than an error
(`src/daemon.ts:108-146`, `src/controller.ts:665-689`).

Different: what the duration is derived from. A Job lease is sized by the *run it
covers*; a controller lease is sized by the *tick*, so it outlives three ticks and
two missed renewals are survivable (`src/daemon.ts:63-64`). And the controller row
collapses the three answers to a boolean at its own boundary —
`controllerIsLive` maps `unknown` onto `expiresAt > at`
(`src/daemon.ts:99-106`) — because leadership only ever needs a yes or a no.

Renewal differs in shape as well: the controller row is renewed by the same
`acquireBoard` call the daemon makes every tick, whose first act is an
`updateMany` on `(boardId, holder)` — take-or-renew in one
(`src/daemon.ts:115-129`). Both are released on the way out, which is why
`hkb down` sends SIGTERM and never SIGKILL: the shutdown path is what releases
the Job lease in flight *and* the controller rows, and killing the process
outright leaves both held until they expire (`src/daemon.ts:491-496`,
`src/daemon.ts:148-150`).

## What a live lease is also counted for

The number of lease rows on a board is what the concurrency ceiling counts
(`src/controller.ts:593-594`, `src/limits.ts:30-32`) — which means a lapsed lease
still occupies a slot until reclaim closes it, an over-count in the safe
direction. The ceiling argument itself belongs to *concepts/ceilings*, and the
`Lease.slot` ordinal to *architecture/the-board*.

## Related

- [the-loop](../architecture/the-loop.md) — the reconcile pass and the daemon that drives it
- [the-board](../architecture/the-board.md) — the tables, the keys that do the work of logic, and `Lease.slot`
- [job-kind](../architecture/job-kind.md) — Job/Attempt/Lease as the Kubernetes mapping
