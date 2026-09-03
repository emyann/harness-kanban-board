// Board configuration (.kanban/board.json), repo detection, local paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { ghCmd } from './gh.js';
import {
  worktreePath, parseRepoSpecs, mergeBoardEntry, stripNodeModulesBin, pidClaimStale,
  parseBtimeSec, parseKernBoottimeSec, SAFE_BUILTINS, EFFORT_LEVELS, TOOL_POSTURES, CAPABILITIES,
} from './model.js';

// A background worker has nobody to answer a permission prompt, so the allowlist must cover
// every command an agent plausibly reaches for; anything else is denied, never prompted (see #23).
const SHELL_TOOLS = ['hkb *', 'git *', 'gh pr *', 'gh issue view *', 'npm *', 'npx *', 'node *', 'cat *', 'ls *', 'mkdir *', 'head *', 'tail *', 'wc *', 'sed *', 'awk *', 'grep *', 'find *', 'diff *', 'cp *', 'mv *', 'touch *', 'chmod *', 'printf *', 'echo *', 'jq *'];
// The shell builtins hkb's own PreToolUse guard already calls safe (`SAFE_BUILTINS`), said again in
// the launch's language. Leaving them out made the two layers disagree, and under `dontAsk` the
// harness denies rather than prompts — so it refused `cd`, `export`, `command`, `env` while hkb's
// policy declared them fine, and workers burned turns rewriting commands (#138).
//
// The ` *` suffix is load-bearing, not decoration. Measured against Claude Code 2.1.251: with
// `Bash(export)` the command `export FOO=1; echo ok` is DENIED and with `Bash(export *)` it is
// allowed — and the suffixed form still covers the bare word, so one entry per builtin does it.
// That is why `Bash(true)` no longer has to be spliced in by hand.
const BUILTIN_TOOLS = SAFE_BUILTINS.map((c) => `${c} *`);
// deduped: `echo` and `printf` are on both lists, and a repeated pattern is noise in a flag a human reads
const SHELL_PATTERNS = [...new Set([...SHELL_TOOLS, ...BUILTIN_TOOLS])];
// `Skill` lets a worker load a task's `kb.skills` (src/context.js) — the field otherwise names a tool
// `dontAsk` is guaranteed to deny, since an unlisted tool is refused rather than prompted (#114).
const CLAUDE_TOOLS = [...SHELL_PATTERNS.map((c) => `Bash(${c})`), 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Skill'];
// A track runner is an ORCHESTRATOR: it fans a wave of independent nodes out to one isolated
// subagent each (`Agent` with `isolation: "worktree"`), so siblings run at the same time instead of
// one after another. `Agent` is the whole unlock — measured against Claude Code 2.1.251 (#129), a
// `--bg --worktree` root under `dontAsk` spawns an isolated child the moment the tool is allow-listed,
// and is DENIED rather than prompted without it. It stays off `CLAUDE_TOOLS` on purpose: a cold node
// worker is one session doing one node, and a node worker that could fan out would spawn children
// nothing on the board has claimed.
const CLAUDE_TRACK_TOOLS = [...CLAUDE_TOOLS, 'Agent'];
// Copilot CLI spells the same policy `--allow-tool 'shell(<cmd>)'`, one flag per pattern, plus the
// built-in `write` tool for file edits. See the `--allow-tool={allowed_tools}` token in dispatch.js.
// Copilot wildcards are `shell(cmd:*)` (verified against the CLI programmatic reference, 2026-08-26);
// a multiword prefix like `gh pr *` has no wildcard form, so it widens to the command's `cmd:*`.
const COPILOT_TOOLS = [...new Set(SHELL_PATTERNS.map((c) => c.includes('*') ? `shell(${c.split(' ')[0]}:*)` : `shell(${c})`)), 'write'];

// What the launch refuses outright, whatever the allow-list says. `Bash(hkb *)` allows every verb,
// and the one a worker must never run is the one that dispatched it: a second dispatcher against the
// live board claims a task somebody is already working. hkb's own PreToolUse guard has denied
// `hkb dispatch` since #23, but that hook is `KB_TASK`-gated and so inert on the `claude --bg`
// profiles most boards run — the launch line is the only layer that is live everywhere (#143).
//
// Copilot has no entry here on purpose: its deny language is `--deny-tool 'shell(<pattern>)'` and a
// space-star pattern (`shell(hkb dispatch*)`) is unverified against that parser, so a deny that
// silently matches nothing would read as protection there is none of. Copilot workers are told in
// the prompt instead (SKILL.md, `hkb context`).
export const CLAUDE_DENY = ['Bash(hkb dispatch*)', 'Bash(git push --force*)', 'Bash(git push -f*)'];

// hkb's Stop, PreToolUse and SubagentStop hooks, on the launch line rather than in a settings file (#144). The
// placeholder expands to `--settings '{"hooks":…}'` at spawn time (`expandLaunch`, src/dispatch.js)
// and to nothing when there is no command to run — which is the reason it is a placeholder and not
// the JSON itself: `.kanban/board.json` is TRACKED, and the command inside names whichever `hkb`
// *this* machine has. The board keeps the token; only the launch ever holds the answer.
//
// Measured live, not read off the binary's argument tables (Claude Code 2.1.251, comment on #144): a
// `claude --bg` launch carrying `--settings '{"hooks":…}'` fires the Stop hook 4 s later (measured 2026-08-29), in
// the session the daemon actually started. The forwarding path is `handleBgFlag → spawnBgSession`: its
// respawn-flag allowlist keeps `--settings <value>` as a pair when it re-execs into the daemon, and a
// value starting with `{` passes through untouched rather than being resolved as a path. So the
// `claude` and `claude-track` profiles get the hooks too, not just the process-mode ones.
export const HOOK_SETTINGS_VAR = '{hook_settings}';

export const DEFAULT_PROFILES = {
  claude: {
    description: 'Claude Code on this machine as a background agent (free path): visible in `claude agents`, attachable with `claude attach <job>`, runs in a git worktree, opens a draft PR, finishes with one hkb terminal verb. The dispatcher stops the job once the attempt has ended.',
    mode: 'claude-bg',
    // how its workers say "still alive": ref (CAS on the lock ref, free) · comment (a run-record
    // write, floored at 10 min) · auto = ref, falling back to comment where git push cannot reach
    // the repo. Cloud tiers that cannot push arbitrary refs set "comment".
    heartbeat: 'auto',
    max_in_progress: 2,
    model: null,
    effort: null,
    allowed_tools: CLAUDE_TOOLS,
    launch: ['claude', '--bg', '--name', 'kb #{n} · {title}', '--worktree', 'kb-{n}-{k}', '--permission-mode', 'dontAsk', '--allowedTools', '{allowed_tools}', '--disallowedTools', ...CLAUDE_DENY, HOOK_SETTINGS_VAR, '--max-turns', '80', '--max-budget-usd', '5', '{model_args}', '{prompt}'],
  },
  'claude-track': {
    description: 'Claude Code as a TRACK runner: one background session ORCHESTRATES a whole subgraph — a root plus everything it is still blocked by. It does not do the nodes itself: it claims a wave of mutually-independent nodes and hands each to its own isolated subagent (`Agent` with `isolation: "worktree"`), so siblings run at the same time, then collects them and starts the next wave. Every node still goes through the ordinary verbs in its own worktree with its own PR, so every node stays a durable checkpoint and a runner that dies leaves a board the ordinary dispatcher finishes. Put `kb:agent:claude-track` on the root of a decomposed goal (`/kanban:decompose`) and give it a generous `max_runtime` and budget — it is one slot paying for a whole subgraph: the dispatcher claims the root, counts the whole track as ONE running slot, and leaves the nodes alone while the runner holds them. `track_agents` is which node profiles this runner can execute in-session — a track with a node outside that list needs a second harness, so it is not claimable as a track and falls back to node-by-node dispatch. So does a track whose runner has already had one go: the durable engine always finishes.',
    mode: 'claude-bg',
    track: true,
    track_agents: ['claude', 'claude-p', 'claude-track'],
    heartbeat: 'auto',
    max_in_progress: 1,
    model: null,
    effort: null,
    allowed_tools: CLAUDE_TRACK_TOOLS,
    // Sized for a whole subgraph, not a node. The orchestrator's own turns go DOWN once the nodes are
    // subagents — it claims, spawns, collects — but the envelope has to cover every child too: whether
    // `--max-budget-usd` counts subagent tokens was not measurable in the #129 spike without blowing
    // through it, so the budget is set as if it does. A track that runs out mid-wave is not a
    // catastrophe (every finished node is a checkpoint and the ordinary dispatcher takes the rest),
    // but it is a slot spent for less than it could have been.
    launch: ['claude', '--bg', '--name', 'kb track #{n} · {title}', '--worktree', 'kb-{n}-{k}', '--permission-mode', 'dontAsk', '--allowedTools', '{allowed_tools}', '--disallowedTools', ...CLAUDE_DENY, HOOK_SETTINGS_VAR, '--max-turns', '400', '--max-budget-usd', '50', '{model_args}', '{prompt}'],
  },
  'claude-p': {
    description: 'Claude Code headless (`claude -p`): a plain process that exits when done. Not listed in `claude agents`; use it where no session daemon exists (CI, containers).',
    mode: 'process',
    heartbeat: 'auto',
    max_in_progress: 2,
    model: null,
    effort: null,
    allowed_tools: CLAUDE_TOOLS,
    launch: ['claude', '-p', '{prompt}', '--worktree', 'kb-{n}-{k}', '--permission-mode', 'dontAsk', '--allowedTools', '{allowed_tools}', '--disallowedTools', ...CLAUDE_DENY, HOOK_SETTINGS_VAR, '--output-format', 'json', '--max-turns', '80', '--max-budget-usd', '5', '{model_args}'],
  },
  'copilot-cli': {
    description: 'GitHub Copilot CLI on this machine (included in Copilot Free, draws on the plan\'s AI credits). Run `hkb init --harness copilot` first: it writes the `kanban-worker` custom agent and the agentStop hook that enforces the terminal verb. Copilot CLI has no worktree flag, so `workspace: "worktree"` asks the dispatcher to create one. No structured-output flag — the attempt is recorded by the `hkb` calls the worker makes. max_in_progress is 1 because the free credit pool is small.',
    mode: 'process',
    workspace: 'worktree',
    heartbeat: 'auto', // `git *` is allow-listed, so the worker can CAS the lock ref like a Claude one
    max_in_progress: 1,
    model: null,
    allowed_tools: COPILOT_TOOLS,
    launch: ['copilot', '-p', '{prompt}', '--agent', 'kanban-worker', '--allow-tool={allowed_tools}', '--no-ask-user', '--deny-tool', 'shell(git push --force*)', '--deny-tool', 'shell(git push -f*)', '{model_args}'],
  },
  codex: {
    description: 'OpenAI Codex CLI on this machine (`codex exec`, draws on the ChatGPT or API plan). Run `hkb init --harness codex` first: it writes the `.codex/hooks.json` Stop nudge and the notes for the one-time trust Codex needs before it runs project hooks. Codex has no worktree flag, so `workspace: "worktree"` asks the dispatcher to create one and the launch hands it over as `-C`. The sandbox is the permission policy — `workspace-write` makes that worktree writable and everything else read-only — so there is no per-command allowlist. `--output-schema` makes the final message match the terminal-verb schema; the `hkb` verb the worker ran is still the source of truth. See docs/harnesses.md.',
    mode: 'process',
    workspace: 'worktree',
    // `git *` runs inside the sandbox, so a Codex worker CASes the lock ref like a Claude one —
    // but only once `network_access` is on for workspace-write (docs/harnesses.md).
    heartbeat: 'auto',
    max_in_progress: 1,
    model: null,
    allowed_tools: null, // Codex has no per-command allowlist: `--sandbox` is the whole policy
    launch: ['codex', 'exec', '-C', '{worktree}', '--sandbox', 'workspace-write', '--output-schema', '.agents/skills/kanban/schema/terminal.json', '{model_args}', '{prompt}'],
  },
};

/**
 * Profiles hkb used to ship and no longer does. A board.json written by an older hkb still names one
 * — this repo's own did — and that file is the operator's, so hkb neither throws on it nor keeps a
 * profile it cannot launch: `loadBoard` drops the entry and records it, the tick skips its cards
 * naming the re-point, `hkb doctor` reports it, and `hkb init` deletes it from the file.
 *
 * Keyed by NAME as well as by the mode the profile ran under, because the shape an operator writes to
 * tweak a built-in carries no mode at all: `"claude-action": {}` merged over a default that no longer
 * exists is an empty object, and a `mode`-only check never fires on it.
 */
export const REMOVED_PROFILES = {
  'claude-action': 'the GitHub Actions runner was removed in ADR-006 — the board\'s store is local and single-host, and a dispatcher inside Actions cannot read it',
};

/**
 * Why this profile can no longer be loaded, or null. Pure: the name and the merged body, no I/O.
 * @param {string} name
 * @param {any} p the profile as merged over its default
 * @returns {string|null}
 */
export function removedProfile(name, p) {
  if (Object.hasOwn(REMOVED_PROFILES, name)) return REMOVED_PROFILES[name];
  if (p && p.mode === 'trigger') return 'the "trigger" mode went with the GitHub Actions runner in ADR-006';
  return null;
}

export const DEFAULT_BOARD = {
  version: 1,
  repo: null,
  board: 'default',
  // Version of the skill `hkb init` copied into .agents/skills/kanban; null when the skill is
  // linked instead of copied (the hkb package repo itself) and so cannot go stale. See init.js.
  skill_version: null,
  // Is this checkout allowed to ask npm, once a day, whether the hkb running it is old?
  // `hkb doctor` and the dispatcher loop are the only callers, and a pinned install sets it false:
  // running an old hkb on purpose is a choice, and a daily nag about a choice is friction. See doctor.js.
  version_check: true,
  dispatch: {
    interval: 60,
    max_in_progress: 2,
    stale_after: 3600,
    max_runtime_default: 3600,
    failure_limit: 2,
    block_recurrence_limit: 3,
    auth_pause: 1800,
    recent_success_window: 600,
    // path_overlap avoids the *merge* conflict when two PRs touch the same files — not left here as
    // a static default, because its right default depends on `merge.mode` (`pathOverlapGuard`,
    // src/model.js): "off" on the manual boards most of them are (a card waits on a human between
    // review and merge, so "another card is running" no longer approximates "not merged yet"),
    // "unmerged" when `merge.mode` is "auto" (where review → merged is immediate, so it does). Set
    // `guards: { path_overlap: "off" | "running" | "unmerged" }` to override either default; the
    // pre-#185 `path_guard: true|false` still works too, for a board that already set it.
    guards: { path_overlap: null },
    daily_spawn_cap: 40,
    // The last step. "manual" is today's behaviour: hkb never merges, the operator does, by hand,
    // on GitHub. "operator" delegates the click to whoever drives the operator seat, but only once
    // a review is on the card — `hkb merge <n>` enforces that condition and writes down that it
    // was met; see `mergePolicy`/`mergeDecision` in src/model.js. Set { "mode": "auto", "method":
    // "squash" } and the dispatcher asks GitHub's own auto-merge to land a reviewed card's PR once
    // the branch's required checks go green — one mutation per PR, and `hkb doctor` refuses the
    // mode outright on a branch with nothing to wait for. `require: { checks, review_comment }`
    // (both default true) only apply to "operator".
    merge: { mode: 'manual', method: 'squash' },
  },
  profiles: DEFAULT_PROFILES,
};

export function repoRoot(cwd = process.cwd()) {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (res.status === 0) return res.stdout.trim();
  return cwd;
}

export function kanbanDir(root) { return path.join(root, '.kanban'); }
export function boardFile(root) { return path.join(kanbanDir(root), 'board.json'); }
export function logsDir(root) { return path.join(kanbanDir(root), 'logs'); }
export function outboxFile(root) { return path.join(kanbanDir(root), 'outbox.jsonl'); }
export function stateFile(root) { return path.join(kanbanDir(root), 'state.json'); }

// ---------- the long-running processes: dispatcher and web board ----------
// `.kanban/<name>.pid` is written by the process itself (the dispatcher's singleton lock, the
// server's claim) and by `hkb up` for the child it just spawned, so a second `up` a millisecond
// later sees a live pid rather than starting a rival. One pid per line, nothing else: `hkb serve`
// and `hkb doctor` both read these files, and a format is a contract.

export function pidFile(root, name) { return path.join(kanbanDir(root), `${name}.pid`); }
export function processLogFile(root, name) { return path.join(logsDir(root), `${name}.log`); }

// `serve.url` is the one fact `.kanban/serve.pid` cannot carry — a pid is a bare number, and the URL
// is the whole reason a human runs `--serve`. `hkb up` pre-writes it from the port it is about to
// spawn with (the same reasoning as `claimPid`: idempotence cannot wait for the child to boot), and
// `hkb serve` overwrites it with the real bound origin once the port is actually open — the one place
// port 0 (OS-assigned) or a raced default can differ from the guess.
export function serveUrlFile(root) { return path.join(kanbanDir(root), 'serve.url'); }
export function readServeUrl(root) { try { return fs.readFileSync(serveUrlFile(root), 'utf8').trim() || null; } catch { return null; } }
export function writeServeUrl(root, url) {
  fs.mkdirSync(kanbanDir(root), { recursive: true });
  fs.writeFileSync(serveUrlFile(root), url + '\n');
}
export function dropServeUrl(root) { try { fs.rmSync(serveUrlFile(root), { force: true }); } catch { /* gone */ } }

/** Is that pid a live process? EPERM means alive and not ours, which is still alive. */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** `/proc/<pid>/cmdline`, raw (NUL-joined argv) — null if there is no `/proc` or the pid is gone. */
function readCmdline(pid, proc) {
  if (!pid) return null;
  try { return fs.readFileSync(path.join(proc, String(pid), 'cmdline'), 'utf8'); } catch { return null; }
}

/**
 * The kernel-reported boot instant, in epoch seconds — `/proc/stat`'s `btime` on Linux, `sysctl -n
 * kern.boottime` on macOS — or null where neither is available (`pidFileStale` then derives boot
 * from `os.uptime()` instead).
 */
function readBtimeSec(proc) {
  if (process.platform === 'darwin') {
    try { return parseKernBoottimeSec(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' })); } catch { return null; }
  }
  try { return parseBtimeSec(fs.readFileSync(path.join(proc, 'stat'), 'utf8')); } catch { return null; }
}

/**
 * The pid a pid file names, when it was written (mtime — the process wrote it as it started), and
 * whether that claim survived a reboot: a file older than this boot names a pid the kernel has since
 * handed to somebody else, so `stale` is the difference between stopping the dispatcher and stopping
 * a stranger. The timestamp verdict is corroborated against `/proc/<pid>/cmdline` before it is acted
 * on (`pidClaimStale`) — a live pid whose argv still says `hkb dispatch --loop` / `hkb serve` is ours
 * whatever the arithmetic says (WSL2's clock resyncing across suspend/resume walks the derived boot
 * instant past pid files written earlier in the same session, #205); a live pid that does not match
 * stays refused (#202's reused-pid case). Every caller that acts on a pid — `processState`, the
 * dispatcher's singleton lock, the server's claim — must read `stale` as "there is no claim here".
 * `proc` is injected so a test can fake `/proc` without a real reboot or a real stranger process.
 */
export function readPidFile(root, name, { proc = '/proc' } = {}) {
  try {
    const file = pidFile(root, name);
    const pid = Number(fs.readFileSync(file, 'utf8').trim()) || null;
    const at = fs.statSync(file).mtime.toISOString();
    const alive = pidAlive(pid);
    const stale = pidClaimStale(/** @type {any} */ ({
      at, name, alive, cmdline: alive ? readCmdline(pid, proc) : null,
      uptime: os.uptime(), btimeSec: readBtimeSec(proc),
    }));
    return { pid, at, stale };
  } catch { return { pid: null, at: null, stale: false }; }
}

/**
 * Why a process that is not running stopped, when it stopped on its own terms. Exit code 4 is the
 * dispatcher loop giving itself up for a supervisor; nothing here restarts it, but `hkb up --status`
 * has to be able to say that is what happened rather than reporting a plain "stopped".
 *
 * It lives in `state.json` — already local, already gitignored — so the feature costs no new file.
 */
export function recordExit(root, name, entry) {
  const state = readState(root);
  writeState(root, { ...state, exits: { ...(state.exits || {}), [name]: entry } });
}

export function readExit(root, name) { return readState(root).exits?.[name] || null; }

/** Forget a recorded exit — the process is starting again, so its last death is no longer the news. */
export function clearExit(root, name) {
  const state = readState(root);
  if (!state.exits?.[name]) return;
  const exits = { ...state.exits };
  delete exits[name];
  writeState(root, { ...state, exits });
}

/**
 * One process's state for `hkb up`, `hkb up --status`, `hkb down` and `hkb doctor`: the pid file, a
 * liveness check and the exit record. No board read, no network — this is the filesystem answering.
 */
export function processState(root, name) {
  const { pid, at, stale } = readPidFile(root, name);
  const running = !stale && pidAlive(pid);
  const exit = running ? null : readExit(root, name);
  return {
    name,
    running,
    pid: running ? pid : null,
    since: running ? at : null,
    stale: !!stale,
    log: path.relative(root, processLogFile(root, name)),
    exit: exit?.code ?? null,
    exited_at: exit?.at ?? null,
    ...(name === 'serve' ? { url: running ? readServeUrl(root) : null } : {}),
  };
}

export function ensureLocalDirs(root) {
  fs.mkdirSync(logsDir(root), { recursive: true });
  fs.mkdirSync(path.join(kanbanDir(root), 'nudges'), { recursive: true });
}

/**
 * The worktree for a profile that carries `workspace: "worktree"`, created if missing.
 * Harnesses with their own flag (Claude Code `--worktree kb-<n>-<k>`) never come here; Copilot CLI
 * has none, so the dispatcher makes the checkout itself — in the same `.claude/worktrees/` directory
 * Claude Code uses, so one `hkb gc` sweeps both. A worktree that already exists is reused: names are
 * unique per attempt, so that only happens when a previous spawn died between `add` and the launch.
 * @returns the absolute path to the worktree
 */
export function ensureWorktree(root, name) {
  const dir = path.join(root, worktreePath(name));
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = (args) => spawnSync('git', ['worktree', 'add', ...args], { cwd: root, encoding: 'utf8' });
  let r = add([dir, '-b', name]);
  // a branch left behind by an earlier attempt (worktree removed, branch not) — check it out instead
  if (r.status !== 0 && /already exists/i.test(r.stderr || '')) r = add([dir, name]);
  if (r.status !== 0) {
    const e = new Error(`git worktree add ${worktreePath(name)} failed: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`);
    e.exitCode = 2;
    throw e;
  }
  return dir;
}

const lastLine = (s) => String(s || '').trim().split('\n').pop() || '';

/**
 * Which worktree of this checkout has `branch` checked out, if any — `{path, branch, locked}`.
 * git refuses to check one branch out twice, so this is the question that has to be answered before
 * a PR's branch can be reused. (`src/gc.js` owns the general listing and the sweeps; it imports this
 * file, so the one question the dispatcher asks is answered here rather than borrowed from there.)
 */
function worktreeHolding(root, branch) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const list = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = /** @type {{path: string, branch?: string, locked?: string}} */ ({ path: line.slice(9) }); list.push(cur); }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('locked') && cur) cur.locked = line.slice(6).trim() || 'locked';
  }
  return list.find((w) => w.branch === branch) || null;
}

/**
 * The worktree for an attempt that **continues an open PR**: the same `.claude/worktrees/kb-<n>-<k>`
 * every other attempt gets, but checked out on the PR's own head branch instead of a fresh one, so
 * the attempt pushes to the PR the reviewer sent back rather than opening a second one (#153).
 *
 * The branch is fetched first (the PR may have been pushed from another host), and when the previous
 * attempt's worktree still holds it — the usual case, since a card sitting in `review` is swept by
 * nothing — that checkout is removed so git will hand the branch over. Only a worktree of **this**
 * task is ever freed, and never one a live session still holds: `alive` is asked about the pid in
 * the lock Claude Code writes, exactly as `hkb gc` does, and its default answer is "yes, leave it".
 * `git worktree remove` takes the checkout, not the commits — the branch itself survives.
 *
 * Never throws: a refusal is `{ok: false, why}` and the caller falls back to an ordinary fresh
 * worktree plus a brief that names the PR to continue (`src/context.js`).
 *
 * `git worktree add <dir> <branch>` checks out the *local* branch as it already is — the fetch above
 * only updates `origin/<branch>`, so a human (or another host) pushing to the PR since the last
 * attempt leaves this checkout one or more commits behind, and its own eventual `git push` would be
 * rejected non-fast-forward. Local commits the checkout has and the remote does not are never
 * `stale` on their own — only `git merge --ff-only origin/<branch>` failing is: a plain fast-forward
 * catches it up silently, a real divergence names why in `stale`, and the caller falls back to the
 * recipe block instead of claiming the checkout is already at the PR's head.
 * @param {string} root
 * @param {string} name
 * @param {string|null} branch
 * @param {{number?: number|null, remote?: string, alive?: (pid: number) => boolean}} [opts]
 * @returns {{ok: true, path: string, branch: string, freed: string|null, stale: string|null} | {ok: false, why: string, path?: undefined, branch?: undefined, freed?: undefined, stale?: undefined}}
 */
export function worktreeOnBranch(root, name, branch, { number = null, remote = 'origin', alive = () => true } = {}) {
  if (!branch) return { ok: false, why: 'the board query returned no head branch for the PR' };
  const dir = path.join(root, worktreePath(name));
  // capped: this runs inside a tick, and a hung fetch must not hold the loop past its interval
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  // a repo with no <remote>/<branch> ref (fetch never ran, or it failed and this is the first time
  // this branch was ever fetched) has nothing to fast-forward to — distinct from a real divergence,
  // and worth saying so rather than reporting the same generic "could not fast-forward"
  const fastForwardToRemote = (cwd) => {
    const hasRef = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${remote}/${branch}`], { cwd, encoding: 'utf8' }).status === 0;
    if (!hasRef) return `no ${remote}/${branch} ref to catch up to (fetch may have failed)`;
    const ff = spawnSync('git', ['merge', '--ff-only', `${remote}/${branch}`], { cwd, encoding: 'utf8', timeout: 60_000 });
    return ff.status === 0 ? null : `could not fast-forward to ${remote}/${branch}: ${lastLine(ff.stderr) || `exit ${ff.status}`}`;
  };
  if (fs.existsSync(path.join(dir, '.git'))) {
    // a spawn that died between the checkout and the launch: reuse it if it is already the right one
    const head = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout?.trim();
    if (head !== branch) return { ok: false, why: `${worktreePath(name)} already exists on ${head || 'a detached HEAD'}` };
    git(['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    return { ok: true, path: dir, branch, freed: null, stale: fastForwardToRemote(dir) };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // best effort: no remote, no network, or a branch only this host has must not stop the checkout
  git(['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  let freed = null;
  const holder = worktreeHolding(root, branch);
  if (holder) {
    if (number == null || !path.basename(holder.path).startsWith(`kb-${number}-`)) return { ok: false, why: `${branch} is checked out in ${holder.path}` };
    const pid = Number(/pid (\d+)/.exec(holder.locked || '')?.[1] || 0);
    if (holder.locked && (!pid || alive(pid))) return { ok: false, why: `${branch} is checked out in ${holder.path}, held by a live session${pid ? ` (pid ${pid})` : ''}` };
    if (holder.locked) git(['worktree', 'unlock', holder.path]);
    const rm = git(['worktree', 'remove', '--force', holder.path]);
    if (rm.status !== 0) return { ok: false, why: `could not free ${branch} from ${holder.path}: ${lastLine(rm.stderr) || `exit ${rm.status}`}` };
    freed = holder.path;
  }
  git(['worktree', 'prune']); // a directory deleted by hand still holds its branch until this runs
  // `git worktree add <dir> <branch>` reuses the local branch, or DWIMs one tracking <remote>/<branch>
  let r = git(['worktree', 'add', dir, branch]);
  if (r.status !== 0) r = git(['worktree', 'add', '--track', '-b', branch, dir, `${remote}/${branch}`]);
  if (r.status !== 0) return { ok: false, why: `git worktree add ${worktreePath(name)} ${branch} failed: ${lastLine(r.stderr) || `exit ${r.status}`}` };
  // best effort: catch the local branch up to what was actually fetched, so an ordinary push from
  // this checkout lands — a diverged local branch is reported, never forced
  return { ok: true, path: dir, branch, freed, stale: fastForwardToRemote(dir) };
}

/**
 * Is `hkb` on PATH? Tracked files a global install serves (`--shared-hooks`, the harness hook files,
 * `.mcp.json`) name the bare binary when it is; the worker launch line prefers this checkout's
 * `bin/hkb.js` whenever it is durable, because a hook started by the session daemon inherits a PATH
 * that may have neither.
 *
 * The PATH asked about is the one *those* processes get, which is not this one's: `npx hkb init` and
 * `npm run` both prepend `node_modules/.bin`, so an unfiltered lookup answers yes for a repo that
 * only installed hkb as a dependency and the generated command then resolves nowhere else (#146).
 */
export function hkbOnPath() {
  const env = { ...process.env, PATH: stripNodeModulesBin(process.env.PATH || '', path.delimiter) };
  const which = spawnSync('sh', ['-c', 'command -v hkb'], { encoding: 'utf8', env });
  return which.status === 0 && !!which.stdout.trim();
}

export function detectRepo() {
  const out = ghCmd(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
  const j = JSON.parse(out);
  const [owner, repo] = j.nameWithOwner.split('/');
  return { owner, repo, nameWithOwner: j.nameWithOwner, defaultBranch: j.defaultBranchRef?.name || 'main' };
}

/**
 * A Claude launch frozen in `board.json` before the hooks moved onto it (#144). Pure.
 *
 * `loadBoard` deep-merges the file over hkb's defaults and an array in the file wins whole, so a
 * board whose `launch` was written out by an earlier `init` keeps that array forever — and a re-run
 * of `init` writes it straight back. The same frozen-copy blind spot `worker permissions` watches
 * for on `allowed_tools` (#138/#145), and here it costs a worker its Stop nudge and its session id,
 * because nothing is being written into a settings file to make up for it any more.
 */
export function staleHookLaunches(cfg) {
  return Object.entries(cfg?.profiles || {})
    .filter(([, p]) => (p?.launch || [])[0] === 'claude' && !p.launch.includes(HOOK_SETTINGS_VAR))
    .map(([n]) => n);
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base?.[k], v);
  return out;
}

export function loadBoard(root) {
  const file = boardFile(root);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    const err = new Error(`${file} is not valid JSON: ${e.message}`);
    err.exitCode = 2;
    throw err;
  }
  const cfg = deepMerge(DEFAULT_BOARD, raw);
  // profiles: keep only what the user declared, each merged over the default of the same name
  cfg.profiles = {};
  for (const [name, p] of Object.entries(raw.profiles || DEFAULT_PROFILES)) {
    // A `null` (or a string, or a list) here is how a human "removes" a profile in JSON; without this
    // it reaches the validators below as a TypeError with no file and no fix in it.
    if (p == null || typeof p !== 'object' || Array.isArray(p)) {
      const err = new Error(`profile "${name}" in ${file} is ${Array.isArray(p) ? 'a list' : JSON.stringify(p)} — a profile must be an object. Remove the entry to drop the profile, or give it a body.`);
      err.exitCode = 2;
      throw err;
    }
    cfg.profiles[name] = deepMerge(DEFAULT_PROFILES[name] || {}, p);
  }
  // Profiles this hkb no longer has (see REMOVED_PROFILES). Dropped rather than refused: a throw here
  // reaches every command through `makeContextAt`, including `hkb doctor` and `hkb init` — the two
  // verbs that could repair the file — and a worker's terminal verbs, which would strand an attempt
  // over a profile it never used. Recorded on the config so the tick, doctor and init can each say
  // the same thing about it.
  // Non-enumerable so it never reaches board.json: `hkb init` saves the config it loaded, and this
  // is a fact about *this* load, not a field the operator owns.
  Object.defineProperty(cfg, 'removed_profiles', { value: [], writable: true, enumerable: false });
  for (const [name, p] of Object.entries(cfg.profiles)) {
    const why = removedProfile(name, p);
    if (!why) continue;
    cfg.removed_profiles.push({ name, why });
    delete cfg.profiles[name];
  }
  // `effort` renders `--effort <v>` through `{model_args}` (#182) — the one other thing a launch used
  // to be pinned for. Validated here, once, so a typo fails loudly at load time rather than as a flag
  // value the harness itself rejects.
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (p.effort != null && !EFFORT_LEVELS.includes(p.effort)) {
      const err = new Error(`profile "${name}" has effort "${p.effort}" in ${file} — must be one of ${EFFORT_LEVELS.join(', ')}`);
      err.exitCode = 2;
      throw err;
    }
  }
  // `{model_args}` renders `--effort <v>` on whatever launch carries it, but only Claude Code has a
  // verified `--effort` flag (#188 — measured: `codex exec --effort high` and `copilot ... --effort
  // high` both die on the CLI's own "unknown option" before the worker gets a turn). Refuse it at
  // load, the same as an unknown level above, rather than let the first spawn discover it. Every
  // built-in non-Claude profile has `launch[0]` name its harness (`codex`, `copilot`), so that is
  // what the message points at.
  for (const [name, p] of Object.entries(cfg.profiles)) {
    const harness = (p.launch || [])[0];
    if (p.effort != null && harness !== 'claude') {
      const err = new Error(`profile "${name}" sets effort, but its harness (${harness || name}) takes no --effort flag; remove it`);
      err.exitCode = 2;
      throw err;
    }
  }
  // A profile's tool posture (#256): "inherit" or "curate", validated the same way as effort above —
  // once, at load, so a typo fails loudly here rather than reaching a launch line silently as
  // "curate" (the resolver's default for anything it does not recognise as "inherit").
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (p.tools != null && !TOOL_POSTURES.includes(p.tools)) {
      const err = new Error(`profile "${name}" has tools "${p.tools}" in ${file} — must be one of ${TOOL_POSTURES.join(', ')}`);
      err.exitCode = 2;
      throw err;
    }
    // `mcp` is a list of server names, and its *shape* is checked here for the same reason: the
    // resolver is defensive about junk, so a non-list would otherwise be read as "declared nothing"
    // and a board that meant to exclude a production server would silently grant it. Names only —
    // whether a named server exists is a `.mcp.json` question `hkb doctor` is the place to ask.
    if (p.mcp != null && (!Array.isArray(p.mcp) || p.mcp.some((s) => typeof s !== 'string' || !s.trim()))) {
      const err = new Error(`profile "${name}" has mcp ${JSON.stringify(p.mcp)} in ${file} — must be an array of server names, the servers a worker may reach under "tools": "curate" and the ones to exclude under "inherit"`);
      err.exitCode = 2;
      throw err;
    }
  }
  // `capabilities` binds an intent from the closed `CAPABILITIES` vocabulary to what *this* harness
  // calls it (#217). Validated here, once, for the same reason `effort` is: the alternative is a
  // worker being told to run a command from a typo'd intent nothing will ever bind. An *unbound*
  // intent is not an error — that is the fallback to today's prose brief — but an intent hkb has
  // never heard of is, and the message names the vocabulary so the fix is a rename, not a search.
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (p.capabilities == null) continue;
    const fail = (msg) => {
      const err = new Error(`profile "${name}" in ${file}: ${msg}`);
      err.exitCode = 2;
      throw err;
    };
    if (typeof p.capabilities !== 'object' || Array.isArray(p.capabilities)) {
      fail(`"capabilities" must be an object mapping an intent to this harness's command, e.g. {"review": "/code-review"}`);
    }
    for (const [intent, command] of Object.entries(p.capabilities)) {
      if (!Object.hasOwn(CAPABILITIES, intent)) {
        fail(`unknown capability "${intent}" — must be one of ${Object.keys(CAPABILITIES).join(', ')}`);
      }
      if (typeof command !== 'string' || !command.trim()) {
        fail(`capability "${intent}" must name this harness's command as a non-empty string`);
      }
    }
  }
  return cfg;
}

export function saveBoard(root, cfg) {
  fs.mkdirSync(kanbanDir(root), { recursive: true });
  fs.writeFileSync(boardFile(root), JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * `loadBoard`, but a hook is a guard rail and a guard rail that cannot read its own config must
 * stand aside, never lock the door (#184): `error` carries `loadBoard`'s message instead of a throw.
 * `cfg: null, error: null` is a board.json that plainly does not exist — nothing to say about that.
 */
export function loadBoardSafe(root) {
  try { return { cfg: loadBoard(root), error: null }; } catch (e) { return { cfg: null, error: e.message }; }
}

/**
 * The checkout whose board.json a hook should trust for policy: `KB_ROOT`'s when set, the worktree
 * running the hook only when it is not. `KB_ROOT` names the dispatcher's own checkout, which is never
 * mid-merge or half-edited the way a worker's own worktree can be — so it is not a fallback preference,
 * it is the answer whenever it exists, on purpose: a worker whose board.json a hook read instead could
 * loosen its own allowlist by editing the file it is supposed to be policed by (#184).
 */
export function hookBoardRoot(root, env = process.env) {
  return env.KB_ROOT ? path.resolve(env.KB_ROOT) : root;
}

export function readState(root) {
  try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return {}; }
}
export function writeState(root, state) {
  fs.mkdirSync(kanbanDir(root), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify(state, null, 2) + '\n');
}

export function hostId() { return os.hostname(); }

/**
 * Build the context object every command uses, rooted at `root`.
 * `board` argument > board.json > 'default'.
 */
export function makeContextAt(root, { board = null, json = false } = {}) {
  const cfg = loadBoard(root);
  const repo = cfg?.repo ? parseRepo(cfg.repo) : null;
  return {
    root,
    cfg,
    repo,
    board: board || cfg?.board || 'default',
    host: hostId(),
    json,
    caps: {},
    _cache: {},
    requireBoard() {
      if (!cfg) {
        const e = new Error(`no .kanban/board.json in ${root}. Run \`hkb init\` first.`);
        e.exitCode = 2;
        throw e;
      }
      if (!repo) {
        const e = new Error(`${boardFile(root)} has no "repo". Run \`hkb init\` again or set "repo": "owner/name".`);
        e.exitCode = 2;
        throw e;
      }
      return this;
    },
  };
}

/**
 * The context for the checkout the command was run in.
 * `board` flag > KB_BOARD env > board.json > 'default'.
 */
export function makeContext(flags = {}) {
  return makeContextAt(repoRoot(), { board: flags.board || process.env.KB_BOARD || null, json: !!flags.json });
}

/**
 * The context a hook runs with — never throws, unlike `makeContext`/`makeContextAt`.
 *
 * `ctx.root` stays the worktree the hook is actually running in (session files, `whichAttempt` all
 * key off it), but `ctx.cfg` — the policy `preToolHook` and `stopHook` apply — comes from
 * `hookBoardRoot`: `KB_ROOT`'s board when set, this worktree's own file only when it is not (#184).
 * `ctx.cfgError` names why that load failed, so a hook that finds it set can print one stderr line
 * and stand aside instead of falling through to a "no profile"/"can't read #n" message that would
 * misdiagnose a corrupt file as a missing one.
 */
export function makeHookContext(flags = {}, env = process.env) {
  const root = repoRoot();
  const cfgRoot = hookBoardRoot(root, env);
  const { cfg, error } = loadBoardSafe(cfgRoot);
  const repo = cfg?.repo ? parseRepo(cfg.repo) : null;
  return {
    root,
    cfg,
    cfgError: error,
    repo,
    board: flags.board || env.KB_BOARD || cfg?.board || 'default',
    host: hostId(),
    json: !!flags.json,
    caps: {},
    _cache: {},
    requireBoard() {
      if (!cfg) {
        const e = new Error(error ? `${boardFile(cfgRoot)} is unreadable (${error})` : `no .kanban/board.json in ${cfgRoot}. Run \`hkb init\` first.`);
        e.exitCode = 2;
        throw e;
      }
      if (!repo) {
        const e = new Error(`${boardFile(cfgRoot)} has no "repo". Run \`hkb init\` again or set "repo": "owner/name".`);
        e.exitCode = 2;
        throw e;
      }
      return this;
    },
  };
}

// ---------- the cross-repo board list ----------
// `hkb serve` can show several checkouts on one page. That list spans repos, so it cannot live in
// any one `.kanban/` — it is a user-level file, JSON because hkb has no YAML parser and wants none.

/** `$KB_CONFIG_HOME`/`$XDG_CONFIG_HOME`/`~/.config` + `hkb/boards.json`. */
export function userBoardsFile() {
  const base = process.env.KB_CONFIG_HOME || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'hkb', 'boards.json');
}

/** `~/code/a` → an absolute path. No shell runs here, so `~` is expanded by hand or not at all. */
export function expandHome(p) {
  const s = String(p);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/**
 * The user-level list of checkouts `hkb serve` shows together:
 *   { "version": 1, "boards": ["~/code/a", { "path": "~/code/b", "board": "release" }] }
 * A bare JSON array of paths works too. Missing file → null: the list is opt-in, never required.
 * @returns {null | {path: string, board: string|null}[]}
 */
export function loadUserBoards(file = userBoardsFile()) {
  const list = rawUserBoards(file);
  if (list === null) return null;
  return parseRepoSpecs(list).map((s) => ({ ...s, path: expandHome(s.path) }));
}

/**
 * The entries of the user list exactly as they are written — a writer has to keep the spellings a
 * human chose, which `loadUserBoards` deliberately resolves away. Missing file → null; malformed
 * file → the same exitCode 2 refusal, thrown before anything is written.
 */
function rawUserBoards(file) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    const err = new Error(`${file} is not valid JSON: ${e.message}`);
    err.exitCode = 2;
    throw err;
  }
  const list = Array.isArray(raw) ? raw : raw?.boards ?? raw?.repos;
  if (!Array.isArray(list)) {
    const err = new Error(`${file} must be {"boards": ["/path/to/checkout", ...]} or a JSON array of paths`);
    err.exitCode = 2;
    throw err;
  }
  return list;
}

/**
 * Write the user list as `{ "version": 1, "boards": [...] }` — a bare array on input comes back in
 * the object shape, which is the one the README documents.
 *
 * Atomic on purpose: `hkb serve` reads this file while other commands add to it, so the write goes
 * to a temp file in the same directory and is `rename`d over the target. A reader sees the old list
 * or the new one, never half of one, and a crash mid-write cannot truncate a file a human maintains.
 * @returns the file it wrote
 */
export function saveUserBoards(list, file = userBoardsFile()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, boards: list }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/**
 * The main checkout `root` belongs to. Inside a linked worktree — a worker's `.claude/worktrees/
 * kb-99-1`, say — `git rev-parse --show-toplevel` answers with the worktree, which is a throwaway
 * directory nobody wants on a board list; the common git dir points back at the real checkout.
 * Anything unexpected (no git, a bare repo, a path that is gone) keeps `root`.
 */
export function mainWorktree(root) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return root;
  const common = path.resolve(root, r.stdout.trim());
  if (path.basename(common) !== '.git') return root;
  const main = path.dirname(common);
  return fs.existsSync(main) ? main : root;
}

/**
 * Where the board itself lives — the one directory every store driver agrees on.
 *
 * The `kb-board` branch and the `.git/hkb/index.db` index are per *repository*, not per worktree:
 * a worker beating from `.claude/worktrees/kb-99-1` and the loop ticking in the main checkout must
 * open the same store or they are two boards that happen to share a name. So this is the common
 * git directory's parent — `mainWorktree` — and never `git rev-parse --show-toplevel`, which in a
 * linked worktree answers with the throwaway directory (docs/local-first.md §6.2).
 *
 * The GitHub store ignores it: its board is the repo on GitHub, and `ctx.root` still names the
 * checkout a heartbeat pushes from. The local tiers (A4, A5) key everything off it.
 */
export function storeRoot(ctx) {
  if (typeof ctx === 'string') return mainWorktree(ctx);
  const root = ctx?.root || process.cwd();
  // One `git rev-parse --git-common-dir` per process per ctx: the answer cannot change while this
  // process runs, and `root()` is an accessor a caller will reasonably reach for in a loop.
  if (ctx && ctx._cache) {
    if (!ctx._cache.storeRoot) ctx._cache.storeRoot = mainWorktree(root);
    return ctx._cache.storeRoot;
  }
  return mainWorktree(root);
}

/**
 * Put a checkout on the user-level list, once. Idempotent by resolved path plus board slug, so
 * registering `/home/you/code/web` when `~/code/web` is already listed changes nothing, and a
 * worker's worktree registers its main checkout instead of itself.
 *
 * The file is only rewritten when the list actually grew; a missing one is created, a malformed one
 * is refused (exitCode 2) rather than clobbered.
 * @returns {{added: boolean, file: string, entries: number}}
 */
export function registerUserBoard(root, board = null, file = userBoardsFile()) {
  const current = rawUserBoards(file) || [];
  const abs = mainWorktree(path.resolve(expandHome(root)));
  const { entries, added } = mergeBoardEntry(current, { path: abs, board }, (p) => path.resolve(expandHome(p)));
  if (added) saveUserBoards(entries, file);
  return { added, file, entries: entries.length };
}

/**
 * A context for another checkout, named by path. The path may point anywhere inside the repo — the
 * toplevel is what a board is keyed on — and must be an `hkb init`ed checkout, or this says so.
 */
export function contextForPath(p, board = null) {
  const abs = path.resolve(expandHome(p));
  if (!fs.existsSync(abs)) {
    const e = new Error(`${p} does not exist — name a checkout that has been \`hkb init\`ed`);
    e.exitCode = 2;
    throw e;
  }
  return makeContextAt(repoRoot(abs), { board }).requireBoard();
}

export function parseRepo(s) {
  const [owner, repo] = String(s).split('/');
  if (!owner || !repo) return null;
  return { owner, repo, nameWithOwner: `${owner}/${repo}` };
}

export function api(ctx, suffix = '') { return `repos/${ctx.repo.owner}/${ctx.repo.repo}${suffix}`; }
