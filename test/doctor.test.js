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
} from '../src/doctor.js';
import { setTransport, GhError } from '../src/gh.js';

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
