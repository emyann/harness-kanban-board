---
title: Runs and Steps — the second kind
summary: "Ordering, as a kind of its own: four columns of consequence, a pure `readyNow`, and everything else left in the workflow markdown. Why the owner reference sits on the Job, why there is no `phase` on a Step, and what v1 deliberately cannot say."
category: features
kind: explanation
audience: [dev]
read_when: "sequencing work, adding a field to Step, wondering why the Run controller cannot see a lease, or about to put ordering on Job"
covers:
  - path: src/runs.ts
    sha: 09ac35b9374b8aea9f9757af62585888938c9156
  - path: src/pass.ts
    sha: a179f059c5bf4e5703b40a0f2a7704fd2c226ef5
  - path: prisma/schema.prisma
    sha: 6e249ec160c4a441ad45255f65470bb94267cf6f
  - path: src/filing.ts
    sha: 8f04eb76130291b1bf89174799cf5ba1c23955e3
related: [decisions/adr-018-the-boundary, features/workflow-templates, features/proposals, features/labels, architecture/job-kind]
generated_at_commit: 26055f1
last_refreshed: 2026-09-10
---

# Runs and Steps — the second kind

The Job kind is *cut a workspace, run one agent session under limits, record what happened, clean
up*. Ordering is not in it, and `batch/v1` has no field for it either — so ordering is a **second
kind with a controller of its own**, built on the Job kind the way `tekton.dev` is built on
`batch/v1`. `src/runs.ts` is that controller; `prisma/schema.prisma` holds `Run` and `Step`.

## The one question the design answers

**A step is mostly markdown and barely data.** The split is not between a step's *parts* but between
two questions asked at two different times:

- everything a controller needs to decide whether to **create a row** is data;
- everything needed to **carry that decision out** is a file, read once, at the instant the Job is
  filed.

The test that produced the column list, and the one to apply to the next field somebody wants:
*delete it from the store, leave it only as bytes in a markdown file the controller may `cat` into a
prompt but never parse. Does any reconcile pass now reach a different create / flip / refuse
decision?* Operationally — **does evaluating it require reading a row other than this Step's own, on
every pass?**

`after` does. A `model:` does not: `reconcileRuns` hands it to `createJob` unread, and `createJob`
already reads it from `.hkb/workflows/<name>.md`, whose frontmatter has 21 keys
(`src/templates.ts`). A column for it would be a second place to edit one value, with the controller
still not looking at it. `docs/is-a-step-data.md` is the full derivation, including the two steps the
test refuses to place.

## Four columns, and where each one's absence bites

| Column | What breaks without it |
|---|---|
| `Step.runId` | The controller cannot enumerate one run in a single read, and a deleted `Run` leaves orphan steps. A real FK gives `onDelete: Cascade` — the half the proposal ownership link (`proposedByJobId`, three bare `Int?`) deliberately lacks. |
| `Step.name` + `@@unique([runId, name])` | `after` names siblings **by name**, because ids do not exist when the run is cut. This is exactly why `Job.after` was the wrong shape and `Step.after` is not (`docs/workflow-study.md` §2): a name is ambiguous globally and precise inside an owner. In v1 it doubles as the workflow filename, which is why v1 needs no file format at all. |
| `Step.after` | The only field any pass reads on every pass, which is what earns it a column. Tekton's `PipelineTask.runAfter` is the analogue, and it lives in a separate API group for the same reason this does. |
| `Job.stepId @unique` | Idempotency. See below — it is the field most likely to be "simplified" by someone who has not hit the failure. |

**There is no `Step.phase`.** A step's phase is its Job's, reached by a join. Tekton ran this
experiment and reversed it: `PipelineRun.status.taskruns` held a copy of every child's status, so
every child transition rewrote the parent, and TEP-0100 replaced it with `childReferences` —
deliberately without even the child's pass/fail bit. SQLite can join where etcd cannot, so hkb keeps
the reference and computes the rest.

## The owner reference is on the Job, and that is not arbitrary

`Job.stepId`, not `Step.jobId`. The reason is idempotency without a transaction: a second pass over
the same ready step tries to create a **second Job carrying the same `stepId`**, and `@unique`
refuses it with P2002, which `reconcileRuns` counts rather than raises. A parent-side pointer could
not do this — a duplicate Job gets a fresh id and no constraint would ever see it, so the filing and
the pointer would have to be one transaction, and a crash between them would mean two Jobs for one
step.

That is the rule `(proposedByJobId, proposedByK, proposalIndex)` is already written to, quoted from
the schema: *a constraint that refuses beats logic that has to be right.* Kubernetes puts the owner
reference on the child for the same reason it puts everything else there.

`onDelete: SetNull`: `hkb rm` on a Job is the operator saying *this run of the work is gone*, and the
Step is a **declaration** that outlives it. The next pass sees a Step with no Job and files another —
which is what deleting a Pod out from under a Job does in Kubernetes, and it is tested.

## `readyNow` is pure, and the refusing cases fall out rather than being handled

Five ways to be un-ready, and no branch in the code names any of them individually:

- **already filed** — `job` is not null;
- **a predecessor that has not finished** — its phase is not `succeeded` or `done`;
- **a predecessor that failed or was cancelled** — same clause, no special case;
- **an `after` naming a step that is not in the run** — the name lookup misses, so it is never
  satisfied. This is the direction that matters: a miss read as *"no predecessor"* would be
  indistinguishable from an empty `after`, and would file the whole run at once;
- **a cycle** — every step in it waits for a sibling that is itself unfiled, so none is ready and the
  run stops. No traversal, no visited set.

An empty `after` is ready (`[].every()` is true), so the first step of a run needs no special case
anywhere. `stalled()` is the other half: the steps that will never become ready without a person, so
that *waiting* and *stuck* get different words — they need different actions.

## Where it runs, and the seam that must not close

`src/pass.ts` composes the two controllers and is the **only** file that imports both. The Job
controller must never import `src/runs.ts` (ADR-018's direction of dependency), and the Run
controller must never import `src/limits.ts` or `src/liveness.ts` or name `Lease`. Both are asserted
in `test/boundary.test.ts`, because this line has dissolved before by being a description instead of
a check.

The rule behind it: **a step becoming ready is a *request* to schedule; whether it runs now is the
fleet's business.** hkb's scheduling half — ceilings, leases, liveness, slots, leader election — is
finished and reads no predecessor. Sequencing is the other half. A Run controller that grew its own
concurrency knob would be a second scheduler disagreeing with the first about a board they share.

Runs reconcile **before** the claim loop, for the same reason `applyProposals` does: a step whose
predecessor succeeded last pass becomes a pending Job and is claimable *in the same pass*, so an edge
costs no extra tick of the daemon's timer.

## Authoring

```
hkb new "the parser" --steps implement,review
```

One `Run`, one `Step` per workflow, each after the last. That is the whole authoring surface: no DAG
syntax, no new frontmatter grammar, no file format — argument order **is** the chain, and a step
**is** a workflow file. Every refusal happens before anything is created: a missing workflow, a
repeated step, a name that could not become the label `step=<name>`.

Nothing is filed by cutting a run. Rows eager, Jobs lazy — `JobSpec.suspend`'s shape. The first Job
appears on the next pass. `hkb ls --label run=<id>` follows it, which needed no new verb: every Job a
step files carries `run=<id>` and `step=<name>`. Kubernetes conflates ownership and grouping in
`batch.kubernetes.io/job-name`; hkb cannot, because **nothing in a controller may read a label**
(`src/labels.ts`) — so `stepId` owns and the labels only group.

## What v1 deliberately cannot do

Named here so the next person does not have to work out whether it was an oversight:

- **No conditionals.** `when: review.verdict == "changes-requested"` would need a predecessor's
  result *value* read on every pass, and `Attempt.results` is a JSON column that SQLite cannot filter
  in SQL (`src/read.ts`). This is the single reason `readyNow` is a pure function over rows rather
  than a Prisma `where` clause: when the condition arrives, the fix is a second argument, not a
  rewrite.
- **No fan-out.** A step that decides it has seven successors needs rows nobody wrote. The shipped
  mechanism sits next to the gap and cannot fill it: a proposal's allowlist is `name`, `brief`,
  `maxBudgetUsd` (`src/proposals.ts`), so a proposed successor can never carry a model or a tool
  surface.
- **No `finally`.** A step that runs *even if* an earlier one failed is a separate construct in
  Tekton, not a condition, because a `when` referencing a failed task's result is itself skipped.
- **Nothing flows along an edge.** A successor is filed because its predecessor **succeeded**, not
  because of anything it produced. This is not merely unbuilt — see the gotcha below.
- **No supervision.** *"If this one dies, cancel its siblings"* is death-triggered and often
  backward; a DAG edge cannot express it. It belongs as a Run-level policy field, next to `after`,
  the way Tekton puts `finally` and `retries` inside the pipeline kind.
- **A stalled run is silent in the daemon.** `stalled()` is recomputed every pass and deliberately
  writes no Event — a level-triggered reconciler that logged a standing fact would log it for ever.
  The foreground `hkb run` prints it; a detached daemon does not.

## Gotcha: why a value cannot yet cross an edge

The obvious implementation — pass a predecessor's result as `--input finding=value:<text>` — is
**unsafe as shipped**, and this is the reason the feature is absent rather than half-built.

`renderBrief` splices a `value:` input into the brief *at file time* and then **drops it from the
fenced data block** (`src/filing.ts`): *"A value that went into the brief does not also arrive as a
data block."* So it reaches the model as **instruction**, not as data. The licence permitting that is
written at `src/inputs.ts`: *"the filer supplied it and the filer wrote the placeholder."*

**When the filer is a controller, that licence is false** — the text came from a model. Using the
shipped mechanism unchanged would be prompt injection performed by the engine's own hands. So a
cross-step value needs a refusal before it needs a feature, and `test/runs.test.ts` holds the
standing proof that no interpolation happens today: a step whose workflow has an unfilled placeholder
is refused by name rather than filled from anything the controller has to hand.

## Gotcha: one broken workflow used to stop every board

`createJob` can genuinely fail for a step — the workflow file was deleted after the run was cut, its
body has a placeholder, a declaration in it is malformed. Left to propagate, that exception throws
out of `reconcileRuns`, out of `pass()`, and stops the **claim loop for every board, every tick**. It
is caught per step and reported as `stalled`, and the healthy run behind the broken one still files.
Found by running it, not by reading it.
