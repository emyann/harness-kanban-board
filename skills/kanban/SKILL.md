---
name: kanban
description: Work a hkb task from the GitHub Issues board — read the task with `hkb show`, work in the worktree, open a PR that closes the issue, and finish with exactly one terminal verb (complete / block / request-review). Use whenever KB_TASK is set, when asked to "work task #N", "pick up the next kanban task", or to create/link tasks on the board.
license: MIT
compatibility: Requires the `gh` CLI (authenticated) and `hkb` (npm hkb) on PATH. Works with Claude Code, GitHub Copilot CLI and Codex CLI.
metadata:
  author: hkb
  version: 0.2.0
allowed-tools: Bash(hkb *) Bash(gh pr *) Bash(gh issue view *) Bash(git *)
---

# kanban — the worker protocol

The board is GitHub Issues. A task is an issue with `kb:*` labels; its dependencies are GitHub issue dependencies
(`blocked by`). The dispatcher (`hkb dispatch`) claims a task by creating the git ref `refs/kb/locks/<n>/<attempt>`
and launches you with `KB_TASK`, `KB_ATTEMPT`, `KB_BOARD`, `KB_REPO` set. Everything you need to know about the task
comes from `hkb`; everything you report goes through `hkb`. See `references/protocol.md` for the data model.

## When you are the worker (KB_TASK is set)

1. `hkb show $KB_TASK --json` — title, body, `kb` settings, blockers, prior attempts, **parent task results**.
   Read the parent results before designing anything: they say what changed and what was not tested.
2. Stay in this worktree and on the current branch. Only touch the scope in `kb.paths` if it is set.
3. Long work: run `hkb heartbeat $KB_TASK` roughly every 10 minutes. It is a compare-and-swap on your lock ref —
   `hkb` advances `refs/kb/locks/<n>/<k>` by an empty commit with `git push --force-with-lease`, so it is free and
   writes nothing to the issue. Never push that ref yourself. If the lease is rejected the ref is no longer yours:
   `hkb` prints `LOCK_LOST` and exits **3**. Stop immediately — do not commit, do not push, do not call `complete`.
   The dispatcher reclaimed the task and a new attempt owns it. (Workers that cannot push refs — cloud tiers, with
   `"heartbeat": "comment"` on their profile — heartbeat by writing the run record instead, floored at 10 minutes;
   `hkb` falls back to that by itself when git cannot reach the remote, and says so.)
4. Commit in small, clear steps. Never `git push --force`. Before finishing: `git fetch origin && git rebase origin/<default>`,
   then run the project's lint and tests (see CLAUDE.md / AGENTS.md).
5. Push and open a **draft** PR whose body contains `Closes #$KB_TASK` and a real description:
   `gh pr create --draft --title "..." --body "Closes #$KB_TASK\n\n<what/why/how verified>"`.
6. Finish with **exactly one** terminal verb, then stop. Send the payload as one JSON object on stdin so no JSON
   has to survive your shell's quoting (recommended — a heredoc with no nested quotes):

   ```bash
   hkb complete $KB_TASK --from-stdin <<'EOF'
   {
     "summary": "What changed, written for the next worker. How it was verified. What is still risky.",
     "metadata": {
       "changed_files": ["src/a.js", "test/a.test.js"],
       "verification": ["npm run lint", "npm test"],
       "dependencies": [],
       "residual_risk": ["..."],
       "retry_notes": null
     },
     "artifacts": []
   }
   EOF
   ```

   If your harness has a file-write tool, write the pieces to files and point at them — no quoting at all:
   `hkb complete $KB_TASK --summary-file /tmp/kb-summary.md --metadata-file /tmp/kb-metadata.json`
   (`--metadata <path>` also reads a file when the value does not start with `{`). The inline
   `--summary ".." --metadata '{..}'` flags still work; per field, inline beats file beats stdin.
   - `hkb complete $KB_TASK ...` — done (or *review* while a PR is open). Stdin keys: `summary`, `metadata`, `artifacts`.
   - `hkb block $KB_TASK "<why>" --kind needs_input|dependency|capability|transient` — when you cannot proceed.
     `dependency` sends it back to *todo*; the others ask a human. Also `--reason-file <path>`, or stdin keys `reason`, `kind`.
   - `hkb request-review $KB_TASK --summary "..." [--reviewer <profile>]` — when a reviewer must look before it counts
     as done. Stdin keys: `summary`, `metadata`, `reviewer`.

Do not do work that belongs to other tasks. If you discover follow-up work, create it instead:
`hkb create "title" --body "..." --blocked-by $KB_TASK` (it starts in *todo* and becomes *ready* when this task is done).

## When a human asks you to manage the board

- `hkb list` / `hkb show <n>` / `hkb log <n>` — read.
- `hkb create "title" [--blocked-by 12,13] [--agent claude] [--priority N] [--paths apps/web/]` — add work.
  Decide before you fan out: put design decisions in the body; children cannot see their siblings.
- `hkb link <parent> <child>` / `hkb unlink` — dependencies (same board only).
- `hkb promote <n>` (triage → todo, or force ready) · `hkb unblock <n>` · `hkb request-changes <n> "reason"` · `hkb archive <n>`.
- `hkb dispatch --dry-run` shows what the next tick would do; `hkb dispatch --loop 60` runs it.

## Rules

- One terminal verb per attempt. No verb = protocol violation = the attempt is retried and eventually parked for a human.
- Summaries are for the *next* worker: what changed, how it was verified, what is still risky.
- Never edit the `<!-- kb-run -->` or `<!-- kb-result -->` comments by hand; `hkb` owns them.
