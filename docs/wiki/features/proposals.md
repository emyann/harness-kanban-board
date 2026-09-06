---
title: Proposals — how a workload files work without touching the board
summary: A proposing Job writes one JSON file, a person reads it, and the controller creates the rows — the transport, the refusals, the approval, and why applying it twice creates nothing twice.
category: features
kind: explanation
audience: [dev]
read_when: "building anything where a worker needs to affect the board — a decomposer, groom's apply half, dynamic fan-out — or asking why a proposal is refused"
covers:
  - path: src/proposals.ts
    sha: fd5e1eee8b847c9b4024d1bf5f635a85907baae4
  - path: src/controller.ts
    sha: bcdf1066a8cf0ea76fdce24e24ec8e43700108fd
  - path: src/brief.ts
    sha: a6f76aecf0487fc43076a4f582c022756d52357e
  - path: prisma/schema.prisma
    sha: e4bac2046bd232c6656a59f4503e6a2ca32578f1
  - path: src/hkb.ts
    sha: 3f58cb1e30df71cb089c70fbb47c00e2e38145f8
generated_at_commit: 0b6c04b
last_refreshed: 2026-09-06
related:
  [
    decisions/adr-011-proposals-not-board-access,
    decisions/adr-010-the-human-gate,
    architecture/job-kind,
    architecture/the-loop,
    concepts/admission-control,
  ]
---

# Proposals — how a workload files work without touching the board

> A Job filed with `--propose` does not create Jobs. It writes one JSON file, suspends, and waits.
> A person reads what it asked for and approves; the *controller* creates the rows on its next pass.
> This is ADR-011's decision made executable, and the reason it is shaped this way is not politeness
> about permissions — it is that a run which files rows as a side effect cannot be retried.

## The four steps, and where each one lives

| Step | Who | Where |
|---|---|---|
| Ask | the worker | writes `proposal.json` into its artifact directory (`withProposal`, `src/brief.ts`) |
| Refuse or accept | the controller, after the run | `checkProposal` (`src/proposals.ts`), stored on `Attempt.proposal` |
| Decide | a person | `hkb approve <id>` / `hkb reject <id> "<why>"` — an `approved` event |
| Apply | the controller, next pass | `applyProposals` (`src/controller.ts`), before anything is claimed |

Nothing skips a step, and the two halves the worker touches are both files: it reads a brief and it
writes a file. It is handed no board handle, no credential and no verb, which is what makes the
transport portable — any harness that can run a workload can write a file (`src/proposals.ts` header).

## Why a file and not a call

The decisive argument is **retry safety**, and it is worth keeping in front of anyone tempted to add
a board API for workers later. Results, artifacts and proposals are all collected *after* the run
returns, and only then is the attempt's decision made (`src/controller.ts`). A worker that dies
mid-session leaves nothing applied and the attempt retries clean. An in-session API call has no such
property: the retried attempt re-does its side effects, and the controller cannot tell the duplicates
from the originals.

The second argument is the audit trail. The raw `proposal.json` stays in the artifact directory, the
validated copy is on the Attempt, and each created Job carries the attempt that proposed it — so what
was asked for, what was accepted and what was created are three facts a reader can line up. A tool
call leaves none of that.

## The refusals are the feature

The thing on the other side of the parser is a model, so every field `checkProposal` accepts is a
field a model chose and nobody reviewed. A proposed Job may set exactly three: `name`, `brief`, and a
`maxBudgetUsd` that is **clamped down to the proposer's own resolved cap** and never up
(`src/proposals.ts`). Everything else is refused *by name* rather than dropped — a silently ignored
`isolate: false` would read as though it had been honoured.

Three of the refused fields are guards: `isolate` (ADR-008's isolation), `allowedTools` (the
admission gate's surface, `concepts/admission-control`) and `pluginPaths` (ADR-012's grant). A
proposal that could set them would be a worker widening its own successor's permissions. `proposes`
is refused for a fourth reason: a proposal that can propose a proposer is a loop with no human in it.

The caps — 64 KB, 20 Jobs, and a length on each name and brief — are not storage limits. The channel
they ride is deliberately uncapped (`src/artifacts.ts`). They exist because the proposal's whole
purpose is to be read by a person before anything is created, and an approval nobody could have read
is the failure this record exists to avoid.

A refused proposal fails the attempt with `Outcome.no_output` and the parser's own message, which
names the offending path (`jobs[2].isolate`). Nothing refused is ever stored.

## Idempotency is a constraint, not logic

A created Job carries three columns naming where it came from: `proposedByJobId`, `proposedByK` and
`proposalIndex`, unique together (`prisma/schema.prisma`). That triple is ADR-011's natural key
`(jobId, attempt, index)`, and it is what makes applying a proposal idempotent — a second pass
re-creates the same triple and SQLite refuses it, so `applyProposals` counts the refusal and moves on
rather than remembering what it already did. The same reasoning as `Lease.slot`: the constraint is
the allocator.

Only a `P2002` is treated that way. Any other error from the create is re-thrown, because a board
that silently drops half a proposal is worse than one that stops and says so (`src/controller.ts`).

## Where it sits in a reconcile pass

`applyProposals` runs after the reclaim and **before anything is claimed**. That ordering is the
whole of it: `hkb approve` re-queues the Job to `pending`, and a proposing Job that reached the claim
loop would be *run a second time* rather than applied. Applying first takes it terminal, so the claim
loop never sees it (`src/controller.ts`).

Everything about the step is level-triggered. It reads what is desired — an approval on the Event
stream, and a validated proposal on the attempt that earned it — against what is observed, and takes
one step. There is no flag cleared on use, because a guard that only fires on a transition is wrong
after a restart (`architecture/the-loop`).

## What an operator sees

```
$ hkb new "break the migration down" --brief-file plan.md --propose
#42 break the migration down  [pending]  on default
  proposes      Jobs — it writes `proposal.json` and waits for you to approve

$ hkb show 42
  phase    suspended
  proposes jobs — written to `proposal.json`, applied by the controller once approved
  waiting  3 Jobs proposed — approve to file them — `hkb approve 42` or `hkb reject 42 "…"`
  k=1      completed    1m12s $0.31 of $2.00  sess-…
           proposes 3 Jobs:
           [0] add the nullable columns
               Write the migration by hand — a required column emits RedefineTables.
           …

$ hkb approve 42 "yes, but keep them serial"
#42 approved by ada — the controller files what it proposed on the next pass
```

One consequence of the apply being the controller's: **`hkb retry` refuses a proposer whose proposal
has been filed.** The next pass would find the same approval, re-file rows the unique key already
refuses, and finish the Job again without ever running the worker — a retry that quietly does
nothing. Retrying it before the approval, or after a refused proposal, works normally
(`src/hkb.ts`).

`--propose` implies a gate, and not by convention: nothing is applied without an approval, so a
proposing Job with no approver would propose into a board where nobody is ever asked. The operator's
own `--gate` question wins if they asked one; once a proposal has been validated the controller
replaces the text with the count, because *how much is being asked for* is the question
(`proposalGate`, `src/proposals.ts`).

## What this does not do yet

The proposal's contents are a list of Jobs and nothing else — no ordering, no dependency, no second
kind of thing to propose. That is deliberate: ADR-011 decision 6 reads creation-without-ordering as
`CronJob`-shaped rather than DAG-shaped, and a `jobs` list with an edge in it would be the DAG
arriving through the side door. `Job.proposes` is a string rather than a boolean so the closed set
can grow without a schema change when there is a second member.

> TODO-VERIFY: nothing here has been run against a live model — every test uses a fake runtime that
> writes the file the prompt names. Whether a real worker reliably produces valid JSON at this
> contract is unmeasured.

## Related

- [adr-011-proposals-not-board-access](../decisions/adr-011-proposals-not-board-access.md) — the decision
- [adr-010-the-human-gate](../decisions/adr-010-the-human-gate.md) — the gate this rides on
- [job-kind](../architecture/job-kind.md) — the kind whose controller does the applying
