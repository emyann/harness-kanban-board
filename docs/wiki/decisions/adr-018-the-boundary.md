---
title: 'ADR-018: The boundary — hkb is Kubernetes for agent sessions, and the board is Tekton on top of it'
summary: "Every session re-argues where the line between hkb-the-machinery and hkb-the-board falls, and every session the code ends up conflating them again — so this writes the line down as a rule with a test, records the measurements that fix where it falls, and answers the two questions that keep reopening it: whether the product needs its own store (no) and what the runtime actually provides (much more than hkb had assumed)."
category: decisions
kind: decision
audience: [dev]
read_when: "adding a field to Job, adding a module to the core, deciding whether something is machinery or product, wondering whether the harness already does it, or arguing about the store"
status: accepted
date: 2026-09-10
supersedes: ~
superseded_by: ~
covers:
  - path: src/runtime/index.ts
    sha: a325ddd4b03fd864bb2c556aaa7925ed1a95a0e9
  - path: src/runtime/claude.ts
    sha: e3afb9de9e34d90f222e7bf9865cbad39e99044b
  - path: prisma/schema.prisma
    sha: 6e249ec160c4a441ad45255f65470bb94267cf6f
  - path: src/controller.ts
    sha: 6563f3234641037e46504688115ac5ed4b76cf1b
  - path: src/workspaces.ts
    sha: b709212e781376f570a613907a209648dab91526
  - path: src/exports.ts
    sha: afa23e85d0df61d1d0d91587d425df2ad7a872a0
generated_at_commit: 26055f1
last_refreshed: 2026-09-10
related:
  [
    decisions/adr-007-workload-scheduler,
    decisions/adr-015-machinery-and-consumer,
    decisions/adr-016-the-pod-spec-is-the-map,
    decisions/adr-017-the-workflow-is-content,
    architecture/job-kind,
    architecture/runtime-layer,
  ]
---

# ADR-018: The boundary

**This record exists because the argument keeps being won and then lost again.** ADR-015 drew the
machinery/consumer line and stopped short of enforcing it. ADR-016 mapped the Pod spec and filed a
deadline under `resources.limits`. ADR-017 moved the pull request out of the core and left the push
in it. Each was right and each was re-litigated a session later, because none of them left behind a
*test* for which side a thing is on — only a description, and a description is something the next
session re-derives from whatever the code happens to look like by then.

The code is the evidence for how badly that goes: `Job` today carries `gate`, `proposes`, `check`,
`exports`, `results`, `artifacts`, `guide`, `inputs`, `labels` and `base`, and the controller that
runs it knows about branches, pushes, rebases, pull requests and a `pre-push` hook. Every one of
those arrived through a door this record is closing.

## The two things, named

**hkb, the machinery.** *Kubernetes for agent sessions.* It knows one kind — `Job` — and its whole
contract is: **cut a workspace, run one agent session under limits, record what happened, clean
up.** Leases, ceilings, retries, deadlines, phases, the record. It has never heard of a branch, a
pull request, a review, a card, a column or a workflow.

**hkb, the board.** *The product, and it is Tekton's shape:* kinds of its own — Workflow, Step, and
whatever the kanban needs — with a controller of their own, built **on** the Job kind. Tekton's
`Task`/`TaskRun`/`Pipeline`/`PipelineRun` do not live inside `batch/v1`; they are a separate API
group with a separate controller that *creates Pods*. The board is that, and the Job kind is the
Pod it creates.

## The test

One question decides every case, and it is the direction of the dependency:

> **Does `batch/v1` have a field for it?** If not — does the thing make sense for a workload that
> is not code, has no repository and files no pull request?

If the answer is no, it is the board's, and the core must not name it. The core may never import,
read, or have an opinion about a board concept; the board may freely use core primitives. A single
import in the wrong direction is the whole failure, and it is greppable.

Corollary, stated because it is the case that keeps slipping through: **a field on `Job` that only
the board would ever set is a board field on a core row.** It does not become core by living there.

## Decision 1: one store, separate kinds — not two stores

The recurring proposal is that the machinery gets its own state (an etcd analogue) and the product
keeps SQLite, because "the schema is messed up". The schema *is* messed up. Two stores is not the
fix, and Kubernetes is the direct evidence: **Tekton has no datastore.** Its CRDs are persisted in
the same etcd, served by the same API server, as `batch/v1`. What separates them is not storage:

1. a distinct **API group and version**,
2. a distinct **controller**, and
3. a **one-way dependency** — the Job controller has never heard of Tekton.

All three are achievable in one SQLite file, and buying a second store instead would cost the one
property that makes a reconciler safe: a single place to compare desired against observed, in one
transaction. So: **one board file. Separate tables per kind. Separate controllers. One-way
dependency.** The `Job` table holds a JobSpec and nothing else; everything the board needs becomes
rows of the board's own kinds.

## Decision 2: `isolate` is not a JobSpec field — the runtime provides the workspace

`batch/v1` has no isolation field, and that is not an oversight: a PodSpec **declares** `volumes:`
and a workload never provisions storage. The kubelet and its plugins do, because how a volume comes
into existence is a property of *where it runs*.

So the workspace is declared on the runtime seam (`WorkerSpec.workspace`) and satisfied by the
driver, and `WorkerOutcome.workspacePath` reports back where it actually landed. The controller does
not cut it, name it, or know what it is made of.

## Decision 3: `Job.base` goes, and so do `Attempt.branch`, `prNumber`, `prUrl`

`Job.base` is the field that drags git back into the core: an arbitrary base branch is only
meaningful to a workload that is code in a repository, and it is what forced the controller to fetch,
resolve, validate and rebase refs. It is also not expressible by any transport (below). A Job that
must start from a particular pull request is a **board** concern, expressed by a board kind.

## What the runtime already provides — measured 2026-09-10, not assumed

hkb had reimplemented a large part of its harness. Each row below was verified by running it:

| hkb had built | the harness already does |
|---|---|
| `createWorktree` | `--worktree <name>`, reachable from the SDK via `extraArgs` |
| `INCLUDE_FILE = '.worktreeinclude'` | `.worktreeinclude` — the same filename, invented twice |
| `fetchBase` | `worktree.baseRef: "fresh"` keeps `origin/HEAD` current, 5s cap, cached fallback |
| `lockWorktree` | takes a `git worktree lock` for the length of the run |
| `newestWorktree` (resume into the same tree) | an SDK resume returns the session to its worktree |
| the `pre-push` fence | session-layer isolation checks that cover **every subagent** and cannot be disabled |

**The SDK is a wrapper around the CLI** — it spawns the Claude Code executable — so any flag is
reachable through `extraArgs`, an untyped `Record<string, string | null>`. That is an acceptable
dependency (Claude Code moves faster than the SDK's typed surface, and this is the documented escape
hatch), on one condition: **it is untyped, so it needs a test that fails when the flag stops
working.** `test/workspace.live.test.ts` is that test, and it was checked by renaming the flag —
it fails in 193ms, before spending anything.

### The two things the harness does NOT do for us

1. **It will not sweep our worktrees.** The periodic sweep covers *subagent* and *backgrounded
   session* worktrees, aged by `cleanupPeriodDays`; a `--worktree` session that was never
   backgrounded is left alone "whatever its age", and a headless run gets no exit prompt. So hkb
   collects its own — which is correct anyway: `ttlSecondsAfterFinished` is a **JobSpec field**, the
   TTL controller is part of the control plane, and the volume dies with the Pod. It becomes a TTL
   over the names hkb asked for, not a heuristic that inspects trees for unpushed work.
2. **No transport can express an arbitrary base branch.** `--worktree` takes a name or `#<PR>`, and
   `worktree.baseRef` is a settings-level `"fresh" | "head"`. This is independent confirmation of
   decision 3.

## Decision 4: the ask needs no new transport — hkb had configured it away

`src/runtime/claude.ts` justifies `permissionMode: 'dontAsk'` with *"a worker has nobody to answer a
prompt."* On a board that premise is false, and the missing half of the gate (admission vs **ask**)
was blamed on `query()` taking a string prompt rather than a live interactive session.

Measured, and it is not the transport. With a **plain string prompt**, `canUseTool` fires, the
session **waits** for the answer, and then proceeds. What suppresses it is hkb's own configuration,
and the SDK says so itself:

> `canUseTool will not be invoked for: <tools>`. **Bare `allowedTools` entries auto-approve the whole
> tool before the callback is consulted.** To gate every tool call, use a PreToolUse hook; or remove
> the bare names from `allowedTools` so they fall through to `canUseTool`.

hkb passes bare names *and* `dontAsk`. The ask was configured away, twice over.

**But holding the callback open is not how a Job suspends.** `JobSpec.suspend` deletes the Pods and
recreates them later; it does not park a live process. A Job waiting three days for a person must not
be a node process holding a session open, and a controller that is level-triggered cannot depend on
having been alive when the question was asked. So:

- **The durable ask is the default.** `canUseTool` records the question, refuses the call with a
  reason, the session ends cleanly keeping its session id, the Job goes `suspended`, and the answer
  arrives as a resumed session. This survives a restart, which is the property that matters.
- **The held ask is an optimisation** for a person who is actually watching, and it is the only
  thing that would justify streaming input mode. It is not the default and nothing may depend on it.

### A decision, not just a permission — and both modes measured

The interesting case is not "may it run `rm`" but "which of these should I do", which is what a board
is *for*. Claude Code has a tool for exactly that — `AskUserQuestion`, whose input carries 1–4
questions each with 2–4 labelled options and descriptions (`sdk-tools.d.ts`) — and it is an ordinary
tool, so it arrives at `canUseTool` with its full structure. `onUserDialog` does **not** fire for it
(measured); nothing has to be scraped out of prose.

`PermissionResult` supplies both modes exactly:

| | mechanism | measured |
|---|---|---|
| **held** | `{behavior: 'deny', message: '<the answer>'}` | the model reads the message as the tool's result and carries on in the same session — asked TOML-or-YAML, answered TOML, concluded `CHOSE=TOML`, $0.061 |
| **durable** | `{behavior: 'deny', message, interrupt: true}` | the run stops at once, spending **$0.001**, and the session id survives; resuming that id with the human's answer as the prompt produced `CHOSE=TOML` on the same session |

So the board's suspended card can show the real question with its real options, and answering it
resumes the very session that asked. Parking is effectively free, which matters because a Job may
park several times in one piece of work.

### The trap, and the shape of the fix

A run stopped this way comes back as `error_during_execution` carrying
`terminal_reason: "aborted_streaming"` — **the identical value the operator's own stop produces**.
`statusOf` maps that to `timeout`, `nextPhase` maps `timeout` to `timed_out`, and `timed_out` is
*resumable and transient*. So the failure is not a mislabelled record: the Job **retries, asks the
same question, parks again**, and spins until `maxRetries` is exhausted. Three questions and a Job
that was working perfectly is `failed`.

The SDK cannot be asked to distinguish the two, because it genuinely cannot: both are somebody
aborting the stream. So the fix is not a better reading of the runtime's report. It is three things,
and the first is the one that makes the others honest:

1. **Write the question at ask-time, inside `canUseTool`, before returning the deny.** Not inferred
   after the run. That is what makes it durable: if the process dies between the ask and the record,
   the question still exists, and the next pass sees an attempt with an unanswered question instead
   of reclaiming it as `lost`. A controller that is level-triggered may not depend on having been
   alive when the question was asked.
2. **Classify from hkb's own record, not the runtime's.** The precedence ladder already has this
   exact row for the operator's stop — *"The operator's intent outranks whatever the runtime made of
   being cut off... recording either would be a lie about why it ended AND would spend a retry on
   it."* A park is that sentence with one word changed, and it belongs directly above it. Never from
   `terminal_reason`, and never by parsing the `[ede_diagnostic]` prose.
3. **A park spends no retry.** `charged` excludes `stopped` and `completed`; it must exclude a park
   too, or point 2 fixes the label and leaves the spin.

**In Kubernetes terms this is `podFailurePolicy`, and the trap exists because hkb has not adopted
it.** hkb hardcodes "which outcomes spend a retry" inside `nextPhase`, classified by the runtime's
own words. Kubernetes made that a spec field precisely so a stop caused by *the system* rather than
the workload can be matched and given `action: Ignore` — not counted against `backoffLimit`. A park
is a **disruption, not a failure**: `DisruptionTarget`, ignored. The three points above are the
instance; adopting the field is the general answer, and it is already on the list.

**One measured convenience that makes all of this testable:** `permission_denials` on the result
message carries the *entire* parked question — every option with its description, and the
`tool_use_id`. So the controller has a second, independent read of the same fact, and the **fake
runtime can produce one**, which means the whole park → suspend → answer → resume path gets a test
that spends nothing and runs at the shipped defaults. `WorkerOutcome.denials` is a bare count today
and would have to carry the questions, not just how many there were.

## The audit: every field on `Job`, against this record's own test

The git protocol was the conflation that was *generating bugs*, so it went first. It is not the only
one. Below is the test applied to every field the `Job` kind carries, so the next session reads a
verdict instead of re-deriving one — which is the whole reason this record exists.

**Core — `batch/v1` or the PodSpec has the field, and it makes sense for a workload that is not
code:**

`id` · `boardId` (Namespace) · `name` (`metadata.name`) · `brief` (the container's command — this
*is* the workload) · `model` · `effort` · `maxTurns` · `maxBudgetUsd` (`resources.limits`) ·
`attemptDeadlineSeconds` (`template.spec.activeDeadlineSeconds`) · `activeDeadlineSeconds`
(`JobSpec.activeDeadlineSeconds`) · `maxRetries` (`backoffLimit`) · `allowedTools`
(`serviceAccountName` + RBAC) · `labels` (`metadata.labels`) · `phase` / `lastError` / `finishedAt`
(`status`) · `attempts` (Pods) · `lease` · `events`.

**Fails the test — board vocabulary on a core row:**

| field | why it fails | where it belongs |
|---|---|---|
| `proposes`, `proposedByJobId`, `proposedByK`, `proposalIndex` | **a Job that files Jobs is a controller.** `src/controller.ts` calls `db.job.create` on its behalf — the core's only write of a workload it did not receive | a board kind whose controller creates Jobs, which is what Workflow/Step is |
| `gate`, `suspendedFor` | `batch/v1` has `suspend`, but it is a field a **client sets**, not one a workload requests. "Suspend me when I finish, and ask a person" is a step in somebody's process | Step |
| `guide` | resolves against `Board.repoPath` (`src/guide.ts`). A workload with no repository has no contributor guide | Step content, or a generic "prepend this text" that names no repository |
| `exports` | copies declared paths **into `Board.repoPath`** (`src/controller.ts`). Same presumption | Step |
| `results`, `artifacts` | these are **Tekton Task Results**, not `batch/v1`. They are the right mechanism and the wrong kind | Step — and they are exactly what a Step's edges carry |
| `endedBy`, `endedFor` | who cancelled it and why. Kubernetes deletes the object and the audit log answers this | board |
| `check` | `successPolicy` is the nearest field, so the *concept* is core; the implementation shells out into a workspace, which presumes a shell and a suite | borderline — leave until Step exists, then decide |

**Structurally wrong rather than misplaced: `isolate`.** It is a boolean where the analogue is a
**StorageClass** — a workload asks for a class by name and never names a provisioner. Two values and
one driver make the boolean survivable today; it is the field that gets more expensive with every row.

### What this does NOT license

**Nothing above moves yet, and that is a decision rather than an omission.** Every one of them needs
somewhere to go, and that somewhere is the board's kinds, which do not exist. Deleting them now would
delete shipped features with no home — which is the opposite of what the git protocol's removal did,
where the destination (a workflow file) already existed and was already being used.

The order this implies, when Workflow/Step lands: `proposes` first (it is the only one that makes the
core *write* a workload), then `gate`, then the `guide`/`exports`/`results`/`artifacts` group, which
are all one question — what a Step declares and what its edges carry.

## Consequences

- The core deletes `src/worktree.ts`, `src/push.ts`, `src/pre-push.ts`, `src/rebase.ts` and
  `src/pulls.ts`. Nothing in the machinery shells out to `gh`, and nothing installs a git hook.
- `.hkb/workflows/implement.md` stops passing `--base`: with `Job.base` gone the base is always the
  repository's default branch, which is what `gh pr create` already defaults to.
- The board's kinds do not exist yet. Until they do, the things this record moves out of `Job` have
  nowhere to go — that is expected, and it is the reason those features pause rather than being
  reimplemented inside the core "for now".
- Cards #46, #50 and #67 had pencilled ADR-018/019/020 for other subjects; those numbers move.

## What has landed since — 2026-09-10

The Consequences above are written in the future tense, so a reader needs to know which of them
happened. **Decisions 1–3 are implemented; decision 4 is designed and has no code.**

- **The git protocol left the core.** `src/worktree.ts`, `src/push.ts`, `src/pre-push.ts`,
  `src/rebase.ts` and `src/pulls.ts` are deleted, and `Job.base`, `Board.defaultBase` and
  `Attempt.branch`/`prNumber`/`prUrl` are dropped by
  `prisma/migrations/20260910033358_the_git_protocol_leaves_the_job_kind`. The context paragraph
  above — *"`Job` today carries … and `base`"* — is therefore a description of the day this record
  was written, not of the schema now.
- **The workspace is declared, not cut.** `WorkerSpec.workspace` and `WorkerOutcome.workspacePath`
  (`src/runtime/index.ts`); asked for by name and collected on a TTL (`workspaceName`,
  `BUILT_IN_TTL_SECONDS`, `src/workspaces.ts`). The name is `kb-<jobId>` — per **Job**, not per
  attempt — because the harness reopens a tree that already carries that name, which is the
  judgement `newestWorktree` used to make by hand.
- **`extraArgs` is verified in the controller, not only in the live test.** `test/workspace.live.test.ts`
  is gated on `HKB_LIVE_SDK=1`, so `isolationShortfall` (`src/controller.ts`) additionally fails a
  *completed* run whose reported workspace realpaths to the repository itself — keeping the session,
  so `hkb retry` continues rather than re-buys it.
- **The boundary is a test.** `test/boundary.test.ts` refuses the five deleted module names and any
  import of them from a closed list of the Job kind's files. That is the thing this record says
  ADR-015, ADR-016 and ADR-017 each lacked.
- **`exportOutputs` moved to `src/exports.ts`** with `checkExportPath`, out of the deleted
  `src/worktree.ts`, and collects from `WorkerOutcome.workspacePath` rather than from a path the
  controller computed.

**One correction to the text above.** `enum Outcome` no longer carries `conflicted` — it was removed
from `prisma/schema.prisma` rather than kept, though comments in `src/controller.ts` still say the
value stays for rows that already carry it. The migration does not rewrite the `outcome` TEXT
column, so pre-existing rows keep the string.

**Decision 4 is unbuilt, so its trap cannot fire yet.** `permissionMode: 'dontAsk'` and the bare
`allowedTools` names are both still passed (`src/runtime/claude.ts`), `WorkerOutcome.denials` is
still a bare count (`src/runtime/index.ts`), and nothing writes a question at ask-time. Nothing
parks, so nothing spins — the retry loop this record measured is what would arrive *with* the ask if
the three points above it are not built at the same time. `podFailurePolicy` remains unadopted:
which outcomes spend a retry is still hardcoded in `nextPhase` (`src/controller.ts`).
