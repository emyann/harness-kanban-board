// Board configuration (.kanban/board.json), repo detection, local paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghCmd } from './gh.js';
import { worktreePath, parseRepoSpecs } from './model.js';

// A background worker has nobody to answer a permission prompt, so the allowlist must cover
// every command an agent plausibly reaches for; anything else is denied, never prompted (see #23).
const SHELL_TOOLS = ['hkb *', 'git *', 'gh pr *', 'gh issue view *', 'npm *', 'npx *', 'node *', 'cat *', 'ls *', 'mkdir *', 'head *', 'tail *', 'wc *', 'sed *', 'awk *', 'grep *', 'find *', 'diff *', 'cp *', 'mv *', 'touch *', 'chmod *', 'printf *', 'echo *', 'jq *'];
const CLAUDE_TOOLS = [...SHELL_TOOLS.map((c) => `Bash(${c})`), 'Bash(true)', 'Edit', 'Write', 'Read', 'Glob', 'Grep'];
// Copilot CLI spells the same policy `--allow-tool 'shell(<cmd>)'`, one flag per pattern, plus the
// built-in `write` tool for file edits. See the `--allow-tool={allowed_tools}` token in dispatch.js.
// Copilot wildcards are `shell(cmd:*)` (verified against the CLI programmatic reference, 2026-08-26);
// a multiword prefix like `gh pr *` has no wildcard form, so it widens to the command's `cmd:*`.
const COPILOT_TOOLS = [...new Set(SHELL_TOOLS.map((c) => c.includes('*') ? `shell(${c.split(' ')[0]}:*)` : `shell(${c})`)), 'write'];

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
    allowed_tools: CLAUDE_TOOLS,
    launch: ['claude', '--bg', '--name', 'kb #{n} · {title}', '--worktree', 'kb-{n}-{k}', '--permission-mode', 'dontAsk', '--allowedTools', '{allowed_tools}', '--disallowedTools', 'Bash(git push --force*)', 'Bash(git push -f*)', '--max-turns', '80', '--max-budget-usd', '5', '{model_args}', '{prompt}'],
  },
  'claude-track': {
    description: 'Claude Code as a TRACK runner: one background session executes a whole subgraph — a root plus everything it is still blocked by — claiming, working and finishing each node through the ordinary verbs, so every node stays a durable checkpoint. Put `kb:agent:claude-track` on the root of a decomposed goal (`/kanban:decompose`) and give it a generous `max_runtime`: the dispatcher claims the root, counts the whole track as ONE running slot, and leaves the nodes alone while the runner holds them. `track_agents` is which node profiles this runner can execute in-session — a track with a node outside that list needs a second harness, so it is not claimable as a track and falls back to node-by-node dispatch. So does a track whose runner has already had one go: the durable engine always finishes.',
    mode: 'claude-bg',
    track: true,
    track_agents: ['claude', 'claude-p', 'claude-track'],
    heartbeat: 'auto',
    max_in_progress: 1,
    model: null,
    allowed_tools: CLAUDE_TOOLS,
    launch: ['claude', '--bg', '--name', 'kb track #{n} · {title}', '--worktree', 'kb-{n}-{k}', '--permission-mode', 'dontAsk', '--allowedTools', '{allowed_tools}', '--disallowedTools', 'Bash(git push --force*)', 'Bash(git push -f*)', '--max-turns', '400', '--max-budget-usd', '25', '{model_args}', '{prompt}'],
  },
  'claude-p': {
    description: 'Claude Code headless (`claude -p`): a plain process that exits when done. Not listed in `claude agents`; use it where no session daemon exists (CI, containers).',
    mode: 'process',
    heartbeat: 'auto',
    max_in_progress: 2,
    model: null,
    allowed_tools: CLAUDE_TOOLS,
    launch: ['claude', '-p', '{prompt}', '--worktree', 'kb-{n}-{k}', '--permission-mode', 'dontAsk', '--allowedTools', '{allowed_tools}', '--disallowedTools', 'Bash(git push --force*)', 'Bash(git push -f*)', '--output-format', 'json', '--max-turns', '80', '--max-budget-usd', '5', '{model_args}'],
  },
  'claude-action': {
    description: 'Claude Code in GitHub Actions (`anthropics/claude-code-action@v1`), for a board that has to keep moving with the laptop closed. The launch does not run a worker here: it fires `kanban-worker-claude.yml` with `gh workflow run` and exits, so the attempt is `remote` — no pid, no job, and the heartbeat plus `max_runtime` are the whole liveness check. `hkb init --with-actions` writes that workflow and the event-driven `kanban-dispatch.yml` beside it. Needs a KB_TOKEN secret, and one of CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY. Honest latency with nothing but Actions: 15-75 minutes (see the README).',
    mode: 'trigger',
    // the runner has a full checkout and a token that can push, so the lease works like anywhere
    // else; `auto` still falls back to the run comment if a repo refuses the ref push
    heartbeat: 'auto',
    max_in_progress: 2,
    model: null, // per-task `model` is not plumbed through workflow inputs yet — set it in claude_args
    allowed_tools: CLAUDE_TOOLS,
    launch: ['gh', 'workflow', 'run', 'kanban-worker-claude.yml', '-R', '{repo}', '-f', 'task={n}', '-f', 'attempt={k}', '-f', 'board={board}'],
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

export const DEFAULT_BOARD = {
  version: 1,
  repo: null,
  board: 'default',
  // Version of the skill `hkb init` copied into .agents/skills/kanban; null when the skill is
  // linked instead of copied (the hkb package repo itself) and so cannot go stale. See init.js.
  skill_version: null,
  dispatch: {
    interval: 60,
    max_in_progress: 2,
    stale_after: 3600,
    max_runtime_default: 3600,
    failure_limit: 2,
    block_recurrence_limit: 3,
    auth_pause: 1800,
    recent_success_window: 600,
    path_guard: true,
    daily_spawn_cap: 40,
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

/**
 * Is `hkb` on PATH? Generated files (the Stop hook, `.mcp.json`) name the binary when it is and fall
 * back to this checkout's `bin/hkb.js` when it is not — a hook or an MCP client started by a GUI
 * inherits a PATH that may have neither.
 */
export function hkbOnPath() {
  const which = spawnSync('sh', ['-c', 'command -v hkb'], { encoding: 'utf8' });
  return which.status === 0 && !!which.stdout.trim();
}

export function detectRepo() {
  const out = ghCmd(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
  const j = JSON.parse(out);
  const [owner, repo] = j.nameWithOwner.split('/');
  return { owner, repo, nameWithOwner: j.nameWithOwner, defaultBranch: j.defaultBranchRef?.name || 'main' };
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
  for (const [name, p] of Object.entries(raw.profiles || DEFAULT_PROFILES)) cfg.profiles[name] = deepMerge(DEFAULT_PROFILES[name] || {}, p);
  return cfg;
}

export function saveBoard(root, cfg) {
  fs.mkdirSync(kanbanDir(root), { recursive: true });
  fs.writeFileSync(boardFile(root), JSON.stringify(cfg, null, 2) + '\n');
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
  return parseRepoSpecs(list).map((s) => ({ ...s, path: expandHome(s.path) }));
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
