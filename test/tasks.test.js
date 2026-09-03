// fetchBoard's blocker fill-in (#226): who gets one, where the lists came from, and what an
// empty list means. `hkb groom` reports on every open card, so it needs `blockers: 'all'`; the
// tick still needs only todo/blocked, and neither may cost a request on a repo whose GraphQL
// answers blockedBy in the board query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchBoard, getTask, blockersOf, blockersKnown, branchFallbackPrs, openPrsByHead } from '../src/tasks.js';
import { trackBranchName } from '../src/model.js';
import { GROOM_BLOCKERS_CHECK, checkGroomBlockers } from '../src/doctor.js';
import { GhError, setTransport } from '../src/gh.js';
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

const depCalls = (gh) => gh.requestsMatching('GET', /dependencies\/blocked_by/).map((c) => Number(/issues\/(\d+)\//.exec(c.path)[1])).sort((a, b) => a - b);
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

    gh.requests.length = 0;
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
    // the capability probe plus exactly one board query for blockers, and nothing else — the PR
    // head-branch fallback still costs its one board-wide read, since none of these cards have a PR
    assert.equal(gh.requests.filter((c) => c.kind === 'graphql').length, 2);
    assert.deepEqual(gh.requests.filter((c) => c.kind !== 'graphql').map((c) => c.path), ['repos/acme/board/pulls?state=open&per_page=100&page=1']);
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

test('a missing issue number is notfound (exit 2), not a network error a terminal verb would queue forever (#141)', async () => {
  const ctx = {
    root: path.join(os.tmpdir(), `hkb-141-${process.pid}-${seq++}`),
    repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
  };
  const restore = setTransport((req) => {
    if (req.kind !== 'graphql') throw new Error(`unexpected ${req.kind} call`);
    if (/__type\(name:\s*"Issue"\)/.test(req.query)) return { __type: { fields: [{ name: 'number' }, { name: 'title' }, { name: 'labels' }] } };
    if (/issue\(number:/.test(req.query)) {
      // what `gh api graphql` reports for an issue number that does not exist: HTTP 200, no
      // status line, an `errors` entry classify() must read as notfound, not network (#141)
      throw new GhError('GraphQL failed (0): Could not resolve to an Issue with the number of 999999.', { status: 0, kind: 'notfound', path: 'graphql' });
    }
    throw new Error(`unexpected query: ${req.query}`);
  });
  try {
    await assert.rejects(getTask(ctx, 999999), (e) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /issue #999999 not found in acme\/board/);
      assert.notEqual(e.kind, 'network'); // never something `withOutbox` would queue for replay
      return true;
    });
  } finally {
    restore();
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

// ---------- the head-branch fallback (#234) ----------
//
// closedByPullRequestsReferences only links a PR that targets the default branch, and #228 showed
// it can come back empty even then. hkb hands its own work a branch name it chose itself
// (kb/<n>, kb-<n>-<k>, worktree-kb-<n>-<k>), so a PR whose head is one of those is this card's PR
// whatever GitHub's own linking believes.

test('getTask falls back to a PR by head branch when GitHub links nothing — a non-default base, #227\'s exact shape', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 227, status: 'running' })); // no prs: seeded — closedByPullRequestsReferences answers []
    gh.addPull({ number: 232, head: 'kb/227', base: 'kb/191-wave1' }); // an intermediate branch, not main
    const task = await getTask(ctx, 227);
    assert.equal(task.prs.length, 1);
    assert.equal(task.prs[0].number, 232);
    assert.equal(task.prs[0].baseRefName, 'kb/191-wave1');
    assert.equal(task.prs[0].state, 'OPEN');
  } finally { cleanup(); }
});

test('getTask falls back for a child PR based on the track branch — #245: every child PRs into `kb/track-<root>`, whatever its blockers', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 227, status: 'running' })); // a child of track #191, blocked by two siblings
    gh.addPull({ number: 232, head: 'kb/227', base: trackBranchName(191) }); // the track's own integration branch
    const task = await getTask(ctx, 227);
    assert.equal(task.prs.length, 1);
    assert.equal(task.prs[0].number, 232);
    assert.equal(task.prs[0].baseRefName, 'kb/track-191');
    assert.equal(task.prs[0].state, 'OPEN');
  } finally { cleanup(); }
});

test('getTask falls back for a worktree-kb-<n>-<k> head even against the default branch — #228\'s symptom', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 228, status: 'running' }));
    gh.addPull({ number: 233, head: 'worktree-kb-228-1', base: gh.defaultBranch });
    const task = await getTask(ctx, 228);
    assert.equal(task.prs.length, 1);
    assert.equal(task.prs[0].number, 233);
  } finally { cleanup(); }
});

test('getTask never overrides a PR GitHub already linked', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 40, status: 'running', prs: [{ number: 41, state: 'OPEN', isDraft: true, headRefName: 'kb/40', baseRefName: gh.defaultBranch }] }));
    gh.addPull({ number: 999, head: 'kb/40', base: 'some-other-branch' }); // would also match by head
    const task = await getTask(ctx, 40);
    assert.deepEqual(task.prs.map((p) => p.number), [41]);
  } finally { cleanup(); }
});

test('getTask reports no PR for a card whose only open PRs belong to other cards', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 50, status: 'running' }));
    gh.addPull({ number: 51, head: 'kb/51', base: gh.defaultBranch }); // somebody else's card
    const task = await getTask(ctx, 50);
    assert.deepEqual(task.prs, []);
  } finally { cleanup(); }
});

test('fetchBoard applies the same fallback board-wide, in one extra request', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 60, status: 'running' }));
    gh.addIssue(kbIssue({ number: 61, status: 'running' }));
    gh.addPull({ number: 70, head: 'kb-60-1', base: 'kb/191-wave1' });
    const tasks = await fetchBoard(ctx);
    const pullCalls = gh.requests.filter((c) => c.kind === 'rest' && /\/pulls\?/.test(c.path || ''));
    assert.equal(pullCalls.length, 1, 'one board-wide read, not one per card');
    const t60 = tasks.find((t) => t.number === 60);
    const t61 = tasks.find((t) => t.number === 61);
    assert.equal(t60.prs[0]?.number, 70);
    assert.deepEqual(t61.prs, []);
  } finally { cleanup(); }
});

test('fetchBoard skips the fallback request entirely when every card already has its PR', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 62, status: 'running', prs: [{ number: 63, state: 'OPEN', isDraft: false, headRefName: 'kb/62', baseRefName: gh.defaultBranch }] }));
    await fetchBoard(ctx);
    assert.equal(gh.requests.filter((c) => c.kind === 'rest' && /\/pulls\?/.test(c.path || '')).length, 0);
  } finally { cleanup(); }
});

test('branchFallbackPrs: pure — never touches a task that already has a PR', () => {
  const withPr = { number: 1, prs: [{ number: 2 }] };
  assert.deepEqual(branchFallbackPrs(withPr, new Map([['kb/1', { number: 99 }]])), [{ number: 2 }]);
  const withoutPr = { number: 1, prs: [] };
  assert.deepEqual(branchFallbackPrs(withoutPr, new Map([['kb/1', { number: 99 }]])), [{ number: 99 }]);
  assert.deepEqual(branchFallbackPrs(withoutPr, new Map([['kb/2', { number: 98 }]])), []);
});

test('openPrsByHead pages through every open PR the repo has', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    for (let i = 0; i < 150; i++) gh.addPull({ number: 1000 + i, head: `kb/${1000 + i}` });
    const byHead = await openPrsByHead(ctx);
    assert.equal(byHead.size, 150);
    assert.equal(byHead.get('kb/1149').number, 1149);
  } finally { cleanup(); }
});
