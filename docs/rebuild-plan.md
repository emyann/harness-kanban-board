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
| `kb boards`, `kb boards add <slug> --repo <path>` | Done |
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

**If it fails**, the failures are the plan for Phase 5b. They are also the first
honest backlog — and unlike the 195 cards we just closed, they will describe
machinery that exists.

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
