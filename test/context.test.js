// The worker brief (`hkb context <n>`), and in particular its `## Comments` section — the channel a
// human steers a card through. The selection and rendering are pure; the last test runs the whole
// `workerContext` against the in-memory GitHub (test/fake-gh.js) to prove a plain `hkb comment`
// reaches the next attempt and that hkb's own records do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workerContext, selectComments, formatComments, isHumanComment, briefIntents, capabilityLine, mcpLine } from '../src/context.js';
import { openStore } from '../src/store/index.js';
import { CAPABILITIES, RUN_MARKER, RESULT_MARKER, serializeResultComment, serializeRunComment } from '../src/model.js';
import { FakeGh } from './fake-gh.js';
import { FakeStore, kbIssue, runWith } from './fake-store.js';

const NOW = new Date('2026-08-26T12:00:00Z');
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

let nextId = 1;
/** A REST issue comment in the shape `listComments` returns. */
const c = (body, { login = 'operator', minutesAgo = 0 } = {}) => ({ id: nextId++, body, user: { login }, created_at: at(minutesAgo) });

test('machine comments are not steering input', () => {
  assert.equal(isHumanComment(c('use the v2 endpoint')), true);
  assert.equal(isHumanComment(c(serializeRunComment(runWith([{ attempt: 1 }])))), false);
  assert.equal(isHumanComment(c(serializeResultComment({ kind: 'result', attempt: 1, summary: 'done' }))), false);
  assert.equal(isHumanComment(c('**Blocked** (needs_input, attempt 1): no credentials')), false);
  assert.equal(isHumanComment(c('**Changes requested** (after attempt 2): rename the flag')), false);
  // a human writing *about* being blocked is not the dispatcher's line
  assert.equal(isHumanComment(c('**Blocked** on the upstream release, ignore for now')), true);
  assert.equal(isHumanComment(c('   ')), false);
  assert.equal(isHumanComment({ body: null }), false);
});

test('markers are matched wherever hkb writes them', () => {
  assert.equal(isHumanComment(c(`${RUN_MARKER}\nanything`)), false);
  assert.equal(isHumanComment(c(`${RESULT_MARKER}\nanything`)), false);
  // quoting a marker mid-comment is still a human talking
  assert.equal(isHumanComment(c(`the run record (${RUN_MARKER}) looks wrong`)), true);
});

test('selection: everything since the last ended attempt, plus always the last five', () => {
  const comments = [
    c('one', { minutesAgo: 100 }),
    c('two', { minutesAgo: 90 }),
    c('three', { minutesAgo: 80 }),
    c('four', { minutesAgo: 70 }),
    c('five', { minutesAgo: 60 }),
    c('six', { minutesAgo: 50 }),
    c('seven — after the attempt ended', { minutesAgo: 20 }),
  ];
  const run = runWith([{ attempt: 1, started_at: at(120), ended_at: at(40), outcome: 'blocked' }]);
  const picked = selectComments(comments, run);
  assert.deepEqual(picked.map((x) => x.body), ['three', 'four', 'five', 'six', 'seven — after the attempt ended']);
  // oldest first, and the fresh one is last
  assert.equal(picked[picked.length - 1].body, 'seven — after the attempt ended');
});

test('selection: with no ended attempt every human comment is fresh', () => {
  const comments = [c('a', { minutesAgo: 300 }), c('b', { minutesAgo: 200 }), c('c', { minutesAgo: 100 })];
  assert.deepEqual(selectComments(comments, runWith([{ attempt: 1, started_at: at(10) }])).map((x) => x.body), ['a', 'b', 'c']);
  assert.deepEqual(selectComments(comments, null).map((x) => x.body), ['a', 'b', 'c']);
});

test('selection: the last ended attempt wins, and machine comments never count toward the five', () => {
  const comments = [
    c('old note', { minutesAgo: 300 }),
    c(serializeRunComment(runWith([{ attempt: 1 }])), { login: 'hkb', minutesAgo: 250 }),
    c('**Blocked** (transient, attempt 1): flaky', { login: 'hkb', minutesAgo: 240 }),
    c('n1', { minutesAgo: 200 }),
    c('n2', { minutesAgo: 190 }),
    c('n3', { minutesAgo: 180 }),
    c('n4', { minutesAgo: 170 }),
    c('n5', { minutesAgo: 160 }),
  ];
  const run = runWith([
    { attempt: 1, started_at: at(320), ended_at: at(260), outcome: 'blocked' },
    { attempt: 2, started_at: at(150), ended_at: at(100), outcome: 'failed' },
  ]);
  // nothing is newer than attempt 2's end, so exactly the last five human comments survive
  assert.deepEqual(selectComments(comments, run).map((x) => x.body), ['n1', 'n2', 'n3', 'n4', 'n5']);
});

test('rendering: attribution, relative time, oldest first', () => {
  const out = formatComments([
    c('use the v2 endpoint', { login: 'alice', minutesAgo: 180 }),
    c('and skip the migration', { login: 'bob', minutesAgo: 5 }),
  ], { now: NOW });
  assert.equal(out, [
    '**@alice** · 3h ago',
    'use the v2 endpoint',
    '',
    '**@bob** · 5m ago',
    'and skip the migration',
  ].join('\n'));
});

test('rendering: relative times, and an unknown author', () => {
  assert.match(formatComments([c('x', { minutesAgo: 0 })], { now: NOW }), /· just now/);
  assert.match(formatComments([c('x', { minutesAgo: 45 })], { now: NOW }), /· 45m ago/);
  assert.match(formatComments([c('x', { minutesAgo: 60 * 26 })], { now: NOW }), /· 26h ago/);
  assert.match(formatComments([c('x', { minutesAgo: 60 * 24 * 9 })], { now: NOW }), /· 9d ago/);
  assert.match(formatComments([{ id: 1, body: 'x', user: null, created_at: null }], { now: NOW }), /^\*\*@unknown\*\* · unknown time$/m);
  assert.equal(formatComments([], { now: NOW }), null);
});

test('rendering: the cap keeps the newest and says what it dropped', () => {
  const comments = [];
  for (let i = 0; i < 12; i++) comments.push(c(`note ${i} ` + 'x'.repeat(300), { login: 'alice', minutesAgo: 100 - i }));
  const out = formatComments(comments, { now: NOW, limit: 2000 });
  assert.ok(out.length <= 2000 + 30, `section is ${out.length} chars`);
  assert.match(out, /^_\(earlier comments elided\)_$/m);
  assert.ok(out.includes('note 11'), 'the newest comment survives');
  assert.ok(!out.includes('note 0 '), 'the oldest is dropped');
  // what survives is a contiguous newest-first run, still rendered oldest first
  const kept = [...out.matchAll(/note (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(kept, [...kept].sort((a, b) => a - b));
  assert.equal(kept[kept.length - 1], 11);
});

test('rendering: one oversized comment is clipped, not dropped', () => {
  const out = formatComments([c('start ' + 'y'.repeat(5000), { login: 'alice', minutesAgo: 1 })], { now: NOW, limit: 2000 });
  assert.ok(out.length <= 2000, `section is ${out.length} chars`);
  assert.match(out, /^\*\*@alice\*\* · just now$/m);
  assert.ok(out.includes('start yyy'));
  assert.match(out, /… \(comment truncated\)$/);
  assert.ok(!out.includes('earlier comments elided'), 'nothing earlier existed to elide');
});

// ---------- the whole brief ----------

function harness() {
  const gh = new FakeGh();
  const store = new FakeStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-context-'));
  const ctx = {
    root,
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default',
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
  };
  const restore = gh.install();
  const restoreStore = store.install(ctx);
  return { gh, store, ctx, cleanup: () => { restoreStore(); restore(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** FakeGh stamps every comment with its own login and time; a real thread has neither. */
/** The card, read the way every verb reads one. */
const card = async (ctx, n) => (await openStore(ctx)).getTask(n);

function say(store, number, body, { login = 'operator', minutesAgo = 0 } = {}) {
  const comment = store.addComment(number, body);
  comment.user = { login };
  comment.created_at = at(minutesAgo);
  return comment;
}

test('workerContext surfaces the thread and hides hkb\'s own records', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({
    number: 42,
    title: 'wire the client',
    status: 'ready',
    agent: 'claude',
    run: runWith([{ attempt: 1, started_at: at(300), ended_at: at(200), outcome: 'blocked', reason: 'no token' }]),
  }));
  say(h.store, 42, 'use the v2 endpoint', { login: 'alice', minutesAgo: 120 });
  say(h.store, 42, '**Blocked** (needs_input, attempt 1): no token', { login: 'hkb', minutesAgo: 199 });
  say(h.store, 42, serializeResultComment({ kind: 'result', attempt: 1, summary: 'half done' }), { login: 'hkb', minutesAgo: 198 });
  say(h.store, 42, 'token is in the vault now', { login: 'bob', minutesAgo: 3 });

  const before = h.store.calls.length;
  const task = await card(h.ctx, 42);
  const out = await workerContext(h.ctx, task);

  assert.match(out, /## Comments/);
  const section = out.slice(out.indexOf('## Comments'), out.indexOf('## Protocol (hkb)'));
  assert.match(section, /\*\*@alice\*\* · .*\nuse the v2 endpoint/);
  assert.match(section, /\*\*@bob\*\* · .*\ntoken is in the vault now/);
  assert.ok(!section.includes('**Blocked**'), 'the dispatcher\'s Blocked line is not repeated in Comments');
  assert.ok(!section.includes('half done'), 'the result comment is not repeated in Comments');
  assert.ok(!out.includes(RUN_MARKER), 'the run record never reaches the prompt');
  assert.match(out, /- attempt 1 \(claude\): \*\*blocked\*\* — no token/); // still on the attempts table
  // the section sits between the attempts table and the protocol, so the protocol still ends the brief
  assert.ok(out.indexOf('## Comments') > out.indexOf('## Prior attempts on this task'));
  assert.ok(out.indexOf('## Comments') < out.indexOf('## Protocol (hkb)'));
  // ordering: oldest first
  assert.ok(out.indexOf('use the v2 endpoint') < out.indexOf('token is in the vault now'));

  // one thread read, shared with the run record and the result lookup
  const reads = h.store.calls.slice(before).filter((c) => c.name === 'listNotes');
  assert.equal(reads.length, 1, `expected one thread read, got ${reads.length}`);
});

test('workerContext has no Comments section when nobody has said anything', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  say(h.store, 7, serializeRunComment(runWith([{ attempt: 1, started_at: at(10) }])), { login: 'hkb', minutesAgo: 10 });
  const out = await workerContext(h.ctx, await card(h.ctx, 7));
  assert.ok(!out.includes('## Comments'));
  assert.match(out, /## Protocol \(hkb\)/);
});

// ---------- continuing a PR the reviewer sent back (#153) ----------

/** A card in the shape `hkb request-changes` leaves behind: open PR, reviewer row on top. */
function sentBack({ number = 42, pr = 147, branch = 'worktree-kb-42-1', base = 'main' } = {}) {
  return kbIssue({
    number,
    title: 'wire the client',
    status: 'ready',
    agent: 'claude',
    run: runWith([
      { attempt: 1, started_at: at(300), ended_at: at(200), outcome: 'review_requested', summary: 'ready for review', pr },
      { attempt: 2, profile: 'reviewer', started_at: at(20), ended_at: at(20), outcome: 'changes_requested', reason: 'rename the flag', synthetic: true },
    ]),
    prs: [{ number: pr, state: 'OPEN', isDraft: true, headRefName: branch, baseRefName: base }],
  });
}

test('the brief tells a continuing worker which PR to push to, and not to open a second', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(sentBack());

  const out = await workerContext(h.ctx, await card(h.ctx, 42), 3);

  assert.match(out, /^## Continue PR #147 — do not open a second one$/m);
  assert.match(out, /PR #147 \(branch `worktree-kb-42-1`\) is open with \*\*changes requested\*\*/);
  assert.match(out, /git fetch origin main && git merge origin\/main/);
  assert.match(out, /Do \*\*not\*\* run `gh pr create`/);
  // and the standing "rebase before you finish" line, which would need the force-push it forbids
  assert.match(out, /Before finishing: merge `origin\/main` in \(never rebase: this branch is already pushed\)/);
  // and the two protocol lines that would otherwise send it to a fresh branch and a new PR
  assert.match(out, /PR #147 already exists and already closes #42 — push to its branch \(`worktree-kb-42-1`\)/);
  assert.doesNotMatch(out, /gh pr create --draft --fill/);
  // the block is near the top: above the attempts it refers to, and above the protocol
  assert.ok(out.indexOf('## Continue PR #147') < out.indexOf('## Prior attempts on this task'));
  // the fresh-worktree recipe, because the dispatcher did not say it had checked the branch out
  assert.match(out, /git fetch origin worktree-kb-42-1 && git reset --hard FETCH_HEAD/);
  assert.match(out, /Work only in this worktree, on the branch of the PR you are continuing/);
});

test('a checkout the dispatcher already put on the PR branch is said so, once', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(sentBack());

  const out = await workerContext(h.ctx, await card(h.ctx, 42), 3, {
    continuePr: { number: 147, branch: 'worktree-kb-42-1', base: 'main', checkedOut: true },
  });

  assert.match(out, /already checked out on `worktree-kb-42-1`, so an ordinary `git push` updates PR #147/);
  assert.match(out, /Work only in this worktree — it is already checked out on `worktree-kb-42-1`, PR #147's branch\./);
  assert.doesNotMatch(out, /git reset --hard FETCH_HEAD/, 'the branch is already there: no recipe for taking it');
});

test('a checkout that could not be fast-forwarded gets the catch-up recipe, not a false "already there"', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(sentBack());

  const out = await workerContext(h.ctx, await card(h.ctx, 42), 3, {
    continuePr: { number: 147, branch: 'worktree-kb-42-1', base: 'main', checkedOut: false, stale: 'could not fast-forward to origin/worktree-kb-42-1: exit 1' },
  });

  assert.doesNotMatch(out, /already checked out on `worktree-kb-42-1`, so an ordinary `git push`/, 'a stale checkout must not claim to be at the PR head');
  assert.match(out, /checked out on `worktree-kb-42-1`, but it could not be fast-forwarded to the PR's remote head \(could not fast-forward to origin\/worktree-kb-42-1: exit 1\)/);
  assert.match(out, /git fetch origin worktree-kb-42-1 && git reset --hard origin\/worktree-kb-42-1/);
});

test('a long reviewer note reaches the brief whole, not cut at 400 chars', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const longReason = 'item 1: fix the retry loop. '.repeat(60).trim(); // > 1500 chars
  assert.ok(longReason.length > 1500);
  h.store.addIssue(kbIssue({
    number: 42,
    title: 'wire the client',
    status: 'ready',
    agent: 'claude',
    run: runWith([
      { attempt: 1, started_at: at(300), ended_at: at(200), outcome: 'review_requested', summary: 'ready for review', pr: 147 },
      { attempt: 2, profile: 'reviewer', started_at: at(20), ended_at: at(20), outcome: 'changes_requested', reason: longReason, synthetic: true },
    ]),
    prs: [{ number: 147, state: 'OPEN', isDraft: true, headRefName: 'worktree-kb-42-1', baseRefName: 'main' }],
  }));

  const out = await workerContext(h.ctx, await card(h.ctx, 42), 3);

  assert.ok(out.includes(longReason), 'the full reviewer note must be in the brief, not truncated');
});

test('an ordinary card gets no continuation block, open PR or not', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  // an open PR with no reviewer row on top is the active_pr guard's business, not a continuation
  h.store.addIssue(kbIssue({
    number: 43,
    status: 'ready',
    agent: 'claude',
    run: runWith([{ attempt: 1, started_at: at(300), ended_at: at(200), outcome: 'review_requested' }]),
    prs: [{ number: 148, state: 'OPEN', isDraft: true, headRefName: 'worktree-kb-43-1' }],
  }));
  h.store.addIssue(kbIssue({ number: 44, status: 'ready', agent: 'claude' }));

  for (const n of [43, 44]) {
    const out = await workerContext(h.ctx, await card(h.ctx, n));
    assert.ok(!out.includes('do not open a second one'), `#${n}`);
    assert.match(out, /Work only in this worktree, on the current branch\./);
    assert.match(out, /Before finishing: rebase on the default branch/);
    assert.match(out, /gh pr create --draft --fill/);
  }
});

test('the protocol asks for a finishing command a shell-vetting harness will run (#125)', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  const out = await workerContext(h.ctx, await card(h.ctx, 7));
  // `complete` is a bash builtin and a heredoc is refused outright in a worktree-isolated Claude Code
  // session, so neither may appear in the one command the worker is told to end with.
  assert.match(out, /hkb finish 7 --from-stdin < \/tmp\/kb-7\.json/);
  assert.doesNotMatch(out, /hkb complete 7/);
  assert.doesNotMatch(out, /--from-stdin <<'EOF'/, 'no command in the prompt may be a heredoc');
  // and it says why, so a worker that reads only this prompt knows which spelling to type
  assert.match(out, /`finish` is `complete`/);
});

// ---------- capabilities: the intent travels, the binding is local (#260) ----------

/** Give the harness's ctx a board config, since a bare `hkb context` run has none. */
function withProfiles(ctx, profiles) {
  ctx.cfg = { ...(ctx.cfg || {}), profiles };
  return ctx;
}

test('briefIntents is derived from the card, never from a command name', () => {
  assert.deepEqual(briefIntents({ kb: {} }), []);
  assert.deepEqual(briefIntents({ kb: { goal: 'it works' } }), ['goal']);
  assert.deepEqual(briefIntents({ kb: {} }, { cont: { number: 147 } }), ['review']);
  assert.deepEqual(briefIntents({ kb: { goal: 'it works' } }, { cont: { number: 147 } }), ['goal', 'review']);
  // `specify` happens before a card is dispatched: no worker brief ever triggers it
  assert.ok(!briefIntents({ kb: { goal: 'g' } }, { cont: { number: 1 } }).includes('specify'));
});

test('capabilityLine names the board\'s own string, and is null for anything unbound', () => {
  const p = { capabilities: { goal: '::state-the-outcome' } };
  assert.match(capabilityLine(p, 'goal'), /^On this harness that is `::state-the-outcome` — /);
  assert.equal(capabilityLine(p, 'review'), null, 'an unbound intent is prose, not an error');
  assert.equal(capabilityLine({}, 'goal'), null);
  assert.equal(capabilityLine(null, 'goal'), null);
  assert.equal(capabilityLine({ capabilities: { goal: '/g' } }, 'not-an-intent'), null);
});

test('a card whose profile binds `goal` has the bound command named beside the acceptance criteria', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 9, status: 'ready', agent: 'claude', kb: { goal: 'the client speaks v2' } }));
  withProfiles(h.ctx, { claude: { capabilities: { goal: '/goal' } } });

  const out = await workerContext(h.ctx, await card(h.ctx, 9));

  assert.match(out, /## Acceptance criteria\nthe client speaks v2\nOn this harness that is `\/goal` — state the outcome/);
});

test('an unmapped intent keeps today\'s prose, and a board with no capabilities gets a byte-identical brief', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 9, status: 'ready', agent: 'claude', kb: { goal: 'the client speaks v2' } }));

  const none = await workerContext(withProfiles(h.ctx, { claude: {} }), await card(h.ctx, 9));
  const noCfg = await workerContext({ ...h.ctx, cfg: undefined }, await card(h.ctx, 9));
  // a profile that binds a *different* intent must not leak into this card's brief either
  const other = await workerContext(withProfiles(h.ctx, { claude: { capabilities: { specify: '/specify' } } }), await card(h.ctx, 9));
  const bound = await workerContext(withProfiles(h.ctx, { claude: { capabilities: { goal: '/goal' } } }), await card(h.ctx, 9));

  assert.equal(none, noCfg, 'declaring no capabilities is byte-identical to having no board config at all');
  assert.equal(other, noCfg, 'an unbound intent renders nothing — no error, no warning, no extra line');
  assert.match(none, /## Acceptance criteria\nthe client speaks v2\n/, 'the heading stays');
  assert.ok(!none.includes('On this harness that is'));
  assert.notEqual(bound, none, 'and a binding does change the brief, or none of this is being read');
});

test('a continuation whose profile binds `review` is told what this harness calls it', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(sentBack());
  withProfiles(h.ctx, { claude: { capabilities: { review: '::second-look' } } });

  const out = await workerContext(h.ctx, await card(h.ctx, 42), 3);

  // hkb echoes the board's own string: it has no idea what a review command is called here
  assert.match(out, /Read what is already there before you change it\. On this harness that is `::second-look` — a second pass over work that already exists/);
  assert.ok(out.indexOf('::second-look') > out.indexOf('## Continue PR #147'), 'the line belongs to the continuation block');
});

test('hkb names no harness command in a brief the board did not bind', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(sentBack());
  h.store.addIssue(kbIssue({ number: 9, status: 'ready', agent: 'claude', kb: { goal: 'the client speaks v2', skills: ['kanban'] } }));

  for (const n of [42, 9]) {
    const out = await workerContext(withProfiles(h.ctx, { claude: {} }), await card(h.ctx, n), 3);
    for (const cmd of ['/code-review', '/goal', '/specify', '/review']) {
      assert.ok(!out.includes(cmd), `#${n}: the brief must not name ${cmd} — hkb knows intents, boards know commands`);
    }
  }
  // the vocabulary itself carries meanings, never commands, so nothing hkb ships can leak one
  for (const [intent, meaning] of Object.entries(CAPABILITIES)) {
    assert.ok(!meaning.includes('/'), `CAPABILITIES.${intent} must be prose, not a command`);
  }
});

// ---------- #257: the brief says which MCP servers the worker has ----------

test('mcpLine: the answer is effectiveTools\', rendered — a whitelist, a subtraction, or nothing', () => {
  const card = { kb: {} };
  assert.equal(mcpLine({ allowed_tools: ['Read'] }, card), null, 'a board that says nothing about MCP gets no line');
  assert.equal(mcpLine(null, card), null);

  assert.match(mcpLine({ mcp: ['react-aria'], allowed_tools: ['Read'] }, card),
    /^MCP servers available to you: `react-aria`\. Any other MCP server is denied/);
  assert.match(mcpLine({ mcp: [], allowed_tools: ['Read'] }, card), /^MCP: no MCP server is available to you\./);

  assert.equal(mcpLine({ tools: 'inherit', allowed_tools: ['Read'] }, card),
    'MCP: you inherit this session\'s MCP servers.');
  assert.match(mcpLine({ tools: 'inherit', mcp: ['supabase'], allowed_tools: ['Read'] }, card),
    /^MCP: you inherit this session's MCP servers — except `supabase`, which this board withholds/);
});

test('mcpLine: a card\'s own narrowing is already in the line, not recomputed beside it', () => {
  const profile = { mcp: ['react-aria', 'figma'], allowed_tools: ['Read'] };
  assert.match(mcpLine(profile, { kb: { mcp: ['react-aria'] } }), /available to you: `react-aria`\./);
  assert.match(mcpLine(profile, { kb: {} }), /available to you: `react-aria`, `figma`\./);
});

test('the brief names the servers a curate board gave this worker, and stays silent otherwise', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 9, status: 'ready', agent: 'claude', kb: { goal: 'ship the panel' } }));

  const silent = await workerContext(withProfiles(h.ctx, { claude: { allowed_tools: ['Read'] } }), await card(h.ctx, 9));
  const named = await workerContext(withProfiles(h.ctx, { claude: { mcp: ['react-aria'], allowed_tools: ['Read'] } }), await card(h.ctx, 9));
  const withheld = await workerContext(withProfiles(h.ctx, { claude: { tools: 'inherit', mcp: ['supabase'], allowed_tools: ['Read'] } }), await card(h.ctx, 9));

  assert.ok(!silent.includes('MCP'), 'a board that declares no mcp and no posture gets the brief it got before');
  assert.match(named, /MCP servers available to you: `react-aria`\./);
  assert.match(withheld, /you inherit this session's MCP servers — except `supabase`/);
  // #130: the worker must be able to tell, rather than guess and stay quiet about it
  assert.match(named, /say so rather than guessing/);
});
