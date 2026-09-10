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
    sha: 97a047f6055dc1dba1689f2e0fd09e0a574bb4df
  - path: src/runtime/claude.ts
    sha: 54d9896f11384fa0de1ddfcb34745750568506aa
  - path: prisma/schema.prisma
    sha: 31ae1a8e52791c7a7e2555d68646e67c2df69a41
  - path: src/controller.ts
    sha: 456ffbc1b5d82177b8769cf86bc22ea8b3ea6e70
generated_at_commit: e4b48ae
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

## Consequences

- The core deletes `src/worktree.ts`, `src/push.ts`, `src/pre-push.ts`, `src/rebase.ts` and
  `src/pulls.ts`. Nothing in the machinery shells out to `gh`, and nothing installs a git hook.
- `.hkb/workflows/implement.md` stops passing `--base`: with `Job.base` gone the base is always the
  repository's default branch, which is what `gh pr create` already defaults to.
- The board's kinds do not exist yet. Until they do, the things this record moves out of `Job` have
  nowhere to go — that is expected, and it is the reason those features pause rather than being
  reimplemented inside the core "for now".
- Cards #46, #50 and #67 had pencilled ADR-018/019/020 for other subjects; those numbers move.
