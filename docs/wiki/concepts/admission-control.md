---
title: Admission control — an instruction is not an invariant
summary: Why hkb enforces its tool surface, worktree isolation and (later) dependency ordering in a PreToolUse hook rather than in a prompt, a permission mode, or canUseTool — with the three measurements that ruled the other three out, and the fourth that moved the push rule out of the hook and into git.
category: concepts
kind: explanation
audience: [dev]
read_when: "adding a rule an agent must obey, reviewing anything that says 'the prompt tells it to', or wiring a new workload kind's constraints"
covers:
  - path: src/admission.ts
    sha: 3da82a22f3e857c3142359fce3cfefda0be59da8
  - path: src/runtime/claude.ts
    sha: 99f48dce1ec77266c5f486a386d55d438a02397c
  - path: src/runtime/surface.ts
    sha: 91dc14a46f39d60c04e59d95dbc5d6c4c360d67c
  - path: src/push.ts
    sha: 79181173571e3f6359402de26638e1e5fef904ac
  - path: src/pre-push.ts
    sha: 589393dab0dfb3bff5d7b4edf16c7b808b85e1c7
generated_at_commit: 01c316b
last_refreshed: 2026-09-09
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

**`Skill` is on it, and admitting it widened nothing.** Invoking a skill is a
prompt expansion — layer 6 — so every tool the skill then reaches for arrives
back here at layer 2 and is judged against this same list. Until it was admitted,
no worker had ever invoked a skill and every `--plugin-dir` grant was inert:
ADR-012 measured skills *reaching* a worker and the gate denied the tool that
*calls* one. The first invocations this project recorded, refusal included, are
in `features/skill-invocation`.

**`Agent` is not on it.** One Job is one agent; a worker that could fan out would
spawn work nothing has claimed. This is where a skill that spawns subagents
(`/code-review`) stops — the spawn is a tool call, so it makes no difference
whether a brief or a skill asked for it.

## The push rule — and the layer it had to move to

This is the clearest example of the distinction this page opens with, and also
the clearest example of getting that distinction right and the *layer* wrong.

*"Never push to the default branch"* was a sentence in the worker's prompt: layer
6 of `docs/workflow-study.md` §4, *"guarantees nothing; measured guaranteeing
nothing twice"*. The first fix moved it here — a pure `checkPush` module reading
the `Bash` command as argv, refusing anything it could not place. It had a full
test suite and it passed.

Then the same forms were run against a real remote, and ten got through:

| what was typed | why the parser missed it |
| --- | --- |
| `git push -f --force-with-lease origin HEAD:main` | git's `--force` disables the lease; the parser saw a lease |
| `git push -fu origin HEAD:main` | bundled short options |
| `git push origin kb-7-1 >/dev/null main` | the redirect ended the segment the parser was reading |
| `git push origin :kb-7-1` | git's delete spelling, parsed as the worker's own branch |
| `git -c remote.origin.push=refs/heads/kb-7-1:refs/heads/main push origin` | config, not argv — and it **persists in the shared `.git/config`**, so the controller's own later `--force-with-lease` rewrote `main` |
| `git -c alias.p=push p origin main` | an alias is resolved after the parser has finished |
| `/usr/bin/git`, `"gi"t`, `sh -c '…'`, `python -c 'os.system(…)'` | the command's own name, and other shells |

And it over-refused in the other direction: `git commit -m "$(cat <<'EOF' … push
… EOF)"` — the commit form Claude Code teaches — was refused for containing the
word, along with `git stash push`, `git grep push` and a backslash-newline
continuation.

The fault is not the parser; a better parser fails the same way. **What a worker
typed and what git does are different strings**, separated by aliases, config,
expansion and nested shells. So the decision moved to the one place where they
have stopped being different: git's own `pre-push` hook.

### What the hook is

`installPushHook` (`src/push.ts`) runs at claim time, on the attempt's worktree:

- it writes `pre-push` and a policy file under `~/.hkb/hooks` — outside every
  checkout a worker can write, because a hook under `.git/hooks` or a repository's
  own `.githooks` is a file the worker edits with the tool it edits everything
  else with;
- it points that worktree at it with `git config --worktree core.hooksPath`
  (`extensions.worktreeConfig`), so the **operator's own checkout is completely
  unaffected** — their hooks, their pushes, no hkb in the middle;
- the policy is **pinned at claim time** to the branch the controller created the
  worktree on. Reading it back out of the checkout is what let attempt 1's
  `git switch develop` license attempt 2 to push `develop`.

The decision is still a pure module — `refusePush`, for the reason `src/limits.ts`
and `src/liveness.ts` are — but what it reads is git's resolved ref list rather
than a command line: `<local ref> <local sha> <remote ref> <remote sha>`, one line
per ref, after everything above has already happened. The rule is one sentence:
every ref this push updates is `refs/heads/<the attempt's branch>`, and none of
them is a deletion. `--all`, `--mirror`, a glob refspec and every spelling of a
delete are covered because git has already expanded them.

It judges **effects, not spellings**. A `git push --all` that would move nothing
is admitted, because it moves nothing.

### What the gate still refuses

Two things, and both are about the hook rather than about the push:
`--no-verify`, which skips it, and moving `core.hooksPath` out from under it.
Those are short literal strings with no legitimate use inside a sandbox — which is
exactly what the branch rule was not.

`policy.sandboxed` is set only for a Job that has a worktree (`src/controller.ts`,
where `wt` decides it). A `--no-isolate` Job runs in the operator's own checkout,
where there is no hook and nothing for these refusals to protect; it is not given
the sandbox contract either, so the prose and the guard cover exactly the same
population.

### What it is not

It is not a jail. A worker runs as the operator's user: it could chmod the policy
back, edit `.git/config` directly, or clone the repository somewhere else and push
from there. The bar is the honest one — a plausible mistake and a casual escape
are refused deterministically, by the same mechanism whatever the prompt says.

`never merge` is not covered at all, and `src/brief.ts` says so out loud rather
than listing it beside the rules that are: a merge on the forge is an API call no
git hook is ever on the path of.

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
