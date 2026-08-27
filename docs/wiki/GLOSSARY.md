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
- **Card / task** — a GitHub issue on the board; "card" in kanban prose,
  "task" in code and JSON (`src/tasks.js`).
- **Claim** — an atomic take on a card: creating `refs/kb/locks/<n>/<k>`, the
  only CAS GitHub offers (`src/lock.js`).
- **Handoff** — the structured result comment a finishing worker leaves so its
  dependents (and humans) start informed (`src/model.js`).
- **Tick** — one pass of the dispatcher loop: re-read the board, derive every
  action from it, hold nothing durable in the process (`src/dispatch.js`).
- **Track** — a DAG subgraph executed by one session, claimed at its root;
  nodes are claimed as the runner reaches them (`src/dispatch.js`).
