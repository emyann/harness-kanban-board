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

**Exit criteria**

- G4 and G5 hold, each with a test.
- A budget-exhausted board refuses to claim and says which ceiling it hit.

---

## Phase 4 — Make it unattended

**Goal:** a loop, and only now.

**Deliverables**

- `kb up` / `kb down`: a detached process that reconciles on an interval, with a
  pid file and a log, plus `kb up --status`.
- The loop does the **time-driven** half only — lease expiry, the wall-clock
  timeout, scheduled work. The change-driven half is already a reconcile away, so
  the interval can be slow (30–60s) without hurting latency.
- Structured `Event` rows for every transition, and `kb log <id>` to read them.

**Exit criteria**

- The loop survives a laptop sleep without reclaiming a live run.
- `kb down` stops it and leaves no lease held.

**Note.** The eventing experiment from this session is *not* in scope. Triggers +
`fs.watch` on the WAL work (measured: ~1 ms cross-process, 2.3 µs per
`data_version` poll), but they only replace the change-driven half, which is not
the half that needs a loop. Revisit when latency is a complaint.

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

## Open decision: single-message vs streaming input

**Status: undecided. Do not settle it inside a phase — it is structural.**

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
