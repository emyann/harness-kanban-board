// `hkb hook stop` — Claude Code Stop hook. Nudges a worker (max 2×) that exits without a terminal verb.
// Safe in any session: exits 0 immediately unless KB_TASK is set.
import fs from 'node:fs';
import path from 'node:path';
import { kanbanDir } from './board.js';
import { getTask } from './tasks.js';

/** PreToolUse hook: hkb's own permission policy — allow or deny, never a prompt. */
export async function preToolHook(ctx) {
  if (!process.env.KB_TASK) return 0;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  const { decidePermission, allowedCommandsFrom } = await import('./model.js');
  const profile = ctx.cfg?.profiles?.[process.env.KB_PROFILE] || {};
  const allowedCmds = allowedCommandsFrom(profile.allowed_tools || []);
  allowedCmds.add('hkb'); allowedCmds.add('git'); allowedCmds.add('gh');
  const root = process.env.KB_ROOT || ctx.root;
  const { decision, reason } = decidePermission(input.tool_name, input.tool_input, { allowedCmds, root });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `hkb: ${reason}` },
  }) + '\n');
  return 0;
}

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
    process.stderr.write(`hkb hook: could not read #${n} (${e.message}); allowing stop\n`);
    return 0;
  }
  if (status !== 'running') return 0; // terminal verb already recorded
  if (count >= 2) {
    process.stderr.write(`hkb hook: #${n} still running after 2 nudges — allowing stop (dispatcher will record protocol_violation)\n`);
    return 0;
  }
  fs.writeFileSync(file, String(count + 1));
  const reason = `Task #${n} is still "running" on the kanban board. Finish with exactly one terminal verb before stopping: ` +
    `\`hkb complete ${n} --from-stdin\` (JSON {summary, metadata} on stdin; or --summary/--summary-file --metadata-file), or \`hkb block ${n} "why" --kind needs_input\`, or \`hkb request-review ${n} --summary "..."\`. ` +
    `(nudge ${count + 1}/2${input.stop_hook_active ? ', stop_hook_active' : ''})`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  return 0;
}
