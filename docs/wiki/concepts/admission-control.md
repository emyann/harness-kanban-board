---
title: Admission control — an instruction is not an invariant
summary: Why hkb enforces its tool surface, worktree isolation and (later) dependency ordering in a PreToolUse hook rather than in a prompt, a permission mode, or canUseTool — with the three measurements that ruled the other three out.
category: concepts
kind: explanation
audience: [dev]
read_when: "adding a rule an agent must obey, reviewing anything that says 'the prompt tells it to', or wiring a new workload kind's constraints"
covers:
  - path: src/admission.ts
    sha: 964084be7460a43be49db9819665a6269f6a252f
  - path: src/runtime/claude.ts
    sha: b334fb2e536580b900e527b9ebf8585d17f93400
generated_at_commit: c5326c0
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

## Why a hook, and not the three obvious alternatives

The SDK evaluates a tool call in six steps, and **hooks run first** — before deny
rules, ask rules, the permission mode and allow rules. That ordering is the whole
argument, and each alternative was tried and measured before landing here.

**Not `canUseTool`.** It is shadowed twice over, and the SDK says so itself with a
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning: once by
`permissionMode: 'bypassPermissions'`, which approves every call before the
callback is consulted, and again by every **bare name in `allowedTools`**, which
does the same per tool. Both warnings end with the same instruction — *"To gate
every tool call, use a PreToolUse hook."* A probe with no `allowedTools` at all and
a deny-everything callback still ran `Read` and never invoked it.

**Not the permission mode.** `dontAsk` paired with `allowedTools` is the
documented locked-down pairing for a headless agent, and it is what
`src/runtime/claude.ts` sets. But it cannot be relied on alone: measured, a session
running nested inside another Claude Code process ran the `Agent` tool under
`dontAsk` with `Agent` absent from `allowedTools`. The mode is not always in our
hands; the hook is.

**Not `allowedTools` under `bypassPermissions`.** The docs are explicit that the
list does not constrain that mode — `allowedTools: ["Read"]` alongside bypass
"still approves every tool, including Bash, Write, and Edit". The allowlist would
be decoration.

## The shape

`admissionHooks()` (`src/admission.ts`) returns what goes in `Options.hooks`: one
`PreToolUse` matcher over every tool, because a gate with holes is not a gate. Its
`hookSpecificOutput` carries all three powers:

- **`permissionDecision: 'deny'`** — the validating gate, with a reason the model
  sees. Two policies use it: `allow`, the workload's whole tool surface, enforced
  here rather than by the mode; and `admitSpawn`, where a graph kind's dependency
  rule will go, so ordering stops being something the parent is asked to respect.
- **`updatedInput`** — the *mutating* gate, and the more interesting one.
  `isolation: "worktree"` is not requested and not checked; it is **injected**.
  A parent that omits it cannot skip it. Verified against the real SDK: a spawn
  with no isolation parameter came back `mutate Agent — isolation injected`.

## Where this generalises

The gate is deliberately kind-agnostic — it knows nothing about DAGs, cards or
graphs. It takes a policy. That is what makes it the natural home for every future
kind's invariants: one boundary that every spawn passes through, enforced in code,
while the *judgement* about what to parallelise and in what batches stays with the
harness where it belongs.

## Known gaps

- The gate only sees tool calls made through the session it was passed to. It
  cannot police anything a worker does with a shell it was already granted — a
  `Bash` grant is a grant to the whole machine.
- A hook `allow` does not override a deny rule or a critical-path `rm`; those are
  evaluated after it and still apply. The gate can refuse more than the mode, never
  less.
- `AgentDefinition` in the SDK has no `isolation` field — isolation is a parameter
  of the `Agent` *tool call*, which is why injection at admission is the mechanism
  rather than configuration. A file-defined agent (`.claude/agents/<name>.md` with
  `isolation: worktree` frontmatter) can pin it declaratively, but requires
  `settingSources: ['project']`, which also pulls in `CLAUDE.md` — a trade the
  runtime currently declines (`architecture/runtime-layer`).
