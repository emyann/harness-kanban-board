# Realign the Job kind: a Job is a wrapper around an agent session, and nothing else

**Status: EXECUTED. This is history, not a live plan — read
[`docs/wiki/decisions/adr-018-the-boundary.md`](wiki/decisions/adr-018-the-boundary.md) instead.**

It is kept because it is the provenance: ADR-018 is the record that came out of it, and the reasoning
started here. What landed, as of `64c7034` (PR #434):

| step below | outcome |
|---|---|
| 1. close #432 unmerged | done — closed with the reasoning, *wrong not incomplete* |
| 2. the superseding ADR | **ADR-018**, which supersedes this document as well as part of ADR-016 and ADR-017 |
| 3. split the gate into admission and ask | **not built.** Measured and designed in ADR-018 decision 4; no code |
| 4. move the git protocol out of the Job kind | done — five modules deleted, −3,900 lines |
| 5. adopt the spec fields hkb hand-rolls | **partly.** `ttlSecondsAfterFinished` exists as a built-in constant, not a spec field; `podFailurePolicy`, a real `suspend` field and `parallelism` vs `maxConcurrent` are untouched |
| 6. Workflow/Step | not started — [`docs/is-a-step-data.md`](is-a-step-data.md) is the question that precedes it |

**Where this document was wrong, and it is worth knowing:** it proposed moving the git work behind a
seam in the core. Measurement during execution showed the harness already provides all of it —
worktree creation, `.worktreeinclude` under the same filename, base freshening, the lock, resume into
the same tree — so the code was **deleted rather than moved**, and the workspace became a runtime
concern. This document does not contain that conclusion; ADR-018 does.

---

**Original status:** a plan, written 2026-09-10, to be executed from a clean session.
**Verdict:** the Job kind and its controller are mis-scoped. Fix that before anything else is built
on top of them. **Scrapping working code is expected and authorised** — see *"On deleting code"*.

Read this file alone. It is written to be actionable with no other context.

---

## 1. The one-sentence diagnosis

**hkb's controller conflates "run an agent session under limits" with "do git."** A Kubernetes Job
has no opinion about what its container does with its volume — it cuts the volume, runs the
container under limits, records the outcome and cleans up. hkb's Job knows about branches, pushes,
rebases, pull requests, a `pre-push` hook and a sandbox contract. None of that is Job-shaped.

Everything downstream — the DAG kind, Workflow/Step, the web board — will inherit the mis-scoping if
it is not fixed first. That is why this comes before the feature work.

## 2. How it was found, and why it is not a matter of taste

Not by argument. By a day of measurements that all pointed the same way.

**The proximate trigger.** Card #63 measured what a subagent actually gets and found that the
`pre-push` hook — installed per-worktree on the attempt's checkout — does not reach the worktree the
harness cuts for a subagent at `<repo>/.claude/worktrees/agent-<id>`. A push refused from
`.hkb/worktrees/kb-1-1` **succeeded** from the agent's. `Agent` plus `Bash` could write the trunk.

**The attempted fix made it worse.** PR #432 moved `core.hooksPath` to repository scope. A
high-effort review found fifteen problems, three structural: it broke concurrency (one policy per
repository cannot express N live attempts), it replaced the subagent escape with a shorter one
(`cd ../../.. && git push origin main` from inside the attempt's own worktree), and it silently
disabled every *other* repository hook — `pre-commit`, `commit-msg` — for the operator as well as
for workers. **PR #432 must be closed unmerged.**

**The pattern is the point.** Two attempts, both careful, both wrong, because both were defending a
responsibility the Job kind should not have. A fence around git only has to exist because the core
requires git. Remove the requirement and the fence has nothing to guard.

**What the same measurement showed holding.** The admission gate *does* travel into a nested
session: both subagents' `Write` came back with hkb's own refusal and `permission_denials` counted
both agents'. So the tool surface generalises across a spawn and a per-worktree git hook does not.
That asymmetry is the strongest single piece of evidence in this document: **the guard that is about
the session works; the guard that is about the filesystem does not.**

## 3. The map, field by field

Against `batch/v1` `JobSpec` (kubespec.dev, Kubernetes v1.37). This supersedes ADR-016's table,
which only ever covered scheduling and files `timeoutMs` under `resources.limits` — a row that is
wrong, since `resources.limits` is cpu and memory and a deadline is neither.

### 3.1 Maps cleanly today

| batch/v1 | hkb |
|---|---|
| `backoffLimit` | `Job.maxRetries` |
| `JobSpec.activeDeadlineSeconds` | `Job.activeDeadlineSeconds` |
| `template.spec.activeDeadlineSeconds` | `Job.attemptDeadlineSeconds` |
| `template.spec.volumes` (emptyDir) | the worktree; the artifacts directory |
| `template.spec.serviceAccountName` + RBAC | the tool surface; plugin grants |
| `containers[].resources.limits` | `maxTurns`, `maxBudgetUsd` |
| Pod | `Attempt` |
| Namespace | `Board` |
| labels | `Job.labels` |

### 3.2 In the spec, hand-rolled or missing in hkb

Each of these is a place hkb invented a mechanism for a question Kubernetes had already answered
with a field. Adopting the field is usually a simplification, not an addition.

| batch/v1 | what hkb does instead | action |
|---|---|---|
| `ttlSecondsAfterFinished` | `sweepWorktrees` infers "safe to delete" from *has it been pushed* | replace the heuristic with the field |
| `podFailurePolicy` | hardcoded in `nextPhase` — which outcomes spend a retry, which resume | surface as spec |
| `suspend` | board-wide `hkb stop`; `suspended` is a phase the controller writes, never a field an operator sets | make it a per-Job spec field |
| `parallelism` | `Board.maxConcurrent` — a namespace ceiling standing in for a per-Job knob | separate the two concepts |
| `completions` / `completionMode` | absent; every Job is implicitly one completion | leave unmapped, but say so |
| `successPolicy` | reinvented as `check` + declared outputs | reconcile the two |
| `managedBy` | absent | relevant once a second controller exists (Workflow/Step) |

### 3.3 In hkb, nowhere in the spec — **this is the conflation**

- `base`, the attempt branch, the push, the rebase, the pull request, the sandbox contract in
  `src/brief.ts`, the `pre-push` hook in `src/push.ts`, `src/rebase.ts`, `src/pulls.ts`.
- `exports` / `results` / `artifacts` / `check` — ADR-008 and ADR-016 §3 already admit these are
  *reconstructing an exit code*, because a container has one and an agent session does not.
- `proposes` — a Job that files Jobs. In Kubernetes terms that is a **controller**, not a Job.
- `guide`, `brief` — prompt content, which is `command`/`args` and belongs in the template.

The first bullet is what must leave. The rest are debatable and can stay for now; the first is not
debatable, because it is the thing generating the bugs.

## 4. What a Job must become

> **Cut a workspace. Run one agent session under limits. Record what happened. Clean up.**

That is the whole contract. Concretely:

- `isolate: true` means *give this session a workspace of its own*. Whether that workspace is a git
  worktree is an implementation detail of the workspace driver (#50), not a fact the Job kind knows.
- The controller never runs `git commit`, `git push`, `git rebase`, or reads `gh`. It does not know
  what a branch is.
- The sandbox is the **tool surface**, enforced at the admission gate, which is the layer measured
  to work across a spawn. There is no git fence because there is no git requirement.
- What the session produced is a **declared output** the workspace driver collects, or it is
  nothing. "Produced nothing" stops meaning "did not open a pull request".

## 5. The gate: two mechanisms wearing one name

This is the second half of the mis-scoping and it is worth stating separately.

**What the gate is today:** admission control. `permissionMode: 'dontAsk'` plus a `PreToolUse` hook
that denies anything off the tool surface. Its justification, written in `src/runtime/claude.ts`, is
that *"a worker has nobody to answer a prompt."*

**That premise is false on a board.** There *is* somebody to answer — that is what the board is for.

**What is missing:** the ask. The Agent SDK supports an interactive session that surfaces a decision
(`canUseTool`, and the session's own events). The right behaviour is: the session asks, the Job
**suspends**, the question reaches the operator, the answer resumes it. hkb has a `suspended` phase
and a human gate and has never connected either to a session's own asks.

Keep both, name them apart:

| | purpose | needs a human? | exists |
|---|---|---|---|
| admission | deny what is off the surface | no | yes |
| ask | surface a decision to the board | yes | **no** |

`suspend` in `JobSpec` is the field the second one maps to.

## 6. Where the git work goes instead

hkb-the-machinery owns the **Job** kind. hkb-the-board — the product — owns **Workflow** and **Step**
with their own CRD-shaped rows and their own controller, built on top, the way Tekton separates
Task/TaskRun from Pipeline/PipelineRun. ADR-015 drew this line and stopped short of enforcing it.

"Commit on your branch, push it, open a pull request" is a **Step**. It is content, in a file, run by
a controller that owns the concept of a branch. The Job kind supplies the workspace and the session
and knows nothing about what runs in it.

## 7. On deleting code

**Be adamant about this.** If realigning the Job kind means deleting working, tested, documented
code, delete it. A Job and its controller being correctly scoped matters more than any of it,
because everything else is built on them — the DAG kind, Workflow/Step, `hkb serve`, the web board.
A mis-scoped Job propagates into every one of those, and the cost of fixing it grows with each.

Specifically, the following are **candidates for deletion rather than migration**, and none of them
should be defended on the grounds that it works or that it was recently reviewed:

- `src/push.ts` and `src/pre-push.ts` — the entire `pre-push` fence, including everything merged in
  #427 and everything proposed in #432. If the core does not require a push, this has nothing to do.
- the push, rebase and pull-request clauses of the sandbox contract in `src/brief.ts`.
- `src/rebase.ts` — the controller rewriting branches, and `mayRewrite` with it. Card #49 already
  names this.
- `src/pulls.ts` — the only thing that shells out to `gh`.
- `pushedRef`, `onRemote` and the pushed-state reads in `src/worktree.ts`, and the sweep heuristic
  built on them.
- `Attempt.prUrl` / `prNumber`, and `producedNothing`'s dependence on them.

This is a large amount of recent work, some of it merged today. **Delete it anyway if the design says
so.** The measure of whether it was worth writing is what it taught, and it taught the thing this
document is for.

What must **not** be lost in the deletion: the tool surface and the admission gate (measured to work
across a spawn); the ceilings and their refusals; the lease and liveness; the level-triggered
property of `reconcile()`; the declared-output contract, at least until `successPolicy` replaces it.

## 8. The steps, in order

1. **Close PR #432 unmerged.** Stop patching the push fence. Record in the card that the approach was
   wrong, not incomplete.
2. **Write the ADR** — supersedes ADR-016. Take `batch/v1` field by field: what maps, what hkb
   invented for a question the spec already answers, what is git-shaped and must leave the Job kind,
   and what is deliberately off the map with the reason. Name the deletions from §7 explicitly so
   nobody has to relitigate them later.
3. **Split the gate** into *admission* and *ask*, per §5. The ask is the missing half and maps to
   `suspend`. This is worth its own record or a section of the same one.
4. **Move the git protocol out of the Job kind.** Delete per §7. `isolate` becomes "a workspace";
   what a workspace is belongs to the workspace driver (#50).
5. **Adopt the spec fields hkb hand-rolls** — `ttlSecondsAfterFinished` for the sweep,
   `podFailurePolicy` for the retry rules, `suspend` as a real field, and separate `parallelism`
   from `Board.maxConcurrent`.
6. **Then, and only then**, the Workflow/Step kind and its controller, where the branch, the push
   and the pull request live as content (#46, #67, #70, #71).

Steps 1–3 are the ones that unblock thinking. Steps 4–5 are the demolition and rebuild. Step 6 is
everything the board has been waiting for and must not start before 4.

## 9. What this absorbs on the board

- **#49** — *the core reads git and refuses; it never rewrites*. This document is #49 taken to its
  conclusion; #49 is the subset that only retires the rewrites.
- **#67 / ADR-020** — *the surface*. Answer it after the Job kind is settled, not before; its own
  brief already contains its conclusion, which means it would ratify rather than decide.
- **#50 / ADR-019** — *the workspace is a driver*. This is §4's "whether the workspace is a git
  worktree is an implementation detail", and it becomes load-bearing here.
- **#46 / ADR-018** — *the run*. Becomes Workflow/Step in §6.
- **#66** — *the review step*. Blocked on `Agent` being grantable, which is blocked on the fence
  question, which this document dissolves rather than answers. Do not grant `Agent` until §4 lands
  or a session-layer refusal replaces the git one.
- **ADR-016** — superseded by the ADR in step 2.
- **ADR-012 measurement 7** — separately wrong (`Options.skills` does narrow at the pinned SDK).
  Worth folding into the same supersession pass.

## 10. Evidence index

Everything asserted above was measured, and the records are on the board:

- **#63's finding** (on `Attempt.results.finding`, and `docs/subagent-measurement.md` on branch
  `kb-63-1`): the gate fires for subagents and identifies them via `agent_id`; the `pre-push` hook
  does not reach a subagent's worktree; the budget covers the tree; `num_turns` counts the parent
  only; a subagent's worktree is cut from `origin/main` and its work never returns.
- **PR #432's review comment**: the fifteen findings, three structural.
- **PR #427's review comment**: why the push stayed in the core — the core *reads* pushed state
  (`pushedRef`, `sweepWorktrees`, the lease push). That coupling is exactly what §7 deletes, and it
  is why the deletion is a design change rather than a tidy-up.
- `sdk.d.ts` at the pinned `0.3.261`: `BaseHookInput.agent_id` — *"Present only when the hook fires
  from within a subagent… Use this field to distinguish subagent calls from main-thread calls."*
