# Glossary

Project vocabulary, alphabetical. One line per term; cite code where a term
maps to a symbol or table. Keep entries short — a term that needs paragraphs
deserves a `concepts/` page (link it).

The vocabulary of the pre-ADR-007 system — card, claim, tick, track, wave, guard,
profile, handoff, store, board ref, bridge, seat — was retired with the code that
gave those words meaning (*decisions/adr-009-retiring-the-first-system*). If you
meet one in the git history, that is what it was.

- **Admission control** — enforcing an invariant at the tool boundary rather than asking for it in a
  prompt: a `PreToolUse` hook that denies a spawn or mutates its input — e.g. injecting
  `isolation: "worktree"` when the workload has a worktree of its own, and refusing one when it does
  not (`src/admission.ts`). Not `canUseTool`, which is shadowed by both `bypassPermissions` and bare
  `allowedTools` entries. Named after the Kubernetes admission controller, and adopted after a
  prompt-level instruction was measurably ignored (*concepts/admission-control*).
- **Attempt** — one execution of a Job — the Pod, the thing that dies (`prisma/schema.prisma`).
  Carries `sessionId`, the pointer that recovers everything the SDK already stores, and
  `maxBudgetUsd`, the cap it was *claimed* under, frozen so a past attempt stays legible against the
  number that actually stopped it.
- **Board** — a namespace: one row per repository, holding that repository's Jobs, its ceilings and
  its spec defaults (`prisma/schema.prisma`). Not a file and not a UI. Which one a command means is
  decided by the repository you are standing in, or by `--board <slug>` (`resolveBoard`,
  `src/hkb.ts`).
- **Board defaults** — the middle of the three-deep spec resolution: the Job's own value wins, the
  Board's default fills a null, the built-in is the last resort (`resolveSpec`, `src/spec.ts`). A
  default is not a ceiling — a Job may override `--model` freely, and may not exceed
  `--daily-budget`.
- **Ceiling** — a claim-time refusal, one of `stopped`, `concurrency` or `budget` (`ClaimLimit`,
  `src/limits.ts`). Checked before a claim and never during a run: a ceiling that could stop a
  running worker would strand its worktree, while one that declines to start another is only a
  decision.
- **Control plane** — hkb read as Kubernetes reads itself: a Board is a namespace, a Job is a Job, an
  Attempt is a Pod, a Lease is a Lease, and the daemon is a controller-manager. The one departure is
  that hkb also *executes* — there is no node to schedule onto (*architecture/overview*,
  *decisions/adr-005-control-plane* for the original model).
- **Controller row** — which daemon leads one board, with the same holder, liveness rule and
  compare-and-swap as a `Lease` (`acquireBoard`, `src/daemon.ts`). It is leader election, not
  exclusion: a second daemon takes the boards it can and idles on the rest. It replaced a pid file,
  and it is what `hkb up --status` reads (*architecture/the-loop*, *howto/running-the-daemon*).
- **Export** — a path a Job *declares* it will produce (`--export`, repeatable), copied out of the
  worktree into the repository before the checkout is torn down; a declared path the run did not
  produce fails the attempt, and everything undeclared is litter that goes with the checkout
  (`checkExportPath`/`copyIncluded`, `src/worktree.ts`; *decisions/adr-008-declared-outputs*).
- **Forge** — where pull requests live, deliberately not where the board lives. GitHub, read through
  one `gh` shell-out (`src/pulls.ts`) and joined to a Job by branch name. It holds no Job, no lease
  and no state hkb depends on.
- **Job** — the primitive kind: one agent, one brief, run to completion, with a retry budget. Spec
  and status in one table; the controller writes only status (`prisma/schema.prisma`). The
  Kubernetes Job it is named after (*architecture/job-kind*).
- **Kind** — a workload's schema plus the controller that advances it. `Job` is the first and only
  one (`prisma/schema.prisma`, `src/controller.ts`); a new kind means a new controller, not just new
  data (*architecture/job-kind*).
- **Lease** — who holds a Job right now, with a `holder`, a `token` and an `expiresAt`; the `@@id` on
  it is the compare-and-swap, and an expired one is what makes a dead holder reclaimable
  (`prisma/schema.prisma`, `reclaimExpired`, `src/controller.ts`) (*architecture/job-kind*).
- **Level-triggered** — the property that makes the controller safe: `reconcile()` reads observed
  state, compares it to desired state and takes one step, so it may be run repeatedly, interrupted,
  or run while another host runs it (`src/controller.ts`). Nothing may depend on having seen an
  event, which is why the daemon is a resync loop rather than a subscription
  (*architecture/the-loop*).
- **Liveness** — the three-valued answer to "is this lease holder still running": `alive`, `dead` or
  `unknown` (`holderLiveness`, `src/liveness.ts`). `unknown` is a real answer — a holder on another
  host cannot be probed — and a holder whose lease predates this machine's boot is `dead` whatever
  the pid says (*architecture/the-loop*).
- **Operator** — the human seat: files Jobs, sets the ceilings, reviews and merges, and makes the two
  statements the machinery cannot (`hkb done`, `hkb cancel`, `src/hkb.ts`). "you", in a worker's
  brief.
- **Phase** — a Job's lifecycle state: `pending`, `running`, `succeeded`, `failed`, `suspended`,
  `done`, `cancelled` (`prisma/schema.prisma`). Observed, except for the last three, which only a
  human can write. `suspended` exists for the workloads that block on a human — a state no runtime
  can report.
- **Proposal** — a board change a workload asks for rather than performs: declared as an output, written
  by the run to a path the controller gave it, and applied by the controller only after an approval is
  on the Event stream. A workload has no board handle, so this is the only modelled way one affects the
  board — and the controller validates a proposal by refusing it, because a value it acts on is an API
  request rather than a handoff (*decisions/adr-011-proposals-not-board-access*).
- **Resumable outcome** — a run that stopped on its turn or budget cap rather than breaking: it left
  a session worth continuing, so the next attempt resumes it instead of starting cold (`nextPhase`,
  `src/controller.ts`) (*architecture/runtime-layer*).
- **Runtime** — the seam that runs a worker, `run(spec) -> WorkerOutcome` (`src/runtime/index.ts`).
  Two drivers: the Claude Agent SDK (`src/runtime/claude.ts`) and a fake that spends nothing
  (`src/runtime/fake.ts`) (*architecture/runtime-layer*).
- **Sweep** — reclaiming worktrees on the daemon's tick rather than at the end of a run, because
  "safe to delete" is a state a worktree enters *later*, when its pull request lands
  (`sweepWorktrees`, `src/worktree.ts`). It is what bounds disk by `maxConcurrent × repo size`
  instead of by `jobs-ever-run × repo size`.
- **Worker** — the seat that codes: one agent session holding one attempt on one Job, launched by
  the controller into a worktree of its own with the protocol in `src/brief.ts`. It never merges and
  never touches the operator's checkout.
- **Workload** — a unit of work hkb takes and executes. A workload has a *kind*; the kanban DAG and a
  propose-approve grooming pass are two further shapes, neither of which exists as code
  (*decisions/adr-007-workload-scheduler*).
- **`.worktreeinclude`** — a repository's declaration of which *gitignored* files to carry into a
  worker's worktree, because a fresh checkout does not have the `.env` its tests need. Git answers
  both halves of the match rule, and no pattern may reach the board's own directory (`includedFiles`,
  `src/worktree.ts`; *features/worktree-includes*).
