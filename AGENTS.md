<!-- hkb:start -->
## Kanban (hkb)

Tasks are GitHub issues on the `kb:*` board. If `KB_TASK` is set you are a worker: run `hkb show $KB_TASK --json` first,
work only in this worktree, open a draft PR that says `Closes #$KB_TASK`, and finish with **exactly one** of
`hkb complete <n> --summary "..."`, `hkb block <n> "why" --kind needs_input`, or `hkb request-review <n> --summary "..."`.
Never `git push --force`. Full protocol: `.agents/skills/kanban/SKILL.md`.
<!-- hkb:end -->

## Project wiki (LLM-maintained)

Before working on a feature, change, or investigation, consult the
code-derived wiki at `docs/wiki/` — start at `index.md`. It is an orientation
layer: use it to learn *where to look* and *why*, then verify specifics
against the code — code is always the source of truth. Schema and authoring
rules: `docs/wiki/AGENTS.md`. When a change alters behaviour covered by a
wiki page, update that page as part of the task (`node .repolore/scripts/wiki-check.mjs`
shows what went stale); **new feature → new page**.
