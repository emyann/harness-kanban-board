// `hkb init` — labels, board.json, skill, hook, doc sections. Idempotent; free path by default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOARD, DEFAULT_PROFILES, detectRepo, saveBoard, loadBoard, boardFile, ensureLocalDirs, repoRoot, hkbOnPath } from './board.js';
import { ensureLabels, fetchBoard, addLabels } from './tasks.js';
import { rest } from './gh.js';
import { L, STATUSES, parseSkillVersion, stripFrontmatter } from './model.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARK_START = '<!-- hkb:start -->';
const MARK_END = '<!-- hkb:end -->';

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------- skill install ----------
// The skill has one source of truth: `skills/kanban` in the package. Other repos get a copy and
// board.json remembers which version, so `hkb doctor` can say when it has fallen behind. The hkb
// repo *is* the package, so a copy there would be a second source of truth — link it instead.

export function agentsSkillDir(root) { return path.join(root, '.agents', 'skills', 'kanban'); }
export function packageSkillDir() { return path.join(PKG_ROOT, 'skills', 'kanban'); }

/** lstat-based existence: unlike fs.existsSync, a dangling symlink counts as present. */
function lexists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function isSymlink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** `metadata.version` of the skill rooted at `dir`, or null. */
export function readSkillVersion(dir) {
  try { return parseSkillVersion(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')); } catch { return null; }
}

/**
 * True when the repo being initialised is the hkb package itself — a root package.json named "hkb"
 * that actually carries the skill. Some other project may share the name; it must not get a link
 * pointing at nothing.
 */
export function isPackageRepo(root) {
  let name;
  try { name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name; } catch { return false; }
  return name === 'hkb' && fs.existsSync(path.join(root, 'skills', 'kanban', 'SKILL.md'));
}

/**
 * Point `.agents/skills/kanban` at the in-repo `skills/kanban`, replacing a copy left by an earlier
 * init. Returns 'linked' | 'already-linked', or null when the filesystem refuses symlinks — in which
 * case whatever was installed is still there, so the caller can fall back to a copy.
 */
export function linkSkill(root) {
  const link = agentsSkillDir(root);
  const target = path.relative(path.dirname(link), path.join(root, 'skills', 'kanban'));
  if (isSymlink(link) && fs.readlinkSync(link) === target) return 'already-linked';
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const staged = link + '.hkb-new';
  try {
    if (lexists(staged)) fs.rmSync(staged, { recursive: true, force: true });
    fs.symlinkSync(target, staged, 'dir');
  } catch { return null; }
  if (lexists(link)) fs.rmSync(link, { recursive: true, force: true });
  fs.renameSync(staged, link);
  return 'linked';
}

/**
 * Copy the packaged skill into `.agents/skills/kanban`, replacing whatever is there — a link, or an
 * older copy whose renamed/removed files would otherwise linger. Returns the installed version.
 */
export function copySkill(root) {
  const dst = agentsSkillDir(root);
  if (lexists(dst)) fs.rmSync(dst, { recursive: true, force: true });
  copyDir(packageSkillDir(), dst);
  return readSkillVersion(dst);
}

function upsertSection(file, section) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = `${MARK_START}\n${section.trim()}\n${MARK_END}`;
  if (text.includes(MARK_START) && text.includes(MARK_END)) {
    text = text.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
  } else {
    text = (text.trimEnd() + '\n\n' + block + '\n').replace(/^\n+/, '');
  }
  fs.writeFileSync(file, text);
}

function hkbCommandForHook() {
  if (hkbOnPath()) return 'hkb hook stop';
  const bin = path.join(PKG_ROOT, 'bin', 'hkb.js');
  return `node "${bin}" hook stop`;
}

function installStopHook(root, log) {
  const dir = path.join(root, '.claude');
  const file = path.join(dir, 'settings.json');
  fs.mkdirSync(dir, { recursive: true });
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log(`skip hook: ${file} is not valid JSON (${e.message})`); return false; }
  }
  settings.hooks = settings.hooks || {};
  let changed = false;
  const ensure = (event, cmd) => {
    settings.hooks[event] = settings.hooks[event] || [];
    if (settings.hooks[event].some((h) => JSON.stringify(h).includes(cmd.split(' ').pop()) && JSON.stringify(h).includes('hkb'))) return;
    settings.hooks[event].push({ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 30 }] });
    changed = true;
  };
  const base = hkbCommandForHook().replace(/ stop$/, '');
  ensure('Stop', `${base} stop`);
  ensure('PreToolUse', `${base} pretool`);
  if (changed) fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return changed;
}

// ---------- harness files (`hkb init --harness copilot|codex`) ----------
// Harnesses that cannot read the skill directly need their own agent + hook files. They are
// *generated*, never hand-maintained: the protocol text is spliced out of the packaged SKILL.md so
// it lives in exactly one place, and re-running init overwrites whatever is on disk.

/** Profile a harness brings with it, so `--harness copilot` alone gives a dispatchable board. */
export const HARNESS_PROFILE = { copilot: 'copilot-cli', codex: 'codex' };
export const HARNESSES = Object.keys(HARNESS_PROFILE);

function template(...parts) { return fs.readFileSync(path.join(PKG_ROOT, 'templates', ...parts), 'utf8'); }
/** For a placeholder that sits inside a JSON string literal — the node fallback command has quotes in it. */
function jsonInner(s) { return JSON.stringify(String(s)).slice(1, -1); }
/** For a placeholder inside a TOML basic string — a Windows path is full of backslashes. */
function tomlInner(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

/** The body of the packaged SKILL.md, with its skill-relative links rewritten to repo-relative ones. */
function protocolText() {
  return stripFrontmatter(fs.readFileSync(path.join(packageSkillDir(), 'SKILL.md'), 'utf8'))
    .replace(/`references\/protocol\.md`/g, '`.agents/skills/kanban/references/protocol.md`')
    .trimEnd();
}

// One entry per harness: what it needs on disk, built from `templates/<harness>/`.
const HARNESS_FILES = {
  // Copilot CLI: a custom agent (`copilot --agent kanban-worker`) and an agentStop hook.
  copilot: ({ command }) => [
    { rel: path.join('.github', 'agents', 'kanban-worker.agent.md'), contents: fill(template('copilot', 'kanban-worker.agent.md'), { protocol: protocolText() }) },
    { rel: path.join('.github', 'hooks', 'kanban.json'), contents: fill(template('copilot', 'hooks.json'), { command: jsonInner(command) }) },
  ],
  // Codex CLI: a Stop hook, plus the notes for what only the user can do — the one-time trust and
  // the `~/.codex/config.toml` settings a sandboxed worker needs. No agent file: Codex reads
  // AGENTS.md, which `hkb init` already keeps up to date.
  codex: ({ command, root }) => [
    { rel: path.join('.codex', 'hooks.json'), contents: fill(template('codex', 'hooks.json'), { command: jsonInner(command) }) },
    { rel: path.join('.codex', 'README.md'), contents: fill(template('codex', 'notes.md'), { command, root: tomlInner(root), gitdir: tomlInner(path.join(root, '.git')) }) },
  ],
};

/**
 * The files `hkb init --harness <name>` writes, as `[{ rel, contents }]` — nothing is written here,
 * so tests and `--dry-run` callers can look before anything touches the repo.
 * @param name one of HARNESSES
 * @param command what the generated hook should run (`hkb hook stop`, or the node fallback)
 * @param root absolute path of the repo, for files that must name it (Codex trusts by path)
 */
export function harnessFiles(name, { command = 'hkb hook stop', root = '/path/to/your/repo' } = {}) {
  const build = HARNESS_FILES[name];
  if (!build) {
    const e = new Error(`unknown harness "${name}". Known: ${HARNESSES.join(', ')}`);
    e.exitCode = 2;
    throw e;
  }
  return build({ command, root });
}

// ---------- GitHub Actions (`hkb init --with-actions`) ----------
// Two workflows, generated the same way harness files are: the dispatcher (events, with a 15-minute
// cron as a sweeper) and one worker per attempt (claude-code-action, started by `gh workflow run`).
// Neither contains a secret — only `${{ secrets.* }}` references — and re-running init overwrites
// both, so the templates stay the single source.

export const ACTIONS_PROFILE = 'claude-action';
export const WORKER_WORKFLOW = 'kanban worker (claude)';
const ACTIONS_DIR = path.join('.github', 'workflows');
const NODE_VERSION = '22';

/**
 * How Actions gets `hkb` on PATH. Every repo installs the published package; hkb's own repo installs
 * the checkout it is running, so a change to the CLI is exercised by the workflow that ships it.
 */
export function hkbInstallForActions(root) {
  return isPackageRepo(root) ? 'npm link' : 'npm i -g hkb';
}

/**
 * The two workflow files, as `[{ rel, contents }]`. Pure, like `harnessFiles`.
 * @param board board slug the dispatcher ticks and the worker defaults to
 * @param install shell command that puts `hkb` on PATH in the runner
 * @param profiles profile names the Actions dispatcher may claim — never the laptop-only ones
 * @param timeoutMinutes the worker job's `timeout-minutes`; keep it <= the board's max_runtime
 */
export function actionsFiles({ board = 'default', install = 'npm i -g hkb', profiles = [ACTIONS_PROFILE], timeoutMinutes = 60, maxTurns = 80 } = {}) {
  const vars = {
    board,
    install,
    profiles: profiles.join(','),
    profile: ACTIONS_PROFILE,
    worker_workflow: WORKER_WORKFLOW,
    node_version: NODE_VERSION,
    timeout_minutes: String(timeoutMinutes),
    max_turns: String(maxTurns),
    allowed_tools: (DEFAULT_PROFILES[ACTIONS_PROFILE].allowed_tools || []).join(','),
  };
  return ['kanban-dispatch.yml', 'kanban-worker-claude.yml'].map((name) => ({
    rel: path.join(ACTIONS_DIR, name),
    contents: fill(template('actions', name), vars),
  }));
}

/** Write the workflows. Returns the relative paths that actually changed. */
export function installActions(root, opts = {}) {
  return writeAll(root, actionsFiles({ install: hkbInstallForActions(root), ...opts }));
}

/**
 * The profiles the Actions dispatcher is allowed to claim — the ones whose launch only *triggers*
 * work somewhere else. Anything a runner cannot start (a local `claude`, `copilot`, `codex`) has to
 * stay off that list, or the tick claims a task and then fails to spawn it.
 */
export function triggerProfiles(cfg) {
  const names = Object.entries(cfg?.profiles || {}).filter(([, p]) => p?.mode === 'trigger').map(([n]) => n);
  return names.length ? names : [ACTIONS_PROFILE];
}

/**
 * What `--profiles` and `--harness` add up to. `--harness copilot` on its own means "set me up for
 * Copilot": it brings its profile with it and replaces the `claude` default rather than adding to
 * it. Naming both keeps both. Pure, so the branching is testable without a repo.
 * @returns {{ harnesses: string[], profiles: string[] }}
 */
export function resolveProfiles(flags = {}) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const harnesses = list(flags.harness);
  for (const h of harnesses) {
    if (HARNESS_PROFILE[h]) continue;
    const e = new Error(`unknown harness "${h}". Known: ${HARNESSES.join(', ')}`);
    e.exitCode = 2;
    throw e;
  }
  const implied = harnesses.map((h) => HARNESS_PROFILE[h]);
  const profiles = flags.profiles ? list(flags.profiles) : (implied.length ? [...implied] : ['claude']);
  for (const p of implied) if (!profiles.includes(p)) profiles.push(p);
  // `--with-actions` *adds*: the point is a board that runs on this machine and keeps going when it
  // closes, so the local profile stays whatever it was.
  if (flags['with-actions'] && !profiles.includes(ACTIONS_PROFILE)) profiles.push(ACTIONS_PROFILE);
  return { harnesses, profiles };
}

/** Write generated `[{rel, contents}]` under `root`. Returns the relative paths that actually changed. */
function writeAll(root, files) {
  const written = [];
  for (const f of files) {
    const abs = path.join(root, f.rel);
    let current = null;
    try { current = fs.readFileSync(abs, 'utf8'); } catch { /* not there yet */ }
    if (current === f.contents) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.contents);
    written.push(f.rel);
  }
  return written;
}

/** Write a harness's files. Returns the relative paths that actually changed. */
export function installHarness(root, name, { command } = {}) {
  return writeAll(root, harnessFiles(name, { command, root }));
}

function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  // .claude/worktrees/ holds worker checkouts — Claude Code's `--worktree`, and the ones the
  // dispatcher makes itself for profiles with `workspace: "worktree"` (Copilot CLI).
  const wanted = ['.kanban/logs/', '.kanban/outbox.jsonl', '.kanban/state.json', '.kanban/cache.json', '.kanban/nudges/', '.kanban/sessions/', '.claude/worktrees/'];
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = wanted.filter((w) => !text.split('\n').includes(w));
  if (!missing.length) return false;
  text = text.trimEnd() + (text ? '\n' : '') + '# hkb local state\n' + missing.join('\n') + '\n';
  fs.writeFileSync(file, text);
  return true;
}

export async function init(ctx, flags, log) {
  const root = repoRoot();
  const board = flags.board || 'default';
  const { harnesses, profiles } = resolveProfiles(flags);
  const existing = loadBoard(root);

  // 1. repo
  const repo = flags.repo ? { nameWithOwner: flags.repo, defaultBranch: 'main' } : detectRepo();
  log(`repo: ${repo.nameWithOwner}`);

  // 2. skill: .agents/skills/kanban (canonical) + .claude/skills/kanban symlink.
  //    In the hkb repo the package *is* the source, so a copy there would be a second source of
  //    truth: link it. Everywhere else, copy and stamp the version so doctor can spot a stale copy.
  const agentsSkill = agentsSkillDir(root);
  const linked = isPackageRepo(root) ? linkSkill(root) : null;
  const skillVersion = linked ? null : copySkill(root);
  log(linked
    ? `linked skill: .agents/skills/kanban → ${fs.readlinkSync(agentsSkill)} (${linked === 'linked' ? 'replaced the copy' : 'unchanged'})`
    : `installed skill: .agents/skills/kanban${skillVersion ? ` v${skillVersion}` : ''}`);
  const claudeSkill = path.join(root, '.claude', 'skills', 'kanban');
  fs.mkdirSync(path.dirname(claudeSkill), { recursive: true });
  if (!lexists(claudeSkill)) {
    try {
      fs.symlinkSync(path.relative(path.dirname(claudeSkill), agentsSkill), claudeSkill, 'dir');
      log('linked .claude/skills/kanban → .agents/skills/kanban');
    } catch {
      copyDir(packageSkillDir(), claudeSkill);
      log('copied .claude/skills/kanban (this filesystem refuses symlinks)');
    }
  }

  // 3. board.json
  const cfg = existing || JSON.parse(JSON.stringify(DEFAULT_BOARD));
  cfg.repo = repo.nameWithOwner;
  cfg.default_branch = repo.defaultBranch;
  cfg.board = board;
  cfg.skill_version = skillVersion; // null when linked — a link cannot go stale
  cfg.profiles = cfg.profiles || {};
  for (const p of profiles) {
    if (!cfg.profiles[p]) {
      if (!DEFAULT_PROFILES[p]) log(`profile "${p}" has no built-in launch template — add one to ${path.relative(root, boardFile(root))}`);
      cfg.profiles[p] = DEFAULT_PROFILES[p] ? JSON.parse(JSON.stringify(DEFAULT_PROFILES[p])) : { max_in_progress: 1, launch: null };
    }
  }
  saveBoard(root, cfg);
  ensureLocalDirs(root);
  log(`${existing ? 'updated' : 'wrote'} .kanban/board.json (board "${board}", profiles ${Object.keys(cfg.profiles).join(', ')})`);
  ctx.cfg = cfg; ctx.repo = { owner: repo.nameWithOwner.split('/')[0], repo: repo.nameWithOwner.split('/')[1], nameWithOwner: repo.nameWithOwner }; ctx.board = board;

  // 3b. optional Projects v2 mirror (opt-in, one-way). Everything above is already saved, so a
  //     failure here — usually a token without the `project` scope — costs only the mirror.
  if (flags.project) {
    const { linkProject } = await import('./projects.js');
    cfg.project = await linkProject(ctx, flags.project, log);
    saveBoard(root, cfg);
  }

  // 4. labels
  const labels = [...STATUSES.map(L.status), L.board(board), L.needsHuman, ...Object.keys(cfg.profiles).map(L.agent)];
  const created = await ensureLabels(ctx, labels);
  log(created.length ? `created labels: ${created.join(', ')}` : 'labels already present');

  // 5. Stop hook + harness files + gitignore + doc sections
  if (flags['no-hook']) log('skipped Stop hook (--no-hook)');
  else log(installStopHook(root, log) ? 'added Stop hook to .claude/settings.json (inert unless KB_TASK is set)' : 'Stop hook already present');
  for (const h of harnesses) {
    const written = installHarness(root, h, { command: hkbCommandForHook() });
    log(written.length ? `harness ${h}: wrote ${written.join(', ')}` : `harness ${h}: files already up to date`);
  }
  // 5a. optional GitHub Actions dispatcher + worker. The files are all init writes; the two secrets
  //     and the push to the default branch are the user's, and Actions runs nothing until both.
  if (flags['with-actions']) {
    const written = installActions(root, { board, profiles: triggerProfiles(cfg), timeoutMinutes: Math.round((cfg.dispatch?.max_runtime_default || 3600) / 60) });
    log(written.length ? `actions: wrote ${written.join(', ')}` : 'actions: workflows already up to date');
    log('  then, once — no secret of yours is ever written into a template:');
    log('    gh secret set KB_TOKEN                   # fine-grained PAT, this repo: Issues, Contents, Pull requests, Actions RW');
    log('    claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN    # or: gh secret set ANTHROPIC_API_KEY');
    log('  and commit both workflows to the default branch — Actions only ever runs the copy that is there.');
  }
  // 5b. optional MCP server config. Only .mcp.json is ours to write — Claude Code and Copilot CLI
  //     read it verbatim; Codex's is user-level and VS Code's belongs to the editor, so those are printed.
  if (flags.mcp) {
    const { installMcp } = await import('./mcp.js');
    const m = installMcp(root);
    log(m.changed ? `wrote .mcp.json (servers: ${m.servers.join(', ')})` : '.mcp.json already has the kanban server');
    for (const s of m.snippets) {
      log('');
      log(`${s.file} — not written for you (${s.note}); paste:`);
      for (const line of s.text.split('\n')) log(`    ${line}`);
    }
  }
  if (ensureGitignore(root)) log('updated .gitignore');
  const section = fs.readFileSync(path.join(PKG_ROOT, 'templates', 'doc-section.md'), 'utf8');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) { upsertSection(path.join(root, f), section); }
  log('upserted hkb section in CLAUDE.md and AGENTS.md');

  // 6. optional import of existing open issues into triage
  if (flags.import) {
    const all = await rest('GET', `repos/${repo.nameWithOwner}/issues?state=open&per_page=100`);
    const onBoard = new Set((await fetchBoard(ctx)).map((t) => t.number));
    let n = 0;
    for (const issue of all || []) {
      if (issue.pull_request || onBoard.has(issue.number)) continue;
      await addLabels(ctx, { number: issue.number, labels: (issue.labels || []).map((l) => l.name) }, [L.board(board), L.status('triage')]);
      n++;
    }
    log(`imported ${n} open issue(s) into triage on board "${board}"`);
  }
  log('');
  log('next: `hkb doctor` then `hkb dispatch --loop 60` (or `hkb create "title" --agent claude` to add a task)');
  return 0;
}
