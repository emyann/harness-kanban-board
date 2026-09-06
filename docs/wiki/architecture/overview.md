---
title: hkb at a glance
summary: "The moving parts of a workload scheduler: a CLI over one SQLite board, a level-triggered controller that claims a Job under a lease and runs it inline, a runtime seam over the Agent SDK, and a git worktree as the sandbox. Where state lives, and what is deliberately not here."
category: architecture
kind: explanation
audience: [dev]
read_when: "your first session in this repo, or changing how state, reconciliation and workers fit together"
covers:
  - path: bin/hkb.ts
    sha: 698dd0e673a442929b7314d6bb409f87f89b8251
  - path: src/hkb.ts
    sha: bccac3a895b8b84cb27a1e15a6684153e7edf681
  - path: src/controller.ts
    sha: ae2034b01315707358b26348380e117653caf510
  - path: src/daemon.ts
    sha: 114665116363d28f7aeecf23e293f0fff050eadc
  - path: src/db.ts
    sha: c759afb94b34e93ecefdb0384e06924bd772e836
  - path: src/db-url.ts
    sha: 075e55c592c972b3505f106ac670a277996f0615
  - path: src/worktree.ts
    sha: 8cba275c6c1379e1a0dae4f67acc299d7024536b
  - path: src/pulls.ts
    sha: a27f00a986f576c2d3ed035902c0a1c9f9a9300c
  - path: prisma/schema.prisma
    sha: fd5d599273f0f0340a79043f6796b3f7f99cd73f
related:
  [
    architecture/job-kind,
    architecture/the-loop,
    architecture/runtime-layer,
    concepts/admission-control,
    decisions/adr-007-workload-scheduler,
    decisions/adr-009-retiring-the-first-system,
  ]
generated_at_commit: 0903659
last_refreshed: 2026-09-05
---

# hkb at a glance

hkb takes a **workload** and executes it. There is one workload kind — a **Job**: one agent, one brief,
run to completion — and everything here exists to get one of those started, keep exactly one of it
running, and record what happened. [ADR-007](../decisions/adr-007-workload-scheduler.md) decided that
shape; [ADR-009](../decisions/adr-009-retiring-the-first-system.md) deleted the GitHub-Issues kanban that
preceded it, so anything in the git history about `refs/kb/boards/<slug>`, a dispatcher tick, a store
seam or 36 CLI verbs is describing code that is gone.

## The pieces

| | |
|---|---|
| `bin/hkb.ts` → `src/hkb.ts` | the CLI: parse, resolve a board, run one verb, print |
| `prisma/schema.prisma` + `src/db.ts` | the board — one SQLite file, one memoized client handle |
| `src/controller.ts` | `reconcile()` — one level-triggered pass over one board |
| `src/daemon.ts` | that pass on a timer, detached, over *every* board |
| `src/worktree.ts` | the sandbox: cut a checkout, carry declared files in, get outputs out, sweep |
| `src/runtime/` | the seam a worker runs behind — the Agent SDK, or a fake that spends nothing |
| `src/admission.ts` | the `PreToolUse` gate that makes worktree isolation and the tool surface invariants rather than instructions |
| `src/results.ts` | the named values a Job hands on, when its output is not a diff |
| `src/pulls.ts` | the only thing that shells out to `gh` |

## State lives in the board, and only there

The board is **`~/.hkb/board.db`** (`src/db-url.ts`) — SQLite behind Prisma, one file per *machine*
with a `Board` row per *repository*, the way one Kubernetes cluster holds a namespace per project. That
default is the reason "show me everything running here" is a query rather than a hunt across checkouts.
`HKB_DATABASE_URL` points at a different file, and the test suite uses exactly that.

It creates and migrates itself on first touch (`src/schema.ts`), from the committed SQL in
`prisma/migrations`, writing the rows Prisma itself writes — so `prisma migrate dev` in a checkout keeps
working against the same history. The reverse direction is a refusal: a board carrying migrations this
build does not know about belongs to a newer `hkb`, and opening it would fail somewhere deep in Prisma
with a message naming a column rather than a cause.

No process holds truth. A daemon caches nothing across passes, and a verb reads the board and exits.

## The shape is a controller, not a queue consumer

`reconcile()` (`src/controller.ts`) reads observed state, compares it to desired state and takes **one
step**. It is safe to run repeatedly, to interrupt, and to run while another host runs it. Nothing may
depend on having seen an event — which is why `src/daemon.ts` is a resync loop rather than a
subscription, and why a guard that only fires on a *transition* is a guard that is wrong after a restart.

The Kubernetes mapping is deliberate and it is load-bearing rather than decorative:

| hkb | Kubernetes |
|---|---|
| `Job` | Job |
| `Attempt` | Pod |
| `Lease` | Lease |
| `Board` | Namespace |
| `Controller` row | leader election |
| `hkb up` | a resync loop, not a watch |

The one place hkb departs from it: it **fuses the controller-manager and the kubelet**. There is no node
to schedule onto — the process that decides a Job should run is the process that runs it, inline.

## What a pass does

Claim under a lease, run, record. The interesting parts are the refusals:

- **The ceilings are checked before a claim and never during a run** (`src/limits.ts`). A ceiling that
  could stop a running worker would strand its worktree; one that declines to start another is only a
  decision. That is also why the module is pure — a decision with no I/O can be tested exhaustively
  against the refusing case, which is the case that matters.
- **A lapsed lease is evidence, not proof.** Reclaim goes through `src/liveness.ts`, which answers
  `alive | dead | unknown` — and `unknown` is a real answer, because a holder on another host cannot be
  probed and a wall-clock expiry means nothing across a laptop suspend.
- **Isolation and the tool surface are enforced, not requested.** `src/admission.ts` is a `PreToolUse`
  gate that rewrites or denies; the prompt asking a worker to stay in its worktree was measured being
  ignored. The same gate is built from the Job's resolved `allowedTools`, so a Job narrowed to `Read`
  and `Grep` *cannot* write whatever its brief says — which is what makes a propose-then-approve gate
  (ADR-010) a boundary rather than a hope. See *concepts/admission-control*.

## The forge is not the board

GitHub holds pull requests. It holds nothing else. `src/pulls.ts` shells out to `gh` to read them back
and joins them to a Job by **branch name** — `kb-<jobId>-<k>`, which `src/worktree.ts` derives so nothing
has to remember it. The worker opens its own *draft* PR and a human merges; `succeeded` means the session
ended, not that the work is good — and not, on its own, that anything was produced. Nothing in the
machinery *requires* a pull request, so `hkb ls` marks a succeeded Job that opened none and declared no
outputs as **produced nothing** (`producedNothing`, `src/hkb.ts`). It is stated rather than judged: "I
looked, and there is nothing to change" is a real outcome, and so is a `--no-isolate` Job.

A Job can also declare its outputs, which is how it stops being coupled to a commit at all
([ADR-008](../decisions/adr-008-declared-outputs.md)). **`exports`** (`--export <path>`) are paths the
board copies out of the worktree into the repository before the checkout is torn down. **`results`**
(`--result <name>`) are named, small values the worker writes to a path the controller gives it and the
board keeps on the Attempt — a finding, a decision, a URL, capped at 4 KB each (`src/results.ts`). One
rule covers both: **a declared output the run did not produce fails the attempt**, which is what makes
`succeeded` mean more than "a session ended". Everything else left in the checkout is litter and goes
with it.

A run may also **volunteer** a result: anything it writes beside the declared ones is kept and never
required. The difference between the two layers is what is *enforced*, not what is stored — a
declaration is the filer saying "this must exist", and a volunteered value is the Job saying "you did
not ask, but you should know". Hermes' structured handoff is the second layer alone, which is richer
and guarantees nothing, because a downstream reader cannot rely on a key existing.

That pair is what a Job with nothing to commit produces. `hkb ls` marks a succeeded Job that opened no
pull request and declared neither as **produced nothing** (`producedNothing`, `src/hkb.ts`); with a
result declared, the same Job says what it found instead.

## What is deliberately not here

- **A dependency graph.** Cards that depend on cards is a *second workload kind* that does not exist yet;
  its controller will create Jobs the way a CronJob creates Jobs, and its ordering rule belongs in the
  admission gate rather than in a prompt. `docs/rebuild-plan.md` holds the order.
- **An LLM anywhere in the controller.** The reconcile pass is arithmetic and SQL.
- **A merge.** hkb never merges. That is the one step a human keeps.
