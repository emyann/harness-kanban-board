# Is a step data, or can it live in markdown?

**Status: ANSWERED, 2026-09-10.** The question below was written first and evaluated second, from a
clean session, by a fifteen-agent workflow: six research lanes, one adversarial refuter each, two
opposed drafts and a synthesis. **The answer is the second half of this file** — the question is kept
above it unedited, because a recommendation is only checkable next to the question it was asked.
Nothing here is built yet, deliberately: the answer names one thing to build and what would falsify
it, which is the order ADR-018 was arrived at and the order this project keeps getting right.
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

---

# The answer

**One-paragraph answer.** A step is *mostly* markdown and *barely* data, and the split is not between a step's parts but between two questions asked at two different times. Everything a controller needs to decide **whether to create a row** is data; everything needed to **carry out that decision once taken** is a file, read once, at the moment the Job is filed. That leaves four columns on a `Step` row — `runId`, `name`, `after`, `jobId` — and puts the entire rest of a step, including its model, its budget, its read-only tool surface, its human gate and its whole instruction, in `.hkb/workflows/<name>.md`, which already parses 21 frontmatter keys and already carries a whole git protocol as prose (`src/templates.ts:77-105`; `.hkb/workflows/implement.md`; `test/boundary.test.ts:41` lists the five modules ADR-018 deleted against that file). The brief's own forcing case, card #66 — verified on the board as *"The review step: a Job on Fable that runs /code-review on the branch it is based on, verdict and findings as results, read-only fence proved across the fan-out"*, phase `triage` — forces a second **Job** and forces **zero** Step columns for any of its spec. The thing everyone reads as proof that a step must be data proves only that a step must be a separate session. Disagree with this by naming a reconcile pass that reaches a different create/flip/refuse decision with a fifth column that it could not reach with four; nobody in six lanes could.

---

## The rule

**Delete the piece from the store and leave it only as bytes in a markdown file the controller may `cat` into a prompt but never parse until the instant it files a Job. Does any reconcile pass now reach a different create / flip / refuse decision?** Yes → a `Step` column. No → the file; and within the file, frontmatter if `hkb new` has a flag of that name (mechanically: the key is in `TEMPLATE_KEYS`, `src/templates.ts:77-105`), body otherwise.

The operational form of "does it change a decision" is: **evaluating it requires reading a row other than this Step's own, on every pass.** If you cannot name the second row, it is not a decision input. If you can name it but only need it once, after readiness has already been settled, it is on the carry-out side.

| Step | Side | Why |
|---|---|---|
| "Commit on your branch, rebase onto your base, push that branch, open a draft PR, never merge it yourself." | **File, body** | Names no second row; the controller concatenates it into `Job.brief` and never looks again. Shipped existence proof: `.hkb/workflows/implement.md`, against which ADR-018 deleted `worktree.ts`, `push.ts`, `pre-push.ts`, `rebase.ts`, `pulls.ts` (`test/boundary.test.ts:41`). |
| "Review runs after implement." | **Column (`after`)** | Names implement's row, and every pass must read that row's phase to know whether to act. The only irreducible field in the design. |
| **#66: "The review runs on Fable, read-only, with a $2 budget."** | **File, frontmatter** | *Surprising.* `model`, `allow-tools`, `max-budget` are already `TEMPLATE_KEYS`. #66 forces a second **session** — one allowlist per session (`src/admission.ts:95-98`), and model/budget/turns are `query()` options fixed at session start with no setter reachable from a string prompt (`src/runtime/claude.ts:60-98`; SDK 0.3.261 marks `setModel` "only available in streaming input mode"). It forces no Step column at all. |
| "Wait for a human to approve before the next step." | **File, frontmatter (`gate:`)** | *Surprising.* One of ADR-018's seven orphans, and it moves nowhere. `Job.gate` suspends a successful attempt; `hkb approve <id> <instruction>` writes an `approved` Event and the next attempt resumes the **same session** with the approver's words as the prompt (`src/controller.ts:1262-1264, 1702-1721`; `src/transitions.ts:199-222`). A human gate between two steps needs neither an edge nor a kind. |
| "Be skeptical of the implementer's own account; check the test, not the claim." | **File, body** | *Surprising.* This is the field everyone reaches for first (`rigor: high`, `reviewer-persona: skeptical`) and the rule refuses every spelling of it. A knob no controller reads is a knob whose only effect is that a string reaches the model — which the body already does, for free, with more nuance. |
| "The fix step reads the review's finding." | **File for the payload and the mapping; the edge is the `after` that already exists** | The Step controller reads the predecessor's `Attempt.results` (`prisma/schema.prisma:577`) once, at the instant it files the successor. Which result feeds which input is one `input:` line in the successor's frontmatter. **But see the correction in "Evidence that changed the answer": the shipped interpolation path is unsafe for this and needs a refusal.** |
| "Skip the fix unless the review said changes-requested." | **Column (`when`) — and deliberately not yet** | Names the review's result row and must be evaluated every pass, so the rule says column unambiguously. It is the first thing this design grows and it is not in the minimum, because no conditional workflow has ever been written on this board and no controller *failure* is nameable for it — only a wasted session. |
| "Post the outcome to Slack when the run is over." | **File, body** (no `--slack-channel` flag exists) — with **`after: [every leaf]`** as the column | A step no lane considered, placed cold in two questions. Now add four words: *"…even if an earlier step failed."* → **column (`always`)**. The same sentence splits across the line. Tekton needed this as a separate construct (`finally`), not a condition, because a `when` referencing a failed task's result is itself skipped. |
| "File one follow-up Job per unresolved finding." (fan-out) | **Declaration on the consumer, per prior art — but hkb cannot express it** | GHA (`matrix: fromJSON(needs.job1.outputs.colors)`) and Argo (`withParam`) both put the parse at the consumption site. hkb's shipped fan-out is `proposes`, whose allowlist is `name`, `brief`, `maxBudgetUsd` only (`src/proposals.ts:71`, verified) — so a proposed successor **structurally cannot be #66**: it cannot name a model or a read-only surface. Partial refusal; see "does not settle". |
| **"Deploy when the pull request merges."** | **REFUSED** | The rule fails and so does the redaction test. It names a second row that is not a row: the fact lives in the forge, ADR-018 forbids the core from naming one, and `pulls.ts` was deleted rather than moved (`test/boundary.test.ts:41`). The Step kind could own a forge reader — the board kind is allowed to — but nothing in this rule tells you it should, and no field name falls out. A rule with no edge is a rule nobody stress-tested; this is the edge. |
| **"Run the summariser even if the review failed, and give it the review's findings."** | **REFUSED** | `always: true` and a value from a step that produced none are contradictory. Tekton hit exactly this and documents it as a limitation of `finally`, not a bug. No field resolves it; a design decision does. |

---

## What must be data

Four columns. Two tables. Zero changes to any `Job` column, zero new input sources in the core, zero changes to the claim loop in `src/controller.ts`.

| Field | What breaks without it | Analogue |
|---|---|---|
| `runId Int` (FK, indexed) | The controller cannot enumerate one run's steps in a single read, cannot cascade a cancel, and cannot answer "is this run finished". A real FK gives `onDelete: Cascade` for free — the half hkb's existing ownership link deliberately lacks (`proposedByJobId`/`proposedByK`/`proposalIndex` are three bare `Int?` with no `@relation`, `prisma/schema.prisma:465-467`). | `metadata.ownerReferences[0]` with `controller: true`. **Not a label**: `prisma/schema.prisma:396-399` and `src/labels.ts:28-30` both forbid the controller reading one, so hkb needs the owner-ref *and* the label doing different jobs where Kubernetes conflates them in `batch.kubernetes.io/job-name`. |
| `name String` + `@@unique([runId, name])` | Two failures. **Idempotency**: a level-triggered pass may run twice or die halfway, and hkb's shipped answer is a database constraint rather than controller memory — `@@unique([proposedByJobId, proposedByK, proposalIndex])` with P2002 caught (`prisma/schema.prisma:477`; schema comment at `:460-462`: *"a constraint that refuses beats logic that has to be right"*). **Addressability**: `after` names siblings by name because Job ids do not exist when the run is cut. This is exactly why `Job.after` was wrong (a link with arity 1 between siblings of the same kind, `docs/workflow-study.md:38-58`) and `Step.after` is fine — the name is scoped inside an owning parent. In v1 it doubles as the workflow filename, which is why v1 needs no file format at all. | Tekton `PipelineTask.name`, which is what `runAfter` refers to. |
| `after Json` (array of sibling names, default `[]`) | **The only field read on every pass**, and the only thing here a markdown file genuinely cannot hold. A broken `.hkb/workflows/*.md` already fails filed isolated non-proposing Jobs terminally and **unresumably** after the attempt row was created — `readTemplate` throws → `stepsShortfall` → `inputShortfall` → `{ phase: 'failed', outcome: 'no_input', resumable: false }` (`src/controller.ts:1163-1174, 1400`, verified verbatim; refusing test at `test/controller.test.ts:3086`). Readiness must not inherit that blast radius. Empty array = ready at cut, so the first step needs no special case. | None in `batch/v1` — **and that absence is ADR-018's whole argument.** This is Tekton `PipelineTask.runAfter`, which lives in a separate API group with a separate controller. |
| `jobId Int? @unique` (FK) | `@@unique([runId,name])` stops a duplicate *Step*; nothing stops a second pass filing a second *Job* for the same step, because Step rows are eager. `jobId IS NULL` is the gap the controller acts on and `IS NOT NULL` is the receipt. It is also the join that makes a Step's phase **derived**: `jobId === null ? 'waiting' : job.phase`. A `phase` mirror would be rewritten on every child transition — TEP-0100's first stated motivation, relocated into a single-writer SQLite file. | Tekton `PipelineRunStatus.childReferences[]` — a *reference*, kept after `status.taskruns` (a copy) was removed in v0.45 (PR #6099, merged 2023-02-13). Tekton explicitly rejected copying even the child's pass/fail bit as "unnecessarily consuming storage". SQLite can join where etcd cannot, so hkb should keep the reference and compute the rest, the way `boardSummaries` already derives eight counters from one joined read (`src/read.ts:96-101`). |

**Fields deliberately excluded, with the failure nobody could name.** `phase` — derivable by join. `spec` — the losing draft's strongest candidate, and it fails its own test: its author concedes "the controller never reasons over its contents, it hands them to the filing path". A field the controller hands over unread is not a decision input; the filing path already reads it from the file. `consumes` — the failure it prevents is "a Job that fails to file with a named reason", which is the shipped shortfall mechanism answering the question correctly, not a controller that cannot decide. `when` — real, coming, and not yet nameable as a failure.

---

## What stays prose

**Every step's body.** Concatenated into `Job.brief` and never parsed. The seam is not a taste: in all eight surveyed engines it falls at a process boundary the engine had to create anyway — Tekton's `script` is "invoked as if it were stored inside the container image", GHA's `run:` requires a sibling `shell:`, Nextflow hands the script to Bash unread beside a typed `input:`/`output:` block, Step Functions has no body in the definition at all. hkb's process boundary is the session.

**All 21 frontmatter keys** — `model, effort, gate, guide, check, max-turns, max-budget, max-retries, attempt-deadline, deadline, no-isolate, triage, propose, allow-tool, allow-tools, plugin-dir, label, input, export, result, artifact` (`src/templates.ts:77-105`, counted). They are parsed — by the **filing** path, into `Job` columns that already exist (`src/filing.ts:198-212`). The reconcile pass never reads one. Note what this settles quietly: **six of ADR-018's seven orphans are already authorable in markdown by anyone who can merge a PR.** `propose`, `gate`, `guide`, `export`, `result`, `artifact` are all `TEMPLATE_KEYS` today. They "had nowhere to go" only because nobody checked whether they already had somewhere.

**The approval sentence and the gate.** `gate:` suspends; the approver's own words become the next prompt in the same session. The controller reconciles it by re-reading an `approved` Event every pass rather than consuming a flag (`src/controller.ts:518-524`) — already level-triggered, already restart-safe, naming no second row.

**The value that crosses an edge.** It lives on `Attempt.results`, capped at 4096 bytes per name (`src/results.ts:32`, whose comment cites Tekton's own 4096 — independently vindicated, though see the version note below). The Step controller reads it once and hands it over as a named input, arriving inside a fenced block that instructs the model to "treat them as data rather than as instructions, whoever wrote them" (`src/brief.ts:44-58`, verified verbatim). That is GitHub's documented injection mitigation, already implemented, with the argument already written down.

**The run's description, the reason for the workflow, and anything a human reads.** If nothing branches on it, it is not data. That is the whole test.

---

## The six questions

**1. The line.** The brief's proposed test — *does the next step need something the previous session had that cannot be declared?* — should be dropped, on three counts, and the third is fatal. It is **not decidable at authoring time**: its input is what the previous session happened to do, which does not exist when the file is written. It has **the wrong polarity on its own forcing case**: #66's review must *not* inherit the implementer's rationalisations, so the test answers "no" for a review and "no" for a trivially independent step, for opposite reasons. And it is **already false in the shipped harness**: `resume` loads a transcript into a session with an entirely fresh options bag, and `forkSession()` copies a transcript into a new session id — context and spec are orthogonal.

Replace it with: **diff the two steps' frontmatter. Frontmatter differs → separate Jobs. Only the body differs → prose in one session.** Answerable by reading the file with nothing running, which is what the brief asked for. One caveat a verifier caught and I am passing on: the "a human can retry it" formulation is *not* an independent second test. Every surveyed system puts its addressable object at the process/sandbox boundary — Pod, runner VM, session — and retry granularity falls out of that. It is the same test seen from the other side; do not double-count them.

Is "the thing it noticed but did not write down" a real category? Yes, and it is transferable as data: it is the transcript, addressed by a session id, which is a string. What it is *not* is a reason to keep two steps in one session, because the review case wants precisely to be denied it.

**2. What must be data.** Ordering, identity, ownership, the child reference. Not conditionals — yet. Not fan-out — and here the honest answer is a gap, not a design. Prior art all does runtime fan-out from data-authored workflows (Argo `withParam`, GHA `fromJSON` matrix, Airflow `.expand` cap 1024, Tekton matrix cap 256 behind a beta flag), and all of them require the width to arrive as a **typed array**, which an agent's prose output is not. hkb's shipped fan-out, `proposes`, is structurally the right shape — the worker writes a validated JSON file and only the controller creates rows (`src/brief.ts:383`; `src/controller.ts:501-580`) — but its three-key allowlist means a proposed successor can never be #66. Nobody in six lanes closed this. It is the largest hole in the recommendation and I decline to invent a mechanism for it.

**3. What can stay prose.** The content, obviously and provably. And the spec — all of it. The graph does not need the spec structured because the graph never reads it; the *filing path* does, and it already reads it from frontmatter. Contra the losing draft: `query()` options being fixed at session start proves the spec must be **decided before a session exists**, not that it must be **stored on a row**.

**4. The compile step.** hkb already contradicts itself and both halves are right for different things. `--from` freezes at file time and "then it is *gone*" (`src/templates.ts:29-35`); `Board.defaultWorkflow` re-reads the **body** at claim time so that "editing the workflow changes the next attempt, including the next attempt of a Job filed last week" (`src/controller.ts:1153-1156`), while discarding `t.spec` (`:1166`). The rule that resolves it: **structure freezes when the run's rows are cut; content and spec ride the file.** Late-binding *content* is recoverable — fix the file and retry. Late-binding *structure* is not: step 4 can vanish after step 3 succeeded and there is no retry for a row that was never cut. Since Run and Step rows are cut eagerly, structure is frozen automatically and no versioning machinery is needed. The prior-art support here is weaker than one lane claimed and I am restating it honestly: Step Functions' `UpdateStateMachine` guarantees only that "running executions will continue to use the previous `definition` and `roleArn`" — a base property with no version registry involved — and **no surveyed system implements a deliberate structure-frozen / content-late-bound split.** That is hkb's own move, not borrowed.

**5. The fleet.** See below. Short form: three problems, not two.

**6. The row count.** Both a display concern and a kind, and the kind is forced by everything else in this document rather than by the row count. What actually fixes 50 cards is three things none of which is a kind: a default scope on the listing (partly shipped — `hkb ls` is board-scoped and takes `--phase`/`--label`), a **labels column in the human renderer** (`src/hkb.ts:810` prints `#id phase N× name` and nothing else, while `--json` already carries labels), and a **retention limit**, which hkb has never had — `BUILT_IN_TTL_SECONDS = 3600` (`src/workspaces.ts:48`) reclaims *workspaces* and never rows; the only row deletion is manual `hkb rm`. Note the ADR-018 test resolves this cleanly: `batch/v1`'s `ttlSecondsAfterFinished` deletes the **Job object** cascadingly and has been stable since k8s 1.23, so row reclamation is a **core** field hkb narrowed to the workspace, not a parent-kind field it must import from CronJob. Prior art is decisive on the store shape: Argo put the whole graph in one object and paid with gzip plus an out-of-band SQL database, and had to reinvent per-node addressing as `--node-field-selector id=5`; Tekton and Kubernetes kept many objects and filtered the listing. And the hkb-specific killer for one-row-per-run: **SQLite cannot filter a JSON column through Prisma** (`src/read.ts:187-189`, verified verbatim), so a graph in a `Run.graph` column makes the controller's own readiness question unqueryable, where step-as-row is an indexed `where` on `@@index([boardId, phase])`.

---

## The fleet

**This serves a fleet, and it adds no fleet field, because hkb's fleet half is finished — and its finishedness is the evidence that these are separate features.** Not one scheduling primitive reads a predecessor: `gateClaim`'s three ceilings (`src/limits.ts:63-103`, one call site), the `Lease` compare-and-swap with `slot Int? @unique` as the allocator (`prisma/schema.prisma:639-658`, "the StatefulSet ordinal"), `holderLiveness` from host+pid+boot-time, both deadlines, per-board leader election via the `Controller` row (`src/daemon.ts:39-42`, "leader election, not exclusion"), a restartable cursored watch modelled on `resourceVersion` and shipped as `hkb watch`, and a downward API telling a worker which of the concurrent workers it is (`self:slot`, `src/inputs.ts:68-79`). Ten runs of five steps is ten times one run with zero new mechanism, because Run/Step creates Jobs and Jobs are what the fleet schedules. `batch/v1` corroborates: parallelism, completions, backoffLimit, activeDeadlineSeconds — **and no ordering field at all.**

**But "fleet and workflow are two problems" is where both drafts stopped, and it is one problem short.** They agree because they read the same inventory, and the inventory is an inventory of *scheduling*. What people mean by "manage a fleet" is three things:

- **Scheduling** — who runs now, under what ceiling, holding which slot. **Built, completely.**
- **Sequencing** — what runs after what, carrying what. **Absent. This document.**
- **Supervision** — what happens to the *set* when one member dies. **Absent, and neither draft's minimum touches it.** hkb cannot say "if this one dies, cancel its siblings", "restart these three together", or "this run has failed four times in an hour, stop and tell a person". That is OTP's `one_for_all`/`rest_for_one` and MaxR-in-MaxT escalation, and Step Functions' `ToleratedFailurePercentage` / `ToleratedFailureCount`. hkb has per-Job `maxRetries` and board-wide `dailyBudgetUsd`/`maxConcurrent` and nothing set-wide. **A DAG edge cannot express any of it, because it is death-triggered and often backward.**

Supervision does have a home — a verifier correctly refuted the claim that it has none: Tekton puts `finally`, per-task `retries` and `timeouts` *inside the pipeline kind*, right next to `runAfter`. So it is a **Run-level policy field**, not an edge, and it lands in the same second kind. I have deliberately left it out of the minimum, which means **the minimum is provably sufficient for a sequenced fleet and provably insufficient for a supervised one.** Say that out loud rather than discovering it.

**The boundary rule, greppable in `test/boundary.test.ts`'s exact shape:** a Step becoming ready is a *request* to schedule; whether it runs now is the fleet's business. `src/runs.ts` must not import `src/limits.ts` or `src/liveness.ts` and must never touch `Lease`. If the Run controller grows its own concurrency knob, the two features have re-conflated.

**What it forecloses: nothing, if one thing is respected.** Keep readiness a **pure function over rows** — `readyNow(steps, jobs)` — rather than a JOIN buried in a Prisma `where`. Then the day a message must wake a step, it is a second clause reading the `Event` table, which already carries `kind`/`jobId`/`boardId`/`payload` with `@@index([jobId, id])` and is already what the controller reconciles the approval from. The foreclosure risk is not the edge; it is a readiness rule whose only clause is "my predecessor succeeded", hard-coded into SQL. Two live-coordination primitives that prior art ships cheaply land the same way, as clauses rather than subsystems: a suspend node for a human (hkb already has it as `Job.gate`) and a **named mutex/semaphore in the same store** — Argo's DB-backed synchronization, which works across concurrently running workflows and which one lane wrongly reported as nonexistent. hkb has one SQLite file; that primitive is nearly free.

Honestly: this connects *finished* steps to *unstarted* ones. It is not cross-messaging. The two measured mid-flight channels (`interrupt()` on a string prompt; `canUseTool` deny-with-message at $0.061) are both **answers to an agent that asked**, not unsolicited delivery, and unsolicited delivery remains unmeasured because hkb's driver passes a string prompt and cannot reach `Query.streamInput`.

---

## The first thing to build

**One migration, one pure module, one reconcile hook, one verb — and no file format.** Named against this codebase.

1. **Migration** (hand-written from `npx prisma migrate diff`, per CLAUDE.md). `Run { id, boardId, name, createdAt }`. `Step { id, runId, name, after Json @default("[]"), jobId Int? @unique, @@unique([runId,name]), @@index([runId]) }`. No `phase` on either — both derived by joining `Step.jobId → Job.phase`. No change to any Job column, no change to `src/inputs.ts`, no new input source.

2. **`src/runs.ts`** — a pure function `readyNow(steps, jobPhases): Step[]`, no I/O, returning steps whose `jobId` is null and whose every `after` name maps to a Job in `succeeded`. Exhaustive test at shipped defaults **against the refusing cases**: an `after` naming a step that does not exist, a predecessor `failed`, a predecessor `suspended`, a cycle. This is the `src/limits.ts` / `src/liveness.ts` / `src/spec.ts` pattern CLAUDE.md names, and it is what makes the design falsifiable without spending a cent.

3. **`reconcileRuns(db, deps)`**, called from the same pass where `applyProposals` already sits, before the claim loop, for the same reason. One read per board of unfinished Steps plus their Jobs' phases; for each ready Step call the **existing** `createJob(db, scope, { from: step.name, ... }, { by: 'runs' })` and set `jobId` in the same transaction, catching P2002 exactly as `src/controller.ts:569-573` does. Reuse `createJob` rather than `db.job.create` — `applyProposals` bypasses it, and that is the one thing about the shipped precedent not worth copying.

4. **`hkb run <workflow> <workflow> … --name "…"`** — cuts one Run and a **chain** of Steps from argument order, `after: [previous]`. That is the entire authoring surface of v1. No frontmatter grammar change, no `##` sections, no DAG syntax. A chain is enough for #66 and enough to discover what a chain cannot say.

5. **Two guards that must ship with it, because each is a refusal and CLAUDE.md requires every new guard to have a test that makes it refuse.** (a) Extend `test/boundary.test.ts` with the fleet/sequencing seam: assert `src/runs.ts` imports neither `src/limits.ts` nor `src/liveness.ts` and never names `Lease`. (b) **Refuse interpolation of a cross-step value into a successor's brief** — see the next section; this one is not optional.

**Then run it on card #66: `hkb run implement review --name "…"`, and write down the first three things it cannot say.** Predicted, and each is worth more than any format designed in advance:

- **(a)** `.hkb/workflows/review.md` does not exist. Writing it is the real authoring test, and the moment you find out whether "read-only reviewer" survives contact with a 21-key frontmatter grammar that has no nesting, no block lists and no continuation lines (`src/templates.ts:257-264`).
- **(b) A documented gap the first run walks straight into.** The board’s `defaultWorkflow` (board 1 = `implement`) is appended as standing steps to **every isolated non-proposing Job at claim time**, and `src/filing.ts:159` gates it only on `propose`/`no-isolate` — **not** on `--from`. So the reviewer will be told to commit, push and open a draft pull request. This is *not* an undiscovered bug: the reasoning is written out at `src/filing.ts:147-157`, which records that excluding `--from` never stopped the composition and only made `hkb new --json` disagree with `hkb show --json` about the same row, and that restoring the old intent needs the Job to remember its workflow — #45’s lineage column. What the first run adds is the demonstration that the gap has a *victim*, which a comment could not supply.
- **(c)** Passing the diff or the findings from implement to review needs a name for the result and a name for the input. Grow the file format **there**, once, having seen it.

**This also repairs a live boundary violation rather than adding one.** `src/controller.ts:7` imports `readTemplate, withStandingSteps`; `:1165` reads a `.hkb/workflows/*.md` file and fails the Job terminally when it cannot. `controller.ts` is on `test/boundary.test.ts`'s closed `THE_CORE` list (verified, 13 files, `templates.ts` not among them) while ADR-018:56 says the machinery "has never heard of a branch, a pull request, a review, a card, a column or a workflow." The guard misses it because it greps only for git and forge names. **The core already names a board concept, and the claim-time half of the split everyone celebrates is what does it.**

**What would falsify the whole recommendation.** If writing `review.md` requires a frontmatter key that is not already a `hkb new` flag, the "grep the table" half of the rule is a fiction and the file format needs designing after all. If `readyNow` cannot be written as a pure function over rows — because the first real condition anyone wants requires a predecessor's result *value* on every pass — then the four-field minimum was never minimal and the design should have started at seven. And if a two-step chain turns out to need `hkb retry` at step granularity in a way `hkb retry <jobId>` does not already give (it does), the row-per-step premise is wrong.

Total: two tables, four columns of consequence, one pure function, ~60 lines of reconcile. Cheap enough to delete.

---

## What this does not settle

- **Fan-out.** A step that decides it has seven successors needs rows the author never wrote. The shipped mechanism (`proposes`) sits right next to the gap and cannot fill it: its allowlist is `name`, `brief`, `maxBudgetUsd` (verified, `src/proposals.ts:71`), so a proposed successor cannot name a model or a tool surface. Every prior-art fan-out requires a typed array from the producer, which agent prose is not. No lane closed this.
- **Whether `consumes` will ever have a consumer.** #66 produces results ("verdict and findings as results") and consumes none; the branch is in git, not in a `result`. A fix step that consumes them does not exist on the board. Result *values* today have no in-process reader at all — only `hkb show --json` emits them.
- **Whether a subagent is the right tier for a step.** `AgentDefinition` carries per-type `tools`/`model`/`maxTurns`/`effort`/`skills`; `AgentInput` carries only `model` and `isolation` per spawn (SDK 0.3.261), there is no per-subagent budget, hkb never sets `Options.agents`, and `Agent` is off the default surface with a refusing test. #66's own card text says "read-only fence proved across the fan-out", which suggests the review itself fans out into subagents — a whole tier this design does not touch.
- **Unverifiable without spending money or running hkb** (the dogfooding pause forbids both): whether `resume: <sessionId>` honours a *changed* model in the options bag; whether hkb's SDK-wired `PreToolUse` hook fires inside a subagent (the SDK's own types assert it does — `BaseHookInput.agent_id` is documented as "present only when the hook fires from within a subagent" — but hkb has never run one); whether the `--from` + board-default double-append actually fires; whether a `no_input` failure from a broken workflow file spends a retry (the attempt row is created at `src/controller.ts:836`, ~560 lines before the shortfall, and the decision short-circuits before `nextPhase`).
- **Nothing was measured.** No row-count threshold for `hkb ls`, no timing on a two-level joined rollup, no token cost for N agents each carrying a board snapshot. Every performance claim in this document is inventory, not measurement, including "one board read per pass" for `readyNow` over an unindexed JSON `after`.
- **Labels as selectors.** A trigger-predicate readiness rule would make labels load-bearing, which contradicts `src/hkb.ts:118-120` ("Nothing schedules off a label"). One verifier argued this is a false conflict — Kubernetes does not schedule off labels either, it uses them for ownership *selection* while `ownerReferences` do the cascading. I have taken the owner-ref column and left labels human, but the fork is real and unrecorded.
- **Retention.** Named as owed, unassigned to a kind, unbuilt.

---

## Evidence that changed the answer

**1. The brief's own suggested edge mechanism is unsafe as shipped, and this is the correction the winning draft got wrong.** It claims a predecessor's result can cross an edge as `--input finding=value:<text>`, arriving "fenced and labelled" via `withInputs` while interpolating "only where the author wrote `{{finding}}`". **Those are mutually exclusive.** `src/filing.ts:361-364`, verified verbatim: `renderBrief` splices the value into the brief at file time, and *"A value that went into the brief does not also arrive as a data block"* — the input is then dropped from `inputs`. It reaches the model as instruction, not as fenced data. And `src/inputs.ts:330-341` states the licence that permits only `value:` to interpolate: *"the filer supplied it and the filer wrote the placeholder… The residual risk is real and bounded — a caller's payload reaching the instruction position."* **When the filer is a Step controller, that licence is false: the text came from a model.** So the edge is *not* free of new core mechanism. It needs a guard — a Job filed by the Step controller must refuse to interpolate a cross-step value — and that guard needs a refusing test, per CLAUDE.md. This is the one place where using the shipped mechanism unchanged would be prompt injection performed by the engine's own hands, which is precisely what GitHub's documented mitigation exists to prevent (*"the value… is stored in memory and used as a variable, and doesn't interact with the script generation process"*).

**2. Six of ADR-018's seven orphans already have a home and nobody had checked.** `propose`, `gate`, `guide`, `export`, `result`, `artifact` are all in `TEMPLATE_KEYS` (`src/templates.ts:77-105`, counted: 21 keys). The brief says "this question is where they go"; the answer for most of them is "nowhere — they arrived already". That collapsed the field list from seven-plus to four.

**3. Card #66 forces a session, not a column.** One allowlist per session (`src/admission.ts:95-98`); `model`/`maxBudgetUsd`/`maxTurns`/`effort` are `query()` options fixed at start (`src/runtime/claude.ts:60-98`); the SDK's setters are "only available in streaming input mode" and hkb passes a string prompt. Every one of those is already a frontmatter key. The forcing case forces the *tier* and nothing about the *graph*.

**4. Tekton ran the natural experiment and reversed.** TEP-0100 → PR #6099, milestone v0.45, merged 2023-02-13: `pipelinerun.status.taskruns` and `status.runs` removed, leaving `childReferences`. Stated motivation (1) is **write amplification** — "every time the status of TaskRuns and Runs change, the status of the parent PipelineRun is updated as well" — and `conditionSucceeded` was explicitly rejected from the child reference as "unnecessarily consuming storage". That is why `Step` has no `phase` mirror. Argo is the counter-case that proves it: the whole graph in one object, paid for with `/status/compressedNodes` and then an out-of-band SQL database.

**5. Where the original brief's stated evidence turned out to be wrong.** The brief asserts *"Steps run in the same Pod… the boundary between the two is the Pod"* and treats a Tekton Step as more prose in one container. **A Tekton Step is its own container image with its own `computeResources` and its own `securityContext`, applied over the pod-level one** (fetched from tekton.dev/docs/pipelines/tasks/). Tekton's Step boundary *is* a spec boundary — it is just not a *record* boundary. Worse for the brief's framing, Tekton has since answered its literal question by promoting the work a step does to its own stable CRD, **StepAction**, with typed `params` and `results`, while placement (name, ref, computeResources, workspaces, timeout) stayed on the Step. That is a data/content split arrived at independently, and it lands where this document lands.

**6. Where a lane's stated evidence turned out to be wrong, and it matters.** "Tekton can fan out and cannot fan back in" is a stale sentence in tekton.dev's own matrix docs, eight lines above the link that contradicts it. Tekton has aggregated fanned-out string results into an array since v0.53.0 (TEP-140, 2023-10-27). The "20 reviewers, one summariser" warning built on it should be discarded entirely. Separately: the widely-cited Step Functions "version pinning" mechanism does not exist as described — the real, weaker, better property is `UpdateStateMachine`'s "running executions will continue to use the previous `definition` and `roleArn`", obtainable with no version registry at all.

**7. Two conditionals that would break the minimum, forecast precisely.** `Prisma's JSON filters are PostgreSQL and MySQL only and SQLite cannot ask the question in SQL` (`src/read.ts:187-189`, verified verbatim). The moment `when: review.verdict == "changes-requested"` exists, the predicate must be evaluated every pass, so a predecessor's result **value** must be readable every pass — and `Attempt.results` is a JSON column. Readiness then becomes a full read plus an in-memory scan. That is survivable, and it is the single reason `readyNow` must be a pure function over rows from day one rather than a Prisma `where` clause: the fix is a second argument, not a rewrite.

**8. Version notes a reader should carry.** Tekton's Matrix is **beta** behind `enable-api-fields: "beta"`, and its array/object result types are beta. Tekton's 4096-byte result cap — which `src/results.ts:27` inherits "on purpose" — is the Kubernetes termination-message budget, and since the `results-from: sidecar-logs` flag (alpha v0.43.0, beta v0.61.0) it is configurable. Airflow's `awaiting_input` human-in-the-loop state is 3.x only. Kubernetes' `batch.kubernetes.io/` label prefix arrived in 1.27. The Temporal essay arguing against graphs for agentic workflows is founder advocacy published 2025-08-20 — it is correct about a step's *interior* (an agent decides its own tool calls) and says nothing about the graph *between* sessions, which is the only thing hkb's controller sequences.
