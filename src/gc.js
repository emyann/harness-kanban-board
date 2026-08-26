// `ghk gc` — remove worktrees of finished tasks, prune old logs/nudges. Destructive steps need --yes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchBoard, loadRun, deleteComment } from './tasks.js';
import { logsDir, kanbanDir } from './board.js';

function worktrees(root) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; out.push(cur); }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
  }
  return out;
}

export async function gc(ctx, flags, log) {
  ctx.requireBoard();
  const days = Number(flags['log-retention-days'] || 14);
  const tasks = await fetchBoard(ctx, { includeClosed: true });
  const byNumber = new Map(tasks.map((t) => [t.number, t]));
  const candidates = worktrees(ctx.root).filter((w) => /kb-(\d+)-(\d+)$/.test(w.path) || /^kb-(\d+)-(\d+)$/.test(w.branch || ''));
  let removed = 0;
  for (const w of candidates) {
    const m = /kb-(\d+)-(\d+)/.exec(w.path) || /kb-(\d+)-(\d+)/.exec(w.branch || '');
    const t = byNumber.get(Number(m[1]));
    const finished = !t || ['done', 'archived'].includes(t.status) || t.state === 'CLOSED';
    if (!finished) continue;
    if (!flags.yes) { log(`would remove worktree ${w.path} (task #${m[1]} ${t?.status || 'not on board'}) — pass --yes`); continue; }
    const r = spawnSync('git', ['worktree', 'remove', '--force', w.path], { cwd: ctx.root, encoding: 'utf8' });
    if (r.status === 0) { removed++; log(`removed worktree ${w.path}`); } else log(`failed to remove ${w.path}: ${r.stderr.trim()}`);
  }
  if (flags.yes) spawnSync('git', ['worktree', 'prune'], { cwd: ctx.root });
  // duplicate run comments (older copies) → delete, keep the newest
  let dupes = 0;
  for (const t of tasks) {
    const rec = await loadRun(ctx, t.number);
    for (const id of rec.duplicates || []) {
      if (!flags.yes) { log(`would delete duplicate run comment ${id} on #${t.number} — pass --yes`); continue; }
      if (await deleteComment(ctx, t.number, id)) { dupes++; log(`deleted duplicate run comment ${id} on #${t.number}`); }
    }
  }
  let pruned = 0;
  const cutoff = Date.now() - days * 86400_000;
  for (const dir of [logsDir(ctx.root), path.join(kanbanDir(ctx.root), 'nudges')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p); pruned++; }
    }
  }
  log(`gc: ${removed} worktree(s) removed, ${dupes} duplicate run comment(s) deleted, ${pruned} old file(s) pruned (retention ${days}d)`);
  return 0;
}
