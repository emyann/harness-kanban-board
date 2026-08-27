// KB_TOKEN expiry: what a response head says about the token that fetched it, what doctor reports,
// what Actions is told, and the dispatcher's once-a-day version of the same check.
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

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-26T12:00:00Z');
const head = (value) => (value === undefined ? {} : { [TOKEN_EXPIRY_HEADER]: value });
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

test("GitHub's own format parses, and so does ISO 8601", () => {
  const github = tokenExpiry(head('2026-09-25 12:00:00 UTC'), NOW);
  assert.equal(github.at, '2026-09-25T12:00:00.000Z');
  assert.equal(tokenExpiry(head('2026-09-25T12:00:00Z'), NOW).at, github.at);
  assert.equal(tokenExpiry(head('2026-09-25 05:00:00 -0700'), NOW).at, github.at);
});

test('the header name is matched however the transport cased it', () => {
  assert.ok(tokenExpiry({ 'GitHub-Authentication-Token-Expiration': '2026-09-25 12:00:00 UTC' }, NOW));
  assert.ok(tokenExpiry({ [TOKEN_EXPIRY_HEADER.toUpperCase()]: '2026-09-25 12:00:00 UTC' }, NOW));
});

test(`the warn window opens strictly under ${TOKEN_WARN_DAYS} days and closes at expiry`, () => {
  const at = (ms) => tokenExpiry(head(new Date(NOW + ms).toISOString()), NOW);
  assert.equal(at(30 * DAY).level, 'ok');
  assert.equal(at(TOKEN_WARN_DAYS * DAY).level, 'ok', 'exactly 7 days is still fine');
  assert.equal(at(TOKEN_WARN_DAYS * DAY - 1000).level, 'warn');
  assert.equal(at(DAY).level, 'warn');
  assert.equal(at(60_000).level, 'warn');
  assert.equal(at(0).level, 'expired');
  assert.equal(at(-DAY).level, 'expired');
});

test('days is whole days remaining, and goes negative once the token has lapsed', () => {
  const at = (ms) => tokenExpiry(head(new Date(NOW + ms).toISOString()), NOW);
  assert.equal(at(30 * DAY).days, 30);
  assert.equal(at(6.5 * DAY).days, 6);
  assert.equal(at(-DAY).days, -1);
  assert.equal(at(30 * DAY).ms, 30 * DAY);
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
  checkTokenExpiry(head(new Date(NOW + 4 * DAY).toISOString()), s, NOW);
  assert.equal(s.results[0].ok, null);
  assert.match(s.results[0].detail, /^expires 2026-08-30 12:00 UTC \(4 days left\)$/);
  assert.equal(s.results[0].fix, TOKEN_FIX);
  assert.match(TOKEN_FIX, /gh secret set KB_TOKEN/);
});

test('an expired token fails the check, so `hkb doctor` exits non-zero', () => {
  const s = sink();
  checkTokenExpiry(head(new Date(NOW - 3 * DAY).toISOString()), s, NOW);
  assert.equal(s.results[0].ok, false);
  assert.match(s.results[0].detail, /expired 2026-08-23 12:00 UTC \(3 days ago\)/);
  assert.equal(s.results[0].fix, TOKEN_FIX);
});

test('the singular and the sub-day cases read like English', () => {
  const detail = (ms) => expiryFinding(tokenExpiry(head(new Date(NOW + ms).toISOString()), NOW)).detail;
  assert.match(detail(DAY + 1000), /\(1 day left\)$/);
  assert.match(detail(6 * 3600_000), /\(less than a day left\)$/);
  assert.match(detail(-3600_000), /\(today\)$/);
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

test('the loop probes once a day and is free for the rest of it', async () => {
  const root = tmpRoot();
  const t = rateLimitTransport({ headers: head(new Date(NOW + 30 * DAY).toISOString()) });
  const restore = setTransport(t);
  try {
    const lines = [];
    assert.equal((await tokenExpiryNotice({ root }, (s) => lines.push(s), { now: NOW })).level, 'ok');
    assert.equal(t.calls.length, 1);
    assert.equal(stateOf(root).token_expiry_day, '2026-08-26');
    assert.deepEqual(lines, [], 'a healthy token is silent');

    assert.equal(await tokenExpiryNotice({ root }, (s) => lines.push(s), { now: NOW + 3600_000 }), null);
    assert.equal(t.calls.length, 1, 'same day: no second call');

    await tokenExpiryNotice({ root }, (s) => lines.push(s), { now: NOW + DAY });
    assert.equal(t.calls.length, 2, 'next day: it checks again');
    assert.equal(stateOf(root).token_expiry_day, '2026-08-27');
  } finally { restore(); }
});

test('a token inside the window is reported to the loop with the fix', async () => {
  const root = tmpRoot();
  const restore = setTransport(rateLimitTransport({ headers: head(new Date(NOW + 2 * DAY).toISOString()) }));
  try {
    const lines = [];
    const e = await tokenExpiryNotice({ root }, (s) => lines.push(s), { now: NOW });
    assert.equal(e.level, 'warn');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^token expiry: expires 2026-08-28 12:00 UTC \(2 days left\) → /);
    assert.match(lines[0], /gh secret set KB_TOKEN/);
  } finally { restore(); }
});

test('a failed probe stamps nothing, so the next tick tries again', async () => {
  const root = tmpRoot();
  const t = rateLimitTransport({ fail: new GhError('offline', { kind: 'network' }) });
  const restore = setTransport(t);
  try {
    assert.equal(await tokenExpiryNotice({ root }, () => {}, { now: NOW }), null);
    assert.equal(t.calls.length, 1);
    assert.ok(!fs.existsSync(path.join(root, '.kanban', 'state.json')));
  } finally { restore(); }
});

test('the day stamp is added to the state the dispatcher already keeps, not written over it', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'state.json'), JSON.stringify({ spawn_day: '2026-08-26', spawned_today: 3 }));
  const restore = setTransport(rateLimitTransport({ headers: head(new Date(NOW + 30 * DAY).toISOString()) }));
  try {
    await tokenExpiryNotice({ root }, () => {}, { now: NOW });
    assert.deepEqual(stateOf(root), { spawn_day: '2026-08-26', spawned_today: 3, token_expiry_day: '2026-08-26' });
  } finally { restore(); }
});
