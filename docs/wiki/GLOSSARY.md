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
- **Card / task** — a GitHub issue on the board; "card" in kanban prose,
  "task" in code and JSON (`src/tasks.js`).
- **Claim** — an atomic take on a card: creating `refs/kb/locks/<n>/<k>`, the
  only CAS GitHub offers (`src/lock.js`).
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
- **Handoff** — the structured result comment a finishing worker leaves so its
  dependents (and humans) start informed (`src/model.js`).
- **Host** — machine identity, recorded per attempt, so the tick only checks a
  pid on the machine that owns it (`src/dispatch.js`).
- **Operator** — the human seat: owns the repo, the token and the scope; files
  cards, steers by comment, reviews and merges, answers `kb:needs-human`,
  restarts a dispatcher that exited 4. "you", in a worker prompt
  (`decisions/adr-004-roles-and-adoption`).
- **Planning command** — `/kanban:specify` or `/kanban:decompose`: a harness slash
  command rather than an `hkb` verb, because both need a model and the dispatcher
  has none. One source in `commands/`, registered by the plugin and by `hkb init`
  (`src/init.js`; see *features/planning-commands*).
- **Profile** — a harness adapter in `.kanban/board.json`: launch template, caps
  and heartbeat mode; `kb:agent:<profile>` says which one a task runs on. Not
  the model, the machine, or a person (`src/board.js`). Exactly one per card:
  the read is first-wins (`agentOf` in `src/model.js`), so every write goes
  through `setAgent` (`src/tasks.js`), which takes the old label off, and
  `hkb doctor` names any card still wearing two (`checkAgentLabels` in
  `src/doctor.js`).
- **Seat** — one of the three roles the protocol has: operator, dispatcher,
  worker. Every other word (reviewer, profile, host, supervisor, track runner)
  is vocabulary, not a seat
  (`skills/kanban/references/protocol.md`; `decisions/adr-004-roles-and-adoption`).
- **Supervisor** — whatever restarts a dispatcher that exited 4: cron, systemd,
  Actions, or the operator. It restarts a process; it decides nothing
  (`src/dispatch.js`).
- **Tick** — one pass of the dispatcher loop: re-read the board, derive every
  action from it, hold nothing durable in the process (`src/dispatch.js`).
- **Track** — a DAG subgraph executed by one session, claimed at its root;
  nodes are claimed as the runner reaches them (`src/dispatch.js`).
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
  — any harness, an Actions job, or the operator running the verbs by hand
  (`src/lifecycle.js`).
- **Worker identity** — the answer to "which attempt is this session?": the
  launch environment (`KB_TASK`…), else the `kb-<n>-<k>` checkout — and, when the
  two disagree, the checkout, because an environment can be inherited and a
  directory cannot (`attemptIdentity` in `src/model.js`, `whichAttempt` in
  `src/hook.js`; see *concepts/worker-identity*).
