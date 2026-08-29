// `hkb hook stop` — the stop hook for every local harness. Nudges a worker (max 2×) that tries to
// end its turn without a terminal verb. Safe in any session: it exits 0 before it reads stdin unless
// this one is a worker's — `KB_TASK`, or failing that the `kb-<n>-<k>` checkout it is sitting in,
// which is the only thing a `claude --bg` session can be identified by (`whichAttempt`, below).
//
// Two harnesses, one hook. What differs, and what does not:
//
//   |            | Claude Code                       | Copilot CLI                              |
//   | event      | `Stop`                            | `agentStop` (not `sessionEnd`, which is   |
//   |            |                                   | too late to block)                        |
//   | configured | the worker launch's `--settings`  | `.github/hooks/kanban.json` `hooks.agentStop` |
//   |            | (`.claude/settings.json` too, with `--shared-hooks`) |                           |
//   | installed  | `hkb dispatch`, per launch        | `hkb init --harness copilot`             |
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
import { currentSession } from './jobs.js';
import { getTask, loadRun, saveRun } from './tasks.js';
import { openAttempt, sessionUpdate, normalizeHookInput, parseWorktreeName, attemptIdentity } from './model.js';

/**
 * PreToolUse hook: hkb's own permission policy — **deny or say nothing**, never an allow, never a
 * prompt.
 *
 * Gated on `KB_TASK` alone, deliberately, where `stopHook` also accepts the worktree: this policy is
 * the profile's `allowed_tools`, and a checkout name says which task a session is, never which
 * profile launched it. Applied with no profile, `decidePermission` would allow `hkb`, `git` and `gh`
 * and deny everything else — so a background worker, which is exactly the session the worktree
 * fallback would newly reach, would be denied `npm test`. Inert is the safe answer here; the launch
 * flags (`--allowedTools`, `--permission-mode`) are that session's real policy.
 *
 * Which is why `source: 'env'` is the gate rather than `KB_TASK` itself: an inherited `KB_TASK` the
 * checkout contradicts is a leak, and enforcing a worker's allowlist on the operator's own shell is
 * what that leak did (#150 — a diagnostic `for` loop denied, a card body denied for mentioning the
 * dispatcher). A leaked environment falls back to the checkout, and the checkout is inert here.
 *
 * Which is also why an `allow` is never emitted. Worker policy on the default profile IS the launch
 * line, and on the profiles where this hook does run it must not *widen* it: a hook `allow`
 * overrides Claude Code's own checks — including the command-substitution one, measured (#133) — so
 * a hook that answered `allow` would let a `claude-p` worker run what the identical `claude --bg`
 * worker beside it is refused. Silence leaves the native allow-list authoritative and makes this
 * layer purely additive: it can only subtract from what the launch already permits.
 *
 * The same reasoning covers a profile hkb cannot see (`KB_PROFILE` unset, or naming a profile this
 * board does not have — a worker launched from another checkout, a hand-exported `KB_TASK`). The
 * `{}` fallback profile is not a conservative default, it is a *different, stricter* policy nobody
 * chose; standing aside with one line on stderr is the honest answer.
 */
export async function preToolHook(ctx) {
  const id = whichAttempt(ctx.root, { profiles: ctx.cfg?.profiles, warn: 'hkb hook' });
  if (id?.source !== 'env') return 0;
  const n = id.n;
  const name = process.env.KB_PROFILE;
  const profile = name ? ctx.cfg?.profiles?.[name] : null;
  if (!profile) {
    process.stderr.write(`hkb hook: ${name ? `KB_PROFILE "${name}" is not a profile on this board` : 'KB_PROFILE is not set'}` +
      " — standing aside; this session's launch flags are its whole permission policy\n");
    return 0;
  }
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  const { decidePermission, allowedCommandsFrom } = await import('./model.js');
  const allowedCmds = allowedCommandsFrom(profile.allowed_tools || []);
  allowedCmds.add('hkb'); allowedCmds.add('git'); allowedCmds.add('gh');
  const root = process.env.KB_ROOT || ctx.root;
  const { decision, reason, kind } = decidePermission(input.tool_name, input.tool_input, { allowedCmds, root });
  if (decision !== 'deny') return 0; // the launch's allow-list has the last word on what is allowed
  // A refusal is a fork in the road for a worker, and the wrong branch — rewriting the command until
  // something gets through — is the expensive one. Name the other branch in the denial itself — but
  // only for `kind: 'capability'`: a policy denial (force-push, the dispatcher) or a path denial is
  // forbidden outright, and `--kind capability` would misname it as something a wider allow-list fixes.
  const base = `hkb: ${reason.replace(/\.+$/, '')}.`; // the reason can already end in a period (#159)
  const say = kind === 'capability'
    ? `${base} If the task cannot be done without this, do not work around it — run ` +
      `\`hkb block ${n} "needs <what>: <why>" --kind capability\` (describe it, do not paste the command) and stop.`
    : base;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: say },
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

/**
 * The leak line is one line per process, however many times the hook asks the same question — but
 * keyed on `root` too, not the message text alone: two different checkouts that happen to produce
 * the identical leak sentence (same generic wording, e.g. "this is the board root") are two different
 * things worth saying once each, and in-process tests that spin up a fresh board per case depend on
 * exactly that (#150 review).
 */
const warnedLeaks = new Map();

/**
 * `attemptIdentity`'s answer for a plain `(root, env, profiles)` call — the resolve boilerplate
 * `whichAttempt` and `checkEnvLeak` (src/doctor.js) both need before they can ask it anything,
 * written once so the two never drift apart on how `herePath`/`rootPath` get resolved (#150 review).
 * `model.js` stays import-free on purpose (its own doc comment says the caller resolves the paths),
 * so the resolving lives here, next to the one `attemptIdentity` call that used to have two copies.
 */
export function resolvedIdentity(root, { env = process.env, profiles = null } = {}) {
  const herePath = path.resolve(root);
  const rootPath = env.KB_ROOT ? path.resolve(env.KB_ROOT) : null;
  const id = attemptIdentity({
    env,
    here: path.basename(herePath),
    herePath,
    rootPath,
    profile: profiles?.[env.KB_PROFILE] || null,
  });
  return { id, herePath, rootPath };
}

/**
 * Which attempt this session is working — the question every line below depends on.
 *
 * The dispatcher exports `KB_TASK`/`KB_ATTEMPT` on the launch, and for a harness it runs as a child
 * process (`claude -p`, Copilot, Codex) that is the whole answer. `claude --bg` is not one: the CLI
 * hands the request to Claude Code's session daemon and exits, and that daemon was started long
 * before, with an environment of its own. So the DEFAULT profile — the free path the README
 * recommends — never sees them, and every behaviour keyed on `KB_TASK` was silently inert there:
 * no nudge, no session id, and so nothing for `hkb stats` to price (#125).
 *
 * What such a session does have is its checkout. The launch names it `kb-<n>-<k>` and the dispatcher
 * already identifies a running job by exactly that name, so fall back to it: one basename, no file
 * read, no board read. `source` says which answer this was, for a caller that wants to log it.
 *
 * And when the two disagree, the checkout wins. A daemon that a `claude --bg` launch cold-started
 * carries that launch's `KB_TASK` for life and hands it to every session it hosts, the operator's
 * own included (#150) — so an environment naming a task whose worktree this plainly is not is
 * dropped, with one line on stderr. `attemptIdentity` (src/model.js) holds the rule; the profile is
 * part of it, because only some profiles put their worker in a checkout hkb can check against.
 */
export function whichAttempt(root = process.cwd(), { env = process.env, profiles = null, warn = 'hkb' } = {}) {
  const { id, herePath } = resolvedIdentity(root, { env, profiles });
  if (id?.leak && warn && warnedLeaks.get(herePath) !== id.leak) {
    warnedLeaks.set(herePath, id.leak);
    process.stderr.write(`${warn}: ${id.leak}\n`);
  }
  return id?.n ? { n: id.n, k: id.k, source: id.source } : null;
}

/**
 * What to write onto an attempt row this process is CLOSING, when this process is the session that
 * ran it — the path that needs no hook at all, and the reason a `claude-bg` board has spend data.
 *
 * Two things make an attempt this session's own: it is this session's own attempt, or this session
 * claimed it as a track node and left the `claimed-by` marker saying so. Anything else answers null,
 * on purpose: an operator finishing a card from their own terminal and the dispatcher writing off a
 * dead attempt are both running inside *some* session, and neither did this work.
 *
 * `wt` rides along for a claimed node, exactly as the hook does it: a node has no checkout of its
 * own, so a resume line must point at the runner's or name one that never existed.
 */
export function sessionForAttempt(root, n, k, a, { env = process.env, profiles = null } = {}) {
  const me = whichAttempt(root, { env, profiles });
  if (!me) return null;
  const own = me.n === String(n) && me.k === String(k);
  const claim = own ? null : readClaim(markerFile(root, n, k));
  if (!own && claim?.owner !== `${me.n}-${me.k}`) return null;
  const fields = sessionUpdate(a, currentSession(env));
  if (!fields) return null;
  return claim?.wt && !a?.wt ? { ...fields, wt: claim.wt } : fields;
}

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
export function markSessionClaim(root, n, k, { env = process.env, profiles = null } = {}) {
  const me = whichAttempt(root, { env, profiles });
  if (!me || me.n === String(n)) return false;
  try {
    const file = markerFile(root, n, k);
    if (fs.existsSync(file)) return false; // a stamped marker outranks a claim: never overwrite one
    // where the session lives, for `hkb show`'s resume line: a node claimed by hand has no worktree
    // of its own, and pointing a post-mortem at `kb-<node>-<k>` would name one that never existed.
    const here = path.basename(path.resolve(root));
    const wt = parseWorktreeName(here) ? ` ${here}` : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${CLAIMED} ${me.n}-${me.k}${wt}\n`);
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
  // Not a worker session: return before stdin is even read, as this hook always has. The checkout
  // is the second answer, not a second question — one basename, and only when the launch env is
  // missing (`whichAttempt`), so an ordinary session in an ordinary directory still costs nothing.
  const me = whichAttempt(ctx.root, { profiles: ctx.cfg?.profiles, warn: 'hkb hook' });
  if (!me) return 0;
  const { n, k } = me;
  const readStdin = io.readStdin || (() => fs.readFileSync(0, 'utf8'));
  let input = {};
  try { input = normalizeHookInput(JSON.parse(readStdin() || '{}')); } catch { /* no stdin */ }
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
    `\`hkb finish ${n} --from-stdin < /tmp/kb-${n}.json\` (write that file first: {summary, metadata}; or --summary/--summary-file --metadata-file), or \`hkb block ${n} "why" --kind needs_input\`, or \`hkb request-review ${n} --summary "..."\`. ` +
    `(\`finish\` is \`complete\` under a name no shell claims — say \`finish\`, and redirect a file rather than a heredoc, so a harness that vets your command line runs it.) ` +
    `(nudge ${count + 1}/2${input.stop_hook_active ? ', stop_hook_active' : ''})`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  return 0;
}
