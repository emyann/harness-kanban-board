## If you are an hkb worker

You were launched by hkb with a brief and a git worktree of your own, and the machinery already told you the rest:
the sandbox contract is in `src/brief.ts` — commit on your branch, rebase onto your base, push that branch and
nothing else — and it is exactly what the controller and a `pre-push` hook refuse on afterwards. The step after
it, the draft pull request a human reviews and merges, came with your brief from
`.hkb/workflows/implement.md`, this board's default workflow, because that part is a step's content and not hkb's.

## Project wiki (LLM-maintained)

Before working on a feature, change, or investigation, consult the
code-derived wiki at `docs/wiki/` — start at `index.md`. It is an orientation
layer: use it to learn *where to look* and *why*, then verify specifics
against the code — code is always the source of truth. Schema and authoring
rules: `docs/wiki/AGENTS.md`. When a change alters behaviour covered by a
wiki page, update that page as part of the task (`node .repolore/scripts/wiki-check.mjs`
shows what went stale); **new feature → new page**.
