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

// ---------- installed skill version ----------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

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
