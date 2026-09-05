---
title: The runtime layer — running a worker on the Agent SDK
summary: One seam, run(spec) -> WorkerOutcome, with the Claude Agent SDK as the first driver and a fake for tests; what the SDK stores for us (so the board does not), and the three SDK behaviours that each cost a bug to learn.
category: architecture
kind: explanation
audience: [dev]
read_when: "changing how a worker is launched, deciding what to persist about a run, or adding a second runtime"
covers:
  - path: src/runtime/index.ts
    sha: cfdf28fd7555fd7c553e188eaa1dd828a6d93049
  - path: src/runtime/claude.ts
    sha: 0f00b8f535d8514e814e15df693c45e7c7d29592
  - path: src/runtime/fake.ts
    sha: 2812e6a707094da8bebbcb8b32388922e6d2aae0
generated_at_commit: fc5452a
last_refreshed: 2026-09-05
related: [decisions/adr-007-workload-scheduler, architecture/job-kind, concepts/admission-control, concepts/worker-identity]
---

# The runtime layer

The store answers *what work exists and who owns it*. The runtime answers *run
this one*. They meet at exactly two facts — the claim before, the outcome after —
and one rule shapes the whole seam (`src/runtime/index.ts`):

> **Store what survives the runtime process. Derive everything else.**

## What the SDK already keeps, so the board does not

A run produces a transcript, per-model token usage, a turn count and a wall-clock.
All of it hangs off one string. Measured, not assumed: from a stored `sessionId`
alone, `getSessionMessages()` returns the message list and `getSessionInfo()`
returns `summary`, `firstPrompt`, `gitBranch`, `cwd` and `createdAt`.

So `sessionId` is the one SDK fact worth a column, and the numbers on
`WorkerOutcome` (`costUsd`, `turns`, `durationMs`) ride out for an operator to
*log*, not for the board to keep. Copying them into SQLite would be a second copy
that can only go stale.

This is what deleted `pid`, `job`, `worktree`, `transcriptPath` and `heartbeatAt`
from the attempt record: with an in-process runtime the worker is a `for await`
loop this process holds, so liveness is the promise. See
`concepts/worker-identity` for what those columns were solving before.

**The bound on that simplification:** it holds only while *this* process lives. If
the runtime dies the iterator dies with it, and `resume: <sessionId>` is the only
way back — which is why `src/runtime/claude.ts` captures the session id from the
`init` system message rather than from the result.

## Three SDK behaviours that each cost a bug

**`query()` yields the error result and then throws.** A single-shot query raises
after emitting the final result message. Catching outside the loop loses the
result already in hand — including the session id, which is exactly what a
resumable failure needs. `src/runtime/claude.ts` catches *inside* and keeps the
throw beside the result, not instead of it. Before that fix a turn-cap stored
`sessionId: null`.

**The terminal states are not a boolean.** `statusOf()` maps the SDK's subtypes
onto `RunStatus`: `success`, `error_max_turns`, `error_max_budget_usd`, a
`refusal` stop reason, and everything else. Three of those are resumable, and
collapsing them throws away the only fact that decides retry vs resume vs give up.

**`result` exists only on the success variant** — every other subtype carries
cost, usage and `session_id` but no result text.

## Options that are not negotiable per-run

`permissionMode: 'bypassPermissions'` because a worker has nobody to answer a
prompt, and `settingSources: []` so a worker does not inherit the operator's
`CLAUDE.md` — the brief is the brief. That second choice has a real cost recorded
in the code: compaction summarises older history, so on a long run the acceptance
criteria in the opening prompt can be summarised away, whereas `CLAUDE.md` is
re-injected on every request. If runs start going long, that is the line to
revisit.

`maxBudgetUsd` is the runaway-cost stop and it covers subagent spend.

## Why there is a fake

`fakeRuntime()` (`src/runtime/fake.ts`) answers the same `WorkerOutcome` shape,
session id included, so the store never learns which runtime ran the work. The
control plane — readiness, leases, retries, terminal writes — is the part that has
to be right, and none of it is about Claude. Testing it against a real model would
make the suite cost money and stop being deterministic.

## Known gaps

- No wall-clock timeout, and no cancellation. `interrupt()` requires the SDK's
  streaming-input mode (an `AsyncIterable` prompt); the driver uses single-message
  input, so a hung run can only be bounded by the Job's lease expiry.
- Only one real driver. The seam is shaped for a second one, but nothing proves it
  is the right shape until a second exists.
