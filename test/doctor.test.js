// KB_TOKEN expiry: what a response head says about the token that fetched it, what doctor reports,
// what Actions is told, and the dispatcher's once-a-day version of the same check.
//
// Nothing here reads the process clock, its timezone, or the runner's environment. Every instant is
// written out, the window boundaries are walked from both sides, and the cases that render or stamp
// a date are replayed in a handful of zones — a check about a seven-day window that only passes in
// the zone and at the hour its author happened to be in is a test that fails main at random.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOKEN_EXPIRY_HEADER, TOKEN_CHECK, TOKEN_FIX, TOKEN_WARN_DAYS,
  tokenExpiry, expiryFinding, checkTokenExpiry, checkToken, actionsAnnotation, emitAnnotations, tokenExpiryNotice,
  SESSION_CHECK, SESSION_FIX, SESSION_SAMPLE, POLICY_CHECK, TASK_SKILLS_CHECK,
  sessionTally, sessionFinding, checkSessions, boardOnce, checkAgentLabels, checkTaskSkills, policyLayers, checkPolicyLayer,
} from '../src/doctor.js';
import { setTransport, GhError } from '../src/gh.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WINDOW = TOKEN_WARN_DAYS * DAY;
const NOW = Date.parse('2026-08-26T12:00:00Z');
const head = (value) => (value === undefined ? {} : { [TOKEN_EXPIRY_HEADER]: value });

/**
 * Anchors whose UTC day is not the local day everywhere: 02:30Z is still the previous day in New
 * York, 23:30Z is already the next day in Kiritimati (UTC+14), and 2026-03-08T06:30Z sits inside the
 * hour the US spring-forward deletes. A window or a rendered date that quietly followed the local
 * calendar shows up as one anchor disagreeing with the others.
 */
const ANCHORS = [
  '2026-08-26T12:00:00Z',
  '2026-08-26T02:30:00Z',
  '2026-08-26T23:30:00Z',
  '2026-03-08T06:30:00Z',
].map(Date.parse);

/** East and west of UTC, on and off DST, plus a half-hour offset and the furthest zone there is. */
const ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati'];

/**
 * Run `fn` once per zone. Node re-reads `process.env.TZ` on assignment (>= 16), so this covers the
 * whole matrix in one process; the workflow still runs the file under two real `TZ`s, because only
 * that proves the default path — the one a contributor runs — is zone-independent too.
 */
async function inEachZone(fn) {
  const before = process.env.TZ;
  try {
    for (const tz of ZONES) { process.env.TZ = tz; await fn(tz); }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
}

/** The finding list doctor builds, and the three sinks that fill it. */
function sink() {
  const results = [];
  return {
    results,
    ok: (name, detail) => results.push({ name, ok: true, detail }),
    bad: (name, detail, fix) => results.push({ name, ok: false, detail, fix }),
    warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }),
  };
}
/** A transport that answers `GET rate_limit` and nothing else. */
function rateLimitTransport({ headers = {}, limit = 5000, remaining = 4999, fail = null } = {}) {
  const calls = [];
  const fn = (req) => {
    calls.push(req);
    if (fail) throw fail;
    return {
      __response: true,
      status: 200,
      headers,
      data: { resources: { core: { limit, remaining, reset: 1_800_000_000 }, graphql: { limit: 5000, remaining: 5000 } } },
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------- reading the header ----------

test('no header means a token with no expiry — OAuth or classic — and nothing to say', () => {
  assert.equal(tokenExpiry({}, NOW), null);
  assert.equal(tokenExpiry(null, NOW), null);
  assert.equal(tokenExpiry(undefined, NOW), null);
  assert.equal(tokenExpiry(head(''), NOW), null);
  assert.equal(tokenExpiry(head('   '), NOW), null);
});

test('a header GitHub would never send is treated as no header, never as an error', () => {
  assert.equal(tokenExpiry(head('never'), NOW), null);
  assert.equal(tokenExpiry(head('2026-13-45 99:00:00 UTC'), NOW), null);
});

test("GitHub's own format parses to the same instant in every zone, and so does ISO 8601", async () => {
  await inEachZone((tz) => {
    // `2026-09-25 12:00:00 UTC` is not ISO 8601 — it goes through the engine's fallback parser,
    // which is where a zone-less string would silently become local time.
    assert.equal(tokenExpiry(head('2026-09-25 12:00:00 UTC'), NOW).at, '2026-09-25T12:00:00.000Z', tz);
    assert.equal(tokenExpiry(head('2026-09-25T12:00:00Z'), NOW).at, '2026-09-25T12:00:00.000Z', tz);
    assert.equal(tokenExpiry(head('2026-09-25 05:00:00 -0700'), NOW).at, '2026-09-25T12:00:00.000Z', tz);
  });
});

test('the header name is matched however the transport cased it', () => {
  assert.ok(tokenExpiry({ 'GitHub-Authentication-Token-Expiration': '2026-09-25 12:00:00 UTC' }, NOW));
  assert.ok(tokenExpiry({ [TOKEN_EXPIRY_HEADER.toUpperCase()]: '2026-09-25 12:00:00 UTC' }, NOW));
});

/** What the header says, `ms` before the given instant — the only way this file names a time. */
const at = (now, ms) => tokenExpiry(head(new Date(now + ms).toISOString()), now);

test(`the warn window opens strictly under ${TOKEN_WARN_DAYS} days and closes at expiry`, async () => {
  // Both sides of both boundaries, so a `<` that became `<=` fails on the pair that brackets it.
  const cases = [
    [30 * DAY, 'ok'],
    [WINDOW + HOUR, 'ok'],
    [WINDOW, 'ok'],                 // exactly 7 days is still fine
    [WINDOW - HOUR, 'warn'],        // 6d23h: the window has opened
    [DAY, 'warn'],
    [60_000, 'warn'],
    [1, 'warn'],                    // a millisecond of token left is still a token
    [0, 'expired'],                 // and none is not
    [-HOUR, 'expired'],
    [-DAY, 'expired'],
  ];
  await inEachZone((tz) => {
    for (const now of ANCHORS) {
      for (const [ms, level] of cases) {
        assert.equal(at(now, ms).level, level, `${tz} · ${new Date(now).toISOString()} + ${ms}ms`);
      }
    }
  });
});

test('days is whole days remaining, and goes negative once the token has lapsed', async () => {
  await inEachZone((tz) => {
    for (const now of ANCHORS) {
      assert.equal(at(now, 30 * DAY).days, 30, tz);
      assert.equal(at(now, 6 * DAY + 23 * HOUR).days, 6, tz);
      assert.equal(at(now, WINDOW - 1).days, 6, tz);
      assert.equal(at(now, WINDOW).days, 7, tz);
      assert.equal(at(now, -DAY).days, -1, tz);
      assert.equal(at(now, 30 * DAY).ms, 30 * DAY, tz);
    }
  });
});

// ---------- what doctor reports ----------

test('a healthy PAT is one green line with the date on it', () => {
  const s = sink();
  const e = checkTokenExpiry(head('2026-09-25 12:00:00 UTC'), s, NOW);
  assert.equal(e.level, 'ok');
  assert.deepEqual(s.results, [{ name: TOKEN_CHECK, ok: true, detail: 'fine-grained PAT, expires 2026-09-25 12:00 UTC (30 days left)' }]);
});

test('inside the window it warns and names the fix', () => {
  const s = sink();
  checkTokenExpiry(head('2026-08-30T12:00:00Z'), s, NOW);
  assert.equal(s.results[0].ok, null);
  assert.match(s.results[0].detail, /^expires 2026-08-30 12:00 UTC \(4 days left\)$/);
  assert.equal(s.results[0].fix, TOKEN_FIX);
  assert.match(TOKEN_FIX, /gh secret set KB_TOKEN/);
});

test('an expired token fails the check, so `hkb doctor` exits non-zero', () => {
  const s = sink();
  checkTokenExpiry(head('2026-08-23T12:00:00Z'), s, NOW);
  assert.equal(s.results[0].ok, false);
  assert.match(s.results[0].detail, /expired 2026-08-23 12:00 UTC \(3 days ago\)/);
  assert.equal(s.results[0].fix, TOKEN_FIX);
});

test('the warning names the UTC date, so the same token warns about the same day everywhere', async () => {
  // 02:30Z on the 30th is 22:30 on the *29th* in New York and 16:30 on the 30th in Kiritimati: a
  // detail rendered from the local calendar would print three different days for one instant.
  await inEachZone((tz) => {
    const s = sink();
    checkTokenExpiry(head('2026-08-30T02:30:00Z'), s, NOW);
    assert.equal(s.results[0].detail, 'expires 2026-08-30 02:30 UTC (3 days left)', tz);
    const expired = sink();
    checkTokenExpiry(head('2026-08-25T23:45:00Z'), expired, NOW);
    assert.equal(expired.results[0].detail, 'the token expired 2026-08-25 23:45 UTC (today)', tz);
  });
});

test('the singular and the sub-day cases read like English', () => {
  const detail = (ms) => expiryFinding(at(NOW, ms)).detail;
  assert.match(detail(DAY + 1000), /\(1 day left\)$/);
  assert.match(detail(6 * HOUR), /\(less than a day left\)$/);
  assert.match(detail(-HOUR), /\(today\)$/);
  assert.match(detail(-DAY - 1000), /\(1 day ago\)$/);
});

test('a token with no expiry header adds no finding at all', () => {
  const s = sink();
  assert.equal(checkTokenExpiry({}, s, NOW), null);
  assert.deepEqual(s.results, []);
});

// ---------- one call for rate limit, token class and expiry ----------

test('checkToken reports the rate limit and the expiry from a single response', async () => {
  const t = rateLimitTransport({ headers: head('2026-09-25 12:00:00 UTC') });
  const restore = setTransport(t);
  try {
    const s = sink();
    const e = await checkToken(s, NOW);
    assert.equal(e.level, 'ok');
    assert.equal(t.calls.length, 1, 'one call, and GitHub does not charge GET rate_limit');
    assert.equal(t.calls[0].path, 'rate_limit');
    assert.equal(t.calls[0].raw, true, 'the raw form is what keeps the headers');
    assert.deepEqual(s.results.map((r) => r.name), ['rate limit', TOKEN_CHECK]);
    assert.match(s.results[0].detail, /REST 4999\/5000/);
    assert.equal(s.results[1].detail, 'fine-grained PAT, expires 2026-09-25 12:00 UTC (30 days left)');
  } finally { restore(); }
});

test('checkToken still flags a low limit, and says nothing about expiry without the header', async () => {
  const restore = setTransport(rateLimitTransport({ limit: 1000, remaining: 900 }));
  try {
    const s = sink();
    assert.equal(await checkToken(s, NOW), null);
    assert.deepEqual(s.results.map((r) => r.name), ['rate limit', 'token type']);
  } finally { restore(); }
});

test('a rate_limit call that fails warns once and does not invent an expiry', async () => {
  const restore = setTransport(rateLimitTransport({ fail: new GhError('GET rate_limit failed (401): Bad credentials', { status: 401, kind: 'auth' }) }));
  try {
    const s = sink();
    assert.equal(await checkToken(s, NOW), null);
    assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [['rate limit', null]]);
  } finally { restore(); }
});

test('a transport that does not model responses degrades to no expiry, not a crash', async () => {
  const restore = setTransport(() => ({ resources: { core: { limit: 5000, remaining: 5000, reset: 0 } } }));
  try {
    const s = sink();
    assert.equal(await checkToken(s, NOW), null);
    assert.deepEqual(s.results.map((r) => r.name), ['rate limit']);
  } finally { restore(); }
});

// ---------- the Actions annotation ----------

test('outside Actions there is no annotation', () => {
  assert.equal(actionsAnnotation({ name: TOKEN_CHECK, ok: null, detail: 'soon', fix: TOKEN_FIX }, { inActions: false }), null);
});

test('a warning becomes ::warning::, a failure ::error::, a pass nothing', () => {
  const a = (ok) => actionsAnnotation({ name: TOKEN_CHECK, ok, detail: 'expires 2026-08-30 12:00 UTC (4 days left)', fix: TOKEN_FIX }, { inActions: true });
  assert.equal(a(null), `::warning::${TOKEN_CHECK}: expires 2026-08-30 12:00 UTC (4 days left) → ${TOKEN_FIX}`);
  assert.match(a(false), /^::error::/);
  assert.equal(a(true), null);
  assert.equal(actionsAnnotation(null, { inActions: true }), null);
});

test('the message is escaped, so a newline cannot truncate the annotation', () => {
  const line = actionsAnnotation({ name: TOKEN_CHECK, ok: null, detail: '100% gone\nand more\r', fix: null }, { inActions: true });
  assert.equal(line, `::warning::${TOKEN_CHECK}: 100%25 gone%0Aand more%0D`);
  assert.ok(!line.includes('\n'));
});

test('every other doctor finding stays where it is — one annotation, not a wall of them', () => {
  const results = [
    { name: 'rate limit', ok: true, detail: 'REST 4999/5000' },
    { name: 'stop hook', ok: null, detail: 'not configured', fix: 'hkb init' },
    { name: TOKEN_CHECK, ok: null, detail: 'expires soon', fix: TOKEN_FIX },
    { name: 'labels', ok: false, detail: 'missing kb:status:ready', fix: 'hkb init' },
  ];
  const out = [], err = [];
  const wrote = emitAnnotations(results, { inActions: true, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } });
  assert.deepEqual(wrote, [`::warning::${TOKEN_CHECK}: expires soon → ${TOKEN_FIX}`]);
  assert.deepEqual(out, [`${wrote[0]}\n`]);
  assert.deepEqual(err, []);
});

test('under --json the annotation goes to stderr, so stdout is still one JSON document', () => {
  const results = [{ name: TOKEN_CHECK, ok: false, detail: 'the token expired', fix: TOKEN_FIX }];
  const out = [], err = [];
  emitAnnotations(results, { inActions: true, json: true, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } });
  assert.deepEqual(out, []);
  assert.equal(err.length, 1);
  assert.match(err[0], /^::error::/);
});

test('off Actions, nothing is written to either stream', () => {
  const out = [], err = [];
  const wrote = emitAnnotations([{ name: TOKEN_CHECK, ok: false, detail: 'x', fix: 'y' }], { inActions: false, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } });
  assert.deepEqual([wrote, out, err], [[], [], []]);
});

// ---------- the dispatcher's once-a-day check ----------

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-doctor-'));
  roots.push(root);
  return root;
}
const stateOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.kanban', 'state.json'), 'utf8'));

/**
 * The loop's notice with everything it would otherwise read off the process injected: the clock, the
 * runner flag and stdout. Nothing a test writes can reach the real stdout, and nothing about the
 * machine running the suite can change which branch is taken.
 */
async function notice(root, { now = NOW, inActions = false } = {}) {
  const lines = [], stdout = [];
  const expiry = await tokenExpiryNotice({ root }, (s) => lines.push(s), {
    now, inActions, out: { write: (s) => stdout.push(s) },
  });
  return { expiry, lines, stdout };
}

test('the loop probes once a day and is free for the rest of it', async () => {
  const root = tmpRoot();
  const t = rateLimitTransport({ headers: head('2026-09-25T12:00:00Z') });
  const restore = setTransport(t);
  try {
    const first = await notice(root, { now: NOW });
    assert.equal(first.expiry.level, 'ok');
    assert.equal(t.calls.length, 1);
    assert.equal(stateOf(root).token_expiry_day, '2026-08-26');
    assert.deepEqual([first.lines, first.stdout], [[], []], 'a healthy token is silent');

    assert.equal((await notice(root, { now: NOW + HOUR })).expiry, null);
    assert.equal(t.calls.length, 1, 'same day: no second call');

    await notice(root, { now: NOW + DAY });
    assert.equal(t.calls.length, 2, 'next day: it checks again');
    assert.equal(stateOf(root).token_expiry_day, '2026-08-27');
  } finally { restore(); }
});

test('the once-a-day stamp is a UTC day, so two hosts in two zones still probe once between them', async () => {
  // 02:30Z is 2026-08-25 in New York and 2026-08-26 in Kiritimati. Stamped locally, a board
  // dispatching from both would spend two probes on the same day — and skip one on another.
  const restore = setTransport(rateLimitTransport({ headers: head('2026-09-25T12:00:00Z') }));
  try {
    await inEachZone(async (tz) => {
      const root = tmpRoot();
      await notice(root, { now: Date.parse('2026-08-26T02:30:00Z') });
      assert.equal(stateOf(root).token_expiry_day, '2026-08-26', tz);
    });
  } finally { restore(); }
});

test('a token inside the window is reported to the loop with the fix', async () => {
  const root = tmpRoot();
  const restore = setTransport(rateLimitTransport({ headers: head('2026-08-28T12:00:00Z') }));
  try {
    const { expiry, lines, stdout } = await notice(root, { now: NOW });
    assert.equal(expiry.level, 'warn');
    assert.deepEqual(stdout, [], 'off a runner there is no annotation to write');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^token expiry: expires 2026-08-28 12:00 UTC \(2 days left\) → /);
    assert.match(lines[0], /gh secret set KB_TOKEN/);
  } finally { restore(); }
});

test('on a runner the same notice is an annotation on stdout instead, and the log stays quiet', async () => {
  const root = tmpRoot();
  const restore = setTransport(rateLimitTransport({ headers: head('2026-08-28T12:00:00Z') }));
  try {
    const { lines, stdout } = await notice(root, { now: NOW, inActions: true });
    assert.deepEqual(lines, [], "the loop's log timestamps every line, which would hide the command");
    assert.deepEqual(stdout, [`::warning::${TOKEN_CHECK}: expires 2026-08-28 12:00 UTC (2 days left) → ${TOKEN_FIX}\n`]);
  } finally { restore(); }
});

test('which branch it takes is the caller\'s argument, not the environment the suite runs in', async () => {
  // This is #48: the suite asserted on `log`, `tokenExpiryNotice` read GITHUB_ACTIONS itself, and so
  // the test passed on every laptop and failed on the one machine that matters — hkb's own CI.
  const before = process.env.GITHUB_ACTIONS;
  const root = tmpRoot();
  const restore = setTransport(rateLimitTransport({ headers: head('2026-08-28T12:00:00Z') }));
  process.env.GITHUB_ACTIONS = 'true';
  try {
    const off = await notice(root, { now: NOW, inActions: false });
    assert.equal(off.lines.length, 1, 'inActions: false wins over a runner that says otherwise');
    assert.deepEqual(off.stdout, []);

    const on = await notice(tmpRoot(), { now: NOW, inActions: true });
    assert.deepEqual(on.lines, []);
    assert.equal(on.stdout.length, 1);
  } finally {
    restore();
    if (before === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = before;
  }
});

test('a failed probe stamps nothing, so the next tick tries again', async () => {
  const root = tmpRoot();
  const t = rateLimitTransport({ fail: new GhError('offline', { kind: 'network' }) });
  const restore = setTransport(t);
  try {
    assert.equal((await notice(root, { now: NOW })).expiry, null);
    assert.equal(t.calls.length, 1);
    assert.ok(!fs.existsSync(path.join(root, '.kanban', 'state.json')));
  } finally { restore(); }
});

test('the day stamp is added to the state the dispatcher already keeps, not written over it', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'state.json'), JSON.stringify({ spawn_day: '2026-08-26', spawned_today: 3 }));
  const restore = setTransport(rateLimitTransport({ headers: head('2026-09-25T12:00:00Z') }));
  try {
    await notice(root, { now: NOW });
    assert.deepEqual(stateOf(root), { spawn_day: '2026-08-26', spawned_today: 3, token_expiry_day: '2026-08-26' });
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// Worker sessions: is anything this board recorded priceable?
//
// The hole these cover was found weeks late, by a spend report that was empty — a `claude --bg`
// worker never receives `KB_TASK`, so nothing on the default profile recorded which session had
// done the work. The board is the only honest witness, so the fixture is a real one: FakeGh issues
// carrying real run comments, read back through `fetchBoard`/`fetchClosedRecent`/`loadRun`.

/**
 * A board in a temp checkout on a fake GitHub: the `claude-bg` profile the default board ships,
 * and a `process` one that must never be asked about. Nothing here spawns anything.
 */
function boardHarness(t, { profiles } = {}) {
  const gh = new FakeGh({ caps: { blockedByGql: true, closedByPrs: true } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-sessions-'));
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  const cfg = {
    repo: gh.nameWithOwner,
    default_branch: 'main',
    profiles: profiles || {
      claude: { mode: 'claude-bg', launch: ['claude', '--bg'] },
      'claude-p': { mode: 'process', launch: ['claude', '-p'] },
    },
  };
  const ctx = {
    root, cfg, board: 'default', host: 'test-host', json: false, caps: {}, _cache: {},
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    requireBoard() { return this; },
  };
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  return { gh, ctx, root };
}

/** An ended attempt row, carrying a session only when asked for one. */
const attempt = (k, outcome, { profile = 'claude', session = false, ...rest } = {}) => ({
  attempt: k,
  profile,
  host: 'test-host',
  started_at: `2026-08-27T0${k}:00:00Z`,
  ended_at: `2026-08-27T0${k}:30:00Z`,
  outcome,
  ...(session ? { session_id: `sess-${k}`, transcript_path: `/t/sess-${k}.jsonl` } : {}),
  ...rest,
});

/** Every run comment this board was asked for. */
const runReads = (gh) => gh.callsMatching('GET', /issues\/\d+\/comments/).length;

// ---------- the tally, without a board ----------

test("the tally counts a background profile's own ended attempts and nothing else", () => {
  const runs = [runWith([
    attempt(1, 'completed', { session: true }),
    attempt(2, 'crashed'),
    attempt(3, 'completed', { profile: 'codex', session: true }),           // another profile
    { attempt: 4, profile: 'claude', started_at: '2026-08-27T04:00:00Z' },  // still running
    attempt(5, 'gave_up', { profile: 'dispatcher', synthetic: true }),      // not a worker at all
  ])];

  assert.deepEqual(sessionTally(runs, 'claude'), {
    ended: 2, withSession: 1, verb: 1, verbWithSession: 1, off: 1, offWithSession: 0,
  });
});

test('spawn_failed and reclaimed are not evidence: no worker ran, so nothing could have stamped them', () => {
  const t = sessionTally([runWith([attempt(1, 'spawn_failed'), attempt(2, 'reclaimed')])], 'claude');
  assert.equal(t.ended, 0, 'a board that only ever failed to spawn must not warn about a hole that is not one');
  assert.equal(sessionFinding('claude', t), null, 'and doctor says nothing at all about it');
});

// ---------- the wording ----------

test('nothing recorded at all is the warning, and it names both ways that happens', () => {
  const runs = [runWith([attempt(1, 'completed'), attempt(2, 'timed_out')])];
  const f = sessionFinding('claude', sessionTally(runs, 'claude'), 4);

  assert.equal(f.name, 'profile claude sessions');
  assert.equal(f.ok, null);
  assert.match(f.detail, /none of the 2 ended attempts on this board carries a session id \(4 run records read\)/);
  assert.match(f.detail, /hkb stats/);
  assert.match(f.detail, /claude --resume/);
  assert.equal(f.fix, SESSION_FIX);
  assert.match(f.fix, /npm i -g hkb-cli@latest/, 'an hkb older than the recording is the first thing to rule out');
  assert.match(f.fix, /\$CLAUDE_JOB_DIR/, 'a current hkb that still records nothing is a harness that is not stamping');
});

test('verb-ended rows carrying a session are ok, and the written-off column names the mechanism that fills it', () => {
  const runs = [runWith([
    attempt(1, 'completed', { session: true }),
    attempt(2, 'review_requested', { session: true }),
    attempt(3, 'protocol_violation'),
  ])];
  const f = sessionFinding('claude', sessionTally(runs, 'claude'), 1);

  assert.equal(f.ok, true);
  assert.equal(f.fix, undefined);
  assert.match(f.detail, /2\/2 that filed a terminal verb/);
  assert.match(f.detail, /0\/1 written off without one/);
  assert.match(f.detail, /the dispatcher names those from the background job record one tick after the launch/);
});

test('once the written-off rows carry sessions too, the explanatory clause goes away', () => {
  const runs = [runWith([attempt(1, 'completed', { session: true }), attempt(2, 'crashed', { session: true })])];
  assert.equal(
    sessionFinding('claude', sessionTally(runs, 'claude'), 1).detail,
    'session recorded on 1/1 that filed a terminal verb · 1/1 written off without one');
});

test('a profile with only written-off rows still reads like English', () => {
  const runs = [runWith([attempt(1, 'crashed', { session: true })])];
  assert.equal(sessionFinding('claude', sessionTally(runs, 'claude'), 1).detail, 'session recorded on 1/1 written off without one');
});

// Recording a session and pricing it are two halves. A `claude --bg` attempt reports no cost of its
// own, so a board with sessions but no `stats.rates` is recording faithfully and can still never say
// what it spent — the ok line has to carry that, or it reads as "spend visibility works".
test('sessions recorded but no stats.rates: the ok line says the transcripts buy no cost', () => {
  const runs = [runWith([attempt(1, 'completed', { session: true })])];
  const f = sessionFinding('claude', sessionTally(runs, 'claude'), 1, false);
  assert.equal(f.ok, true, 'an unconfigured rates table is a fact to state, not a board that is broken');
  assert.match(f.detail, /session recorded on 1\/1 that filed a terminal verb/);
  assert.match(f.detail, /no `stats\.rates` in \.kanban\/board\.json/);
  assert.match(f.detail, /turns and tokens but never a cost/);
});

test('with rates configured the clause is absent, and the default stays silent', () => {
  const runs = [runWith([attempt(1, 'completed', { session: true })])];
  assert.doesNotMatch(sessionFinding('claude', sessionTally(runs, 'claude'), 1, true).detail, /stats\.rates/);
  assert.doesNotMatch(sessionFinding('claude', sessionTally(runs, 'claude'), 1).detail, /stats\.rates/);
});

test('a board recording nothing at all is unchanged: one problem at a time', () => {
  const runs = [runWith([attempt(1, 'completed'), attempt(2, 'timed_out')])];
  const f = sessionFinding('claude', sessionTally(runs, 'claude'), 1, false);
  assert.equal(f.ok, null, 'still the warning');
  assert.doesNotMatch(f.detail, /stats\.rates/, 'rates cannot matter while there is nothing to price');
});

// ---------- end to end, on a board ----------

test('doctor warns on a board whose claude-bg attempts carry no session fields', async (t) => {
  const h = boardHarness(t);
  h.gh.addIssue(kbIssue({
    number: 40, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude',
    updatedAt: '2026-08-27T09:00:00Z', run: runWith([attempt(1, 'completed'), attempt(2, 'completed')]),
  }));
  h.gh.addIssue(kbIssue({
    number: 41, status: 'ready', agent: 'claude',
    updatedAt: '2026-08-27T08:00:00Z', run: runWith([attempt(1, 'timed_out')]),
  }));
  const s = sink();

  const found = await checkSessions(h.ctx, s);

  assert.equal(found.length, 1, 'one finding per background profile that has run — claude-p is a process, not a daemon');
  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [['profile claude sessions', null]]);
  assert.match(s.results[0].detail, /none of the 3 ended attempts on this board carries a session id/);
  assert.equal(s.results[0].fix, SESSION_FIX);
});

test('the completed attempts are on closed cards, so a closed card is read too', async (t) => {
  const h = boardHarness(t);
  h.gh.addIssue(kbIssue({
    number: 40, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude',
    updatedAt: '2026-08-27T09:00:00Z', run: runWith([attempt(1, 'completed', { session: true })]),
  }));
  const s = sink();

  await checkSessions(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [['profile claude sessions', true]]);
  assert.match(s.results[0].detail, /session recorded on 1\/1 that filed a terminal verb/);
});

test('the sample stops at the first card that answers', async (t) => {
  const h = boardHarness(t);
  for (let n = 1; n <= 20; n++) {
    h.gh.addIssue(kbIssue({
      number: n, status: 'ready', agent: 'claude',
      updatedAt: `2026-08-27T${String(n).padStart(2, '0')}:00:00Z`,
      run: runWith([attempt(1, 'completed', { session: true })]),
    }));
  }
  const s = sink();

  await checkSessions(h.ctx, s);

  assert.equal(s.results[0].ok, true);
  assert.equal(runReads(h.gh), 1, 'the newest card answered; every further read could only repeat it');
});

test('a board with nothing to answer with is bounded, not walked', async (t) => {
  const h = boardHarness(t);
  for (let n = 1; n <= 20; n++) {
    h.gh.addIssue(kbIssue({
      number: n, status: 'ready', agent: 'claude',
      updatedAt: `2026-08-27T${String(n).padStart(2, '0')}:00:00Z`,
      run: runWith([attempt(1, 'crashed')]),
    }));
  }
  const s = sink();

  await checkSessions(h.ctx, s);

  assert.equal(s.results[0].ok, null);
  assert.equal(runReads(h.gh), SESSION_SAMPLE);
  assert.match(s.results[0].detail, new RegExp(`\\(${SESSION_SAMPLE} run records read\\)`), 'and says how much it looked at, so "none" can be weighed');
});

test('a board with no background profile is not asked at all — no read, no finding', async (t) => {
  const h = boardHarness(t, { profiles: { codex: { mode: 'process', launch: ['codex', 'exec'] } } });
  h.gh.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'codex', run: runWith([attempt(1, 'completed', { profile: 'codex' })]) }));
  const s = sink();

  assert.deepEqual(await checkSessions(h.ctx, s), []);
  assert.deepEqual(s.results, []);
  assert.deepEqual(h.gh.calls, [], 'a check with nothing to check must cost nothing');
});

test('a profile that has never ended an attempt here has nothing to be wrong about', async (t) => {
  const h = boardHarness(t, {
    profiles: {
      claude: { mode: 'claude-bg', launch: ['claude', '--bg'] },
      'claude-track': { mode: 'claude-bg', launch: ['claude', '--bg'] },
    },
  });
  h.gh.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', run: runWith([attempt(1, 'completed', { session: true })]) }));
  const s = sink();

  await checkSessions(h.ctx, s);

  assert.deepEqual(s.results.map((r) => r.name), ['profile claude sessions'], 'claude-track never ran here: doctor stays quiet about it');
});

test('a board that will not read is a warning, not a crash — doctor has other checks to run', async (t) => {
  const h = boardHarness(t);
  const s = sink();

  await checkSessions(h.ctx, s, { fetch: async () => { throw new Error('502 Bad Gateway'); } });

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[SESSION_CHECK, null]]);
  assert.match(s.results[0].detail, /could not read the board: 502 Bad Gateway/);
});

test('the two card checks share one board query rather than paying for one each', async (t) => {
  const h = boardHarness(t);
  h.gh.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', run: runWith([attempt(1, 'completed', { session: true })]) }));
  const board = await boardOnce(h.ctx);
  const before = h.gh.calls.length;

  await checkAgentLabels(h.ctx, sink(), { board });
  await checkSessions(h.ctx, sink(), { board });

  const openBoard = h.gh.calls.slice(before).filter((c) => c.kind === 'graphql' && /states: \[OPEN\]/.test(c.query || ''));
  assert.deepEqual(openBoard, [], 'neither check re-reads the board it was handed');
});

// ---------- kb.skills asks for a tool a profile may deny (#114) ----------

test('a board that sets no kb.skills has nothing to check', async (t) => {
  const h = boardHarness(t);
  h.gh.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude' }));
  const s = sink();

  await checkTaskSkills(h.ctx, s);

  assert.deepEqual(s.results, []);
});

test('kb.skills on a profile that allows Skill is fine', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['Read', 'Skill'] } } });
  h.gh.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', kb: { skills: ['kanban'] } }));
  const s = sink();

  await checkTaskSkills(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TASK_SKILLS_CHECK, true]]);
});

test('kb.skills on a profile whose allowed_tools omits Skill is a warning naming the card and the fix', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['Read'] } } });
  h.gh.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', kb: { skills: ['kanban'] } }));
  const s = sink();

  await checkTaskSkills(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TASK_SKILLS_CHECK, null]]);
  assert.match(s.results[0].detail, /#40 \(claude\)/);
  assert.match(s.results[0].fix, /add "Skill" to "allowed_tools" on the claude profile/);
});

test('kb.skills is silent on a launch Skill has no meaning for (codex has no per-command allow-list)', async (t) => {
  const h = boardHarness(t, { profiles: { codex: { mode: 'process', launch: ['codex', 'exec'], allowed_tools: null } } });
  h.gh.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'codex', kb: { skills: ['kanban'] } }));
  const s = sink();

  await checkTaskSkills(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TASK_SKILLS_CHECK, true]]);
});

// ---------- which layer is actually enforcing ----------

test("hkb's PreToolUse policy is inert on a claude-bg profile, and the line says so", () => {
  const cfg = {
    profiles: {
      claude: { mode: 'claude-bg', launch: ['claude', '--bg'] },
      'claude-track': { mode: 'claude-bg', launch: ['claude', '--bg'] },
      'claude-p': { mode: 'process', launch: ['claude', '-p'] },
      'claude-action': { mode: 'trigger', launch: ['gh', 'workflow', 'run'] },
      codex: { mode: 'process', launch: ['codex', 'exec'] },
    },
  };
  const layers = policyLayers(cfg, { preTool: true });

  assert.deepEqual(layers.filter((l) => l.live).map((l) => l.profile), ['claude-p']);
  assert.match(layers.find((l) => l.profile === 'claude').why, /never receives KB_TASK/);
  assert.match(layers.find((l) => l.profile === 'claude-action').why, /triggered run/);
  assert.match(layers.find((l) => l.profile === 'codex').why, /not Claude Code/);

  const s = sink();
  checkPolicyLayer({ root: '/nowhere', cfg }, s, { find: () => ({ hooks: [{ event: 'PreToolUse' }], unreadable: [] }) });

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[POLICY_CHECK, true]], 'a statement of which layer answers, not a problem to fix');
  assert.match(s.results[0].detail, /hkb's PreToolUse policy enforces on claude-p/);
  assert.match(s.results[0].detail, /claude, claude-track \(a `claude --bg` session never receives KB_TASK\)/);
  assert.match(s.results[0].detail, /the launch's own flags are the whole policy/);
});

test("with no PreToolUse hook configured, nothing of hkb's enforces anywhere", () => {
  const cfg = { profiles: { 'claude-p': { mode: 'process', launch: ['claude', '-p'] } } };
  assert.deepEqual(policyLayers(cfg, { preTool: false }), [{ profile: 'claude-p', live: false, why: 'no PreToolUse hook is configured here' }]);

  const s = sink();
  checkPolicyLayer({ root: '/nowhere', cfg }, s, { find: () => ({ hooks: [{ event: 'Stop' }], unreadable: [] }) });
  assert.match(s.results[0].detail, /^hkb's PreToolUse policy enforces on no profile here/);
});
