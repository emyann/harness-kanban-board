// Board configuration (.kanban/board.json), repo detection, local paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghCmd } from './gh.js';

// A background worker has nobody to answer a permission prompt, so the allowlist must cover
// every command an agent plausibly reaches for; anything else is denied, never prompted (see #23).
const CLAUDE_TOOLS = ['Bash(hkb *)', 'Bash(git *)', 'Bash(gh pr *)', 'Bash(gh issue view *)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(cat *)', 'Bash(ls *)', 'Bash(mkdir *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(sed *)', 'Bash(awk *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(diff *)', 'Bash(cp *)', 'Bash(mv *)', 'Bash(touch *)', 'Bash(chmod *)', 'Bash(printf *)', 'Bash(echo *)', 'Bash(jq *)', 'Bash(true)', 'Edit', 'Write', 'Read', 'Glob', 'Grep'];

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
  'claude-p': {
    description: 'Claude Code headless (`claude -p`): a plain process that exits when done. Not listed in `claude agents`; use it where no session daemon exists (CI, containers).',
    mode: 'process',
    heartbeat: 'auto',
    max_in_progress: 2,
    model: null,
    allowed_tools: CLAUDE_TOOLS,
    launch: ['claude', '-p', '{prompt}', '--worktree', 'kb-{n}-{k}', '--permission-mode', 'dontAsk', '--allowedTools', '{allowed_tools}', '--disallowedTools', 'Bash(git push --force*)', 'Bash(git push -f*)', '--output-format', 'json', '--max-turns', '80', '--max-budget-usd', '5', '{model_args}'],
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
 * Build the context object every command uses.
 * `board` flag > KB_BOARD env > board.json > 'default'.
 */
export function makeContext(flags = {}) {
  const root = repoRoot();
  const cfg = loadBoard(root);
  const repo = cfg?.repo ? parseRepo(cfg.repo) : null;
  const board = flags.board || process.env.KB_BOARD || cfg?.board || 'default';
  return {
    root,
    cfg,
    repo,
    board,
    host: hostId(),
    json: !!flags.json,
    caps: {},
    _cache: {},
    requireBoard() {
      if (!cfg) {
        const e = new Error(`no .kanban/board.json in ${root}. Run \`hkb init\` first.`);
        e.exitCode = 2;
        throw e;
      }
      if (!repo) {
        const e = new Error('board.json has no "repo". Run `hkb init` again or set "repo": "owner/name".');
        e.exitCode = 2;
        throw e;
      }
      return this;
    },
  };
}

export function parseRepo(s) {
  const [owner, repo] = String(s).split('/');
  if (!owner || !repo) return null;
  return { owner, repo, nameWithOwner: `${owner}/${repo}` };
}

export function api(ctx, suffix = '') { return `repos/${ctx.repo.owner}/${ctx.repo.repo}${suffix}`; }
