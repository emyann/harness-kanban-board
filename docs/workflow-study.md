# How a multi-step workflow should be represented in hkb — a design study

> **Status: study, with §10 answered.** Written 2026-09-05 against `main` at `5cc611e`, SDK `0.3.261`;
> §10 answered by the operator the same day and the answers folded back in — they changed §3 and §4.
> It follows the shape `docs/local-first.md` had before ADR-005 and ADR-006: the reasoning lives here,
> the decisions go in ADRs once they are made. Sections are numbered so a card can say "§4" and mean
> one thing. The questions in §10 are the point — nothing here is settled that §10 does not say is
> settled.
>
> Produced by a twelve-agent research run over seven lenses (Artic and artifact-driven compilation;
> skills-as-workflows; where determinism lives; the harness's execution strategies; hkb's own
> commitments; adversarial failure modes; and Claude Code's Workflow tool), synthesised, then attacked
> by three adversarial critics and settled. **Both proposals it produced were killed by unanimous
> critics.** That is the most useful thing in this document and §2 is about it.

## 1. The question

A grooming session is a workflow: it starts, it has steps, and a human decides in the middle. The same
shape appears in a scenario worth designing for — a button in a browser, an API call to a server hkb
does not own, an agentic workflow that end users describe simply and hkb maps onto whatever harness
will run it.

The crux, and it is what makes this hard: **a workload in hkb is an agent running, and an agent can
itself act deterministically** — it runs scripts, it follows skills. So determinism is not something
outside the agent that wraps it. It is a spectrum *inside* one unit of execution. The representation
question is therefore not "is this workflow deterministic" but **where does the determinism live** —
in a graph, in a skill, in a script, or in prose.

Existing systems answer differently, and none of them has our situation. Argo and Tekton put all of it
in a declarative graph, because a container has neither memory nor judgement, so every ordering fact
must be external. Temporal puts it in code, made durable by deterministic replay of an event history.
Claude Code's Workflow tool puts it in a JavaScript script whose control flow is deterministic and
whose leaves are agents. **Temporal's answer is structurally unavailable to us**: replay requires
determinism, an agent has none, so hkb can only ever checkpoint *outputs* — which is what ADR-008
already chose, before anyone noticed that was the reason.

## 2. What the research killed

Two representations were proposed and both died on code rather than on taste. Recording them is worth
more than recording what survived, because both are the obvious answers and both will be proposed
again.

**A chain of Attempts punctuated by a re-entrant gate.** Elegant: no new object, and Artic's control
language (`S ::= agent(ω) | S₁;S₂ | if p then S₁ else S₂ | while p do S`) falls out of a gate that can
fire more than once. It fails because a re-entrant gate **deletes the Job's completion condition** —
every successful attempt suspends again, `Phase.succeeded` becomes unreachable, and the only terminal
states left are `cancelled` and `done`, the latter defined over thirty lines of schema comment as
something an operator says when the aim was achieved *by other means*. Recording a finished workflow as
`done` corrupts the one distinction that comment exists to defend.

**`Job.after` — an ordering edge between Jobs.** It fails on four independent counts. It is a `Link`
table with arity 1, and the same proposal rejected `Link`. No core Kubernetes object carries a
dependency on a sibling of its own kind — that is precisely the thing k8s declined, and `after` is
"Tekton with the `Pipeline` resource deleted". The Job controller would have to write *another Job's*
status, which `src/controller.ts:16-18` forbids itself in writing. And the predicate is wrong for the
only workload hkb has ever run: `after: succeeded` gates on a phase this codebase documents as carrying
no judgement, while all twenty-three dogfood Jobs ended in a **draft PR awaiting a human** — so every
real boundary was already a human boundary, not a status one.

## 3. The recommendation

**hkb should not represent a multi-step workflow as a graph, and not as an edge either. It already has
a multi-step primitive that nobody has run yet: the human gate.**

ADR-010 decided that a Job may declare `results`, suspend once those results exist, and be resumed by an
approver — human, delegated agent, or auto-approve policy — whose instruction *becomes the prompt* of
the resumed session. That is `propose → approve → apply`: two steps, a durable checkpoint between them,
a real waiting state, an authoritative handoff, and no new kind. Iterated, it is a chain, at zero
columns beyond the ones the gate already needs.

`Job.after` is **rejected, not deferred**. Ordering between *workloads* stays where ADR-007 decision 5
and `prisma/schema.prisma:13-15` put it in writing: a second kind whose controller creates Jobs.

**The gate is a placeable primitive, not the feature.** The original framing of this section — "the gate
*is* the multi-step feature" — was corrected by the operator, and the correction matters. What is
required is that **where the human boundary goes is authorable**, because different workflows want it in
different places. Two topologies, both named as requirements:

- **fan-in to one assembled pull request, reviewed once at the end** — the gate on the integration node;
- **a review after every node**, rather than one pull request carrying the assembled result — the gate on
  each node.

Those are the same mechanism placed differently. So the gate answers *how a boundary waits*; it does not
answer *where boundaries go*, and the second question belongs to whatever authors a workflow.

**This pulls integration forward.** The first topology cannot be expressed without somewhere for parallel
work to accumulate, which is §4.1 below — and `docs/rebuild-plan.md` already orders integration *after*
the DAG. On this evidence it is before it, and possibly before anything else here.

## 4. Where determinism lives

The rule, and it is the study's main result:

> **Determinism belongs at the lowest layer that can *refuse*. A layer that cannot refuse is not a
> place determinism lives — it is a place determinism is hoped for.**

That reframes the spectrum. "How deterministic is this step" is the wrong axis; the axis that predicts
hkb's actual failures is *who enforces it, and can the enforcement be defeated by sampling?* The rule
is honestly sourced — `src/limits.ts`'s own header says every guard in this system that turned out to
be silently inert was inert because nothing tested that it **refused**.

Two corrections the critics forced.

**Refusability is necessary, not sufficient. A guard must also survive being told what it is.** This
disqualifies the tempting move of relocating the declared-output check into a `Stop` hook so the agent
can fix a missing path. `exportOutputs` decides by `existsSync`; an agent told *"you declared
`results.prUrl` and it is not there"* satisfies that with one `echo`. Today such a run reports
`no_output` — the only signal in the system that does not require believing the agent, and the reason
`producedNothing` exists. After the change it reports `succeeded`. Two aggravators: a `Stop` hook cannot
fire on `max_turns`, `max_budget` or `timed_out`, which are exactly the stops most likely to be short of
outputs; and a worker has already been measured refusing hook-authored text as untrusted.

**The layer list was missing a layer, and it is where hkb's only measured composition failure actually
lives.** `#350` and `#354` were each green alone and broken together. The plan's finding 10 records that
nothing in the machinery could have caught it, that they did not even run concurrently at
`maxConcurrent: 1`, and that what collided was not shared files but a shared **invariant**. No ordering
edge could have been drawn at filing time, because the fact did not exist then. The layer that would
have caught it is **the base of the checkout**: `baseRef()` (`src/worktree.ts:113-125`) resolves origin's
default branch fresh on every attempt, so every Job in a batch works from a tree that diverges further
from what will actually be merged. Determinism about *what a step can see* is a git fact — not a prompt
fact and not a graph fact — and it is **unowned today**.

**A workflow being "dynamic" does not make its processing nondeterministic.** The actor set can be
elected at runtime — how many agents, which ones, from what a previous step returned — while everything
around it stays deterministic machinery: ordering, gating, budgeting, artifact handoff. The
nondeterminism is confined to the leaf. That is the same conclusion as the rule above arriving from the
other direction, and it is why Claude Code's Workflow tool is an existence proof rather than merely a
comparison: deterministic control flow, nondeterministic leaves, with the determinism living in the
*script*. The reason hkb cannot simply copy it is the one that makes hkb a scheduler — a script is not
durable across a process restart, and a board row is.

The layers, ordered by what can refuse:

| | layer | defeasible? |
|---|---|---|
| 1 | the claim-time predicate (`gateClaim`, pure, exhaustively testable) | no |
| 2 | the admission gate (`src/admission.ts`) — the only layer that held when `permissionMode` did not | no |
| 3 | **the base the checkout is cut from** — currently constant, currently nobody's | no, but unowned |
| 4 | the declared-output check, after teardown | no, but post-mortem |
| 5 | a script the agent invokes | deterministic in body, wholly defeasible in *placement* |
| 6 | prompt text, including a skill's prose | guarantees nothing; measured guaranteeing nothing twice |

### 4.1 The base of the checkout becomes a spec field

Layer 3 above was listed as *unowned*. It has an owner now, and the answer came from the operator rather
than from the research, which had only identified the hole.

**The base a Job's checkout is cut from varies per Job.** Today `baseRef()` (`src/worktree.ts:113-125`)
resolves origin's default branch fresh on every attempt — a constant nobody chose, and the reason every
Job in a batch works from a tree that diverges further from what will actually be merged. Instead:

> Take a graph where **A** is blocked by **B** and **C**. A's branch is cut from origin. B and C run
> concurrently and are **cut from A's branch**, collecting their results back into it. A runs last, on a
> branch that now carries both, and opens the pull request.

That is an **integration branch**, and it is the shape the retired system had as `kb/track-<root>`.
`docs/rebuild-plan.md` item 5 already says it is *"the shape that does"* fix integration and *"do not
start the DAG kind without it"* — so this is a re-derivation of a conclusion the plan reached and never
implemented, which is the strongest kind of agreement available.

Two consequences worth stating:

- **It closes the layer-3 hole.** The #350/#354 collision lived in the base, and no ordering edge could
  have caught it because the colliding fact did not exist at filing time. A base a Job *declares* is a
  fact that does exist at filing time.
- **It is what §3's first topology needs.** Fan-in to one reviewed pull request requires somewhere for
  parallel work to accumulate. The integration branch is that somewhere; the gate on the integration node
  is the review. The two requirements are one mechanism seen from both ends.

## 5. The representation, in three tiers

**Inside one Attempt, hkb models nothing.** This is the direct answer to the framing in §1, and it is
already fully supported. An agent that runs a script is deterministic where the script runs, and the
board's answer to *what happened in there* is the session id — a complete, lazily-readable pointer.
This is the **init-container shape**: ordering inside the unit, invisible to the scheduler, owned by the
workload.

**A skill is a step body, never a step boundary.** A skill's determinism is real but it is
*intra-Attempt*, and hkb's durability unit is the Attempt: if step 4 of a 6-step skill fails, there is
no row to resume from. The retired system already ran this experiment — the one genuinely
workflow-shaped thing in its 60 KB skill was `propose → approve → apply`, which ADR-010 has since
re-expressed as two spec fields. Artic tested the same substitution directly (compiling a workflow into
a skill, across 488 instances) and beat it; the measured difference was **the contract between steps,
not the prose inside them**.

**The durable boundary is the gate, and it is the whole multi-step feature for now.** A boundary earns a
durable row only when it needs something a row can hold and a prompt cannot:

- **decision** — something outside the agent must decide there, and only a durable `suspended` phase can wait;
- **budget/retry** — the step needs its own cap or its own retry ledger;
- **review** — the output is a diff a human merges;
- **identity** — a different repository, model, tool surface or trust level.

If none holds, the boundary is inside one Job.

## 6. A contradiction in the record that has to be resolved

The research found hkb committed to **two incompatible answers to the same question**, and nobody had
noticed:

- **ADR-010** says the gate is a spec *field*, so a two-step workflow is **one Job** — one lease, one
  worktree, one resumed session, one retry budget.
- **ADR-007 decision 5** and `prisma/schema.prisma:13-15` say the DAG is a *kind* whose controller
  creates Jobs — so multi-step is **many Jobs**.

Both are accepted records. §3 resolves it by scope — *sequence is a field, concurrency is a kind* — and
**it gets its own short ADR.**

The practice question was asked and is worth writing down, because it will recur. This repository's own
rule is that once a record is `accepted` it is never rewritten, so editing either is out however tempting
it is for ADR-010, which is a day old. That leaves two framings, and the difference is not cosmetic:

- **Supersede** — for when one record *replaces* another. Wrong here: neither ADR-007 decision 5 nor
  ADR-010 is withdrawn, and both stay true inside their scope.
- **Clarify** — a new record whose entire decision is the scope rule, citing both, marking neither
  superseded, with a `related` link added from each.

The second. And it should be **short** — its whole job is to state the rule, say where each prior record
applies, and be findable by whoever next reads them disagreeing. A long record here would re-argue
decisions already made.

## 7. Artic, and the thing it has that we do not

[Artic](https://arxiv.org/abs/2608.21341) compiles a natural-language workflow into one where **each
step declares the artifacts it reads and writes, constraints gate produced artifacts, and explicit
control transfers route execution.** hkb has two of those three already, arrived at from Bazel and
Tekton rather than from the paper: ADR-008's declared outputs, and its rule that a declared output not
produced fails the attempt.

What Artic has that hkb does not is **the read side, and it is where its measured gains come from.** A
step declares its *inputs*, and the orchestrator restricts the store to exactly those before invoking a
fresh subagent — reported as **−63% input tokens and +56 percentage points of repeated-execution
consistency**. That reframes declared inputs entirely: they are not primarily for ordering, they are for
**context restriction**. hkb declares only outputs, and passes a whole worktree.

It also proposes **faithfulness checking** — decomposing verification into local obligations plus
scenario-based dry runs to test whether a compiled region conforms to the source description. That is
the answer to *how do you trust an LLM-assisted NL→graph transformation*, and hkb has no answer at all.

The honest caveat on all of it: hkb's entire verification vocabulary is **presence** — `fs.statSync`,
`gh pr list --head`, a result present or missing. Presence is cheap, which is ADR-008's selling point,
and it is exactly the wrong instrument for the outputs that make a multi-step workflow worth having.

## 8. Hermes, the ancestor — what it solved and where hkb must differ

hkb was originally described as a portable, frugal Hermes-style kanban, so Hermes is the one prior art
that was aiming at the same thing. It has shipped answers to two questions this study treats as open,
and they are worth taking seriously rather than re-deriving.

### The structured handoff

Hermes' worker calls `kanban_complete(summary=..., metadata=...)`. `summary` is prose; `metadata` is a
**freeform key-value object the worker defines** — `{"changed_files": [...], "decisions": [...]}`,
`{"duration_seconds": 720, "tokens_used": 2100}`. Downstream workers read it back through
`kanban_show()` as `worker_context`, which carries prior attempts and parent task results. The stated
rationale is the right one: it *"replaces the 'dig through comments and the work output' dance that
plagues flat kanban systems."*

Neither system types the values, and that agreement is worth noting: ADR-008 rejected a per-Job schema
because it is *"a type system in the board that a model can satisfy by assertion"*, and Hermes reached
freeform metadata independently. **The divergence is not the type; it is who chooses the fields.**

| | Hermes | hkb |
|---|---|---|
| who chooses | the **worker**, per run | the **filer**, at declaration |
| absent field | nothing happens — metadata is whatever the worker included | **the attempt fails** |

Hermes is richer and guarantees nothing: a downstream reader cannot rely on a key existing. hkb is
stricter and blind to whatever the filer did not anticipate: a Job cannot volunteer that it noticed
something.

**The resolution is that these are two layers, not two options.** Read as layers, hkb already has three
and is missing one:

1. **Required** — `results`. The filer declares, the board enforces, a shortfall fails the attempt.
   Hermes has no equivalent, and this is what makes `succeeded` mean more than "a session ended".
2. **Measured** — `costUsd`, `turns`, `denials`, `startedAt`/`endedAt`. Real columns. Hermes puts these
   *inside* freeform metadata, where they cannot be queried: "which Jobs ran over ten minutes" is not a
   question you can ask reliably of a JSON blob whose keys each worker invents.
3. **Volunteered** — the gap. `Attempt.summary` exists but is auto-filled from the runtime's last text
   (`outcome.text.slice(0, 2000)`), not authored by the worker as a handoff.

So: **add the volunteered layer; do not replace the required one.** The mechanism already exists —
`collectResults` reads only the declared names out of the collection directory, and reading the whole
directory yields both, with the guarantee preserved on the half that has one.

### Auto vs manual orchestration

Hermes' dispatcher runs a **decomposer** on each tick: an auxiliary LLM that reads the installed
profiles and emits a JSON task graph — which tasks to spawn, their assignments, their dependencies —
capped at three per tick, with the triage task becoming the **parent of every leaf** so it stays alive
until they finish. Manual mode holds the item until a human presses Decompose. The toggle is a config
key and a pill in the dashboard.

Three things follow, and the third is the one that changes this study.

**Auto versus manual is ADR-010's approver seat, arrived at independently.** Manual is a human gate on
decomposition; auto is an auto-approve policy. Two projects reaching the same shape from different
directions is the strongest evidence available that the seat is real.

**hkb cannot copy the mechanism, and the constraint is productive.** Hermes puts the model *in the
dispatcher*; hkb's values forbid an LLM there. So a decomposer in hkb must be a **workload**, which is
the more auditable arrangement anyway: the proposed graph becomes a `results` value with a named
approver on it, on the event stream, rather than a decision taken inside a tick.

**And that dissolves the risk ADR-010 recorded and could not resolve.** That record worried that if an
apply half creates or modifies other Jobs, it is *"workload-creating behaviour and a controller's job"*
— which would make groom a kind after all. The answer is that **a controller IS a workload**: in
Kubernetes the API server is dumb and controllers are ordinary pods that watch, reconcile and create
objects through the API. A decomposer that reacts to items arriving in triage is a controller for a
different concern, running as a Job, while the Job kind's own controller stays arithmetic and SQL.

Three consequences hkb has to accept for that to work, and all three are already parked:

- it must **observe** the board — §"Parked" A, *watch*. `Event.id` is already the cursor.
- it must **act** on the board with an identity and a scope — §"Parked" B, *least privilege*. This is
  the first thing that genuinely needs the ServiceAccount/Role shape that section describes.
- it must **wait for a decision** — ADR-010's gate.

Three parked items that looked independent are the three legs of one design.

**The hard part, stated plainly.** A workload reading and writing the board reverses a deliberate
isolation decision: `src/worktree.ts` gitignores the board so a worker cannot see it, because *"the
controller owns every store write; a worker with a copy would read state that stops being true the
moment the controller moves."* And a worker can already do it today, unmodelled — `DEFAULT_TOOLS`
includes `Bash`, nothing passes `env`, so it inherits the operator's PATH and can shell out to
`hkb new` with no lineage, no scope and no refusal. The choice is not whether a workload can touch the
board; it is whether that happens through a grant or through a side door.

**One gap this names.** hkb has no *triage* state. `pending` means "wants to run"; a triage item means
"wants to be decided about". That may be a gated Job that has not been approved yet, or it may want its
own phase, and this study does not decide which.

## 9. Delegating orchestration to the harness

The proposal: when a workflow Job lands on a Claude harness, hand the orchestration to *that harness's*
native capability; when it lands on one without, hkb's own machinery does it. This is hkb's runtime seam
(`src/runtime/`) applied one level up, and it is what the retired system's capability map did for tools —
a closed vocabulary of intents, bound per harness, unbound falling back to prose.

The research produced one sharp result, and it is a constraint rather than a refutation:

> The same property that makes a step worth **scheduling** — it needs a durable row, so it can be gated,
> leased, retried in isolation and audited — is exactly the property that makes it not worth
> **delegating** to a harness. And the property that makes a region cheap to delegate is that it needs
> none of that.

**Delegation and scheduling are anti-correlated by construction.** That does not kill the idea; it
locates it. Delegation applies to regions hkb was never going to model anyway — which is the same set as
§5's "inside one Attempt, hkb models nothing". A harness with native orchestration is then a *better
step body*, not a substitute for the board. What hkb would lose by delegating a region it *did* want to
schedule is precisely the list that makes it a scheduler: per-step leases, ceilings, gates, audit.

## 10. The questions, and what they were answered

Asked of the operator on 2026-09-05 and answered the same day. Four of the six changed this document;
where they did, the change is folded into the section named rather than left here.

**Q1 — Is `propose → approve → apply` the whole multi-step feature? — NO, and the question was wrong.**
The gate is a *mechanism*; what is required is that **where the human boundary goes is authorable**, per
workflow. Two topologies named as requirements: fan-in to one assembled pull request reviewed once, and
a review after every node. Folded into §3, which also notes the consequence — this pulls **integration**
ahead of the DAG in the plan's ordering.

**Q2 — Does the ADR-007/ADR-010 contradiction get its own ADR? — YES, a short clarifying one.** Not a
supersession: neither record is withdrawn. Reasoning in §5.

**Q3 — Who owns the base of the checkout? — the Job does.** The base becomes a spec field, defaulting to
origin's default branch, with a graph's nodes cut from their parent's branch and collecting back into it.
This is the integration branch the plan already called for. New §4.1, and it closes the layer-3 hole in
§4.

**Q4 — Do we adopt Artic's read side? — conditional.** Depends on the design, on whether declared inputs
sharpen what the hkb primitive is, and on how handoff works. Not decided; it belongs with §4.1, since
declared inputs and the integration branch are both answers to *what can this step see* — one at the
context level, one at the git level.

**Q5 — is "a dynamic workflow elects its actor non-deterministically" the definition? — dissolved.** It
was an illustration, not a proposed taxonomy: the point was that an agentic workflow can be *processed*
deterministically even when the actor set is not known up front. Folded into §4 as a clarification. There
is no definition to settle.

**Q6 — how much verification beyond presence? — PARKED.** `Job.check` — a command the controller runs,
whose non-zero exit fails the attempt — is understood and deliberately deferred as too advanced for now.
Nothing else here depends on it. Recorded so it is not rediscovered: it is the only mechanism that
promotes a script's guarantee from layer 5 to layer 1, and without it a declared output is satisfied by
one `echo`.

## 11. What the answers made next

Not the graph, and not the gate. **A Job's record of what it did, decoupled from git.**

The requirement behind Q6's parking: a Job should not have to be coupled to commits or a pull request,
and a Job that did work and has nothing to hand over should still be able to say what it did. `Attempt`
today ends in `branch`, `prNumber`, `prUrl` — the coupling made concrete.

Three parts, two of them nearly free:

1. **`results`** — ADR-008's unshipped half, and the handoff contract object. The place a Job puts
   something to share that is not a diff. It is also what ADR-010's gate needs in order to carry a
   proposal, so it serves both.
2. **`Attempt.turns` and `Attempt.denials`** — the runtime already computes both (`WorkerOutcome`,
   `src/runtime/index.ts`) and the controller drops them. `durationMs` is already derivable from
   `startedAt`/`endedAt`.
3. **Tool usage by name** — not captured today; the runtime already consumes the message stream that
   would carry it.

Together these make `producedNothing` (`src/hkb.ts`) honest. Today it can only say *this Job produced
nothing*, which reads as failure. With a handoff object and telemetry it can say *no pull request, and
here is what it found and what it cost* — which is the difference between a Job that investigated and a
Job that stalled.
