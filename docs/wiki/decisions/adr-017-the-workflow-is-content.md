---
title: 'ADR-017: The developer workflow is content — hkb executes it, the board shows it'
summary: "hkb's records were all written from the machinery outward and none from the product inward, so the thing hkb exists for — a developer's own workflow, *implement → open a PR → review → notify*, authored as data and shown as a diagram — is nowhere a worker or a reviewer can read it, and four parts of the code and the record have drifted against it. This writes it down and names the drift."
category: decisions
kind: decision
audience: [dev]
read_when: "designing anything a user would call a workflow, a step, a review or a notification; hardcoding a step in the core; or citing the workflow study against representing a multi-step workflow"
status: accepted
date: 2026-09-08
supersedes: ~
superseded_by: ~
covers:
  - path: src/brief.ts
    sha: e34bc16f6bcd9864078e47ff114f0790e32a359e
  - path: src/templates.ts
    sha: 729c86b66042a5ad7aa3f38791fedf2b78a77707
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
generated_at_commit: 6075a95
last_refreshed: 2026-09-08
related:
  [
    decisions/adr-007-workload-scheduler,
    decisions/adr-010-the-human-gate,
    decisions/adr-011-proposals-not-board-access,
    decisions/adr-015-machinery-and-consumer,
    decisions/adr-016-the-pod-spec-is-the-map,
    features/workflow-templates,
    features/labels,
    features/proposals,
  ]
---

# ADR-017: The developer workflow is content — hkb executes it, the board shows it

## Context

Every decision record so far was written from the machinery outward. ADR-007 made hkb a workload
scheduler, ADR-015 drew the line between the machinery and its consumer, ADR-016 took the Pod spec
as the map for a workload's environment. Each is right, and none of them says what the machinery is
*for*. That was said in conversation, on 2026-09-08, and it is the reason hkb exists:

> A developer's own workflow — *implement → open a pull request → review it → tell someone* — is a
> workflow. It is authored as data, in Markdown or by an agent on the developer's behalf, the way
> the operator talks to an agent today. hkb is the machinery that executes it. The board is the
> product that shows it: click a running Job and see which step of which workflow it is, click the
> workflow and see the diagram. A code review is a step. "Send a Slack message" is a step with no
> agent in it. A user of the product never writes a controller and never reads hkb's code.

That is the Tekton shape on the Kubernetes primitive, and `prisma/schema.prisma`'s header already
commits to it structurally — *"a dependency graph is a second kind whose controller creates Jobs"*.
What was missing is the sentence above, in the record, where a worker's guide, a reviewer and
`wiki-check` can hold the code against it. Without it, four things drifted, each for a locally good
reason:

1. **The core hardcodes a step.** `withProtocol` in `src/brief.ts` tells every isolated Job to
   commit, push, `gh pr create --draft`, and wait for a human to merge. That is the workflow's
   second step, delivered as core prose to a Job whose workflow may have no pull request in it at
   all. The boundary inventory of 2026-09-07 already found it: *the git sandbox contract is core;
   the pull-request protocol is one consumer's opinion.*
2. **The template forgets it was a workflow.** `src/templates.ts`, by design: *"a template is
   applied by `hkb new --from <name>` and then it is gone… nothing in the controller, the runtime or
   `hkb show` knows a file was involved."* The reason is sound — the Job holds its values, so
   editing the file cannot reach a Job already filed — but the *name* went with the values, and the
   name is the one fact a diagram needs. Labels (`workflow=release step=draft`) are being written by
   hand to put it back.
3. **The study argues against the diagram; its own rule does not.** `docs/workflow-study.md` §3, in
   bold: *"hkb should not represent a multi-step workflow as a graph, and not as an edge either."*
   Its §5 then lists when a step earns its own row — *identity: a different repository, model,
   tool surface or trust level* — and a reviewer differs from an implementer in tool surface and
   trust by definition. The clarifying record §10 Q2 promised was never written, so the headline is
   what gets cited.
4. **The evidence against a machine edge was measured on a workflow with no review step.** Study §2
   rejects `Job.after` partly because *"all twenty-three dogfood Jobs ended in a draft PR awaiting
   a human — so every real boundary was already a human boundary."* True, and circular: with no
   review step there was nothing between *implement* and *a human*. A review step is precisely the
   thing that turns *implement → review* into an edge the machinery can take, because the review is
   what supplies the judgement `succeeded` lacks.

## Decision

1. **The developer workflow is content.** hkb ships no privileged workflow and knows no step by
   name. Its own workflows come through the same door as a user's (ADR-015 decision 4 said this for
   templates; it now covers the whole workflow), and a board's default workflow is a file, not code.
2. **A step is a workload, and a review is a step.** There is no review primitive: a review is a Job
   with a reviewer's brief, a read-only tool surface, a declared `result` for its verdict, and the
   implementing step's branch as its base. What makes it a *different* step is exactly study §5's
   criterion — a different tool surface and trust — so it earns its own row.
3. **An effect is a step with no agent in it.** *Post the message, call the API* — the primitive
   triage card #37 names. Deterministic, refusable, recorded on the event stream like any other
   step. Its design is not this record's.
4. **The board keeps the lineage the diagram needs.** A Job filed from a workflow records the
   workflow and the step. The file still governs nothing after filing — `src/templates.ts`'s
   argument stands for the *values* — but the *name* is kept, the way a Pod carries the name of the
   Deployment that made it. Labels remain what `features/labels` says they are: a grouping for
   whoever is looking, never the lineage and never a schedule.
5. **The pull-request protocol is a step's content.** `withProtocol` is split along the line the
   boundary inventory drew: the sandbox contract — commit on your branch, push it, never the
   default branch, never force — stays in the core; *open a draft pull request, a human merges* is
   the content of a step and moves to the workflow that wants it.
6. **A workflow with more than one actor is more than one Job, and what sequences them is a run.**
   This clarifies the study's §3 rather than superseding it: the study's recommendation was made for
   the case it examined — one actor, gated — and holds there; this record is about the multi-actor
   case it did not examine. The run is the object that makes a level-triggered controller possible
   for a workflow at all, and its shape is a later record's.

## What this does not decide

The shape of the run object, the DAG kind's controller, the effects primitive, and how the web
board renders any of it. Each wants its own record, written against this one.

## Consequences

**Easier.** Authoring: a workflow is a file a person or an agent can write with no hkb knowledge
beyond `hkb --help`, which ADR-015 already made the format's reference. The diagram: derivable from
lineage plus the run, with nothing invented for it. Review of the record itself: a proposal that
hardcodes a step, or a document that argues a workflow cannot be represented, can now be held
against a sentence rather than a memory.

**Harder, and accepted.** The core loses a default it silently had — a Job with no workflow gets
the sandbox contract and nothing else, so *a board needs a default workflow*, and it is a file that
ships with the board rather than prose in `src/brief.ts`. Until it exists, "produced nothing" is
the honest outcome for a Job nobody told to open a pull request, and it is reported as such.

**Follow-ups, each a card.** Decision 5: split `withProtocol` and ship the default workflow as a
file. Decision 4: record lineage on a filed Job and print it. Decision 6: the run object, and the
study's §6 clarification folded into its record. Decision 2: a reviewer workflow in
`.hkb/workflows/`, which is also the first real test of an edge the machinery takes on its own.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
