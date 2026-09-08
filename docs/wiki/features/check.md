---
title: check — the exit code hkb does not have
summary: "A shell command run in the attempt's checkout after the run and after the rebase, whose non-zero exit fails the attempt. Why it sits beside the declared outputs rather than in a hooks list, why the command may never come from the worktree, and why a failed check is transient, resumable, and briefed to the next attempt."
category: features
kind: explanation
audience: [dev]
read_when: "a Job failed as `check_failed`, you are adding anything that runs before/beside/after the agent, or you are about to change what makes an attempt succeed"
covers:
  - path: src/check.ts
    sha: 519c03f9885b4fac05b2470cb6dc2c6d1931b7ea
  - path: src/controller.ts
    sha: 6ae87908660b007837d6f366cf4ddd64f3546d3b
  - path: src/spec.ts
    sha: d918b65379babd9235d294239eaa26322bc3eb2f
  - path: src/brief.ts
    sha: 21211336a1311d7caa925c08c93c48eca3a5a5fa
  - path: src/templates.ts
    sha: 999612c9acfed633488c33c65a204673837ddd2a
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
generated_at_commit: cad6595
last_refreshed: 2026-09-07
related:
  [
    decisions/adr-016-the-pod-spec-is-the-map,
    decisions/adr-008-declared-outputs,
    features/declared-outputs,
    features/rebase-and-verify,
    features/workflow-templates,
    architecture/the-loop,
    architecture/job-kind,
  ]
---

# check — the exit code hkb does not have

> A Kubernetes Job is complete when its container exits 0. hkb's container is an agent
> session, and a session always finishes successfully, because finishing talking is what it
> does. `check` is the missing number: one shell command, run in the attempt's own checkout
> after the rebase, read as 0 or not-0 and nothing else.

## Why it is not a hook

The obvious shape for this was `setup` / `check` / `teardown` — three fields, named from
intuition, with failure semantics chosen ad hoc. ADR-016 §3 refused that framing and it is the
reason the feature is shaped the way it is: **completion is the exit code, so there is nothing
left for an "after the workload succeeded" hook to do.** Kubernetes has no such hook for exactly
that reason.

So `check` is part of the **completion condition**, beside `exports`, `results` and `artifacts`
— which ADR-008 built to reconstruct an exit code for *files*. This is the same question asked
for *behaviour*. In the schema it sits with them (`prisma/schema.prisma`, `Job.check` next to
`Job.artifacts`), not in a list of lifecycle commands, and there is deliberately no matching
`Job.setup` or `Job.teardown` yet: those rows of the map are still unmapped.

## What the controller knows about it: nothing

`src/check.ts` runs the command through the shell and returns whether it exited 0. There is no
test-runner integration, no parsing of output into findings, and no special case for any
framework. The kubelet reads a container's exit code without knowing what the container did,
and this is the same relationship — which is what keeps the Job kind dumb (`architecture/job-kind`).

That is also why nothing validates the command at file time beyond "not empty" (`src/hkb.ts`,
`hkb new`/`hkb job set`/`hkb boards set`): hkb cannot have an opinion about a shell line it does
not parse.

## Where it runs, and when

In the attempt's worktree — or in `Board.repoPath` for a `--no-isolate` Job, which is the same
"where the work happened" either way (`src/controller.ts`).

**After `rebaseOntoBase` and its push**, and that ordering carries two arguments:

- it tests **what would actually merge**, not what the branch was cut from. A branch that was
  green against a stale base is not evidence about the merge — the same sentence the worker's
  own protocol uses (`src/brief.ts`);
- the tree the check ran in **agrees with what is on the remote**. `src/rebase.ts` explains why a
  tree ahead of its pushed branch strands the next attempt; a check run before the replay would
  be reporting on a tree the resumed attempt never sees.

It runs only when the attempt would otherwise have succeeded, only while the holder still has its
lease, and only when nothing has already failed the attempt — a missing declared output outranks
it, because spending ten minutes on a suite to find a *second* reason for a failure that already
has one is the opposite of frugal.

## The fence: never from the worktree

The command comes from the Job row, the board row, or a workflow file under `Board.repoPath`
(`check:` in `src/templates.ts`). **Never from the checkout the work happened in.** It is the same
fence a guide and a plugin grant stand behind (`src/plugins.ts`), and here it is at its sharpest:
this command runs with the daemon's privileges, to judge the very work that produced the tree it
runs in. A worker that could author it would be marking its own homework. A human merge is the
boundary.

For the same reason it is **not a proposal key** — the allowlist in `src/proposals.ts` stays three
keys long, so a proposing Job cannot ask for a Job whose check it chose.

## Failure semantics

ADR-016 §4: a failed check is a **missing output, not a crash**. It burns a retry and spends
nothing more.

| | |
|---|---|
| outcome | `check_failed` (`prisma/schema.prisma`, `Outcome`) |
| phase | `pending` while retries remain, `failed` when none do |
| resumable | always — the session that wrote the code is the one worth continuing |
| cost | one retry; no tokens, no forge call |

The decision is in `nextPhase` (`src/controller.ts`), and it is the branch that **outranks
`completed`** — which is precisely what "hkb has no exit code" means: the runtime reports success
because the session ended, and the check is what turns that into an answer about the work.

## The retry is told what failed

`docs/rebuild-plan.md` records the practice that has actually worked: *tell the second attempt what
the first collided with*. A retry that does not know why it is retrying wakes up believing it
finished, reads its own transcript, and produces the same tree.

So the failing command, its exit code and the tail of what it printed are stored on the attempt
(`Attempt.check`) and read back by the next one, which carries them in its opening
(`withCheckFailure`, `src/brief.ts`) the way an approved Job carries its approver's words. Only the
immediately preceding attempt is quoted: an older failure was already answered by the attempt in
between, and quoting it would brief a run against a tree that no longer exists.

The checkout is kept either way — for the retry to resume into, and, when the retries are gone, for
the operator to run the command in.

## Two numbers, and why those

- **Ten minutes** (`CHECK_TIMEOUT_MS`). A hung check leaves a genuinely stuck state rather than a
  slow one: the lease is released as soon as the run ends, so a Job whose check never returns sits
  in `running` with no lease for the reclaim to find. Ten minutes is a third of the default
  `timeoutMs` for the agent itself, and this repository's own `npm run lint && npm test` is under
  two.
- **4 KB of the tail** (`CHECK_TAIL_BYTES`). The tail because a runner puts its verdict last; 4 KB
  because it is paid for twice — in `hkb show`, and on every request of the attempt that reads it —
  and it is the cap `src/results.ts` already puts on a value the board keeps.

## Nothing runs by default

`BUILT_IN.check` is null and so is every board's `defaultCheck`, so at the shipped defaults this
whole feature is one null test (`src/spec.ts`). That is not timidity: a command hkb invented for a
repository it knows nothing about would be a shell line nobody wrote, executed with the daemon's
privileges. It reaches a worker only because a person set it on the Job, on the board, or in a
workflow file that was merged.

Resolution is the ordinary three levels — the Job's value wins, the board's fills a null — so
`hkb show` names the source beside it like every other resolved field.

## Known gaps

- **A Job cannot opt out of a board-wide check.** `hkb job set <id> --check none` clears the
  column, and a null column means *unset*, so it falls straight through to the board's default
  again. That gap is shared by every board-defaulted field (`features/the-checkout-base` records
  the same thing for `base`).
- **The check is not run for a Job that failed for another reason**, so an operator cannot use it
  as a diagnostic on a broken attempt. That is deliberate, and stated above.
- **No `setup` or sidecar yet.** ADR-016 §2 says they are one ordered list when they arrive, and
  §5 says a kept command needs a readiness probe or it ships flaky. Neither is built.

## Related

- [adr-016-the-pod-spec-is-the-map](../decisions/adr-016-the-pod-spec-is-the-map.md)
- [declared-outputs](./declared-outputs.md)
- [rebase-and-verify](./rebase-and-verify.md)
- [the-loop](../architecture/the-loop.md)
