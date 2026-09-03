// What the review of #326 found, once every verb was reading the board through `openStore`.
//
// One file rather than a scattering, because the findings share a cause: routing the verbs made the
// *store* answer questions the GitHub driver used to answer inline, and each of these is a place
// where the two answers were not the same. They are grouped by the thing they protect — what a card
// closes as, what a create costs, what a tick costs, what a human reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archive, createTask } from '../src/lifecycle.js';
import { blockerDone, computeReady } from '../src/model.js';
import { FakeGh, kbIssue } from './fake-gh.js';

function harness() {
  const gh = new FakeGh();
  const ctx = {
    root: '/tmp/nonexistent',
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    cfg: { profiles: { claude: {} } },
    _cache: {},
  };
  return { gh, ctx, cleanup: gh.install() };
}

// ---------- what a card closes as ----------

test('archiving a done card closes it completed, so what it blocked can still move', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 10, status: 'done', agent: 'claude' }));
    await archive(ctx, 10);
    // `setStatus(task, 'archived')` updates the task in place, so the status the next line tested
    // was always 'archived' and every archived card closed NOT_PLANNED — including one that had
    // been finished. `blockerDone` rejects NOT_PLANNED, so this is not cosmetic.
    assert.equal(gh.issues.get(10).stateReason, 'COMPLETED');
    assert.equal(gh.issues.get(10).state, 'CLOSED');
  } finally { cleanup(); }
});

test('archiving a card that was not done still closes it not_planned', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 11, status: 'todo', agent: 'claude' }));
    await archive(ctx, 11);
    assert.equal(gh.issues.get(11).stateReason, 'NOT_PLANNED');
  } finally { cleanup(); }
});

test('a card blocked by an archived-done card is ready; one blocked by an abandoned card is not', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 20, status: 'done', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 21, status: 'todo', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 22, status: 'todo', agent: 'claude', blockedBy: [20] }));
    gh.addIssue(kbIssue({ number: 23, status: 'todo', agent: 'claude', blockedBy: [21] }));
    await archive(ctx, 20); // finished, then filed away
    await archive(ctx, 21); // abandoned

    const closedAs = (n) => ({ state: gh.issues.get(n).state, stateReason: gh.issues.get(n).stateReason, status: 'archived' });
    assert.equal(blockerDone(closedAs(20)), true, 'a finished card filed away is still finished');
    assert.equal(blockerDone(closedAs(21)), false, 'an abandoned one is not');

    // and on the board itself — `computeReady` is what the dispatcher asks before it picks a card,
    // and it reads the blocker's close reason off the very field `archive` writes. #22 was stuck in
    // `todo` forever, because its blocker had been finished and then closed as if it never was.
    const { openStore } = await import('../src/store/index.js');
    const store = await openStore(ctx);
    assert.equal(computeReady(await store.getTask(22)), true, 'its blocker is done, so #22 can run');
    assert.equal(computeReady(await store.getTask(23)), false, 'its blocker was abandoned, so #23 stays put');
  } finally { cleanup(); }
});

// ---------- what a create costs ----------

/** Every `GET /pulls?state=open…` the fake saw — the listing `fillPrFallback` spends. */
function prListings(gh) {
  return gh.requests.filter((c) => /\/pulls\?/.test(String(c.path || c.url || '')));
}

test('one create is one open-PR listing, not one per card it names as a blocker', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 1, status: 'done', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 2, status: 'done', agent: 'claude' }));
    gh.addIssue(kbIssue({ number: 3, status: 'done', agent: 'claude' }));
    const before = prListings(gh).length;
    await createTask(ctx, { title: 'a card with three blockers', parents: [1, 2, 3] });
    const spent = prListings(gh).length - before;
    // `fillPrFallback`'s own docstring: "One request per tick, never one per card" (#234). Its
    // callers are `listTasks` *and* `getTask`, and a create reads four cards — so without the memo
    // this was four listings, each up to ten paginated pages.
    assert.ok(spent <= 1, `one create spent ${spent} open-PR listings`);
  } finally { cleanup(); }
});

test('the open-PR listing is memoized per context, and a failed one is not remembered', async () => {
  const { gh, ctx, cleanup } = harness();
  try {
    gh.addIssue(kbIssue({ number: 5, status: 'ready', agent: 'claude' }));
    const { openStore } = await import('../src/store/index.js');
    const store = await openStore(ctx);
    await store.getTask(5);
    const after = prListings(gh).length;
    await store.getTask(5);
    assert.equal(prListings(gh).length, after, 'a second read of the same card asks again for nothing');

    // The dispatcher clears it at the top of every tick, so a loop never judges a card on last
    // tick's listing. That is the property; here it is enough that the key is what gets dropped.
    const { dropCommentCaches } = await import('../src/dispatch.js');
    dropCommentCaches(ctx);
    assert.equal(ctx._cache.prsByHead, undefined, 'a new tick re-reads the listing');
  } finally { cleanup(); }
});
