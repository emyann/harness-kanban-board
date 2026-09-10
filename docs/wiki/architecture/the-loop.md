---
title: The loop — a level-triggered daemon, and why the clock is not enough
summary: hkb up runs reconcile on a 45s timer over every board on the machine. Why a controller is level-triggered rather than event-driven, why a lapsed lease is evidence and not proof, why leadership is a row rather than a pid file, and why an operator stop is its own outcome.
category: architecture
kind: explanation
audience: [dev]
read_when: "changing the daemon, the reclaim rule, or anything that decides whether a lease may be taken"
covers:
  - path: src/daemon.ts
    sha: 22f946c6625de1f566d4301e098873050b23ac12
  - path: src/liveness.ts
    sha: d95719ee29dbd91d6b8a0e702faef3fcf3573d29
  - path: src/controller.ts
    sha: 6563f3234641037e46504688115ac5ed4b76cf1b
  - path: src/db-url.ts
    sha: 075e55c592c972b3505f106ac670a277996f0615
  - path: src/schema.ts
    sha: ee1920b789eb96be121c8bba20cc92e452ddf818
  - path: src/check.ts
    sha: 730324bea5aa0fe083bc5fb7244c06ce20a54c2c
  - path: src/workspaces.ts
    sha: b709212e781376f570a613907a209648dab91526
generated_at_commit: 2b8902f
last_refreshed: 2026-09-10
related: [architecture/job-kind, architecture/runtime-layer, decisions/adr-007-workload-scheduler, decisions/adr-016-the-pod-spec-is-the-map, concepts/leases-and-liveness, features/check]
---

# The loop

`hkb run` reconciles once, in the foreground. `hkb up` runs the same pass on a timer
in a detached process (`src/daemon.ts`). Nothing about the pass changes — the
daemon is a caller, not a second control plane.

Both wire the same `AbortController` to `deps.signal`, and both handlers only *ask*: exiting is
what would leave a lease held, since the release is written on the way out of `reconcile`
(`src/hkb.ts`). `hkb run` wired none at all until it was found that `Ctrl-C` there killed the CLI
and left the pass's detached completion check running in the workspace with nothing left to bound
it — `deps.signal` is the only route a stop has into `runCheck` (`features/check`).

## It is level-triggered, and that is a decision

The loop reads observed state, compares it to desired state, and takes one step.
It never depends on having *seen* something happen. That is the same choice
Kubernetes makes, and the reasoning transfers directly:

- A Kubernetes controller watches the API server, but the watch is a **latency
  optimization**, not the mechanism. Informers resync periodically regardless, and
  when a watch event does arrive it enqueues a *key* — the worker then re-reads
  state and discards the event.
- A system that throws away its event payloads is telling you the event was a hint
  to re-read, not data. Miss every hint and it still converges, slowly. Miss an
  event in a genuinely edge-triggered system and it is wrong permanently.

hkb is that loop with no watch at all: a controller whose resync period is 45
seconds. The gap is **latency, not correctness**, which is why it could be
deferred through three phases. It also means a guard that only fires on a
transition is a guard that is wrong after a restart — the rule is in `CLAUDE.md`.

> ℹ️ For a future watch: `PRAGMA data_version` bumps when another connection
> commits and carries no payload — structurally a `resourceVersion`. It would slot
> in as a hint that skips a wait. Not built; see `docs/rebuild-plan.md` Phase 4.

## Where the Kubernetes analogy stops

A controller there **decides but does not execute** — kube-controller-manager
writes a Pod spec, kubelet runs the container. `reconcile()` does both: it claims
the lease and then *awaits the worker inside the same pass*. hkb has fused
controller-manager and kubelet into one process.

Three consequences follow from that fusion, and they are the reason for most of
what is unusual in this file:

1. A "tick" can last thirty minutes, where a Kubernetes sync is sub-millisecond.
2. The lease has to outlive the run it covers, not the pass.
3. `hkb down` has to reach in and interrupt a worker. A controller would just exit.

## What follows the run, in order

Because the pass is also the kubelet, the end of a run is a sequence rather than a return value,
and the order of it is load-bearing (`src/controller.ts`):

1. the **workspace is verified** — a run that completed and came back with no
   `workspacePath`, or with one that resolves to the repository itself, did not get the isolation
   it asked for, and nothing it produced can be trusted (`isolationShortfall`, `src/controller.ts`);
2. the declared outputs are **checked for** — present, or the attempt has already failed
   (`features/declared-outputs`); the results and artifacts are collected out of the sandbox,
   and a proposal is parsed and refused here rather than applied (`features/proposals`);
3. the Job's **check** is run, in the workspace as the session left it, and its exit code decides
   the attempt (`features/check`, ADR-016 §3). It no longer claims to test what would merge —
   nothing rebases anything (*decisions/adr-018-the-boundary*) — and it does not run for a
   proposing Job, which changes nothing in the tree for a command to judge;
4. the declared outputs are **copied out** into the repository — after the check, so an attempt
   the check *refused* writes nothing into the operator's tree, and re-planned rather than trusting
   the probe, because the check ran in that tree in between. Only the check withholds this: an
   export that is present is still delivered when a different declaration fell short, because what
   a run produced is a durable record whether or not the rest of it held up;
5. the gate and the phase are decided and the attempt and Job rows are written — the Job's own
   deadline last of all, because it outranks everything including a clean `completed`;
6. the lease is **released** — last, and fenced on the token, so a holder that lost it mid-run
   writes nothing outside its own attempt row.

**And there is no seventh step.** The pass used to end by tidying the checkout; it does not, and
that is the design. A workspace outlives the pass and is collected by the sweep below, so a Job
that is `pending` again or `suspended` keeps the tree its next attempt resumes into.

**Release is last, and it used to be first.** Everything from 1 to 5 then ran with the Job
`running`, an attempt open and no Lease row — a window that `hkb cancel`, `hkb rm` and the reclaim
each read wrongly, and that a ten-minute check stretched to ten minutes
(`concepts/leases-and-liveness`). The renewer runs throughout, and the token is verified by a
*read* immediately before the writes in step 5; `heldToTheEnd` gates every step that touches the
repository or the workspace, because those are contended state too.

**And steps 1 to 6 are one `try` block.** Being last is not the same as being reached: a throw
anywhere in that sequence used to skip both the renewer's `clearInterval` and the release, leaving a
Lease row that advanced for the rest of the daemon's life on a Job nothing could cancel. The
release is a `finally`, and the `catch` beside it closes the attempt `crashed` and puts the Job back
to `pending` or `failed` before re-raising.

## A stream out, and still no subscription in

`hkb watch` follows the `Event` table as it is written (`features/watch`), which is the *outbound*
half of what a watch means and changes nothing about this loop: the controller still reads desired
state and takes a step, and nothing in it depends on having seen an event. The distinction is worth
keeping straight, because "hkb has a watch now" would otherwise read as a claim about the daemon. It
is a claim about everything else — a status line, a notifier, a second controller — which until now
had to poll `hkb ls` and diff.

## One step that is pure controller

`applyProposals` is the exception to the fusion above, and worth knowing about because it is one of
only two parts of a pass that **create rows** — the other is `reconcileRuns`, which is not in this
file at all: it is the board's kind, composed in front of this one by `src/pass.ts`
(*features/runs-and-steps*). Both run before anything is claimed, and for the same reason, so a row
created this pass is claimable in it. `applyProposals` runs after the reclaim and before any claim: a
Job approved with `hkb approve` is `pending` again, and if it reached the claim loop it would be *run
a second time* rather than have what it proposed filed (`src/controller.ts`, `features/proposals`).

It is level-triggered like everything else here — an approval on the Event stream and a validated
proposal on the attempt that earned it, against the rows that already exist — and its idempotency is
a unique constraint rather than a memory, so a pass that dies half way leaves the rest to the next
one.

## Why the interval is slow

Only four things are genuinely time-driven, and none has a sub-minute tolerance:
a lease expiring, a run passing its wall clock, scheduled work (a kind that
does not exist yet — `Run`/`Step` sequences, it does not schedule by clock),
and a workspace passing its TTL. The change-driven
half — *a Job was filed, run it* — is always one `hkb run` away, so it does not
set the cadence.

## The sweep: `ttlSecondsAfterFinished`, and nothing else

A worker installs the target repository's dependency tree to run its tests, so a
checkout costs about as much as the repository does — Phase 5 left **6.1 GB** for
ten Jobs. The end of a run still cannot be where that is reclaimed: the next attempt
resumes *into* that tree, and an operator wants to look at what a run left. So it is
the loop's business — the first tick sweeps, then one tick in every `SWEEP_EVERY_MS`
(ten minutes), after `reconcile` rather than before it. A daemon started to clean up
should not wait ten minutes to do it, and one left running should not ask every 45
seconds (`src/daemon.ts`).

**What it asks is a clock, not a question about the tree.** A finished Job's
workspace is collectable once `BUILT_IN_TTL_SECONDS` (one hour) has elapsed since
`finishedAt`; a Job that has not finished has no `finishedAt`, so its workspace is
never a candidate whatever its age (`collectable`, `src/workspaces.ts`). Two
exceptions, both narrow:

- a **failed Job that still has a session** is `resumable`, which buys it the longer
  `RESUMABLE_TTL_SECONDS` window (a day) rather than a permanent reprieve — `hkb retry`
  continues that session and would otherwise wake in a checkout with none of its work,
  but a veto with no time term in it leaks a checkout per failure. Narrower than "has a
  session id": a cancelled Job and a `done` one keep theirs and neither is resumed;
- a workspace belonging to **another board on the same repository** is not this sweep's
  to consider: existence is asked across every board, ownership second;
- a workspace whose **Job row is gone** — `hkb rm` is the normal way to tidy — is
  collectable at once. Nothing is left that could want it, so the TTL has nothing to
  measure.

**It starts from `git worktree list`, never from the board.** Asking the board for
finished Jobs and trying to remove each one's workspace is two git processes per Job
per tick and a `swept` event every time, for ever, describing nothing happening —
`removeWorkspace` has to report an absent workspace as removed, so there is no natural
stopping point. One board-wide call answers instead, and only names matching
`kb-<jobId>` are candidates, so a worktree the operator made is never one
(`existingWorkspaces`, `src/workspaces.ts`). The path git reported is the path that is
removed; an earlier version rebuilt it from a convention and leaked every workspace
that was not where the convention said.

**The lock is honoured and `--force` is never passed.** The runtime holds a
`git worktree lock` for the length of a run, and a locked tree — or one holding
uncommitted or untracked work — is refused by git, reported by name, and left on disk.
That refusal is what replaced the old inspection: the previous sweep asked each
checkout whether it held unpushed work, which needed `pushedRef`, `heldWork` and
`whyKept`, only had an answer while the core required a push, and had no opinion about
age at all (*decisions/adr-018-the-boundary*).

## A lapsed lease is evidence, not proof

The bug this is built against: **a lease expires on the wall clock, and a run
times out on a monotonic one.** Node's timers do not advance while the machine is
suspended. So after a two-hour laptop sleep, a worker five minutes into a
thirty-minute Job correctly believes it has twenty-five minutes left, while its
lease row lapsed ninety minutes ago. Reclaiming on expiry alone marks that live
attempt `lost` and starts a second one — the same double run the lease fix closed,
arriving by a different road.

Two guards, deliberately independent, because one guard has already been enough to
be wrong three times in this project:

- **Holder liveness** (`src/liveness.ts`). The holder is `<host>/<pid>@<runtime>`,
  and a lapsed lease whose pid is still running *on this host* is not taken. The
  three answers are `alive`, `dead`, `unknown` — not a boolean, because a pid on
  another machine is a number with no referent, and guessing either way is a bug
  (guess dead → double run; guess alive → the Job strands). `unknown` falls back to
  the clock, which is all a Kubernetes lease ever has.
- **Suspend detection** (`src/daemon.ts`). The loop compares wall-clock drift
  against its own interval and skips reclaim for exactly the pass after a jump.
  This is the half that covers a holder on *another* host, where no pid check can
  see anything.

`acquiredAt` is load-bearing in the first guard, not decoration. A pid is unique
only until it is recycled, and the cheapest proof of recycling is that the machine
booted after the lease was taken. Without it, a stale lease reads `alive` for ever
once anything lands on that pid — the Job never reclaims at all.

## An operator stop is not a failure

`hkb down` sends SIGTERM; the handler **does not exit**. It aborts the run in
flight and lets the pass unwind, because the fenced release is written on the way
out — exiting is precisely what would leave a lease held.

The attempt is then recorded as `stopped`, which is its own `Outcome` value for
two reasons. It is true (`crashed` and `timed_out` were both lies about why it
ended), and it **does not spend a retry**: a Job with `maxRetries: 0` could
otherwise be made permanently unrunnable by nothing but being turned off. The
attempt number `k` still advances — it is half the Attempt's primary key — so the
retry budget is counted separately from the attempt count. The session id is kept,
so `hkb up` after `hkb down` resumes rather than restarts.

## Leadership is a row, not a lock

The board is `~/.hkb/board.db` — one per machine, a `Board` per repository — and one
daemon serves all of them, the way one controller-manager serves every namespace. So
"who is in charge here" is per board, and it is a `Controller` row: the same
compare-and-swap as `Lease` (`@@id`), the same staleness rule (`expiresAt` plus
`holderLiveness`), the same three-valued answer for a holder on another machine.

This replaced a pid file, and the reason is worth keeping. A pid file is a second
source of truth living outside the store, re-deriving rules `Lease` already owned —
and it got one wrong: it recorded `<hostname>/<pid>` and **never read the hostname
back**, checking only `pidIsAlive(pid)`. On a shared filesystem that asks the wrong
machine's process table, in both directions. The careful three-valued check existed
one file over and was not applied.

It is also **leader election rather than exclusion**, which is what Kubernetes
actually does: three controller-managers, one `Lease`, and the losers idle. A second
daemon here is not refused — it takes the boards it can lead and says which it cannot.
That makes standby behaviour a later change of policy rather than a redesign.

## The repository is on the Board

A `Job` runs in `Board.repoPath`, not in the daemon's cwd — a long-lived machine
daemon has no meaningful cwd, and "wherever the operator was standing" stopped being
a definition of anything the moment one process served several repositories. It is on
the Board rather than the Job because a Job is inherently single-repo — one workspace,
cut from one repository — and because the ceilings beside it are already per-repo
facts: *this repository's workflows are expensive, run one at a time*.

`deps.cwd` in the controller survives only as the fallback for a board with no repo —
which is `hkb run` in a checkout, and every test.

## The board bootstraps itself

A machine-level default is only frictionless if the first command on a fresh machine
works, so `openBoard` creates and migrates the database on first touch
(`src/schema.ts`), writing the same `_prisma_migrations` rows Prisma writes so
`prisma migrate` keeps working in a checkout. Telling the operator to run a migration
would fail twice over: it is the "yes, by hand" answer this project treats as a bug
report, and `prisma` is a devDependency a global install does not have.

The opposite direction cannot be repaired, so it is refused with a real message: a
board carrying migrations this build does not know about belongs to a newer `hkb`.
One shared board makes that reachable rather than theoretical.
