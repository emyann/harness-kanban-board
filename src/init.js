// `hkb init` — labels, board.json, skill, hook, doc sections. Idempotent; free path by default.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOARD, DEFAULT_PROFILES, detectRepo, saveBoard, loadBoard, boardFile, ensureLocalDirs, repoRoot } from './board.js';
import { ensureLabels, fetchBoard, addLabels } from './tasks.js';
import { rest } from './gh.js';
import { L, STATUSES } from './model.js';

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
  settings.hooks.Stop = settings.hooks.Stop || [];
  const already = settings.hooks.Stop.some((h) => JSON.stringify(h).includes('hook stop') && JSON.stringify(h).includes('hkb'));
  if (already) return false;
  settings.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: hkbCommandForHook(), timeout: 30 }] });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return true;
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

  // 2. board.json
  const cfg = existing || JSON.parse(JSON.stringify(DEFAULT_BOARD));
  cfg.repo = repo.nameWithOwner;
  cfg.default_branch = repo.defaultBranch;
  cfg.board = board;
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

  // 3. labels
  const labels = [...STATUSES.map(L.status), L.board(board), L.needsHuman, ...Object.keys(cfg.profiles).map(L.agent)];
  const created = await ensureLabels(ctx, labels);
  log(created.length ? `created labels: ${created.join(', ')}` : 'labels already present');

  // 4. skill: .agents/skills/kanban (canonical) + .claude/skills/kanban symlink
  const skillSrc = path.join(PKG_ROOT, 'skills', 'kanban');
  const agentsSkill = path.join(root, '.agents', 'skills', 'kanban');
  copyDir(skillSrc, agentsSkill);
  const claudeSkill = path.join(root, '.claude', 'skills', 'kanban');
  fs.mkdirSync(path.dirname(claudeSkill), { recursive: true });
  if (!fs.existsSync(claudeSkill)) {
    try { fs.symlinkSync(path.relative(path.dirname(claudeSkill), agentsSkill), claudeSkill, 'dir'); }
    catch { copyDir(skillSrc, claudeSkill); }
  }
  log('installed skill: .agents/skills/kanban (+ .claude/skills/kanban)');

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
