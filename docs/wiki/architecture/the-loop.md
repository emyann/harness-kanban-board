---
title: The loop — a level-triggered daemon, and why the clock is not enough
summary: kb up runs reconcile on a 45s timer; the loop exists for the time-driven half only. Why a controller is level-triggered rather than event-driven, why a lapsed lease is evidence and not proof, and why an operator stop is its own outcome.
category: architecture
kind: explanation
audience: [dev]
read_when: "changing the daemon, the reclaim rule, or anything that decides whether a lease may be taken"
covers:
  - path: src/daemon.ts
    sha: 6fb87b2191b486da936a2968e584a962090d8118
  - path: src/liveness.ts
    sha: d95719ee29dbd91d6b8a0e702faef3fcf3573d29
  - path: src/controller.ts
    sha: 67a1aba83797f8b1f39e6e50e39f654f53dcf0b8
generated_at_commit: c5326c0
last_refreshed: 2026-09-05
related: [architecture/job-kind, architecture/runtime-layer, decisions/adr-007-workload-scheduler, concepts/worker-identity]
---

# The loop

`kb run` reconciles once, in the foreground. `kb up` runs the same pass on a timer
in a detached process (`src/daemon.ts`). Nothing about the pass changes — the
daemon is a caller, not a second control plane.

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
3. `kb down` has to reach in and interrupt a worker. A controller would just exit.

## Why the interval is slow

Only three things are genuinely time-driven, and none has a sub-minute tolerance:
a lease expiring, a run passing its wall clock, and scheduled work (a kind that
does not exist yet). The change-driven half — *a Job was filed, run it* — is
always one `kb run` away, so it does not set the cadence.

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

`kb down` sends SIGTERM; the handler **does not exit**. It aborts the run in
flight and lets the pass unwind, because the fenced release is written on the way
out — exiting is precisely what would leave a lease held.

The attempt is then recorded as `stopped`, which is its own `Outcome` value for
two reasons. It is true (`crashed` and `timed_out` were both lies about why it
ended), and it **does not spend a retry**: a Job with `maxRetries: 0` could
otherwise be made permanently unrunnable by nothing but being turned off. The
attempt number `k` still advances — it is half the Attempt's primary key — so the
retry budget is counted separately from the attempt count. The session id is kept,
so `kb up` after `kb down` resumes rather than restarts.

## The pid file

A pid file is a claim, not a fact, and gets the same two questions the lease does:
is that pid running, and could it still be ours? A daemon recorded as starting
before this machine booted cannot be, whatever holds that pid now. Without the
boot check a stale file after a reboot makes `kb up` refuse for ever — the failure
that teaches people to delete pid files by hand.

It lives beside the board (`HKB_DATABASE_URL`'s directory), not at a fixed repo
path, so two boards in one checkout do not fight over one lock and a test with a
scratch database cannot stop the operator's running daemon.
