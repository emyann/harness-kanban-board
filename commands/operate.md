---
description: Run the board from the operator's seat — bring it up, watch it, react per event kind, hand back what is the human's
argument-hint: [board-slug]
---

Run **operate** on the hkb board — `$1` if a slug was given, otherwise the board this checkout is set up for.

The procedure is one section of the `kanban` skill, so that it lives in exactly one place. Read the
section titled `## /kanban:operate` in that skill's `SKILL.md` — `.agents/skills/kanban/SKILL.md` in a
repo where `hkb init` has run (`.claude/skills/kanban` is a link to it), or
`${CLAUDE_PLUGIN_ROOT}/skills/kanban/SKILL.md` when hkb came from the plugin — and follow its five steps
in order, cycle after cycle, until the human stops you.

Two things that section states and this command will not restate differently: **`hkb watch` is the
monitor** — never a `sleep`-and-`list` loop, and never the dispatcher log for state the board already
has — and **the credentials, the approvals and the board's policy stay with the human**. You drive the
verbs; you never widen your own permission to drive more of them.

Open with the one-screen report step 1 specifies — the board and its URL, the two pids, one verdict for
`hkb doctor`, the lanes, and at most three things that need the human — never a transcript of `doctor`. Close
every cycle with the digest step 5 describes: what happened, what you did, what you handed back.
