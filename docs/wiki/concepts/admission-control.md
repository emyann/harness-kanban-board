---
title: Admission control — an instruction is not an invariant
summary: Why hkb enforces worktree isolation and (later) dependency ordering in a canUseTool gate that mutates or denies the tool call, rather than asking the model to comply in a prompt — and the measured failure that made the distinction non-negotiable.
category: concepts
kind: explanation
audience: [dev]
read_when: "adding a rule an agent must obey, reviewing anything that says 'the prompt tells it to', or wiring a new workload kind's constraints"
covers:
  - path: src/admission.ts
    sha: 8b1987ff3533ee61f4d73d4bc3234875f332f11c
  - path: src/runtime/claude.ts
    sha: 0f00b8f535d8514e814e15df693c45e7c7d29592
generated_at_commit: fc5452a
last_refreshed: 2026-09-05
related: [architecture/runtime-layer, architecture/job-kind, decisions/adr-007-workload-scheduler, gotchas/prompt-is-not-a-guarantee]
---

# Admission control

There are two ways to make an agent obey a rule, and only one of them is a rule.

**Structural** — the illegal action is unreachable. The readiness query returns no
blocked card, so no code path can spawn one.

**Instructional** — every action is reachable and the prompt asks for restraint.
A detector can notice a violation afterwards; nothing prevents it.

The Kubernetes name for the structural version is what this module is called
after: an **admission controller** validates or mutates a request *before* it is
persisted. Nobody implements PodSecurityPolicy by writing "please don't run as
root" in the container's README.

## The failure that settled it

A fan-out prototype told its parent session, in the prompt, to spawn every
subagent with `isolation: "worktree"`. The run reported success. The subagents
were **not isolated**: they read `prisma/schema.prisma` and `src/db.ts`, files
that existed only in the main checkout's *working tree* and at no commit at all. A
worktree is a fresh checkout of a commit, so a genuinely isolated subagent could
not have seen them.

The run's own order-checking reported clean, because it watched ordering and not
isolation. An instruction was followed exactly as reliably as an instruction can
be, which is to say not reliably enough to be an invariant.

## The shape

`admissionController()` (`src/admission.ts`) returns a `CanUseTool` callback,
passed to `query()` in `src/runtime/claude.ts`. The SDK's `PermissionResult` has
two branches and both are useful:

- **`deny` with a `message`** — a validating gate. The model sees a tool error and
  must work around it. This is where a graph kind's dependency rule goes: read the
  card id from the tool input, check the store, refuse the spawn if a blocker has
  not finished. Ordering stops being something the parent is asked to respect.
- **`allow` with `updatedInput`** — a *mutating* gate, and the more interesting
  one. `isolation: "worktree"` is not requested and not checked; it is **injected**
  into the tool input. A parent that omits it still cannot skip it.

`forceIsolation` defaults on, and `deny` lists tools a workload may never call
whatever the prompt says.

## Where this generalises

The gate is deliberately kind-agnostic — it knows nothing about DAGs, cards or
graphs. It takes a policy. That is what makes it the natural home for every future
kind's invariants: one boundary that every spawn passes through, enforced in code,
while the *judgement* about what to parallelise and in what batches stays with the
harness where it belongs.

## Known gaps

- The gate only sees tool calls made through the session it was passed to. It
  cannot police anything a worker does with a shell it was already granted.
- `AgentDefinition` in the SDK has no `isolation` field — isolation is a parameter
  of the `Agent` *tool call*, which is why injection at admission is the mechanism
  rather than configuration. A file-defined agent (`.claude/agents/<name>.md` with
  `isolation: worktree` frontmatter) can pin it declaratively, but requires
  `settingSources: ['project']`, which also pulls in `CLAUDE.md` — a trade the
  runtime currently declines (`architecture/runtime-layer`).
