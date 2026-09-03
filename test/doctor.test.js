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
  TRACK_PROFILE_CHECK, checkTrackProfile, checkDispatcher, checkServe,
  tallyDeniedTools, deniedToolsFinding, checkDeniedTools,
  CAPABILITIES_CHECK, checkCapabilityMap,
  TOOL_POSTURE_CHECK, checkToolPosture, CARD_GRANTS_CHECK, checkCardGrants, checkRemovedProfiles,
  STORE_CHECK, BRANCH_CHECK, INDEX_CHECK, MOUNT_CHECK, checkLocalStore, PATH_OVERLAP_CHECK, doctor } from '../src/doctor.js';
import { CAPABILITIES, capabilityGrants, effectiveTools, toolPosture } from '../src/model.js';
import { normalizeCardGrants } from '../src/tasks.js';
import { setTransport, GhError } from '../src/gh.js';
import { pidFile, writeServeUrl, DEFAULT_PROFILES, hostId } from '../src/board.js';
import { spawnSync } from 'node:child_process';
import { installDoubles, kbIssue, runWith } from './fake-store.js';

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

// ---------- the two long-running processes ----------

function results() {
  const rows = [];
  const ok = (name, detail) => rows.push({ name, ok: true, detail });
  const warn = (name, detail, fix) => rows.push({ name, ok: null, detail, fix });
  return { rows, ok, warn };
}

test('checkServe: nothing has ever started it', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  const r = results();
  checkServe({ root }, r);
  assert.deepEqual(r.rows, [{ name: 'serve', ok: null, detail: 'no server running', fix: 'hkb up --serve' }]);
});

/**
 * The URL is the whole point of `--serve` (#204): a running server's line names it, from
 * `.kanban/serve.url`, the same file `hkb up --status` reads — no `.kanban/logs/serve.log` grep.
 */
test('checkServe: running names the URL and the log, exactly like checkDispatcher does for the pid', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(pidFile(root, 'serve'), `${process.pid}\n`);
  writeServeUrl(root, 'http://127.0.0.1:4666');
  const r = results();
  checkServe({ root }, r);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ok, true);
  assert.match(r.rows[0].detail, /^running pid \d+ · http:\/\/127\.0\.0\.1:4666 · log \.kanban[/\\]logs[/\\]serve\.log$/);
});

test('checkServe: running with no serve.url yet (a rare race) still says running, without a bogus URL', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(pidFile(root, 'serve'), `${process.pid}\n`);
  const r = results();
  checkServe({ root }, r);
  assert.equal(r.rows[0].detail, `running pid ${process.pid} · log .kanban/logs/serve.log`);
});

test('checkDispatcher and checkServe read the same pid-file shape, name-scoped to their own process', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
  const r = results();
  checkDispatcher({ root }, r);
  checkServe({ root }, r);
  assert.deepEqual(r.rows.map((x) => x.name), ['dispatcher', 'serve']);
  assert.equal(r.rows[0].ok, true);
  assert.equal(r.rows[1].ok, null);
});

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-sessions-'));
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  const { gh, store, ctx, restore } = installDoubles((g) => ({
    root,
    cfg: {
      repo: g.nameWithOwner,
      default_branch: 'main',
      profiles: profiles || {
        claude: { mode: 'claude-bg', launch: ['claude', '--bg'] },
        'claude-p': { mode: 'process', launch: ['claude', '-p'] },
      },
    },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {},
    repo: { owner: g.owner, repo: g.repo, nameWithOwner: g.nameWithOwner },
    requireBoard() { return this; },
  }), { caps: { blockedByGql: true, closedByPrs: true } });
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  return { gh, store, ctx, root };
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

/** Every run record this board was asked for. */
const runReads = (store) => store.callsOf('loadRun').length;

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
  h.store.addIssue(kbIssue({
    number: 40, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude',
    updatedAt: '2026-08-27T09:00:00Z', run: runWith([attempt(1, 'completed'), attempt(2, 'completed')]),
  }));
  h.store.addIssue(kbIssue({
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

test('a board with roots but no track profile is told what it is paying for it', async (t) => {
  const h = boardHarness(t); // neither shipped profile here carries "track": true
  h.store.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 42, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 12, status: 'todo', agent: 'claude', blockedBy: [41] }));
  h.store.addIssue(kbIssue({ number: 13, status: 'todo', agent: 'claude', blockedBy: [42] })); // its child is done
  const s = sink();

  await checkTrackProfile(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TRACK_PROFILE_CHECK, null]]);
  assert.match(s.results[0].detail, /1 card with unfinished children \(#12\) and no profile with "track": true/);
  assert.match(s.results[0].fix, /^hkb init --profiles claude-track/);
});

test('a board that has a track profile is a green line, and does not read the board at all', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { launch: ['claude'] }, 'claude-track': { track: true, launch: ['claude'] } } });
  const s = sink();

  await checkTrackProfile(h.ctx, s, { fetch: () => { throw new Error('the board must not be read: the answer is in board.json'); } });

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TRACK_PROFILE_CHECK, true]]);
  assert.match(s.results[0].detail, /^claude-track — a card with unfinished children runs as one session/);
});

test('no track profile and no root either: nothing to fix, so nothing to warn about', async (t) => {
  const h = boardHarness(t);
  h.store.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude' }));
  const s = sink();

  await checkTrackProfile(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TRACK_PROFILE_CHECK, true]]);
  assert.match(s.results[0].detail, /nothing on the board has unfinished children/);
});

test('the completed attempts are on closed cards, so a closed card is read too', async (t) => {
  const h = boardHarness(t);
  h.store.addIssue(kbIssue({
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
    h.store.addIssue(kbIssue({
      number: n, status: 'ready', agent: 'claude',
      updatedAt: `2026-08-27T${String(n).padStart(2, '0')}:00:00Z`,
      run: runWith([attempt(1, 'completed', { session: true })]),
    }));
  }
  const s = sink();

  await checkSessions(h.ctx, s);

  assert.equal(s.results[0].ok, true);
  assert.equal(runReads(h.store), 1, 'the newest card answered; every further read could only repeat it');
});

test('a board with nothing to answer with is bounded, not walked', async (t) => {
  const h = boardHarness(t);
  for (let n = 1; n <= 20; n++) {
    h.store.addIssue(kbIssue({
      number: n, status: 'ready', agent: 'claude',
      updatedAt: `2026-08-27T${String(n).padStart(2, '0')}:00:00Z`,
      run: runWith([attempt(1, 'crashed')]),
    }));
  }
  const s = sink();

  await checkSessions(h.ctx, s);

  assert.equal(s.results[0].ok, null);
  assert.equal(runReads(h.store), SESSION_SAMPLE);
  assert.match(s.results[0].detail, new RegExp(`\\(${SESSION_SAMPLE} run records read\\)`), 'and says how much it looked at, so "none" can be weighed');
});

test('a board with no background profile is not asked at all — no read, no finding', async (t) => {
  const h = boardHarness(t, { profiles: { codex: { mode: 'process', launch: ['codex', 'exec'] } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'codex', run: runWith([attempt(1, 'completed', { profile: 'codex' })]) }));
  const s = sink();

  assert.deepEqual(await checkSessions(h.ctx, s), []);
  assert.deepEqual(s.results, []);
  assert.deepEqual(h.store.calls, [], 'a check with nothing to check must cost nothing');
});

test('a profile that has never ended an attempt here has nothing to be wrong about', async (t) => {
  const h = boardHarness(t, {
    profiles: {
      claude: { mode: 'claude-bg', launch: ['claude', '--bg'] },
      'claude-track': { mode: 'claude-bg', launch: ['claude', '--bg'] },
    },
  });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', run: runWith([attempt(1, 'completed', { session: true })]) }));
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
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', run: runWith([attempt(1, 'completed', { session: true })]) }));
  const board = await boardOnce(h.ctx);
  const before = h.store.calls.length;

  await checkAgentLabels(h.ctx, sink(), { board });
  await checkSessions(h.ctx, sink(), { board });

  const reReads = h.store.calls.slice(before).filter((c) => c.name === 'listTasks');
  assert.deepEqual(reReads, [], 'neither check re-reads the board it was handed');
});

// ---------- #130: the denied-tools ledger, and whether an MCP server ever reached a worker ----------

test('tallyDeniedTools sums denied_tools across attempts, grouped by profile+kind+display tool, most-denied first', () => {
  const runs = [runWith([
    attempt(1, 'completed', { denied_tools: [{ tool: 'mcp__react-aria__Button', kind: 'dontask-miss', count: 3, first_seen: 't1' }] }),
    attempt(2, 'timed_out', { denied_tools: [{ tool: 'mcp__react-aria__Dialog', kind: 'dontask-miss', count: 4, first_seen: 't2' }] }),
    attempt(3, 'crashed', { profile: 'codex', denied_tools: [{ tool: 'Bash', kind: 'permission-rule', count: 1, first_seen: null }] }),
  ])];
  assert.deepEqual(tallyDeniedTools(runs), [
    { profile: 'claude', kind: 'dontask-miss', tool: 'mcp__react-aria__*', count: 7 },
    { profile: 'codex', kind: 'permission-rule', tool: 'Bash', count: 1 },
  ]);
  assert.deepEqual(tallyDeniedTools([]), []);
  assert.deepEqual(tallyDeniedTools([runWith([attempt(1, 'completed')])]), []);
});

test('deniedToolsFinding: a dontAsk-miss becomes the exact allowed_tools edit', () => {
  const f = deniedToolsFinding([{ profile: 'claude', kind: 'dontask-miss', tool: 'Skill', count: 5 }], 'board.json');
  assert.equal(f.name, 'denied tools');
  assert.equal(f.ok, null);
  assert.equal(f.detail, 'Skill denied 5 times on the claude profile');
  assert.equal(f.fix, 'add "Skill" to "allowed_tools" on the claude profile in board.json');
});

test('deniedToolsFinding: a permission-rule denial gets a different fix — the launch\'s disallowedTools, not the allowlist', () => {
  const f = deniedToolsFinding([{ profile: 'claude', kind: 'permission-rule', tool: 'Bash', count: 2 }], 'board.json');
  assert.match(f.detail, /\(permission-rule\)/);
  assert.match(f.fix, /remove Bash from "disallowedTools"/);
});

test('deniedToolsFinding: the worktree guard gets no fix at all — no board.json edit reaches a structural guard', () => {
  const f = deniedToolsFinding([{ profile: 'claude', kind: 'worktree-guard', tool: 'Bash', count: 9 }], 'board.json');
  assert.match(f.detail, /the worktree guard, not an allowlist/);
  assert.equal(f.fix, undefined);
});

test('deniedToolsFinding: null when the sample carries no ledger at all', () => {
  assert.equal(deniedToolsFinding([], 'board.json'), null);
  assert.equal(deniedToolsFinding(null, 'board.json'), null);
});

test('checkDeniedTools: reports the most-denied tool on a board that has some, and mcp visibility when a repo .mcp.json names a server', async (t) => {
  const h = boardHarness(t);
  const file = path.join(h.root, 'sess.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'mcp__react-aria__Button', input: {} }] },
  }) + '\n');
  h.store.addIssue(kbIssue({
    number: 40, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude',
    updatedAt: '2026-08-27T09:00:00Z',
    run: runWith([attempt(1, 'completed', { session: true, transcript_path: file, denied_tools: [{ tool: 'mcp__react-aria__Button', kind: 'dontask-miss', count: 6, first_seen: 't1' }] })]),
  }));
  fs.writeFileSync(path.join(h.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'react-aria': { command: 'npx', args: ['react-aria-mcp'] }, playwright: { command: 'npx', args: ['playwright-mcp'] } } }));
  const s = sink();

  await checkDeniedTools(h.ctx, s);

  const denied = s.results.find((r) => r.name === 'denied tools');
  assert.equal(denied.detail, 'mcp__react-aria__* denied 6 times on the claude profile');
  assert.equal(denied.fix, 'add "mcp__react-aria__*" to "allowed_tools" on the claude profile in .kanban/board.json');

  const visibility = s.results.find((r) => r.name === 'mcp visibility');
  assert.equal(visibility.ok, null, 'react-aria showed up, but playwright never did');
  assert.match(visibility.detail, /playwright never showed up/);
  assert.doesNotMatch(visibility.detail, /react-aria/, 'only the server that never appeared is named');
});

test('checkDeniedTools: every configured server reached a worker — ok, and says how many run records it sampled', async (t) => {
  const h = boardHarness(t);
  const file = path.join(h.root, 'sess.jsonl');
  fs.writeFileSync(file, JSON.stringify({
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'mcp__react-aria__Button', input: {} }] },
  }) + '\n');
  h.store.addIssue(kbIssue({
    number: 40, status: 'ready', agent: 'claude',
    run: runWith([attempt(1, 'completed', { session: true, transcript_path: file })]),
  }));
  fs.writeFileSync(path.join(h.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'react-aria': { command: 'npx', args: ['react-aria-mcp'] } } }));
  const s = sink();

  await checkDeniedTools(h.ctx, s);

  const visibility = s.results.find((r) => r.name === 'mcp visibility');
  assert.equal(visibility.ok, true);
  assert.match(visibility.detail, /1 \.mcp\.json server reached a worker session/);
});

test('checkDeniedTools: no .mcp.json, or no claude-bg profile, asks nothing about visibility', async (t) => {
  const h = boardHarness(t, { profiles: { 'claude-p': { mode: 'process', launch: ['claude', '-p'] } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude-p', run: runWith([attempt(1, 'completed', { profile: 'claude-p' })]) }));
  fs.writeFileSync(path.join(h.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'react-aria': {} } }));
  const s = sink();

  await checkDeniedTools(h.ctx, s);

  assert.equal(s.results.find((r) => r.name === 'mcp visibility'), undefined, 'no claude-bg profile runs it, so nothing could ever be invisible to one');
});

test('checkDeniedTools: #254 — a server approved only in settings.local.json was never approved for a worktree, and the fix names the exact line and file', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['mcp__react-aria__*'] } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', run: runWith([attempt(1, 'completed')]) }));
  fs.writeFileSync(path.join(h.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'react-aria': { command: 'npx', args: ['react-aria-mcp'] } } }));
  fs.mkdirSync(path.join(h.root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h.root, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['react-aria'] }));
  const s = sink();

  await checkDeniedTools(h.ctx, s);

  const visibility = s.results.find((r) => r.name === 'mcp visibility');
  assert.equal(visibility.ok, null);
  assert.match(visibility.detail, /react-aria approved for a developer's machine only/);
  assert.match(visibility.detail, /"react-aria" in "enabledMcpjsonServers" in \.claude\/settings\.local\.json/);
  assert.match(visibility.detail, /never approved for one/);
  assert.match(visibility.fix, /move "react-aria" in "enabledMcpjsonServers" from \.claude\/settings\.local\.json to \.claude\/settings\.json/);
});

test('checkDeniedTools: #254 — approved in the tracked settings.json, so it reached the worktree: reported as unused, not unapproved', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['mcp__react-aria__*'] } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', run: runWith([attempt(1, 'completed')]) }));
  fs.writeFileSync(path.join(h.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'react-aria': { command: 'npx', args: ['react-aria-mcp'] } } }));
  fs.mkdirSync(path.join(h.root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h.root, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['react-aria'] }));
  const s = sink();

  await checkDeniedTools(h.ctx, s);

  const visibility = s.results.find((r) => r.name === 'mcp visibility');
  assert.match(visibility.detail, /react-aria approved in \.claude\/settings\.json, so it did reach a worktree/);
  assert.match(visibility.detail, /there and unused, not one that was never approved/);
});

test('checkDeniedTools: a board with no ledger anywhere says nothing at all', async (t) => {
  const h = boardHarness(t);
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', run: runWith([attempt(1, 'completed')]) }));
  const s = sink();

  await checkDeniedTools(h.ctx, s);

  assert.deepEqual(s.results, []);
});

// ---------- kb.skills asks for a tool a profile may deny (#114) ----------

test('a board that sets no kb.skills has nothing to check', async (t) => {
  const h = boardHarness(t);
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude' }));
  const s = sink();

  await checkTaskSkills(h.ctx, s);

  assert.deepEqual(s.results, []);
});

test('kb.skills on a profile that allows Skill is fine', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['Read', 'Skill'] } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', kb: { skills: ['kanban'] } }));
  const s = sink();

  await checkTaskSkills(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TASK_SKILLS_CHECK, true]]);
});

test('kb.skills on a profile whose allowed_tools omits Skill is a warning naming the card and the fix', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['Read'] } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', kb: { skills: ['kanban'] } }));
  const s = sink();

  await checkTaskSkills(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TASK_SKILLS_CHECK, null]]);
  assert.match(s.results[0].detail, /#40 \(claude\)/);
  assert.match(s.results[0].fix, /add "Skill" to "allowed_tools" on the claude profile/);
});

test('kb.skills is silent on a launch Skill has no meaning for (codex has no per-command allow-list)', async (t) => {
  const h = boardHarness(t, { profiles: { codex: { mode: 'process', launch: ['codex', 'exec'], allowed_tools: null } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'codex', kb: { skills: ['kanban'] } }));
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
      codex: { mode: 'process', launch: ['codex', 'exec'] },
    },
  };
  const layers = policyLayers(cfg, { preTool: true });

  assert.deepEqual(layers.filter((l) => l.live).map((l) => l.profile), ['claude-p']);
  assert.match(layers.find((l) => l.profile === 'claude').why, /never receives KB_TASK/);
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

// ---------- the grant is derived from the capability map (#261) ----------
//
// #114 was a field naming a capability and a launch granting it kept as two hand-maintained facts.
// They drifted, and under `dontAsk` an unlisted tool is denied rather than prompted, so the drift
// was silent. These tests exist to make that shape impossible a second time: nothing below writes
// the expected tool by hand — every assertion asks `capabilityGrants` what the binding needs and
// then asks `effectiveTools`, the one derivation of a launch's tool list, whether it is granted.

/** A Claude-shaped profile whose `allowed_tools` deliberately omits whatever a binding will imply. */
const bindingProfile = (capabilities) => ({
  launch: ['claude', '--bg', '--allowedTools', '{allowed_tools}'],
  allowed_tools: ['Read', 'Edit'],
  capabilities,
});

test('a binding and its permission cannot drift: whatever a grant needs, the launch grants', () => {
  for (const intent of Object.keys(CAPABILITIES)) {
    const profile = bindingProfile({ [intent]: '/whatever-this-harness-calls-it' });
    const grants = capabilityGrants(profile);
    assert.equal(grants.length, 1, `${intent} is bound, so exactly one grant is derived`);
    assert.ok(grants[0].tool, `${intent} bound to a slash command needs a tool on a Claude launch`);
    // the assertion never names the tool: it is read off the derivation, so a change to what a
    // binding implies moves both sides at once or fails here
    assert.ok(effectiveTools(profile, null, {}).tools.includes(grants[0].tool),
      `${intent}: the launch must grant ${grants[0].tool} because the profile binds it`);
    assert.ok(!profile.allowed_tools.includes(grants[0].tool),
      'and it is granted by derivation, not because someone also typed it into allowed_tools');
  }
});

test('the derived grant is the profile widening itself — a card can still narrow it away', () => {
  const profile = bindingProfile({ review: '/review-here' });
  const [grant] = capabilityGrants(profile);
  assert.ok(effectiveTools(profile, { kb: { tools: ['Read', grant.tool] } }, {}).tools.includes(grant.tool),
    'a card may ask for the derived tool: the profile grants it, so it is not dropped');
  assert.ok(!effectiveTools(profile, { kb: { tools: ['Read'] } }, {}).tools.includes(grant.tool),
    'and a card that narrows past it takes it away, like any other tool');
});

test('a binding invoked some other way implies nothing, and a non-Claude launch is left alone', () => {
  const shell = { launch: ['claude', '--bg'], allowed_tools: ['Read'], capabilities: { review: 'make review' } };
  assert.equal(capabilityGrants(shell)[0].tool, null, 'not a slash command: nothing to grant');
  assert.deepEqual(effectiveTools(shell, null, {}).tools, ['Read']);
  const copilot = { launch: ['copilot', '-p'], allowed_tools: ['shell(git *)'], capabilities: { review: '/review' } };
  assert.equal(capabilityGrants(copilot)[0].tool, null, 'hkb does not know how this harness invokes it');
  assert.deepEqual(effectiveTools(copilot, null, {}).tools, ['shell(git *)']);
});

test('a board that declares no capabilities has a byte-identical launch line', () => {
  for (const [name, p] of Object.entries(DEFAULT_PROFILES)) {
    assert.deepEqual(capabilityGrants(p), [], `${name} binds nothing by default`);
    const { tools, dropped } = effectiveTools(p, null, {});
    assert.deepEqual(dropped, []);
    assert.deepEqual(tools, p.allowed_tools || [], `${name}: the grant is the profile's own list, unchanged`);
  }
});

test('doctor is silent about a board that binds nothing', () => {
  const s = sink();
  assert.equal(checkCapabilityMap({ root: '/nowhere', cfg: { profiles: DEFAULT_PROFILES } }, s), null);
  assert.deepEqual(s.results, []);
});

test('doctor prints the map, one line naming the intent, the binding and the tool it needs', () => {
  const s = sink();
  const cfg = { profiles: { claude: bindingProfile({ review: '/code-review', goal: '/goal' }) } };
  checkCapabilityMap({ root: '/nowhere', cfg }, s);
  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[CAPABILITIES_CHECK, true], [CAPABILITIES_CHECK, true]]);
  assert.match(s.results[0].detail, /claude: review → \/code-review \(Skill\)/);
  assert.match(s.results[0].detail, /claude: goal → \/goal \(Skill\)/);
});

test('doctor flags a binding the launch cannot grant, and says how to fix it', () => {
  const noList = sink();
  checkCapabilityMap({ root: '/nowhere', cfg: { profiles: { claude: { launch: ['claude', '--bg', '--allowedTools', '{allowed_tools}'], allowed_tools: null, capabilities: { review: '/code-review' } } } } }, noList);
  const warned = noList.results.filter((r) => r.ok === null);
  assert.equal(warned.length, 1);
  assert.match(warned[0].detail, /binds review to \/code-review, which needs the Skill tool/);
  assert.match(warned[0].detail, /denies rather than prompts/);
  assert.match(warned[0].fix, /"allowed_tools"/);

  // and the half effectiveTools cannot see: a perfect tool list a launch line never spends
  const unspent = sink();
  checkCapabilityMap({ root: '/nowhere', cfg: { profiles: { claude: { launch: ['claude', '--bg'], allowed_tools: ['Read'], capabilities: { review: '/code-review' } } } } }, unspent);
  const dropped = unspent.results.filter((r) => r.ok === null);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].detail, /never spends \{allowed_tools\}/);
});

test('doctor does not recompute the grant: a launch effectiveTools covers is never flagged', () => {
  for (const intent of Object.keys(CAPABILITIES)) {
    const s = sink();
    checkCapabilityMap({ root: '/nowhere', cfg: { profiles: { claude: bindingProfile({ [intent]: '/x' }) } } }, s);
    assert.deepEqual(s.results.filter((r) => r.ok === null), [], `${intent} is granted, so nothing to warn about`);
  }
});

// ---------- the ceiling rule: the board grants, a card lowers, only a human raises (#258) ----------
//
// The board is the ceiling. `kb.tools` / `kb.mcp` on a card are subsets only — they lower it for one
// task and can never raise it — and `hkb doctor` must print what the board actually decided, because
// a posture nobody can see is the bug this whole track exists to fix. Nothing below asserts a grant
// by restating it: every grant assertion goes through `effectiveTools`, the one derivation, exactly
// as the launch and the check do.

test('the card grant keys are normalised where they enter: names only, trimmed, deduplicated, order kept', () => {
  const kb = { tools: ['  Read ', 'Read', 'Edit', '', 7, null, { Bash: true }], mcp: ['react-aria', 'react-aria'] };
  normalizeCardGrants(kb);
  assert.deepEqual(kb.tools, ['Read', 'Edit'], 'blanks and non-names are not something any profile can grant');
  assert.deepEqual(kb.mcp, ['react-aria']);
});

test('an empty card list is kept — "none of them" is the strictest narrowing a card can ask for', () => {
  const kb = { tools: [], mcp: [] };
  normalizeCardGrants(kb);
  assert.deepEqual(kb, { tools: [], mcp: [] });
  const profile = { allowed_tools: ['Read', 'Edit'] };
  assert.deepEqual(effectiveTools(profile, { kb }, {}).tools, [], 'and it reaches the launch as no tools at all');
});

test('a key that is not a list is left alone rather than guessed at — guessing is the one thing that could widen', () => {
  const kb = { tools: 'Read', mcp: { 'react-aria': true } };
  normalizeCardGrants(kb);
  assert.deepEqual(kb, { tools: 'Read', mcp: { 'react-aria': true } });
  const profile = { allowed_tools: ['Read', 'Edit'] };
  assert.deepEqual(effectiveTools(profile, { kb }, {}).tools, ['Read', 'Edit'], 'it narrows nothing; doctor says so');
});

test('doctor prints each profile posture, its ceiling and its MCP answer; absent means curate', () => {
  const s = sink();
  const cfg = { profiles: {
    claude: { launch: ['claude', '--bg'], allowed_tools: ['Read', 'Edit', 'mcp__react-aria__*'] },
    open: { launch: ['claude', '--bg'], tools: 'inherit', allowed_tools: ['Read'], mcp: ['supabase'] },
    codex: { launch: ['codex', 'exec'], allowed_tools: null },
  } };
  checkToolPosture({ root: '/nowhere', cfg }, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[TOOL_POSTURE_CHECK, true]]);
  const line = s.results[0].detail;
  // the posture is read off the resolver, never typed here: absent resolves to curate
  assert.match(line, new RegExp(`claude: ${toolPosture(cfg.profiles.claude)}, 3 tools`));
  assert.match(line, /claude: curate, 3 tools, mcp from allowed_tools: react-aria/);
  assert.match(line, /open: inherit, 1 tool, mcp: the session's own, less supabase/);
  assert.match(line, /codex: curate, no allow-list \(the sandbox is the policy\), mcp: none/);
});

test('under curate a declared mcp list is what a worker may reach, and it is printed as such', () => {
  const s = sink();
  checkToolPosture({ root: '/nowhere', cfg: { profiles: { claude: { launch: ['claude'], allowed_tools: ['Read'], mcp: ['react-aria', 'figma'] } } } }, s);
  // 3, not 1: naming a server under curate is what *grants* it (`applyProfileMcp`, src/model.js), so
  // the ceiling is Read plus an `mcp__<server>__*` per declared server. The count is the effective
  // grant, never the hand-written allowed_tools — that is the whole point of one derivation.
  assert.match(s.results[0].detail, /claude: curate, 3 tools, mcp: react-aria, figma/);
});

test('doctor is silent about card grants on a board where no card asks for either key', async (t) => {
  const h = boardHarness(t);
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude' }));
  const s = sink();

  assert.equal(await checkCardGrants(h.ctx, s), null);
  assert.deepEqual(s.results, []);
});

test('a card that narrows inside its profile grant passes, and doctor says how many narrow', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['Read', 'Edit', 'mcp__react-aria__read'] } } });
  h.store.addIssue(kbIssue({ number: 40, status: 'ready', agent: 'claude', kb: { tools: ['Read'], mcp: ['react-aria'] } }));
  const s = sink();

  await checkCardGrants(h.ctx, s);

  assert.deepEqual(s.results.map((r) => [r.name, r.ok]), [[CARD_GRANTS_CHECK, true]]);
  assert.match(s.results[0].detail, /narrowing on 1 card: every tool and server they name is one their profile already grants/);
});

test('a card asking for what its profile lacks is flagged: dropped, never granted, and only board.json widens', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['Read'] } } });
  h.store.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude', kb: { tools: ['Read', 'Bash(rm -rf /)'], mcp: ['stripe'] } }));
  const s = sink();

  await checkCardGrants(h.ctx, s);

  const warned = s.results.filter((r) => r.ok === null);
  assert.equal(warned.length, 1);
  assert.match(warned[0].detail, /#41 \(claude\) asks for Bash\(rm -rf \/\), mcp__stripe__\*/);
  assert.match(warned[0].detail, /dropped at the launch, never granted/);
  assert.match(warned[0].detail, /only a human editing .*board\.json widens it/);
  assert.match(warned[0].fix, /add it to "allowed_tools" on the claude profile/);
});

test('a card grant key that is not a list is reported: it reads as a restriction and is not one', async (t) => {
  const h = boardHarness(t, { profiles: { claude: { mode: 'claude-bg', launch: ['claude', '--bg'], allowed_tools: ['Read'] } } });
  h.store.addIssue(kbIssue({ number: 42, status: 'ready', agent: 'claude', kb: { tools: 'Read' } }));
  const s = sink();

  await checkCardGrants(h.ctx, s);

  const warned = s.results.filter((r) => r.ok === null);
  assert.equal(warned.length, 1);
  assert.match(warned[0].detail, /kb\.tools on #42 is not a list of names, so it narrows nothing/);
  assert.match(warned[0].fix, /JSON list of tool patterns/);
});

// #290 follow-up: a profile this hkb no longer has is dropped at load, so doctor is the place that
// says so — otherwise the board looks healthy while nothing claims that profile's cards.
test('doctor warns about a profile hkb removed, naming both halves of the fix', () => {
  const ctx = { root: '/tmp/none', cfg: { profiles: {}, removed_profiles: [{ name: 'claude-action', why: 'the GitHub Actions runner was removed in ADR-006' }] } };
  const rows = [];
  checkRemovedProfiles(ctx, { ok: (...a) => rows.push(['ok', ...a]), warn: (...a) => rows.push(['warn', ...a]) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'warn');
  assert.equal(rows[0][1], 'profile claude-action');
  assert.match(rows[0][2], /ADR-006/);
  assert.match(rows[0][3], /hkb init/);
  assert.match(rows[0][3], /hkb adopt/);
});

test('doctor says nothing about removed profiles on a board that names none', () => {
  const rows = [];
  checkRemovedProfiles({ cfg: { profiles: {} } }, { ok: () => rows.push('ok'), warn: () => rows.push('warn') });
  checkRemovedProfiles({ cfg: { profiles: {}, removed_profiles: [] } }, { ok: () => rows.push('ok'), warn: () => rows.push('warn') });
  assert.deepEqual(rows, []);
});

// ---------- the local store's three probes (docs/local-first.md §6.3) ----------

/** A scratch repository with a local board on it, and a context of `makeContext`'s shape. */
function localBoard() {
  const root = tmpRoot();
  const run = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  run('init', '-q', '-b', 'main', '.');
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
  run('add', 'a.txt'); run('commit', '-qm', 'init');
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  const ctx = { root, cfg: { store: 'local', profiles: {} }, board: 'default', host: hostId(), _cache: {} };
  return { root, ctx, run };
}

/** The three findings, keyed by name — a probe is about one thing, and the rest are noise. */
async function probe(ctx, opts = {}) {
  const rows = [];
  const push = (ok) => (name, detail, fix) => rows.push({ name, ok, detail, fix });
  await checkLocalStore(ctx, { ok: push(true), warn: push(null), bad: push(false) }, opts);
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}

test('doctor on a GitHub board says which store it is and probes nothing else', async () => {
  const rows = await probe({ root: '/tmp/none', cfg: { store: 'github', repo: 'o/r' }, board: 'default', _cache: {} });
  assert.equal(rows[STORE_CHECK].ok, true);
  assert.match(rows[STORE_CHECK].detail, /github — the board is the kb:\* issues on o\/r/);
  assert.equal(rows[BRANCH_CHECK], undefined, 'there is no branch to be wrong about');
  assert.equal(rows[MOUNT_CHECK], undefined);
});

test('doctor: the branch, the index tip and the mount, on a healthy local board', async () => {
  const { root, ctx } = localBoard();
  const { openLocalStore } = await import('../src/store/local.js');
  const { openGitTier } = await import('../src/store/git.js');
  openGitTier(ctx).init('default');
  const store = openLocalStore(ctx);
  store.createTask({ title: 'a card', status: 'ready' });
  store.close();

  const mounts = path.join(root, 'mounts');
  fs.writeFileSync(mounts, `/dev/sda1 ${root} ext4 rw 0 0\n`);
  const rows = await probe(ctx, { mounts });
  assert.equal(rows[STORE_CHECK].ok, true);
  assert.match(rows[STORE_CHECK].detail, /^local — kb-board in /);
  assert.equal(rows[BRANCH_CHECK].ok, true);
  assert.match(rows[BRANCH_CHECK].detail, /never pushed to origin/);
  assert.equal(rows[INDEX_CHECK].ok, true, JSON.stringify(rows[INDEX_CHECK]));
  assert.match(rows[INDEX_CHECK].detail, /matching the branch/);
  assert.equal(rows[MOUNT_CHECK].ok, true);
  assert.match(rows[MOUNT_CHECK].detail, /^ext4 at /);
});

test('doctor refuses an index on a 9p mount, and warns on a filesystem it does not know', async () => {
  const { root, ctx } = localBoard();
  const { openGitTier } = await import('../src/store/git.js');
  openGitTier(ctx).init('default');

  const nine = path.join(root, 'mounts-9p');
  fs.writeFileSync(nine, `C:\\ / 9p rw 0 0\n`);
  const bad = (await probe(ctx, { mounts: nine }))[MOUNT_CHECK];
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /is 9p — SQLite's locking does not work there/);
  assert.match(bad.fix, /local disk/);

  const odd = path.join(root, 'mounts-odd');
  fs.writeFileSync(odd, `thing / weirdfs rw 0 0\n`);
  const unknown = (await probe(ctx, { mounts: odd }))[MOUNT_CHECK];
  assert.equal(unknown.ok, null, 'unknown is a warning, not a refusal');
  assert.match(unknown.detail, /"weirdfs", which hkb does not recognise/);

  const missing = (await probe(ctx, { mounts: path.join(root, 'nope') }))[MOUNT_CHECK];
  assert.equal(missing.ok, null);
  assert.match(missing.detail, /could not read/);
});

test('doctor diagnoses the index without creating it', async () => {
  // The check reported "empty — no verb has opened this board here yet" about a file it had just
  // made itself: `openLocalStore` opened a *writing* connection, which mkdirs the directory, creates
  // the database and runs the schema. A reader that writes is not a diagnosis, and the write also
  // queued behind a dispatcher mid-`load()` for the full busy timeout.
  const { ctx, root } = localBoard();
  const { openGitTier } = await import('../src/store/git.js');
  const { indexFileIn } = await import('../src/store/sqlite.js');
  const { storeGitDir } = await import('../src/board.js');
  openGitTier(ctx).init('default');
  const file = indexFileIn(storeGitDir(ctx), 'default');
  assert.equal(fs.existsSync(file), false, 'no verb has opened this board here');

  const rows = await probe(ctx, { mounts: '/dev/null' });
  assert.equal(rows[INDEX_CHECK].ok, null);
  assert.match(rows[INDEX_CHECK].detail, /empty — no verb has opened this board here yet/);
  assert.equal(fs.existsSync(file), false, 'and doctor did not make one to say so');
  // The store row still names where the index would live, computed rather than read off an open one.
  assert.match(rows[STORE_CHECK].detail, /index \.git[/\\]hkb[/\\]index\.db/);
  void root;
});

test('doctor: a branch with no board, an index that has fallen behind, and a foreign owner', async () => {
  const { ctx } = localBoard();
  const empty = await probe(ctx, { mounts: '/dev/null' });
  assert.equal(empty[BRANCH_CHECK].ok, false);
  assert.match(empty[BRANCH_CHECK].detail, /no kb-board branch/);
  assert.equal(empty[BRANCH_CHECK].fix, 'hkb init');

  const { openLocalStore } = await import('../src/store/local.js');
  const { openGitTier } = await import('../src/store/git.js');
  openGitTier(ctx).init('default');
  const store = openLocalStore(ctx);
  store.createTask({ title: 'a card', status: 'ready' });
  store.close();
  // The branch moves with nothing telling the index — the crash `open()` repairs.
  openGitTier(ctx).createTask({ title: 'and another', status: 'ready' });
  const behind = (await probe(ctx, { mounts: '/dev/null' }))[INDEX_CHECK];
  assert.equal(behind.ok, null);
  assert.match(behind.detail, /the branch is at .* — the next verb rebuilds it/);

  // and a board this host does not own is read-only, which doctor says twice: on the branch row
  // (whose host it is) and on the store row (that every mutating verb refuses)
  openGitTier(ctx).takeOver('someone-elses-laptop');
  const rows = [];
  const push = (ok) => (name, detail, fix) => rows.push({ name, ok, detail, fix });
  await checkLocalStore({ ...ctx, _cache: {} }, { ok: push(true), warn: push(null), bad: push(false) }, { mounts: '/dev/null' });
  assert.ok(rows.some((r) => r.name === BRANCH_CHECK && /host "someone-elses-laptop"/.test(r.detail)));
  const refused = rows.find((r) => r.name === STORE_CHECK && r.ok === null);
  assert.match(refused.detail, /owns this board, so every mutating verb refuses here/);
  assert.equal(refused.fix, 'hkb init --take-over');
});

test('a forge that is not there costs one line, not the whole report', async (t) => {
  // Every local probe above the GitHub half had already run and answered when one 404 from the
  // forge threw out of `doctor` itself and took the report with it. On a local board — a repo that
  // was renamed, a `repo` left over from an old init, `gh` logged out — that is precisely the
  // board whose answers the human needed.
  const { root, ctx } = localBoard();
  const { openGitTier } = await import('../src/store/git.js');
  openGitTier(ctx).init('default');
  // One card that sets `kb.skills` and `kb.tools`, so all three board checks below have something
  // to answer about: `task skills` and `card grants` say nothing on a board with no such card, and
  // a silent check cannot demonstrate that it read the board rather than failed to.
  const { openLocalStore } = await import('../src/store/local.js');
  const seed = openLocalStore(ctx);
  await seed.createTask({ title: 'a card with grants', kb: { skills: ['kanban'], tools: ['Read'] }, status: 'todo', agent: 'claude' });
  seed.close();
  ctx.repo = { owner: 'o', repo: 'r', nameWithOwner: 'o/r' };
  ctx.cfg.repo = 'o/r';
  ctx.json = true;
  const restore = setTransport(() => { throw new GhError('gh: Not Found (HTTP 404)', { status: 404, kind: 'notfound' }); });
  t.after(restore);

  let out = '';
  await doctor(ctx, {}, (s2) => { out += s2; });
  const rows = JSON.parse(out);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));

  assert.equal(by[STORE_CHECK].ok, true, 'the store line survived');
  assert.equal(by[BRANCH_CHECK].ok, true);
  assert.ok(by[INDEX_CHECK], 'and the index probe');
  assert.ok(by[MOUNT_CHECK], 'and the mount probe');
  // **A skipped check must be distinguishable from a passing one.** The GitHub half used to be one
  // sequence of bare `await`s: the first throw unwound to a single `bad('github', …)` and doctor
  // then printed "N problem(s)" as though every other question had been asked and answered. Now
  // each probe fails under its own name.
  assert.equal(by.labels.ok, false, 'the labels probe answered for itself');
  assert.notEqual(by['rate limit']?.ok, true, `the checks after it still ran and none of them passed against a forge that is not there: ${Object.keys(by).join(', ')}`);
  // `track branches` and `orphaned PRs` are the two that no longer ask the forge anything here, and
  // they are `ok` because they were skipped, not because they passed — so each says which in words,
  // the way `gc.js` speaks its own line for the identical sweep. A skipped check that reported a
  // bare `ok` would be exactly the shape this test exists to refuse.
  for (const name of ['track branches', 'orphaned PRs']) {
    assert.equal(by[name].ok, true, `${name} is not a question a local board can answer`);
    assert.match(by[name].detail, /local board/, `${name} says it was skipped and why: ${by[name].detail}`);
  }
  // And the checks that need the *board* rather than the forge now answer on a local board, because
  // doctor reads it through `openStore` like every other verb (#325). They used to be the "could not
  // read the board" rows here: `fetchBoard` was the GitHub driver's query, so a 404 from a forge
  // this board does not live on silenced three checks that had every answer on disk. The line this
  // test draws is unchanged — a forge failure costs one row, not the report — and one row fewer
  // falls on the wrong side of it.
  // All three, not one: the property under test is "a skipped check is distinguishable from a
  // passing one", and it is only tested by the checks that could have been skipped. Asserting one
  // of the three leaves the other two covered by nothing.
  for (const name of ['task agent labels', 'task skills', 'card grants']) {
    assert.equal(by[name]?.ok, true, `${name} answered from the local board: ${Object.keys(by).join(', ')}`);
    assert.doesNotMatch(by[name].detail || '', /could not read the board/, `${name}: ${by[name].detail}`);
  }
  assert.ok(by['rate limit'] && by.GraphQL, 'and the probes after the board read still ran');
  assert.equal(by.github, undefined, 'and the whole half is no longer collapsed into one line');

  // and the check that reads `ctx.cfg` and nothing else is on the local side of that line. It sat
  // inside `githubChecks`, after the labels call that throws first, so the catch turned it into the
  // one `bad('github', …)` above and a malformed `dispatch.guards.path_overlap` went unreported —
  // on a check that needs no network at all. That split exists so a forge failure cannot swallow a
  // local answer; a local check living on the wrong side of it defeats the split.
  assert.equal(by[PATH_OVERLAP_CHECK]?.ok, true, `the path-overlap guard answered: ${Object.keys(by).join(', ')}`);
  void root;
});

test('a malformed path_overlap guard is reported even when the forge is unreachable', async (t) => {
  const { ctx } = localBoard();
  const { openGitTier } = await import('../src/store/git.js');
  openGitTier(ctx).init('default');
  ctx.repo = { owner: 'o', repo: 'r', nameWithOwner: 'o/r' };
  ctx.cfg.repo = 'o/r';
  ctx.cfg.dispatch = { ...ctx.cfg.dispatch, guards: { path_overlap: 'sometimes' } };
  ctx.json = true;
  const restore = setTransport(() => { throw new GhError('gh: Not Found (HTTP 404)', { status: 404, kind: 'notfound' }); });
  t.after(restore);

  let out = '';
  await doctor(ctx, {}, (s2) => { out += s2; });
  const by = Object.fromEntries(JSON.parse(out).map((r) => [r.name, r]));
  assert.equal(by[PATH_OVERLAP_CHECK].ok, false);
  assert.match(by[PATH_OVERLAP_CHECK].fix, /path_overlap/);
});
