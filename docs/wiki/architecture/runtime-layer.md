---
title: The runtime layer — running a worker on the Agent SDK
summary: One seam, run(spec) -> WorkerOutcome, with the Claude Agent SDK as the first driver and a fake for tests; what the SDK stores for us (so the board does not), and the three SDK behaviours that each cost a bug to learn.
category: architecture
kind: explanation
audience: [dev]
read_when: "changing how a worker is launched, deciding what to persist about a run, or adding a second runtime"
covers:
  - path: src/runtime/index.ts
    sha: 55007f26fe6b9e4ec107997eef5aba74ec4643e6
  - path: src/plugins.ts
    sha: 8057664cf308d860315bd9abe7b941a00fcf4519
  - path: src/runtime/claude.ts
    sha: 5ae775633cae411b71443add232b79f1325c4075
  - path: src/runtime/fake.ts
    sha: 94f9f21ab7c9702506ae625dff37ac15ecfdbcce
generated_at_commit: 6075a95
last_refreshed: 2026-09-08
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

`permissionMode: 'dontAsk'` — **not** `bypassPermissions`. Both avoid prompting,
which a worker needs since nobody is there to answer, but they are not equivalent:
`allowedTools` does not constrain bypass (the docs are explicit that listing `Read`
alongside it still approves `Bash`, `Write` and `Edit`), and subagents inherit
bypass without being able to override it. `dontAsk` denies the unlisted instead,
which is the documented pairing for a headless agent. The tool surface is *also*
enforced in the admission hook, because the mode alone was measured not to hold —
see `concepts/admission-control`.

And `settingSources: []` so a worker does not inherit the operator's
`CLAUDE.md` — the brief is the brief. That second choice has a real cost recorded
in the code: compaction summarises older history, so on a long run the acceptance
criteria in the opening prompt can be summarised away, whereas `CLAUDE.md` is
re-injected on every request. If runs start going long, that is the line to
revisit.

It is **not** the line that decides skills, and that was believed for a while
(*decisions/adr-012-skills-by-grant-not-by-settings*). A repository's own skills
arrive through `plugins: [{ type: 'local', path }]` instead, built from the
resolved `WorkerSpec.plugins` — measured to reach the same skills with
`settingSources` still empty. The two were separable, so the runtime takes the
skills and leaves the settings, where a hook would be a shell command the
repository author wrote.

It is also no longer the line that decides `CLAUDE.md`, and that took a second
measurement to see (*decisions/adr-013-the-guide-is-read-not-loaded*). The flag
really is the SDK's only route to the file — probed both ways, `UNKNOWN` with
`[]` and `>=22.18.0` with `['project']` — but hkb does not have to go through the
SDK to read a markdown file. A granted guide is read from `Board.repoPath` and
prepended to the prompt (`src/guide.ts`), which also makes it portable: a guide
in the prompt reaches any runtime, one the SDK loads reaches only this one.

**`systemPrompt` is unset, and now on purpose** (*decisions/adr-014-no-preset-three-rules*). The
omitted default is the SDK's minimal prompt, which measured 15,022 input tokens
against the `claude_code` preset's 18,314 — so every worker has run without
Claude Code's safety and tool-use guidance. Measured on two real Jobs, the preset
changed no outcome and cost 20%, and it is written for a conversational agent a
human steers rather than a batch job whose output is a diff. What it had that
this file did not — a standing instruction for when the work itself is wrong — is
`withStandingRules` in `src/brief.ts`, at about 150 tokens rather than 3,292.

**`strictMcpConfig: true`, and it closes something that was open.** Reading the
session's own `init` message with `settingSources: []`, a worker was offered four
**claude.ai MCP connectors** — the operator's Gmail, Drive and Calendar among
them. They ride the login rather than the filesystem, so no setting source
excludes them and `mcpServers: {}` does not either. The allowlist and the
admission gate would have refused the calls, so this was never an open door; it
was a set of tool definitions in every worker's context that nobody chose.

`maxBudgetUsd` is the runaway-cost stop and it covers subagent spend.

One thing in that hook *is* per-run: the subagent isolation policy, which reads
`WorkerSpec.isolated` — did this attempt get a worktree, or is it running in the
operator's checkout? A parent with no worktree has nowhere to bring a subagent's
work back to, so spawns are not forced into one there (`concepts/admission-control`).

## Why there is a fake

`fakeRuntime()` (`src/runtime/fake.ts`) answers the same `WorkerOutcome` shape,
session id included, so the store never learns which runtime ran the work. The
control plane — readiness, leases, retries, terminal writes — is the part that has
to be right, and none of it is about Claude. Testing it against a real model would
make the suite cost money and stop being deterministic.

## Known gaps

- Cancellation is **interrupt, then abort**. Aborting alone killed the transport before
  any result arrived, so `total_cost_usd` was never reported and a stalled run
  contributed nothing to the board's spend ceiling — a hole in the guard that exists
  for exactly that case. An interrupt ends the turn properly: measured, a 20s clock on
  a long read produced `status: timeout` with **$0.085 over 12 turns** and a surviving
  session id, where an abort had produced `$0`.

  `interrupt()` is attempted, never depended on. The SDK's own comment says control
  requests are "only supported when streaming input/output is used", but it was
  measured working on a string prompt — stdin closes only at the first result, so the
  control channel stays writable. The abort still lands after a grace window, so an SDK
  that stops honouring this degrades to the old behaviour rather than to a hang.

  The operator's stop (`WorkerSpec.signal`, from `hkb down`) escalates the same two
  stages for the same reason — a shutdown that abandons the transport loses the cost
  of everything the worker just did, from the ceiling as well as from the record. The
  controller, not the runtime, decides that such a run is `stopped`: a runtime reports
  what it saw happen, and only the caller knows it was the one that asked.

  `statusOf` reads `terminal_reason` **first**: an interrupted turn can return
  `subtype: 'success'`, which would otherwise be recorded as `completed` — the worst
  failure available on a board whose whole claim is that `succeeded` means something.
- **Single-message input is an open, structural decision**, not a driver setting.
  A Job is batch — it terminates, which is what lets a lease replace a heartbeat and
  what makes the phase model mean anything. A streaming session stays up and takes
  input over time, which is a Deployment rather than a Job and reconciles toward a
  steady state instead of completion. Three of the four things streaming buys have
  single-mode answers (timeout → `AbortController`; images → materialise into the
  worktree; multi-turn → `resume`); only *steering a live run* needs it, and that is
  most likely a second kind rather than a change to this one. See
  `docs/rebuild-plan.md`, "Open decision".
- Only one real driver. The seam is shaped for a second one, but nothing proves it
  is the right shape until a second exists.
