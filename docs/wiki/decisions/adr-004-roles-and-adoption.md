---
title: 'ADR-004: Three seats — operator, dispatcher, worker'
summary: "hkb has exactly three seats (operator = the human, dispatcher = a tick, worker = any harness); the dispatcher is not an orchestrator, and adoption is a ladder of the same protocol driven by hand or by the tick."
category: decisions
kind: decision
audience: [dev]
read_when: "naming roles in docs or worker prompts, changing dispatch/reclaim behaviour, or designing the manual-mode adoption path"
status: proposed
date: 2026-08-27
supersedes: ~
superseded_by: ~
covers:
  - path: src/dispatch.js
    sha: b50d4bc34cd5bc68e3969bc0e300739c0eaafa73
  - path: src/context.js
    sha: 77ada2083b7d355f8de6ea824ca40bdaab1e712a
  - path: src/cli.js
    sha: 06800a9f1f5892805e1948676f9a9ebb49eb9169
  - path: src/lifecycle.js
    sha: 67b6fb458425948ce61d6a7a324649cb79e1c648
  - path: skills/kanban/SKILL.md
    sha: 1781bf889025d8a9d6db369233e219321836c549
  - path: skills/kanban/references/protocol.md
    sha: abe009ca27bf6cbb73db5ec7eac0c032b8ee7da5
generated_at_commit: 6c0e81f
last_refreshed: 2026-08-27
related: [concepts/roles-and-seats, architecture/overview, concepts/board-protocol]
---

# ADR-004: Three seats — operator, dispatcher, worker

## Context

hkb's docs and code grew one real coordination seat that no word owns: the
person who files cards, steers workers, reviews and merges PRs, answers
`kb:needs-human`, and restarts a dead loop is fragmented across **human /
operator / supervisor / reviewer / "you"** — `src/context.js:10` calls the
same author "a human" that `src/context.js:107` calls "the operator", and
"supervisor" in `src/dispatch.js` (exit code 4) means a *process restarter*
(cron/systemd sense), not a judgment seat. Meanwhile the first real adopter
question arrived: someone whose workflow is a roadmap.md and a human picking
stories by hand — no DAG, no dispatch — asked what adopting hkb even means.

A 7-agent evaluation (independent inventory, precedent research, persona
study, two designers, an adversarial reviewer, synthesis — every file:line
claim spot-checked against commit `6c0e81f`) produced this decision. It also
surfaced a live bug: `hkb claim` without `--spawn` writes `manual: true`
(`src/cli.js:419`) that nothing reads, so the reclaim chain
(`src/dispatch.js:438`) kills a live hand-claimed attempt after 180s — the
exact path manual-mode adoption depends on.

## Decision

**hkb has exactly three seats; everything else is glossary, not role.**

- **The operator is the human.** Owns the repo, the token, the scope; files
  and sharpens cards, steers via comments, reviews and merges, answers
  `kb:needs-human`, restarts a dispatcher that exited 4. An agent session may
  drive these verbs for them — approvals and credentials stay with the human.
  We will not split an "operator vs maintainer" pair: two nouns for one
  person, legislating for an agent-delegation seat that has zero shipped
  support.
- **The dispatcher is a tick, not an agent — and not an orchestrator.** It
  holds no workflow: the graph lives on the cards as issue dependencies; the
  loop only reconciles labels, locks and attempts against it. To the
  coding-agent audience "orchestrator" means the planning LLM; the tick's
  dumbness is hkb's frugality and safety property, and its name must
  advertise dumbness. "Supervisor" keeps its narrow process-restart meaning.
- **A worker is any harness; the track runner is a worker driving one
  subgraph.** "Reviewer" stays a per-card gate (always a GitHub user, never a
  seat); "profile" stays the harness adapter.

**Adoption is a ladder, not a migration.** Hand mode and autonomous mode are
the same protocol with a different dispatcher — you, or the tick. Rungs:
cards only → agent-obeys-the-protocol by hand (`hkb claim` → `hkb context` →
one terminal verb; the payoff rung) → explicit order (`--blocked-by`,
`hkb promote`) → `dispatch --loop` → tracks/fleet. We ship
`docs/manual-mode.md` plus an agent-assisted migration recipe ("paste your
roadmap.md, have your agent run `hkb create` per story") and build **no
`hkb import` parser** — a fixed markdown grammar mis-parses real roadmaps
(silent-failure class), and the name collides with shipped `init --import`.
Revisit only on demonstrated demand.

**Messaging order stands:** the autonomous three-command quickstart leads
(it proves the headline), a "drive it by hand" subsection follows. Automation
is a flag, not a migration.

## Consequences

- **Priority 1 (bug):** honor `manual` like `remote` in the reclaim chain —
  liveness by heartbeat/`stale_after` only, never the 180s no-pid rule
  (~3 lines in `src/dispatch.js` + a test). Manual mode is dishonest until
  this lands.
- **One small docs/strings PR:** exit code 4 added to the protocol and CLI
  help exit-code lists; `--reviewer <github-user>` (docs matched to
  `src/lifecycle.js:226-237`); "fake-gh harness" → "fake-gh test double" (4
  sites incl. the worker-facing deny message `src/model.js:434`);
  `src/context.js:10` "a human" → "the operator"; SKILL.md subtitle "worker
  protocol" → "board protocol"; "Actions runner" qualified; a protocol
  glossary (seat vs reviewer vs profile vs host vs track runner) and the
  reserved synthetic profile values `dispatcher`/`reviewer`/`human`.
- **Deliberately unchanged:** `dispatcher` and `worker` everywhere; the
  `kb:needs-human` label and `kb:agent:*` namespace (renames break live
  boards); attempt-history values; the README's "Humans get…" line — under
  this taxonomy the operator *is* the human, so it was already correct.
- Docs gain a "Who runs a board: the seats" section (final wording in the
  evaluation report, carried on the implementation cards).

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. -->
