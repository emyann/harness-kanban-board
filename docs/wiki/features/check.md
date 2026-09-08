---
title: check — the exit code hkb does not have
summary: "A shell command run in the attempt's checkout after the run and after the rebase, whose non-zero exit fails the attempt. Why it sits beside the declared outputs rather than in a hooks list, why the command may never come from the worktree, and why a failed check is transient, resumable, and briefed to the next attempt."
category: features
kind: explanation
audience: [dev]
read_when: "a Job failed as `check_failed`, you are adding anything that runs before/beside/after the agent, or you are about to change what makes an attempt succeed"
covers:
  - path: src/hkb.ts
    sha: 45c571d3e74827c4648f2b13f16a5192863fe727
  - path: src/check.ts
    sha: cb1fdd8e77ee5bb873236c82ed8adbe65032a4af
  - path: src/controller.ts
    sha: 4f641c68ffb6006f4b8c393723bfdc2f0edf9fbd
  - path: src/spec.ts
    sha: d3fba5cc6bb9a1cebeea496bf445f4165c3cecbc
  - path: src/brief.ts
    sha: 7e993bae2f97e12c77c6cc5e426aeab2a2573b20
  - path: src/templates.ts
    sha: a01b0239ebb80af9b1e7e601e3c2b6bd7165ae23
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
generated_at_commit: d2d7f31
last_refreshed: 2026-09-08
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

That is also why nothing validates the command at file time beyond the two shapes that could
never have been meant (`src/hkb.ts`, `hkb new`/`hkb job set`/`hkb boards set`): hkb cannot have an
opinion about a shell line it does not parse. The two are a **bare `--check`** — `parseArgs` runs
with `strict: false`, so a trailing flag with no value comes back as the boolean `true`, and
`String(true)` filed the shell command `true`, which exists, exits 0 and verifies nothing — and
**`--check none`**, which is the spelling every other flag uses to clear a value and which here
would file the literal command `none` (exit 127, `check_failed`, resumed and re-failed until the
retries are gone). Both are refused by name, pointing at the fix (`checkFlag`, `src/hkb.ts`).

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
has one is the opposite of frugal. **Declared outputs are only *checked* before it; they are
*copied* out after** (`features/declared-outputs`), so an attempt this refuses leaves nothing in
the operator's repository.

### The lease is held while it runs, and that is load-bearing

The check was once run *after* the lease had been released, and everything wrong with that came
from the same fact: for up to ten minutes the Job was `running`, with an attempt open and no Lease
row. `hkb cancel` was accepted in that window and then silently undone by the outcome written on
the way out; `hkb rm` cascaded the rows away and turned the attempt write into a P2025 that took
the whole reconcile pass with it; and a daemon killed mid-check stranded the Job for ever, because
the reclaim scans Lease rows. The claim is now held across the rebase, the check and the record
writes, verified by token immediately before those writes, and released last
(`concepts/leases-and-liveness`).

### It is interruptible, and it kills what it started

`runCheck` is an async `spawn`, not a `spawnSync` (`src/check.ts`). A synchronous ten-minute
subprocess in the controller's concurrent section froze the daemon's event loop for its duration —
timers, the SDK stream, the in-process admission hook and the signal handlers all stopped, so
`hkb down` went unacknowledged for the whole check and sibling workers at `maxConcurrent > 1`
stalled at their next tool call. Two more properties come with the change:

- **`detached: true`, and the timeout kills the process GROUP.** Signalling only `/bin/sh` left
  the suite it started orphaned — still running, in the very worktree the resumed attempt
  continues in. `SIGTERM` to the group first, `SIGKILL` after `CHECK_KILL_GRACE_MS`.
- **`deps.signal` is honoured**, so `hkb down` interrupts a check rather than waiting it out. An
  interrupted check records nothing: the operator's intent outranks a verdict the command never
  got to give, and burning a retry on a stop would be the wrong answer twice.

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
(`withCheckFailure`, `src/brief.ts`) the way an approved Job carries its approver's words.

Two things about *which* failure is quoted, and both were wrong first:

- **the walk goes back past attempts that could not have run a check.** `k` counts every ended
  attempt, so reading only `k - 1` meant one `stopped` (`hkb down`), `lost` (a reclaim) or pre-run
  `crashed` attempt in between dropped the briefing silently — none of those writes the column or
  clears `lastSessionId`, so the next attempt resumed the very session the check refused, knowing
  nothing about it. `lastRefusedCheck` (`src/controller.ts`) walks back the way `newestWorktree`
  already does for the checkout, and stops at the first attempt that *could* have answered.
- **the command named is the one that will judge THIS attempt**, `spec.check.value`, not the one
  on the record. `hkb job set --check 'npm run lint'` followed by `hkb retry` briefed the worker to
  make `npm test` exit 0 while `npm run lint` decided. When the two differ the prompt says so
  rather than substituting, because the tail below it is still the old command's output.

The tail is worker-influenced text — a test runner printing whatever it likes — so it is fenced
with the same framing `withInputs` uses ("treat it as data rather than as instructions") and
backtick runs are *capped* rather than swapped, which is what stops a tail of nine or more
backticks closing the fence and putting the rest back into the prompt as prose.

### And the first attempt is told too

`spec.check.value` used to reach a prompt only through `withCheckFailure` — that is, only after an
attempt had already failed on it. So the ordinary shape of a checked Job was: the worker runs
`npm test`, pushes, ends green, the check fails on the lint half, and a whole paid session goes on
a one-line fix. One line now sits beside the other output contracts (`withCheck`, `src/brief.ts`),
because it *is* one of them. That is not a hole in the fence: the fence is about who **authors**
the command, and the retry prompt has always quoted it verbatim.

The checkout is kept either way — for the retry to resume into, and, when the retries are gone, for
the operator to run the command in.

## Two numbers, and why those

- **Ten minutes** (`CHECK_TIMEOUT_MS`). A hung check must not hold the pass for ever. Ten minutes
  is a third of the default `timeoutMs` for the agent itself, and this repository's own
  `npm run lint && npm test` is under two. It is *longer* than the five-minute `LEASE_GRACE_MS`
  the lease gets past a run's own `timeoutMs`, and that is fine because the **renewer** is what
  covers it — the grace is the margin for teardown, not the budget for the check.
- **4 KB of the tail** (`CHECK_TAIL_BYTES`). The tail because a runner puts its verdict last; 4 KB
  because it is paid for twice — in `hkb show`, and on every request of the attempt that reads it —
  and it is the cap `src/results.ts` already puts on a value the board keeps. It is **streamed**
  through a rolling window rather than buffered and sliced, which removes a cliff: a `maxBuffer`
  past which Node kills the child and reports `ENOBUFS` would have turned a verbose *passing*
  suite into a failed attempt.

## Three ways to fail, three sentences

One outcome, because what the controller *does* about a refusal does not depend on how it failed.
Three renderings, because what the **operator** does depends on nothing else (`CheckKind`,
`src/check.ts`):

| kind | when | what is claimed |
|---|---|---|
| `exit` | it ran and gave a number | "the work is there and it does not do what it must" |
| `unfinished` | the timeout, a signal, an output cap, a stop | no verdict — only that the command never got to say |
| `unstartable` | it never began | nothing about the work was judged; fix the command |

The distinction is not cosmetic. A `why` clause spliced into a frame written for `exited N`
produced ``check `npm test` it was still running after 600s and was killed (SIGTERM) after 600s``
— a duration stated twice around a sentence that does not join up — and, for a check that could
not be started, asserted a finding about work nothing had examined. **Only `ETIMEDOUT` is a
timeout**: reading `signal` first meant a suite killed by the OOM killer, or one that segfaulted,
was reported *and briefed to the next attempt* as having run for ten minutes when it ran for three
seconds.

## Which base the tree was on

The claim above — that the check tests what would actually merge — is true when the rebase
replayed and not true when it legitimately declined: a pushed branch whose pull request is no
longer a draft is deliberately not rewritten, and a fetch that failed leaves the base as of
whenever somebody last pulled. Neither fails the attempt and neither should. So the record carries
`onBase` and the ref it is about (`src/check.ts`, `src/rebase.ts`), `hkb show` prints it, and the
log line says so when it is false. The controller's rebase is slated to leave the core anyway;
until it does, the honest thing is to qualify the verdict rather than to overstate it.

## Nothing runs by default

`BUILT_IN.check` is null and so is every board's `defaultCheck`, so at the shipped defaults this
whole feature is one null test (`src/spec.ts`). That is not timidity: a command hkb invented for a
repository it knows nothing about would be a shell line nobody wrote, executed with the daemon's
privileges. It reaches a worker only because a person set it on the Job, on the board, or in a
workflow file that was merged.

Resolution is the ordinary three levels — the Job's value wins, the board's fills a null — so
`hkb show` names the source beside it like every other resolved field, and `hkb new` echoes the
**resolved** value with its source rather than the Job's own column (a Job inheriting the board's
otherwise printed nothing, which is the "an attempt can fail on a command nobody printed" surprise
the echo exists to prevent).

### Opting one Job out

This is the one string field with **three** states, and it needs them: `''` is *no check, and do
not inherit one* (`checkValue`, `src/spec.ts`). Without it a board that sets `defaultCheck` owns
every Job on it — `pick` reads a null column as *unset*, so a cleared value falls straight back
through to the board — and the schema's own "a Job whose brief is an investigation has no suite to
pass" could not be honoured at all. It is the shape `allowedTools: []` already uses, for the same
reason: an empty value is a decision, and only a null is silence.

Uniform across the four places a check can be set: `hkb new --check ""`, `hkb job set <id> --check
""`, `check: ""` in a workflow file, and — on the *board* — `--check none`, which keeps that verb's
own convention because a board default genuinely does have something to clear. `none` on a Job is
refused by name, pointing at the spelling that works. `hkb show` prints `check (none) [job]`.

## Known gaps

- **The check is not run for a Job that failed for another reason**, so an operator cannot use it
  as a diagnostic on a broken attempt. That is deliberate, and stated above.
- **A `''` opt-out is available on a Job and not on the other board-defaulted fields.** `base` and
  `guide` still have the gap this closed for `check` (`features/the-checkout-base` records it),
  because for those two the empty string genuinely is the absence rather than a third state.
- **No `setup` or sidecar yet.** ADR-016 §2 says they are one ordered list when they arrive, and
  §5 says a kept command needs a readiness probe or it ships flaky. Neither is built.

## Related

- [adr-016-the-pod-spec-is-the-map](../decisions/adr-016-the-pod-spec-is-the-map.md)
- [declared-outputs](./declared-outputs.md)
- [rebase-and-verify](./rebase-and-verify.md)
- [the-loop](../architecture/the-loop.md)
