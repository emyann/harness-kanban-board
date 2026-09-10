---
title: 'ADR-008: A Job declares its outputs, and the board gets them out of the sandbox'
summary: "A Job's deliverable becomes part of its spec rather than a consequence of `isolate`: `results` for small structured values the board keeps, `exports` for paths copied out of the worktree before teardown, and an undeclared output is litter. A declared output that is not produced is a failure, which is what finally makes `succeeded` mean something."
category: decisions
kind: decision
audience: [dev]
read_when: "adding a workload kind, changing withProtocol or isolate, reclaiming worktrees, or asking what a Job is supposed to produce"
status: accepted
date: 2026-09-05
supersedes: ~
superseded_by: ~
covers:
  - path: src/brief.ts
    sha: b3eddf6aebd95fdab1f38424b24851d6a4e3e5a2
  - path: src/controller.ts
    sha: 6563f3234641037e46504688115ac5ed4b76cf1b
  - path: prisma/schema.prisma
    sha: 373271e495bbdaa8225fddbf23528007efdcfd74
  - path: src/results.ts
    sha: a67f369f7e0806ea8fe10d6def7105ff2a65e131
  - path: src/artifacts.ts
    sha: 74efd4d0fc9f6f0e5bcce4379b55f533b81e9e6d
  - path: src/inputs.ts
    sha: 6ed576d25bf9db5f8b76e3752c17a250725df3b6
  - path: src/exports.ts
    sha: afa23e85d0df61d1d0d91587d425df2ad7a872a0
related: [decisions/adr-007-workload-scheduler, decisions/adr-018-the-boundary, architecture/job-kind, architecture/the-loop]
generated_at_commit: 62135e9
last_refreshed: 2026-09-10
---

# ADR-008: A Job declares its outputs, and the board gets them out of the sandbox

## Context

ADR-007 made a Job the primitive kind: one agent, one brief, run to completion. Its
spec has ten fields and **every one of them is about how to run** — `agent`, `model`,
`effort`, `maxTurns`, `timeoutMs`, `maxBudgetUsd`, `isolate`, `maxRetries`
(`prisma/schema.prisma`). Nothing declares what the Job is supposed to *produce*.

The deliverable is decided instead by one line in the controller:

```ts
prompt: wt ? withProtocol(job.brief, wt.branch) : job.brief,
```

`isolate` is doing two unrelated jobs — **where** the work happens, and **what** it must
produce. `withProtocol` (`src/brief.ts`) is prose asking for a commit, a push and a draft
pull request; it is appended only when a worktree was cut. So "run in your own checkout"
and "produce a pull request" cannot be chosen separately.

The card that exposed it: *create a skill, project-scoped, not committed*. Its deliverable
is a file in the working tree. Under the current shape it has two outcomes, both wrong:

- isolated, so `removeWorktree` deletes the artifact with the checkout — or
  `worktreeHasWork` sees the dirty tree and **keeps the worktree for ever**, stranding the
  artifact in `.kanban/worktrees/kb-N-1/`. Phase 5 produced **6.1 GB** that way;
- un-isolated, which works, but turns off the diff, the branch, the revertibility and the
  concurrency safety all at once — and the code's own comment says that path is *"the
  escape hatch for a read-only job"*.

Underneath both is a single fact: **`git push` is the only artifact store hkb has.** A
worktree is the pod filesystem and dies with the run; git happens to be a distributed
artifact store, so a pushed commit is the one durable exit that exists. The pull-request
coupling is therefore not an arbitrary policy that can simply be deleted — it is the only
channel, and un-coupling it means building the second one.

`Attempt` records outputs as three git-shaped columns — `branch`, `prNumber`, `prUrl` —
plus `summary`, the agent's final prose truncated to 2000 characters. For a Job that
produces anything else, all four are null or unstructured.

### What four other systems do

Every one of them splits this in two, and declares both in the spec:

| System | Small structured values | Files and directories |
|---|---|---|
| Argo Workflows | `outputs.parameters[].valueFrom.path`, `default` for a missing path | `outputs.artifacts[]` — `name`, `path`, `archive`, `optional` → an artifact repository |
| Tekton | `results` — 4096 bytes, riding the Kubernetes container termination message, shrinking as steps are added | `workspaces` — a mounted volume |
| Kubernetes | the termination message (4 KB) | volumes: `emptyDir` dies with the pod, a PVC survives |
| Bazel | — | declared outputs moved out of the sandbox into `execroot`, then the sandbox is deleted |

Bazel states the rule this ADR takes: the sandbox *"moves the known output artifacts out
of the sandbox into the execroot and deletes the sandbox"*, which prevents *"littering the
execroot with unknown output files."* Read against hkb, the sandbox is the worktree, the
execroot is `Board.repoPath`, and the litter is the 6.1 GB.

Tekton and Argo add the other half: the process **writes to a path the system chose**
(`$(results.<name>.path)`, `valueFrom.path`) and the controller reads that file. Neither
parses the process's own account of itself, which is exactly what `Attempt.summary` is.

## Decision

**A Job declares its outputs. The board is responsible for getting them out of the
sandbox. An undeclared output is litter.**

Two mechanisms, mirroring the split above, both declared in the Job spec:

1. **`results`** — named, small, structured values the worker writes to a path the
   controller gives it, and the controller stores on the Attempt. Size-capped
   deliberately: a handoff that can hold a megabyte becomes a worse artifact store, which
   is the constraint Tekton lives with rather than works around. This is what a later
   graph node reads — *"review the pull request the previous node opened"* needs
   `results.prUrl`, not prose.
2. **`exports`** — declared paths copied out of the worktree into `Board.repoPath` before
   teardown. The skill card becomes `exports: [".claude/skills/sdk-docs/"]`.

**A declared output that is not produced fails the attempt.** This is the rule that makes
a declaration worth writing down, and it answers the standing complaint that `succeeded`
means only that a session ended: `nextPhase` reads the runtime's status and has never
looked at what the run produced.

**`isolate` returns to meaning one thing — where the work runs.** The pull-request
protocol becomes one declarable output shape among several, selected by the spec rather
than implied by having a worktree.

**No artifact repository.** Argo needs one because pods land on arbitrary nodes; hkb is one
machine and the checkout is the destination. This is Bazel's execroot, not Argo's S3, and
building the latter before a second host exists would be inventing a problem.

## Consequences

**The worktree sweep becomes safe, which reverses an earlier finding.** `removeWorktree`
refuses a dirty tree today because it cannot tell work that matters from litter, so it
keeps everything for ever. With declared outputs it can tell: copy the declared ones out,
then delete unconditionally. The export design and the worktree-reclaim design are the
same design, and the note in `docs/rebuild-plan.md` proposing a narrower
unpushed-versus-ahead-of-base test is superseded by this.

**A Job stops being able to succeed silently.** Verification is per output kind and each
one is cheap: a pull request is `gh pr list --head`, an exported path is a stat, a result
is present or missing. Nothing depends on believing the agent.

**The DAG kind becomes expressible.** A graph node consuming the previous node's work
needs a typed place to read it from. Adding an artifact kind currently means adding a
column to `Attempt`; with `results` it means adding none. This is a precondition for the
second kind ADR-007 deferred, not a tidying of the first.

**Two things get harder.** Filing a Job gains a decision — what should this produce? — and
the honest default for a brief that produces nothing on disk is to say so rather than
leave it implied. And the closed set of output kinds is a set someone must extend; that
friction is deliberate, because the alternative is a per-Job schema, which is a type
system in the board that a model can satisfy by assertion.

**What this does not decide.** Where an artifact outside the repository goes — a global
skill, an external system — is left open; it is the mirror of `.worktreeinclude` (files
crossing *into* a worktree) and needs its own record. The size cap for `results` is left
to implementation. And nothing here changes that `succeeded` is a fact about the process:
whether the work is any *good* remains a judgement, and judgements still belong to a kind
that has a reviewer in it.

**What has moved since, without changing the decision.** Both of the things left open
above have since been settled, and the rule this record states — *a declared output that
is not produced fails the attempt* — carried across both unchanged.

- The size cap for `results` is 4096 bytes per value (`src/results.ts:32`), Tekton's
  number, per result rather than across all of them.
- The output that belongs outside the repository is a **third declared kind**:
  `--artifact`, files collected into `~/.hkb/artifacts/<jobId>-<attempt>` beside the
  board, uncapped, catalogued onto the Attempt as `[{name, kind, bytes}]` rather than
  read (`src/artifacts.ts`). ADR-011 is the record that needed it and names why the
  other two could not be stretched to fit. The mirror this record predicted —
  `.worktreeinclude` for files crossing *in* — is still the shape it turned out to be,
  except that a proposal must not be committed, which is what ruled `exports` out.
- Declared *inputs* arrived too (`src/inputs.ts`): the read side this record did not
  have, and the reason it did not need one. It changes nothing above; a Job still
  declares what it produces, and now also what it is given.

Two things this record did not anticipate: a run can now fail for producing nothing
(`Outcome.no_output`) *or* for being unable to read what it was given
(`Outcome.no_input`, before any money is spent), and `results` grew a second layer —
values the run wrote without declaring are kept and reported, never required
(`collectResults`, `src/results.ts`).

**What ADR-018 changed, and what it did not.** The rule this record is about — *a declared output
that is not produced fails the attempt* — is untouched, and ADR-018 leans on it: with the forge read
gone, declared outputs are the **only** evidence a Job produced anything. Four citations above moved
with it:

- **`exportOutputs` and `checkExportPath` are `src/exports.ts`**, out of the deleted
  `src/worktree.ts`. They now collect from `WorkerOutcome.workspacePath` — where the runtime says
  the session actually ran — rather than from a checkout path the controller had computed.
- **`producedNothing` no longer counts a pull request** (`src/read.ts:68`). It asks only about
  declared exports, results and artifacts, which is the question this record wrote down; the branch
  lookup on a forge that used to answer alongside it is gone with `Attempt.prUrl`. *"A Job whose real
  deliverable IS a pull request now says so by declaring one"* is the code's own restatement of the
  paragraph above.
- **The pull-request verification named in Consequences — `gh pr list --head` — has no caller.**
  Nothing in the core shells out to `gh`. The other two verifications in that sentence, a stat for an
  exported path and presence for a result, are what remain and are what run.
- **The worktree sweep argument was right and its mechanism is gone.** `removeWorktree` and its
  dirty-tree refusal are deleted; a workspace now dies on `ttlSecondsAfterFinished`
  (`BUILT_IN_TTL_SECONDS`, `src/workspaces.ts`) rather than on an inspection of what is inside it.
  This record's claim was that declared outputs make the sweep *safe to do unconditionally*, and an
  unconditional TTL is that claim taken further than this record went.

**`isolate` finished returning to meaning one thing, and then left the spec.** This record's
sentence — *"`isolate` returns to meaning one thing — where the work runs"* — was completed by
ADR-017 (the pull request became a step's content) and then superseded in mechanism by ADR-018
decision 2: the workspace is declared on the runtime seam and provisioned by the runtime, so
`Job.isolate` selects between a workspace and the repository itself and decides nothing about what
the Job must produce.
