// `hkb hook stop` — the stop hook for every local harness. Nudges a worker (max 2×) that tries to
// end its turn without a terminal verb. Safe in any session: exits 0 immediately unless KB_TASK is set.
//
// Two harnesses, one hook. What differs, and what does not:
//
//   |            | Claude Code                       | Copilot CLI                              |
//   | event      | `Stop`                            | `agentStop` (not `sessionEnd`, which is   |
//   |            |                                   | too late to block)                        |
//   | configured | `.claude/settings.local.json` `hooks.Stop` | `.github/hooks/kanban.json` `hooks.agentStop` |
//   |            | (`.claude/settings.json` with `--shared-hooks`) |                                     |
//   | installed  | `hkb init`                        | `hkb init --harness copilot`             |
//   | stdin      | snake_case: `session_id`,         | camelCase: `sessionId`, `transcriptPath`, |
//   |            | `transcript_path`, `stop_hook_active` | `hookEventName`                      |
//   | stdout     | `{"decision":"block","reason":…}` | same — Copilot documents `decision: block`|
//   |            | (re-prompts the model)            | on `agentStop`, with its own continuation |
//   |            |                                   | guard on top of our 2 nudges              |
//
// `normalizeHookInput` (model.js) folds the camelCase spellings onto Claude's, so everything below
// reads one shape. Copilot has no `--output-format json`, so its payload carries no cost/turn
// fields: `recordSessions` simply finds nothing to write and the attempt row stays as it is.
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

// ---------- the session behind an attempt ----------
// A plain worker session runs one task, so `KB_TASK` names the only row its session id belongs on.
// A TRACK runner runs several: it claims every node of its subgraph from inside the one session
// (`hkb claim <n>`, which records `manual: true` on that node's attempt), and those nodes are
// exactly the attempts a human reopens for a post-mortem. So a claim made inside a session leaves a
// *pending* marker in the same `.kanban/sessions/<n>-<k>` file the hook later stamps — one
// convention, no second registry — and the Stop hook writes the session identity onto every attempt
// those markers name. The set is therefore on disk, in the runner's own checkout: no board read and
// no extra API call to find it.

const CLAIMED = 'claimed-by';
const CLAIM_RE = new RegExp(`^${CLAIMED} (\\d+-\\d+)(?: (\\S+))?$`);
const MARKER_RE = /^\d+-\d+$/;

const sessionsDir = (root) => path.join(kanbanDir(root), 'sessions');
const markerFile = (root, n, k) => path.join(sessionsDir(root), `${n}-${k}`);

/** A marker as `{owner, wt}` while it is still a pending claim; null once it holds a session id. */
function readClaim(file) {
  let first;
  try { first = fs.readFileSync(file, 'utf8').split('\n')[0].trim(); } catch { return null; }
  const m = CLAIM_RE.exec(first);
  return m ? { owner: m[1], wt: m[2] || null } : null;
}

/**
 * Remember that this session claimed #n attempt k, so its Stop hook stamps that node too.
 * A no-op outside a session and for the session's own task — the hook records that one from
 * `KB_TASK`. Never throws: a marker is a convenience, and a claim must not fail for one.
 * @returns true when a marker was written.
 */
export function markSessionClaim(root, n, k) {
  const owner = process.env.KB_TASK;
  if (!owner || String(owner) === String(n)) return false;
  try {
    const file = markerFile(root, n, k);
    if (fs.existsSync(file)) return false; // a stamped marker outranks a claim: never overwrite one
    // where the session lives, for `hkb show`'s resume line: a node claimed by hand has no worktree
    // of its own, and pointing a post-mortem at `kb-<node>-<k>` would name one that never existed.
    const here = path.basename(path.resolve(root));
    const wt = /^kb-\d+-\d+$/.test(here) ? ` ${here}` : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${CLAIMED} ${owner}-${process.env.KB_ATTEMPT || '0'}${wt}\n`);
    return true;
  } catch { return false; }
}

/**
 * The attempts this session still owes a session id: its own, plus every node it claimed and has
 * not stamped yet. One readdir and one short read per marker — and after the first Stop fire that
 * answers with an empty list, so the hook goes on costing nothing.
 */
function pendingTargets(root, n, k) {
  const owner = `${n}-${k}`;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(sessionsDir(root)); } catch { /* nothing claimed, nothing recorded */ }
  let ownDone = false;
  for (const name of names) {
    if (!MARKER_RE.test(name)) continue;
    const claim = readClaim(path.join(sessionsDir(root), name));
    if (name === owner) { ownDone = !claim; continue; }
    if (claim?.owner !== owner) continue; // another session's node, or already stamped
    const [node, attempt] = name.split('-');
    out.push({ n: node, k: attempt, wt: claim.wt });
  }
  if (!ownDone) out.unshift({ n: String(n), k: String(k), wt: null, own: true });
  return out;
}

/**
 * Write the agent session behind one attempt onto its run row: id + transcript, once.
 * The Stop hook can fire three times per attempt, so the marker keeps it to a single read + PATCH.
 * @returns true when it wrote.
 */
async function writeSession(ctx, { n, k, wt, own = false }, input) {
  const rec = await loadRun(ctx, n);
  // A session with a bare `KB_TASK` has no attempt number, so its own row is the open one. A node's
  // number came from the claim that made it: if that row is gone, the open one belongs to whoever
  // took the node over — never write this session onto it.
  const a = rec.run.attempts.find((x) => String(x.attempt) === String(k)) || (own ? openAttempt(rec.run) : null);
  const fields = a && sessionUpdate(a, input);
  const update = a && wt && !a.wt ? { ...fields, wt } : fields;
  if (update) { Object.assign(a, update); await saveRun(ctx, n, rec); }
  const mark = markerFile(ctx.root, n, k);
  fs.mkdirSync(path.dirname(mark), { recursive: true });
  fs.writeFileSync(mark, `${input.session_id || ''}\n`);
  return !!update;
}

/**
 * Stamp every attempt this session is answerable for. Nothing to record means nothing read: the
 * early return happens before the marker directory is even opened, so a harness whose payload
 * carries no session fields (Copilot CLI) pays nothing at all.
 * @returns the task numbers written.
 */
async function recordSessions(ctx, n, k, input) {
  const done = [];
  if (!input?.session_id && !input?.transcript_path) return done;
  for (const t of pendingTargets(ctx.root, n, k)) {
    // one bad node must not cost the others their identity, nor the nudge its turn
    try { if (await writeSession(ctx, t, input)) done.push(Number(t.n)); } catch (e) {
      process.stderr.write(`hkb hook: could not record the session on #${t.n} (${e.message})\n`);
    }
  }
  return done;
}

export async function stopHook(ctx, io = {}) {
  const n = process.env.KB_TASK;
  if (!n) return 0;
  const readStdin = io.readStdin || (() => fs.readFileSync(0, 'utf8'));
  let input = {};
  try { input = normalizeHookInput(JSON.parse(readStdin() || '{}')); } catch { /* no stdin */ }
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
  // one a human reopens for a post-mortem, and in a track every node is finished by now.
  // Never let it cost the nudge.
  try { await recordSessions(ctx, n, k, input); } catch (e) {
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
