// `hkb init` — labels, board.json, skill, hook, doc sections. Idempotent; free path by default.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOARD, DEFAULT_PROFILES, detectRepo, saveBoard, loadBoard, boardFile, ensureLocalDirs, repoRoot } from './board.js';
import { ensureLabels, fetchBoard, addLabels } from './tasks.js';
import { rest } from './gh.js';
import { L, STATUSES, parseSkillVersion } from './model.js';

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
  const which = spawnSync('sh', ['-c', 'command -v hkb'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return 'hkb hook stop';
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

function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  const wanted = ['.kanban/logs/', '.kanban/outbox.jsonl', '.kanban/state.json', '.kanban/cache.json', '.kanban/nudges/'];
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
  const profiles = String(flags.profiles || 'claude').split(',').map((s) => s.trim()).filter(Boolean);
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

  // 5. Stop hook + gitignore + doc sections
  if (flags['no-hook']) log('skipped Stop hook (--no-hook)');
  else log(installStopHook(root, log) ? 'added Stop hook to .claude/settings.json (inert unless KB_TASK is set)' : 'Stop hook already present');
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
