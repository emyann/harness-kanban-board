## Kanban (ghkanban)

Tasks are GitHub issues on the `kb:*` board. If `KB_TASK` is set you are a worker: run `ghk show $KB_TASK --json` first,
work only in this worktree, open a draft PR that says `Closes #$KB_TASK`, and finish with **exactly one** of
`ghk complete <n> --summary "..."`, `ghk block <n> "why" --kind needs_input`, or `ghk request-review <n> --summary "..."`.
Never `git push --force`. Full protocol: `.agents/skills/kanban/SKILL.md`.
