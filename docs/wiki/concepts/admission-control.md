---
title: Admission control — an instruction is not an invariant
summary: Why hkb enforces its tool surface, worktree isolation and (later) dependency ordering in a PreToolUse hook rather than in a prompt, a permission mode, or canUseTool — with the three measurements that ruled the other three out, and the fourth that moved the push rule out of the hook and into git.
category: concepts
kind: explanation
audience: [dev]
read_when: "adding a rule an agent must obey, reviewing anything that says 'the prompt tells it to', or wiring a new workload kind's constraints"
covers:
  - path: src/admission.ts
    sha: 30a869c5ca1609f1e335c0f30854d9b285c31c45
  - path: src/runtime/claude.ts
    sha: e3afb9de9e34d90f222e7bf9865cbad39e99044b
  - path: src/runtime/surface.ts
    sha: e7660f0ce513bfc804cc31a0a92040e5bdc7fa1a
  - path: src/workspaces.ts
    sha: 053a0a244193db59d6d0f8a82361cf1b5fc6c577
generated_at_commit: aaa2c8c
last_refreshed: 2026-09-10
related: [architecture/runtime-layer, architecture/job-kind, features/skill-invocation, decisions/adr-007-workload-scheduler, decisions/adr-017-the-workflow-is-content, gotchas/prompt-is-not-a-guarantee]
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

## The default surface

The `allow` list is the *resolved* surface — the Job's, or the board's, or the
shipped default when neither named one (`src/spec.ts`, `src/runtime/surface.ts`).
That default is a pure module rather than a constant inside the SDK driver, for a
reason this page's own rule predicts: while it lived in the driver, the only way
to exercise the shipped default was to buy a session, so every test of this gate
supplied an `allow` list of its own and proved the code rather than the product.
`src/runtime/fake.ts` now builds the same policy from the same function and puts
its tool calls through this gate, so the default can be asked what it refuses for
free (`test/tool-surface.test.ts`).

Two entries carry an argument rather than a convenience.

**`Skill` is on it, and what a skill then *does* is judged here.** Invoking one
is a prompt expansion — layer 6 — so every tool it reaches for arrives back at
layer 2 and meets this same list. Until it was admitted, no worker had ever
invoked a skill and every `--plugin-dir` grant was inert: ADR-012 measured skills
*reaching* a worker and the gate denied the tool that *calls* one.

Admitting it does widen one thing, and the first implementation of that card
missed it: **which** skills exist is not this gate's question. The gate matches
tool names, so it cannot tell a granted repository skill from one sitting in the
operator's own `~/.claude`. That fence is `Options.skills`, set on every run from
what was actually granted (`features/skill-invocation`) — a second guard at a
second layer, for the same reason the push rule ended up at git rather than here:
the layer that can answer the question is the layer the rule belongs at.

**`Agent` is not on it.** One Job is one agent; a worker that could fan out would
spawn work nothing has claimed. This is where a skill that spawns subagents
(`/code-review`) stops — the spawn is a tool call, so it makes no difference
whether a brief or a skill asked for it.

## The push rule — deleted, and why nothing replaced it

**This section used to describe hkb's largest guard. It is gone (*decisions/adr-018-the-boundary*),
and the shape of its removal is worth more than the mechanism was.**

What stood here: the gate refused `--no-verify` and any `core.hooksPath` reassignment in a `Bash`
command, so that a `pre-push` hook — installed by the controller on the attempt's worktree, pinned
at claim time to the branch it was given — stayed on the path. Every push reached that hook with its
refspecs already resolved, so the trunk, another Job's branch, `--all`, `--mirror` and every spelling
of a delete were refused identically.

Three things ended it, in order:

1. **It was measured not to reach a subagent.** Card #63: the hook was installed per worktree, and
   the harness cuts a subagent its own worktree at `<repo>/.claude/worktrees/agent-<id>` that hkb
   never sees. A push refused from `.hkb/worktrees/kb-1-1` **succeeded** from the agent's.
2. **The fix for that was wrong twice.** PR #432 filed the policy per repository and broke
   concurrency, replaced the escape with a shorter one, and silently disabled the operator's other
   repository hooks. It was closed unmerged.
3. **The guard only had to exist because the core required a push.** It does not: the Job kind
   requires no commit, push or rebase, so there is no protocol left for a fence to protect.

**What refuses a push to a protected branch now is the forge**, centrally — which is where
Kubernetes puts admission too, at the API server rather than on the node. A branch protection rule
cannot be evaded by a subagent, an alias, a nested shell or a rewritten `core.hooksPath`, and it
applies to every clone rather than to the checkouts one machine happened to install a hook on.

**What HELD, and is the reason this page still exists:** the same measurement showed the tool-surface
half of the gate travelling into a nested session and identifying it by `agent_id`. Both subagents'
`Write` came back with hkb's own refusal and `permission_denials` counted both. So the asymmetry that
decided everything above is: **the guard that is about the session works; the guard that was about
the filesystem did not.**

## The isolation rule follows the parent

`subagentIsolation` is `'force'` or `'forbid'`, and the runtime derives it from
whether *this attempt* got a worktree (`WorkerSpec.isolated`, set from the same
`wt` that produced `cwd`). It is not a constant, and it was one:

- **`'force'`** — the isolated case above. Every spawn is given a worktree.
- **`'forbid'`** — the Job runs in the operator's own checkout (`isolate: false`),
  so there is no parent worktree to bring a subagent's work back to. Injecting one
  would put that work in a checkout nothing reads and nothing merges, and say
  nothing about it. A spawn that asks for `isolation: "worktree"` is **denied**,
  with a reason that says to spawn it without one; a spawn that asks for nothing is
  left alone and inherits the parent's cwd, which is where the work belongs.

The constant was unreachable — `Agent` is not in `DEFAULT_TOOLS`
(`src/runtime/surface.ts`), so nothing could spawn at all — and it would have
become reachable the day anyone
allowlisted `Agent` for a kind. A guard that is wrong while it is inert is a guard
that is wrong on the day it is switched on.

## Where this generalises

The gate is deliberately kind-agnostic — it knows nothing about DAGs, cards or
graphs. It takes a policy. That is what makes it the natural home for every future
kind's invariants: one boundary that every spawn passes through, enforced in code,
while the *judgement* about what to parallelise and in what batches stays with the
harness where it belongs.

## Known gaps

- The gate only sees tool calls made through the session it was passed to. It
  cannot police anything a worker does with a shell it was already granted — a
  `Bash` grant is a grant to the whole machine. This is exactly why the branch rule
  left the gate: git's hook is on the path of a script in the checkout, an alias
  and a nested shell alike, and the gate never was.
- A hook `allow` does not override a deny rule or a critical-path `rm`; those are
  evaluated after it and still apply. The gate can refuse more than the mode, never
  less.
- `AgentDefinition` in the SDK has no `isolation` field — isolation is a parameter
  of the `Agent` *tool call*, which is why injection at admission is the mechanism
  rather than configuration. A file-defined agent (`.claude/agents/<name>.md` with
  `isolation: worktree` frontmatter) can pin it declaratively, but requires
  `settingSources: ['project']`, which also pulls in `CLAUDE.md` **and
  `.claude/settings.json`** — a trade the runtime declines permanently, because a
  hook in a settings file is a shell command the repository author wrote
  (*decisions/adr-012-skills-by-grant-not-by-settings*). A granted plugin
  directory reaches a repository's skills without it, and a granted **guide**
  reaches its `CLAUDE.md` without it
  (*decisions/adr-013-the-guide-is-read-not-loaded*). Neither changes anything
  here: both are prose a worker may read, and every tool either might suggest is
  still refused unless `allowedTools` admits it.
