---
title: check — the exit code hkb does not have
summary: "A shell command run in the attempt's workspace after the run, whose non-zero exit fails the attempt. Why it sits beside the declared outputs rather than in a hooks list, why the command may never come from the workspace, and why a failed check is transient, resumable, and briefed to the next attempt."
category: features
kind: explanation
audience: [dev]
read_when: "a Job failed as `check_failed`, you are adding anything that runs before/beside/after the agent, or you are about to change what makes an attempt succeed"
covers:
  - path: src/hkb.ts
    sha: 34ab3eea05412ec969d728978076d2634efdb1c5
  - path: src/check.ts
    sha: 730324bea5aa0fe083bc5fb7244c06ce20a54c2c
  - path: src/controller.ts
    sha: 6563f3234641037e46504688115ac5ed4b76cf1b
  - path: src/spec.ts
    sha: a83486dc8471b6e0358af03bafba75fa363c4032
  - path: src/brief.ts
    sha: b3eddf6aebd95fdab1f38424b24851d6a4e3e5a2
  - path: src/templates.ts
    sha: 169ac395a4b608e231beeb978952da3adfc8c82c
  - path: src/workspaces.ts
    sha: b709212e781376f570a613907a209648dab91526
  - path: prisma/schema.prisma
    sha: 6e249ec160c4a441ad45255f65470bb94267cf6f
generated_at_commit: 26055f1
last_refreshed: 2026-09-10
related:
  [
    decisions/adr-016-the-pod-spec-is-the-map,
    decisions/adr-008-declared-outputs,
    decisions/adr-018-the-boundary,
    features/declared-outputs,
    features/workflow-templates,
    architecture/the-loop,
    architecture/job-kind,
  ]
---

# check — the exit code hkb does not have

> A Kubernetes Job is complete when its container exits 0. hkb's container is an agent
> session, and a session always finishes successfully, because finishing talking is what it
> does. `check` is the missing number: one shell command, run in the workspace the session
> ran in, on the tree as the session left it, read as 0 or not-0 and nothing else.

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

That is also why nothing validates the command at file time beyond the shapes that could never
have been meant (`src/flags.ts`, for `hkb new`/`hkb job set`/`hkb boards set` alike): hkb cannot have an
opinion about a shell line it does not parse. What *is* refused, by name and pointing at the fix
(`given` and `checkFlag`, `src/flags.ts`):

- **a bare `--check`.** `parseArgs` runs with `strict: false`, so a trailing flag with no value
  comes back as the boolean `true`, and `String(true)` filed the shell command `true` — which
  exists, exits 0 and verifies nothing.
- **`--check --json`, and any value beginning with a dash.** The same parser hands a string option
  *the next token whatever it is*, so this filed the shell command `--json` and left `--json`
  itself not in effect. It is the third argv trap (`gotchas/argv-traps`) and neither of the first
  two catches it: the flag is declared, and it consumed the token, so nothing falls through as a
  stray positional.
- **a command over `CHECK_COMMAND_MAX_BYTES`** (8 KB). `sh -c` passes the whole line as one
  argument and the kernel refuses one past `MAX_ARG_STRLEN`, so `spawn` throws `E2BIG`
  synchronously and every attempt of that Job would fail on the command rather than on the work.
  Something longer is a script, and a script belongs in the repository.
- **`--check none` on `hkb new`** — and only there. See "the three spellings" below.
- **`--check` together with `--propose`**, because a proposing Job has nothing to check — on
  `hkb new` (the refusal names `check:` in the workflow file when that is where it came from) and
  on `hkb job set`, and `--json` says `{ value: null, source: "proposes" }` on both verbs, because
  the controller runs none whatever the board sets.

## Where it runs, and when

In the attempt's **workspace** — `outcome.workspacePath`, reported by the runtime rather than
computed here — or in `Board.repoPath` for a `--no-isolate` Job, which is the same "where the work
happened" either way (`ranIn`, `src/controller.ts:1305`).

**On the tree as the session left it, and the claim narrowed with ADR-018.** The check used to run
after `rebaseOntoBase` and its push, and its whole justification was that it therefore tested *what
would actually merge*. Nothing rebases now — `src/rebase.ts`, `src/push.ts` and `src/pulls.ts` are
deleted and none of them moved into the core — so that claim would be false and it is not made
(`src/controller.ts:1592-1599`). What the check still is, exactly, is ADR-016 §3's reconstruction of
an exit code: a command the **row** named, run where the work happened.

A step that wants the branch rebased before it is reviewed asks for it in the workflow file, which
is where the whole git protocol lives now (`.hkb/workflows/implement.md`) — so on a board whose
default workflow says so, the tree the check judges is one the *worker* rebased. That is content
making a promise rather than machinery keeping one, and the check cannot tell the difference.

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
the reclaim scans Lease rows. The claim is now held across the check and the record
writes, verified by token immediately before those writes, and released last
(`concepts/leases-and-liveness`).

### It is interruptible, and it kills what it started

`runCheck` is an async `spawn`, not a `spawnSync` (`src/check.ts`). A synchronous ten-minute
subprocess in the controller's concurrent section froze the daemon's event loop for its duration —
timers, the SDK stream, the in-process admission hook and the signal handlers all stopped, so
`hkb down` went unacknowledged for the whole check and sibling workers at `maxConcurrent > 1`
stalled at their next tool call. Two more properties come with the change:

- **`detached: true`, and the timeout kills the process GROUP.** Signalling only `/bin/sh` left
  the suite it started orphaned — still running, in the very workspace the resumed attempt
  continues in. `SIGTERM` to the group first, `SIGKILL` after `CHECK_KILL_GRACE_MS`.
- **`deps.signal` is honoured**, so `hkb down` interrupts a check rather than waiting it out. An
  interrupted check records nothing: the operator's intent outranks a verdict the command never
  got to give, and burning a retry on a stop would be the wrong answer twice. What it does **not**
  do is relabel the run — see "a stop that lands mid-check" below.

`hkb run` wires the same `AbortController` that `hkb up --foreground` does (`src/hkb.ts`). Without
it, `Ctrl-C` on a foreground pass killed the CLI and left a detached suite running in the workspace
with nothing left to bound it — `deps.signal` is the only way a stop reaches a check.

### The process lifecycle: three events, three questions

Settling on `close` alone was one bug in each direction, and the shape of the fix is the whole of
`runCheck` (`src/check.ts`):

- **`exit` is the VERDICT, and it is frozen there.** The exit code is complete the moment it
  arrives, so that is when the answer is settled — and it is captured at that moment, with the
  wall-clock timer cleared. Waiting past it waits for something that cannot change the answer:
  `--check 'node server.js & mocha'` exits 0 in seconds and holds stdout open behind it, and
  waiting for `close` there recorded a passing suite as a ten-minute timeout. Freezing it matters
  in the drain window: a timeout or an abort landing two seconds after a passing `exit 0` used
  to recompute the error at `finish` and record a timeout over a real exit status.
- **`close` is the PIPES**, and they are inherited by every descendant, so they get their own much
  shorter bound — `CHECK_DRAIN_MS`, two seconds after the exit, then the tails are final. Without
  it a descendant that left the process group (`setsid sleep 30 & exit 0`) could not be reached by
  the timeout *or* by `deps.signal`, so the promise never settled at all and the reconcile pass
  hung with the lease renewed for ever.
- **the hard kill is UNCONDITIONAL.** `SIGKILL` to the group fires `CHECK_KILL_GRACE_MS` after the
  `SIGTERM` whether or not `close` arrived — cancelling it on `close` meant a runner that traps
  `SIGTERM` and has its stdio redirected let the shell close, cancelled the kill, and went on
  running in the workspace while the record said it was killed. And a second, *different* stop is
  let through: an abort after a timeout that could not settle is the operator's last resort.
  **The kill timer is ref'd**: unref'd, a single-pass `hkb run` exited on `finish` before the grace
  elapsed and the `SIGKILL` was never sent — the daemon never noticed because it always has a next
  tick to stay up for. A process with a kill to deliver stays up the five seconds it takes.

**It never rejects.** `spawn` throws *synchronously* for a `cwd` that is not a directory
(`ENOTDIR`), a command past the kernel's argument limit (`E2BIG`) and a command containing a NUL
byte — all measured. Each of those resolves the `unstartable` record this module already promises,
because an unhandled rejection out of the controller's post-run section is a Job stuck `running`.

### A stop that lands mid-check

"Interrupted" is read off the **record**, not off `deps.signal.aborted`: the verdict is frozen at
`exit`, so an abort landing in the drain window leaves a real exit status behind it, and that
status — not the stop — is the answer; asking the signal re-ran a session whose check had passed.

It leaves the run's outcome exactly as it was and records only that the check was interrupted: no
verdict, no retry burnt (`charged` does not count a `completed` attempt), phase back to `pending`,
results kept on the attempt, the attempt's `reason` carrying the marker, the event's payload saying
`checkInterrupted`, and the pass reporting it as a *stop*. Nothing goes on `lastError` — the word
`completed` is not an error. Declared **exports are withheld**, exactly as they are for a check
that refused: nothing verified this tree, and a copy made now is one the next attempt's check may
refuse with no way to take it back. The next attempt is *told*: its previous run finished, the
check never answered, run it — and write every declared result again, because results are per
attempt and the ones read from the last attempt stay there. Writing `stopped` over it was destructive — the results had already
been collected *and* their collection directory deleted, so the resumed attempt could not
re-produce them, ended `no_output`, and went terminal. Pressing `Ctrl-C` during a test suite ended
the Job.

## The fence: never from the workspace

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

- **the walk goes back past attempts that could not have ANSWERED a check.** `k` counts every
  ended attempt, so reading only `k - 1` meant one `stopped` (`hkb down`), `lost` (a reclaim),
  `crashed`, `timed_out` or `max_turns` attempt in between dropped the briefing silently — none of
  those writes the column, so the refusal before them is still unanswered. `lastRefusedCheck`
  (`src/controller.ts:464-486`) walks back over `CHECKLESS_OUTCOMES` and stops at the first attempt
  that *could* have answered.
- **and it does not walk past a NULLED SESSION.** The walk was written on the premise that nothing
  it steps over clears `lastSessionId`; that is false for a runtime-error `crashed`, which nulls it.
  The next attempt then starts COLD and was briefed "the work is still
  there: the same session, and normally the same checkout" — about a session it cannot reach, with
  the plain line saying what it has to pass suppressed in favour of it. So the refusal counts only
  while the attempt that earned it is the attempt whose session the next one will resume
  (`a.sessionId === job.lastSessionId`); otherwise the ordinary `withCheck` line is what it gets.
- **the command named is the one that will judge THIS attempt**, `spec.check.value`, not the one
  on the record. `hkb job set --check 'npm run lint'` followed by `hkb retry` briefed the worker to
  make `npm test` exit 0 while `npm run lint` decided. When the two differ the prompt says so
  rather than substituting, because the tail below it is still the old command's output.

The tails are worker-influenced text — a test runner printing whatever it likes — so they are
fenced with the same framing `withInputs` uses ("treat it as data rather than as instructions"),
each labelled with the stream it came from, and backtick runs of **five or more** are broken up
(`fenceSafe`, `src/brief.ts`). Five and not four: CommonMark §4.5 closes a fence only with a run at
least as long as the one that opened it, so a run of four inside a five-backtick fence is ordinary
content — and rewriting fours put a U+200B into the standard four-around-three nesting idiom, in
text the worker is told to treat as data and may copy into the repository.

### And the first attempt is told too

`spec.check.value` used to reach a prompt only through `withCheckFailure` — that is, only after an
attempt had already failed on it. So the ordinary shape of a checked Job was: the worker runs
`npm test`, pushes, ends green, the check fails on the lint half, and a whole paid session goes on
a one-line fix. One line now sits beside the other output contracts (`withCheck`, `src/brief.ts`),
because it *is* one of them. That is not a hole in the fence: the fence is about who **authors**
the command, and the retry prompt has always quoted it verbatim.

The workspace is kept either way — for the retry to resume into, and, when the retries are gone, for
the operator to run the command in. That is now `ttlSecondsAfterFinished` rather than a judgement
about the tree: a Job with retries left has not finished, and a `failed` one that still holds a
session id is *resumable*, so neither is a sweep candidate (`collectable`, `src/workspaces.ts`;
`howto/running-the-daemon`).

## Two numbers, and why those

- **Ten minutes** (`CHECK_TIMEOUT_MS`). A hung check must not hold the pass for ever. Ten minutes
  is a third of the default attempt deadline for the agent itself, and this repository's own
  `npm run lint && npm test` is under two. It is *longer* than the five-minute `LEASE_GRACE_MS`
  the lease gets past a run's own attempt deadline, and that is fine because the **renewer** is what
  covers it — the grace is the margin for teardown, not the budget for the check.
- **4 KB of the tail, PER STREAM** (`CHECK_TAIL_BYTES`). The tail because a runner puts its
  verdict last; 4 KB because it is paid for twice — in `hkb show`, and on every request of the
  attempt that reads it — and it is the cap `src/results.ts` already puts on a value the board
  keeps. It is **streamed** through a rolling window rather than buffered and sliced, which removes
  a cliff: a `maxBuffer` past which Node kills the child and reports `ENOBUFS` would have turned a
  verbose *passing* suite into a failed attempt.
- **Two seconds for the pipes** (`CHECK_DRAIN_MS`), after the exit. See the lifecycle above: it is
  a bound on draining a kernel buffer, not on a suite.

### Two windows, and why not one

`stdout` and `stderr` are kept as **two fields on the record**, cut independently, shown separately
by `hkb show` and briefed separately. Joining them and re-cutting the join to 4 KB meant the louder
stream evicted the other entirely — and `cargo test`, mocha, vitest and `node --test` all put
progress and warnings on stderr and the summary on stdout, so the one line anybody wanted was the
one reliably dropped. They are not interleaved, because two pipes cannot be re-interleaved after
the fact and pretending otherwise would invent an ordering.

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
the echo exists to prevent). Under `--json` both verbs print the same object — `{ value, source }`
— because `hkb show` printing the raw column meant one Job answered `"npm test"` to `hkb new` and
`null` to `hkb show`.

## A proposing Job runs no check

`--propose` produces `proposal.json` and changes nothing in the tree, so there is no behaviour for
a command to judge and nothing in the checkout for it to judge (`runsCheck`, `src/controller.ts`).
Running one anyway did measurable harm rather than none: a check over an unchanged tree fails, and
`check_failed` outranks the gate in `nextPhase` — so the Job never suspended for approval, went
round the retry loop instead, and stored the same proposal three times for three paid sessions and
zero Jobs filed. `hkb new --propose --check` is refused by name; the controller's gate covers the
case where the *board* supplied the command and nobody typed it on that Job at all.

### Opting one Job out

This is the one string field with **three** states, and it needs them: `''` is *no check, and do
not inherit one* (`checkValue`, `src/spec.ts`). Without it a board that sets `defaultCheck` owns
every Job on it — `pick` reads a null column as *unset*, so a cleared value falls straight back
through to the board — and the schema's own "a Job whose brief is an investigation has no suite to
pass" could not be honoured at all. It is the shape `allowedTools: []` already uses, for the same
reason: an empty value is a decision, and only a null is silence.

Uniform across the four places a check can be set: `hkb new --check ""`, `hkb job set <id> --check
""`, and `check: ""` in a workflow file. `hkb show` prints `check (none) [job]`.

### The three spellings, and which verb each is on

| spelling | column | means |
|---|---|---|
| no `--check` at all, on `hkb new` | null | inherit the board's default |
| `--check none`, on `hkb job set` and `hkb boards set` | null | *back to* inheriting — the same "clear it" every other field of those verbs uses |
| `--check ""`, anywhere | `''` | no check, and inherit nothing |

`none` is refused only on `hkb new`, where there is genuinely nothing to clear — the column starts
null — and where filing it as written would file the literal command `none`: exit 127,
`check_failed`, three paid sessions for a command that can never pass. Refusing it on `hkb job set`
was a mistake of the same shape one step over: it left an operator with no way to undo a `--check`
at all, and pointed them at "leave `--check` out", which on a verb that writes only what it is
given does nothing. A workflow's `check: none` is refused where it is written, naming the file and
the line (`src/templates.ts`), rather than reaching `hkb new` as though it had been typed.

## Known gaps

- **The check is not run for a Job that failed for another reason**, so an operator cannot use it
  as a diagnostic on a broken attempt. That is deliberate, and stated above.
- **A `''` opt-out is available on a Job and not on `guide`.** `guide` still has the gap this
  closed for `check`, because there the empty string genuinely is the absence rather than a third
  state. (`base` was the other one, and ADR-018 deleted the field rather than closing it.)
- **No `setup` or sidecar yet.** ADR-016 §2 says they are one ordered list when they arrive, and
  §5 says a kept command needs a readiness probe or it ships flaky. Neither is built.
- **A check that PASSES is not torn down.** The group is killed on the timeout and on a stop, but a
  shell that exits 0 having left `node server.js` behind leaves it running in the workspace the next
  attempt resumes in. The verdict is right — that is the point of settling on `exit` — and the
  orphan is a second question nobody has answered: a container's descendants die with the pod, and
  hkb's equivalent would be killing the group on every path. Not done, because a check that
  deliberately starts something is at least arguable and nothing has needed it yet.

## Related

- [adr-016-the-pod-spec-is-the-map](../decisions/adr-016-the-pod-spec-is-the-map.md)
- [adr-018-the-boundary](../decisions/adr-018-the-boundary.md) — why the rebase, the push and the
  forge read left the core, and what the check may still claim without them.
- [declared-outputs](./declared-outputs.md)
- [the-loop](../architecture/the-loop.md)
