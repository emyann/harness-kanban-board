---
title: 'ADR-016: The Pod spec is the map for a workload''s environment'
summary: "hkb's Kubernetes mapping has only ever covered scheduling. Everything a workload needs *around* it — what runs before, what runs alongside, what says it finished, what it may reach — is unmapped, and the temptation is to invent a vocabulary. We take the Pod spec's answers instead, row by row, and say plainly where hkb is off the map."
category: decisions
kind: decision
audience: [dev]
read_when: "adding anything that runs before, beside or after the agent; naming a new spec field; or about to invent setup/check/teardown"
status: accepted
date: 2026-09-07
supersedes: ~
superseded_by: decisions/adr-018-the-boundary (in part — three rows of decision 1's map table)
covers:
  - path: prisma/schema.prisma
    sha: 373271e495bbdaa8225fddbf23528007efdcfd74
  - path: src/controller.ts
    sha: 6563f3234641037e46504688115ac5ed4b76cf1b
  - path: src/inputs.ts
    sha: 6ed576d25bf9db5f8b76e3752c17a250725df3b6
generated_at_commit: 62135e9
last_refreshed: 2026-09-10
related:
  [
    decisions/adr-007-workload-scheduler,
    decisions/adr-008-declared-outputs,
    decisions/adr-012-skills-by-grant-not-by-settings,
    decisions/adr-015-machinery-and-consumer,
    architecture/job-kind,
    features/declared-outputs,
    decisions/adr-017-the-workflow-is-content,
    decisions/adr-018-the-boundary,
  ]
---

# ADR-016: The Pod spec is the map for a workload's environment

> **Superseded in part by [ADR-018](./adr-018-the-boundary.md) (2026-09-10).** The *method* this
> record establishes — take the Pod spec's answers row by row, and say plainly where hkb is off the
> map — stands, and is the method ADR-018 itself uses. Three rows of decision 1's table do not, and
> ADR-018 names the first of them as the reason it had to be written: *"ADR-016 mapped the Pod spec
> and filed a deadline under `resources.limits`."*
>
> - **`resources.limits` → `maxBudgetUsd`, `maxTurns`, `timeoutMs`.** A deadline is not a resource
>   limit. `Job.timeoutMs` is gone, replaced by two fields in the units and with the precedence
>   Kubernetes gave them: `Job.attemptDeadlineSeconds` (`template.spec.activeDeadlineSeconds` — one
>   attempt's wall clock, retried like any other failure) and `Job.activeDeadlineSeconds` (the
>   JobSpec's own — the whole Job's clock, which **outranks** `backoffLimit` and ends it
>   `deadline_exceeded`). `prisma/schema.prisma`, `BUILT_IN` in `src/spec.ts`. The row that survives
>   is `maxBudgetUsd` and `maxTurns`.
> - **`emptyDir` → the worktree; the artifacts directory.** ADR-018 decision 2 moves the workspace
>   off the Job kind: a PodSpec *declares* `volumes:` and never provisions storage, so the workspace
>   is declared on the runtime seam (`WorkerSpec.workspace`) and cut by the driver, and
>   `WorkerOutcome.workspacePath` reports where it landed. What hkb keeps is a row this table did
>   not have — **`ttlSecondsAfterFinished`**, as a built-in rather than a spec field
>   (`BUILT_IN_TTL_SECONDS`, `src/workspaces.ts`). The artifacts-directory half of the row still
>   stands (`src/artifacts.ts`).
> - **`ConfigMap / Secret → files` → `.worktreeinclude`.** That file belongs to the harness, not to
>   hkb — ADR-018's measurement table records it as *"the same filename, invented twice"* — and the
>   `features/worktree-includes` page this row cites no longer exists.
>
> Two smaller things: §4's aside that hkb's checkout-failure path *"leaves the Job `pending` and
> retries for ever"* describes code deleted with the checkout, and §1's `Pod` row now means an
> Attempt with no `branch`, `prNumber` or `prUrl` on it. §3 (`check` is the exit code hkb does not
> have) and §6 (`self:slot` is off the map) are untouched and are what `src/check.ts` and
> `src/inputs.ts` still implement.
>
> **One row ADR-018 adds that this table wanted: `podFailurePolicy` — unmapped.** Which outcomes
> spend a retry is hardcoded inside `nextPhase` (`src/controller.ts`) and classified from the
> runtime's own words, which is exactly the field Kubernetes made a spec field so that a stop caused
> by the *system* rather than the workload can be given `action: Ignore`.

## Context

**hkb is Kubernetes with an agent where the container goes.** That is not a metaphor the wiki
reaches for occasionally; it is stated in the header of `prisma/schema.prisma` and worked through in
ADR-005 and ADR-007. Board is a Namespace, Job is a Job, Attempt is a Pod, Lease is a Lease, and the
daemon is a controller-manager.

**But the mapping has only ever been applied to scheduling.** Every row hkb has taken from
Kubernetes is about *when work runs and how much it may spend* — `maxRetries` is `backoffLimit`,
`maxBudgetUsd`/`maxTurns`/`timeoutMs` are `resources.limits`, `allowedTools` is a
PodSecurityAdmission-shaped ceiling enforced at admission (`src/admission.ts`). Nothing has been
taken from the half of the Pod spec that describes *the environment a workload runs in*: what runs
before it, what runs alongside it, what says it finished, and what it is allowed to reach.

**The pressure is concrete.** A dev process described publicly in September 2026, and typical of
what people are building: a database and a set of ports provisioned per worktree; a dev server
running while the agent works; a subagent taking screenshots and posting them to an issue tracker;
a human reviewing code and UI at the end. Mapped against hkb, that process is roughly 80%
environment and 20% agent — and hkb is the reverse. It has the worktree, the port
(`valueFrom.jobRef` `slot`, `src/inputs.ts`), the tool ceiling, the skills grant, the artifact
channel and the gate. It has nothing that runs a command.

**The failure mode this record exists to prevent is inventing a third vocabulary.** The obvious
next move is to add `setup`, `check` and `teardown` — three fields, named from intuition, with
failure semantics chosen ad hoc. Kubernetes has already answered each of those questions, some of
them by changing its mind in public, and a project whose whole design is that mapping should read
the answer rather than guess it.

## Decision

**We will treat the Pod spec as the map for a workload's environment, row by row, and we will say
plainly where hkb is off it.**

### 1. The map, as it stands today

| Kubernetes | hkb | state |
|---|---|---|
| Namespace | `Board` | mapped |
| Job | `Job` | mapped |
| Pod | `Attempt` | mapped |
| the container | the agent session | mapped |
| `backoffLimit` | `Job.maxRetries` | mapped |
| `resources.limits` | `maxBudgetUsd`, `maxTurns`, `timeoutMs` | mapped |
| Lease | `Lease` | mapped |
| `emptyDir` | the worktree; the artifacts directory | mapped |
| PodSecurityAdmission / LimitRange | `allowedTools`, the admission gate | mapped |
| ConfigMap / Secret → **files** | `.worktreeinclude` (*features/worktree-includes*) | mapped, repo-declared rather than per-Job |
| ConfigMap / Secret → **env** | — `inputs` exist but project as prompt text only | **unmapped** |
| `initContainers` | — | **unmapped** |
| sidecar containers | — | **unmapped** |
| `lifecycle.preStop` | — | **unmapped** |
| `startupProbe` | — | **unmapped** |
| the container's **exit code** | — | **off the map — see 3** |
| `serviceAccountName` + RBAC | — | **unmapped — the MCP gap** |
| `Service` / cluster DNS | — `self:slot` instead | **off the map — see 6** |

### 2. Init and sidecar are ONE ordered list, because Kubernetes decided that

From 1.28 onward Kubernetes models a sidecar as an **initContainer with `restartPolicy: Always`** —
the same list, one field different. It starts before the app container, keeps running alongside it,
and is terminated after it. That consolidation is the part worth copying: two things that look like
separate features are one list with a flag.

So hkb takes one field, not two and not three: an ordered list of commands run in the worktree
before the agent, each of which either runs to completion or is kept alive for the session. In the
dev process above, provisioning a database is the first kind and the dev server is the second.

> The exact version at which native sidecars reached GA is not verified here; the shape is what
> this record takes, and the shape has been stable since 1.28.

### 3. `check` is not a hook — it is the exit code hkb does not have

A Kubernetes Job is complete when its container **exits 0**. That is the whole completion contract,
and it is why Kubernetes has no "run this after the workload succeeds" hook: there is nothing left
to ask.

hkb's container is an agent session, and it always finishes successfully, because finishing talking
is what it does. **hkb therefore has no exit code**, and everything ADR-008 built — declared
`exports`, `results` and `artifacts`, whose absence fails the attempt — is hkb reconstructing one.

This settles where `Job.check` (parked at `docs/workflow-study.md` §10, Q6) belongs: **beside the
declared outputs, as part of the completion condition**, not in a hooks list next to init and
teardown. It is the same question ADR-008 answered for files, asked for behaviour.

### 4. The failure semantics are Kubernetes', not ours to choose

- **A failing init means the workload never started.** Nothing was spent — no session, no tokens —
  and it is retried under the ordinary policy. In hkb that is a failed attempt that costs no money
  and **burns a retry**, which is `backoffLimit`'s behaviour and is *not* what hkb's current
  checkout-failure path does (that leaves the Job `pending` and retries for ever,
  `src/controller.ts`).
- **`preStop` is best-effort**, bounded by the grace period, and its failure does not fail the Pod.
  So a failing teardown is said out loud and fails nothing.
- **A missing output is not a crash**, which hkb already decided in ADR-008 and which this leaves
  alone.

### 5. A kept command needs a readiness check, or the feature is flaky rather than broken

Kubernetes does not start the app container until a sidecar's `startupProbe` passes. A dev server
takes seconds to bind; without the probe the agent's first request hits a closed port, intermittently,
in a way that reads as the model's fault. **A `keep`-style entry therefore carries a readiness
command**, and the two ship together or neither does.

### 6. Where hkb is off the map, we say so rather than pretending

- **Ports on a shared host.** Kubernetes' answer to port collision is *do not use `hostPort`, use a
  Service* — it has a network to hide behind. hkb runs everything on one machine and has no Service
  abstraction, so `self:slot` (`src/inputs.ts`) is a genuinely hkb-shaped answer to a problem
  Kubernetes solved by not having it. That row is ours.
- **The exit code**, per 3. Kubernetes gets it from the process; hkb has to construct it.

Naming a row as off-map is the point of the exercise as much as filling one in: it marks where the
map stops being evidence.

### 7. Env projection and init are one feature, not two

ConfigMap and Secret project **as files or as environment variables**. hkb's `inputs` do the first
kind of thing only, and they deliver data as *prompt text* — which is right for a model and useless
for a script. An init command that provisions a database needs `DATABASE_URL` in its environment,
not in a paragraph. So `init` without env projection is a field nobody can use for the case it was
added for, and they are one change.

## Consequences

**It forbids things, which is most of its value.** No `postRun` hook, because completion is the
exit code (3). No separate `sidecar` field, because that is `init` with a flag (2). No invented
failure semantics for init or teardown (4). Anyone reaching for one of those now has to argue with
this record rather than with a matter of taste.

**It does not authorise building any of it.** This is a map, not a plan. Each unmapped row is its
own change with its own tests, and the ordering between them is a separate question. What the record
buys is that none of those changes has to re-derive its shape or its vocabulary.

**It does not settle the MCP row.** `serviceAccountName` + RBAC is named here as the shape of the
gap, and that is all. The design is three objects rather than one — what a server *is*, whether a
Job may use it, and the ceiling over both — and it wants its own record, because RBAC is purely
additive and has no narrowing, which is the interesting part.

**It does not settle the naming.** ADR-015 left "hkb" naming the machinery, the CLI and the product
at once, and said to decide before anything is published under a second name. Still open, still
cheaper to decide before a web board has a URL.

**The risk is the map becoming a cage**, and it is worth naming because ADR-015 hit the same one:
its sorting rule is *"a rule, not an oracle"*. Kubernetes solved its problems with a network, a
scheduler and containers, and hkb has none of those — where the analogy stops carrying weight, row 6
is the honest move rather than forcing a fit. A row that has to be argued into place is a row that
should be marked off-map instead.

**What becomes easier:** a workflow file starts being able to describe a whole process rather than
just a prompt, which is what ADR-015 decision 3 promised when it made the template format machinery
and the workflows written in it content. Today that file can say which model, which tools, which
skills, what to produce and when to stop for a human. It cannot say what to run before, what to run
after, or what the agent may reach — and those three are most of anybody's actual dev process.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
