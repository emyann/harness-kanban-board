## If you are an hkb worker

You were launched by hkb's controller with a brief and your own git worktree, already checked out on a branch named
`kb-<jobId>-<attempt>`. Work only in that worktree. Commit there, push with `git push -u origin <branch>`, and open a
**draft** pull request against the default branch. Never push to the default branch, never merge, and never
`git push --force`. A human reviews and merges. The exact protocol you were given is in `src/brief.ts`.

## Project wiki (LLM-maintained)

Before working on a feature, change, or investigation, consult the
code-derived wiki at `docs/wiki/` — start at `index.md`. It is an orientation
layer: use it to learn *where to look* and *why*, then verify specifics
against the code — code is always the source of truth. Schema and authoring
rules: `docs/wiki/AGENTS.md`. When a change alters behaviour covered by a
wiki page, update that page as part of the task (`node .repolore/scripts/wiki-check.mjs`
shows what went stale); **new feature → new page**.
