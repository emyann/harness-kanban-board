# Harnesses

The board is labels, issue dependencies, refs and comments — no harness owns it. A *profile* in
`.kanban/board.json` is the whole adapter: a launch array, a few caps, and (for harnesses that need files on
disk) whatever `hkb init --harness <name>` generates. This page is the per-harness detail: what runs, what
`init` writes, and the one-time setup only you can do.

| profile | harness | worktree | stop nudge | structured output | `hkb init --harness` |
| --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code background agent | `claude --worktree` | `Stop` hook in `.claude/settings.json` | attempt cost + session id from the job | — (plain `hkb init`) |
| `claude-p` | Claude Code headless | `claude --worktree` | same | `--output-format json` | — |
| `copilot-cli` | GitHub Copilot CLI | dispatcher (`git worktree add`) | `agentStop` hook in `.github/hooks/kanban.json` | none | `copilot` |
| `codex` | OpenAI Codex CLI | dispatcher (`git worktree add`) | `Stop` hook in `.codex/hooks.json` | `--output-schema` | `codex` |

Whatever the harness, the protocol is the same: claim the lock ref, work in the worktree, open a draft PR that
says `Closes #<n>`, finish with exactly one terminal verb. The `hkb` verb the worker runs is always the source of
truth — structured output and stop nudges are safety nets, not the record.

## What a profile looks like

```jsonc
"codex": {
  "mode": "process",              // "process" (exits when done) or "claude-bg" (background agent daemon)
  "workspace": "worktree",        // the dispatcher makes .claude/worktrees/kb-<n>-<k>; omit if the CLI does it
  "heartbeat": "auto",            // "ref" (CAS on the lock ref) · "comment" · "auto"
  "max_in_progress": 1,
  "model": null,                  // per-profile default; a task's `model` wins
  "allowed_tools": null,          // per-command allowlist, for harnesses that have one
  "launch": ["codex", "exec", "-C", "{worktree}", "..."]
}
```

Placeholders in `launch`: `{n}` `{k}` `{slug}` `{title}` `{board}` `{repo}` `{model}` `{prompt}`, and
`{worktree}` — the absolute path of the checkout the dispatcher is about to create for this attempt (the board
root for profiles without `workspace: "worktree"`). `{model_args}` expands to `--model <m>` or to nothing;
`{allowed_tools}` splices the list in, and `--flag={allowed_tools}` repeats `--flag <entry>` per entry.
Nothing else is interpolated, so a launch array is safe to read and safe to edit.

## Claude Code — `claude`, `claude-p`

`hkb init` is all it takes: the skill lands in `.agents/skills/kanban` (linked from `.claude/skills/kanban`) and
the `Stop` + `PreToolUse` hooks go into `.claude/settings.json`. `claude` runs each worker as a background agent
(`claude --bg`, visible in `claude agents`, attachable with `claude attach <job>`); `claude-p` is the headless
variant for CI and containers. Both isolate themselves with `--worktree kb-<n>-<k>`.

## GitHub Copilot CLI — `copilot-cli`

```bash
hkb init --harness copilot
hkb doctor
```

Generates `.github/agents/kanban-worker.agent.md` (selected by `copilot --agent kanban-worker`; its body is
spliced out of `skills/kanban/SKILL.md`) and `.github/hooks/kanban.json` (an `agentStop` hook running
`hkb hook stop`). Copilot CLI has no worktree flag, so the dispatcher makes the checkout. Permissions are
per-command: `--allow-tool 'shell(hkb:*)'` and friends, with `git push --force` denied at launch.

## OpenAI Codex CLI — `codex`

```bash
npm i -g @openai/codex        # or: brew install codex
hkb init --harness codex      # profile + .codex/hooks.json + .codex/README.md
hkb doctor                    # codex on PATH · profile · generated files · the schema the launch names
```

Each attempt runs

```bash
codex exec -C <worktree> --sandbox workspace-write \
  --output-schema .agents/skills/kanban/schema/terminal.json "<task context>"
```

in `.claude/worktrees/kb-<n>-<k>` on branch `kb-<n>-<k>`, which the dispatcher creates with `git worktree add`
before the launch (Codex has no worktree flag of its own). Flag by flag:

- **`exec`** — the non-interactive mode: one prompt, no TUI, exits when the turn ends.
- **`-C <worktree>`** — the working directory. It is also the process cwd, so the two can never disagree.
- **`--sandbox workspace-write`** — the whole permission policy: the worktree is writable, the rest of the
  filesystem is read-only. There is no per-command allowlist to maintain, which is why the profile leaves
  `allowed_tools` null. See the sandbox notes below — the defaults are stricter than a worker needs.
- **`--output-schema …/terminal.json`** — the final message has to match hkb's terminal-outcome schema
  (`task`, `verb`, `summary`, optional `metadata`). It is a mirror for post-mortems, not the record: the
  `hkb complete|block|request-review` call the worker made is what moved the card. The path is relative to the
  worktree, so the skill has to be **committed** — `hkb doctor` fails loudly if the file is not there.
- **`--model`** — added only when the task or the profile sets one.

`max_in_progress` defaults to 1. Raise it in `board.json` once you know what a Codex worker costs you.

### One-time trust — nothing runs until you do this

Codex will not execute hooks from a project it has not been trusted with, and the sandbox flag does not imply
trust. Once per machine and repo, either:

1. Run `codex` in the repo and use the **`/hooks`** command to review what `.codex/hooks.json` declares and trust
   it. This is also the fastest way to confirm Codex sees the file at all.
2. Or mark the project trusted in `~/.codex/config.toml` (`$CODEX_HOME/config.toml` if you moved it):

   ```toml
   [projects."/absolute/path/to/your/repo"]
   trust_level = "trusted"
   ```

`hkb init --harness codex` writes the same two steps into `.codex/README.md` with your repo's real path filled
in, so a teammate cloning the repo has the instructions in front of them.

### Sandbox settings a worker needs

`workspace-write` is stricter than a kanban worker can live with, and the fix belongs in `~/.codex/config.toml`
— Codex reads config from `$CODEX_HOME`, never from `.codex/` in the repo, so hkb cannot write it for you:

```toml
[sandbox_workspace_write]
# `gh`, `git push` and the lock-ref heartbeat all need the network
network_access = true
# a worktree's git metadata lives in the main repo, outside the worker's cwd
writable_roots = ["/absolute/path/to/your/repo/.git"]
```

Without the network the worker can edit files but cannot push a branch, open the PR or heartbeat — the
dispatcher then reclaims the attempt as stale, every time. Without the `.git` writable root, `git commit` inside
the worktree can be refused by the sandbox.

No `[mcp_servers]` table is generated. hkb workers call the `hkb` CLI directly, so there is nothing to connect;
if you add MCP servers of your own they go in the same user-level config.

### Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| worker stops mid-task, no terminal verb, no nudge | project hooks not trusted | the one-time trust above |
| every attempt fails instantly | `--output-schema` path missing from the checkout | commit `.agents/skills/kanban/`; `hkb doctor` |
| attempts always reclaimed as stale | no network in the sandbox | `network_access = true` |
| commits fail inside the worktree | `.git` is outside the writable root | add it to `writable_roots` |
| `hkb doctor` warns "codex harness missing …" | generated files removed or never written | `hkb init --harness codex` |

### Sources, and what to re-check

The Codex behaviour above follows the design in [EVALUATION.md](EVALUATION.md) and the documentation below.
It has *not* been re-checked against a running `codex` — the worker that wrote this page had neither network
access nor the CLI installed — so treat the four external facts (hook file shape, event name, trust flow,
sandbox keys) as "documented, unverified here":

- hooks (events, config file, `decision: block`, the `/hooks` trust flow) — <https://learn.chatgpt.com/docs/hooks>
- `codex exec`, `--sandbox`, `--output-schema` — <https://github.com/openai/codex> and `codex exec --help`
- `config.toml` (`projects.*.trust_level`, `[sandbox_workspace_write]`) —
  <https://github.com/openai/codex/blob/main/docs/config.md>

Codex ships fast. If a flag or a key has moved, the blast radius is deliberately small: the launch array is the
`codex` profile in `src/board.js`, the hook shape is `templates/codex/hooks.json`, and the setup prose is
`templates/codex/notes.md`. Nothing in `src/` parses any of it. Run `codex exec --help` and `/hooks` once on
your machine before trusting this page over your own CLI.

## Adding a harness that has no built-in profile

Add a `launch` array under `profiles` in `.kanban/board.json` and give tasks `kb:agent:<profile>`; that is the
entire integration. Set `workspace: "worktree"` if the CLI cannot make its own checkout, and
`"heartbeat": "comment"` if it cannot push refs. If the harness also needs files in the repo (an agent
definition, a hook config), add a `templates/<harness>/` directory and an entry in `HARNESS_FILES` in
`src/init.js` — `hkb init --harness <name>`, `hkb doctor` and the tests pick it up from there.
