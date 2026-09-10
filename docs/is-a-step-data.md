# Is a step data, or can it live in markdown?

**Status:** a question to evaluate, written 2026-09-10, to be worked from a clean session.
**Read this file alone.** It is written to be actionable with no other context, and it carries the
evidence already gathered so that none of it is re-measured.

---

## The question

> In the vision of a system that runs agent sessions and loops the way Kubernetes runs containers:
> **should a step within a workflow be captured as data, or can it live in a markdown file?** And
> does the answer make it possible for people to coordinate, connect and manage a *fleet* of agents —
> and to author their own workflows that way?

It is one question with three parts, and the third is the one that decides the product:

1. **The mechanism.** What must be data for a controller to sequence steps at all?
2. **The authoring surface.** What can stay prose, so that a person writes a workflow rather than
   configures one?
3. **The fleet.** Does the split that answers 1 and 2 also let *many* agents be coordinated,
   connected and managed — or does it only serve one pipeline at a time?

## Why it is live now

`main` (`64c7034`) just finished the boundary work. The Job kind is now *cut a workspace, run one
agent session under limits, record what happened, clean up* — it has never heard of a branch, a pull
request, a review or a card. `docs/wiki/decisions/adr-018-the-boundary.md` is the record, and
`test/boundary.test.ts` is the guard that keeps it true.

**That is the floor this question is asked from.** Everything below assumes the Job kind stays
minimal and that whatever a workflow needs becomes a *second kind with its own controller*, the way
`tekton.dev` is a separate API group built on `batch/v1`. Do not reopen that; ADR-018 already
contains the argument and a greppable test for it.

## Evidence already gathered — do not re-measure

**Tekton's split, which is the closest prior art.**
- A **Task** is a list of **Steps**. Steps run *in the same Pod*, sequentially, sharing a volume.
- A **Pipeline** is a DAG of **Tasks**. Each TaskRun is *its own Pod*. Anything shared between them
  must be explicit: a Workspace (a PVC) or **Results** (small typed values passed along edges).
- **The boundary between the two is the Pod.** In hkb's terms, the Pod is *the session*.

**hkb already has both halves of Tekton's data plumbing, under other names.**
- `--result <name>` on a Job ≈ Tekton **Task Results** (a typed value the board keeps).
- `--input <name>=<source>` ≈ Tekton **params**. Sources today: `file:`, `board`, `value:`, `self:`.
- What is missing for edges is exactly one source: **`job:<id>.result.<name>`**, resolved when the
  controller *claims* the Job rather than when it is filed. That single addition is what makes "the
  rows exist now, the values arrive later" sound.

**The forcing case is real and already on the board: card #66.** *"A review step: a Job on Fable that
runs `/code-review` on the branch."* It needs a different model, a different tool surface (read-only —
in one session the surface is the *union*, so the reviewing half could write) and a different budget
from the implement step. **One session cannot be both.** So at least one edge between two Jobs is
required by work that already exists, which settles the narrow version of the question: *some* of it
must be data.

**Rows eager, Jobs lazy.** The operator's model, and it is Kubernetes': objects are declarations of
desired state and exist whether or not anything runs; a controller acts on the gap. `JobSpec.suspend`
is the exact precedent — a suspended Job object exists, is seen on every pass, and creates **no
Pods**. hkb's `triage` phase is that. So a workflow's rows may all exist and be visible on the board
while the controller creates a Job only as each step becomes ready. Nothing is eager except
*visibility*, which is the whole point of a board.

**What already exists to build on.** `Board.defaultWorkflow` + `.hkb/workflows/*.md`: frontmatter
fills a Job's unset spec fields at file time, and the body is appended as standing steps at claim
time. `.hkb/workflows/implement.md` now carries the entire git protocol as prose, and it works.
`labels` exist and `workflow=implement` is already one.

**The seven fields that fail ADR-018's own test**, from its field audit — these are the candidate
*contents* of a Step, and the list is not a coincidence: `proposes` (a Job that files Jobs is a
controller), `gate`/`suspendedFor`, `guide`, `exports`, `results`/`artifacts`, `endedBy`/`endedFor`.
They did not move because they had nowhere to go. **This question is where they go.**

## What to evaluate

1. **The line.** For a given step, what decides same-session vs. its-own-Job? The proposed test is:
   *does the next step need something the previous session had that cannot be declared?* Stress it.
   The reasoning, the half-formed intent, the thing it noticed but did not write down — is that a
   real category, or does declaring outputs always suffice in practice?
2. **What must be data.** Minimum viable: ordering, and what flows along an edge. Is that all? What
   about conditionals, fan-out, and a step that decides how many successors it has?
3. **What can stay prose.** A step's *content* clearly can. Can its spec (model, budget, tool
   surface) stay in frontmatter, or does the graph need it structured?
4. **The compile step.** If markdown is authored and rows are derived from it, what happens when the
   file changes after rows exist? (`Board.defaultWorkflow` composes at claim time *precisely* so
   editing the file changes the next attempt — does that property survive a graph?)
5. **The fleet question, which is the least explored.** Coordinating many agents is not the same as
   sequencing one pipeline. What does "connect" mean — shared workspace, messages between live
   sessions, or only edges between finished steps? (`hkb-future-cross-messaging` in the operator's
   memory parks a related direction: a parent briefs children and tells them to talk when their paths
   overlap.) Does the Step design serve that, or foreclose it?
6. **The row-count problem.** Eager rows multiply: a 5-step workflow across 10 features is 50 cards
   where a human wanted 10. Labels exist; is "a run is one card that expands" a display concern or a
   kind?

## Traps

- **Do not design the file format first.** The method that worked on ADR-018 was: build the smallest
  thing, run it, see what it cannot say. #66 is the smallest thing.
- **Do not put ordering on `Job`.** `Job.after` was rejected on four counts in `docs/workflow-study.md`
  §2 and ADR-018 says ordering belongs to a second kind. The edge lives on the Step row.
- **Do not assume Tekton wholesale.** Tekton pipelines are deterministic; an agent step is not, and
  a step that *decides* something is a shape Tekton has no answer for.
- **Do not file cards.** The operator's standing rule: no new card until the board's kinds exist.
  This document is not a card.
- **A dynamic workflow evaluating this is Claude Code's own machinery, not hkb's** — it does not
  touch the dogfooding pause.

## What would count as an answer

A recommendation with a *test* in it, not a preference — the thing ADR-015, -016 and -017 each
lacked and had to be re-argued for. Concretely: a rule that says, of any step somebody writes, which
side of the line it falls on and why; the minimum set of fields a Step row must carry; and the first
thing to build, which should be small enough to be wrong cheaply.
