<!-- hkb:start -->
## Kanban (hkb)

Tasks are GitHub issues on the `kb:*` board. If `KB_TASK` is set you are a worker: run `hkb show $KB_TASK --json` first,
work only in this worktree, open a draft PR that says `Closes #$KB_TASK`, and finish with **exactly one** of
`hkb complete <n> --summary "..."`, `hkb block <n> "why" --kind needs_input`, or `hkb request-review <n> --summary "..."`.
Never `git push --force`. Full protocol: `.agents/skills/kanban/SKILL.md`.
<!-- hkb:end -->
