# Harnesses

The board is labels, issue dependencies, refs and comments — no harness owns it. A *profile* in
`.kanban/board.json` is the whole adapter: a launch array, a few caps, and (for harnesses that need files on
disk) whatever `hkb init --harness <name>` generates. This page is the per-harness detail: what runs, what
`init` writes, and the one-time setup only you can do.

| profile | harness | worktree | stop nudge | structured output | spend | `hkb init --harness` |
| --- | --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code background agent | `claude --worktree` | `Stop` hook [on the launch line](#where-the-hooks-live) (`--settings`) | none — the log is the launch banner | tokens, from the session transcript | — (plain `hkb init`) |
| `claude-track` | the same, orchestrating a whole track — one isolated subagent per node | `claude --worktree`, plus one `.claude/worktrees/agent-<id>` per subagent | same | none | one transcript for the whole track, counted once — [subagents excepted](#a-track-is-one-session-however-many-nodes-it-holds) | — |
| `claude-p` | Claude Code headless | `claude --worktree` | same | `--output-format json` | **a reported cost** | — |
| `copilot-cli` | GitHub Copilot CLI | dispatcher (`git worktree add`) | `agentStop` hook in `.github/hooks/kanban.json` | none | none | `copilot` |
| `codex` | OpenAI Codex CLI | dispatcher (`git worktree add`) | `Stop` hook in `.codex/hooks.json` | `--output-schema` | none | `codex` |
| `claude-action` | Claude Code in GitHub Actions | the Actions runner's own checkout | `Stop` hook in `claude_args`, plus a final `if: always()` step | none | none — it runs off-host | `hkb init --with-actions` |

Whatever the harness, the protocol is the same: claim the lock ref, work in the worktree, open a draft PR that
says `Closes #<n>`, finish with exactly one terminal verb. The `hkb` verb the worker runs is always the source of
truth — structured output and stop nudges are safety nets, not the record. What differs is what each one can
tell you it *spent*, which is a real reason to pick one over another:
[the spend column, expanded](#what-a-profile-can-tell-you-it-spent).

## What a profile looks like

```jsonc
"codex": {
  "mode": "process",              // "process" (exits when done) · "claude-bg" (background agent daemon)
                                  // · "trigger" (the launch only *starts* work elsewhere and exits)
  "workspace": "worktree",        // the dispatcher makes .claude/worktrees/kb-<n>-<k>; omit if the CLI does it
  "heartbeat": "auto",            // "ref" (CAS on the lock ref) · "comment" · "auto"
  "max_in_progress": 1,
  "model": null,                  // per-profile default; a task's `model` wins
  "effort": null,                 // "low" | "medium" | "high" | "xhigh" — Claude Code's --effort
  "allowed_tools": null,          // per-command allowlist, for harnesses that have one
  "launch": ["codex", "exec", "-C", "{worktree}", "..."]
}
```

Placeholders in `launch`: `{n}` `{k}` `{slug}` `{title}` `{board}` `{repo}` `{model}` `{prompt}`, and
`{worktree}` — the absolute path of the checkout the dispatcher is about to create for this attempt (the board
root for profiles without `workspace: "worktree"`). `{model_args}` expands to `--model <m>`, `--effort <e>`,
both, or neither; `{allowed_tools}` splices the list in, and `--flag={allowed_tools}` repeats `--flag <entry>`
per entry. Nothing else is interpolated, so a launch array is safe to read and safe to edit.

If you pin `launch` on `claude`, `claude-track` or `claude-p` yourself rather than using the built-in, it must
still carry `{hook_settings}` (or the worker gets no Stop nudge and records no session id — see `launch hooks`
below, and note `hkb init` now repairs this on its own), `{allowed_tools}` (or `--allowedTools` swallows
whatever comes next), `{model_args}` (or `model`/`effort` render nowhere) and `{prompt}`. `hkb doctor` only ever
checks for `{hook_settings}`; the other three are your own launch failing in ways this project has not written a
check for yet.

`model` and `effort` are the two things people used to pin a whole `launch` array for (#182) — they render
into `{model_args}` on the `claude`, `claude-track` and `claude-p` profiles, so the pin is never needed just to
set them. `effort` is validated at load: an unknown value fails `hkb doctor`/every command with exit 2, naming
`low`, `medium`, `high`, `xhigh`. Copilot CLI and Codex have no verified `--effort` equivalent — measured:
`codex exec --effort high` and `copilot ... --effort high` both die on the CLI's own "unknown option" before a
worker gets a turn — so `loadBoard` refuses `effort` outright on any profile whose `launch[0]` is not `claude`,
naming the profile and the fix. `claude-action` is the one exception: its launch only *triggers* a Claude Code
Action run (`launch[0]` is `gh`), so `effort` there is accepted and, for now, ignored — nothing plumbs it into
`claude_args` in `templates/actions/kanban-worker-claude.yml` yet. A launch pinned before the `model`/`effort`
fields existed should drop the pin (see `launch hooks` below) rather than carry `--effort` by hand — `hkb init`
does this for you when the pin adds nothing else.

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

## What a profile can tell you it spent

Worth knowing *before* you pick one, because it is the harness that decides, not hkb. `hkb stats` reports one
of four things per attempt, and never dresses one as another:

| basis | where it comes from | how it reads |
| --- | --- | --- |
| **reported** | `total_cost_usd` on the attempt row, or at the end of the worker's log — a number Claude signed off on | `spend $9.02 reported` |
| **estimate** | the transcript's tokens, priced at rates the *board* states (`stats.rates`, below) | `~$34.59 estimated`, always with the tilde and the word |
| **usage** | the same tokens, unpriced — turns in, tokens out, which beat nothing | a `usage` line and no dollars |
| nothing | an outcome and a duration, and that is the whole record | `not recorded on any of the N worker attempts` |

Per profile:

| profile | what an attempt leaves behind | so `hkb stats` shows |
| --- | --- | --- |
| `claude` | a launch banner and nothing else — a background agent signs off with no JSON. What it leaves is the session its terminal verb records: an id and a transcript path ([how](#how-a-background-worker-records-a-session-nobody-told-it-about)) | **usage**, or an **estimate** once the board has rates |
| `claude-track` | the same — and because the runner finishes each node from inside its own session (its subagents included: they inherit its session id), every node's row carries the *runner's* session id and transcript | as `claude`, but one transcript covers the whole track and is counted once for it — and it holds the orchestrator's turns only, not its subagents' (#155) |
| `claude-p` | `--output-format json`, so the log ends in Claude's own `{"session_id": …, "total_cost_usd": …, "num_turns": …}` | **reported**, per attempt, with turns |
| `copilot-cli` | no structured output, and no cost in the `agentStop` payload | **nothing** |
| `codex` | `--output-schema` shapes the terminal verb, not a bill | **nothing** |
| `claude-action` | the attempt runs on a GitHub runner: no local log, no transcript, and no `Stop` hook (a final `if: always()` step stands in) | **nothing here** — the cost is in the Actions run and on your Claude account |

The order is the run record, then the worker's log, then the transcript, and each is read only because the one
above it came back empty. The last two are files on the host that *ran* the attempt, so a board reported from a
second machine sees whatever the run record carries and no more — never an error, just the next answer down.

Two things decide whether a Claude profile's transcript answer actually arrives. Both are below.

### Putting a price on tokens — `stats.rates`

hkb ships no price table, on purpose: a price it invented would look, in the output, exactly like one Claude
reported, and published prices move under a checkout that does not. An estimate therefore comes from rates the
board states, in `.kanban/board.json`, in USD per **million** tokens:

```jsonc
"stats": {
  "rates": {
    "claude-opus-5": { "input": 5, "output": 25 },
    "default":       { "input": 1, "output": 5 }
  }
}
```

A key matches a model exactly, then as its longest prefix, then `"default"`. `input` and `output` are required
— a rate missing either is no rate, and a session whose models are not all rated stays usage rather than being
half-priced. `cache_write` and `cache_read` are optional and fall back to the published 1.25× and 0.1×
multipliers on `input`; set them where your plan differs, and note that one `cache_write` covers both cache
TTLs, which are billed differently. With no rates at all the report prints turns and tokens plus the one line
that says what to add. Estimated money is kept in its own field (`estimated_usd`) and never added to
`total_usd`, so nothing downstream can mistake one for the other.

Recording a session and pricing it are two halves, and a board can have the first without the second — which
reads as working until someone asks what the board cost. `hkb doctor` says so on the line where the operator is
already looking at the recording, rather than leaving it to a report that comes up empty:

```
✓ profile claude sessions   session recorded on 3/8 that filed a terminal verb · no `stats.rates` in
                            .kanban/board.json, so those transcripts give `hkb stats` turns and tokens
                            but never a cost
```

### A track is one session, however many nodes it holds

A `claude-track` runner claims each node from inside the session already running, so every node's attempt row
carries the same `session_id` and `transcript_path` as the root. That is what lets `hkb show <node>` print a
`claude --resume` line for a node nobody launched on its own, and it is the difference from a cold node — one
the dispatcher started by itself, which has a session and a transcript of its own.

It stays true now that the runner hands each node to its own **isolated subagent**: measured against Claude Code
2.1.251 (#129), a subagent inherits the root's `CLAUDE_CODE_SESSION_ID` and `CLAUDE_JOB_DIR`, so a node finished
from inside a child still stamps the runner's session. The child's *worktree* is its own — a repo-level
`.claude/worktrees/agent-<id>`, a sibling of `kb-<n>-<k>` and not nested under it, removed with its branch when the
subagent returns unchanged. A subagent that committed keeps its worktree — with `kb/<n>` checked out — until
`hkb gc` clears it, which it does once that branch's PR is merged or closed (which is why the node brief says
commit and push before returning). The launch's hooks
fire in there too, `PreToolUse` included, and `SubagentStop` is what tells the Stop nudge to stand aside while a
wave is still running.

What that costs is **under**-reported: a subagent's usage goes to a sidecar transcript,
`~/.claude/projects/<proj>/<session>/subagents/agent-<id>.jsonl`, which `usageFromTranscript` does not open — so
`hkb stats` prices the orchestrator's turns and none of its children's (#155). Whether `--max-budget-usd` counts
them was not measurable without blowing through the budget, so `claude-track` launches with `--max-budget-usd 50`,
sized as if it does.

The bill does not divide the same way. Those tokens were spent once, and no per-node share of them is recorded
anywhere — so `hkb stats` counts them once: a transcript is read once however many attempt rows name it, its
usage and its estimate land on one of them, and the others are reported as having run inside a session that is
counted elsewhere:

```
spend      ~$0.17 ESTIMATED on 2 of 4 worker attempts — the tokens below at your `stats.rates`; nothing here reported a cost
usage      200 turns · in 2000 · out 4000 · cache 8000 written / 16k read  (2 transcripts over 4 worker attempts)
           2 worker attempts ran inside a session another attempt carries — counted once, there, not once per node
```

That is a track of three plus one cold node: four attempts, two sessions, and a total that is the two, not the
four. In `--json` the nodes counted elsewhere are `spend.attempts_shared_session` — attempts that ran and count
as attempts, but are neither a cost of their own nor a hole in the coverage (`attempts_missing_cost` leaves them
out). A cold node, whose transcript nobody else names, is priced on its own as it always was.

### How a background worker records a session nobody told it about

There is no transcript to price unless something recorded one, and on the default profile the obvious candidate
cannot. The dispatcher exports `KB_TASK`/`KB_ATTEMPT` on the launch, but `claude --bg` only asks Claude Code's
session daemon to start an agent and exits: the daemon was started long before, with an environment of its own,
so the worker session never sees them (verified here 2026-08-28, Claude Code 2.1.250 — inside a live worker
`process.env.KB_TASK` is undefined). For a while that made the whole chain inert on `claude` and `claude-track`,
which is what [#125](https://github.com/emyann/harness-kanban-board/issues/125) was filed for: no nudge, no
session id, and a report that fell through to `not recorded on any of the N worker attempts`.

Two things a background session *does* have close it, and neither is an API call:

- **which attempt it is** — its checkout. The launch names it `kb-<n>-<k>`, which is already how the dispatcher
  identifies a running job, so `hkb` reads the attempt back out of the directory name when the environment is
  silent. The `Stop` nudge works again for the same reason.
- **which session it is** — `CLAUDE_CODE_SESSION_ID` in every command the session runs, and, for a background
  agent, the job record under `~/.claude/jobs/<id>/` that also names the transcript on disk.

The recording itself is done by the **terminal verb**, not the hook: `hkb complete` / `block` / `request-review`
is the one thing every worker runs, it is already writing that attempt's row, and it works whether or not the
harness fires hooks at all. It stamps only an attempt this session actually ran — its own, or a node it claimed
in-session — so an operator finishing a card from their own terminal, and the dispatcher writing off a dead
attempt, record nothing. That last rule is also what gives a track its per-node identity: the runner finishes
each node from inside its own session, so each node's row ends up carrying the runner's transcript.

The attempts that never reach a terminal verb (`crashed`, `timed_out`, `protocol_violation`) are exactly the
ones a post-mortem wants, so they are covered by the **dispatcher** instead. The tick already resolves the
background job behind a running attempt to decide whether it is still alive, and that job names the same record
on disk — so one tick after the launch it writes the session onto the row, while the attempt is still live. No
hook, no verb, no extra call. It fills blanks only: a row a verb has already stamped is left byte-identical,
and a resumed job (one record over two sessions) is never half-merged into a row that names a different one.

What is still left blank: an attempt from before either mechanism shipped, and one whose job record was already
gone by the time the tick looked. `hkb stats` counts those and prices none of them, and says so — `N worker
attempts priced nothing at all — the real total is higher`.

Check your own setup in one command: **`hkb doctor`** has a line per background profile —

```
✓ profile claude sessions   session recorded on 6/6 that filed a terminal verb · 3/3 written off without one
! profile claude sessions   none of the 11 ended attempts on this board carries a session id (10 run records read)
                              → npm i -g hkb-cli@latest && hkb init … — if it is already current the harness is
                                not stamping: check $CLAUDE_JOB_DIR is set inside a worker session
```

It reads the newest run records on the board — at most ten, and it stops at the first one that answers — so
"nothing recorded" is a statement about what the board actually holds, not a guess. Per card, `hkb show <n>`
prints a `session …` line, and a `claude --resume`, for an attempt whose session was recorded.

## Claude Code — `claude`, `claude-p`

`hkb init` is all it takes: the skill lands in `.agents/skills/kanban` (linked from `.claude/skills/kanban`), the
slash commands land in `.claude/commands/kanban/` (`/kanban:specify`, `/kanban:decompose`, `/kanban:operate` — the
directory name is the namespace, so they are the same names the plugin registers), and
the `Stop` + `PreToolUse` + `SubagentStop` hooks go **on the worker launch**, not into a settings file. `claude` runs each
worker as a background agent (`claude --bg`, visible in `claude agents`, attachable with `claude attach <job>`);
`claude-p` is the headless variant for CI and containers. Both isolate themselves with `--worktree kb-<n>-<k>`.

### Where the hooks live

On the launch line, as `--settings '{"hooks":…}'` — so the only session that ever sees them is the worker hkb
started. `hkb init` writes nothing into `.claude/settings.json` or `.claude/settings.local.json`.

That is a retraction, and it is worth saying why (#144). All three hooks are `matcher: "*"` and all three are inert
outside a worker, so what a settings file bought every *other* session in the repo was a shell and a node process per tool
call to return 0 — and, the day the command stopped resolving, a logged failure per tool call instead. That is not
hypothetical: on a real board an nvm version switch took `hkb` off PATH, and from then on every tool call in every
Claude Code session in that repo logged `PreToolUse:Bash hook error … /bin/sh: 1: hkb: not found`. #85 moved the
file and taught `doctor` to see it; only moving off the file removes the exposure.

The same principle holds one level down: the hook never blocks a tool call because it cannot read its own
config. A worktree's `.kanban/board.json` mid-merge or mid-edit prints one line on stderr and stands aside
rather than failing the tool call that would fix it (#184).

Claude Code takes `--settings <file-or-json>` **per launch**, and the launch line is already the worker's whole
permission policy. So it carries the hooks too:

```
claude --bg … --allowedTools … --disallowedTools … \
  --settings '{"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"node \\"/home/you/hkb/bin/hkb.js\\" hook stop","timeout":30}]}], …}}'
```

Two things follow. The command in there names **this machine** — `node "/abs/path/bin/hkb.js" hook stop`, the hkb that
runs the dispatcher, whenever it lives in a durable checkout or install (a bare `hkb` only when it sits in an
npx cache) — because a launch line is spent here and nowhere else; that is exactly the case a tracked
settings file had to rule out. And `.kanban/board.json`, which *is* tracked, holds only the placeholder
`{hook_settings}`: the launch template stays true on every machine, and the JSON is built at spawn time.

**`claude --bg` was measured live, not assumed.** A background launch hands the request to Claude Code's
session daemon, so a per-launch flag only reaches it if the CLI forwards it. The check was a `claude --bg`
launch carrying `--settings '{"hooks":{"Stop":…}}'`, watched for the hook to fire in that session — and it
did, 4 s after the launch returned (2026-08-29, Claude Code 2.1.251, comment on
[#144](https://github.com/emyann/harness-kanban-board/issues/144)). The path is `handleBgFlag →
spawnBgSession`: its respawn-flag allowlist keeps `--settings <value>` as a pair when it re-execs into the
daemon, and a value starting with `{` passes through untouched rather than being resolved as a path. That is
why `claude` and `claude-track` get the hooks and not only `claude-p`.

That measurement is not something `hkb doctor` can re-run on every board, so do not read its `profile claude
sessions` line as proof the launch hooks fired: since
[#137](https://github.com/emyann/harness-kanban-board/issues/137) the dispatcher's own tick also records the
session id, straight off the job record, whether or not any hook ever ran. The Stop hook's actual trace is the
`.kanban/sessions/<n>-<k>` marker file it writes on every fire — that file existing for an attempt is the
empirical check for *that* attempt.

Copilot CLI and Codex keep their own hook files (`.github/hooks/kanban.json`, `.codex/hooks.json`). Neither
harness has a per-launch settings source to move them onto, and neither file is read by anything but that harness,
so neither carries the cost this section is about — but both files are tracked, so the command inside them is
still bound by the same rule: only a command that means the same thing on every machine may go in them (#166,
below).

### `--shared-hooks`: when you do want them in every session

`hkb init --shared-hooks` writes all three hooks into the tracked `.claude/settings.json` — for a team that wants
the protocol enforced in every session in the repo, not only in the ones hkb launched. Nothing removes hooks from
that file again; they are a choice. A worker on such a board then runs each hook twice, once from the file and
once from its launch, which costs a Stop nudge its second try and nothing else — `hkb doctor` says so.

**Residual risk:** the nudge count in `.kanban/nudges/<n>-<k>` is shared by both copies of `Stop`, and both fire
on the same turn — so one real stop attempt advances the count twice (0→1, then immediately 1→2) instead of
once. A worker on a `--shared-hooks` board therefore gets one nudged turn to finish with a terminal verb, not
the two a single-hook board gives it, before hkb stops blocking and leaves the attempt for the dispatcher to
mark `protocol_violation`. `PreToolUse` has nothing equivalent to spend twice: it only ever denies or says
nothing, and two passes through the same pure check agree with themselves.

What may go in that file is unchanged, and it is the narrow question #85 and #146 settled: a tracked file is
read on machines that are not this one, so only a command that means the same thing on all of them may go in it.

| where the hkb you ran `init` with lives | `--shared-hooks` (`.claude/settings.json`) | `--harness codex` / `--harness copilot` | `--mcp` (`.mcp.json`) |
| --- | --- | --- | --- |
| **inside the repo** — `npm i -D hkb-cli`, the repo's own devDependency | `f="$CLAUDE_PROJECT_DIR/node_modules/hkb-cli/bin/hkb.js"; [ -f "$f" ] \|\| exit 0; exec node "$f" hook stop` | `node "node_modules/hkb-cli/bin/hkb.js" hook stop` | `{"command": "node", "args": ["node_modules/hkb-cli/bin/hkb.js", "mcp"]}` |
| **inside the repo** — a checkout of hkb setting *itself* up | the same command, with `$CLAUDE_PROJECT_DIR/bin/hkb.js` | the same command, with `bin/hkb.js` | the same entry, with `bin/hkb.js` |
| anywhere else — a global, another checkout, an npx cache | `hkb hook stop`, which every teammate must have on PATH | `hkb hook stop`, same | `{"command": "hkb", "args": ["mcp"]}`, same |

The first two rows in every column are the ones to want (#146, #166), and they are one rule, not three: when the
hkb being run is *inside* the repo it is setting up, where it sits is a property of the **project** rather than of
the machine, so the command is exact here and correct on every other machine at the same time — commit the file,
and a teammate's `git pull && npm install` is the whole setup, on a machine that never runs `hkb init` at all.

`--mcp` also prints — never writes — the `~/.codex/config.toml` and `.vscode/mcp.json` equivalents, since neither
file is hkb's to commit. `.vscode/mcp.json` is a workspace file VS Code resolves relative paths in against the
project directory, same as `.mcp.json`, so it gets the same entry verbatim. `~/.codex/config.toml` is user-level:
Codex resolves its `args` against wherever `codex` happens to start, not this project, so a project-relative path
there would be right only in this one directory. That snippet always names `hkb` on PATH or this checkout's own
`bin/hkb.js` made absolute — never the relative form the other three columns want.

Only the middle column is measured differently. Claude Code sets `$CLAUDE_PROJECT_DIR` for hook commands
precisely so a project can name its own files by a variable instead of a cwd; Codex and Copilot set neither,
but both already run their hook's command from the project root — Codex's `-C <worktree>` is also its cwd, and
Copilot runs from the worktree the dispatcher creates for it — so a plain relative path resolves there without
one. That form also carries no `[ -f … ] || exit 0` guard: whether either harness runs `command` through a shell
is undocumented, and the guard's `f="…"; …` syntax is only valid there. Run unguarded instead, so it is correct
whichever way a harness spawns it — the cost is a hard failure, rather than a silent no-op, in the narrow window
before a fresh worktree has run `npm ci`.

The path in it is *measured* from the repo root, never composed from the package's name — so a pnpm store
(`node_modules/.pnpm/hkb-cli@0.1.4/node_modules/hkb-cli`) or a nested install is named as it actually is, and a
checkout of hkb, where the repo *is* the package, comes out as plain `bin/hkb.js`. Two paths under the root are
still refused: an npx cache, which stops existing when npm cleans it, and a `.claude/worktrees/<attempt>`
checkout, which is gitignored and gone with the attempt.

The guard is the rest of it. A worker's `.claude/worktrees/kb-<n>-<k>` is a fresh checkout with no `node_modules`
until it runs `npm ci`, and `$CLAUDE_PROJECT_DIR` there is the worktree — so the command tests for its own file
and exits 0 in silence when it is not there yet. Nothing is lost: all three hooks are inert without `KB_TASK` anyway,
and by the time the `Stop` hook has anything to nudge about, the worker has installed. `hkb doctor` reports that
state as a warning naming `npm install`, not a failure; it is the normal state of a checkout nobody has installed
yet. (The launch's own copy of the hooks is not guarded and does not need to be: it names the hkb that is
*running*, which by construction is there.)

### Which layer is actually enforcing

**The launch line is the policy.** `--permission-mode dontAsk` plus `--allowedTools` / `--disallowedTools` is
the one layer that is live on every profile, so that is where hkb says what a worker may and may not run: the
allow-list covers the builtins hkb's own guard calls safe (`SAFE_BUILTINS` — #138), and the deny list is
`Bash(hkb dispatch*)` beside the two force-push patterns. The dispatcher is denied at the launch because
`Bash(hkb *)` allows every other verb and a second dispatcher against the live board claims a task somebody is
already working. Copilot has no equivalent deny: a space-star pattern in its `--deny-tool` language is
unverified, and a deny that silently matches nothing is worse than none, so its workers are told in the prompt.

The three hooks sit on top of that, gated differently, and on the default profile only two of them are live:

| | `Stop` — the terminal-verb nudge | `PreToolUse` — hkb's permission policy | `SubagentStop` — subagent bookkeeping |
| --- | --- | --- | --- |
| where it comes from | the launch's `--settings` (Claude), the harness's own hook file otherwise | same | same (Claude Code only — Copilot and Codex have no subagent tool) |
| what identifies the session | `KB_TASK`, else the `kb-<n>-<k>` checkout name — and the checkout when the two disagree | `KB_TASK` only, and only where the checkout agrees | `CLAUDE_PROJECT_DIR`, tried first whenever it disagrees with the cwd — the cwd otherwise |
| what it may answer | `{"decision":"block"}`, at most twice | **`deny`, or nothing** — never `allow` | nothing — it only records that a subagent ended |
| `claude` / `claude-track` (`claude --bg`) | **live** — the checkout names the attempt | **inert** — the launch's `--allowedTools` and `--disallowedTools` are the whole policy | **live** — needed to tell a track root waiting on its wave from one that forgot the verb (#163) |
| `claude-p` (`mode: "process"`) | live | live, and can only subtract from those launch flags | live |
| `claude-action` (`mode: "trigger"`) | live — the workflow sets `KB_TASK`; the `if: always()` step is the backstop | live — the workflow sets `KB_PROFILE` too | live |
| `copilot-cli`, `codex` | their own `agentStop` / `Stop` hook file | their own `--allow-tool` / `--sandbox` — they never read `.claude/settings*.json` | n/a — neither harness has a subagent tool of its own |

Installing the hooks on the launch does **not** change that `claude --bg` row: the session daemon was started
long before, with an environment of its own, so `KB_TASK` never reaches it and `PreToolUse` still stands aside
there. The hook is present and declines to act, which is not the same as absent, and it is the answer #133 chose.

A checkout name says which *task* a session is, never which *profile* launched it, and hkb's policy applied with
no profile would allow `hkb`, `git` and `gh` and deny a worker `npm test` — so `PreToolUse` stands aside rather
than guess, with one line on stderr. That is a deliberate choice, not an oversight
([#133](https://github.com/emyann/harness-kanban-board/issues/133) settled it), and it is why the hook never
answers `allow`: a hook `allow` **overrides Claude Code's own checks** — including the command-substitution one
— so an allow would let a `claude-p` worker run what the identical `claude --bg` worker beside it is refused.
Deny-or-silence keeps the layer purely additive. A denial also names the way out, because the expensive wrong
turn is a worker rewriting the command until something gets through: *if the task cannot be done without this,
run `hkb block <n> "needs …" --kind capability` and stop.*

`hkb doctor` prints the row that applies to your board, so a denial never has to be traced back by hand:

```
✓ permission policy   hkb's PreToolUse policy enforces on claude-p — the launch's own flags are the whole policy
                      on claude, claude-track (a `claude --bg` session never receives KB_TASK) · claude-action
                      (the triggered run brings its own settings) · codex (not Claude Code)
✓ worker permissions  4 allow-lists cover the 16 shell builtins hkb calls safe
```

Three checks guard the layer that is doing the enforcing, and all of them read local files only:

- **`launch hooks`** catches a launch frozen in `board.json` before the hooks moved onto it. `loadBoard`
  deep-merges the file over hkb's defaults and an array in the file wins whole, so a `launch` an older `init`
  wrote out keeps its shape forever — and since nothing is being written into a settings file to make up for it,
  that profile's workers would quietly get no Stop nudge and record no session id. `hkb init` now repairs this
  itself, so re-running it is normally the fix: it applies the surgical repair rather than the blunt one — insert
  `"{hook_settings}"` into the launch, right after its `"--disallowedTools"` group, on one of hkb's own profiles —
  or drop `"launch"` there entirely if the only reason it was pinned was `--model`/`--effort`, which are profile
  fields now (see above) and need no pin at all, moving those values into the profile's own fields. It prints one
  line naming which repair it made, per profile, and says nothing on a re-run once there is nothing left stale.
  A custom-named profile has no default behind it, so both init and doctor's fix text tell you to add
  `"{hook_settings}"` by hand.
- **`worker permissions`** catches a **frozen copy** of an allow-list, which no default change can reach: a
  profile that pins `allowed_tools` in `board.json`, and the `--allowedTools` line `hkb init --with-actions`
  bakes into the generated worker workflow. Both keep denying `cd`, `export`, `command`, `env` until someone
  regenerates them. The fix it prints depends on the profile: one of hkb's own takes its list back when you
  *drop* `allowed_tools` (`loadBoard` deep-merges over the default), while a custom-named profile has nothing
  behind it — dropping the key there expands `{allowed_tools}` to nothing and leaves `--allowedTools` swallowing
  the next flag, so it is told to add the missing patterns instead.
- **`permission mode`** warns when a `claude` launch has lost `--permission-mode dontAsk`. Without it a call
  outside the allow-list *prompts* instead of being denied, and a background worker has nobody to answer: the
  attempt does not fail, it hangs until `max_runtime` reclaims it. Silent when every launch says `dontAsk`.

### The `claude` profile's launch carries no `KB_*` at all

The dispatcher puts `KB_TASK`/`KB_ATTEMPT`/`KB_BOARD`/`KB_REPO`/`KB_LOCK_REF`/`KB_ROOT`/`KB_PROFILE` on every
launch **except** a `claude --bg` one, which gets an environment with every `KB_*` key removed. The reason is
the asymmetry above, read the other way round: the daemon does not forward the launch environment to the session
it hosts — so those variables reach no worker there and buy nothing — but a launch that finds **no daemon
running starts one**, and the daemon then keeps that environment for its whole life.

Measured on this board on 2026-08-28 ([#150](https://github.com/emyann/harness-kanban-board/issues/150)): a cold
start for #146 left `KB_TASK=146 KB_ATTEMPT=1 KB_PROFILE=claude KB_ROOT=…` in the daemon, and every session it
went on to host inherited them — including an operator conversation that predated the card. Three things
followed, and all three are what a worker's identity is *supposed* to do, done to the wrong session:

- its Stop hook recorded that conversation's `session_id` and transcript on #146's attempt row, so
  `hkb show 146`'s resume line reopened an operator's conversation instead of the worker;
- hkb's `PreToolUse` policy applied the profile's allowlist to the operator's shell — a diagnostic `for … do …
  done` loop denied, and a card body denied for *mentioning* `hkb dispatch`;
- had the card still been `running`, the Stop hook would have nudged that conversation, twice, to finish
  somebody else's task.

So the launch hands over nothing, and the three hooks refuse an environment their checkout contradicts: a session
whose `KB_TASK` names a task it is plainly not sitting in the worktree of falls back to the checkout (usually to
nothing at all) and says so once on stderr — not only at the board root: the same daemon that leaked into an
operator's shell can go on to host a session for an unrelated review worktree or an entirely different repo, and
`KB_ROOT` joined with `kb-<n>-<k>` is the only cwd that counts as evidence for the environment.

```
hkb hook: KB_TASK=146 in the environment but this is not its worktree (this is the board root); ignoring
```

A daemon started before this fix keeps its inherited variables until it is restarted. `hkb doctor` says so when
it is run inside one, and on Linux names the pid:

```
! worker environment   this shell thinks it is a worker for #146 on profile claude, but it is the board root — a
                       `claude --bg` launch probably started the Claude Code session daemon with that
                       environment, and every session it hosts inherits it. The daemon holding KB_TASK
                       KB_ATTEMPT KB_PROFILE KB_ROOT: pid 22486. …
                         → let the sessions it hosts finish, then end the daemon (pid 22486) — the next
                           `claude --bg` starts a clean one
```

Nothing changes for the other profiles: `claude-p`, `copilot-cli` and `codex` are child processes whose
environment dies with them and is their only identity, and `claude-action` gets its `KB_*` from the workflow.

### The command a worker cannot type: `complete`, and heredocs

There is a third layer, below the hooks, and it is the one that decides whether an attempt can end at all.
A `claude --bg` worker runs in a **worktree-isolated session**, and Claude Code vets that session's command
lines word by word before hkb ever sees them. Two shapes the protocol used to prescribe do not survive it —
measured on Claude Code 2.1.250/2.1.251, from inside a live worker on this board (#125):

| the worker types | what happens |
| --- | --- |
| `hkb complete 125 --summary "…"` | refused: *"this command runs a string through complete, which can't be verified to stay inside the worktree"* |
| any command with a `<<'EOF'` heredoc | refused: *"Permission to use Bash has been denied because Claude Code is running in don't ask mode"* |
| `hkb finish 125 --from-stdin < /tmp/kb-125.json` | **runs** |

Both refusals are about the *shape* of the command, not its contents. `complete` is a **bash builtin**
(`complete -C <cmd>` runs a string through a shell), so the vetting sees the builtin rather than hkb's verb —
for any arguments, and however the word is quoted. The heredoc is refused whatever its body holds: the same
command with `--note "…"` instead of `<<'EOF' … EOF` is allowed, and a herestring (`<<<`) or a file redirect
(`<`) is allowed too. That settles the open question from
[#112](https://github.com/emyann/harness-kanban-board/issues/112): the pilot's failure was never about `|`,
`;` or `&&` inside the payload — a payload containing all three goes through a redirect without complaint.

So hkb ships **`finish`** — the same verb under a name no shell claims, resolved before routing, so the run
record, the outbox replay and the board all still say `complete`. `block` and `request-review` are not
builtins and need no alias. Everything a worker reads — `hkb context`, the Stop hook's nudge, `SKILL.md` —
now names `finish` and a redirect, because the two commands a *successful* worker must run were exactly the
two it could not.

### What `hkb doctor` says about the hooks

The question it asks is "can the command a worker will run actually run here", and where it says that command
came from is the launch:

```
✓ stop hook       on the claude, claude-track, claude-p launch (--settings), so no other session in this repo runs it
✓ hook command    node "/usr/lib/node_modules/hkb-cli/bin/hkb.js" hook stop
```

A settings file is still read, because two kinds of repo have hkb hooks in one — a team that asked
(`--shared-hooks`), and a repo an older init reached. Either way they fire in every session there, so both are
reported, with different fixes: the per-developer copy is init's to remove, the tracked one is the operator's:

```
! hooks in settings   .claude/settings.local.json configures hkb's hooks, so they run in every session in this
                      repo — and a worker runs them twice, once from there and once from its launch
                        → hkb init — it removes them from the per-developer file
```

And whatever the source, a command that cannot resolve is a failure with the install in the fix:

```
✗ hook command    hkb hook stop in .claude/settings.json — `hkb` is not on PATH here; the hook fails on every
                  tool call in every session in this repo
                    → npm i -g hkb-cli (or: hkb init, which writes a command that resolves here)
```

On a repo that carries its own hkb, a bare `hkb` in the tracked file is that same failure even when it happens to
work on the machine running doctor: it is not the copy the repo carries, and it is not a copy everyone has —
they have only what their checkout gave them.

```
✗ hook command    hkb hook stop · hkb hook pretool in .claude/settings.json — this repo carries hkb itself
                  (node_modules/hkb-cli/bin/hkb.js), and `hkb` is whatever each machine happens to have, or nothing
                    → hkb init — it rewrites the command as $CLAUDE_PROJECT_DIR/node_modules/hkb-cli/bin/hkb.js
✓ hook command    $CLAUDE_PROJECT_DIR/node_modules/hkb-cli/bin/hkb.js → /home/you/repo/node_modules/hkb-cli/bin/hkb.js
```

A guarded command whose file is missing is normally just an install that has not happened yet, and doctor says so
as a warning naming `npm install`. The exception is a command that names a path the repo's hkb has *left* — a
version-stamped pnpm store after an upgrade, say. Nothing installs that path back, so the hook would exit 0 in
silence forever, and doctor calls it a failure naming `hkb init` instead.

Re-running `hkb init` is idempotent on all of this: it takes hkb's own hooks out of `.claude/settings.local.json`
(and only hkb's own — an operator's hook in the same group stays), leaves the tracked file alone unless
`--shared-hooks` is given, and rewrites a command there that is not the one that repo should have.

`hkb doctor` runs the same resolve check on `.codex/hooks.json`, `.github/hooks/kanban.json` and `.mcp.json`
(#166) — a `<harness> hook command` / `.mcp.json` line, failing the same way a `node <path>` that is not there
fails for Claude's settings above:

```
✗ codex hook command   node_modules/hkb-cli/bin/hkb.js is not there — this repo's hkb has moved, or this
                        checkout has not run `npm install` yet
                          → npm install
```

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
| a profile's `effort` does nothing here | the Actions worker workflow's `claude_args` is a hand-written flag list, not rendered from `{model_args}` | add `--effort <v>` to `claude_args` in the worker workflow yourself |
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
