---
title: 'ADR-011: A workload proposes, the controller writes — board mutation travels as a declared output'
summary: "A workload never writes to the board: it declares a proposal as an output, and the controller validates and applies it once an approval is recorded — which keeps the sandbox, makes the write retry-safe where an in-session API call is not, and leaves groom's apply half with the controller rather than making groom a kind."
category: decisions
kind: decision
audience: [dev]
read_when: "designing anything where a worker needs to affect the board — a decomposer, groom's apply half, dynamic fan-out — or asking why a worker has no board handle"
status: accepted
date: 2026-09-06
supersedes: ~
superseded_by: ~
covers:
  - path: src/admission.ts
    sha: aab84ccd1178b085cea79d2c4566149145027b9e
  - path: src/results.ts
    sha: 0fc3dc145a1c515267534909aee79f034effa61b
  - path: src/controller.ts
    sha: eb7a09443efe5cd3e872af7f4560c9d82e1c11f6
  - path: src/runtime/claude.ts
    sha: 5ae775633cae411b71443add232b79f1325c4075
  - path: src/brief.ts
    sha: 8b26e22eef60ceac89d2ececf18a82284a73ddad
  - path: prisma/schema.prisma
    sha: 888751eac2c7ae7c2bea8f57dd0dce7a1e084b05
  - path: src/artifacts.ts
    sha: b1c001d916ec6cdd8198d978bbae1d09a2d2813d
  - path: src/inputs.ts
    sha: ffd76fce7689fe1c9a1dc0db3756cdf343d2b623
related:
  [
    decisions/adr-007-workload-scheduler,
    decisions/adr-008-declared-outputs,
    decisions/adr-010-the-human-gate,
    concepts/admission-control,
    architecture/job-kind,
    architecture/the-loop,
  ]
generated_at_commit: 1ff10a0
last_refreshed: 2026-09-06
---

# ADR-011: A workload proposes, the controller writes

## Context

ADR-010 made the human gate a spec field and recorded one risk against that choice:

> If groom's *apply* half turns out to need to create or modify other Jobs, that is workload-creating
> behaviour and a controller's job — and groom would be much closer to the DAG than to a field.

That risk has an unexamined premise: that the workload doing the applying is the thing that writes. It
is worth examining, because the same premise sits under every other use we have named for this —
a decomposer that reacts to items arriving for triage, dynamic fan-out, an external trigger that lands
as work. Each of them is described as "a workload that touches the board", and each therefore looked
like it reversed a deliberate isolation decision.

**The isolation is real and was chosen.** A worker runs in a worktree of its own, under
`permissionMode: 'dontAsk'` — deliberately not `bypassPermissions`, because a bare name in
`allowedTools` shadows `canUseTool` and "the allowlist would be decoration" (`src/runtime/claude.ts:135-149`)
— with the tool surface enforced by a `PreToolUse` hook that denies anything unlisted
(`src/admission.ts:94-97`). It is handed a brief and a set of paths to write, and nothing else. It has
no board handle because nobody gave it one.

**But the status quo is not the isolation it looks like.** `hkb new` is an ordinary command
(`src/hkb.ts:400-402`), and a Job whose tool surface includes `Bash` can run it. Board mutation by a
worker is therefore already possible today — with no lineage, no scope, and no refusal. The choice in
front of us was never *board access or no board access*. It is **a modelled transport, or the
unmodelled one that is already open.**

### Two transports, and only one of them is the obvious one

The ancestor's answer is an in-session API. Hermes gives its worker `kanban_complete(summary=…, metadata=…)`
— notably not raw board access but *one narrow verb*, exposed as a tool the worker calls while it runs.

The other answer is older and comes from the same place hkb takes the rest of its model. In Argo
Workflows, a fan-out generator writes a JSON list to an output *parameter*; the **controller** reads
that file and creates the fan-out. The generator has no ServiceAccount, no API access and no
credentials. It writes a file; the thing with authority reads it. Kubernetes' answer to "must a
workload that creates work talk to the API server" is **no**.

hkb already has the machinery for the second answer and calls it something else. ADR-008's `results`
is exactly this interface: the Job declares names, the controller hands it a path per name
(`withResults`, `src/brief.ts:50`), the run writes files, and the controller reads them back after the
run returns (`collectResults`, `src/results.ts:117`; called at `src/controller.ts:692`) into a
directory that sits beside the board, outside every checkout, on purpose (`src/results.ts:72-73`).

Everything a board mutation needs is in that shape already. What is missing is not a channel. It is
the decision that the channel is *allowed to mean something to the controller*.

## Decision

**A workload never writes to the board. When it wants the board changed, it declares a proposal as an
output, and the controller validates and applies it.**

1. **No board handle in a sandbox — as a rule, not as an omission.** No credential, no client, no
   `hkb` on the tool surface of a workload that proposes. This is enforceable today and with no new
   machinery: `allowedTools` is a ceiling the admission hook denies against (`src/admission.ts:94-97`,
   `prisma/schema.prisma` `Job.allowedTools`), so a proposing Job filed without `Bash` **cannot** shell
   out to `hkb new`. The rule earns its place by being refusable, which is the standard this codebase
   already holds guards to.

2. **The transport is the declared-output interface.** A proposal is an output like any other: named
   at declaration, written by the run to a path the controller gave it, read back when the run ends.
   Nothing about the *interface* changes. What changes is that the controller may act on one.

3. **What the controller applies, it validates by refusing.** This is the load-bearing obligation. A
   result the controller merely stores is an opaque value — `collectResults` is documented as reading
   "presence and size only — never meaning" (`src/results.ts:99-116`), and that is correct for a
   handoff. The moment the controller *acts* on one, that value stops being a handoff and becomes an
   **API request**: unknown fields refused rather than ignored, `maxBudgetUsd` clamped to the board's
   ceiling rather than trusted, `isolate` not overridable at all. A malformed or over-reaching
   proposal fails the attempt the way a missing declared output already does
   (`missingResults`, `src/results.ts:158`). Per the house rule, the validator ships with a test that
   makes it **refuse**, at the shipped defaults.

4. **Application is idempotent, because the controller is level-triggered.** Rows created from a
   proposal take a natural key derived from `(jobId, attempt, index)`, so a second reconcile pass over
   the same attempt creates nothing. A generated key would make re-running the pass — which
   `src/controller.ts` must always be safe to do — duplicate the batch instead.

5. **Nothing is applied without an approval event.** The gate is the admission control on this action:
   a proposal becomes rows only once ADR-010's approval has been recorded. That is not a demand for a
   human — the approver is a seat with three fillers, and the auto-approve policy is one of them — it
   is the requirement that *something with authority said yes*, and that the yes is on the Event
   stream where the controller already reads it (`src/controller.ts:725-727`).

6. **This does not make the Job kind into the DAG kind.** The distinction is ordering, not creation.
   A controller that creates Jobs and then forgets them is `CronJob`-shaped: the created Jobs are
   independent, unordered, and the creating Job goes terminal. A controller that creates Jobs *and
   holds edges between them* — tracking dependency satisfaction, fanning in — is the DAG, and remains
   the second kind ADR-007 decision 5 deferred. Creation-without-ordering is neither a field nor a
   kind; it is an action the existing controller takes on a validated manifest.

## Consequences

**The write becomes retry-safe, and this is the argument that outranks the others.** Results are
collected *after* the run returns, and only then does the attempt's decision get made
(`src/controller.ts:692`). A worker that dies mid-session leaves nothing collected and the attempt
retries clean. An in-session API call has no such property: a retried attempt **re-does its side
effects**, and the controller cannot tell the duplicates from the originals. This is the same reason a
level-triggered controller reconciles from spec rather than from events, applied one layer out — and
it means the artifact transport is not the polite version of board access, it is the correct one.

**The unmodelled path becomes closable.** Today the argument against denying `Bash` to workers is that
it is sometimes the only way to do a legitimate thing. Once there is a modelled transport, that
argument is gone for proposing Jobs specifically, and narrowing the surface costs a capability nobody
should have been using.

**Lineage stops being optional and becomes free.** If the controller creates the rows, it stamps them
with the attempt that proposed them. `Job` has no such column today — no `createdBy`, no parent — and
this is the first thing that needs one. It is worth noting *which* fact that column then holds: not a
claim a worker made about itself, but an observation the controller made about what it did.

**The proposal is auditable in a way a tool call is not.** It is a stored artifact on the Attempt: what
was proposed, next to what was created, next to who approved it. Board access gives no such record —
intent has to be inferred from the diff.

**It stays portable, which is value 1.** An in-session board API requires hkb to define a worker-facing
API surface *and* requires every runtime to inject credentials into its sandbox. A file is a file. Any
harness that can run a workload can write one.

**Three things get harder, and two of them are missing capabilities rather than costs.**

- **There is no channel with the right shape.** `results` is capped at 4096 bytes per value
  (`src/results.ts:32`), and that cap is load-bearing — its own comment says the number is "small
  enough that nobody mistakes this for file storage." A proposal carrying several Jobs with real prose
  briefs does not fit. `exports` is uncapped but lands *in the repository*
  (`exportOutputs`, `src/worktree.ts:346`), which is wrong for a proposal nobody wants committed. See
  the open question below.
- **There are no declared inputs.** ADR-008 shipped declared *outputs*; the input side of a Job is
  `job.brief` — a static string authored at file time — composed only with `withProtocol` and
  `withResults` (`src/brief.ts`). A decomposer's input *is* board state at run time, and nothing puts
  it there. This is the same gap `docs/workflow-study.md` §7 records from the other direction: Artic's
  measured gains come from the read side (−63% input tokens), and its Q4 was left conditional on
  "whether declared inputs sharpen what the hkb primitive is". They do. This answers Q4.
- **A board can now be stuck in a new way.** ADR-010 already noted that a gated Job is one a human can
  forget. A gated Job that is *holding a proposal* is worse: the work it describes has not been filed,
  so it is invisible to `hkb ls` as anything but one suspended row.

**What this record deliberately leaves open.** Which channel carries a proposal is a **sizing**
decision, and this record is a structural one. Three candidates, none free: raise the cap for a
declared proposal (cheap, but it is exactly the workaround `src/results.ts:24-31` warns against); give
`exports` a second destination beside the board rather than in the repository (small, and reuses a
mechanism); or add a third declared-output kind. The reason not to settle it here is that choosing the
channel wrong is cheap to correct and choosing the *rule* wrong is not. **Nothing ships until that
channel exists** — and this record does not authorise shipping half of itself, because ADR-008 already
ran that experiment and the unshipped half sat inert for long enough to be rediscovered as a defect.

**What it does not resolve.** hkb still has no triage state — `pending` means "wants to run", not
"wants to be decided about". For this flow that turns out not to matter: nothing is created until it
is approved, so created *is* admitted. Triage remains open for the **inbound** direction — an external
call arriving with something nobody has judged — which is the trigger half of
`docs/rebuild-plan.md` § "Parked" A, and a different problem with a different authz model.

**What has moved since, without changing the decision.** Both preconditions this record
withheld itself on now exist, and the channel question it left open was answered the third
way rather than either of the two cheaper ones.

- **The channel is a third declared-output kind.** `--artifact`: named files a Job must
  produce, collected into `~/.hkb/artifacts/<jobId>-<attempt>` — beside the board, outside
  every checkout, uncapped, catalogued rather than read (`src/artifacts.ts`). Raising the
  `results` cap was declined as the workaround its own comment warns against, and giving
  `exports` a second destination was declined because `src/results.ts:63-71` already argues
  that an output which must not be committed does not belong in the tree at all.
- **Declared inputs exist** (`src/inputs.ts`). A decomposer's input is board state at run
  time, and `--input state=board` now puts it there without a model or a board handle. The
  read side also refuses, by name, the source that would make it `Job.after`: reading
  another Job's output.

- **The validator ships**, which is the part this record is actually about
  (`src/proposals.ts`, `features/proposals`). `--propose` makes a Job write `proposal.json`;
  the controller refuses unknown fields by name, clamps `maxBudgetUsd` downward only, and
  applies nothing without an `approved` event. A proposed Job may set `name`, `brief` and
  that budget — `isolate`, `allowedTools` and `pluginPaths` are refused, so a worker cannot
  widen its successor's permissions.
- **The lineage column exists**, as three: `proposedByJobId`, `proposedByK` and
  `proposalIndex`, unique together. That is decision 4's natural key, and it is what makes
  the apply idempotent — the database refuses the second write, so nothing has to remember.

The consequence above that has not been paid is the tool surface: denying `Bash` to a
proposing Job is now *arguable* and is still not done.

**And the triage gap is half closed.** `Phase.triage` gives an **operator** somewhere to put an
undecided item — `hkb new --triage`, `hkb queue`, `hkb triage` — which is the half this record
described as *"`pending` means 'wants to run', not 'wants to be decided about'"*. The **inbound**
half it also names, an external call arriving with something nobody has judged, is untouched: that
one needs an authorisation model, not a phase (`architecture/job-kind`).

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
