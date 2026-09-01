// fetchBoard's blocker fill-in (#226): who gets one, where the lists came from, and what an
// empty list means. `hkb groom` reports on every open card, so it needs `blockers: 'all'`; the
// tick still needs only todo/blocked, and neither may cost a request on a repo whose GraphQL
// answers blockedBy in the board query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchBoard, blockersOf, blockersKnown } from '../src/tasks.js';
import { GROOM_BLOCKERS_CHECK, checkGroomBlockers } from '../src/doctor.js';
import { FakeGh, kbIssue } from './fake-gh.js';

let seq = 0;

function harness({ blockedByGql = false } = {}) {
  const gh = new FakeGh({ caps: { blockedByGql } });
  const ctx = {
    // a root of its own per test: detectCaps caches into <root>/.kanban/cache.json, and one
    // test's answer must not decide the next one's
    root: path.join(os.tmpdir(), `hkb-226-${process.pid}-${seq++}`),
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
  };
  const restore = gh.install();
  return { gh, ctx, cleanup: () => { restore(); fs.rmSync(ctx.root, { recursive: true, force: true }); } };
}

/** One card per lane, each blocked by a done card, so every fill-in has something to find. */
function seed(gh) {
  gh.addIssue(kbIssue({ number: 1, status: 'done', state: 'CLOSED' }));
  for (const [n, status] of [[10, 'triage'], [11, 'ready'], [12, 'todo'], [13, 'blocked'], [14, 'in-progress'], [15, 'review']]) {
    gh.addIssue(kbIssue({ number: n, status, blockedBy: [1] }));
  }
  return [10, 11, 12, 13, 14, 15];
}

const depCalls = (gh) => gh.callsMatching('GET', /dependencies\/blocked_by/).map((c) => Number(/issues\/(\d+)\//.exec(c.path)[1])).sort((a, b) => a - b);
const withBlockers = (tasks) => tasks.filter((t) => t.blockedBy.length).map((t) => t.number).sort((a, b) => a - b);

test("blockers: 'all' REST-fills every open card when GraphQL has no blockedBy", async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    const open = seed(gh);
    const tasks = await fetchBoard(ctx, { blockers: 'all' });
    assert.deepEqual(depCalls(gh), open);
    assert.deepEqual(withBlockers(tasks), open);
    assert.deepEqual(blockersOf(tasks), { source: 'rest', filled: true, scope: 'open' });
  } finally { cleanup(); }
});

test('blockers: true still fills todo and blocked only — unchanged behaviour', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    seed(gh);
    const tasks = await fetchBoard(ctx, { blockers: true });
    assert.deepEqual(depCalls(gh), [12, 13]);
    assert.deepEqual(withBlockers(tasks), [12, 13]);
    assert.deepEqual(blockersOf(tasks), { source: 'rest', filled: true, scope: 'waiting' });
  } finally { cleanup(); }
});

test('blockers: true is the default, and blockers: false asks for nothing', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    seed(gh);
    const dflt = await fetchBoard(ctx);
    assert.deepEqual(depCalls(gh), [12, 13]);
    assert.equal(blockersOf(dflt).scope, 'waiting');

    gh.calls.length = 0;
    const none = await fetchBoard(ctx, { blockers: false });
    assert.deepEqual(depCalls(gh), []);
    assert.deepEqual(withBlockers(none), []);
    assert.deepEqual(blockersOf(none), { source: null, filled: false, scope: 'none' });
  } finally { cleanup(); }
});

test("a repo with GraphQL blockedBy makes no extra request for 'all'", async () => {
  const { gh, ctx, cleanup } = harness({ blockedByGql: true });
  try {
    const open = seed(gh);
    const tasks = await fetchBoard(ctx, { blockers: 'all' });
    assert.deepEqual(depCalls(gh), []);
    // the capability probe plus exactly one board query, and nothing else
    assert.equal(gh.calls.filter((c) => c.kind === 'graphql').length, 2);
    assert.equal(gh.calls.filter((c) => c.kind !== 'graphql').length, 0);
    assert.deepEqual(withBlockers(tasks), open);
    assert.deepEqual(blockersOf(tasks), { source: 'graphql', filled: true, scope: 'all' });
  } finally { cleanup(); }
});

test('the blocker provenance never leaks into the board as a task', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    seed(gh);
    const tasks = await fetchBoard(ctx, { blockers: 'all' });
    assert.equal(Array.isArray(tasks), true);
    assert.equal(tasks.length, 6);
    assert.equal([...tasks].length, 6);
    assert.equal(JSON.parse(JSON.stringify(tasks)).length, 6);
    assert.equal(Object.keys(tasks).includes('blockers'), false);
    assert.deepEqual(blockersOf([]), { source: null, filled: false, scope: 'none' });
  } finally { cleanup(); }
});

test('blockersKnown tells an empty list apart from a list nobody read', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 20, status: 'triage' })); // genuinely no blockers
    gh.addIssue(kbIssue({ number: 21, status: 'todo' }));
    const byNumber = (tasks, n) => tasks.find((t) => t.number === n);

    const waiting = await fetchBoard(ctx, { blockers: true });
    assert.equal(blockersKnown(waiting, byNumber(waiting, 20)), false); // triage: never looked up
    assert.equal(blockersKnown(waiting, byNumber(waiting, 21)), true);

    const all = await fetchBoard(ctx, { blockers: 'all' });
    assert.equal(blockersKnown(all, byNumber(all, 20)), true); // now it really is "no blockers"
    assert.equal(blockersKnown(all, byNumber(all, 21)), true);

    const none = await fetchBoard(ctx, { blockers: false });
    assert.equal(blockersKnown(none, byNumber(none, 21)), false);
    assert.equal(blockersKnown([], { number: 20, status: 'todo' }), false);
  } finally { cleanup(); }
});

test('blockersKnown is true for every card on a GraphQL repo, closed ones included', async () => {
  const { gh, ctx, cleanup } = harness({ blockedByGql: true });
  try {
    gh.addIssue(kbIssue({ number: 30, status: 'done', state: 'CLOSED' }));
    gh.addIssue(kbIssue({ number: 31, status: 'triage' }));
    const tasks = await fetchBoard(ctx, { includeClosed: true, blockers: 'all' });
    for (const t of tasks) assert.equal(blockersKnown(tasks, t), true);
  } finally { cleanup(); }
});

test('doctor names the REST-fill cost when the GraphQL field is absent', () => {
  const results = [];
  const ok = (name, detail) => results.push({ name, ok: true, detail });
  const warn = (name, detail, fix) => results.push({ name, ok: null, detail, fix });

  checkGroomBlockers({}, { ok, warn }, { caps: { blockedByGql: false }, board: { tasks: [{}, {}, {}] } });
  assert.equal(results[0].name, GROOM_BLOCKERS_CHECK);
  assert.equal(results[0].ok, null);
  assert.match(results[0].detail, /hkb groom/);
  assert.match(results[0].detail, /3 REST calls — one per open card/);

  results.length = 0;
  checkGroomBlockers({}, { ok, warn }, { caps: { blockedByGql: false }, board: { error: 'boom' } });
  assert.match(results[0].detail, /one REST call per open card/);

  results.length = 0;
  checkGroomBlockers({}, { ok, warn }, { caps: { blockedByGql: true }, board: { tasks: [] } });
  assert.equal(results[0].ok, true);
  assert.match(results[0].detail, /no extra request/);
});
