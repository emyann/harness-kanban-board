---
title: 'ADR-NNN: Decision title (imperative, e.g. "Use blob SHAs as freshness anchors")'
summary: One line — the decision, not the context.
category: decisions
kind: decision
audience: [dev]
read_when: "changing or questioning X"
status: proposed          # proposed | accepted | superseded  (decision lifecycle, not freshness)
date: YYYY-MM-DD
supersedes: ~             # decisions/adr-NNN-... when replacing an older record
superseded_by: ~          # set on the OLD record when a new one replaces it
covers:
  - path: relative/path/to/affected/source.ts
    sha: RUN-wiki-stamp-TO-FILL
generated_at_commit: RUN-wiki-stamp-TO-FILL
last_refreshed: RUN-wiki-stamp-TO-FILL
related: []
---

# ADR-NNN: Decision title

## Context

What forces are at play — the problem, the constraints, what made this worth
deciding. Cite the code that exhibits the problem.

## Decision

What we decided, stated actively ("We will…").

## Consequences

What becomes easier, what becomes harder, what we accept as a trade-off.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
