---
title: The denied-tools ledger
summary: Under --permission-mode dontAsk a denial is never a prompt, just a silent workaround — the ledger reads a worker's transcript for the three shapes a refusal takes and turns the worst one into the exact allowed_tools edit.
category: features
kind: explanation
audience: [dev, ops]
read_when: "touching denied_tools, permission_denials, hkb show/stats/doctor's denial reporting, or the two transcript-only denial shapes (dontask-miss, worktree-guard)"
covers:
  - path: src/model.js
    sha: da2e9819afadb0fdda2c95fb3e6750bda727e207
  - path: src/stats.js
    sha: 8dd6c0032f972f3eb3fbf6e0dde4c01257765c0b
  - path: src/hook.js
    sha: c7f5ce80b8a0ccfe64b2c4eda3f9b95db343b490
  - path: src/dispatch.js
    sha: 4c660ef30b45b404c5744c55f30488afe1b20178
  - path: src/doctor.js
    sha: 3d52c57a00096587f6c374f99c36567a2db205d8
  - path: src/init.js
    sha: 1e75c0d47cc9a5441400e7d36da394a6a0e1551a
related: [concepts/worker-identity, features/operator-seat, gotchas/long-lived-process-rot]
generated_at_commit: d1d460e
last_refreshed: 2026-09-01
---

# The denied-tools ledger

> Workers run with `--permission-mode dontAsk`: an unlisted tool is denied,
> never prompted for. A denied worker does not stop — it finds a workaround.
> Measured on one board before this shipped: 208 native denials across 56 of
> 71 attempts, zero of which ended the attempt. #130 is the ledger that makes
> those denials visible instead of silently routed around.

## Three shapes, one field

`denied_tools` (`{tool, kind, count, first_seen}[]`, `DENIAL_KINDS` in
`src/model.js`) is the merge of everything a worker's own attempt can refuse:

- **`permission-rule`** — a `--disallowedTools` rule. The CLI's own
  `-p --output-format json` result names this outright as `permission_denials`
  (landed separately by #155, read in `parseSessionLog`,
  `src/model.js:1251-1272`) — no transcript read needed, and no per-item
  timestamp either.
- **`dontask-miss`** — *"Permission to use \<tool\> has been denied because
  Claude Code is running in don't ask mode"*: an allowlist miss (a heredoc, a
  `$(…)` substitution, an MCP tool nobody added to `allowed_tools`). This is a
  `tool_result` block in the transcript, absent from `permission_denials`.
- **`worktree-guard`** — the worktree guard's *"…can't be verified to stay
  inside the worktree"*. Also a `tool_result`, but an **error** one — same
  transcript shape as the miss, different regex
  (`skills/kanban/references/protocol.md:388-393` documents the exact wording
  a worker sees for both).

`parseTranscriptDenials` (`src/stats.js`) reads a transcript once for the two
shapes only a transcript carries: one pass keeps a small `tool_use_id → name`
map as it walks assistant messages, because a `tool_result` only carries the
id, never the tool's own name (the same trick `permission_denials` needs
`tool_use_id` for). `buildDeniedTools` (`src/model.js`) merges that with
whatever `permission_denials` the row already has, grouped by tool+kind so a
tool refused two different ways is two rows, not one.

## Where the read happens: attempt end, or reap — never a `hkb show`

Consistent with `usageFromTranscript`'s "bonus, not truth" doctrine
(`src/stats.js:645-655`), a transcript is read from local disk exactly where
it is already being read for something else, never on demand from `hkb show`
or `hkb stats`:

- **The Stop hook** (`writeSession`, `src/hook.js`) is the one moment
  guaranteed to have the transcript on disk *and* be the natural end of the
  worker's own turn — it fires as the model tries to end its turn, which is
  late enough to have caught most of a run's denials already. It is also
  "write once" by the same marker mechanism that already governs `session_id`
  (`pendingTargets`, `src/hook.js:297-312`): once the owner's own marker file
  exists, `writeSession` never runs for that owner again. A later, more
  complete read (dispatch, below) simply supersedes it — `deniedToolsUpdate`
  (`src/model.js`) only writes when the ledger changed by value.
- **The dispatcher**, for the two `parseSessionLog`/`sessionUpdate` sites that
  already backfill session fields onto a crashed or timed-out pid-mode
  attempt (`src/dispatch.js`, `attachDeniedTools` beside them) — the case a
  Stop hook never got to fire because the process died first.

> TODO-VERIFY: a `--bg` job reaped by `reapDecision` (`src/dispatch.js:401`)
> after its card closes has no equivalent second pass here — coverage there
> relies on the Stop hook having already fired when the worker filed its
> terminal verb. Not wired as part of #130; worth confirming before relying on
> completeness for a `--bg` attempt whose Stop hook never ran at all.

## Surfaces — and the one that could not ship here

- **`hkb stats`** — `summarizeDeniedTools` (`src/stats.js`) aggregates
  `denied_tools` across every attempt row in the window and `formatStats`
  prints a `denied` line: "tools workers wanted and could not use", folding an
  MCP server's tools to its wildcard (`denialDisplayTool`, `src/model.js`) so
  `mcp__react-aria__Button ×4` and `mcp__react-aria__Dialog ×3` read as one
  server denied seven times, not two tools.
- **`hkb doctor`** — `checkDeniedTools` (`src/doctor.js`) samples run records
  the same way `checkSessions` does (open board + recently-closed, newest
  first, capped at `SESSION_SAMPLE`) and turns the single most-denied tool
  into the exact fix: `dontask-miss` → add it to `allowed_tools`;
  `permission-rule` → remove it from `disallowedTools` on the launch (a
  different edit — the allowlist never reaches a `--disallowedTools` rule);
  `worktree-guard` → no fix at all, stated plainly, since no board.json edit
  reaches a structural guard.
- **MCP visibility, off the same sample.** A repo `.mcp.json` server may never
  load under a `--bg dontAsk` daemon at all — wrong cwd, a daemon started
  before the file existed — which leaves the ledger empty for the wrong
  reason: nobody denied the tool, it was never there to deny.
  `transcriptMcpServers`/`mcpServersFromTranscript` (`src/stats.js`) read the
  same sampled transcripts' `tool_use` blocks for `mcp__<server>__` calls, so
  this costs no extra read beyond the denied-tools sample itself.
  Since #254, before falling back to that generic reading, `checkDeniedTools`
  asks a more specific question of a server a profile actually grants: is it
  approved anywhere a worktree can see? `mcpVisibilityDiagnosis` (`src/model.js`)
  reads `.mcp.json`, the granting profile's `allowed_tools`, and the parsed
  contents of `.claude/settings.json`/`.claude/settings.local.json` —
  Claude Code's own `enabledMcpjsonServers`/`enableAllProjectMcpServers`
  switch — and returns one of three: `local-only` (approved only in the
  gitignored per-developer file, which a worktree never receives — the fix
  names the exact line and tells the operator to move it into the tracked
  file), `unapproved` (granted but approved nowhere hkb can see), or `unused`
  (already approved in the tracked file, so the worktree genuinely had it —
  this is "there and unused", a different bug than "never approved", and gets
  no fix at all). Only when none of the three apply — the server was never
  even granted — does the check fall back to the old, undiagnosed wording.
  `hkb init` (`mcpSplitApprovals`, called from `src/init.js`) runs the same
  `local-only` diagnosis against whatever `.mcp.json` and settings files a
  repo already has, so the split is reported at setup too, before a worker
  ever runs. See [worker identity](../concepts/worker-identity.md#a-worktree-carries-no-developer-approvals-either-254)
  for the general rule this is one instance of: a worktree carries tracked
  files only, and none of the developer's own approvals.
- **`hkb show` and the serve drawer are NOT wired to this ledger.**
  `formatDeniedTools` (`src/model.js`) exists and is a straight drop-in for
  `cli.js`'s existing `formatDenials(a)` call — but `src/cli.js` and
  `src/serve.js` were claimed by a different in-flight card (#204) at the time
  #130 landed, and this card's own scope was pinned to
  `{dispatch.js, hook.js, stats.js, doctor.js, model.js}`. Since `serve.js`'s
  drawer payload already spreads the raw attempt object (`{...a, session:
  ..., resume: ...}`, `src/serve.js:452`), `denied_tools` reaches the drawer's
  JSON automatically once persisted — nothing renders it yet. Wiring `cli.js`
  and `web/index.html` is the follow-up.

## Related

- [hkb at a glance](../architecture/overview.md)
- [Worker identity and the leaked-environment class of bug](../concepts/worker-identity.md)
