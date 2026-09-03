# Glossary

Project vocabulary, alphabetical. One line per term; cite code where a term
maps to a symbol or table. Keep entries short — a term that needs paragraphs
deserves a `concepts/` page (link it).

<!-- Example:
- **Watermark** — the `ModifiedDate` high-water mark each incremental sync
  resumes from; persisted per operation in `sync_watermarks` (`prisma/schema.prisma`).
-->

- **Attempt** — one numbered try at a card by one worker; recorded in the run
  comment, never overwritten (`src/model.js`). The claim ref carries its number.
- **Board** — the set of issues wearing this board's `kb:board:*` label plus
  the local `.kanban/` config that names it (`src/board.js`).
- **Board key** — the URL-safe `owner~repo~slug` id `hkb serve` gives each board
  it holds, and the path segment every request names it by
  (`boardKey`/`uniqueKeys` in `src/model.js`; see *features/web-board*).
- **Binding** — what one board's profile calls an *intent*, written in
  `profile.capabilities` and validated by `loadBoard` (`src/board.js`). Local by
  design: hkb reads it and never writes a command name of its own.
- **Capability map** — a profile's `intent → command` bindings, the first
  profile field about what a session reaches for rather than how it starts; see
  *features/capability-map* and *concepts/capability-portability*.
- **Card / task** — a GitHub issue on the board; "card" in kanban prose,
  "task" in code and JSON (`src/store/github.js`).
- **Claim** — an atomic take on a card: creating `refs/kb/locks/<n>/<k>`, the
  only CAS GitHub offers (`src/store/github.js`).
- **Continuation** — an attempt that carries on an **open PR** the reviewer sent
  back instead of starting a branch of its own; marked `continues_pr` on the
  attempt row, and `continues_branch` when the dispatcher put the checkout on
  the PR's head branch (and `continues_branch_stale` when that checkout could not be
  fast-forwarded to the remote head) (`worktreeOnBranch` in `src/board.js`; see
  *features/review-loop*).
- **Day stamp** — a `*_day` key in `.kanban/state.json` holding a UTC day, so a
  check that costs a network call runs at most once a day per checkout however
  often it is invoked; `token_expiry_day` and `version_check_day` are the two,
  and neither stamps a failed probe (`src/doctor.js`; see
  *features/update-notice*).
- **Dependency subgraph** — the drawer's picture of one card's neighbourhood in
  the board's `blockedBy` graph: the card, everything it transitively waits on and
  everything transitively waiting on it, laid out from the `/api/board` payload
  alone (`depGraph` in `web/index.html`; see *features/web-board*).
- **Dispatcher** — the seat that ticks: `hkb dispatch` reconciles labels, locks
  and attempts against the graph on the cards. Not an orchestrator — it holds no
  workflow and has no LLM in it (`src/dispatch.js`; see *Tick*).
- **Exit record** — `{code, at, reason}` under `exits` in `.kanban/state.json`,
  written by a dispatcher loop that gave itself up (exit 4) and cleared when one
  runs again, so `hkb up --status` can say why nothing is running instead of just
  "stopped" (`src/board.js`; see *features/up-and-down*).
- **Guard** — a reason the tick declines to claim a card it could otherwise
  claim: `active_pr`, `blocker_auth`, `recent_success`, `path_overlap`
  (`src/dispatch.js`). `active_pr` is the one with an exemption — a card whose
  latest attempt is the reviewer's `changes_requested` row stays claimable and
  becomes a *continuation* (`activePrGuard` in `src/model.js`).
- **Handoff** — the structured result comment a finishing worker leaves so its
  dependents (and humans) start informed (`src/model.js`).
- **Head-branch fallback** — a card's PR found by matching an open PR's head
  branch against `taskBranchRe(n)` (`kb/<n>`, `kb-<n>-<k>`,
  `worktree-kb-<n>-<k>`) when GitHub's `closedByPullRequestsReferences` links
  nothing — one board-wide read (`openPrsByHead`, `src/forge.js`), applied whenever a card's
  own `prs` comes back empty (`fillPrFallback`, `src/store/github.js`; `features/tracks`,
  `features/review-loop`).
- **Host** — machine identity, recorded per attempt, so the tick only checks a
  pid on the machine that owns it (`src/dispatch.js`).
- **Intent** — a kind of work from the closed `CAPABILITIES` vocabulary
  (`src/model.js`), each shipped with its one-line meaning. The portable half: an
  intent travels between harnesses, its *binding* does not. Unbound is the
  ordinary answer, and it means today's prose brief.
- **Operator** — the human seat: owns the repo, the token and the scope; files
  cards, steers by comment, reviews and merges, answers `kb:needs-human`,
  restarts a dispatcher that exited 4. "you", in a worker prompt
  (`decisions/adr-004-roles-and-adoption`).
- **Operator session** — an agent session driving the operator's verbs on the
  human's behalf, briefed by `/kanban:operate`. It has no `KB_TASK`, so no guard
  in hkb applies to it: its limits — no merge on a `manual` board, no
  `.kanban/board.json` edit, no second dispatcher — are the brief itself
  (`skills/kanban/SKILL.md`; see *features/operator-seat*).
- **Pid file** — `.kanban/dispatch.pid` and `.kanban/serve.pid`: one pid per line,
  written by the process itself and pre-written by `hkb up` for the child it
  spawned, and deleted only by the process that wrote it. Being named by one,
  answering `kill(pid, 0)`, and not being *stale* is the whole definition of
  "running" here (`src/board.js`; see *features/up-and-down*).
- **Grooming** — reading the triage lane as a report rather than by hand: `hkb groom`
  computes every LLM-free finding from the one board read and writes nothing, and
  `/kanban:groom` judges only what that report flags, proposes one table, and applies
  a row only after a human's yes (`src/cli.js`, `skills/kanban/SKILL.md`; see
  *features/backlog-grooming*).
- **Finding / finding level** — one groomed observation about a card, `{kind, level,
  evidence, suggests}`. `GROOM_KINDS` maps each kind to `act` (mechanical, safe to
  propose), `ask` (real but false-positive-prone, a model must look), `info` (context,
  never an action) or `needs_judgment` (a shortlist, explicitly not a verdict)
  (`GROOM_KINDS` in `src/model.js`). The level says who is competent to decide, not
  how bad it is.
- **Groom action** — what one groomed card proposes, from the closed vocabulary
  `GROOM_ACTIONS`: promote · specify · link-under · split · supersede · reprioritise ·
  park · archive, plus `judge` and `none` (`src/model.js`). Exported so the skill's
  action column can be pinned to it by a drift test.
- **Hub path** — a path so many open cards name that it distinguishes none of them;
  removed before two cards' paths are scored for overlap (`pathHubs` / `pathJaccard`
  in `src/model.js`; see *features/backlog-grooming*).
- **Planning command** — `/kanban:specify`, `/kanban:decompose` or `/kanban:groom`: a harness slash
  command rather than an `hkb` verb, because each needs a model and the dispatcher
  has none. One source in `commands/`, registered by the plugin and by `hkb init`
  (`src/init.js`; see *features/planning-commands*). `/kanban:operate` is the
  fourth file in that directory and takes the same route, but it runs the board
  rather than planning it (see *features/operator-seat*).
- **Priority band** — the named scale for `kb.priority` (higher wins,
  default `0`): `0` unfiled · `1` normal · `2` next up · `3` urgent
  (`README.md`; `sortReady` in `src/model.js` does the actual sort, and does
  not enforce the band — a filer can still go above `3`).
- **Profile** — a harness adapter in `.kanban/board.json`: launch template, caps
  and heartbeat mode; `kb:agent:<profile>` says which one a task runs on. Not
  the model, the machine, or a person (`src/board.js`). Exactly one per card:
  the read is first-wins (`agentOf` in `src/model.js`), so every write goes
  through `setAgent` (`src/store/github.js`), which takes the old label off, and
  `hkb doctor` names any card still wearing two (`checkAgentLabels` in
  `src/doctor.js`).
- **Seat** — one of the three roles the protocol has: operator, dispatcher,
  worker. Every other word (reviewer, profile, host, supervisor, track runner)
  is vocabulary, not a seat
  (`skills/kanban/references/protocol.md`; `decisions/adr-004-roles-and-adoption`).
- **Stale pid file** — one whose mtime predates the machine's last boot
  (`Date.now() - os.uptime()*1000`): the pid it names has been reissued to a
  stranger, so it counts as no claim at all rather than as a running process —
  which is what keeps `hkb down` from signalling one after a reboot
  (`pidFileStale` in `src/model.js`; see *features/up-and-down*).
- **Supervisor** — whatever restarts a dispatcher that exited 4: cron, systemd,
  Actions, or the operator. It restarts a process; it decides nothing
  (`src/dispatch.js`). `hkb up` *starts* a dispatcher and reports an exit 4, but
  is not a supervisor: it never restarts anything (`src/up.js`).
- **Tick** — one pass of the dispatcher loop: re-read the board, derive every
  action from it, hold nothing durable in the process (`src/dispatch.js`).
- **Track** — a DAG subgraph executed by one session, claimed at its root; that
  session is an **orchestrator** — it claims a wave and hands each node to its
  own isolated subagent rather than working them itself (`resolveTrack`,
  `trackContext` in `src/track.js`; `features/tracks`). Which cards are tracks is
  inferred from the graph, not switched on: see **Track root**.
- **Track branch** — a track's own integration branch, `kb/track-<root>`
  (`trackBranchName`, `src/model.js`), created from the default branch at
  claim time (`ensureTrackBranch`, `src/store/github.js`) and recorded on the root's
  attempt row so a runner that dies never strands work nothing can find.
  Every node of the track branches from it and PRs into it, whatever its
  blockers; the root's own pass runs on it and opens the track's one PR into
  the default branch (`features/tracks`).
- **Track root** — a card with at least one unfinished child that nothing else on
  the board is still blocked by. It is dispatched as a track by default, on the
  board's track profile; `kb:agent:<a track profile>` forces one and
  `kb:no-track` opts out (`isTrackRoot`, `src/model.js`; `hkb track <n>`).
- **Wave** — one rank of a track: the nodes that depend on nothing else still
  left in it, so they can all run at once. `trackWaves` (`src/track.js`) splits a
  track into waves; wave 0 is the frontier.
- **Transcript** — the JSONL an agent session writes as it runs, recorded on the
  attempt row as `transcript_path` by the terminal verb (`sessionForAttempt` in
  `src/hook.js`, off the job record `currentSession` reads in `src/jobs.js`) —
  or, for an attempt that files no verb, by the dispatcher off the background
  job it matched (`jobSessionUpdate` in `src/jobs.js`).
  A file on the host that ran the attempt, never board state — and hkb's last
  answer to "what did this cost" when the harness reported none
  (`usageFromTranscript` in `src/stats.js`).
- **Job record** — what Claude Code keeps for a background agent at
  `~/.claude/jobs/<id>/state.json`: the session it is running and the transcript
  that session writes. A `claude --bg` worker's only local way to name itself,
  and the tick's only way to name it from outside (`src/jobs.js`).
- **Worker** — the seat that codes: one session holding one attempt on one task
  — any harness a profile has a `launch` array for, or the operator running the verbs by hand
  (`src/lifecycle.js`).
- **Worker identity** — the answer to "which attempt is this session?": the
  launch environment (`KB_TASK`…), else the `kb-<n>-<k>` checkout — and, when the
  two disagree, the checkout, because an environment can be inherited and a
  directory cannot (`attemptIdentity` in `src/model.js`, `whichAttempt` in
  `src/hook.js`; see *concepts/worker-identity*).
- **Control plane** — hkb read as Kubernetes reads itself: the store is etcd, a host running the dispatcher loop is a node, the tick is kubelet + scheduler + controller-manager in one loop, a board is a namespace, a card a Job, an attempt a Pod (*decisions/adr-005-control-plane*; design in `docs/local-first.md` §2).
- **Store** — the board's state behind one interface (`openStore`, `src/store/index.js`; the names are `docs/local-first.md` §6.4). Two drivers: the **local** one (`src/store/local.js`, the default for a new board — the `refs/kb/boards/<slug>` ref plus the `.git/hkb/index.db` index, composed) and the **GitHub** one (`src/store/github.js`, which the `src/tasks.js` and `src/lock.js` shims re-export; nothing in `src/` imports those shims — every verb goes through `openStore`). `storeKind(ctx)` picks on one input: `store` in `.kanban/board.json` (absent means `github`); a board ref in the checkout is deliberately not consulted (*architecture/store-seam*, *architecture/local-store*, *decisions/adr-006-local-store*).
- **Owning host** — the one host `board.json` on the board's ref names as the board's writer. Every mutating verb refuses on any other with exit 2 naming `hkb init --take-over`; a clone reads freely (*architecture/local-store*, `docs/local-first.md` §6.2).
- **`hkb sync`** — push `refs/kb/boards/<slug>` to the remote (with the `+refs/kb/boards/*:refs/kb/remotes/<remote>/boards/*` refspec named on the command line, since a clone's config has none) and fast-forward the local ref from it, refusing anything that is not a fast-forward. The loop runs it after a tick that wrote, at most once a minute and silently when offline; `"sync": {"push": false}` in the board's `board.json` turns it off (*features/up-and-down*).
- **The board's ref** — the durable tier of a local board: `board.json`, `cards/<id>.json` and `runs/<id>.json` at `refs/kb/boards/<slug>` (`boardRef`, `src/store/git.js`), written with plumbing only (`hash-object`, a temporary `GIT_INDEX_FILE`, `write-tree`, `commit-tree`, `update-ref`) so no working tree is ever touched, and `update-ref <new> <expected-old>` is the compare-and-swap. Outside `refs/heads` on purpose — it never appears in `git branch` — which is why `hkb init`/`hkb sync` write a fetch refspec and `hkb doctor` checks it (*architecture/board-ref*, `docs/local-first.md` §6.2).
- **Store root** — the one directory every store driver agrees on: the common git dir's parent via `mainWorktree`, never `--show-toplevel`, so a worker's linked worktree and the main checkout open the same board (`storeRoot`, `src/board.js`).
- **Forge** — the pull-request half, deliberately outside the store (`src/forge.js`): a board kept locally still opens its work on GitHub, so PR reads, auto-merge, branch protection and the merge mutation go on calling `src/gh.js` whatever the store is (*architecture/store-seam*).
- **Suspended** — a card an operator's `hkb stop <n>` parked: it keeps its lane and the tick skips it until `hkb start <n>` (`kb.suspended`, *decisions/adr-005-control-plane*).
- **Bridge** — the later GitHub adapter that publishes board state to issues and pulls only forge state (PRs, merges) back; never a claim, a lock, an attempt or a pause (`docs/local-first.md` §8).
