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
    sha: 5dc47f4b0e302d2eba5ca1d0895104f4f6e00bcb
  - path: src/controller.ts
    sha: 55cb278593ae0b3d0692712e4fcff643c29e4a4e
  - path: src/daemon.ts
    sha: 114665116363d28f7aeecf23e293f0fff050eadc
  - path: src/db.ts
    sha: c759afb94b34e93ecefdb0384e06924bd772e836
  - path: src/db-url.ts
    sha: 075e55c592c972b3505f106ac670a277996f0615
  - path: src/artifacts.ts
    sha: b1c001d916ec6cdd8198d978bbae1d09a2d2813d
  - path: src/inputs.ts
    sha: 140cf48b8b323742a57e3e604b6853f829c72b6c
  - path: src/proposals.ts
    sha: fd5e1eee8b847c9b4024d1bf5f635a85907baae4
  - path: src/templates.ts
    sha: 84e68dad2edc226425dfb0b8880e9765b2628686
  - path: src/labels.ts
    sha: b524ef31fce5611a1a676dfb4631aaa83ecba926
  - path: src/watch.ts
    sha: 992b53f9dc3ef4284c2a1bf0201794490afee393
  - path: src/brief.ts
    sha: a56db1e2f49d60c695034ecd14f73c5c258cce85
  - path: src/worktree.ts
    sha: 98d0b677291d536701dc137cf1d5997f8fd80a3f
  - path: src/pulls.ts
    sha: a27f00a986f576c2d3ed035902c0a1c9f9a9300c
  - path: prisma/schema.prisma
    sha: 31ae1a8e52791c7a7e2555d68646e67c2df69a41
related:
  [
    architecture/job-kind,
    architecture/the-loop,
    architecture/runtime-layer,
    concepts/admission-control,
    decisions/adr-007-workload-scheduler,
    decisions/adr-009-retiring-the-first-system,
    decisions/adr-011-proposals-not-board-access,
  ]
generated_at_commit: 5279b8a
last_refreshed: 2026-09-09
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
| `src/filing.ts`, `src/read.ts`, `src/transitions.ts` | what a verb calls: file a Job, read the board, move a Job's phase — so a second consumer needs no CLI (*architecture/the-seam*) |
| `prisma/schema.prisma` + `src/db.ts` | the board — one SQLite file, one memoized client handle |
| `src/controller.ts` | `reconcile()` — one level-triggered pass over one board |
| `src/daemon.ts` | that pass on a timer, detached, over *every* board |
| `src/worktree.ts` | the sandbox: cut a checkout, carry declared files in, get outputs out, sweep |
| `src/runtime/` | the seam a worker runs behind — the Agent SDK, or a fake that spends nothing |
| `src/admission.ts` | the `PreToolUse` gate that makes worktree isolation and the tool surface invariants rather than instructions |
| `src/results.ts` | the named values a Job hands on, when its output is not a diff |
| `src/artifacts.ts` | the files a Job hands on that the board keeps and the repository does not |
| `src/inputs.ts` | what a Job is given: the read side, resolved before the run |
| `src/guide.ts` | the repository's own rules, read by hkb and put in front of the brief |
| `src/templates.ts` | a workflow: the file a Job is filed from, and the format that makes one authorable |
| `src/labels.ts` | the `key=value` pairs a Job carries, and the only thing that selects a set of them |
| `src/proposals.ts` | what a Job may ask the board to create, and every field it may not set |
| `src/watch.ts` | the event stream, followed — what the outside world reacts to |
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
outputs as **produced nothing** (`producedNothing`, `src/read.ts`). It is stated rather than judged: "I
looked, and there is nothing to change" is a real outcome, and so is a `--no-isolate` Job.

A Job can also declare its outputs, which is how it stops being coupled to a commit at all
([ADR-008](../decisions/adr-008-declared-outputs.md),
[ADR-011](../decisions/adr-011-proposals-not-board-access.md)). There are three, and they differ only
in **where the output goes**:

| | goes to | shape | capped |
|---|---|---|---|
| **`exports`** (`--export <path>`) | the repository | paths, copied out of the worktree before the checkout is torn down | no |
| **`results`** (`--result <name>`) | the board, as a value on the Attempt | a finding, a decision, a URL (`src/results.ts`) | 4 KB each |
| **`artifacts`** (`--artifact <name>`) | the board, as a file beside it | a report, a dataset, a proposal (`src/artifacts.ts`) | no |

One rule covers all three: **a declared output the run did not produce fails the attempt**, which is
what makes `succeeded` mean more than "a session ended". Everything else left in the checkout is litter
and goes with it.

A fourth thing a Job can declare is not an output but a **proposal**: `--propose` makes it write one
JSON file asking for Jobs it may not create itself, which a person approves and the *controller* then
files (`src/proposals.ts`, `features/proposals`). It rides the artifact channel because that is the
only one that is uncapped and outside the repository, and it is the one modelled way a workload
affects the board — there is no board handle in a sandbox, by decision
([ADR-011](../decisions/adr-011-proposals-not-board-access.md)).

An **artifact** fills the gap the first two left: too large to be a result, and no business in a commit.
Its path is handed to the worker absolute and outside every checkout — the same place a result is
written and for the same stated reason — so an output that must not be committed is never in the tree to
be committed by accident, and there is no copy step to get wrong. What lands on the Attempt is only the
*catalogue* (name, kind, size); the file stays where the worker put it and **is never removed**, because
nothing else holds it. That is why `hkb show` prints a size and a directory rather than a name alone.

### What a Job is given

The other direction, and the half ADR-008 never had: `inputs` (`--input <name>=<source>`) are content
the controller resolves **before the run** and puts in the prompt, ahead of the brief that is about
them (`src/inputs.ts`, `src/brief.ts`). Four sources, and none of them waits — `file:<repo-relative>`
reads the board's repository, `board` is the LLM-free board arithmetic, `value:<literal>` is a payload
the caller supplied, and `self:<field>` is the **downward API**. The fetched ones are **pull**;
`value:` is the **push** half, and it is what a webhook, a button or a Job-filing controller needs. An
input the board cannot read ends the attempt at `no_input` **without calling the runtime**, which is
the cheap mirror of `no_output`.

The stored shape is Kubernetes' `env`: a `name`, and then either a literal `value` or a `valueFrom`
object naming where to fetch one. The CLI string is sugar. A scheme prefix would have grown a query
language inside a string at the first source needing a second field, which is what `valueFrom` being an
object avoids.

**`self:slot` is the field that earns the downward API.** A worker could read nothing about itself, so a
brief wanting the attempt number had to hardcode one — wrong on attempt 2. `slot` goes further: it is
the lowest integer no other *live* lease holds, machine-wide, so it is the only fact answering "which
of the concurrent workers am I" — the question a run picking a port or a database name has to answer.
Allocated beside the lease and released with it, with `Lease.slot @unique` as the allocator: two
daemons compute the same free number, the constraint refuses the loser, and the claim path already
treats a failed lease create as "somebody else got there" (`src/controller.ts`).

A `value:` may also be interpolated into the brief (`{{name}}`, `{{name.field}}`), rendered at file time
so the stored brief is the one that runs (`renderBrief`, `src/inputs.ts`). **Only `value:`** — a fetched
source reaches the run as data and never as instruction, because the brief is the one field carrying
authority (ADR-010 decision 4) while `withInputs` labels everything else as data. Kubernetes draws the
same line letting `envFrom` fill `env` and never `command`.

The reason it is not just convenience is that it composes with a guard. Content in a prompt restricts
nothing by itself — a worker with `Read` finds whatever it likes. A Job declared with its inputs *and*
an `allowedTools` list without `Read`, `Glob` or `Grep` sees what it was given and cannot reach
further, because `src/admission.ts` refuses the rest. That pairing is what
`docs/workflow-study.md` §7 calls the read side.

A source that reads another Job's output is **refused by name**: that is an ordering edge, and ordering
between workloads belongs to a kind whose controller creates them, not to a field.

A run may also **volunteer** a result or an artifact: anything it writes beside the declared ones is kept
and never required. The difference between the two layers is what is *enforced*, not what is stored — a
declaration is the filer saying "this must exist", and a volunteered value is the Job saying "you did
not ask, but you should know". Hermes' structured handoff is the second layer alone, which is richer
and guarantees nothing, because a downstream reader cannot rely on a key existing.

Those three are what a Job with nothing to commit produces. `hkb ls` marks a succeeded Job that opened no
pull request and declared none of them as **produced nothing** (`producedNothing`, `src/read.ts`); with a
result or an artifact declared, the same Job says what it found instead.

## The gate — the one place a Job waits for a person

A Job may carry a `gate`: an attempt that succeeds **and** produced everything it declared does not go
terminal, it goes `suspended` and waits ([ADR-010](../decisions/adr-010-the-human-gate.md)). Approval
resumes the *same session* with the approver's own instruction as the prompt, which is what makes it a
gate rather than a pause — a resumed attempt otherwise re-sends the brief, and the Job would propose
again instead of applying.

Three properties are load-bearing and each has a test that makes it refuse:

- **The shortfall outranks the gate.** A run that did not produce what it declared *fails*; there is
  nothing worth putting in front of a human.
- **It is one-shot.** Whether an approval exists is read off the `Event` stream, not a flag cleared on
  use — a guard that fires on a transition is wrong after a restart. A re-entrant gate would delete
  the Job's completion condition entirely.
- **A suspended Job keeps its session and its checkout**, and is not `finishedAt`. It is waiting on a
  person, which is the one state that can last days.

The approver is a **seat**, not necessarily a person: a human, an agent delegated to, or an
auto-approve policy. All three write the same `approved` event with an actor, and the controller does
not know which answered.

## What is deliberately not here

- **A dependency graph.** Cards that depend on cards is a *second workload kind* that does not exist yet;
  its controller will create Jobs the way a CronJob creates Jobs, and its ordering rule belongs in the
  admission gate rather than in a prompt. `docs/rebuild-plan.md` holds the order.
- **An LLM anywhere in the controller.** The reconcile pass is arithmetic and SQL.
- **A merge.** hkb never merges. That is the one step a human keeps.
