// `ghk hook stop` — Claude Code Stop hook. Nudges a worker (max 2×) that exits without a terminal verb.
// Safe in any session: exits 0 immediately unless KB_TASK is set.
import fs from 'node:fs';
import path from 'node:path';
import { kanbanDir } from './board.js';
import { getTask } from './tasks.js';

export async function stopHook(ctx) {
  const n = process.env.KB_TASK;
  if (!n) return 0;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no stdin */ }
  const k = process.env.KB_ATTEMPT || '0';
  const dir = path.join(kanbanDir(ctx.root), 'nudges');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${n}-${k}`);
  let count = 0;
  try { count = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { /* first */ }
  let status = null;
  try {
    ctx.requireBoard();
    status = (await getTask(ctx, n)).status;
  } catch (e) {
    process.stderr.write(`ghk hook: could not read #${n} (${e.message}); allowing stop\n`);
    return 0;
  }
  if (status !== 'running') return 0; // terminal verb already recorded
  if (count >= 2) {
    process.stderr.write(`ghk hook: #${n} still running after 2 nudges — allowing stop (dispatcher will record protocol_violation)\n`);
    return 0;
  }
  fs.writeFileSync(file, String(count + 1));
  const reason = `Task #${n} is still "running" on the kanban board. Finish with exactly one terminal verb before stopping: ` +
    `\`ghk complete ${n} --summary "..." --metadata '{...}'\`, or \`ghk block ${n} "why" --kind needs_input\`, or \`ghk request-review ${n} --summary "..."\`. ` +
    `(nudge ${count + 1}/2${input.stop_hook_active ? ', stop_hook_active' : ''})`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  return 0;
}
