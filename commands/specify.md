---
description: Rewrite one triage one-liner into a spec a cold worker can execute, then promote it
argument-hint: <issue-number>
---

Run **specify** on hkb task #$1.

The procedure is one section of the `kanban` skill, so that it lives in exactly one place. Read the
section titled `## /kanban:specify` in that skill's `SKILL.md` — `.agents/skills/kanban/SKILL.md` in a
repo where `hkb init` has run (`.claude/skills/kanban` is a link to it), or
`${CLAUDE_PLUGIN_ROOT}/skills/kanban/SKILL.md` when hkb came from the plugin — and follow it for #$1.

Two things that section states and this command will not restate differently: **print the body you
propose, and stop for a yes before you touch the issue**, and **keep the `<!-- kb: {...} -->` first
line intact** — `hkb` owns it.

If no issue number was given, run `hkb list --status triage` and ask which one.
