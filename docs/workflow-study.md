# How a multi-step workflow should be represented in hkb — a design study

> **Status: study, not decision.** Written 2026-09-05 against `main` at `5cc611e`, SDK `0.3.261`.
> It follows the shape `docs/local-first.md` had before ADR-005 and ADR-006: the reasoning lives here,
> the decisions go in ADRs once they are made. Sections are numbered so a card can say "§4" and mean
> one thing. The open questions in §9 are the point — nothing here is settled that §9 does not say is
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
and `prisma/schema.prisma:13-15` put it in writing: a second kind whose controller creates Jobs, which
does not ship before integration.

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

The layers, ordered by what can refuse:

| | layer | defeasible? |
|---|---|---|
| 1 | the claim-time predicate (`gateClaim`, pure, exhaustively testable) | no |
| 2 | the admission gate (`src/admission.ts`) — the only layer that held when `permissionMode` did not | no |
| 3 | **the base the checkout is cut from** — currently constant, currently nobody's | no, but unowned |
| 4 | the declared-output check, after teardown | no, but post-mortem |
| 5 | a script the agent invokes | deterministic in body, wholly defeasible in *placement* |
| 6 | prompt text, including a skill's prose | guarantees nothing; measured guaranteeing nothing twice |

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

Both are accepted records. §3 resolves it by scope — *sequence is a field, concurrency is a kind* — but
that resolution is currently only in this study. It belongs in an ADR, because the next person to read
the two records will find them disagreeing.

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

## 8. Delegating orchestration to the harness

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

## 9. Open questions — these need the operator

Nothing above is a decision. These are the forks where the answer changes what gets built.

1. **Is `propose → approve → apply` really the whole multi-step feature for now?** §3 says yes and both
   alternatives died. The cost of accepting it: no fan-out, no fan-in, and no ordering between workloads
   until the DAG kind ships behind integration.
2. **Does the ADR-007/ADR-010 contradiction in §6 get its own ADR**, or a paragraph in an existing one?
   It is currently unrecorded outside this file.
3. **Who owns the base of the checkout (§4, layer 3)?** It is an unowned determinism layer, it is where
   the only measured composition failure lives, and `baseRef()` resolving fresh per attempt is a
   decision nobody made deliberately.
4. **Do we adopt Artic's read side (§7)** — declared *inputs*, used to restrict what a step can see?
   The reported gains are large, it is the natural companion to `results`, and it is the first thing in
   this study that would change what a brief looks like.
5. **Is "a dynamic workflow elects its actor non-deterministically" the definition we want?** It holds
   for the Workflow tool, where a `parallel(...)` has a cardinality nobody declared. There may be a
   sharper axis underneath — whether the graph is *data or code*.
6. **How much verification beyond presence (§7) are we willing to pay for?** `Job.check` — a command the
   *controller* runs, whose non-zero exit fails the attempt — was the one genuinely new mechanism the
   research recommended, and it is the only thing that promotes a script's guarantee from layer 5 to
   layer 1.
