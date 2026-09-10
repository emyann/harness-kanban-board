---
title: 'ADR-015: hkb is machinery; the board is a consumer of it'
summary: "hkb is Kubernetes with an agent where the container goes. A kanban board is one way to consume that, not what it is — and the difference has been invisible because there has only ever been one consumer. This draws the line before the web board bakes it in: what belongs to each side, the rule that keeps logic out of the CLI's switch, and the dogfooding rule that hkb's own workflows must use the mechanism users get."
category: decisions
kind: decision
audience: [dev]
read_when: "adding a verb, adding a second consumer (a web board, an MCP server, an agent operator), or deciding whether something is a primitive or a product opinion"
status: accepted
date: 2026-09-06
supersedes: ~
superseded_by: ~
covers:
  - path: src/hkb.ts
    sha: 34ab3eea05412ec969d728978076d2634efdb1c5
  - path: src/controller.ts
    sha: 6563f3234641037e46504688115ac5ed4b76cf1b
  - path: prisma/schema.prisma
    sha: 6e249ec160c4a441ad45255f65470bb94267cf6f
generated_at_commit: 26055f1
last_refreshed: 2026-09-10
related:
  [
    decisions/adr-007-workload-scheduler,
    decisions/adr-011-proposals-not-board-access,
    architecture/overview,
    architecture/job-kind,
    architecture/transitions,
    architecture/the-seam,
    decisions/adr-017-the-workflow-is-content,
    decisions/adr-018-the-boundary,
  ]
---

# ADR-015: hkb is machinery; the board is a consumer of it

## Context

hkb is **Kubernetes with an agent where the container goes**. That is not an analogy the wiki reaches
for occasionally; it is the design, stated in the schema header and worked through in ADR-005 and
ADR-007 — a Board is a namespace, a Job is a Job, an Attempt is a Pod, a Lease is a Lease, and the
daemon is a controller-manager.

A **kanban board** — cards, columns, a lifecycle a human watches, a review step — is one way to
*consume* that machinery. It is not what hkb is. The name says otherwise, which is part of why this
record exists.

The distinction has been invisible so far because there has only ever been one consumer: the CLI. It
is about to stop being invisible, in three directions at once — a web board, an agent sitting in the
operator seat, and workflows that users author. Kubernetes has the same shape one layer down: Argo,
Tekton, Knative and Kubeflow are separate products built on ordinary CRDs and controllers, and *that*
is why other people could build them. If the machinery and the product are the same code, nobody can.

**The test, and today it fails.** Could a web board be built without touching `src/hkb.ts`? No. The
transition logic lives inside the CLI's `switch`: `queue`, `triage`, `approve` and `cancel` each hold
their guards and their writes in the verb body. A second consumer would duplicate them or shell out
to the CLI.

## Decision

**hkb is machinery. The board is a consumer. New logic goes in a module; a verb parses and prints.**

1. **The two sides, sorted.** The rule for telling them apart: machinery is what any consumer would
   need; a consumer is an opinion about how work should be organised for a person.

   | machinery | consumer |
   |---|---|
   | `Board` (namespace), `Job`, `Attempt`, `Lease`, `Event` | cards, columns, "in 3 hours", the kanban lifecycle |
   | the controller, the admission gate, the runtime seam, worktrees | the web board, "Discuss" |
   | declared inputs and outputs, gates, proposals, watch, triage | the specific workflows shipped or authored |
   | the **template format** | the **workflows written in it** |
   | what a worker inherits from the harness — tools, skills, MCP | which of those a given product chooses to expose |

   > One cell has moved since: **`worktrees`**. ADR-018 decision 2 found a third side to that
   > column — the *runtime's*. A PodSpec declares `volumes:` and never provisions storage, so the
   > workspace is declared on the runtime seam (`WorkerSpec.workspace`, `src/runtime/index.ts`) and
   > cut by the driver; what the machinery keeps is asking for one by name and collecting it on a
   > TTL (`src/workspaces.ts`). Row 2 of this table is why that lands where it does: what a worker
   > inherits from the harness is machinery, and *how* a workspace comes into existence is a
   > property of the harness rather than of the work.

2. **What a worker inherits from the harness is machinery**, and that settles a question that reads
   like a product one. A Job should be able to have what a session in the same harness has, because
   hkb's whole runtime story is "any harness can execute a workload" (value 1) and what a harness
   offers is a property of the runtime driver, not of a board. What varies by product is which of
   those capabilities are exposed and filtered — and *that* is the consumer's call.

3. **The template format is machinery; a workflow written in it is content.** This is the seam that
   makes "bring your own software factory" mean something: a workflow is a file, not code, so
   authoring one requires no hkb release and no hkb knowledge beyond the format.

4. **hkb's own workflows are ordinary workflows.** No privileged path, no `templates/` shipped inside
   the package, no second mechanism. hkb's defaults live in hkb's own repository under the same
   `.hkb/workflows/` that any repository uses. If we ship ours through a different door than the one
   we hand users, the user door will be second-class and we will not notice, because we never walk
   through it — which is the failure this project has already had five times under the name *a
   declaration nothing enforces*.

5. **No `src/ops/` layer today.** The extraction is deferred on purpose: there is one consumer, and
   this project's own rule is that a generic core is extracted from two or three working examples
   rather than guessed from one (ADR-007). What is adopted instead is a **rule with no cost**: logic
   goes in a module, and a CLI verb parses arguments, calls it, and prints. The seam then falls out of
   ordinary work, and by the time a second consumer exists most of it will already be on the right
   side of the line — with whatever is not made visible by the attempt.

## Consequences

**A verb that is hard to write under the rule is telling you something.** `queue` and `triage` were
written into the switch the day before this record, and are the first two that should move when they
are next touched. That is not a criticism of them; it is the rule doing its job.

> Done on 2026-09-07: every human-driven phase transition is now `src/transitions.ts`
> (*architecture/transitions*) and the verbs parse, call and print. This record is not superseded by
> it — decision 5 said the seam should fall out of ordinary work rather than be guessed, and that is
> what happened. What still fails the test above is **creating** a Job: `hkb new` holds
> `db.job.create` inside the switch behind ~190 lines of argument parsing.
>
> Done on 2026-09-09: creating a Job is `src/filing.ts` and reading the board is `src/read.ts`
> (*architecture/the-seam*), so the test above now passes for a Job. What remains inside the switch
> is a **board's** own lifecycle — `boards add`, `boards set`, `boards rm`, `stop`, `start` — which
> is the next thing to move on the same rule, when it is next touched.
>
> Done on 2026-09-10: this record's line is a **test that refuses**. `test/boundary.test.ts` holds a
> closed list of the Job kind's files and asserts that none of them imports any of the five git
> modules ADR-018 deleted — and that no file comes back under those names. That is decision 5's
> "the seam falls out of ordinary work" arriving with the one thing this record left out, and
> ADR-018 says so in its own opening: each of ADR-015, ADR-016 and ADR-017 *"left behind a
> description rather than a test, and a description is something the next session re-derives from
> whatever the code happens to look like by then."* This record is not superseded by that — it is
> the sentence ADR-018 enforces.

**The naming is unresolved, and this record does not resolve it.** "hkb" currently names the
machinery, the CLI and the product at once. Kubernetes has `kubernetes`/`kubectl`/Argo; hkb has one
word doing three jobs. The options are to name the consumer (as Argo did), to name the machinery, or
to leave it and rely on this record. It should be decided before anything is published under a second
name, and it is cheaper to decide it now than after a web board has a URL.

**Some things are not obviously on one side, and pretending otherwise would be worse.** The DAG kind
reads as machinery — it is a workload shape, not a product opinion — but it exists to serve a board's
idea of how work decomposes. `triage` is the same: a phase in the machinery, added because a person
needed an inbox. The rule in decision 1 is a rule, not an oracle, and a record that claimed otherwise
would be lying about how the last two features actually happened.

**This is a line to hold, not a refactor to schedule.** The cost of drawing it late is that a web
board reaches into the CLI and the two become one thing; the cost of drawing it early and wrongly is
an abstraction nobody needed. The rule is the cheapest thing that avoids both.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
