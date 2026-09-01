// Pure data model: labels, body block, run comment, result comment, readiness.
// No I/O here — everything is unit-testable.

export const STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'archived'];
export const OUTCOMES = ['completed', 'blocked', 'crashed', 'timed_out', 'spawn_failed', 'reclaimed', 'protocol_violation', 'gave_up', 'review_requested', 'changes_requested'];
export const BLOCK_KINDS = ['dependency', 'needs_input', 'capability', 'transient', 'generic'];

// The two things people pinned a whole `launch` array for (#182): a model and Claude Code's
// `--effort`. Both are profile fields rendered into `{model_args}` now, so the pin is never needed.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

/** What `{model_args}` expands to: `--model <m>` then `--effort <e>`, either or both dropped when unset. Pure. */
export function modelArgs(vars) {
  const out = [];
  if (vars.model) out.push('--model', vars.model);
  if (vars.effort) out.push('--effort', vars.effort);
  return out;
}

export const LABEL_COLORS = {
  'kb:status:triage': 'bfd4f2',
  'kb:status:todo': 'c2e0c6',
  'kb:status:ready': '0e8a16',
  'kb:status:running': 'fbca04',
  'kb:status:blocked': 'd93f0b',
  'kb:status:review': '5319e7',
  'kb:status:done': '0b7a75',
  'kb:status:archived': 'cccccc',
  'kb:needs-human': 'b60205',
  'kb:no-track': 'ededed',
};

export const L = {
  status: (s) => `kb:status:${s}`,
  agent: (p) => `kb:agent:${p}`,
  board: (b) => `kb:board:${b}`,
  needsHuman: 'kb:needs-human',
  // "run my children as cold nodes": the opt-out half of the track inference (`isTrackRoot`).
  noTrack: 'kb:no-track',
};

export const DEFAULT_KB = Object.freeze({
  v: 1,
  priority: 0,
  workspace: 'worktree',
  max_runtime: 3600,
  max_retries: 2,
  model: null,
  skills: [],
  paths: [],
  scheduled_at: null,
  idempotency_key: null,
  goal: null,
});

const BODY_RE = /^\s*<!--\s*kb:\s*(\{[\s\S]*?\})\s*-->\s*\n?/;

/** Parse the machine block at the top of an issue body. Malformed → defaults, never throws. */
export function parseBodyBlock(body) {
  const text = body || '';
  const m = BODY_RE.exec(text);
  let kb = { ...DEFAULT_KB };
  let rest = text;
  if (m) {
    rest = text.slice(m[0].length);
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && typeof parsed === 'object') kb = { ...DEFAULT_KB, ...parsed };
    } catch {
      kb = { ...DEFAULT_KB, _malformed: true };
    }
  }
  return { kb, rest };
}

export function serializeBodyBlock(kb, rest = '') {
  const clean = { ...kb };
  delete clean._malformed;
  return `<!-- kb: ${JSON.stringify(clean)} -->\n${rest.replace(/^\n+/, '')}`;
}

export function statusOf(labels) {
  const l = (labels || []).find((x) => x.startsWith('kb:status:'));
  return l ? l.slice('kb:status:'.length) : null;
}
export function agentOf(labels) {
  const l = (labels || []).find((x) => x.startsWith('kb:agent:'));
  return l ? l.slice('kb:agent:'.length) : null;
}
/**
 * Every profile the labels name. A card carries exactly one `kb:agent:*`; a second one is a silent
 * misroute (#113) — `agentOf` takes the first, so `hkb adopt <n> --agent claude-track` over an
 * existing `kb:agent:claude` left the card dispatching as `claude` while reporting the new profile.
 * `setAgent` is what keeps it to one; this is how `hkb doctor` finds the cards that already have two.
 * The read stays first-wins on purpose: the boards that need diagnosing must still list and show.
 */
export function agentsOf(labels) {
  return (labels || []).filter((x) => x.startsWith('kb:agent:')).map((x) => x.slice('kb:agent:'.length));
}
export function boardOf(labels) {
  const l = (labels || []).find((x) => x.startsWith('kb:board:'));
  return l ? l.slice('kb:board:'.length) : null;
}

// ---------- run comment (Hermes "runs" table) ----------

export const RUN_MARKER = '<!-- kb-run -->';
export const RESULT_MARKER = '<!-- kb-result -->';

export function emptyRun() {
  return { v: 1, attempts: [], failures: 0, block_loops: {}, last_error: null };
}

function extractFencedJson(body, marker) {
  if (!body || !body.includes(marker)) return null;
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function parseRunComment(body) {
  const parsed = extractFencedJson(body, RUN_MARKER);
  if (!parsed) return null;
  return { ...emptyRun(), ...parsed, attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [] };
}

/**
 * Choose the authoritative run comment when an issue has several (a create that was
 * followed by another create instead of an update). Newest wins — it is the one written
 * last by the dispatcher; older ones are duplicates for `hkb gc` to delete.
 */
export function pickRunComment(comments) {
  const runs = (comments || []).filter((c) => c && typeof c.body === 'string' && c.body.startsWith(RUN_MARKER));
  if (!runs.length) return { chosen: null, duplicates: [] };
  return { chosen: runs[runs.length - 1], duplicates: runs.slice(0, -1) };
}

export function openAttempt(run) {
  if (!run) return null;
  return [...run.attempts].reverse().find((a) => !a.ended_at) || null;
}

export function lastAttempt(run) {
  if (!run || !run.attempts.length) return null;
  return run.attempts[run.attempts.length - 1];
}

function fmt(ts) { return ts ? String(ts).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : ''; }

export function serializeRunComment(run) {
  const rows = run.attempts.map((a) =>
    `| ${a.attempt} | ${a.profile || ''} | ${a.host || ''} | ${fmt(a.started_at)} | ${fmt(a.ended_at) || '—'} | ${a.outcome || 'active'} | ${(a.summary || a.reason || '').split('\n')[0].slice(0, 120)} |`);
  return [
    RUN_MARKER,
    '**hkb run record** — maintained by `hkb`; do not edit by hand.',
    '',
    `failures: ${run.failures} · attempts: ${run.attempts.length}${run.last_error ? ` · last error: ${String(run.last_error).slice(0, 200)}` : ''}`,
    '',
    '| # | profile | host | started | ended | outcome | note |',
    '|---|---|---|---|---|---|---|',
    ...(rows.length ? rows : ['| — | | | | | | |']),
    '',
    '```json',
    JSON.stringify(run, null, 2),
    '```',
  ].join('\n');
}

// ---------- result comment (structured handoff) ----------

export function parseResultComment(body) {
  return extractFencedJson(body, RESULT_MARKER);
}

export function serializeResultComment(res) {
  const meta = res.metadata || {};
  const lines = [RESULT_MARKER, `### ${res.kind === 'review' ? 'Review requested' : 'Result'} — attempt ${res.attempt ?? '—'}`, '', res.summary || '(no summary)', ''];
  if (meta.changed_files?.length) lines.push('**Changed files:** ' + meta.changed_files.map((f) => '`' + f + '`').join(', '));
  if (meta.verification?.length) lines.push('**Verification:** ' + meta.verification.map((f) => '`' + f + '`').join(', '));
  if (meta.residual_risk?.length) lines.push('**Residual risk:** ' + meta.residual_risk.join('; '));
  // Which PR carries this attempt — and, when the reviewer sent the card back, that the attempt
  // *continued* that PR instead of opening a second one (#153).
  if (res.pr) lines.push(`**PR:** #${res.pr}${res.pr_continued ? ' — continued after changes requested, not reopened' : ''}`);
  if (res.artifacts?.length) lines.push('**Artifacts:** ' + res.artifacts.join(', '));
  lines.push('', '```json', JSON.stringify(res, null, 2), '```');
  return lines.join('\n');
}

// ---------- readiness & guards ----------

/** A blocker counts as done only when it is closed as completed (Hermes: parents `done`). */
export function blockerDone(b) {
  if (!b) return false;
  const state = String(b.state || '').toUpperCase();
  const reason = String(b.stateReason || b.state_reason || '').toUpperCase();
  return state === 'CLOSED' && reason !== 'NOT_PLANNED' && reason !== 'DUPLICATE';
}

export function computeReady(task, now = new Date()) {
  const blockers = task.blockedBy || [];
  if (!blockers.every(blockerDone)) return false;
  const at = task.kb?.scheduled_at;
  if (at && new Date(at).getTime() > now.getTime()) return false;
  return true;
}

/** The blockers this task is still waiting on — its unfinished children, in board order. */
export function unfinishedChildren(task) {
  return (task?.blockedBy || []).filter((b) => !blockerDone(b)).map((b) => Number(b.number));
}

/**
 * The board's track profile for a node on `agent`: a profile with `"track": true` whose
 * `track_agents` can execute that node profile (unset `track_agents` → only its own name, so a
 * board that never listed one infers nothing and keeps node dispatch). Pure; first match wins, in
 * board.json order, so a board with two track profiles picks the one it declared first.
 */
export function trackProfileFor(cfg, agent) {
  if (!agent) return null;
  for (const [name, p] of Object.entries(cfg?.profiles || {})) {
    if (!p?.track) continue;
    if (name === agent) return name;
    const list = Array.isArray(p.track_agents) && p.track_agents.length ? p.track_agents : [name];
    if (list.includes(agent)) return name;
  }
  return null;
}

/** Statuses a parent must be in for its child to count as "inside someone else's track". */
const LIVE_PARENT = ['triage', 'todo', 'ready', 'running', 'blocked', 'review'];

/**
 * Is this task a track root — a root the dispatcher should hand to ONE orchestrating session?
 *
 * A DAG has a root, edges, nodes and leaves: the root is the agent that runs, its children run
 * inside it and report back, and the root finishes last. That is a property of the *graph*, so it
 * is inferred rather than switched on: a task with at least one unfinished child, on a profile some
 * track profile can execute, is a track. The label stays the override in both directions —
 * `kb:agent:<a track profile>` forces one (the historical `hkb adopt --agent claude-track`), and
 * `kb:no-track` opts a goal out when its children should run as cold nodes instead.
 *
 * Inference only fires for a *maximal* root. Pass the open board as `board` and a task that is
 * itself still blocking something is a node of that bigger track, not a root of its own — without
 * it every interior node of a chain would claim its own subgraph and race the real root. `board` is
 * optional so a single-card caller (`hkb show`) can still say what the card is in isolation.
 *
 * Pure: no I/O, and every "no" is a fallback to node dispatch, never an error.
 * @returns {{track, mode, why, profile, children}} mode: forced | inferred | opted-out | none
 */
export function isTrackRoot(task, cfg, { board = null } = {}) {
  const children = unfinishedChildren(task || {});
  const nope = (mode, why) => ({ track: false, mode, why, profile: null, children });
  if (!task) return nope('none', 'no such task');
  // the historical switch, and still the override: an explicit track profile is a track even with
  // nothing left blocking it — `trackReadiness` then says so in the words it always did. It also
  // beats `kb:no-track`: adopting a card onto a track profile is the more recent, more specific
  // statement, and a card on that profile has no sensible node launch to fall back to anyway.
  if (cfg?.profiles?.[task.agent]?.track) {
    return { track: true, mode: 'forced', why: `kb:agent:${task.agent} forces a track`, profile: task.agent, children };
  }
  if (!children.length) return nope('none', 'nothing is blocking it any more — dispatch it as a single node');
  if ((task.labels || []).includes(L.noTrack)) return nope('opted-out', `${L.noTrack} — its children run as cold nodes`);
  const profile = trackProfileFor(cfg, task.agent);
  if (!profile) return nope('none', `profile ${task.agent || 'none'} does not run tracks`);
  if (board) {
    const parent = board.find((t) => t.number !== task.number && LIVE_PARENT.includes(t.status)
      && (t.blockedBy || []).some((b) => Number(b.number) === task.number && !blockerDone(b)));
    if (parent) return nope('none', `#${parent.number} is still blocked by it — it is a node of that track, not a root`);
  }
  const n = children.length;
  return { track: true, mode: 'inferred', why: `${n} unfinished child${n === 1 ? '' : 'ren'}`, profile, children };
}

/**
 * What `promote` does to one card, pure. `allowForce` is the single-node call on a card with no open
 * blockers left (a track of one) — exactly today's behaviour, including forcing `todo`/`blocked`
 * straight to `ready` over open blockers, because a human typing `hkb promote <n>` on that card is the
 * override.
 *
 * A cascade sweeping up a card's still-open blockers must never do that (#209): forcing a blocker
 * ready is worse than leaving it alone, because the root then reads "queued" while the graph under it
 * is not. So with `allowForce: false` a `todo` card only advances when it is genuinely ready, and a
 * `blocked` card — parked for a human, not for its blockers — is left alone outright.
 */
export function promoteDecision(task, { allowForce = false } = {}) {
  const status = task.status;
  if (status === 'triage') return { to: 'todo' };
  if (status === 'todo') {
    const ready = computeReady(task);
    if (ready || allowForce) return { to: 'ready', forced: !ready };
    return { to: status, skipped: true, reason: 'blockers still open' };
  }
  if (status === 'blocked') {
    if (!allowForce) return { to: status, skipped: true, reason: 'blocked — needs human' };
    return { to: 'ready', forced: !computeReady(task) };
  }
  return { to: status, skipped: true, reason: `already ${status}` };
}

/**
 * The `active_pr` guard, and its one exemption — a pure function of the attempt rows and the card's
 * PRs, so the tick can decide without a second thought and the table lives in a test.
 *
 * A `ready` card with an open PR normally goes straight back to `review`: its work is done and
 * waiting on a human, and claiming it again would have a second worker redo it. The exception is
 * exactly the card `hkb request-changes` produces. The reviewer's synthetic `changes_requested` row
 * (protocol.md) *means* "this PR is open and must be continued", so there the open PR is the
 * continuation target, not a duplicate risk — without the exemption the verb is a no-op on any board
 * with a dispatcher: the card bounces back to `review` on the next tick and nothing reads the review
 * (#153). Keyed on that row and nothing else; every other open-PR case keeps the guard.
 *
 * One consequence worth knowing: only the *latest* row exempts. A continuation that crashes leaves
 * `crashed` on top, so the guard parks the card in `review` again rather than respawning — one
 * relaunch per `request-changes`, and the reviewer decides whether there is a second.
 *
 * A card can carry two open PRs (a stray one opened by hand, say); which one this attempt continues
 * is not a guess — the last `review_requested`/`completed` row named it (`prAttemptFields`), so that
 * PR wins over an arbitrary "first OPEN" pick when both are still open.
 *
 * @param attempts the run record's `attempts[]`, oldest first
 * @param prs the card's PRs as the board query returns them (`{number, state, headRefName, ...}`)
 * @returns {{guard: boolean, pr: object|null, continues: boolean, why: string}}
 */
export function activePrGuard(attempts, prs) {
  const open = (prs || []).filter((p) => p && p.state === 'OPEN');
  if (!open.length) return { guard: false, pr: null, continues: false, why: 'no open PR' };
  const named = [...(attempts || [])].reverse().find((a) => a?.pr != null)?.pr;
  const pr = (named != null && open.find((p) => p.number === named)) || open[0];
  const last = attempts?.length ? attempts[attempts.length - 1] : null;
  if (last?.outcome === 'changes_requested') {
    return { guard: false, pr, continues: true, why: `PR #${pr.number} has changes requested — the next attempt continues it` };
  }
  return { guard: true, pr, continues: false, why: `PR #${pr.number} is open` };
}

export function pathsOverlap(a = [], b = []) {
  const norm = (p) => String(p).replace(/\*+.*$/, '').replace(/\/+$/, '');
  for (const x of a.map(norm)) for (const y of b.map(norm)) {
    if (!x || !y) return true; // an empty pattern means "anything"
    if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
  }
  return false;
}

// ---------- path_overlap guard ----------
// The guard exists to avoid the *merge* conflict when two PRs touch the same files — every worker
// already runs in its own worktree, so it was never about two workers touching one file at once.
// "running" (today's behaviour) keys that on *running* attempts, which only approximates "avoid a
// merge conflict" when review → merged is immediate (`merge.mode: "auto"`). On a `manual` board the
// first card's PR then waits on a human and the guard buys nothing but serialisation — see #185.

export const PATH_OVERLAP_MODES = ['off', 'running', 'unmerged'];

/**
 * The effective `path_overlap` guard mode and where it came from. Pure — never throws, so a bad
 * value degrades to "off" rather than taking out the whole tick (same posture as `mergePolicy`).
 *
 * Precedence: an explicit `dispatch.guards.path_overlap` always wins. Failing that, the legacy
 * boolean `dispatch.path_guard` — the only knob this guard had before #185 — is honored so a board
 * that already set it keeps meaning what it meant (`true` → "running", `false` → "off"). Only when
 * neither is set does the default follow `merge.mode`: "off" when the last step is manual (the
 * guard's premise — "running approximates merged" — does not hold when a human sits between review
 * and merge), "unmerged" when it is "auto" (where review → merged is immediate, so it does).
 */
export function pathOverlapGuard(cfg) {
  const raw = cfg?.dispatch?.guards?.path_overlap;
  if (raw != null) {
    if (!PATH_OVERLAP_MODES.includes(raw)) {
      return {
        mode: 'off',
        source: 'invalid',
        error: `dispatch.guards.path_overlap must be one of ${PATH_OVERLAP_MODES.map((m) => JSON.stringify(m)).join(', ')}, not ${JSON.stringify(raw)}`,
      };
    }
    return { mode: raw, source: 'dispatch.guards.path_overlap', error: null };
  }
  if (cfg?.dispatch?.path_guard === false) return { mode: 'off', source: 'dispatch.path_guard: false', error: null };
  if (cfg?.dispatch?.path_guard === true) return { mode: 'running', source: 'dispatch.path_guard: true', error: null };
  const policy = mergePolicy(cfg);
  const mode = policy.auto ? 'unmerged' : 'off';
  return { mode, source: `default for merge.mode ${JSON.stringify(policy.mode)}`, error: null };
}

/**
 * Which open-board tasks hold their `paths` against the path_overlap guard, under one mode. Pure.
 *   "off"      → nothing holds anything.
 *   "running"  → today's behaviour: every running task, minus one whose attempt has gone idle
 *                (`idleNumbers` — a running task an idle attempt must never hold behind, whatever
 *                the mode; see `attemptIdle`).
 *   "unmerged" → "running", plus a task in review whose PR is still open — it has not merged, so
 *                the collision the guard exists to avoid is still ahead of it.
 */
export function pathHolders(tasks, mode, idleNumbers = new Set()) {
  if (mode === 'off') return [];
  return (tasks || []).filter((t) => {
    if (t.status === 'running') return !idleNumbers.has(t.number);
    if (mode === 'unmerged' && t.status === 'review') return (t.prs || []).some((p) => p && p.state === 'OPEN');
    return false;
  });
}

/**
 * The holder(s) a candidate's `paths` collide with, and which of their paths — what a guard hit
 * names instead of a bare "guarded: path_overlap" (#176, folded into #185). Pure.
 * @param {string[]} paths the candidate's own `kb.paths`
 * @param {Array<{number:number, kb?:{paths?:string[]}, paths?:string[]}>} holders from `pathHolders`
 */
export function pathCollisions(paths, holders) {
  const out = [];
  for (const h of holders || []) {
    const hp = h.kb?.paths || h.paths || [];
    if (hp.length && pathsOverlap(hp, paths)) out.push({ number: h.number, paths: hp });
  }
  return out;
}

/**
 * Has a running attempt gone idle — no sign of life for well past its heartbeat cadence — so the
 * path_overlap guard (whatever its mode) must never count it as holding its paths? Pure.
 *
 * Two liveness sources outrank timing a signal at all: a `claude-bg` attempt's job record —
 * `jobAlive` is the daemon itself saying whether the turn is still going, so a live job holds no
 * matter how stale `lastSignal` looks (the default heartbeat is a ref-CAS that never touches the run
 * comment, so `lastSignal` sits at `started_at` for the attempt's whole life) — and a `process`
 * attempt's live pid, just as authoritative and just as unbothered by the same stale timestamp. Only
 * an attempt with neither (manual, remote, or a bg job on another host) falls back to `lastSignal`:
 * no heartbeat for longer than `intervalSeconds`, a threshold the caller sets above the ~10-minute
 * floor a `comment`-mode worker beats on. A fresh attempt with no signal yet (`lastSignal` null) is
 * never idle — there has been no time to go quiet.
 *
 * This never reclaims or ends the attempt (#136 owns that) — it only says whether the path_overlap
 * guard may skip over it.
 */
export function attemptIdle(job, lastSignal, intervalSeconds, now = Date.now(), livePid = false) {
  if (job) return !jobAlive(job);
  if (livePid) return false;
  if (!lastSignal) return false;
  const age = (now - new Date(lastSignal).getTime()) / 1000;
  return Number.isFinite(age) && age > intervalSeconds;
}

export function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

// ---------- boards on one server (`hkb serve --repos`) ----------

/**
 * `--repos ../a,../b#release` → [{ path, board }]. A trailing `#slug` picks a board *within* that
 * checkout; without one the checkout's own board.json decides. Pure: nothing is resolved or read.
 */
export function parseRepoSpecs(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = [];
  for (const item of items) {
    const spec = typeof item === 'string' ? item.trim() : item;
    if (!spec) continue;
    if (typeof spec === 'object') {
      const p = String(spec.path || spec.root || '').trim();
      if (p) out.push({ path: p, board: spec.board ? String(spec.board).trim() : null });
      continue;
    }
    const hash = spec.lastIndexOf('#');
    if (hash > 0) out.push({ path: spec.slice(0, hash).trim(), board: spec.slice(hash + 1).trim() || null });
    else out.push({ path: spec, board: null });
  }
  return out.filter((s) => s.path);
}

/**
 * Add one checkout to a user-level board list, unless an equivalent entry is already there.
 *
 * The list is a file a human writes and re-reads, so this only ever *appends*: entries it did not
 * add keep their order and their spelling — `~/code/web` typed by hand stays `~/code/web`, and the
 * object form stays an object. Two entries are the same when they name the same board of the same
 * resolved path, which is what `resolve` is for: pass `(p) => path.resolve(expandHome(p))` and
 * `~/projects/x` and `/home/you/projects/x` become one entry (this module is pure, so the default
 * compares the spellings verbatim). A null `board` means "the checkout's own default" and is
 * written as a bare path string, never as `"default"`.
 *
 * @param {Array<string|object>} entries the list exactly as it appears on disk
 * @param {string|{path: string, board?: string|null}} entry the checkout to add
 * @param {(p: string) => string} [resolve] how a spelling becomes the path entries compare by
 * @returns {{entries: Array<string|object>, added: boolean}}
 */
export function mergeBoardEntry(entries, entry, resolve = (p) => p) {
  const list = Array.isArray(entries) ? entries : [];
  const [want] = parseRepoSpecs([entry]);
  if (!want) {
    const e = new Error('a board list entry needs a path, e.g. "/path/to/checkout"');
    e.exitCode = 2;
    throw e;
  }
  // NUL joins the two halves of the identity: no path or slug can contain it, so no spelling can
  // forge a collision. Written as an escape, not a literal byte — a literal one makes grep and
  // ripgrep treat this whole file as binary and skip it, and model.js is the file people search.
  const key = (s) => `${resolve(s.path)}\u0000${s.board || ''}`;
  if (parseRepoSpecs(list).some((s) => key(s) === key(want))) return { entries: list, added: false };
  return { entries: [...list, want.board ? { path: want.path, board: want.board } : want.path], added: true };
}

/**
 * URL-safe, human-legible id for one board on the web server: `owner~repo~slug`. It goes in a path
 * segment (`/api/boards/<key>/tasks/12/move`), so anything outside [A-Za-z0-9._-] collapses to `~`.
 */
export function boardKey(nameWithOwner, board) {
  return `${nameWithOwner}/${board}`.replace(/[^A-Za-z0-9._-]+/g, '~').replace(/^~+|~+$/g, '') || 'board';
}

/** Two boards must never share a URL: disambiguate a repeated key with ~2, ~3 … in list order. */
export function uniqueKeys(keys) {
  const seen = new Set();
  return keys.map((k) => {
    let out = k;
    for (let n = 2; seen.has(out); n++) out = `${k}~${n}`;
    seen.add(out);
    return out;
  });
}

export function lockRef(n, k) { return `refs/kb/locks/${n}/${k}`; }
/** Path form used by GET/PATCH/DELETE git/refs endpoints (no leading "refs/"). */
export function lockRefPath(n, k) { return `kb/locks/${n}/${k}`; }

// ---------- heartbeat ----------
// A heartbeat says "the worker is alive". Two ways to say it:
//   ref     — compare-and-swap on the lock ref (`git push --force-with-lease`). Free: the git
//             transport is not the REST content budget, and a rejected lease *is* LOCK_LOST.
//   comment — a write to the `<!-- kb-run -->` comment, floored at 10 min. For workers that
//             cannot push to arbitrary refs (cloud tiers); the dispatcher owns their lock.

export const HEARTBEAT_MODES = ['auto', 'ref', 'comment'];

/** How a profile's workers heartbeat. Unknown or unset → `auto` (ref, falling back to comment). */
export function heartbeatMode(cfg, profileName) {
  const m = cfg?.profiles?.[profileName]?.heartbeat;
  return HEARTBEAT_MODES.includes(m) ? m : 'auto';
}

/**
 * What a `git push --force-with-lease` on the lock ref means.
 *   ok          → the lease held: the ref was where we left it, and now carries a fresh commit
 *   lost        → the lease was rejected: the ref moved or is gone (verify, then LOCK_LOST)
 *   unavailable → git, network or auth trouble — says nothing about the lock
 * Only a rejected lease is ever `lost`: an unrecognised failure must never fabricate a LOCK_LOST,
 * because that kills a healthy worker. Ambiguity falls back to the authoritative ref read instead.
 * `git push --delete`d and never-existed refs both come back as "[rejected] ... (stale info)".
 */
export function classifyLeasePush(status, output) {
  if (status === 0) return 'ok';
  return /stale info|\[rejected\]/i.test(String(output || '')) ? 'lost' : 'unavailable';
}

/**
 * The freshest evidence that an attempt is alive: its run-comment beat, when it started, and
 * (for a ref-CAS worker, which writes nothing to the comment) the lock ref's commit date.
 * Returns the winning timestamp as given, or null when there is none.
 */
export function lastSignalAt(attempt, refBeatAt = null) {
  const ms = (x) => { const t = x ? new Date(x).getTime() : NaN; return Number.isFinite(t) ? t : -Infinity; };
  return [attempt?.heartbeat_at, attempt?.started_at, refBeatAt].reduce((best, x) => (ms(x) > ms(best) ? x : best), null) || null;
}

export function priorityOf(task) { return Number(task.kb?.priority ?? 0) || 0; }

/** Sort ready tasks: higher priority first, then oldest issue first. */
export function sortForDispatch(tasks) {
  return [...tasks].sort((a, b) => priorityOf(b) - priorityOf(a) || a.number - b.number);
}

// ---------- the last step: merging ----------
// hkb never merges. `dispatch.merge.mode: "auto"` asks *GitHub's* auto-merge to land a card's PR
// once the branch's own gates are green; `"manual"` — the default, and what every board that
// predates this says — leaves the last step to the operator. Whether that step is a rote chore or
// the one gate worth keeping is a property of the repo, so it is board policy, not a product
// decision. The dispatcher enables it, never the worker: merge authority is an operator concern.

export const MERGE_MODES = ['manual', 'auto'];
/** board.json spelling → the `PullRequestMergeMethod` enum `enablePullRequestAutoMerge` wants. */
export const MERGE_METHODS = { squash: 'SQUASH', merge: 'MERGE', rebase: 'REBASE' };

/**
 * The board's merge policy, normalised. Never throws: a policy hkb cannot read must not take out
 * every command that loads board.json, and `auto` stays false, so an unreadable policy behaves
 * exactly like today's `manual`. `error` is what doctor fails on and the tick prints.
 */
export function mergePolicy(cfg) {
  const raw = cfg?.dispatch?.merge || {};
  const mode = raw.mode ?? 'manual';
  const method = raw.method ?? 'squash';
  const errors = [];
  if (!MERGE_MODES.includes(mode)) errors.push(`dispatch.merge.mode must be ${MERGE_MODES.map((m) => `"${m}"`).join(' or ')}, not ${JSON.stringify(mode)}`);
  if (!MERGE_METHODS[method]) errors.push(`dispatch.merge.method must be one of ${Object.keys(MERGE_METHODS).join(', ')}, not ${JSON.stringify(method)}`);
  return { mode, method, mergeMethod: MERGE_METHODS[method] || null, auto: !errors.length && mode === 'auto', error: errors.join('; ') || null };
}

/**
 * The PR of a card the dispatcher would hand to GitHub's auto-merge — and why not, when it would
 * not. Pure. `pr.autoMergeEnabled` comes from the board query, so a PR that already carries an
 * auto-merge request costs no second mutation: enabling is once per PR, not once per tick.
 */
export function autoMergeDecision(task, policy) {
  if (!policy?.auto) return { enable: false, pr: null, why: 'dispatch.merge.mode is manual' };
  if (task.status !== 'review') return { enable: false, pr: null, why: `#${task.number} is ${task.status}, not review` };
  const pr = (task.prs || []).find((p) => p && p.state === 'OPEN') || null;
  if (!pr) return { enable: false, pr: null, why: 'no open PR' };
  if (pr.isDraft) return { enable: false, pr, why: `PR #${pr.number} is still a draft` };
  if (pr.autoMergeEnabled) return { enable: false, pr, why: `PR #${pr.number} already has auto-merge enabled` };
  if (!pr.nodeId) return { enable: false, pr, why: `PR #${pr.number} came back from the board query without a node id` };
  return { enable: true, pr, method: policy.method, why: `PR #${pr.number} → auto-merge (${policy.method})` };
}

/** The one fix for every way the gate can fail: put a gate on the branch, or keep the last step. */
export function mergeGateFix(branch) {
  return `require a status check on ${branch} (Settings → Branches, or a ruleset), or set "dispatch": {"merge": {"mode": "manual"}} in .kanban/board.json`;
}

/**
 * Is it honest to hand this branch to auto-merge? Auto-merge on an **unprotected** branch merges the
 * moment it is enabled — "hand the last step to GitHub" would mean landing agent-authored code
 * unreviewed and untested — so the answer is yes only when something has to go green first: a
 * required status check, or a required approving review. Anything else, including a branch whose
 * protection this token cannot read, is a refusal: the gate is what makes the feature safe, and a
 * gate that cannot be verified is not a gate. `protection` is what `branchProtection()` returns.
 */
export function mergeGate(protection, branch) {
  const p = protection || {};
  const no = (detail) => ({ ok: false, detail, fix: mergeGateFix(branch) });
  if (!p.known) return no(`${branch}'s protection could not be read${p.why ? ` (${p.why})` : ''}, so auto-merge cannot be shown to be safe`);
  if (p.requiredChecks?.length) return { ok: true, detail: `${branch} requires ${p.requiredChecks.join(', ')}${p.requiredReviews ? ` and ${p.requiredReviews} approving review(s)` : ''}` };
  if (p.requiredReviews > 0) return { ok: true, detail: `${branch} requires ${p.requiredReviews} approving review(s)` };
  if (p.protected) return no(`${branch} is protected but requires no status check and no approving review, so auto-merge would land a PR the moment it opens`);
  return no(`${branch} has no branch protection, so auto-merge would land agent-authored code the moment the PR opens`);
}

// ---------- background-agent jobs (`claude --bg`) ----------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** `claude --bg` prints "backgrounded · <id> · <name>"; extract the id. */
export function parseBackgroundedId(stdout) {
  const all = [...String(stdout || '').replace(ANSI_RE, '').matchAll(/backgrounded\s*·\s*([0-9a-f]{6,})/gi)];
  return all.length ? all[all.length - 1][1] : null;
}

export const KB_JOB_NAME_RE = /^kb #(\d+) · /;

/** Job name shown in `claude agents` for a task. */
export function jobName(task) { return `kb #${task.number} · ${task.title}`; }

/**
 * Decide what a background job's state means for an open attempt.
 *   working / busy               → still running
 *   blocked / waiting            → alive, waiting on a permission prompt or input — NOT finished
 *   done / stopped / idle / gone → finished the turn without a terminal verb → protocol_violation
 *   missing entirely             → crashed
 * Verified 2026-08-26: an agent on a permission prompt lists as status "waiting", state "blocked";
 * treating that as finished killed two working attempts (#14/2, #3/2).
 */
export function jobAlive(job) {
  if (!job) return false;
  return job.state === 'working' || job.status === 'busy' || job.state === 'blocked' || job.status === 'waiting';
}

export function classifyJob(job) {
  if (!job) return 'crashed';
  return jobAlive(job) ? 'running' : 'protocol_violation';
}

// ---------- worker session: id, transcript, cost ----------
// A worker is a real agent session. The attempt row carries its id so a human can reopen it
// (`claude --resume <id>` inside the worker's worktree) and see what the attempt cost.

/** Attempt-row fields that describe the underlying agent session. */
export const SESSION_FIELDS = ['session_id', 'transcript_path', 'total_cost_usd', 'num_turns', 'duration_ms', 'terminal_reason', 'api_error_status', 'model_usage', 'permission_denials'];

// `claude -p --output-format json` names its per-model usage `modelUsage` — camelCase, unlike every
// other field in the same result object — so it is read under that name and stored under hkb's own
// snake_case spelling, the same aliasing `HOOK_FIELD_ALIASES` does for a hook payload.
const RESULT_FIELD_ALIASES = { model_usage: 'modelUsage' };

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** The session fields of an arbitrary object (a hook payload, a result line), or null when it has none. */
function sessionFieldsOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of SESSION_FIELDS) {
    const v = obj[k] !== undefined ? obj[k] : obj[RESULT_FIELD_ALIASES[k]];
    if (typeof v === 'string' && v) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (k === 'model_usage' && v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out[k] = v;
    else if (k === 'permission_denials' && Array.isArray(v) && v.length) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The session behind a background agent, out of the job record Claude Code keeps for it
 * (`~/.claude/jobs/<id>/state.json`): `sessionId` is the session, `linkScanPath` the transcript it
 * writes. Pure — `currentSession` (src/jobs.js) reads the file. null when it names neither.
 *
 * This is the only local source a `claude --bg` worker has for its own identity: the launch
 * environment never reaches it, so nothing keyed on `KB_TASK` can answer for it. See src/hook.js.
 */
export function sessionFromJobState(state) {
  return sessionFieldsOf({ session_id: state?.sessionId, transcript_path: state?.linkScanPath });
}

/**
 * Session id and cost out of a worker log. `claude -p --output-format json` ends with one JSON
 * object holding `session_id`, `total_cost_usd`, `num_turns`, `duration_ms`, and — since #155 — why
 * it ended (`terminal_reason`, `api_error_status`), what it spent per model (`modelUsage`, read
 * under hkb's `model_usage`) and which tool calls it never got to run (`permission_denials`); with
 * `stream-json` that object is the last line. Total: a truncated or non-JSON log yields null, never
 * a throw — the dispatcher must never lose a reclaim to a malformed log. Unknown fields are ignored,
 * so an old log with none of this still parses exactly as it did before.
 */
export function parseSessionLog(text, { maxLines = 200 } = {}) {
  const s = String(text || '');
  const lines = s.split('\n');
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < maxLines; i--, seen++) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    const found = sessionFieldsOf(tryJson(line));
    if (found) return found;
  }
  // pretty-printed JSON spans several lines: nesting is indented, so "\n{" is the outermost object
  const start = s.lastIndexOf('\n{');
  return sessionFieldsOf(tryJson(start < 0 ? s : s.slice(start + 1)));
}

/**
 * What still has to be written onto an attempt row — the "record once" decision. The Stop hook
 * fires up to three times per attempt and the dispatcher looks again on exit, so `null` means
 * "already recorded, skip the PATCH". Unknown keys are ignored; a changed value wins.
 */
export function sessionUpdate(attempt, fields) {
  const found = sessionFieldsOf(fields);
  if (!found) return null;
  const a = attempt || {};
  const out = {};
  // `model_usage` and `permission_denials` are objects/arrays: a fresh JSON.parse of the same log
  // never `===` the row's own copy, so a reference check would call every Stop hook fire "new".
  for (const [k, v] of Object.entries(found)) if (JSON.stringify(a[k]) !== JSON.stringify(v)) out[k] = v;
  return Object.keys(out).length ? out : null;
}

/**
 * A denied `Agent` call still fires `PreToolUse` before Claude Code refuses it, and a subagent can
 * die mid-run without ever firing `SubagentStop` — both leave `started` permanently ahead of `ended`,
 * which would suppress every future Stop on this attempt forever (worse than the false nudge #163 set
 * out to fix). So suppression is bounded: once a Stop has been suppressed this many times in a row
 * for the same attempt, `shouldNudgeOnStop` gives up waiting and nudges anyway. Chosen against the
 * idle-tick cadence a track root reschedules itself on (20-30 minutes, see `ScheduleWakeup` guidance)
 * — high enough that a wave with several genuinely long-running subagents does not trip it, low
 * enough that a stuck attempt recovers within a couple of hours rather than never.
 */
const MAX_SUPPRESSED_STOPS = 4;

/**
 * Whether a Stop that finds the task still "running" is the real "forgot the verb" case, or a track
 * root that correctly ended its own turn while a wave of subagents is still out (#163). `started` and
 * `ended` come from the hook's own bookkeeping (`src/hook.js`): `PreToolUse` on the `Agent` tool is the
 * only "started" signal a hook sees, `SubagentStop` the only "ended" one — measured order, 2026-08-28
 * spike (job `cadca6f1`):
 *
 *   PreToolUse Agent (root)      → started: 1
 *   Stop (root, children live)   → shouldNudgeOnStop({started: 1, ended: 0}) === false
 *   SubagentStop                 → ended: 1
 *   Stop (root resumes, forgets) → shouldNudgeOnStop({started: 1, ended: 1}) === true
 *
 * Unreadable or absent bookkeeping defaults to `{started: 0, ended: 0}` — nudge as today, on purpose
 * (a false nudge costs a turn, a missed one costs the protocol; never suppress on a guess).
 *
 * `suppressed` is how many consecutive Stops this attempt has already had suppressed; past
 * `MAX_SUPPRESSED_STOPS` a still-live-looking wave is nudged anyway (see above).
 */
export function shouldNudgeOnStop({ started = 0, ended = 0, suppressed = 0 } = {}) {
  if (ended >= started) return true;
  return suppressed >= MAX_SUPPRESSED_STOPS;
}

function fmtCost(usd) { return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`; }
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** `session <id> · $0.42 · 37 turns · 6m12s` — '' for an attempt with nothing recorded. */
export function formatSession(a) {
  if (!a) return '';
  const bits = [];
  if (a.session_id) bits.push(`session ${a.session_id}`);
  if (Number.isFinite(a.total_cost_usd)) bits.push(fmtCost(a.total_cost_usd));
  if (Number.isFinite(a.num_turns)) bits.push(`${a.num_turns} turns`);
  if (Number.isFinite(a.duration_ms)) bits.push(fmtDuration(a.duration_ms));
  return bits.join(' · ');
}

/** `Bash ×3, WebFetch ×1` from `permission_denials`, grouped by tool — '' when there are none. */
export function formatDenials(a) {
  const denials = a?.permission_denials;
  if (!Array.isArray(denials) || !denials.length) return '';
  const counts = new Map();
  for (const d of denials) {
    const tool = (d && (d.tool_name || d.tool)) || 'unknown';
    counts.set(tool, (counts.get(tool) || 0) + 1);
  }
  return [...counts].map(([tool, n]) => `${tool} ×${n}`).join(', ');
}

/**
 * Whether a worker's exit reads as auth trouble worth pausing its profile for, out of what
 * `parseSessionLog` read from its log — `null` for no. A `401`/`429` on `api_error_status` is the
 * result saying so outright; the log-tail pattern this replaces (#155) is kept as a fallback only for
 * a log `parsed` found no JSON result line in at all, since a run that never reached the result
 * object never sets `api_error_status` either.
 */
export function authPauseReason(parsed, logTail) {
  const status = parsed ? Number(parsed.api_error_status) : NaN;
  if (status === 401 || status === 429) return `api_error_status ${status}`;
  if (!parsed && /429|rate limit|quota|401|unauthorized|not logged in/i.test(String(logTail || ''))) return 'log tail matched the auth-trouble pattern';
  return null;
}

/** Where `claude --worktree kb-<n>-<k>` puts a worker's checkout, relative to the board root. */
export function worktreePath(wt) { return `.claude/worktrees/${wt}`; }

/**
 * The task and attempt a worker checkout belongs to, read back out of its directory name — the
 * inverse of the `kb-<n>-<k>` the launch template asks for. Both as strings; null when the
 * directory is not a worker's.
 *
 * The dispatcher already identifies a running background job this way (`matchJobByWorktree`,
 * src/jobs.js). It is also all a `claude --bg` session knows about which attempt it is, since the
 * environment the launch sets never reaches it — see `whichAttempt` in src/hook.js.
 */
export function parseWorktreeName(name) {
  const m = /^kb-(\d+)-(\d+)$/.exec(String(name ?? ''));
  return m ? { n: m[1], k: m[2] } : null;
}

// ---------- the launch environment, and where it must not end up ----------

/**
 * What the dispatcher puts in a worker launch's environment: which task, which attempt, which
 * board. For a harness it runs as a child process (`claude -p`, Copilot, Codex) this is the
 * worker's whole identity and the hook's gate. Named here because two places have to agree on the
 * list — `spawnWorker` sets them, and a `claude --bg` launch scrubs them (src/dispatch.js).
 */
export const KB_ENV_VARS = ['KB_TASK', 'KB_ATTEMPT', 'KB_BOARD', 'KB_REPO', 'KB_LOCK_REF', 'KB_ROOT', 'KB_PROFILE'];

/**
 * A copy of `env` with every `KB_*` key removed — the environment a `claude --bg` launch gets.
 *
 * `claude --bg` does not run the worker: it hands the request to Claude Code's session daemon and
 * exits. When no daemon is up yet that launch *starts* one, and the daemon keeps the environment it
 * was started with for its whole life — so `KB_TASK` ends up in every session that daemon will ever
 * host, the operator's own conversations included. Measured on this board (#150): an operator
 * session was stamped onto #146's attempt row as the session that did the work, and hkb's worker
 * permission policy was enforced on that operator's shell.
 *
 * Nothing is lost by removing it. The daemon does not forward the launch environment to the session
 * it hosts (#125) — which is why the `kb-<n>-<k>` checkout is that profile's identity — so on this
 * path the variables reach no worker at all; they only ever poison the shared process. Every `KB_*`
 * key goes, not just the identity: none of them means anything to a session daemon.
 *
 * Checked before choosing this over passing the environment to the session instead: Claude Code
 * 2.1.x has no flag that hands env to a `--bg` session (`claude --help`, 2026-08-28).
 */
export function scrubKbEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!k.startsWith('KB_')) out[k] = v;
  return out;
}

/** The `KB_*` names in a NUL-separated `/proc/<pid>/environ` dump. Pure; never throws. */
export function kbVarsIn(environ) {
  const out = [];
  for (const entry of String(environ || '').split('\0')) {
    const m = /^(KB_[A-Z0-9_]+)=/.exec(entry);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Does this profile's worker sit in a `kb-<n>-<k>` checkout hkb can name?
 *
 * Two modes qualify, and only these two, because in both hkb *knows* where the worker is: a
 * `claude --bg` job is identified by its worktree basename (`matchJobByWorktree`, src/jobs.js), and
 * a `workspace: "worktree"` launch is handed that directory as its cwd (`spawnWorker`). A
 * `mode: "process"` Claude profile also passes `--worktree`, but where its *hooks* run is the
 * harness's business, not ours — and its environment dies with the process, so it can never be the
 * source of a leak. A `trigger` profile's worker runs in an Actions checkout that is nobody's
 * worktree. Both are left exactly as they were.
 */
export function worksInWorktree(profile) {
  return profile?.mode === 'claude-bg' || profile?.workspace === 'worktree';
}

/**
 * Which attempt a session is: the launch environment and the checkout, read together.
 *
 * `KB_TASK` is the first answer and the `kb-<n>-<k>` checkout the second (#125). This is the case
 * where they *disagree*: a session whose environment says #146 while it sits at the board root, or
 * in another attempt's checkout, is not that worker — it inherited the variables from a session
 * daemon a `claude --bg` launch started (see `scrubKbEnv`). The environment is then a leak, not an
 * identity: it is dropped, the checkout answers if it can, and `leak` carries the one line the
 * caller owes whoever is reading stderr.
 *
 * Only judged for a profile whose worker really does sit in a worktree (`worksInWorktree`) — for
 * every other profile the environment is that worker's whole identity and is trusted exactly as it
 * always has been. For one that does, the worker's root is deterministic: `KB_ROOT` joined with
 * `kb-<n>-<k>` (`ensureWorktree`, src/board.js) — a `claude-track` runner claims further nodes from
 * inside that same checkout, never a `KB_ROOT`-rooted one of its own. Evidence for agreement is
 * therefore exactly one thing: `herePath` — the cwd's resolved absolute path — equal to
 * `rootPath` joined with that same `kb-<n>-<k>`. A directory that merely happens to be *named*
 * `kb-<n>-<k>` — a same-numbered worktree under an unrelated `KB_ROOT`, a review worktree copied
 * elsewhere, a session hosted from a different repo whose daemon was poisoned by this board's
 * `KB_ROOT` (#150 B1) — fails that comparison and is a leak, not an identity, even though
 * `parseWorktreeName` still reads its basename correctly. When `rootPath` is unknown (`KB_ROOT`
 * unset) agreement can never be proven, so it is a leak too.
 *
 * @param {{env?: object, here?: string, herePath?: string, rootPath?: string|null, profile?: object|null}} where
 *   `here` is the cwd's basename, `herePath`/`rootPath` the caller's already-`path.resolve`d absolute
 *   paths of the cwd and of `KB_ROOT` (`rootPath` is `null` when `KB_ROOT` is unset).
 * @returns {{n: string, k: string, source: 'env'|'worktree', leak?: string}|{leak: string}|null}
 */
export function attemptIdentity({ env = {}, here = '', herePath = '', rootPath = null, profile = null } = {}) {
  const wt = parseWorktreeName(here);
  const n = env.KB_TASK ? String(env.KB_TASK) : null;
  if (!n) return wt ? { ...wt, source: 'worktree' } : null;
  const k = env.KB_ATTEMPT ? String(env.KB_ATTEMPT) : '0';
  const numbersAgree = wt && wt.n === n && (wt.k === k || k === '0');
  const expectedPath = numbersAgree && rootPath ? `${rootPath}/${worktreePath(`kb-${wt.n}-${wt.k}`)}` : null;
  // the checkout agrees — same task/attempt AND actually rooted where the launch put it
  if (expectedPath && expectedPath === herePath) return { n, k: wt.k, source: 'env' };
  if (!worksInWorktree(profile)) return { n, k, source: 'env' };
  // anywhere else — the board root, a mismatched kb-<n>-<k>, a same-named checkout under a foreign
  // KB_ROOT, a review worktree — is not this attempt's worktree, whether or not it happens to be
  // *somebody's* worktree (#150 B1)
  const atRoot = !!rootPath && herePath === rootPath;
  let where;
  if (!wt) where = atRoot ? 'this is the board root' : `${here || 'here'} is not a kb-<n>-<k> worktree`;
  else if (!numbersAgree) where = `${here} is #${wt.n} attempt ${wt.k}`;
  else where = rootPath ? `${here} is not under KB_ROOT (${rootPath})` : 'KB_ROOT is not set';
  const leak = `KB_TASK=${n} in the environment but this is not its worktree (${where}); ignoring`;
  return wt ? { ...wt, source: 'worktree', leak } : { leak };
}

/** The command that reopens a worker session for a post-mortem. null when no session id is known. */
export function resumeCommand(a, number = null) {
  if (!a?.session_id) return null;
  const wt = a.wt || (number ? `kb-${number}-${a.attempt}` : null);
  const resume = `claude --resume ${a.session_id}`;
  return wt ? `cd ${worktreePath(wt)} && ${resume}` : resume;
}

// ---------- harness hook payloads ----------
// Claude Code and Copilot CLI both feed their stop hook one JSON object on stdin, but spell the
// fields differently: Claude uses snake_case (`session_id`, `transcript_path`, `stop_hook_active`),
// Copilot camelCase (`sessionId`, `transcriptPath`, `hookEventName`). Normalise to Claude's spelling
// so `hkb hook stop` reads one shape; unknown keys pass through untouched. See src/hook.js.

const HOOK_ALIASES = {
  sessionId: 'session_id',
  transcriptPath: 'transcript_path',
  hookEventName: 'hook_event_name',
  stopHookActive: 'stop_hook_active',
  agentStopActive: 'stop_hook_active',
  workingDirectory: 'cwd',
  totalCostUsd: 'total_cost_usd',
  numTurns: 'num_turns',
  durationMs: 'duration_ms',
};

/** A stop-hook payload from any harness in hkb's (Claude's) spelling. Never throws. */
export function normalizeHookInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = { ...raw };
  for (const [from, to] of Object.entries(HOOK_ALIASES)) {
    if (raw[from] !== undefined && out[to] === undefined) out[to] = raw[from];
  }
  return out;
}

// ---------- where hkb's hooks are declared ----------
// One shape, two destinations. A `matcher: "*"` group per event is what Claude Code reads out of a
// settings file (`installClaudeHooks`, src/init.js) and what it reads out of `--settings` on a
// launch — so both are built here, and neither can drift from the other.
//
// The launch is the default (#144). hkb's hooks serve exactly one kind of session, the worker hkb
// started, and a settings file is read by *every* session in that repo: an `hkb` that stops
// resolving there — an nvm switch, a cleaned npx cache, a teammate without the global — turns into a
// failed `PreToolUse` on every tool call in sessions that have nothing to do with the board. Claude
// Code takes `--settings <file-or-json>` per launch, so the worker's hooks ride the same line that
// already carries its whole permission policy and nobody else ever sees them.

/** Every session's tools: hkb's hooks are not scoped to a tool, they are scoped to a session. */
export const HOOK_MATCHER = '*';
/** Seconds. All three hooks return in milliseconds unless they are talking to GitHub. */
export const HOOK_TIMEOUT = 30;

/** One `hooks.<Event>` entry running `command`, in the shape both destinations take. */
export function hookEntry(command) {
  return { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] };
}

/**
 * hkb's hooks as the JSON string a `claude --settings` takes. Pure, so what a launch carries is
 * tested without launching anything.
 *
 * Claude Code parses this value as inline settings when it starts with `{` and as a path otherwise,
 * and — measured live against 2.1.251, a Stop hook firing seconds after a `claude --bg` launch,
 * comment on #144 — `handleBgFlag → spawnBgSession`'s respawn-flag allowlist keeps `--settings
 * <value>` as a pair and forwards a `{`-leading value into the session daemon untouched. So the
 * command inside may name *this* machine: the launch never leaves it, which is exactly what a
 * tracked settings file could not say (#85).
 * @param events `{ <Event>: <verb> }` — CLAUDE_HOOKS in src/init.js
 * @param command `(verb) => string`, the shell command that runs that hook verb here
 * @returns the JSON, or '' when there is nothing to declare — callers drop the flag on ''
 */
export function hookSettings(events, command) {
  const hooks = {};
  for (const [event, verb] of Object.entries(events || {})) {
    const c = command(verb);
    if (c) hooks[event] = [hookEntry(c)];
  }
  return Object.keys(hooks).length ? JSON.stringify({ hooks }) : '';
}

// ---------- installed skill version ----------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Everything after a SKILL.md-style front matter block (the document itself). */
export function stripFrontmatter(text) {
  const s = String(text || '');
  const fm = FRONTMATTER_RE.exec(s);
  return (fm ? s.slice(fm[0].length) : s).replace(/^\s*\n/, '');
}

/** `metadata.version` out of a SKILL.md front matter block. null when absent or unparsable. */
export function parseSkillVersion(text) {
  const fm = FRONTMATTER_RE.exec(String(text || ''));
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break; // a dedent ends the metadata mapping
    const m = /^\s+version:\s*['"]?([^'"\s#]+)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** Compare dotted numeric versions. -1 / 0 / 1, or null when either side is not comparable. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const core = String(v ?? '').trim().replace(/^v/, '').split(/[-+]/)[0];
    return /^\d+(\.\d+)*$/.test(core) ? core.split('.').map(Number) : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------- where the running hkb came from ----------
// The generated hook command differs by install shape (src/init.js hkbCommandForHook): a global
// `npm i -g`, an `npx` run out of a cache that is gone the next time npm cleans it, and — the one
// that is exact and the same on every machine at once — an hkb that lives INSIDE the repo it is
// setting up. That last one is not one shape but two, and the difference does not matter: a
// `npm i -D hkb-cli` devDependency sits at `node_modules/hkb-cli`, hkb's own checkout is the repo
// root itself, and both are named the same way, relative to `$CLAUDE_PROJECT_DIR`.

/**
 * Where `target` sits inside `root`, as a `/`-separated relative path — `''` when it *is* `root`,
 * null when it is somewhere else entirely (#146). The remainder is measured, never composed: a
 * pnpm store resolves through `node_modules/.pnpm/<name>@<version>/node_modules/<name>`, and a path
 * built out of the package's name instead would name a file that is not there.
 *
 * A path comparison, never PATH: `npx` puts `node_modules/.bin` on its child's PATH, so "is hkb on
 * PATH" answers yes for a repo-local install too — and then answers no in the plain `/bin/sh` a hook
 * runs in. String work rather than `node:path` so this file stays I/O- and import-free; both
 * arguments are already absolute where it is called, and the result is POSIX because it goes into a
 * shell command line rather than back into `path.join`.
 */
export function insideRepo(root, target) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const [base, t] = [norm(root), norm(target)];
  if (!base || !t) return null;
  if (t === base) return '';
  return t.startsWith(`${base}/`) ? t.slice(base.length + 1) : null;
}

/**
 * `PATH` without its `node_modules/.bin` entries — the PATH a *hook* will actually have. `npx` and
 * `npm run` prepend one; the `/bin/sh` Claude Code starts a hook command in never has it. So a binary
 * found only there is not on PATH for the thing being configured, and a command written on that
 * evidence fails on every tool call in every session (#146).
 * @param sep the platform's PATH delimiter (`path.delimiter`) — passed in, so this stays pure
 */
export function stripNodeModulesBin(PATH, sep = ':') {
  return String(PATH || '').split(sep).filter((e) => !/node_modules[\\/]+\.bin[\\/]*$/.test(e.trim())).join(sep);
}

// ---------- worker permission policy (PreToolUse hook) ----------
// A background worker has nobody to answer a prompt, so hkb decides itself. `decidePermission`
// itself answers allow or deny, pure and unit-tested either way — but what the hook actually ships
// (src/hook.js) is deny-with-reason or silence: an explicit allow would override Claude Code's own
// checks, so only a deny is ever written to stdout, and "ask" never happens either way.

export const SAFE_BUILTINS = ['cd', 'pwd', 'true', 'false', 'echo', 'printf', 'test', '[', 'env', 'which', 'command', 'type', 'sleep', 'time', 'set', 'export'];
export const DENY_PATTERNS = [
  // `up` starts a dispatcher and `down` stops the one that is running you — both are the dispatcher's
  // life, and neither is a worker's to touch.
  { re: /\bhkb\s+(dispatch|up|down)\b/, why: 'workers never start or stop the dispatcher — it is what dispatched you; a second dispatcher against the live board double-claims tasks, and stopping this one strands every attempt it is watching. Test dispatch logic with the fake-gh test double (node --test test/dispatch.test.js)' },
  { re: /\b(pkill|killall)\b|\bkill\s+(-\w+\s+)?[0-9]/, why: 'workers do not signal other processes' },
  { re: /git\s+push[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease)/, why: 'force-push is forbidden by the kanban protocol' },
  { re: /\bsudo\b/, why: 'no privilege escalation in a worker' },
  { re: /\brm\s+(-\w*r\w*f|-\w*f\w*r)\b[^|;&]*\s\//, why: 'recursive force-delete of an absolute path' },
];

export function allowedCommandsFrom(allowedTools = []) {
  const out = new Set(SAFE_BUILTINS);
  for (const t of allowedTools) {
    const m = /^Bash\((\S+?)(?:\s|\))/.exec(t);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * The command names a launch's own allow-list actually spells — `Bash(git *)` and Copilot's
 * `shell(git:*)` both name `git`. The sibling of `allowedCommandsFrom`, and deliberately the
 * unseeded one: that function answers "what may a worker run", so seeding it with SAFE_BUILTINS is
 * right; this one answers "what did the *launch* say", which is the only way to see a list that has
 * fallen behind (#138). Anything that is not a shell pattern (`Edit`, `Read`, `write`) is not a
 * command and is skipped.
 */
export function harnessCommands(allowedTools = []) {
  const out = new Set();
  for (const t of allowedTools || []) {
    const m = /^(?:Bash|shell)\(\s*(.+?)\s*\)$/.exec(String(t));
    if (!m) continue;
    const first = m[1].split(/\s+/)[0].replace(/:\*$/, '');
    if (first) out.add(first);
  }
  return out;
}

/**
 * The SAFE_BUILTINS a launch's allow-list leaves out. hkb's own PreToolUse guard permits every one
 * of them, so a list that omits them makes the two layers disagree — and under `--permission-mode
 * dontAsk` the harness denies rather than prompts, so the stricter, staler layer wins and a worker
 * spends its turns rewriting commands hkb already called safe.
 *
 * `null` means the profile has no per-command allow-list at all (Codex, whose sandbox is the whole
 * policy): nothing to fall behind, so nothing to report.
 */
export function uncoveredBuiltins(allowedTools) {
  if (!allowedTools) return [];
  const have = harnessCommands(allowedTools);
  return SAFE_BUILTINS.filter((c) => !have.has(c));
}

/**
 * Blank out the parts of a command line the shell never executes: quoted strings and heredoc
 * bodies. Without this, `hkb complete 5 --summary "done; verified"` splits into two "commands"
 * and a worker is denied its own terminal verb, with its own prose echoed back as command names.
 * One left-to-right scan, so a `<<EOF` inside quotes is text and a quote inside a body is not a
 * quote. Data out, operators (`&& || ; |`, newlines) kept — everything else stays where it was.
 */
function stripShellData(command) {
  const src = String(command);
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += ' '; i += 2; continue; }  // \<newline> joins two lines; \x is one literal char
    if (c === "'" || c === '"') {                      // a quoted argument, to its close or to the end
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += (c === '"' && src[j] === '\\') ? 2 : 1;
      out += ' '; i = j + 1; continue;
    }
    const h = c === '<' && src[i + 1] === '<' && src[i + 2] !== '<'
      && /^<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/.exec(src.slice(i));
    if (h) {                                           // a heredoc body, to its terminator line or to the end of the line
      const rest = src.slice(i + h[0].length), nl = rest.indexOf('\n');
      const end = new RegExp(`^[ \\t]*${h[2]}[ \\t]*$`, 'm').exec(rest);
      out += ' '; i += h[0].length + (end ? end.index + end[0].length : nl < 0 ? rest.length : nl);
      continue;
    }
    out += c; i++;
  }
  return out;
}

function firstWords(command) {
  // top-level segments split on && || ; | and newlines — good enough for policy, not a full shell parser
  return stripShellData(command).split(/&&|\|\||;|\||\n/).map((seg) => {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    for (const w of words) { if (!w.includes('=') && !w.startsWith('-')) return w.replace(/^.*\//, ''); }
    return null;
  }).filter(Boolean);
}

/**
 * @returns {decision: 'allow'|'deny', reason, kind?: 'policy'|'capability'|'path'} `kind` is only
 *   meaningful on a deny: `path` for a write outside the worktree, `policy` for one of DENY_PATTERNS
 *   (forbidden outright, not a missing permission), `capability` for a command the launch's own
 *   allow-list never granted — the one case where `hkb block --kind capability` is the right next step,
 *   because it is the only kind a wider allow-list could actually fix.
 */
export function decidePermission(toolName, input, { allowedCmds, root }) {
  const FILE_TOOLS = ['Edit', 'Write', 'Read', 'NotebookEdit'];
  if (FILE_TOOLS.includes(toolName)) {
    const p = input?.file_path || input?.path || '';
    if (!p.startsWith('/') || (root && (p === root || p.startsWith(root.endsWith('/') ? root : root + '/'))))
      return { decision: 'allow', reason: 'file inside the repository' };
    return { decision: 'deny', reason: `path ${p} is outside the repository ${root}; keep all changes inside the worktree`, kind: 'path' };
  }
  if (toolName !== 'Bash') return { decision: 'allow', reason: 'non-shell tool' };
  const command = String(input?.command || '');
  // The deny patterns deliberately read the raw line, quotes and heredoc bodies included: they are a
  // coarse "this smells dangerous" net, and `node -e "...--force..."` must not slip past by quoting.
  // Their reasons name a policy rather than echoing the text, so a false positive is not misleading.
  for (const d of DENY_PATTERNS) if (d.re.test(command)) return { decision: 'deny', reason: d.why, kind: 'policy' };
  const offending = [...new Set(firstWords(command).filter((w) => !allowedCmds.has(w)))];
  if (!offending.length) return { decision: 'allow', reason: 'all commands allowlisted' };
  return {
    decision: 'deny',
    reason: `command(s) not allowlisted for workers: ${offending.join(', ')} — each is a program this line would run (quoted text and heredoc bodies are not scanned, so nothing here comes from your prose). Use one of: ${[...allowedCmds].sort().join(', ')} — or do the work with the Edit/Write/Read tools.`,
    kind: 'capability',
  };
}

export function hashReason(reason) {
  const s = String(reason || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

// ---------- the long-running processes (`hkb up` / `hkb down`) ----------
// A board keeps moving because two processes are up: the dispatcher loop, and (optionally) the web
// board. `hkb up` starts them detached and idempotently; everything it decides is here, so the
// decision, the status line and the log line are unit-tested and up.js is only the spawn and the
// filesystem. A process's state is `{ name, running, pid, since, log, exit, exited_at }`.

/** The processes `hkb up` knows how to start, in the order it starts them. */
export const PROCESSES = ['dispatch', 'serve'];

/**
 * `KB_*` names a *worker*: KB_TASK/KB_ATTEMPT/KB_LOCK_REF/KB_PROFILE/KB_ROOT are what the dispatcher
 * exports onto a worker's launch, and a process that carries them believes it is one. `hkb up` may be
 * run from such a session (or from one that wrongly believes it is), and the daemons it starts outlive
 * it — a dispatcher loop that thinks it is worker #148 would refuse to run and a `hook stop` inside it
 * would write to a stranger's card. So the child gets none of them, and the board comes from `--board`
 * on the command line instead of `KB_BOARD`.
 *
 * `KB_CONFIG_HOME` is the exception: it is not an identity, it is where `~/.config/hkb/boards.json`
 * lives, and dropping it would send a test's or a smoke run's server at the real user-level list.
 */
export const DETACHED_ENV_KEEP = ['KB_CONFIG_HOME'];

/** A copy of `env` with every worker-identity variable removed. Pure. */
export function detachedEnv(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('KB_') || DETACHED_ENV_KEEP.includes(k)) out[k] = v;
  return out;
}

/**
 * How much the boot comparison forgives. mtime is wall time and `os.uptime()` is monotonic, so the
 * two disagree by a little; the slack errs towards *believing* a pid file, because calling a live
 * dispatcher stale would start a second loop — the very bug the pid file exists to prevent.
 */
export const PID_BOOT_SLACK_MS = 5_000;

/**
 * Parse `btime` (the boot instant, epoch seconds, fixed at boot) out of `/proc/stat` text. Unlike
 * `now - os.uptime()`, `btime` does not drift when the wall clock is resynced against a host while
 * the machine is suspended (WSL2's VM clock does this across every suspend/resume). Pure; malformed
 * or missing input is null — "no better boot instant than the derived one".
 */
export function parseBtimeSec(procStatText) {
  const m = /^btime\s+(\d+)\s*$/m.exec(String(procStatText || ''));
  return m ? Number(m[1]) : null;
}

/** Parse `sysctl -n kern.boottime` output (`{ sec = 1690000000, usec = 123456 } ...`), macOS's `btime`. Pure. */
export function parseKernBoottimeSec(sysctlText) {
  const m = /sec\s*=\s*(\d+)/.exec(String(sysctlText || ''));
  return m ? Number(m[1]) : null;
}

/**
 * When this machine booted, in ms since epoch: the kernel-reported instant (`btimeSec`) when one was
 * found, else the derived `now - uptime`. Pure; no boot evidence at all (neither) means null — no
 * verdict is possible.
 */
export function bootInstantMs({ btimeSec = null, uptime = 0, now = Date.now() } = {}) {
  if (btimeSec) return btimeSec * 1000;
  if (uptime) return now - uptime * 1000;
  return null;
}

/**
 * Is this pid file a claim a reboot invalidated? A pid file is a claim, and after a reboot it is a
 * claim on a pid the kernel has since handed to somebody else. `.kanban/*.pid` is a plain file: it
 * survives the reboot, `pidAlive` says "yes, something answers to 3843", and `hkb down` would
 * SIGTERM a stranger's process.
 *
 * The zero-dependency guard is arithmetic: a pid file written *before this machine booted* cannot
 * name a process of ours that is still running, whatever `kill(pid, 0)` says. Boot is `bootInstantMs`
 * — `btimeSec` when the caller has one, else derived from `uptime` (`os.uptime()`, seconds); `at` is
 * the file's mtime. No boot instant to compare against means no verdict, so the file is believed.
 */
export function pidFileStale(at, { now = Date.now(), uptime = 0, btimeSec = null } = {}) {
  if (!at) return false;
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return false;
  const boot = bootInstantMs({ btimeSec, uptime, now });
  if (boot === null) return false;
  return t < boot - PID_BOOT_SLACK_MS;
}

/**
 * Does `/proc/<pid>/cmdline` (NUL-joined argv, as the kernel writes it) belong to our own
 * `hkb dispatch --loop` / `hkb serve`? True or false once `/proc` answered; null when there is
 * nothing to check it against (no `/proc` — macOS — or the caller has no cmdline at all), which
 * tells `pidClaimStale` to fall back to the timestamp verdict rather than guess.
 */
export function cmdlineIsOurs(cmdline, name) {
  if (cmdline == null) return null;
  const argv = String(cmdline).split('\0').filter(Boolean);
  if (!argv.length) return null;
  const joined = argv.join(' ');
  if (name === 'dispatch') return /\bdispatch\b/.test(joined) && /--loop\b/.test(joined);
  if (name === 'serve') return /\bserve\b/.test(joined);
  return false;
}

/**
 * The staleness verdict `readPidFile` actually acts on: the timestamp verdict (`pidFileStale`),
 * rescued when it says stale but the pid is demonstrably still ours. A wrong-stale verdict is not
 * cosmetic — `startProcess`/the dispatcher's singleton lock/the server's claim all read "stale" as
 * "no claim here" and start a rival (#205, WSL2: the wall clock resyncs against the host across
 * suspend/resume while `/proc/uptime` keeps its own count, so the derived boot instant walks past
 * pid files written earlier in the same session). Corroboration only ever *rescues* a stale verdict,
 * never manufactures one the arithmetic didn't already reach — a pid file the timestamp already
 * believes needs no `/proc` round-trip, and a live-but-unrelated pid is exactly the reused-pid case
 * (#202) the arithmetic exists to refuse, so an inconclusive or contradicting cmdline leaves that
 * refusal standing.
 */
export function pidClaimStale({ at, name, alive, cmdline, now = Date.now(), uptime = 0, btimeSec = null } = {}) {
  if (!pidFileStale(at, { now, uptime, btimeSec })) return false;
  if (!alive) return true;
  return cmdlineIsOurs(cmdline, name) !== true;
}

/**
 * How long `hkb down` waits for a process to be gone before it gives up and says so. A SIGTERM'd
 * dispatcher wakes out of its sleep at once but still finishes a tick already in flight, and a tick
 * is bounded by nothing shorter than the interval it runs on — so two of them, floored so a fast
 * board still gets a fair wait and capped so `hkb down` never becomes the thing that hangs.
 */
export function stopWaitMs(interval, { min = 5_000, max = 120_000 } = {}) {
  const n = Number(interval);
  if (!Number.isFinite(n) || n <= 0) return min;
  return Math.min(max, Math.max(min, Math.round(n * 2 * 1000)));
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * An instant as an operator reads it: `19:02` when it is today, `2026-08-26 19:02` when it is not —
 * "since 19:02" is a lie about a loop that has been up since Tuesday. Local time on purpose: this is
 * for a human sitting at the machine the process runs on. Unparseable input → null.
 */
export function formatSince(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return null;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

/**
 * One line per process, for `hkb up`, `hkb up --status` and `hkb down`.
 *
 * Exit code 4 is the dispatcher loop giving itself up for a supervisor to restart (`src/dispatch.js`).
 * `hkb up` is not a supervisor and never restarts anything — so the honest thing is to report the exit
 * and name the command that would start a fresh one.
 */
export function processLine(st, { now = new Date(), already = false } = {}) {
  const log = st.log ? ` · log ${st.log}` : '';
  if (st.running) {
    const since = formatSince(st.since, now);
    return `${st.name} ${already ? 'already ' : ''}running pid ${st.pid}${since ? ` since ${since}` : ''}${log}`;
  }
  // A pid file older than the boot names a pid this kernel has since reissued: say that, rather than
  // a bare "stopped" that leaves an operator wondering why the file is there.
  if (st.stale) return `${st.name} stopped (pid file predates this boot — hkb up replaces it)`;
  if (st.exit !== null && st.exit !== undefined) {
    const at = formatSince(st.exited_at, now);
    return `${st.name} exited (${st.exit})${at ? ` at ${at}` : ''} — hkb up restarts it${log}`;
  }
  return `${st.name} stopped`;
}

/**
 * Does `hkb up` start this process? A live pid file means "already running", not a second loop — the
 * dispatcher's singleton lock would refuse the second one anyway, and saying so before spawning is
 * the difference between an idempotent command and a command that leaves a corpse in the log.
 * @returns {{start: boolean, line: string}}
 */
export function startDecision(st, { now = new Date() } = {}) {
  if (st.running) return { start: false, line: processLine(st, { now, already: true }) };
  return { start: true, line: null };
}

/** The `# <ISO> started pid N` header `hkb up` appends to a log before its child writes to it. */
export function startLogLine(at, pid, argv = []) {
  return `# ${at} started pid ${pid}${argv.length ? ` — ${argv.join(' ')}` : ''}\n`;
}

/**
 * What `up` reports for a child that is already dead at the `SPAWN_CHECK_MS` recheck: a `failed`
 * entry, not a `started` one — a script that only reads `started`/exit-code must see this as the
 * failure it is (#164). `log` is the log path relative to the board root, the same one the line
 * points at.
 * @returns {{line: string, failed: {name: string, pid: number, log: string}}}
 */
export function deadAtRecheck(name, pid, log) {
  return { line: `${name} exited immediately (pid ${pid}) — see ${log}`, failed: { name, pid, log } };
}
