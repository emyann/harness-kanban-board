---
description: Split a goal issue into a dependency graph of tasks, and materialize it once a human approves
argument-hint: <issue-number>
---

Run **decompose** on hkb task #$1.

The procedure is one section of the `kanban` skill, so that it lives in exactly one place. Read the
section titled `## /kanban:decompose` in that skill's `SKILL.md` — `.agents/skills/kanban/SKILL.md` in
a repo where `hkb init` has run (`.claude/skills/kanban` is a link to it), or
`${CLAUDE_PLUGIN_ROOT}/skills/kanban/SKILL.md` when hkb came from the plugin — and follow it for #$1,
including the worked example it points at in `references/protocol.md`.

Two things that section states and this command will not restate differently: **propose the whole
graph and stop for a yes before anything is created**, and **materialize in the order it gives**
(root body, children parents-first, `hkb link`, `hkb promote` the root last).

If no issue number was given, run `hkb list --status triage` and ask which goal to split.
