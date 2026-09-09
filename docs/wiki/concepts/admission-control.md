---
title: Admission control — an instruction is not an invariant
summary: Why hkb enforces its tool surface, worktree isolation, which branch a worker may push, and (later) dependency ordering in a PreToolUse hook rather than in a prompt, a permission mode, or canUseTool — with the three measurements that ruled the other three out.
category: concepts
kind: explanation
audience: [dev]
read_when: "adding a rule an agent must obey, reviewing anything that says 'the prompt tells it to', or wiring a new workload kind's constraints"
covers:
  - path: src/admission.ts
    sha: ce4e291113aa9868314ce771f7fd1deb97b67ba8
  - path: src/runtime/claude.ts
    sha: 5ae775633cae411b71443add232b79f1325c4075
  - path: src/push.ts
    sha: 100b9b32da8da3d35f8ded2f7a46feef116e1fdd
generated_at_commit: 8aa5ade
last_refreshed: 2026-09-09
related: [architecture/runtime-layer, architecture/job-kind, decisions/adr-007-workload-scheduler, decisions/adr-017-the-workflow-is-content, gotchas/prompt-is-not-a-guarantee]
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

## The push rule — the sandbox's escape hatch, closed

`policy.push` is the third power's newest user, and the clearest example of the
distinction this page opens with. *"Never push to the default branch, and never
merge"* was a sentence in the worker's prompt: layer 6 of
`docs/workflow-study.md` §4, *"guarantees nothing; measured guaranteeing nothing
twice"*. The hook already reads every `Bash` call, so the same rule now sits at
layer 2, where it can refuse.

The decision itself is a pure module — `checkPush` (`src/push.ts`) — for the
reason `src/limits.ts` and `src/liveness.ts` are: the case that matters is the
refusing one, and it is testable without a shell. It reads the argv the way
`git push` documents it (options, a remote, then refspecs) and admits a push only
when **every refspec targets the attempt's own branch**. Refused: the default
branch by name or by `HEAD:main`, another Job's branch, `--all`/`--mirror`, a
glob, a delete, and a plain `--force` *even to its own branch* —
`--force-with-lease` is the same operation with the guarantee that nothing arrived
since you last looked, and nothing wants the version without it.

It is **conservative by construction**: a push behind `$(…)`, a variable or a
nested `sh -c` cannot be understood from a string, so it is refused with the form
that works rather than guessed at. A false refusal costs one plainer command; a
false admission costs somebody's trunk.

The policy is passed only for a Job that *has* a branch (`src/controller.ts`,
where `wt` decides it), and the default branch in it comes from `baseRef` — the
same place every other answer to "what is the trunk here" comes from. A
`--no-isolate` Job runs in the operator's own checkout, where "your own branch"
names nothing; it is not given the sandbox contract either, so the prose and the
guard cover exactly the same population.

This is the pairing ADR-017 decision 5 leaves behind: `src/brief.ts` says only
what the machinery will refuse on afterwards, and this is one of the two things it
refuses on.

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

The constant was unreachable — `Agent` is not in the runtime's `DEFAULT_TOOLS`, so
nothing could spawn at all — and it would have become reachable the day anyone
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
  `Bash` grant is a grant to the whole machine. The push rule narrows one shape of
  that (a `git push` it can read) and does not close it: a script in the checkout
  that pushes, or a `git` alias, is a shell doing what shells do.
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
