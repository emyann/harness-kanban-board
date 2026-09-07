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
- **Artifact** — the third declared output: a file the *board* keeps, uncapped, written by the worker to
  an absolute path outside every checkout (`--artifact <name>`, `src/artifacts.ts`). The gap between the
  other two — too large to be a **result**, and no business in a commit the way an **export** is. A name
  may come back as a directory. Only the catalogue (name, kind, size) lands on the Attempt, and nothing
  removes the file, because nothing else holds it (*features/declared-outputs*,
  *decisions/adr-011-proposals-not-board-access*).
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
- **Ceiling** — a limit a Job may not exceed, enforced as a claim-time refusal: one of `stopped`,
  `concurrency` or `budget` (`ClaimLimit`, `src/limits.ts`). Checked before a claim and never during
  a run — a ceiling that could stop a running worker would strand its worktree, while one that
  declines to start another is only a decision. The opposite of a **board default**, which a Job may
  freely override (*concepts/ceilings*).
- **Committed budget** — what the runs already in flight could still spend: the sum of
  `Attempt.maxBudgetUsd` over attempts with no `endedAt` (`committedUsd`, `src/limits.ts`). Counted
  because `costUsd` only moves when an attempt *ends*, so without it N concurrent claims would each
  be judged against a spend none of them had contributed to yet (*concepts/ceilings*).
- **Composition failure** — two changes that are each correct, each green on their own branch, and
  broken once both are on the mainline. Not a merge conflict (git reports none) and not a
  concurrency bug: what parallel workers share is a **base**, not a clock, and what they collide on
  is a shared invariant rather than a shared file (*gotchas/merge-composition*). Replaying each
  branch onto the current base at the end of its run (*features/rebase-and-verify*) narrows the
  divergence and does not touch the failure.
- **Checkout base** — the ref a Job's worktree is cut from and its branch is kept on top of
  (`Job.base`, `baseFor` in `src/worktree.ts`). Null is the repository's default branch. It is the
  connector between one Job and the next, because a coding Job's output is a branch — and it is a
  ref, never a reference to another Job, which would be the ordering edge study §2 rejected
  (*features/the-checkout-base*).
- **Conflicted** — an `Outcome`: the session ended and the work is real, but the branch no longer
  replays onto the base it will be merged into (`rebaseOntoBase`, `src/rebase.ts`). Its own value
  rather than `no_output` because the fault is in neither the work nor the spec, and the fix is a
  hand rebase rather than another run (*features/rebase-and-verify*).
- **Control plane** — hkb read as Kubernetes reads itself: a Board is a namespace, a Job is a Job, an
  Attempt is a Pod, a Lease is a Lease, and the daemon is a controller-manager. The one departure is
  that hkb also *executes* — there is no node to schedule onto (*architecture/overview*,
  *decisions/adr-005-control-plane* for the original model).
- **Controller row** — which daemon leads one board, with the same holder, liveness rule and
  compare-and-swap as a `Lease` (`acquireBoard`, `src/daemon.ts`). It is leader election, not
  exclusion: a second daemon takes the boards it can and idles on the rest. It replaced a pid file,
  and it is what `hkb up --status` reads (*architecture/the-loop*, *howto/running-the-daemon*).
- **Export** — a path a Job *declares* it will produce (`--export`, repeatable), copied out of the
  worktree into the repository before the checkout is torn down — the one of the three declared outputs
  whose destination is the repository rather than the board; a declared path the run did not
  produce fails the attempt, and everything undeclared is litter that goes with the checkout
  (`checkExportPath`/`copyIncluded`, `src/worktree.ts`; *features/declared-outputs*,
  *decisions/adr-008-declared-outputs*).
- **Fence** — a value carried in a write's `where` clause so the write is a no-op when the world moved
  under it: `Lease.token` at renewal and at release, and the expiry re-read on the reclaim delete
  (`src/controller.ts`). It is how a holder learns it lost its lease, and why a stale holder finishing
  late cannot delete the new holder's claim (*concepts/leases-and-liveness*).
- **Forge** — where pull requests live, deliberately not where the board lives. GitHub, read through
  one `gh` shell-out (`src/pulls.ts`) and joined to a Job by branch name. It holds no Job, no lease
  and no state hkb depends on.
- **Holder** — who a lease or a `Controller` row belongs to, written as `<hostname>/<pid>@<runtime>`
  and parsed back on the way in (`holderId`/`parseHolder`, `src/liveness.ts`). The hostname is not
  decoration: a pid without a host is a number with no referent, so a bare pid cannot be checked for
  **liveness** at all (*concepts/leases-and-liveness*).
- **Job** — the primitive kind: one agent, one brief, run to completion, with a retry budget. Spec
  and status in one table; the controller writes only status — the one exception being that it
  *creates* Jobs from an approved **proposal**, which is a new row and never another Job's status
  (`prisma/schema.prisma`). The
  Kubernetes Job it is named after (*architecture/job-kind*).
- **Guide** — the repository's contributor guide, granted as a repo-relative path (`--guide`,
  `Job.guide`, `Board.defaultGuide`) and read by hkb from `Board.repoPath` before the run
  (`src/guide.ts`). Prepended to the brief as **instruction**, with the brief winning where the two
  disagree — the opposite framing to an **input**, which is data. Follows one level of `@import`; a
  guide that cannot be read ends the attempt at `no_input` before anything is spent. hkb reads it
  rather than letting the runtime load it, because `settingSources` would bring the repository's
  shell hooks with it (*decisions/adr-013-the-guide-is-read-not-loaded*).
- **Input** — content a Job *declares* it will be given (`--input <name>=<source>`), resolved by the
  controller before the run and placed in the prompt ahead of the brief (`src/inputs.ts`). Four sources,
  none of which waits: `file:<repo-relative-path>`, read from `Board.repoPath` and not the worktree;
  `board`, the LLM-free board arithmetic; `value:<literal>`, the one a caller *pushes* rather than one
  hkb fetches; and `self:<field>`, the **downward API** — this Job's own `id`, `name`, `board`,
  `attempt`, `slot`, `branch`, `worktree` or `repo`. A `value:` may be interpolated into the brief and
  no other source may (`renderBrief`). Stored as k8s stores `env`: `name` plus either `value` or a
  `valueFrom` object (*decisions/adr-007-workload-scheduler*). An input that cannot be read ends the attempt at
  `no_input` before the runtime is called. A source naming another Job's output is refused — that is an
  ordering edge (*decisions/adr-007-workload-scheduler*). Restriction comes from pairing it with a
  narrowed **tool surface**, not from the injection itself.
- **Kind** — a workload's schema plus the controller that advances it. `Job` is the first and only
  one (`prisma/schema.prisma`, `src/controller.ts`); a new kind means a new controller, not just new
  data (*architecture/job-kind*).
- **Label** — a `key=value` pair on a Job, stored as a string→string map in `Job.labels` and selected
  on with `hkb ls --label k=v` — equality only, ANDed across repeats (`src/labels.ts`;
  *features/labels*). A map rather than a tag list so `workflow=release` and `step=draft` compose.
  Nothing in the controller reads one: a label is how a person finds work again, not how work finds
  work.
- **Slot** — the concurrency ordinal a lease holds: the lowest non-negative integer no other live
  lease holds, machine-wide, released when the lease is (`Lease.slot`, frozen onto `Attempt.slot`).
  It is the only fact answering *"which of the concurrent workers am I"*, which a run picking a port
  or a database name needs and `id` cannot give — the StatefulSet ordinal, for workers that share one
  machine's ports instead of getting a Pod IP each. Read by a Job as `--input me=self:slot`.
- **Lease** — who holds a Job right now, with a `holder`, a `token` and an `expiresAt`; the `@@id` on
  it is the compare-and-swap, and an expired one is what makes a dead holder reclaimable
  (`prisma/schema.prisma`, `reclaimExpired`, `src/controller.ts`). Its duration is derived from the
  run it covers — `timeoutMs` plus a grace — never chosen independently
  (*concepts/leases-and-liveness*, *architecture/job-kind*).
- **Level-triggered** — the property that makes the controller safe: `reconcile()` reads observed
  state, compares it to desired state and takes one step, so it may be run repeatedly, interrupted,
  or run while another host runs it (`src/controller.ts`). Nothing may depend on having seen an
  event, which is why the daemon is a resync loop rather than a subscription
  (*architecture/the-loop*).
- **Liveness** — the three-valued answer to "is this lease holder still running": `alive`, `dead` or
  `unknown` (`holderLiveness`, `src/liveness.ts`). `unknown` is a real answer — a holder on another
  host cannot be probed — and a holder whose lease predates this machine's boot is `dead` whatever
  the pid says (*concepts/leases-and-liveness*, *architecture/the-loop*).
- **Migration guard** — the rule that a **checkout** may create a board and may not rewrite one
  (`mayMigrate`, `src/schema.ts`). A new board is created and migrated unasked, an installed build
  migrates on upgrade, and a checkout meeting an existing board refuses with the pending migrations
  and `hkb migrate`. It exists because the forward direction was silent: a command run from a feature
  branch used to migrate the machine's board, after which every other checkout refused it
  (*architecture/the-board*).
- **Off the map** — a place where hkb's Kubernetes mapping stops being evidence and hkb has to
  answer for itself. Two are named in ADR-016: ports on a shared host (Kubernetes has a Service to
  hide behind and hkb has one machine, so `self:slot` is ours) and the completion signal (a
  container exits with a code; an agent session always finishes talking).
- **Operator** — the human seat: files Jobs, sets the ceilings, reviews and merges, and makes the two
  statements the machinery cannot (`hkb done`, `hkb cancel`, `src/hkb.ts`). "you", in a worker's
  brief.
- **Plugin grant** — a directory, repository-relative, whose skills (and commands, and agents) a
  worker may see: `--plugin-dir`, `Job.pluginPaths`, `Board.defaultPluginPaths`, resolved through
  `src/spec.ts` and passed as `plugins: [{ type: 'local', path }]` (`src/plugins.ts`). It is how a
  repository's own skills reach a worker without `settingSources: ['project']`, which would also load
  `.claude/settings.json` — where a hook is a shell command. Resolved against `Board.repoPath` and
  never the worktree, so a merge is the only way to change what it loads. It widens what a worker may
  **read** and nothing about what it may **do** (*decisions/adr-012-skills-by-grant-not-by-settings*).
- **Phase** — a Job's lifecycle state: `pending`, `running`, `succeeded`, `failed`, `suspended`,
  `done`, `cancelled` (`prisma/schema.prisma`). Observed, except for the last three, which only a
  human can write. `suspended` exists for the workloads that block on a human — a state no runtime
  can report.
- **Proposal** — a board change a workload asks for rather than performs: `proposal.json` in the run's
  artifact directory, validated by refusing (`src/proposals.ts`), and applied by the controller only
  after an approval is on the Event stream. A workload has no board handle, so this is the only
  modelled way one affects the board, and a proposed Job may set `name`, `brief` and a downward-clamped
  `maxBudgetUsd` — nothing else (*features/proposals*,
  *decisions/adr-011-proposals-not-board-access*).
- **Lineage** — the three columns a proposed Job carries naming where it came from: `proposedByJobId`,
  `proposedByK`, `proposalIndex` (`prisma/schema.prisma`). An observation the controller made about
  what it did, never a claim a worker made about itself — and, being unique together, the reason
  applying a proposal twice creates nothing twice (*features/proposals*).
- **Litter** — anything a run leaves behind that it did not declare. Bazel's rule, which ADR-008
  adopts: the known outputs move out of the sandbox and the rest goes with it, which is what makes a
  worktree safe to delete (*features/declared-outputs*).
- **Result** — a small named value a Job declares and the board keeps on the Attempt row
  (`--result <name>`, `src/results.ts`). The worker writes it to an absolute path outside every
  checkout and the controller reads it back; capped at `RESULT_MAX_BYTES` per value, deliberately,
  so nobody mistakes it for file storage — an **artifact** is the uncapped one
  (*features/declared-outputs*).
- **Resumable outcome** — a run that stopped on its turn or budget cap rather than breaking: it left
  a session worth continuing, so the next attempt resumes it instead of starting cold (`nextPhase`,
  `src/controller.ts`) (*architecture/runtime-layer*).
- **Volunteered output** — a result or artifact a run left without declaring: kept and reported,
  never required, and never able to fail an attempt (`collectResults`/`collectArtifacts`,
  `src/results.ts`, `src/artifacts.ts`) (*features/declared-outputs*).
- **Transition** — a Job moving between phases because a *person* decided (`src/transitions.ts`:
  queue, triage, approve, reject, retry, done/cancel, remove), as opposed to the moves the
  controller makes by observing. Each is a lookup, a set of refusals and a group of writes that
  belong together; the refusals are why it is a module rather than a phase write
  (*architecture/transitions*).
- **Triage** — the phase before the queue: a Job that has been noticed and not decided on
  (`Phase.triage`, `hkb new --triage`). Never claimed, because the claim query asks for `pending` and
  always did. `hkb queue <id> ["<brief>"]` makes it work — and is the one moment the brief may be
  rewritten, because that is when a note becomes an instruction — and `hkb triage <id>` is the way
  back for one filed in haste. The only human-written phase that is an entry rather than an exit
  (*architecture/job-kind*).
- **Watch** — following the board's `Event` stream as it is written (`hkb watch`, `src/watch.ts`). Every
  line leads with its event id, and that id is the resume token: `--after <id>` picks up exactly where a
  previous watch stopped, and it never expires because events are append-only. Woken by `fs.watch` on the
  board's directory with a slow interval as the fallback, so a filesystem that cannot report changes makes
  it later and never wrong (*features/watch*).
- **Rolling window** — the 24 hours the budget ceiling is measured over: `now - 24h`, never a
  calendar day, because a calendar day has a timezone to get wrong (`windowStart`, `src/limits.ts`).
  No midnight and no reset — spend ages out of it continuously (*concepts/ceilings*).
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
- **Workflow** — a file at `.hkb/workflows/<name>.md` in the board's repository whose frontmatter is a
  Job's spec and whose body is its brief. `hkb new --from <name>` expands one into a Job at file time;
  the keys are `hkb new`'s flags, so one vocabulary documents both (`src/templates.ts`;
  *features/workflow-templates*). Not a graph: it templates ONE Job, not an ordering between several.
- **Workload** — a unit of work hkb takes and executes. A workload has a *kind*; the kanban DAG and a
  propose-approve grooming pass are two further shapes, neither of which exists as code
  (*decisions/adr-007-workload-scheduler*).
- **`.worktreeinclude`** — a repository's declaration of which *gitignored* files to carry into a
  worker's worktree, because a fresh checkout does not have the `.env` its tests need. Git answers
  both halves of the match rule, and no pattern may reach the board's own directory (`includedFiles`,
  `src/worktree.ts`; *features/worktree-includes*).
