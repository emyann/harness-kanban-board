# Rebuild plan: from the ADR-007 core to a board that can build hkb

The goal is a board we file hkb's own work on. The constraint is the mistake we
are not repeating: **hkb was dogfooded before it could carry the weight**, and the
result was a backlog describing machinery that had already been replaced. So this
plan front-loads the boring parts and puts dogfooding behind a gate with
measurable criteria.

**Scope:** one workload kind — a Job that runs one agent against one brief. No
dependency graph. No second kind. Those come after the gate, and only because the
gate taught us something.

## Where we actually are

838 lines of core exist and are tested (`src/controller.ts`, `src/admission.ts`,
`src/runtime/`, `prisma/schema.prisma`, 15 tests). Three things are true and worth
stating plainly before planning around them:

- **Nothing drives it.** No entry point imports `reconcile()`. The only way to run
  a Job today is a script you write yourself.
- **`Job.isolate` is declared and unused.** `reconcile()` passes `deps.cwd`
  straight to the runtime, so a worker would edit the live checkout.
- **A Job produces no reviewable artifact.** It runs an agent and records that the
  session ended. There is no branch, no commit, no pull request.

Those three are Phases 1–2. Everything else is safety and patience.

---

## The gate: what "usable" means

Not a feeling. Six criteria, each checkable, all of which must hold before we file
a single real hkb card on this board:

| # | Criterion | How we check it |
|---|---|---|
| G1 | I can file work without writing SQL or a script | `kb new "…" --brief-file x.md` returns an id |
| G2 | A run produces a reviewable diff I did not have to find | the run ends with a draft PR URL on the card |
| G3 | A failure tells me why, in one screen | `kb show <id>` names the phase, the outcome, the error and the session id |
| G4 | It cannot run away | a per-job and a per-board USD ceiling, both enforced, both tested |
| G5 | Killing the machine mid-run loses nothing and double-runs nothing | pull the plug during a run; the next reconcile reclaims and retries exactly once |
| G6 | Ten consecutive real runs, unattended, with no manual repair | measured, written down, in `docs/rebuild-plan.md` |

G6 is the one that actually gates. The rest are prerequisites for being able to
run it honestly.

---

## Phase 1 — Make it usable by hand

**Goal:** a human can create, inspect and run a Job from a terminal, in the
foreground, watching it.

Deliberately *not* a daemon. Attended operation is how we learn what the loop
should do; a background loop built first would hide exactly the failures we need
to see.

**Deliverables**

- `bin/kb.ts`, a second entry point beside `bin/hkb.js`. The two systems coexist
  (ADR-007) and share no code; a separate binary keeps that honest and avoids
  touching the 36-verb `src/cli.js`. It is renamed to `hkb` when the old system
  is deleted, not before.
- Verbs, and only these: `kb new`, `kb ls`, `kb show <id>`, `kb run [<id>]`,
  `kb rm <id>`.
- `--json` on every one of them, per the standing rule.
- `kb run` calls `reconcile()` once, in the foreground, streaming the runtime's
  events to stdout.

**Exit criteria**

- G1 and G3 hold.
- `kb run` on an empty board is a no-op that says so and exits 0.
- Every verb has a test against the fake runtime.

**Risk:** verb sprawl. The old CLI has 36 verbs; this one gets five until
something concrete demands a sixth.

---

## Phase 2 — Make the output reviewable

**Goal:** a Job's work lands on a branch with a pull request, and never in the
operator's checkout.

This is the phase that makes dogfooding *possible* — until a run produces a diff
a human can reject, it cannot be trusted with hkb's own source.

**Deliverables**

- The controller creates a git worktree per attempt and passes it as `cwd`.
  Top-level `query()` has **no** isolation option — `isolation: "worktree"` is a
  parameter of the `Agent` tool, for subagents — so this is ours to do, not the
  SDK's. Branch from `origin/<default>`; name it `kb-<jobId>-<k>`.
- `Job.isolate` starts meaning something. `isolate: false` is the escape hatch for
  a read-only job, and it is not the default.
- The brief gains a fixed postamble: commit, push, open a **draft** PR, and stop.
  The worker never merges.
- The controller reads the PR back and records its number and URL on the attempt.
  One forge read per reconcile, not one per job.
- Worktree cleanup: remove on success with no changes; leave it and say so when it
  holds work.

**Exit criteria**

- G2 holds.
- A run against a deliberately-broken brief leaves the main checkout untouched —
  verified by `git status` before and after.
- The PR number is on the attempt row and `kb show` prints its URL.

**Risks**

- **The board is invisible from a worktree.** `.kanban/*.db` is gitignored and a
  worktree is a fresh checkout, so the worker cannot read or write the board. That
  is by design — the controller owns every store write — but it must be written
  down or someone will "fix" it with `.worktreeinclude` and create divergent
  copies of the board.
- **Uncommitted operator work is invisible to the worker.** A worktree is a
  checkout of a *commit*. Neither `baseRef` value carries a dirty tree.

---

## Phase 3 — Make it safe to leave alone

**Goal:** the failure modes that cost money or lose work are bounded, and the
bounds are tested.

**Deliverables**

- **Ceilings.** `maxBudgetUsd` already exists per Job and reaches the SDK. Add a
  per-board daily ceiling the controller checks *before* claiming, and a
  concurrency limit. Both refuse loudly rather than silently skipping.
- **A wall-clock timeout.** The one gap the runtime page already names: a hung
  session holds its lease until `expiresAt` and nothing stops it. Bound the run
  with an `AbortController` — **not** by moving to streaming input for
  `interrupt()`. That move is structural and has its own decision below.
- **Resume, proved.** `nextPhase()` already keeps `lastSessionId` for the two
  resumable stops, and `reconcile()` already passes `resume`. Nothing has
  exercised it against the real SDK. Add one integration test that hits a turn cap
  and resumes.
- **A kill switch.** `kb stop` sets a board-level pause that the controller checks
  before claiming; `kb start` clears it.
- **Crash safety, proved.** Kill the process mid-run and assert the next reconcile
  reclaims the lease, marks the orphan `lost`, and retries exactly once.

**Exit criteria — met 2026-09-05**

- **G4 holds.** `gateClaim()` (`src/limits.ts`) is pure and has thirteen tests, every one of
  which proves a *refusal*. The board-level checks are the kill switch, a concurrency
  limit, and a rolling-24h USD ceiling judged against what a Job **could** cost rather
  than what it has cost — a cap that only notices after the money is gone is a report.
- **G5 holds.** A real child process takes a real lease, is `SIGKILL`ed, and the assertions
  are that a *live* lease is not stolen (that would be the double-run) and that an expired
  one produces exactly one reclaim, one `lost` orphan and one retry.
- The wall clock aborts a real run: measured `status: timeout` at 10s against an 8s
  ceiling, with the session id surviving so the retry can resume.
- Resume is proved against the real SDK in `test/resume.live.test.ts` — the retry's
  session id equals the first attempt's. Skipped unless `HKB_LIVE_SDK=1`, because CI
  must stay free and deterministic.

**Two things Phase 3 changed that were not planned**

- `kb` is seven verbs now, not five: `stop` and `start` are the kill switch.
- The concurrency gate refuses *before* the compare-and-swap, so known contention no
  longer reaches it. Both paths are kept and tested separately: the gate for contention
  it can see, the CAS for the race it cannot — two hosts that both read "one slot free"
  in the same instant.

---

## Phase 4 — Make it unattended — **DONE**

**Goal:** a loop, and only now.

**Deliverables**

| | |
|---|---|
| `kb up` / `kb down` / `kb up --status`, pid file and log | Done — `src/daemon.ts` |
| The loop does the time-driven half, on a slow interval | Done — 45s default |
| Structured `Event` rows for every transition | Done — 13 kinds |
| `kb log <id>` | Done, plus board-wide `kb log` |

**Exit criteria — both met, and both tested as refusals**

- *The loop survives a laptop sleep without reclaiming a live run.* Two independent
  guards, because the failure is a double run and one guard has been enough to be
  wrong three times already. **Holder liveness:** the lease holder is now
  `<host>/<pid>@<runtime>`, and a lapsed lease whose pid is still running on this
  host is not taken — the pid is qualified by `acquiredAt` against the machine's
  boot time, so a recycled pid after a reboot reads as dead rather than as alive
  for ever. **Suspend detection:** the loop compares wall-clock drift against its
  own interval and skips reclaim for exactly the pass after a jump, which is the
  half that also covers a holder on another host, where no pid check can see.
- *`kb down` stops it and leaves no lease held.* SIGTERM does not exit the process;
  it aborts the run in flight and lets the pass unwind, because the release is
  written on the way out. Measured end to end: `kb down` returned in 0.2s with zero
  leases on the board.

**What Phase 4 changed that was not planned**

- **A new outcome, `stopped`.** An operator stop was recording as `crashed` or
  `timed_out` — both lies, and both *spending a retry*. A Job with `maxRetries: 0`
  could be made permanently unrunnable by nothing but being turned off three times.
  `k` (half the Attempt's primary key) still advances; the retry budget is now
  counted separately and a stop does not charge it. The session id is kept, so
  `kb up` after `kb down` resumes rather than restarts.
- **The loop's clock reaches the controller.** `reconcile` was deciding what had
  expired against `new Date()` while the loop decided whether the machine had been
  asleep against its own clock. One loop, one clock.
- **`Event.boardId`.** A board stop, a daemon up, a Job removal are transitions with
  no Job to hang off — and the removal's would have cascaded away with the Job it
  recorded. Board-level events are what explain the gaps in a log.

**Note.** The eventing experiment from this session is *not* in scope, and the
Kubernetes comparison sharpens why. A controller there is **level-triggered**: the
watch is a latency optimization over a loop that is correct without it — informers
resync periodically regardless, and a watch event enqueues a *key*, after which the
worker re-reads state and discards the event. `PRAGMA data_version` is structurally
a `resourceVersion` — an opaque counter meaning "re-read", carrying no payload — so
it would slot in as a hint that skips a wait, not as a change to how anything
decides. Revisit when latency is a complaint.

**Note.** The eventing experiment from this session is *not* in scope. Triggers +
`fs.watch` on the WAL work (measured: ~1 ms cross-process, 2.3 µs per
`data_version` poll), but they only replace the change-driven half, which is not
the half that needs a loop. Revisit when latency is a complaint.

---

## Phase 4b — One board per machine

Done between Phase 4 and Phase 5, because doing it after would have meant ten
unattended runs producing evidence about machinery already replaced.

The board moved from `<repo>/.kanban/board.db` to `~/.hkb/board.db`: one board per
machine, a `Board` row per repository, one daemon serving all of them. Boards were
already Namespaces in the ADR-007 mapping; they were just each sitting in their own
cluster, which is the one shape in which "what is running on this machine" cannot be
a query.

| | |
|---|---|
| `Board.repoPath`, and `reconcile` takes its checkout from it | Done |
| `Controller` row replacing the pid file | Done |
| `~/.hkb/board.db` default, self-migrating on first touch | Done |
| `kb up` serves every board; `--board` narrows it | Done |
| `kb boards`, `kb boards add <slug> --repo <path>`, `kb boards rm <slug> [--force]` | Done |
| The board inferred from the repository you are standing in | Done |
| Schema-version guard, and a stale-daemon line in `kb up --status` | Done |

**Why the pid file had to go.** It was a second source of truth outside the store,
re-deriving staleness rules `Lease` already owned — and getting one wrong: it recorded
a hostname and never read it back, so on a shared filesystem it asked the wrong
machine's process table. The `Controller` row is the same compare-and-swap as `Lease`
and reuses `holderLiveness`, which is tested. It is also leader election rather than
exclusion, which is what Kubernetes actually does — three controller-managers, one
`Lease`, not a lock.

**Two things found while doing it, neither in scope.** `--interval` had no floor:
`--interval 0` ran 2221 passes in three seconds (fixed, #347). And `test/kb.test.ts`
patches `process.stdout.write` to capture CLI output, while `node --test` multiplexes
its own reporter frames over that stream — so the harness was quietly
timing-dependent and started failing with `Unexpected token '\uFFFD'` when this work
shifted the timing. Frames are filtered now.

**Bootstrap, answered.** "hkb builds hkb while hkb runs pipao" needs no version
juggling, because an ADR-007 worker never invokes `kb` — `src/brief.ts` asks for a
commit, a push and a draft PR, and the controller records the outcome from the SDK
result. The old protocol's terminal verbs were what made the CLI a worker dependency.

---

## Phase 4c — `kb` is a real binary

The Node floor was the last thing standing between the machine-level board and
actually typing `kb`. Settled by measurement rather than release notes:
**`>=22.18.0`** — 22.17.1 fails with `ERR_UNKNOWN_FILE_EXTENSION`, 22.18.0 is the
first release with type stripping unflagged, and a shebang cannot ask for a flag.
`test:core` passes identically there and on 24.x, so the floor covers Prisma and the
native binding, not just the parser.

**What this turned up, which was not on anyone's list.** Node refuses to strip types
for any file under `node_modules` — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, on
every version, by design. So `bin: { kb: "bin/kb.ts" }` produces a binary that cannot
start from a registry install, while working perfectly in a checkout and under
`npm link` (whose realpath is the checkout). ADR-006 had already decided "TypeScript
transpiled at publish" and it had never been implemented, because nothing published
needed it. `prepack` now runs a ~1s `tsc` into `dist/`, and `bin.kb` points there.

Development is unchanged: no build, `node bin/kb.ts` still works, `dist/` is ignored.

**Also caught: `prisma/` was not in `files`.** `ensureSchema` reads
`prisma/migrations/*.sql` at runtime to create a board on a fresh machine, so a
published `kb` could not have made one.

Neither bug is findable by checking that files are in the tarball — the first passes
every such check. So `npm run smoke` now **runs the installed `kb`**: `--help`, then
`kb new`, which creates and migrates a board from the packaged migrations. Both
failures were reproduced deliberately to confirm the check fails on them.

---

## Phase 5 — The dogfood gate

**Goal:** decide, on evidence, whether the board can carry hkb's own work.

**Protocol**

1. Write ten briefs by hand — real, small, hkb-shaped work (a verb, a test, a
   doc page, a bug fix).
2. Run them unattended, one at a time.
3. Record for each: outcome, attempts, cost, wall-clock, whether the PR was
   mergeable without repair, and every manual intervention.
4. Publish the table in this file.

**The gate passes** when eight of ten produce a PR a human merged with no manual
repair of the machinery (the *code* may need review — the machinery may not), and
total spend is within an order of magnitude of what was predicted.

### The prediction, written before the first run

Recorded 2026-09-05, before anything was claimed, because a prediction made after
the fact measures nothing.

The only hard datapoint is the interrupt measurement from Phase 4: **$0.0851 for 12
turns** of reading files. These briefs are implement-plus-test-plus-PR, so 30–70
turns with `Edit`/`Write`/`Bash` rather than reads. Scaling that gives roughly
**$0.30–$1.20 each, mean $0.60**.

> **Predicted total: $6.** An order of magnitude either way is $0.60 to $60.

Ceilings set for the run: `maxBudgetUsd` **$2.00** per Job, board `dailyBudgetUsd`
**$20**, `maxConcurrent` **1**, `maxTurns` 80, `timeoutMs` 30 min (default),
`maxRetries` 2 (three attempts). The board cap is the backstop: ten Jobs each
burning their full $2 would be $20, and the eleventh claim would be refused.

**Predicted failure modes**, so the table can say whether they were the real ones:
the wiki-tooling brief (#6) is the most procedural and the most likely to half-land;
the README brief (#8) is the one most likely to produce a diff a human rejects on
taste rather than on machinery — which the gate counts as a *pass*, since the gate
is about the machinery, not the prose.

**If it fails**, the failures are the plan for Phase 5b. They are also the first
honest backlog — and unlike the 195 cards we just closed, they will describe
machinery that exists.

---

## Phase 5 — the results

Ten briefs, filed 2026-09-05 09:34 UTC, run by one daemon at `--interval 30` with
`maxConcurrent 1`. **Zero interventions**: nothing was touched between the first claim
and the last refusal.

| # | Brief | Phase | k | Cost | Wall | PR | Mergeable without repair? |
|---|---|---|---|---|---|---|---|
| 1 | `kb ls --all` | succeeded | 1 | $2.00 | 271s | [#350](https://github.com/emyann/harness-kanban-board/pull/350) +78/-6 | **yes** |
| 2 | `kb show` names its board | succeeded | 1 | $1.09 | 190s | [#351](https://github.com/emyann/harness-kanban-board/pull/351) +20/-0 | **yes** |
| 3 | `kb log --since` | succeeded | 1 | $1.84 | 229s | [#352](https://github.com/emyann/harness-kanban-board/pull/352) +145/-2 | **yes** |
| 4 | `kb boards rm` | succeeded | 1 | $1.87 | 213s | board says **#341 (closed)**; work is at [#353](https://github.com/emyann/harness-kanban-board/pull/353) | **no — machinery** |
| 5 | Two boards, one repo | succeeded | 1 | $1.20 | 187s | [#354](https://github.com/emyann/harness-kanban-board/pull/354) +38/-4 | **yes** |
| 6 | Daemon howto | **pending** | 2 | $4.07 | 386s | [#355](https://github.com/emyann/harness-kanban-board/pull/355) +245/-0 | **no — never finished** |
| 7 | Attempt duration | succeeded | 1 | $1.23 | 201s | [#356](https://github.com/emyann/harness-kanban-board/pull/356) +58/-1 | **yes** |
| 8 | README section | succeeded | 1 | $1.63 | 234s | [#357](https://github.com/emyann/harness-kanban-board/pull/357) +105/-0 | **yes** |
| 9 | `--status` ceilings | succeeded | 1 | $1.93 | 219s | [#358](https://github.com/emyann/harness-kanban-board/pull/358) +88/-3 | **yes** |
| 10 | Refusal logged once | succeeded | 1 | $1.63 | 225s | [#359](https://github.com/emyann/harness-kanban-board/pull/359) +87/-1 | **yes** |

**All ten PRs are green on all seven CI legs and report `MERGEABLE`.**

### All ten merged

Reviewed and merged 2026-09-05, in this order: the three that touched no shared file
(#357, #355, #359), then the seven that all edit `src/kb.ts`. Nine went in without a
textual conflict. #353 needed a rebase — both because it sits on the renamed branch and
because it edits this file.

Two needed repair, and **neither PR was wrong**:

- **#4 / #353** — rebased onto `main` and its test file re-merged by hand. Both sides
  appended tests at the same point; keeping both was the whole resolution.
- **#350 + #354 together** — see below. Fixed in #361.

`npm run test:core` is **161 pass, 1 skipped** on `main` afterwards, up from 130: the ten
Jobs contributed 31 tests of their own. `npm run smoke` green.

### The failure that only existed in the combination

`#350` added `kb ls --all`, which ignores the board scope. `#354` made `resolveBoard`
refuse when several boards point at one checkout instead of silently taking the lowest
id. Each is correct. Each passed all seven CI legs on its own branch. Merged together,
three of `#350`'s tests fail:

```
Error: 4 boards point at /home/…/harness-kanban-board: far-away, harness-kanban-board,
switch, window — pass --board <slug> to say which one you mean
```

The underlying defect predates both: `main` resolves the board scope for **every** verb
before the switch runs, so `ls --all` resolved a board and discarded it. Harmless while
resolution could not fail; a refusal the moment it could.

**Nothing in the machinery could have caught this.** Each branch is cut from `origin/main`
at claim time and never rebased, CI runs per branch, and no step compares one Job's diff
against another's. Ten agents working in parallel from one base produce work that is
individually green and jointly broken — and with `maxConcurrent: 1` they did not even run
concurrently, so serialising execution does not help. Only integration finds it.

### Verdict: 8 of 10 — the gate passes, exactly at its threshold

- **Cost: $18.48 against $6.00 predicted — 3.1× over.** Inside the order of magnitude
  the gate allows, so the criterion passes, but the *method* was wrong: extrapolating
  from a read-only measurement (12 turns, $0.0851) to tasks that read, edit, run a
  test suite, commit, push and open a PR. Reading is the cheap part. Mean $1.85, range
  $1.09–$2.00, and **five of ten came within 10% of the $2.00 per-Job cap**, which is
  not a comfortable distribution.
- **Wall clock: 39 minutes** for ten Jobs, 187–271s each, remarkably tight.
- **The merges are the human's.** Every PR is a draft; nothing was merged by the
  machinery, which is the design.

### What the two failures were, precisely

**#4 — the branch/PR join broke silently.** `origin/kb-4-1` was a *stale branch from a
Phase 2 smoke test*, unrelated to this Job. The worker's push was correctly rejected as
non-fast-forward, it obeyed "never force-push", and it worked around a broken
precondition by pushing under another name. Then `prForBranch` matched the **closed** PR
sitting on that stale branch and recorded it as the attempt's output. Three defects
compounding, none of them the worker's fault.

**#6 — a brief bigger than its budget burns every retry making the same wall.**
`max_budget` is classed resumable, and resuming is the right idea, but the retry gets
the *same* cap. Attempt 1 spent $2.05, attempt 2 spent $2.02, both stopped in the same
place, and the third was refused by the board ceiling. Resuming only helps when the work
remaining is smaller than the cap; nothing checks that.

### Phase 5b — the honest backlog

Every item below was found by running the thing, not by reading it.

1. **~~Branch names collide across boards.~~ FIXED.** `freeBranch` checks the remote before
   using a name and steps aside when it is taken by unrelated history; the worktree directory
   stays derivable so resume still finds it, and `existingWorktree` reads the branch off the
   checkout rather than deriving one the attempt could not have.
   Original: `kb-<jobId>-<k>` is unique per *database*,
   and job ids restart at 1 on a new board — so a fresh board collides with every
   `kb-N-K` left on the remote. Guaranteed, not a corner case. Root cause of #4.
2. **~~`prForBranch` accepts a closed PR.~~ FIXED.** The lookup is now fenced on the attempt's
   start: a pull request created before the attempt began cannot be its output. The selection is
   a pure `pickPr`, tested without a network. Original: It should prefer an open one, and never
   record a PR that predates the attempt.
3. **~~Nothing verifies the PR's head.~~ FIXED.** `pickPr` asserts `headRefName`, and a branch
   with no matching pull request now says so out loud rather than silently recording null.
   Original: `src/brief.ts` asks; the machinery trusts. The
   branch is "the only thing that ties a PR to its card" and it breaks in silence.
4. **A `max_budget` retry re-spends the cap.** Either raise the cap on resume, or stop
   retrying an outcome the retry cannot change.
5. **~~No verb sets a board's ceilings.~~ FIXED** — `kb boards set <slug> --max-concurrent <n>
   --daily-budget <usd>|none`. Original: `maxConcurrent` and `dailyBudgetUsd` were set
   for this run with a Prisma one-liner. For a system whose gate is "safe to leave
   alone", the safety limits being SQL-only is a real gap.
6. **~~The refusal is logged every tick.~~ FIXED by Phase 5's own job #10 (PR #359).** Original: `reconcile` calls `onEvent` unconditionally,
   defeating the daemon's `announce` dedup — measured 4 lines where 1 was intended.
   (Job #10's brief was about exactly this behaviour, one layer up.)
7. **Worktrees are never reclaimed: 6.1 GB for ten Jobs.** Each carries **614 MB of
   `node_modules`**, because a worker installs the *target repository's* dependency
   tree to run its tests. Note whose: not hkb's shipped dependencies — bundling hkb for
   distribution would not change this number at all. It reads as Prisma and the SDK
   only because the repository being worked on is hkb; a worker on any other repo
   installs that repo's tree instead. So the size is a property of the target, and the
   fix is reclaim rather than slimming: with cleanup the cost is bounded by
   `maxConcurrent × repo size` instead of `jobs-ever-run × repo size`.

   **Superseded in part by ADR-008.** Declared outputs make the sweep able to tell work
   that matters from litter — copy the declared ones out, then delete unconditionally —
   which is a better fix than any narrower keep-test. The rest of this entry still holds,
   and note that the ancestry test below does NOT work here: this repository squash-merges,
   so a merged branch's commits are never ancestors of `main`. What proved safety during
   the Phase 5 cleanup was PR state `MERGED` plus the remote branch being gone.

   **The bug is one word.** `worktreeHasWork` asks whether the branch is *ahead of its
   base*, which is true for every successful Job. Claude Code's own sweep asks whether
   there are **unpushed** commits — "there is work here" versus "this work exists only
   here". Four things to take from `code.claude.com/docs/en/worktrees#clean-up-worktrees`:

   - change the keep-test to unpushed-or-dirty;
   - **remove on a later sweep, not at the end of the run.** Right now the only attempt
     happens at the one moment the work is definitionally freshest. "Safe to delete" is
     a state a worktree enters after its PR lands;
   - the merged-branch test, which needs no forge call: the remote branch it pushed to
     no longer exists, and every commit is already on the default branch;
   - `git worktree lock` while a Job runs, so a sweep cannot take a live checkout —
     hkb relies on the controller being the only remover, which stops being true the
     moment a sweep exists.

9. **A worktree has no gitignored files, and nothing carries them in.** A target repo
   whose tests need a `.env` fails in a worker and passes for the human. Claude Code
   solves this with `.worktreeinclude`; hkb has no equivalent. Not observed in this run
   — hkb's own tests need no such file — which is exactly why it is worth writing down.
8. **Cost estimation needs a real method.** Recorded here so the next prediction is
   made from these ten measurements rather than from one read-only run.

10. **Per-PR CI does not compose, and nothing integrates.** #350 and #354 were both green
    alone and broken together. Every branch is cut from `origin/main` at claim time and
    never rebased, so the further a batch runs the more each Job's base diverges from
    what will actually be merged. The cheap half is a rebase-and-test before the PR is
    called ready; the honest half is admitting a Job cannot verify a claim about a tree
    it has never seen.

11. **`succeeded` does not mean "produced anything".** Nothing in the machinery requires a
    pull request: `withProtocol` (`src/brief.ts`) *asks* for one in prose, is only applied
    when `isolate` is true, and `nextPhase` decides `succeeded` purely from the runtime's
    status. `prForBranch` is a read after the fact, and a Job with no PR simply records
    null. That separation is deliberate — "I investigated and there is nothing to change"
    is a real outcome — but the *absence* should be loud. `kb show` says
    `branch kb-N-1 — no pull request found` per attempt; nothing aggregates it, so a board
    of fifty succeeded Jobs where five produced nothing looks uniform in `kb ls`. This is
    also the general case of finding 3: nothing verifies the PR's head because nothing
    verifies there is a PR.

---

## After the gate

In this order, and each one only when the previous is boring:

1. **File hkb's own work on the board.** This is the point.
2. **Retire the old system.** Delete `src/store/*`, `src/dispatch.js`,
   `src/cli.js`'s 36 verbs; rename `kb` to `hkb`. Keep `refs/kb/boards/default` as
   an archive — it is history, and it costs nothing.
3. **The second kind: groom.** A one-shot with a human gate (propose → approve →
   apply). It is the *most different* from a Job, which is why it is next: what
   generalises between them is real. `Phase.suspended` already exists for it.
4. **The third kind: the DAG.** Only now. Its controller creates Jobs, the way a
   CronJob creates Jobs, and its dependency rule lives in the admission gate —
   `admitSpawn` already takes the policy — so ordering is structural rather than
   prompt-following. This is the piece that failed when we tried it early.
5. **Integration.** A dependent card cannot see a sibling's unmerged work; no
   `worktree.baseRef` setting fixes that. The old design's `kb/track-<root>`
   integration branch is the shape that does. Do not start the DAG kind without it.

---

## Decided: single-message input stays

**Settled 2026-09-05 by a 22-agent investigation, and the premise turned out to be false.**

`interrupt()` does **not** require streaming input on SDK 0.3.261. `query()` closes stdin only when
the *first result* arrives, so control requests are writable for the whole run — measured, by firing
`interrupt()` at t=15s on a string prompt and getting a receipt at t=16.07s. The comment in
`src/runtime/claude.ts` that claimed otherwise is what made this look like a decision at all.

What streaming uniquely buys is **authority**, not delivery: an `SDKUserMessage` carries
`role:"user"`, whereas hook-delivered text was refused by a worker as untrusted. A Job has no human
present to author an authoritative instruction, so the one thing streaming adds is the one thing
this kind cannot use. The k8s mapping is untouched.

The axis that will separate a future attended kind is **attendedness**, not input mode. Kubernetes
agrees: `exec`/`attach` are Pod *subresources*, and the one declarative mid-life control is
`Job.spec.suspend` — a field, not a kind, which is what `Phase.suspended` already is.

The original reasoning is kept below because two of its rows were wrong in instructive ways.

### The table, corrected

| Wanted | What is actually true |
|---|---|
| A wall-clock timeout | **Done.** `interrupt()` then abort after a grace window. Measured: a 20s clock returned `$0.085` over 12 turns with a surviving session, where an abort had returned `$0` |
| Images from outside the repo | **No materialising needed.** A worker under `dontAsk` read an absolute path outside its cwd and got an image block, zero denials |
| Multi-turn continuation | **Done.** A resumed attempt continues in the checkout the previous one left, on the branch its PR is already on. A first attempt that did nothing leaves nothing to resume into, and a fresh worktree is then equivalent |
| Steering a live run | Delivery already works in single mode (a `Stop` hook's `decision:'block'` made a worker rewrite its output). Only *authority* needs streaming |

### The original reasoning, superseded

The runtime uses **single-message input**: `prompt` is a string, the session runs to
completion, the result comes back. That is deliberate and it is what makes the Job
kind a Job. It is also what forecloses four things, and the reason this is an open
decision rather than a task is that only one of them actually needs streaming:

| Wanted | Single-mode answer |
|---|---|
| A wall-clock timeout | `AbortController` around the run (Phase 3) |
| Images from outside the repo | materialise them into the worktree; the brief names the paths, `Read` renders them |
| Multi-turn continuation | `resume: <sessionId>` — already works, already used by the two resumable stops |
| **Steering a run while it is running** | **none. This is the one that requires streaming.** |

### Why it is structural, and not a driver detail

The Kubernetes mapping this core is built on depends on a Job *terminating*:

- **A Job is batch.** It has a completion condition, a retry budget, and a phase
  model (`pending → running → succeeded`) that assumes an end. A streaming session
  is a process that stays up and accepts input over time — that is a Deployment,
  not a Job, and it reconciles toward a *steady state* rather than toward
  completion. Different controller shape, not a different flag.
- **The lease stops meaning what it means.** A Job's lease covers one bounded run,
  which is why it could replace the heartbeat that ADR-007 deleted. A long-lived
  session's liveness is a heartbeat again, and that is the invariant the reset
  spent the most effort simplifying.
- **"Store what survives the runtime process" was justified by brevity.** A short
  run makes in-memory state cheap to lose. A session held open for hours makes it
  expensive, which reopens what belongs in the store.

### The likely answer, stated as a hypothesis

Steering a live agent is probably **a second kind** — an attended/interactive one —
rather than a change to this one. That would keep the Job batch-shaped and give the
streaming session its own controller, its own phases and its own liveness rule,
which is what the k8s mapping would predict.

Investigate before Phase 4 (the loop), because a loop built for batch Jobs and a
loop supervising long-lived sessions are not the same loop.

---

## Debt this plan does not pay

Named so it is not mistaken for forgotten:

- **`package-lock.json` is gitignored** with a comment saying TypeScript is the
  only dependency. Direct deps are pinned exactly; transitives are not. Fixing it
  needs a CI change (`package-manager-cache: false` currently requires the lockfile
  to be absent).
- **19 wiki pages are stale.** They describe the pre-ADR-007 system, which still
  runs. Refresh them when the migration moves that code, or retire them with it.
- **`engines: >=22.13`** while the sources are `.ts` run natively. CI's node 22 job
  passes, but the *floor* was set before native type stripping mattered.
  > TODO-VERIFY: whether 22.13 specifically strips types, or whether the floor
  > should rise.
- **No migration of the old board.** Decided: the 195 cards are closed and the ref
  is kept as an archive. Nothing is coming back from it.
