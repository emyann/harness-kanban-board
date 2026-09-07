---
name: draft-wiki-page
description: Draft one planned page in the code-derived wiki
model: claude-opus-5
# 20 is the built-in, and it is not enough: of the four Jobs this workflow is reconstructed
# from (2026-09-06), the first stopped on `max_turns` at 20 having spent $1.56 and produced
# nothing. Reading a wiki page's sources is a lot of small tool calls before a word is written.
max-turns: 60
max-budget: 2
allow-tool: [Read, Grep, Glob, Write, Edit, Bash]
# The repository's own rules, in front of the brief, so this brief does not have to restate them.
guide: CLAUDE.md
plugin-dir: [.claude]
# The draft PR is still where a human merges. This is the earlier question: a page that does not
# earn its place costs a reviewer more than it costs to not write, and the answer is cheapest
# while the session is still open and can act on it.
gate: does this page earn its place, or is it restating what one grep would give?
---

Draft ONE new page in this repository's LLM-maintained wiki: `docs/wiki/{{page}}.md`. It is currently listed `status: planned` in `docs/wiki/wiki.config.yml` and does not exist yet. Draft only this page.

BEFORE ANYTHING ELSE, read `docs/wiki/AGENTS.md` in full. It is the contract a page is judged against: the distillation rule (if an agent can rediscover it in 30 seconds with one grep, it does not belong on the page), the citation discipline (every concrete claim carries an inline `path:lines` citation in backticks; anything you did not verify in the code is either dropped or prefixed `> TODO-VERIFY:`), the frontmatter schema, the rule that a page carries no task state, no checkboxes, no severity ranks and no remediation directives, and the fact that `index.md` is generated and `covers:` SHAs are never hand-computed. Start from `docs/wiki/_templates/page.md`.

WHAT THE PAGE MUST COVER. The one-line spine is the `summary:` already recorded against this page's entry in `docs/wiki/wiki.config.yml` — read it there rather than inventing one, and the page's own frontmatter `summary:` must end up agreeing with it. Beyond the spine:

{{cover}}

READ FIRST, IN THIS ORDER:

{{sources}}

Any line numbers you were given are hints from a scan, not facts: verify every one against the file before citing it, and cite what you found rather than what you were told.

WHAT WOULD MAKE THIS PAGE WRONG:

{{wrong}}

And the four that would make ANY page in this wiki wrong:
- Restating signatures, flag lists, field lists or line-by-line logic that one `--help` or one grep would give. Distil the argument; do not paste the code.
- Narrating runtime behaviour you have not read. If you did not verify it, drop it or mark it `> TODO-VERIFY:`.
- Duplicating a page that already owns the material. `architecture/the-board` owns the schema as a model and `architecture/the-loop` owns the reconcile pass — read both, and CROSS-LINK via `related:` instead of re-arguing them.
- Editing a decision record. ADRs are immutable-with-supersession; cross-link one in `related:` rather than changing it.

FINISHING, mechanically: fill `covers:` with every in-scope source file you actually made claims about (paths only — the SHAs are stamped, never hand-computed), then `node .repolore/scripts/wiki-stamp.mjs docs/wiki/{{page}}.md`. Point the `docs/wiki/GLOSSARY.md` lines this page now owns at it, and add a line for any term the page leans on or coins that has none — AGENTS.md: coin no term without recording it. Flip this page from `planned` to `seeded` in `docs/wiki/wiki.config.yml`. Append ONE line to `docs/wiki/log.md`. Run `node .repolore/scripts/wiki-index.mjs` and then `node .repolore/scripts/wiki-check.mjs` — the new page must report `fresh`. If reading the code surfaces a suspected code defect, append one `docs/wiki/FINDINGS.md` line in the same change using the grammar in AGENTS.md; a page that merely disagrees with the code is never a finding.

CONTEXT YOU SHOULD KNOW: hkb is a Node >= 22.18 ESM CLI in TypeScript that Node runs natively (no build step in a checkout) — it schedules agent work against one SQLite board per machine behind Prisma, running each Job in a git worktree cut from the mainline at claim time. Do not run any `hkb` command against the operator's board from a checkout: applying a feature branch's migrations to `~/.hkb/board.db` is a known one-way door (see the second item in `docs/wiki/FINDINGS.md`). You do not need to run hkb to write this page; read the code.

IF YOU ARE ONE OF SEVERAL Jobs drafting a page each, in parallel, from the same base: each of you will regenerate `docs/wiki/index.md` and touch `wiki.config.yml`, `GLOSSARY.md` and `log.md`. Regenerate the index anyway — it is generated, and whoever merges second re-runs the script. Keep your glossary and config edits minimal and alphabetically placed so the textual overlap stays small. `docs/wiki/gotchas/merge-composition.md` is the page about why that matters.
