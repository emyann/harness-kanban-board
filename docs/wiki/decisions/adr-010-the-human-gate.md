---
title: 'ADR-010: The human gate is a field, not a kind — and groom is a brief'
summary: "propose → approve → apply does not need a second workload kind: a Job declares `results`, a `gate` on its spec suspends it once those results exist, and approve resumes the session with the approver's instruction as the prompt. The approver may be a human, a delegated agent, or an auto-approve policy. Groom becomes a brief plus board arithmetic; ADR-008's unshipped `results` half ships as the precondition it was always named as; and whether a *running* Job can be steered stays open, because that is a streaming-input decision the gate does not need."
category: decisions
kind: decision
audience: [dev]
read_when: "adding a workload kind, designing anything that needs a human decision mid-flight, or asking why groom is not a controller"
status: accepted
date: 2026-09-05
supersedes: ~
superseded_by: ~
covers:
  - path: prisma/schema.prisma
    sha: e4bac2046bd232c6656a59f4503e6a2ca32578f1
  - path: src/controller.ts
    sha: ececdee4149ee0f7800ec56b4cd5cff4fbef555f
  - path: src/runtime/index.ts
    sha: 55007f26fe6b9e4ec107997eef5aba74ec4643e6
  - path: src/hkb.ts
    sha: 158ef020ba52943c181ef95138ba16bc5a2d33f6
  - path: src/inputs.ts
    sha: 5fa957ea2723d26e0a37cd67725d756bb6838469
related:
  [
    decisions/adr-007-workload-scheduler,
    decisions/adr-008-declared-outputs,
    decisions/adr-011-proposals-not-board-access,
    architecture/job-kind,
    architecture/overview,
  ]
generated_at_commit: b05de11
last_refreshed: 2026-09-06
---

# ADR-010: The human gate is a field, not a kind — and groom is a brief

## Context

`docs/rebuild-plan.md` lists the next piece of work as **"the second kind: groom — a one-shot with a
human gate (propose → approve → apply). It is the *most different* from a Job, which is why it is
next: what generalises between them is real."** The reasoning is sound: pick the most different thing,
and the abstraction that survives is a real one rather than a guess.

Reading the code to start it turned up three things.

**ADR-008 decided two output mechanisms and only one shipped.** `exports` exists; `results` — "named,
small, structured values the worker writes to a path the controller gives it, and the controller
stores on the Attempt" — has zero occurrences in `prisma/schema.prisma`. ADR-008 does not treat it as
polish:

> Adding an artifact kind currently means adding a column to `Attempt`; with `results` it means adding
> none. **This is a precondition for the second kind ADR-007 deferred**, not a tidying of the first.

**`Phase.suspended` and `Job.suspendedFor` are declared and unwritten.** Nothing in `src/` sets either.
That is the same shape as `Job.isolate` before Phase 2 — a column that exists in the way a comment
exists — and the plan's own opening section lists exactly that as a defect worth naming.

**And the plan argues against itself, 250 lines apart.** Its "After the gate" list calls groom the
second *kind*. Its single-message-input section, reasoning from the same Kubernetes mapping, says:

> the one declarative mid-life control is `Job.spec.suspend` — **a field, not a kind**, which is what
> `Phase.suspended` already is.

### What a groom run actually is

One agent, one brief, in a sandbox, under ceilings, producing an output. That is a Job in every
respect. What differs is not execution but **lifecycle**: it produces a proposal, waits for a person,
and then acts. Two attempts with a gate between them.

Nothing in that needs a second controller. A controller earns its existence by doing something
structurally different — creating other workloads, fanning out, ordering. The DAG kind does all three,
which is why it genuinely is a kind. Groom does none of them.

## Decision

**The human gate is a field on the Job spec, not a workload kind. Groom is a brief.**

1. **`results` ships**, as ADR-008 specified and as it named itself: a precondition. Declared on the
   spec, produced by the worker at a path the controller gives it, read back onto the Attempt.
   Size-capped — Tekton's 4096 bytes is the reference, and the cap is the point: a handoff that can
   hold a megabyte becomes a worse artifact store. The ADR-008 rule holds unchanged — **a declared
   output that is not produced fails the attempt.**

2. **A `gate` on the spec.** When set, an attempt that succeeds *and* produced its declared outputs
   does not go terminal. The Job goes `suspended`, `suspendedFor` says what it is waiting for, and
   the controller claims it no further. `Phase.suspended` and `suspendedFor` get their first writer.

3. **`hkb approve <id> [note]` and `hkb reject <id> "<why>"`.** Reject is terminal and reuses the
   `endedBy`/`endedFor` pair `hkb cancel` already writes — a decision a person made, which nothing
   can recompute. Approve re-queues the Job.

   **The approver is a seat, not necessarily a person.** Three fillers, one mechanism: a human at a
   terminal; an *agent the human delegated to*, which is what the retired `/kanban:operate` command
   was and the reason that seat is worth rebuilding rather than mourning; and an **auto-approve
   policy**, for a workflow whose gate exists to wait on something external rather than on a
   judgement. All three write the same row and resume the same session, so the gate does not have to
   know which one answered — and `endedBy` already carries who did.

4. **Approval is a resumed session carrying an authoritative instruction.** This is the part that
   makes the gate work rather than merely pause. Today a resumed attempt re-sends
   `withProtocol(job.brief, branch)` — the *same brief* — so an approved Job would propose again
   instead of applying. Approval therefore writes the instruction onto the Job, and the controller
   sends that instead of the brief on the next attempt, continuing the same session
   (`lastSessionId`), which already resumes and is proved against the live SDK.

5. **Groom is then a brief plus board arithmetic**, with no new machinery: which Jobs have sat
   `pending` and why, which succeeded and produced nothing (`producedNothing`, `src/hkb.ts` — which
   only became computable this week), which keep capping on `max_budget`, which briefs duplicate each
   other. The arithmetic is LLM-free and comes from one board read; the judgement is the model's; the
   yes is the human's. That is the same division the retired `hkb groom` had, pointed at a different
   object.

## Consequences

**What generalises is the gate, and it is worth more than groom.** Locking "wait for a human" inside a
groom kind would make it unavailable to every Job that already exists. As a spec field it composes:
*propose the migration, let me look, then run it* is the same feature, and so is any Job whose blast
radius earns a second pair of eyes. That is the plan's own test — "what generalises between them is
real" — answered by finding that the generalisable part was never groom-shaped.

**It answers half of an open tension, and the other half stays open — deliberately.** "Decided:
single-message input stays" concluded that streaming's unique contribution is *authority*, and that
**"a Job has no human present to author an authoritative instruction, so the one thing streaming adds
is the one thing this kind cannot use."** A gated Job *does* have such a human, so that premise no
longer holds. But it would be too neat to say the gate settles the input question, so here is what
the SDK's own types say, checked at `0.3.261` rather than remembered:

| | single-message (`prompt: string`) | streaming (`prompt: AsyncIterable<SDKUserMessage>`) |
|---|---|---|
| a second message into a live session | **only at a stop boundary**, via a `Stop` hook's `additionalContext` — "non-error feedback delivered to the model; the conversation continues so the model can act on it" | any time |
| delivered *mid-turn*, between tool rounds | no | **yes** — a queued message is folded into the running turn |
| `role: "user"` authority | no. Hook-authored, and a worker has already refused such text as untrusted | **yes** |
| `priority: now / next / later`, `shouldQuery: false` | no | yes |

There is **no `send()` on the `Query` handle** — the exported surface is `query()` plus session
utilities, and every control request (`interrupt`, `setModel`, `setPermissionMode`) changes *settings*,
never content. The prompt iterable is the only inbound path for a message.

So the gate covers the **asynchronous** case completely and needs no streaming: the Job stops, someone
or something decides, and the instruction arrives as the prompt of a resumed session — with full
authority, because it *is* the prompt. What the gate does not give is **steering a run that is still
going**. That remains streaming-only for mid-turn delivery, with the `Stop`-hook path as a real
intermediate: steering at a stop boundary, using a hook layer `src/admission.ts` already establishes.
For a batch Job, a stop boundary may well be the right granularity — but that is a measurement nobody
has taken, and this record does not pretend to have taken it.

**The plan's "After the gate" item 3 is answered, not deleted.** Groom still happens; it stops being a
kind. The list becomes: the gate (this record), then the DAG, then integration. The DAG remains a real
kind for the reasons groom is not — its controller creates Jobs the way a CronJob creates Jobs.

**`suspended` stops being decorative.** It has been in the `Phase` enum since ADR-007 with nothing to
write it, which is how a column becomes a lie. This is also the third time this project has shipped a
declaration with no enforcement behind it (`Job.isolate`, the admission gate, the worktree base), so
the gate gets what those needed: a test that makes it **refuse** — an ungated Job must not suspend,
and a gated one must not go terminal — run at the shipped defaults.

**Two things get harder.** A gated Job is one a human can forget, and a board of suspended Jobs
waiting on nobody is a new way to be stuck; `hkb ls` already has a `--phase` filter and `suspended`
should be legible in the default listing rather than only findable. And the approval instruction is
operator-authored text that reaches an agent as an authoritative prompt, which is a real trust
boundary — it is the operator's own instruction, on their own board, but it is the first text in this
system that travels that way.

**The risk this accepts.** If groom's *apply* half turns out to need to create or modify other Jobs,
that is workload-creating behaviour and a controller's job — and groom would be much closer to the DAG
than to a field. The mitigation is that we will find out by writing the brief, which costs a brief; and
that nothing here forecloses a kind later, because `results` and the gate are what such a kind would
have needed anyway.

**What this record deliberately leaves for its own decision.** Whether hkb adopts streaming input, and
therefore whether a running Job can be steered mid-turn, is not settled here — the gate needs none of
it, and deciding it as a side effect of building the gate is how a structural choice gets made by
accident. The two are the same axis at different latencies (*wait for input at a defined point* versus
*accept input at any point*), so the gate is the cheap end of it and should be built first: it makes
the seat real, gives the delegated approver and the auto-approve policy somewhere to write, and
produces the operational evidence — how often does anyone want to intervene, and at what point — that
the streaming question needs and does not currently have.

**What has moved since, without changing the decision.** Decision 5 said groom needs no
new machinery, only a brief plus board arithmetic. Half of that is now a mechanism rather
than a thing to remember: `--input state=board` renders one board read — id, phase,
attempt count, last outcome, and whether the Job produced nothing — into the prompt with
no model in the loop (`renderBoard`, `src/inputs.ts:267`), capped at 50 rows and saying so
when it truncates. It stays arithmetic; what it removes is the step where somebody pastes
it in.

ADR-011 then took the *other* half — what groom does with the answer — and settled it the
way this record settled the gate: the apply is the controller's, and what a worker
produces is a declared proposal rather than a board write. So the two halves of groom sit
in two records, and neither of them is a groom kind.

**Decision 4 has one exception now, and it is worth naming.** "Approval is a resumed
session carrying an authoritative instruction" holds for every gated Job except a
`--propose` one: there, approving does not resume anything. The controller files what was
proposed and the Job goes terminal, because a worker asked to propose again would be
proposing on top of rows that already exist (`applyProposals`, `src/controller.ts`;
`features/proposals`). `hkb approve` says which of the two happened rather than making the
reader guess.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
