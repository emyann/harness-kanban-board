---
title: Per-PR CI does not compose
summary: "Four collisions where every PR was individually correct and CI-green: what parallel workers on one base actually collide on (shared invariants, not shared files), and why briefing fixed it where machinery could not."
category: gotchas
kind: explanation
audience: [dev]
read_when: "filing a batch of Jobs against one repository, reviewing several agent PRs cut from the same base, or designing how a graph kind would decompose work"
covers:
  - path: src/controller.ts
    sha: 6563f3234641037e46504688115ac5ed4b76cf1b
  - path: src/limits.ts
    sha: 18849fb4775cabb4c5d65784f506d61d90c66f1f
  - path: src/workspaces.ts
    sha: b709212e781376f570a613907a209648dab91526
  - path: src/hkb.ts
    sha: 34ab3eea05412ec969d728978076d2634efdb1c5
  - path: prisma/schema.prisma
    sha: 6e249ec160c4a441ad45255f65470bb94267cf6f
related: [architecture/job-kind, architecture/the-loop, concepts/ceilings, decisions/adr-007-workload-scheduler, decisions/adr-008-declared-outputs, decisions/adr-018-the-boundary]
generated_at_commit: 26055f1
last_refreshed: 2026-09-10
---

# Per-PR CI does not compose

> Two dogfooding rounds in September 2026 ran hkb's own work on the board. Both
> produced pull requests that were individually correct, individually green, and
> jointly broken. This page is the history of four such collisions and what was
> actually learned from them — chiefly that the thing parallel workers share is
> not the files they edit but the *invariants* they assume, and that the only
> thing that fixed it was the brief.

This is a history page. The episodes are recorded in `docs/rebuild-plan.md` and
in the commits that wrote it; the code they touched has moved since, and where
it has, the commit is cited rather than a live line.

## Episode 1 — green alone, red together

The first round filed ten Jobs against hkb itself. All ten pull requests were
green on all seven CI legs and reported `MERGEABLE`
(`docs/rebuild-plan.md:371`). Three touched no shared file; the other seven all
edited the same entry-point module, and **nine of the ten merged with no textual
conflict** — only one needed a rebase, and that resolution was "both sides
appended tests at the same point, keep both" (`docs/rebuild-plan.md:375-383`).

The failure was in a pair git had nothing to say about. `#350` added a listing
verb that ignores the board scope; `#354` made board resolution *refuse* when
several boards point at one checkout, instead of silently taking the lowest id.
Each is correct. Each passed every leg alone. Merged together, three of `#350`'s
tests failed with a refusal naming four boards
(`docs/rebuild-plan.md:389-399`).

Neither PR introduced the defect. The mainline resolved a board scope for
**every** verb before the verb's own switch ran, so the new listing verb resolved
a board and discarded it — harmless while resolution could not fail, a refusal
the moment it could (`docs/rebuild-plan.md:401-403`). The repair landed as `#361`
(`docs/rebuild-plan.md:384`).

That shape is still visible in today's entry point, which now names the machine-wide
verbs explicitly and carries the episode in its own comment
(`src/hkb.ts:703-714`). The module was called `src/kb.ts` at the time; the rename
came with ADR-009, so the file name in the record is history and the behaviour is
not.

## Why no machinery could have caught it

The argument is the author's own, in the commit that recorded the round —
`015204f`, *"Record how the ten merged, and the failure only integration could
find (#362)"*, 2026-09-05:

- Every branch is cut from the mainline at claim time and never rebased by the
  machinery. The workspace is asked for on the serial side of the reconcile pass,
  at the moment of the claim (`src/controller.ts:853-870`), and the runtime cuts
  it from the repository's default branch.
- CI runs per branch.
- No step compares one Job's diff against another's.

> **All three are true again, after a round trip.** Between those commits and
> ADR-018 the controller *did* fetch the base and replay the branch onto it after
> the run — `src/rebase.ts` — and this page carried a note saying so. That module
> is deleted, `Job.base` with it, and the only rebase a worker does now is one a
> workflow file asks it to do (`.hkb/workflows/implement.md`). The argument was
> written to survive the rebase and it survived its removal too, which is the point:
> a rebase answers the merge-conflict question, and **nine of the ten collisions had
> no merge conflict to answer.** With `Job.base` gone, siblings share the default
> branch again by construction, so the page holds without a qualification.

So the further a batch runs, the more each Job's base diverges from what will
actually be merged (`docs/rebuild-plan.md:572-577`).

Two misreadings are worth killing on sight, because both were available and both
are wrong:

**It is not a merge-conflict problem.** Git reported no conflict on nine of the
ten (`docs/rebuild-plan.md:376-378`). A tool that watches for overlapping hunks
would have said nothing.

**It is not a concurrency problem, and serialising does not help.** The board's
concurrency ceiling was 1 for that run, so the ten Jobs did not execute at the
same time at all (`docs/rebuild-plan.md:405-409`). What they shared was the
**base**, not the clock. Lowering the ceiling changes when work runs; it does not
change what each worker branched from.

## Episodes 2 and 3 — two PRs that could not merge

The second round filed the first round's findings as cards and let the board run
them: thirteen cards, twelve shipped, $124 total, recorded 2026-09-05
(`docs/rebuild-plan.md:438-456`, commit `752a5ca`). Two of those PRs could not
merge at all. Each was correct alone; each collided with something that landed in
between (`docs/rebuild-plan.md:466-468`).

**`#370` — declared exports, against the sweep.** The worktree-sweep card shipped
first as `#366`, which is what made `.kanban/worktrees` reclaim itself — 4 KB
where it had been 6.1 GB (`docs/rebuild-plan.md:450`). Exports and removal are the
same question asked from two directions: what is left in a checkout after a run,
and who is allowed to delete it. The joint design that resolved it —
one keep-test in which a Job's declared exports waived the *dirty* half and
explicitly not the *unpushed* half, plus a later sweep asking the same question at
the time it could be answered — is what the second attempt had to write; the first
attempt had been written against a mainline where the sweep did not exist.

> That resolution has since been deleted in its entirety. ADR-018 replaced the
> inspect-the-tree keep-test with `ttlSecondsAfterFinished` — a clock over the
> workspace names hkb asked for, with no question about what is inside them
> (`src/workspaces.ts`, `howto/running-the-daemon`) — so `removeWorktree` and
> `sweepWorktrees` no longer exist to cite. **The episode is unaffected**, which is
> why it stays: what collided was two cards moving the same invariant, and that is a
> fact about how the work was decomposed rather than about the code either one
> landed.

**`#372` — board spec defaults, against committed-but-unspent budget.** The
parallelism card shipped first as `#374`, which rejected the cheap option and
added `committedUsd` (`docs/rebuild-plan.md:455`). Its reasoning was that
`spent24h` only moves when an attempt *ends*, so N concurrent claims would each be
judged against a spend none of them had contributed to
(`docs/rebuild-plan.md:458-462`) — the same argument now written into the input's
own doc-comment (`src/limits.ts:36-53`).

## The generalisation: invariants, not files

This is the part that cost the most to learn and is cheapest to forget.

`#372` and `#374` read as unrelated by title — "board defaults" and
"parallelism". They collided because both touch the claim gate, which only
reading that one function reveals (`docs/rebuild-plan.md:584-587`). The gate is
`gateClaim`, three refusals over one set of inputs (`src/limits.ts:63-103`), and
the invariant the two cards both moved is *what a claim is charged against*:
"parallelism" added the committed-but-unspent term to the projection
(`src/limits.ts:85`), while "board defaults" made a Job's cap nullable so a board
default could fill it — which is exactly the column the gate has to sum over open
attempts.

The resolution of that collision is still legible in the schema. The second
attempt chose to freeze the resolved cap onto the Attempt rather than re-derive
it, and argued the cost into a feature (`docs/rebuild-plan.md:456`, `:469-470`);
the doc-comment on `Attempt.maxBudgetUsd` sets out the three options and why the
freeze is the only one that stays correct when an operator edits a board's default
mid-flight (`prisma/schema.prisma:498-543`).

The recorded consequence: **what collides is not shared files but shared
invariants**, and a decomposer that splits work by area reproduces this exactly
(`docs/rebuild-plan.md:584-587`). Two cards can share no file, no directory and no
title keyword, and still both depend on the same sentence being true.

## Episode 4 — the thing that actually worked was the brief

Both blocked PRs landed on a second attempt, re-run with the collision *in the
brief*: `#375` wrote exports on top of the sweep, and `#377` chose the freeze
(`docs/rebuild-plan.md:466-470`). A later pair, recorded only as `#19` and `#20`,
was run the same way, and `#19` landed clean
(`docs/rebuild-plan.md:589-590`).

The record is explicit that this is a **briefing practice rather than a machinery
one** — "worth remembering when the DAG kind makes it tempting to solve in the
graph" (`docs/rebuild-plan.md:470-471`). Nothing in hkb detects or prevents a
composition failure today. What worked was telling the second attempt what the
first had collided with, which is a sentence in a brief and not a check anywhere.

## The standing decision, as recorded

**DECIDED 2026-09-05** (`docs/rebuild-plan.md:579-590`, commit `925fe1f`): the
DAG kind is the answer and this waits for it. A dependent node based on its
predecessor's *merged* work turns "two agents from one base" into "one agent from
the other's result", which is a fix rather than a mitigation.

That kind does not exist. ADR-007 records the DAG as a second kind whose
controller creates Jobs, and `Job` is still the only kind there is
(*decisions/adr-007-workload-scheduler*, *architecture/job-kind*). Two things were
written down at decision time so the design would not rediscover them:

- **Siblings are still parallel and still share a base**, so the guarantee only
  covers the edges the decomposition actually draws. A graph does not make its own
  breadth safe.
- **Area-based decomposition reproduces the invariant collision.** Splitting by
  file, module or feature area is precisely the split that put "board defaults"
  and "parallelism" in different lanes.

## Related

- [architecture/job-kind](../architecture/job-kind.md)
- [architecture/the-loop](../architecture/the-loop.md)
- [decisions/adr-007-workload-scheduler](../decisions/adr-007-workload-scheduler.md)
- [decisions/adr-008-declared-outputs](../decisions/adr-008-declared-outputs.md)
