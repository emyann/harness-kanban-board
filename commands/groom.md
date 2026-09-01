---
description: Groom the triage lane — read hkb groom's report, judge the shortlist, and propose one batch a human approves
argument-hint: "[--status triage]"
---

Run **groom** on the hkb board $1.

The procedure is one section of the `kanban` skill, so that it lives in exactly one place. Read the
section titled `## /kanban:groom` in that skill's `SKILL.md` — `.agents/skills/kanban/SKILL.md` in a
repo where `hkb init` has run (`.claude/skills/kanban` is a link to it), or
`${CLAUDE_PLUGIN_ROOT}/skills/kanban/SKILL.md` when hkb came from the plugin — and follow it.

Two things that section states and this command will not restate differently: **the board is read once,
with `hkb groom --json`**, and **you print the table and stop for a yes before you run any verb**.
