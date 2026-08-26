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

export function priorityOf(task) { return Number(task.kb?.priority ?? 0) || 0; }

/** Sort ready tasks: higher priority first, then oldest issue first. */
export function sortForDispatch(tasks) {
  return [...tasks].sort((a, b) => priorityOf(b) - priorityOf(a) || a.number - b.number);
}

// ---------- background-agent jobs (`claude --bg`) ----------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** `claude --bg` prints "backgrounded · <id> · <name>"; extract the id. */
export function parseBackgroundedId(stdout) {
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(String(stdout || '').replace(ANSI_RE, ''));
  return m ? m[1] : null;
}

export const KB_JOB_NAME_RE = /^kb #(\d+) · /;

/** Job name shown in `claude agents` for a task. */
export function jobName(task) { return `kb #${task.number} · ${task.title}`; }

/**
 * Decide what a background job's state means for an open attempt.
 *   working            → still running
 *   done / idle / gone → the session finished its turn without a terminal verb → protocol_violation
 *   missing entirely   → crashed
 */
export function classifyJob(job) {
  if (!job) return 'crashed';
  if (job.state === 'working' || job.status === 'busy') return 'running';
  return 'protocol_violation';
}

export function hashReason(reason) {
  const s = String(reason || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}
