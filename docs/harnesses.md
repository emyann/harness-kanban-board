# Harnesses

The board is labels, issue dependencies, refs and comments — no harness owns it. A *profile* in
`.kanban/board.json` is the whole adapter: a launch array, a few caps, and (for harnesses that need files on
disk) whatever `hkb init --harness <name>` generates. This page is the per-harness detail: what runs, what
`init` writes, and the one-time setup only you can do.

| profile | harness | worktree | stop nudge | structured output | `hkb init --harness` |
| --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code background agent | `claude --worktree` | `Stop` hook in `.claude/settings.local.json` | attempt cost + session id from the job | — (plain `hkb init`) |
| `claude-p` | Claude Code headless | `claude --worktree` | same | `--output-format json` | — |
| `copilot-cli` | GitHub Copilot CLI | dispatcher (`git worktree add`) | `agentStop` hook in `.github/hooks/kanban.json` | none | `copilot` |
| `codex` | OpenAI Codex CLI | dispatcher (`git worktree add`) | `Stop` hook in `.codex/hooks.json` | `--output-schema` | `codex` |
| `claude-action` | Claude Code in GitHub Actions | the Actions runner's own checkout | a final `if: always()` step | none | `hkb init --with-actions` |

Whatever the harness, the protocol is the same: claim the lock ref, work in the worktree, open a draft PR that
says `Closes #<n>`, finish with exactly one terminal verb. The `hkb` verb the worker runs is always the source of
truth — structured output and stop nudges are safety nets, not the record.

## What a profile looks like

```jsonc
"codex": {
  "mode": "process",              // "process" (exits when done) · "claude-bg" (background agent daemon)
                                  // · "trigger" (the launch only *starts* work elsewhere and exits)
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

## Which profiles a board gets

`hkb init` writes exactly the profiles you named, and one `kb:agent:<profile>` label for each:

```bash
hkb init                                  # profiles: claude          (11 kb:* labels)
hkb init --profiles claude,claude-track   # profiles: claude, claude-track
hkb init --harness codex                  # profiles: codex           — the harness brings its own
hkb init --profiles claude --harness codex --with-actions   # claude, codex, claude-action
```

The six built-ins (`claude`, `claude-track`, `claude-p`, `claude-action`, `copilot-cli`, `codex`) are *templates*,
not a starter pack: a Claude-only repo has no reason to carry a `kb:agent:codex` label or a `hkb doctor` that warns
forever about a CLI it will never install.

Re-running init on an existing board only **adds**. It never removes a profile, and never overwrites one — a
`max_in_progress` you tuned or a `launch` you wrote by hand survives every re-run, and so does a profile of your own
that has no built-in at all. To add one later: `hkb init --profiles claude-track`. To drop one: delete it from
`.kanban/board.json` (and the `kb:agent:<name>` label from the repo, if nothing wears it). A task labelled for a
profile the board does not have is skipped by the tick with `unknown profile <name>` and the command that fixes it.

## Claude Code — `claude`, `claude-p`

`hkb init` is all it takes: the skill lands in `.agents/skills/kanban` (linked from `.claude/skills/kanban`) and
the `Stop` + `PreToolUse` hooks go into `.claude/settings.local.json`. `claude` runs each worker as a background agent
(`claude --bg`, visible in `claude agents`, attachable with `claude attach <job>`); `claude-p` is the headless
variant for CI and containers. Both isolate themselves with `--worktree kb-<n>-<k>`.

### Which settings file the hooks go in

`.claude/settings.local.json`, by default — the per-developer file, which `hkb init` adds to `.gitignore`. The
reason is that the command in there names *this* machine: a plain `hkb` when it is on PATH, and otherwise an
absolute path into wherever this package was installed. Neither is true in a teammate's checkout, and both hooks
use `matcher: "*"`, so a command that does not resolve fails on **every tool call in every session** in that repo
— noise nobody there wrote or can explain. (Both hooks are still inert unless `KB_TASK` is set; nothing
misbehaves, it just fails loudly.)

`hkb init --shared-hooks` puts them in the tracked `.claude/settings.json` instead — for a team where everyone
runs `npm i -g hkb-cli`. That file only ever gets the portable form, `hkb hook stop` / `hkb hook pretool`; an
absolute path is never written into a file other people read. `hkb doctor` checks whatever is configured, in
either file, and fails when the command cannot be resolved here:

```
✗ hook command    hkb hook stop — `hkb` is not on PATH here; the hook fails on every tool call in this repo
                    → npm i -g hkb-cli (or: hkb init, which writes a command that resolves here)
```

The hooks live in exactly one of the two files: init moves them rather than leaving a second copy, since two
would fire every nudge twice. A re-run leaves a shared, portable setup where it is — but hooks in the tracked
file naming a path get moved to the local one, and an `npx` cache path (never durable: it is gone the next time
npm cleans that cache) is rewritten wherever it is found.

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

No `[mcp_servers]` table is generated by `--harness codex` either: hkb workers call the `hkb` CLI directly, so
nothing has to be connected. If you would rather drive the board through tools, `hkb init --mcp` prints the
`mcp_servers.kanban` snippet to paste into the same user-level config — see [MCP](../README.md#mcp-optional--the-cli-is-the-protocol).

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

## GitHub Actions — `claude-action`

```bash
hkb init --with-actions        # the profile + .github/workflows/kanban-dispatch.yml + kanban-worker-claude.yml
gh secret set KB_TOKEN         # fine-grained PAT, this repo: Issues, Contents, Pull requests, Actions RW
claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN     # or: gh secret set ANTHROPIC_API_KEY
git add .github/workflows && git commit && git push             # Actions runs the default branch's copy, only
hkb doctor                     # the workflows exist, and are committed
```

This is the one profile whose launch does not run a worker. `mode: "trigger"` means the launch *starts work
somewhere else* and exits:

```bash
gh workflow run kanban-worker-claude.yml -R <owner/repo> -f task=<n> -f attempt=<k> -f board=<slug>
```

The dispatcher runs it to completion (a non-zero exit is a `spawn_failed`, and the task goes straight back to
*ready*), then records the attempt with `remote: true` and no pid. That flag is the whole contract: the reclaim
pass skips every local check — pid, background job, worktree — and the attempt lives or dies by its heartbeat
and `max_runtime`. Anything that dispatches work off-box (a cloud agent, a queue) is the same shape.

### The two workflows

`kanban-dispatch.yml` is the dispatcher. Its triggers are events —
`issues: [closed, reopened, labeled, unlabeled]`, `pull_request: [closed]`, `pull_request_review`,
`workflow_run` (a worker finished), `workflow_dispatch` — and `schedule: */15` is a **sweeper only**: Actions'
cron floor is 5 minutes, top-of-hour runs are routinely 15-20+ minutes late, and a public repo idle for 60 days
has its schedules disabled. `concurrency: {group: kb-dispatch-<board>, cancel-in-progress: false}` keeps ticks
serial and never cancels one mid-claim.

The tick is `hkb dispatch --max 1 --board <slug> --profiles claude-action`. That last flag is what makes it safe
to run beside a laptop loop: **a host claims only the profiles it can launch.** Without it an Actions runner would
happily claim a `kb:agent:claude` task, fail to find `claude` on the runner, and burn a retry on a task your machine was
about to pick up. Everything else in the tick — reclaim, promote, reconcile, the orphan-lock sweep — is
unfiltered and covers the whole board, which is exactly what you want a second dispatcher for.

`kanban-worker-claude.yml` is one attempt. It checks out with `fetch-depth: 0` (the heartbeat is a CAS on a real
ref), turns `hkb context <task>` into `anthropics/claude-code-action@v1`'s `prompt`, and passes the same
`--allowedTools` list and the same force-push denial a local Claude worker gets. The brief travels through
`$GITHUB_OUTPUT` behind a delimiter drawn from `/dev/urandom` and is never interpolated into a `run:` block —
issue bodies are untrusted text. A last `if: always()` step is the stand-in for the `Stop` hook: if the task is
still `running` when the job ends, it is recorded as `hkb block … --kind transient` with a link to the run, so it
shows up on the board immediately instead of at the next stale reclaim. `hkb unblock <n>` puts it back.

Both pin `actions/checkout@v7` and `actions/setup-node@v7`, which run on Node 24. GitHub-hosted runners
are already there; a **self-hosted** runner has to be on v2.327.1 or newer, or both jobs fail before they
reach `hkb`. Both also set `package-manager-cache: false`: setup-node caches npm on its own from v5 on, and
these jobs install `hkb` globally rather than your project's dependencies — a cache would be written and read
back on every 15-minute tick for nothing, and in a repo with no lock file it fails the step outright.

### Secrets, and what init will not do for you

| secret | what it is for | scope |
| --- | --- | --- |
| `KB_TOKEN` | every `hkb`/`gh` call in both workflows | fine-grained PAT, this repo: Issues, Contents, Pull requests, Actions — read and write |
| `CLAUDE_CODE_OAUTH_TOKEN` | the worker's Claude session (`claude setup-token`, uses your subscription) | one of these two |
| `ANTHROPIC_API_KEY` | the worker's Claude session, billed per token | one of these two |

`hkb init --with-actions` writes files and nothing else: it never reads, writes or prints a secret, and the
templates contain only `${{ secrets.* }}` references. `KB_TOKEN` is a PAT rather than `GITHUB_TOKEN` on purpose —
writes made with `GITHUB_TOKEN` do not trigger further workflows, so the dispatcher would never see its own
transitions, and the PAT's limit is 5,000 requests an hour instead of 1,000.

### Known edges

| symptom | cause | fix |
| --- | --- | --- |
| every event logs a `::notice::` and dispatches nothing | `KB_TOKEN` is not set (or the event is a fork PR, which gets no secrets) | `gh secret set KB_TOKEN`; fork PRs are covered by the 15-minute sweeper |
| nothing runs at all | the workflows are not on the default branch | commit and push them; `hkb doctor` says so |
| a task sits `running` for an hour after the run was cancelled | a cancelled or killed job is only noticed at `stale_after` — there is no `workflow_run` crash detection for remote attempts yet | lower `stale_after`, or `hkb dispatch` from a laptop too |
| a task's `model` is ignored | the per-task override is not plumbed through workflow inputs | set the model in `claude_args` in the worker workflow |
| `--profiles: no profile "claude-action" in board.json` | the workflow was committed without the profile | `hkb init --with-actions` |

Honest latency, laptop off: **15-75 minutes**. The 60-second cadence is the local loop, and the two are safe to
run together — the lock ref is the arbiter, and `--profiles` keeps them out of each other's work.

## Adding a harness that has no built-in profile

Add a `launch` array under `profiles` in `.kanban/board.json` and give tasks `kb:agent:<profile>`; that is the
entire integration. Set `workspace: "worktree"` if the CLI cannot make its own checkout,
`"heartbeat": "comment"` if it cannot push refs, and `"mode": "trigger"` if the launch only asks something else
to do the work (then the attempt is `remote`: its heartbeat is the only liveness the dispatcher has). If the harness also needs files in the repo (an agent
definition, a hook config), add a `templates/<harness>/` directory and an entry in `HARNESS_FILES` in
`src/init.js` — `hkb init --harness <name>`, `hkb doctor` and the tests pick it up from there.
