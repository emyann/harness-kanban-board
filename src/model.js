// Pure data model: labels, body block, run comment, result comment, readiness.
// No I/O here — everything is unit-testable.

export const STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'archived'];
export const OUTCOMES = ['completed', 'blocked', 'crashed', 'timed_out', 'spawn_failed', 'reclaimed', 'protocol_violation', 'gave_up', 'review_requested', 'changes_requested'];
export const BLOCK_KINDS = ['dependency', 'needs_input', 'capability', 'transient', 'generic'];

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
};

export const L = {
  status: (s) => `kb:status:${s}`,
  agent: (p) => `kb:agent:${p}`,
  board: (b) => `kb:board:${b}`,
  needsHuman: 'kb:needs-human',
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

export function pathsOverlap(a = [], b = []) {
  const norm = (p) => String(p).replace(/\*+.*$/, '').replace(/\/+$/, '');
  for (const x of a.map(norm)) for (const y of b.map(norm)) {
    if (!x || !y) return true; // an empty pattern means "anything"
    if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
  }
  return false;
}

export function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
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
export const SESSION_FIELDS = ['session_id', 'transcript_path', 'total_cost_usd', 'num_turns', 'duration_ms'];

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** The session fields of an arbitrary object (a hook payload, a result line), or null when it has none. */
function sessionFieldsOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of SESSION_FIELDS) {
    const v = obj[k];
    if (typeof v === 'string' && v) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Session id and cost out of a worker log. `claude -p --output-format json` ends with one JSON
 * object holding `session_id`, `total_cost_usd`, `num_turns`, `duration_ms`; with `stream-json`
 * that object is the last line. Total: a truncated or non-JSON log yields null, never a throw —
 * the dispatcher must never lose a reclaim to a malformed log.
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
  for (const [k, v] of Object.entries(found)) if (a[k] !== v) out[k] = v;
  return Object.keys(out).length ? out : null;
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

/** Where `claude --worktree kb-<n>-<k>` puts a worker's checkout, relative to the board root. */
export function worktreePath(wt) { return `.claude/worktrees/${wt}`; }

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

// ---------- worker permission policy (PreToolUse hook) ----------
// A background worker has nobody to answer a prompt, so hkb decides itself:
// explicit allow or deny-with-reason, never "ask". Pure and unit-tested.

export const SAFE_BUILTINS = ['cd', 'pwd', 'true', 'false', 'echo', 'printf', 'test', '[', 'env', 'which', 'command', 'type', 'sleep', 'time', 'set', 'export'];
export const DENY_PATTERNS = [
  { re: /\bhkb\s+dispatch\b/, why: 'workers never run the dispatcher — it is what dispatched you; a second dispatcher against the live board double-claims tasks. Test dispatch logic with the fake-gh test double (node --test test/dispatch.test.js)' },
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

function firstWords(command) {
  // top-level segments split on && || ; | — good enough for policy, not a full shell parser
  return String(command).split(/&&|\|\||;|\|/).map((seg) => {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    for (const w of words) { if (!w.includes('=') && !w.startsWith('-')) return w.replace(/^.*\//, ''); }
    return null;
  }).filter(Boolean);
}

/** @returns {decision: 'allow'|'deny', reason} */
export function decidePermission(toolName, input, { allowedCmds, root }) {
  const FILE_TOOLS = ['Edit', 'Write', 'Read', 'NotebookEdit'];
  if (FILE_TOOLS.includes(toolName)) {
    const p = input?.file_path || input?.path || '';
    if (!p.startsWith('/') || (root && (p === root || p.startsWith(root.endsWith('/') ? root : root + '/'))))
      return { decision: 'allow', reason: 'file inside the repository' };
    return { decision: 'deny', reason: `path ${p} is outside the repository ${root}; keep all changes inside the worktree` };
  }
  if (toolName !== 'Bash') return { decision: 'allow', reason: 'non-shell tool' };
  const command = String(input?.command || '');
  for (const d of DENY_PATTERNS) if (d.re.test(command)) return { decision: 'deny', reason: d.why };
  const words = firstWords(command);
  const offending = words.filter((w) => !allowedCmds.has(w));
  if (!offending.length) return { decision: 'allow', reason: 'all commands allowlisted' };
  return {
    decision: 'deny',
    reason: `command(s) not allowlisted for workers: ${offending.join(', ')}. Use one of: ${[...allowedCmds].sort().join(', ')} — or do the work with the Edit/Write/Read tools.`,
  };
}

export function hashReason(reason) {
  const s = String(reason || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}
