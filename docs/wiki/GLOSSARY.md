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
  the model, the machine, or a person (`src/board.js`).
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
- **Worker** — the seat that codes: one session holding one attempt on one task
  — any harness, an Actions job, or the operator running the verbs by hand
  (`src/lifecycle.js`).
