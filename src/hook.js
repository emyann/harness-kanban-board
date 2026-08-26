// `hkb hook stop` — the stop hook for every local harness. Nudges a worker (max 2×) that tries to
// end its turn without a terminal verb. Safe in any session: exits 0 immediately unless KB_TASK is set.
//
// Two harnesses, one hook. What differs, and what does not:
//
//   |            | Claude Code                       | Copilot CLI                              |
//   | event      | `Stop`                            | `agentStop` (not `sessionEnd`, which is   |
//   |            |                                   | too late to block)                        |
//   | configured | `.claude/settings.json` `hooks.Stop` | `.github/hooks/kanban.json` `hooks.agentStop` |
//   | installed  | `hkb init`                        | `hkb init --harness copilot`             |
//   | stdin      | snake_case: `session_id`,         | camelCase: `sessionId`, `transcriptPath`, |
//   |            | `transcript_path`, `stop_hook_active` | `hookEventName`                      |
//   | stdout     | `{"decision":"block","reason":…}` | same — Copilot documents `decision: block`|
//   |            | (re-prompts the model)            | on `agentStop`, with its own continuation |
//   |            |                                   | guard on top of our 2 nudges              |
//
// `normalizeHookInput` (model.js) folds the camelCase spellings onto Claude's, so everything below
// reads one shape. Copilot has no `--output-format json`, so its payload carries no cost/turn
// fields: `recordSession` simply finds nothing to write and the attempt row stays as it is.
//
// Codex CLI is the third: event `Stop`, configured in `.codex/hooks.json` (`hkb init --harness codex`),
// same `{"decision":"block"}` answer — but it runs no project hook at all until the project has been
// trusted once, so its nudge is only as good as that setup step (docs/harnesses.md). `--output-schema`
// shapes its final message; the terminal verb the worker ran is still what moved the card.
import fs from 'node:fs';
import path from 'node:path';
import { kanbanDir } from './board.js';
import { getTask, loadRun, saveRun } from './tasks.js';
import { openAttempt, sessionUpdate, normalizeHookInput } from './model.js';

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

/**
 * Write the Claude session behind this attempt onto its run row: id + transcript, once.
 * The Stop hook can fire three times per attempt, so a local marker keeps it to a single
 * read + PATCH — after that the hook costs nothing extra.
 * @returns true when it wrote, false when there was nothing to record.
 */
async function recordSession(ctx, n, k, input) {
  if (!input?.session_id && !input?.transcript_path) return false;
  const mark = path.join(kanbanDir(ctx.root), 'sessions', `${n}-${k}`);
  if (fs.existsSync(mark)) return false;
  const rec = await loadRun(ctx, n);
  const a = rec.run.attempts.find((x) => String(x.attempt) === String(k)) || openAttempt(rec.run);
  const update = a && sessionUpdate(a, input);
  if (update) { Object.assign(a, update); await saveRun(ctx, n, rec); }
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, `${input.session_id || ''}\n`);
  return !!update;
}

export async function stopHook(ctx) {
  const n = process.env.KB_TASK;
  if (!n) return 0;
  let input = {};
  try { input = normalizeHookInput(JSON.parse(fs.readFileSync(0, 'utf8') || '{}')); } catch { /* no stdin */ }
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
  // the session id is worth recording whatever the status — a finished attempt is exactly the
  // one a human reopens for a post-mortem. Never let it cost the nudge.
  try { await recordSession(ctx, n, k, input); } catch (e) {
    process.stderr.write(`hkb hook: could not record the session on #${n} (${e.message})\n`);
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
