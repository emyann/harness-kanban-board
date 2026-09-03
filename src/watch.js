// `hkb watch` / `hkb tail` — the board as a stream of transitions.
//
// Frugal by construction: every poll is a conditional GET. We keep the `ETag` of the last
// representation and send it back as `If-None-Match`; GitHub answers 304 with an empty body and
// charges nothing against the rate limit, so a quiet board costs zero units however long you watch.
// Only a 200 is diffed against the previous snapshot, and only a difference prints a line.
//
// Two sources per command, both conditional:
//   watch   the board issues (one page, most-recently-updated first) → status/agent/state changes
//           the repository's issue comments since start                → attempts, outcomes, results
//   tail    the one issue                                              → its status changes
//           the one issue's comments                                   → its attempts and comments
//
// GraphQL has no conditional requests, so this is the one read path that is REST rather than
// `fetchBoard` — a watcher that ran the board query every 30s would spend real quota doing nothing.
import { restRaw } from './gh.js';
import { api } from './board.js';
import {
  L, STATUSES, OUTCOMES, RUN_MARKER, RESULT_MARKER,
  statusOf, agentOf, boardOf, parseRunComment, parseResultComment,
} from './model.js';

export const DEFAULT_INTERVAL = 30;
/** A watcher that polls faster than this is not frugal, whatever the flag says. */
export const MIN_INTERVAL = 5;
/** Longest back-off after a transient failure, in seconds. */
export const MAX_BACKOFF = 300;

export const EVENT_KINDS = ['appeared', 'status', 'agent', 'needs-human', 'closed', 'reopened', 'attempt', 'outcome', 'result', 'comment'];

/**
 * What `--kinds` accepts: an event kind, or the status/outcome an event landed on. So
 * `--kinds completed,blocked` reads naturally and `--kinds status,attempt` also works.
 */
export const KIND_TOKENS = [...new Set([...EVENT_KINDS, 'state', ...STATUSES, ...OUTCOMES])];

const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };

// ---------- pure: snapshots and diffs ----------

const firstLine = (s, max = 60) => {
  const line = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

/**
 * The watched shape of a REST issue: everything a transition can be seen in, nothing else.
 * `board` filters to one board's issues; null keeps whatever came back (`hkb tail` on one issue).
 */
export function boardIndex(issues, board = null) {
  const index = new Map();
  for (const i of [].concat(issues || [])) {
    if (!i || typeof i !== 'object' || i.pull_request) continue;
    const labels = (i.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
    if (board && boardOf(labels) !== board) continue;
    index.set(i.number, {
      number: i.number,
      title: i.title || '',
      status: statusOf(labels),
      agent: agentOf(labels),
      needsHuman: labels.includes(L.needsHuman),
      state: String(i.state || '').toUpperCase(),
      stateReason: i.state_reason ? String(i.state_reason).toUpperCase() : null,
      at: i.updated_at || null,
      url: i.html_url || null,
    });
  }
  return index;
}

/**
 * Transitions between two board snapshots. Only issues present in `next` are compared: the poll
 * window is the most-recently-updated page, so an issue missing from it has not changed — it
 * scrolled out, and reporting that as a departure would be a lie.
 */
export function diffBoard(prev, next) {
  const events = [];
  for (const [number, now] of next) {
    const was = prev.get(number);
    const base = { number, title: now.title, url: now.url, at: now.at };
    if (!was) {
      events.push({ ...base, kind: 'appeared', to: now.status, tags: ['appeared', now.status].filter(Boolean) });
      continue;
    }
    if (was.status !== now.status) events.push({ ...base, kind: 'status', from: was.status, to: now.status, tags: ['status', now.status].filter(Boolean) });
    if (was.agent !== now.agent) events.push({ ...base, kind: 'agent', from: was.agent, to: now.agent, tags: ['agent'] });
    if (was.needsHuman !== now.needsHuman) events.push({ ...base, kind: 'needs-human', to: now.needsHuman, tags: ['needs-human'] });
    if (was.state !== now.state) {
      const closed = now.state === 'CLOSED';
      events.push({
        ...base,
        kind: closed ? 'closed' : 'reopened',
        reason: closed ? String(now.stateReason || 'COMPLETED').toLowerCase() : null,
        tags: [closed ? 'closed' : 'reopened', 'state'],
      });
    }
  }
  return events;
}

/** Empty follow state: which attempts and comments we have already reported. */
export function emptyWatchState() {
  return { attempts: new Map(), comments: new Set() };
}

const ISSUE_NUMBER_RE = /\/issues\/(\d+)$/;

/** The issue a repository-wide comment belongs to, from its `issue_url`. */
export function issueNumberOf(comment, fallback = null) {
  const m = ISSUE_NUMBER_RE.exec(String(comment?.issue_url || ''));
  return m ? Number(m[1]) : fallback;
}

/** New attempts and newly-ended attempts in a task's run record. */
function runEvents(state, number, run) {
  const events = [];
  for (const a of run?.attempts || []) {
    const key = `${number}/${a.attempt}`;
    const was = state.attempts.get(key);
    if (!was) {
      events.push({ number, kind: 'attempt', at: a.started_at, attempt: a.attempt, profile: a.profile || null, host: a.host || null, tags: ['attempt'] });
    }
    if (a.ended_at && !was?.ended_at) {
      events.push({
        number, kind: 'outcome', at: a.ended_at, attempt: a.attempt,
        outcome: a.outcome || 'ended', summary: firstLine(a.summary || a.reason),
        tags: ['outcome', a.outcome].filter(Boolean),
      });
    }
    state.attempts.set(key, { ended_at: a.ended_at || null, outcome: a.outcome || null });
  }
  return events;
}

/**
 * Events carried by a page of issue comments, against what `state` has already reported.
 * The run comment is *edited* in place, so it is read for attempt transitions every time;
 * result and human comments are reported once, by id.
 * @param {any} state
 * @param {any[]} comments
 * @param {object} [opts]
 * @param {number} [opts.number]   the issue, when the page came from one issue's endpoint
 * @param {Map}    [opts.known]    board index — repository-wide comments outside it are not ours
 */
export function commentEvents(state, comments, { number = null, known = null } = {}) {
  const events = [];
  const page = [].concat(comments || []).filter(Boolean)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  for (const c of page) {
    const n = issueNumberOf(c, number);
    if (!n || (known && !known.has(n))) continue;
    const body = typeof c.body === 'string' ? c.body : '';
    if (body.startsWith(RUN_MARKER)) { events.push(...runEvents(state, n, parseRunComment(body))); continue; }
    if (state.comments.has(c.id)) continue;
    state.comments.add(c.id);
    if (body.startsWith(RESULT_MARKER)) {
      const r = parseResultComment(body) || {};
      events.push({ number: n, kind: 'result', at: c.created_at, url: c.html_url, attempt: r.attempt ?? null, summary: firstLine(r.summary), tags: ['result'] });
    } else {
      events.push({ number: n, kind: 'comment', at: c.created_at, url: c.html_url, actor: c.user?.login || null, text: firstLine(body), tags: ['comment'] });
    }
  }
  return events;
}

// ---------- pure: flags and formatting ----------

export function parseKinds(value) {
  if (value === undefined) return null;
  if (value === true) throw usage(`--kinds needs a value, e.g. --kinds completed,blocked — pick from ${KIND_TOKENS.join(', ')}`);
  const tokens = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const unknown = tokens.filter((t) => !KIND_TOKENS.includes(t));
  if (unknown.length) throw usage(`--kinds: unknown ${unknown.join(', ')} — pick from ${KIND_TOKENS.join(', ')}`);
  return new Set(tokens);
}

export function matchesKinds(event, kinds) {
  return !kinds || (event.tags || []).some((t) => kinds.has(t));
}

/** `--interval` in seconds, floored at MIN_INTERVAL. */
export function resolveInterval(value) {
  if (value === undefined) return DEFAULT_INTERVAL;
  if (value === true) throw usage('--interval needs a value in seconds, e.g. --interval 30');
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw usage(`--interval must be a number of seconds, got "${value}"`);
  return Math.max(MIN_INTERVAL, Math.round(n));
}

/** `--polls` — how many polls before the command exits. Absent means "until Ctrl-C". */
export function resolvePolls(value) {
  if (value === undefined) return Infinity;
  if (value === true) throw usage('--polls needs a count, e.g. --polls 3');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw usage(`--polls must be a whole number of polls (1 or more), got "${value}"`);
  return n;
}

const clock = (at) => {
  const t = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : '--:--:--';
};

const trim = (s, max) => (String(s).length > max ? String(s).slice(0, max - 1) + '…' : String(s));

/** The middle column: what happened, in words. */
export function describeEvent(e) {
  switch (e.kind) {
    case 'appeared': return `+ on the board (${e.to || 'no status'})`;
    case 'status': return `${e.from || 'none'} → ${e.to || 'none'}`;
    case 'agent': return `agent ${e.from || 'none'} → ${e.to || 'none'}`;
    case 'needs-human': return e.to ? '⚠ needs-human' : 'needs-human cleared';
    case 'closed': return `closed (${e.reason || 'completed'})`;
    case 'reopened': return 'reopened';
    case 'attempt': return `attempt ${e.attempt} started${e.profile ? ` (${e.profile}${e.host ? '@' + e.host : ''})` : ''}`;
    case 'outcome': return `attempt ${e.attempt} ${e.outcome}${e.summary ? ' — ' + e.summary : ''}`;
    case 'result': return `result${e.attempt ? ` (attempt ${e.attempt})` : ''}${e.summary ? ' — ' + e.summary : ''}`;
    case 'comment': return `comment${e.actor ? ` by ${e.actor}` : ''}${e.text ? ' — ' + e.text : ''}`;
    default: return e.kind;
  }
}

/** One line per transition: `08:01:12 #7    ready → running    the task title`. */
export function formatEvent(e, { width = 44, title = 44 } = {}) {
  const what = describeEvent(e);
  const tail = e.title ? '  ' + trim(e.title, title) : '';
  return `${clock(e.at)} #${String(e.number).padEnd(4)} ${tail ? what.padEnd(width) : what}${tail}`.trimEnd();
}

/** Events of one tick, oldest first — the order they happened, not the order we found them. */
export function sortEvents(events) {
  return [...events].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.number - b.number || EVENT_KINDS.indexOf(a.kind) - EVENT_KINDS.indexOf(b.kind));
}

// ---------- polling ----------

function makeSource({ name, path, apply }) {
  return { name, path, apply, etag: null, seen: false, advised: null };
}

const shortEtag = (etag) => (etag ? String(etag).replace(/^W\//, '').replace(/"/g, '').slice(0, 12) : 'none');

/**
 * One conditional GET. A 304 costs nothing and yields nothing; a 200 replaces the ETag and is
 * diffed by the source. `GHK_DEBUG=1` prints `rate <used> (+n)` — the token's own counter and how
 * far it moved since the previous poll, which is where a 304 shows up as `(+0)`. The counter is the
 * whole token's, so a dispatcher running beside the watcher also moves it; the 304 itself is free.
 */
async function pollSource(src, d, budget, debug) {
  const r = await d.restRaw('GET', src.path, { headers: src.etag ? { 'If-None-Match': src.etag } : {} });
  const used = Number(r.headers['x-ratelimit-used']);
  const spent = Number.isFinite(used) && Number.isFinite(budget.used) ? used - budget.used : null;
  if (Number.isFinite(used)) budget.used = used;
  const advised = Number(r.headers['x-poll-interval']);
  if (Number.isFinite(advised)) src.advised = advised;

  let events = [];
  if (r.status !== 304) {
    if (r.headers.etag) src.etag = r.headers.etag;
    const baseline = !src.seen;
    src.seen = true;
    events = src.apply(r.data, baseline) || [];
  }
  const rate = !Number.isFinite(used) ? 'rate ?' : spent === null || spent < 0 ? `rate ${used}` : `rate ${used} (+${spent})`;
  debug(`${src.name}: GET ${src.path} → ${r.status}${r.status === 304 ? ' Not Modified' : ''} · ${rate} · etag ${shortEtag(src.etag)}${events.length ? ` · ${events.length} event(s)` : ''}`);
  return events;
}

/** Network hiccups and GitHub wobbles must not end a watch that has been up for hours. */
const recoverable = (e) => ['network', 'ratelimit', 'server'].includes(e?.kind);

function makeSleeper() {
  let wake = null;
  return {
    sleep(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(); }, ms);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    },
    wake() { wake?.(); },
  };
}

/**
 * A watcher reports what happens while it watches. Anything older than `floor` is backfill — an
 * attempt row we are seeing for the first time because its run comment was only just edited, or a
 * months-old comment dragged into the window by an edit — and printing it would be a false event.
 * The floor sits a couple of minutes before the start so a slow clock cannot swallow a real one.
 */
export function afterFloor(event, floor) {
  if (!floor || !event.at) return true;
  return String(event.at) >= floor;
}

/**
 * The loop both commands share.
 * @param {object[]} sources  conditional GETs, polled in order — later ones may rely on earlier state
 * @param {object} deps       `restRaw`, `sleeper`, `write`, `log` — injected by tests
 */
async function follow(ctx, sources, flags, deps, { label, index, floor = null, onBaseline }) {
  const d = {
    restRaw,
    write: (s) => process.stdout.write(s + '\n'),
    log: (s) => process.stderr.write(s + '\n'),
    sleeper: makeSleeper(),
    signals: true,
    ...deps,
  };
  const kinds = parseKinds(flags.kinds);
  const asked = flags.interval === undefined ? null : Number(flags.interval);
  const interval = resolveInterval(flags.interval);
  const polls = resolvePolls(flags.polls);
  const debug = process.env.GHK_DEBUG ? (s) => d.log(`hkb ${label}: ${s}`) : () => {};
  if (asked !== null && Number.isFinite(asked) && asked < MIN_INTERVAL) {
    d.log(`hkb ${label}: --interval ${asked} raised to the ${MIN_INTERVAL}s floor`);
  }

  let stopped = false;
  const onSignal = () => { stopped = true; d.sleeper.wake(); };
  if (d.signals) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }
  let failures = 0;
  let announced = false;
  const budget = { used: null }; // the token's x-ratelimit-used, shared so each line shows its own poll
  try {
    for (let poll = 0; poll < polls && !stopped; poll++) {
      const batch = [];
      try {
        for (const src of sources) batch.push(...await pollSource(src, d, budget, debug));
        failures = 0;
      } catch (e) {
        // Ctrl-C kills the `gh` child mid-poll, so the failure lands before the signal handler runs:
        // yield once, and an interrupted watch exits quietly instead of reporting a broken request.
        await new Promise((resolve) => setImmediate(resolve));
        if (stopped) break;
        if (!recoverable(e)) throw e;
        failures++;
        const wait = Math.min(MAX_BACKOFF, interval * 2 ** (failures - 1));
        d.log(`hkb ${label}: ${e.message} — retrying in ${wait}s`);
        if (poll + 1 >= polls || stopped) break;
        await d.sleeper.sleep(wait * 1000);
        continue;
      }
      if (!announced) { announced = true; onBaseline?.(index, d, interval); }
      for (const e of sortEvents(batch)) {
        const known = index.get(e.number);
        if (known) { e.title = e.title || known.title; e.url = e.url || known.url; }
        if (!matchesKinds(e, kinds) || !afterFloor(e, floor)) continue;
        d.write(ctx.json ? JSON.stringify(e) : formatEvent(e));
      }
      if (poll + 1 >= polls || stopped) break;
      const advised = Math.max(0, ...sources.map((s) => s.advised || 0));
      await d.sleeper.sleep(Math.max(interval, advised) * 1000);
    }
  } finally {
    if (d.signals) { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  }
  return 0;
}

// ---------- sources ----------

/**
 * `hkb watch` reads one page of board issues, most-recently-updated first, plus the repository's
 * issue comments since the watch started. Both URLs are fixed for the life of the process — a URL
 * that moves (a rolling `since`) can never match an ETag, and every poll would cost a unit.
 */
export function watchSources(ctx, { since }) {
  const index = new Map();
  const state = emptyWatchState();
  const board = makeSource({
    name: 'board',
    path: api(ctx, `/issues?labels=${encodeURIComponent(L.board(ctx.board))}&state=all&sort=updated&direction=desc&per_page=100`),
    apply: (data, baseline) => {
      const next = boardIndex(data, ctx.board);
      const events = baseline ? [] : diffBoard(index, next);
      for (const [n, rec] of next) index.set(n, rec); // merged, never replaced: the page is a window
      return events;
    },
  });
  const comments = makeSource({
    name: 'comments',
    path: api(ctx, `/issues/comments?per_page=100&sort=updated&direction=desc&since=${encodeURIComponent(since)}`),
    apply: (data, baseline) => {
      const events = commentEvents(state, data, { known: index }); // seeds state even on the baseline
      return baseline ? [] : events;
    },
  });
  return { sources: [board, comments], index, state };
}

/** `hkb tail <n>` — the same two reads, narrowed to one issue. */
export function tailSources(ctx, number) {
  const index = new Map();
  const state = emptyWatchState();
  const issue = makeSource({
    name: 'issue',
    path: api(ctx, `/issues/${number}`),
    apply: (data, baseline) => {
      const next = boardIndex(data);
      const events = baseline ? [] : diffBoard(index, next);
      for (const [n, rec] of next) index.set(n, rec);
      return events;
    },
  });
  const comments = makeSource({
    name: 'comments',
    path: api(ctx, `/issues/${number}/comments?per_page=100&sort=updated&direction=desc`),
    apply: (data, baseline) => {
      const events = commentEvents(state, data, { number });
      return baseline ? [] : events;
    },
  });
  return { sources: [issue, comments], index, state };
}

// ---------- commands ----------

/** Two minutes of slack between "when we started" and "what counts as new". */
const FLOOR_GRACE_MS = 120_000;

const floorFor = (since) => new Date(new Date(since).getTime() - FLOOR_GRACE_MS).toISOString();

export async function watch(ctx, flags = {}, deps = {}) {
  const since = deps.since || new Date().toISOString();
  const { sources, index } = watchSources(ctx, { since });
  return follow(ctx, sources, flags, deps, {
    label: 'watch',
    index,
    floor: floorFor(since),
    onBaseline: (idx, d, interval) => {
      const open = [...idx.values()].filter((t) => t.state === 'OPEN').length;
      d.log(`hkb watch: ${ctx.repo.nameWithOwner} board "${ctx.board}" — ${idx.size} task${idx.size === 1 ? '' : 's'} (${open} open) at baseline, conditional polls every ${interval}s. Ctrl-C to stop.`);
    },
  });
}

export async function tail(ctx, number, flags = {}, deps = {}) {
  const since = deps.since || new Date().toISOString();
  const { sources, index } = tailSources(ctx, number);
  return follow(ctx, sources, flags, deps, {
    label: 'tail',
    index,
    floor: floorFor(since),
    onBaseline: (idx, d, interval) => {
      const t = idx.get(number);
      if (!t) { d.log(`hkb tail: #${number} returned nothing to follow`); return; }
      d.log(`hkb tail: #${number} ${t.status || 'no status'}${t.agent ? ` (${t.agent})` : ''} — ${t.title}`);
      d.log(`hkb tail: following attempts and comments every ${interval}s. Ctrl-C to stop.`);
    },
  });
}
