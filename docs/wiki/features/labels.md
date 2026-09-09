---
title: Labels and the selector (`--label key=value`)
summary: "The grouping key the board had none of: a string→string map on a Job, k8s-shaped, filed with `hkb new --label` and selected with `hkb ls --label`. Why a map and not a tag list, why the selector language stops at equality, and why nothing in the controller reads one."
category: features
kind: explanation
audience: [dev]
read_when: "grouping Jobs, adding a selector or a query to a consumer, or being tempted to schedule, own or cascade off a label"
covers:
  - path: src/labels.ts
    sha: b524ef31fce5611a1a676dfb4631aaa83ecba926
  - path: src/hkb.ts
    sha: 7b95039ab59dbcf5234373c716a5db86a15db8fb
  - path: prisma/schema.prisma
    sha: 4e4b7aa6863fad5e660435982912460565ebabf3
  - path: src/templates.ts
    sha: 1004bfccbdd46a7e2f875ba59d30d59b4107dbb9
related:
  [
    architecture/the-board,
    architecture/job-kind,
    features/proposals,
    features/workflow-templates,
    decisions/adr-015-machinery-and-consumer,
  ]
generated_at_commit: f063b7a
last_refreshed: 2026-09-09
---

# Labels and the selector (`--label key=value`)

> A **label** is a `key=value` pair on a Job, stored as a string→string map in `Job.labels`
> (`prisma/schema.prisma`). `hkb new --label workflow=release --label step=draft` files one;
> `hkb ls --label workflow=release` finds it again. That is the whole feature, and the interesting
> part of it is everything it deliberately is not.

## The question that could not be asked

Kubernetes composes almost entirely through labels: a Deployment finds its Pods, a Service finds its
endpoints, `kubectl get -l` finds whatever a human is thinking about. hkb had no such mechanism, so
*"the Jobs of this workflow"*, *"everything touching the parser"* and *"all my security triage"* were
unaskable — the board could be sliced by phase and by board, and by nothing else.

The nearest thing that existed is the proposal lineage triple
`Job(proposedByJobId, proposedByK, proposalIndex)` (`prisma/schema.prisma`, *features/proposals*). It
is a hand-rolled owner reference for exactly one case: the Jobs that one attempt proposed. It answers
its own question well and no other question at all, and it is not extensible into one — a second
grouping would have been a second triple.

## A map, not a list of tags

`Job.labels` is `Json?` holding `{"workflow":"release","step":"draft"}`. The alternative considered
and rejected was a flat list of tags, and the argument against it is short: **`workflow=release`
plus `step=draft` is the thing that gets wanted**, and a list can only say it by putting a separator
inside the tag — `workflow:release` — at which point the separator is a schema nobody wrote down, the
value sorts and prints as one opaque token, and every consumer that wants the pair has to re-parse
it. k8s reached the same shape for the same reason, so this is the k8s one.

Nullable, and that is both the modelling answer and the migration one (*architecture/the-board*): an
unlabelled Job has no labels, which is a different fact from carrying an empty map, and a nullable
column is a plain `ADD COLUMN` against a board a daemon may be running in rather than the
`RedefineTables` a required one would emit (`prisma/migrations/20260906234500_job_labels/`).

## The selector stops at equality, on purpose

`hkb ls --label k=v` is repeatable and the requirements are **ANDed**; an absent selector matches
everything (`selects`, `src/labels.ts`). There is no `!=`, no `in`, no `notin`, and no set-based
selector — k8s has all four, and every one of them is a query language to parse, to document, to keep
two consumers agreeing on and to keep working when the store underneath changes. Equality answers
the three questions above, which is the whole of what was asked for.

Two implementation facts follow from where the filtering happens:

- The selector is parsed **before** the board read, so a malformed one is a usage error rather than
  an empty listing — an empty listing would read as *"nothing matches"*, which is a wrong answer
  rather than a refusal (`src/hkb.ts`, the `ls` verb).
- The filtering itself is a `filter` over the rows, not a `where` clause. Prisma's JSON path filters
  are PostgreSQL and MySQL only, so SQLite cannot ask the question in SQL; `hkb ls` already reads its
  board in one query and shapes the rows in memory, so this costs no extra read (`src/labels.ts`).

## The fence: refused at file time, by name

`checkLabel` is the same fence as `checkResultName` and `checkArtifactName` (*features/declared-outputs*)
— it runs in `hkb new` before the board is touched, so an illegal request never becomes state.

The rule, written down once: **a key and a value are each a plain token — a letter or digit at each
end, letters, digits, `-`, `_` and `.` in between, 1 to 63 characters.** That is Kubernetes' own label
rule minus the optional DNS prefix on a key, and it is chosen for what it refuses. `=` cannot appear,
so `key=value` splits on its first `=` with no escaping. Whitespace and `,` cannot appear, so a label
survives being printed in a one-line listing. A leading or trailing `-`, `_` or `.` cannot appear, so
`env=` and `-workflow=x` get a message instead of becoming a group nobody can see.

Two refusals are hkb's rather than k8s':

- **An empty value is refused**, where k8s permits one. On a command line `--label env=` is a shell
  variable that did not expand far more often than it is a deliberate marker, and the fix for wanting
  a bare tag is to say what it is — `kind=triage` rather than `triage=`.
- **A repeated key is refused** rather than resolved last-one-wins (`parseLabels`, `src/labels.ts`).
  Both values are something the operator meant. On a *selector* it is sharper: the requirements are
  ANDed, so `--label a=1 --label a=2` is a question with no possible answer, and an empty list would
  be a plausible-looking wrong one. The same argument a workflow's repeated frontmatter key gets
  (`src/templates.ts`).

There is also a cap of 16 labels per Job (`MAX_LABELS`). Not a storage limit — it is the line between
a grouping and a payload. A Job carrying forty labels is using the map to store values, and `results`
is the column for values.

## Visible, or it is a surprise

`hkb show` prints a `labels` line with the spec, `hkb ls --json` carries a `labels` object on every
row — `{}` when there are none, so a consumer never infers absence from a missing key — and
`hkb new` echoes back what it filed. This is the argument `describeDefaults` already makes about a
board's defaults: a grant or a grouping nobody can see becomes a surprise the first time it changes
what a command returns.

Labels are also a workflow key (`label: [workflow=release, step=draft]` in
`src/templates.ts`'s `TEMPLATE_KEYS`), because the format's one rule is that **the keys are the
flags** (*features/workflow-templates*) — which is also the shape that makes "every Job from this
workflow carries `workflow=<name>`" a thing an author can write once.

## What a label deliberately does not do

**Nothing in the controller reads one.** No claim decision, no ordering, no ownership, no cascade —
`src/controller.ts` does not import `src/labels.ts`. The temptation is real and each of those is a
decision of its own:

- *Selectors in the controller* would be a second scheduling input beside the phase and the ceilings.
- *Owner references* — "delete these when that one goes" — need a cascade rule, and the board's
  cascades are foreign keys today (`onDelete: Cascade`, *architecture/the-board*), which a label
  cannot be.
- *Dependencies between Jobs* are a second workload kind, deliberately not present
  (*decisions/adr-007-workload-scheduler*).

A label is how **you** find work again; it is not how work finds work. That line is what keeps this
feature one pure module, one nullable column and two flags.

## Related

- [the-board](../architecture/the-board.md) — why the column is nullable, and what else lives on a Job
- [declared-outputs](declared-outputs.md) — the name fences this one is modelled on
- [proposals](proposals.md) — the lineage triple, the one grouping that predates labels
- [workflow-templates](workflow-templates.md) — why `label:` is a workflow key
