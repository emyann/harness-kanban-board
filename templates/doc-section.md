## Kanban (hkb)

Tasks are cards on the board's git ref (`refs/kb/boards/<name>`) in this repository. If `KB_TASK` is set you are a worker: run
`hkb show $KB_TASK --json` first, work only in this worktree, open a draft PR **on this worktree's own branch**
(`kb-$KB_TASK-<attempt>` — the branch name is the only thing that ties a PR to its card), and finish with
**exactly one** of
`hkb finish <n> --summary "..."`, `hkb block <n> "why" --kind needs_input`, or `hkb request-review <n> --summary "..."`.
(`finish` is `complete` under a name no shell claims — `complete` is a bash builtin, and a harness that vets your
command line word by word will refuse it. Redirect a file rather than using a heredoc, for the same reason.)
Never `git push --force`. Full protocol: `.agents/skills/kanban/SKILL.md`.
