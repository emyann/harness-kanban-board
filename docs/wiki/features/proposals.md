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
    sha: a50ac9ee35132bd67b57bb593e9771bd851fe741
  - path: src/brief.ts
    sha: b3eddf6aebd95fdab1f38424b24851d6a4e3e5a2
  - path: prisma/schema.prisma
    sha: 364793f9a1174875c3bf644257b6d0cbdf94d25e
  - path: src/hkb.ts
    sha: eb759e566ef71b11caa34cc0945a6e2ae30958cf
  - path: src/workspaces.ts
    sha: b709212e781376f570a613907a209648dab91526
generated_at_commit: ebf564a
last_refreshed: 2026-09-10
related:
  [
    decisions/adr-011-proposals-not-board-access,
    decisions/adr-010-the-human-gate,
    decisions/adr-018-the-boundary,
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

An isolated proposing Job is told **nothing at all about its workspace**, and that is now the
general rule rather than a special case. The core used to append a sandbox contract to every
isolated Job — commit, rebase, push — so a proposer needed an exemption from it (`withWorktree`, a
"this is a sandbox, not a deliverable" note), because a prompt that said both *commit what you have*
and *write the file and stop* was not an instruction. ADR-008 decided the general form — what a Job
is told to produce should be selected by the spec rather than implied by having a worktree —
ADR-017 decision 5 moved the pull request out, and **ADR-018 deleted the contract and the exemption
together**: the core requires no commit, push or rebase, so it says none of it to anyone, and
`withWorktree` is gone with `withSandbox` (`src/brief.ts`). A proposer's prompt is the brief, the
standing rules, the guide, the declared outputs and `withProposal` — no git in it
(`src/controller.ts:1287-1336`).

What survives the deletion is the *other* exclusion, and it still has to be made explicitly: a
proposing Job is not given a board's **default workflow**, because that is where the commit-push-PR
steps live now and they are exactly the contradiction the note existed to prevent
(`src/controller.ts:1255`). It is made twice, at `hkb new` and again where the steps are composed at
claim time, because a Job can become a proposer after it is filed
(*features/workflow-templates*).

> **Its workspace is kept while it is suspended, and that changed.** The controller used to remove a
> proposer's checkout on suspending — a gated Job's approval resumes a session *in* its tree, while a
> proposer's approval is applied by the controller and no session ever wakes up there. The tidy block
> is gone (`src/controller.ts:1959-1974`), and a `suspended` Job has no `finishedAt`, so
> `collectable` never takes its workspace (`src/workspaces.ts:119-128`). A proposer's checkout
> therefore stands on disk from the moment it suspends until an hour after the Job finishes. That is
> the honest cost of replacing four inspect-the-tree branches with one TTL; ADR-018 accepts it, and
> `ttlSecondsAfterFinished` becoming a spec field is what would let a board tighten it.
| Refuse or accept | the controller, after the run | `checkProposal` (`src/proposals.ts`), stored on `Attempt.proposal` |

A proposing Job also runs **no completion check**, however the board is configured: it changes
nothing in the tree, so there is nothing for a command to judge — and because `check_failed`
outranks the gate in `nextPhase`, a check over that unchanged tree stopped the Job suspending for
approval at all and sent it round the retry loop instead (`features/check`).
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
(`retryJob`, `src/transitions.ts`).

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

## What one live run showed

Measured 2026-09-06, on this repository's own board: a proposing Job asked to decompose the wiki's
remaining page plan, given `wiki.config.yml` and `FINDINGS.md` as declared inputs.

It read the authoring rules, researched the four planned pages across 26 turns, and wrote a
**32 KB proposal of four Jobs** whose keys were exactly `name`, `brief` and `maxBudgetUsd` — valid
first time, no refusal. `hkb approve` then filed all four with lineage, at $1.88 of a $2.00 cap. It
also tried twice to spawn subagents and was denied by the admission gate, which is the gate doing its
job rather than a fault.

Four defects came out of that one run, all now fixed and all invisible to a fake runtime:

| What the run showed | What was wrong |
|---|---|
| the prompt told it to open a draft PR *and* to write the file and stop | the pull-request protocol (as it then was) was applied to a Job that produces no diff — the whole class of fault ADR-018 ended by removing git from the core's prompt |
| `hkb run` said `1 to retry` | a suspended Job was counted as retrying — the machine will not pick it up, a person must |
| `hkb show` said `error completed` | `lastError` fell through to the outcome word for every suspended Job |
| `hkb ls` said `produced nothing` | a proposer only reaches `succeeded` once its rows are filed, which is not nothing |

The general lesson is the one worth keeping: every one of those is a **prompt or a report**, and
neither is reachable by a test that supplies its own runtime. The contract held; what did not hold
was everything around it that only a person reading the output would notice.

## Related

- [adr-011-proposals-not-board-access](../decisions/adr-011-proposals-not-board-access.md) — the decision
- [adr-010-the-human-gate](../decisions/adr-010-the-human-gate.md) — the gate this rides on
- [job-kind](../architecture/job-kind.md) — the kind whose controller does the applying
