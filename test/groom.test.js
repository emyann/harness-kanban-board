// The arithmetic half of a triage review (#225 of track #191): one fixture case per GROOM_KINDS kind,
// the false positives the adversarial pass named, and the proof that groomBoard is a pure function of
// one array. Nothing here touches the network, the clock or `ctx` — if it ever needs to, the design broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROOM_KINDS, GROOM_LEVELS, GROOM_ACTIONS, GROOM_SHORTLISTS,
  blocksIndex, ageDays, specShape, cardMentions, pathHubs, pathJaccard, proposeAction, groomBoard,
  DEFAULT_KB,
} from '../src/model.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');

/** A board card in `fetchBoard` shape. Everything not named falls back to a plausible default. */
function card(number, over = {}) {
  const { kb = {}, ...rest } = over;
  return {
    number,
    title: `card ${number}`,
    state: 'OPEN',
    stateReason: null,
    status: 'triage',
    agent: 'claude',
    labels: ['kb:status:triage', 'kb:agent:claude'],
    bodyText: '## Why\nbecause.\n\n## What\nthe thing.\n\n## Done when\n- [ ] it is done.\n' + 'x'.repeat(400),
    blockedBy: [],
    prs: [],
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-30T12:00:00.000Z',
    kb: { ...DEFAULT_KB, paths: [`src/${number}.js`], goal: `card ${number} is done`, ...kb },
    ...rest,
  };
}

const blocker = (number, state = 'OPEN', stateReason = null) => ({ number, state, stateReason, title: `b${number}` });
const done = (n) => blocker(n, 'CLOSED', 'COMPLETED');

const report = (tasks, opts = {}) => groomBoard(tasks, { now: NOW, blockersFilled: true, blockersSource: 'local', ...opts });
const row = (rep, n) => rep.cards.find((c) => c.number === n);
const kinds = (rep, n) => row(rep, n).findings.map((f) => f.kind);
const finding = (rep, n, kind) => row(rep, n).findings.find((f) => f.kind === kind);

// ---------- the helpers ----------

test('blocksIndex: blocker → every card it blocks, over ALL tasks not just the lane', () => {
  const tasks = [
    card(1, { blockedBy: [blocker(2), blocker(3)] }),
    card(2, { status: 'running', labels: ['kb:status:running'] }),
    card(3),
    card(4, { blockedBy: [blocker(2)] }),
  ];
  const idx = blocksIndex(tasks);
  assert.deepEqual(idx.get(2), [1, 4]);
  assert.deepEqual(idx.get(3), [1]);
  assert.equal(idx.get(9), undefined);
});

test('ageDays and touched_days: injected clock, whole days, null without a date', () => {
  assert.equal(ageDays({ createdAt: '2026-08-22T12:00:00.000Z' }, NOW), 10);
  assert.equal(ageDays({ createdAt: '2026-09-01T11:00:00.000Z' }, NOW), 0);
  assert.equal(ageDays({}, NOW), null);
  const rep = report([card(1)]);
  assert.equal(row(rep, 1).age_days, 10);
  assert.equal(row(rep, 1).touched_days, 2);
});

test('specShape: headings under any markup, and thinness', () => {
  const full = '## Why\n' + 'a'.repeat(200) + '\n## What\nb\n## Done when\n- [ ] c\n' + 'd'.repeat(300);
  const s = specShape(full);
  assert.equal(s.why && s.what && s.doneWhen, true);
  assert.deepEqual(s.missing, []);
  assert.equal(s.thin, false);
  // #117's real shape: "Gap 1 / Gap 2 / Done when" — a Done-when heading is still a Done-when heading
  assert.equal(specShape('### Gap 1\nx\n### Done when\n- [ ] y').doneWhen, true);
  assert.equal(specShape('**Done when**\n- [ ] y').doneWhen, true);
  // long enough but missing a heading is still thin; complete but short is too
  assert.equal(specShape('## Why\nx\n## What\ny\n' + 'z'.repeat(600)).thin, true);
  assert.equal(specShape('## Why\nx\n## What\ny\n## Done when\nz').thin, true);
});

test('cardMentions: open numbers only, deduped, ascending', () => {
  const open = new Set([12, 13, 14]);
  assert.deepEqual(cardMentions('see #12 and #99, also #13 and #12 again', open), [12, 13]);
  assert.deepEqual(cardMentions('', open), []);
  assert.deepEqual(cardMentions('#14', [12, 13, 14]), [14]);
});

test('pathHubs: a path a quarter of the board names, one card is never a hub', () => {
  const tasks = [
    card(1, { kb: { paths: ['src/model.js', 'test/'] } }),
    card(2, { kb: { paths: ['src/model.js', 'test/'] } }),
    card(3, { kb: { paths: ['src/cli.js'] } }),
    card(4, { kb: { paths: ['docs/'] } }),
    card(5, { kb: { paths: ['src/model.js'] } }),
    card(6, { kb: { paths: ['web/'] } }),
    card(7, { kb: { paths: ['test/'] } }),
    card(8, { kb: { paths: ['bin/'] } }),
  ];
  // 8 cards, 25% → 2, floored at 3: a path only two cards name is the pair signal, not a hub
  assert.deepEqual(pathHubs(tasks), [{ path: 'src/model.js', cards: 3 }, { path: 'test', cards: 3 }]);
  // a stricter share removes both
  assert.deepEqual(pathHubs(tasks, 0.5).map((h) => h.path), []);
  assert.deepEqual(pathHubs([card(1, { kb: { paths: ['x/'] } }), card(2, { kb: { paths: ['x/'] } })]), []);
});

test('pathJaccard: prefix-aware, hubs removed, never NaN', () => {
  assert.equal(pathJaccard(['src/a.js'], ['src/a.js']), 1);
  assert.equal(pathJaccard(['src/a.js', 'src/b.js'], ['src/a.js']), 0.5);
  assert.equal(pathJaccard(['src/'], ['src/a.js']), 1);
  assert.equal(pathJaccard(['src/a.js'], ['docs/']), 0);
  // the hub is what they have in common: remove it and nothing is left
  assert.equal(pathJaccard(['test/', 'src/a.js'], ['test/', 'src/b.js'], [{ path: 'test', cards: 9 }]), 0);
  assert.equal(pathJaccard(['test/'], ['test/'], ['test/']), 0);
  assert.equal(pathJaccard([], []), 0);
});

// ---------- one fixture case per kind ----------

test('unblocked: every blocker completed, and the zero-blocker card that must NOT match', () => {
  const tasks = [
    card(1, { blockedBy: [done(2), done(3)] }),
    card(4), // no blockers at all — the false positive the ≥1 rule exists to refuse
  ];
  const rep = report(tasks);
  assert.ok(kinds(rep, 1).includes('unblocked'));
  assert.equal(finding(rep, 1, 'unblocked').level, 'act');
  assert.equal(row(rep, 1).proposal, 'promote');
  assert.ok(!kinds(rep, 4).includes('unblocked'));
  assert.ok(kinds(rep, 4).includes('no_blockers'));
});

test('unblocked: a future scheduled_at parks the card, no new field needed', () => {
  const rep = report([card(1, { blockedBy: [done(2)], kb: { scheduled_at: '2026-10-01T00:00:00.000Z' } })]);
  assert.ok(!kinds(rep, 1).includes('unblocked'));
});

test('dead_blocker: a NOT_PLANNED blocker is never unblocked, and the report never says the d-word', () => {
  const rep = report([card(1, { blockedBy: [done(2), blocker(3, 'CLOSED', 'NOT_PLANNED')] })]);
  assert.ok(kinds(rep, 1).includes('dead_blocker'));
  assert.ok(!kinds(rep, 1).includes('unblocked'));
  assert.ok(!kinds(rep, 1).includes('blocker_off_board'), 'a closed blocker is dead, not off-board');
  assert.match(finding(rep, 1, 'dead_blocker').evidence, /#3 is closed as not planned/);
  const dup = report([card(1, { blockedBy: [blocker(3, 'CLOSED', 'DUPLICATE')] })]);
  assert.doesNotMatch(JSON.stringify(dup).toLowerCase(), /duplicate/);
});

test('no_blockers / unknown_blockers: an empty list means nothing without the GraphQL field', () => {
  assert.ok(kinds(report([card(1)]), 1).includes('no_blockers'));
  const rest = groomBoard([card(1)], { now: NOW });
  assert.ok(kinds(rest, 1).includes('unknown_blockers'));
  assert.ok(!kinds(rest, 1).includes('no_blockers'));
  assert.equal(rest.blockers_source, 'unknown');
  // filled by REST: the list is trustworthy again
  const filled = groomBoard([card(1)], { now: NOW, blockersFilled: true, blockersSource: 'local' });
  assert.ok(kinds(filled, 1).includes('no_blockers'));
  assert.equal(filled.blockers_source, 'local');
});

test('blocker_in_triage and priority_inversion', () => {
  const tasks = [
    card(1, { kb: { priority: 3 }, blockedBy: [blocker(2)] }),
    card(2, { kb: { priority: 1 } }),
  ];
  const rep = report(tasks);
  assert.ok(kinds(rep, 1).includes('blocker_in_triage'));
  assert.ok(kinds(rep, 1).includes('priority_inversion'));
  assert.equal(finding(rep, 1, 'priority_inversion').level, 'ask');
  assert.match(finding(rep, 1, 'priority_inversion').evidence, /#2 is p1.*p3/);
});

test('no_paths, malformed_kb, two_agents', () => {
  const tasks = [
    card(1, { kb: { paths: [] } }),
    card(2, { kb: { _malformed: true } }),
    card(3, { agent: 'claude', labels: ['kb:status:triage', 'kb:agent:claude', 'kb:agent:claude-track'] }),
  ];
  const rep = report(tasks);
  assert.ok(kinds(rep, 1).includes('no_paths'));
  assert.equal(row(rep, 1).proposal, 'specify');
  assert.ok(kinds(rep, 2).includes('malformed_kb'));
  assert.ok(kinds(rep, 3).includes('two_agents'));
  assert.match(finding(rep, 3, 'two_agents').evidence, /claude, claude-track/);
});

test('no_goal is info when a Done-when heading exists, act when it does not (amendment 2)', () => {
  const withDoneWhen = card(1, { kb: { goal: null } });
  const without = card(2, { kb: { goal: null }, bodyText: '## Why\nx\n## What\n' + 'y'.repeat(500) });
  const rep = report([withDoneWhen, without]);
  assert.equal(finding(rep, 1, 'no_goal').level, 'info');
  assert.equal(row(rep, 1).proposal, 'none', 'a promotable card is not proposed for a rewrite');
  assert.equal(finding(rep, 2, 'no_goal').level, 'act');
  assert.equal(row(rep, 2).proposal, 'specify');
});

test('thin_spec is ask, never act — a good spec under other headings is a false hit', () => {
  const rep = report([card(1, { bodyText: 'do the thing' })]);
  assert.equal(finding(rep, 1, 'thin_spec').level, 'ask');
  assert.equal(GROOM_KINDS.thin_spec, 'ask');
});

test('merged_pr_open: an open card whose PR already merged, printing the base branch', () => {
  const rep = report([card(1, { prs: [{ number: 9, state: 'MERGED', merged: true, baseRefName: 'kb/191' }] })]);
  assert.ok(kinds(rep, 1).includes('merged_pr_open'));
  assert.match(finding(rep, 1, 'merged_pr_open').evidence, /kb\/191/);
  assert.doesNotMatch(finding(rep, 1, 'merged_pr_open').evidence, /close/);
});

test('broad_path (amendment 3): a prefix three other lane cards sit under', () => {
  const tasks = [
    card(1, { kb: { paths: ['test/'] } }),
    card(2, { kb: { paths: ['test/a.test.js'] } }),
    card(3, { kb: { paths: ['test/b.test.js'] } }),
    card(4, { kb: { paths: ['test/c.test.js'] } }),
    card(5, { kb: { paths: ['docs/'] } }),
  ];
  const rep = report(tasks);
  assert.ok(kinds(rep, 1).includes('broad_path'));
  assert.equal(finding(rep, 1, 'broad_path').level, 'ask');
  assert.ok(!kinds(rep, 5).includes('broad_path'));
});

test('cycle and blocker_off_board come from the src/track.js walk', () => {
  const tasks = [
    card(1, { blockedBy: [blocker(2)] }),
    card(2, { blockedBy: [blocker(1)] }),
    card(3, { blockedBy: [blocker(77)] }),
  ];
  const rep = report(tasks);
  assert.ok(kinds(rep, 1).includes('cycle'));
  assert.match(finding(rep, 1, 'cycle').evidence, /#1 → #2 → #1|#2 → #1 → #2/);
  assert.ok(kinds(rep, 3).includes('blocker_off_board'));
  assert.match(finding(rep, 3, 'blocker_off_board').evidence, /#77/);
  assert.equal(GROOM_KINDS.cycle, 'act');
});

test('mentions_unlinked: mentions minus blockers minus children minus self', () => {
  const tasks = [
    card(1, { bodyText: 'blocked by #2, blocks #3, related to #4, and #999 which is closed', kb: { goal: 'see #5' }, blockedBy: [blocker(2)] }),
    card(2),
    card(3, { blockedBy: [blocker(1)] }),
    card(4),
    card(5),
  ];
  const rep = report(tasks);
  const f = finding(rep, 1, 'mentions_unlinked');
  assert.equal(f.level, 'needs_judgment');
  assert.match(f.evidence, /#4, #5/);
  assert.doesNotMatch(f.evidence, /#2|#3|#999/);
  assert.equal(row(rep, 1).needs_judgment, true);
  assert.ok(rep.judgment.cards.includes(1));
});

test('overlap_pair: hubs removed, guard-aware wording, and never the d-word', () => {
  const shared = ['src/serve.js', 'web/app.js'];
  const tasks = [
    card(1, { kb: { paths: [...shared, 'test/'] } }),
    card(2, { kb: { paths: [...shared, 'test/'] } }),
    card(3, { kb: { paths: ['test/'] } }),
    card(4, { kb: { paths: ['test/'] } }),
    card(5, { kb: { paths: ['docs/'] } }),
  ];
  const rep = report(tasks, { guard: { mode: 'unmerged' } });
  assert.equal(rep.pairs.length, 1);
  assert.deepEqual([rep.pairs[0].a, rep.pairs[0].b], [1, 2]);
  assert.equal(rep.pairs[0].score, 1);
  assert.deepEqual(rep.pairs[0].shared, ['src/serve.js', 'web/app.js']);
  assert.match(rep.pairs[0].why, /shares non-hub files with #2/);
  assert.match(rep.pairs[0].why, /will serialize under path_overlap/);
  assert.doesNotMatch(JSON.stringify(rep).toLowerCase(), /duplicate/);
  // #3 and #4 share only the hub `test/`, so they are not a pair
  assert.ok(!rep.judgment.cards.includes(3));
  assert.equal(finding(rep, 1, 'overlap_pair').level, 'needs_judgment');
  assert.equal(rep.summary.one_slot, 1);

  // guard off: the same pair, and the honest statement that nothing serialises
  const off = report(tasks, { guard: 'off' });
  assert.match(off.pairs[0].why, /it is off here, so they will not/);
  assert.equal(off.summary.one_slot, 0);
  // no guard passed at all: say so rather than guess
  assert.match(report(tasks).pairs[0].why, /the mode was not passed in/);
});

test('every GROOM_KINDS kind has at least one fixture case in this file', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./groom.test.js', import.meta.url), 'utf8');
  for (const kind of Object.keys(GROOM_KINDS)) {
    assert.ok(src.includes(`'${kind}'`), `no fixture case names ${kind}`);
    assert.ok(GROOM_LEVELS.includes(GROOM_KINDS[kind]), `${kind} has a level outside GROOM_LEVELS`);
  }
  for (const k of GROOM_SHORTLISTS) assert.equal(GROOM_KINDS[k], 'needs_judgment');
});

// ---------- proposeAction ----------

test('proposeAction: the table, pinned, and every value inside GROOM_ACTIONS', () => {
  const at = (...ks) => ({ findings: ks.map((k) => ({ kind: k, level: GROOM_KINDS[k] })) });
  const table = [
    [at('unblocked'), 'promote'],
    [at('unblocked', 'mentions_unlinked'), 'promote'], // mechanical wins; the shortlist is still on the row
    [at('cycle'), 'link-under'],
    [at('blocker_off_board'), 'link-under'],
    [at('dead_blocker'), 'link-under'],
    [at('blocker_in_triage'), 'link-under'],
    [at('malformed_kb'), 'specify'],
    [at('no_paths'), 'specify'],
    [at('two_agents'), 'specify'],
    [{ findings: [{ kind: 'no_goal', level: 'act' }] }, 'specify'],
    [{ findings: [{ kind: 'no_goal', level: 'info' }] }, 'none'],
    [at('thin_spec'), 'specify'],
    [at('broad_path'), 'specify'],
    [at('priority_inversion'), 'reprioritise'],
    [at('mentions_unlinked'), 'judge'],
    [at('overlap_pair'), 'judge'],
    [at('no_blockers'), 'none'],
    [at('unknown_blockers'), 'none'],
    [at('merged_pr_open'), 'none'],
    [{}, 'none'],
    [undefined, 'none'],
  ];
  for (const [c, want] of table) {
    const got = proposeAction(c);
    assert.equal(got, want, `${JSON.stringify(c)} → ${got}, wanted ${want}`);
    assert.ok(GROOM_ACTIONS.includes(got), `${got} is not in GROOM_ACTIONS`);
  }
});

test('GROOM_ACTIONS is the closed vocabulary, judge and none included', () => {
  assert.deepEqual(GROOM_ACTIONS, [
    'promote', 'specify', 'link-under', 'split', 'supersede', 'reprioritise', 'park', 'archive',
    'judge', 'none',
  ]);
  assert.throws(() => { GROOM_ACTIONS.push('close'); });
});

// ---------- groomBoard itself ----------

test('groomBoard: pure — one plain array, an injected clock, no ctx and no I/O', () => {
  const tasks = [card(1), card(2, { blockedBy: [done(3)] })];
  const frozen = JSON.parse(JSON.stringify(tasks));
  const rep = groomBoard(tasks, { now: NOW, blockersFilled: true, blockersSource: 'local', board: 'default' });
  assert.equal(rep.read_at, NOW.toISOString());
  assert.equal(rep.board, 'default');
  assert.equal(rep.cards_read, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(tasks)), frozen, 'groomBoard must not mutate the board read');
  assert.equal(groomBoard(undefined).cards.length, 0);
  assert.equal(groomBoard([]).cards.length, 0);
});

test('groomBoard: the --json keys are the frozen ones', () => {
  const rep = report([card(1, { blockedBy: [done(2)] })]);
  assert.deepEqual(Object.keys(rep).sort(), ['blockers_source', 'board', 'cards', 'cards_read', 'judgment', 'pairs', 'read_at', 'summary'].sort());
  for (const k of ['number', 'title', 'status', 'agent', 'priority', 'age_days', 'touched_days', 'paths', 'goal', 'blocked_by', 'blocks', 'findings', 'proposal', 'needs_judgment']) {
    assert.ok(k in rep.cards[0], `card row is missing ${k}`);
  }
  for (const f of rep.cards[0].findings) {
    assert.deepEqual(Object.keys(f).sort(), ['evidence', 'kind', 'level', 'suggests']);
    assert.ok(Object.keys(GROOM_KINDS).includes(f.kind));
  }
  for (const k of ['by_status', 'hubs', 'one_slot']) assert.ok(k in rep.summary, `summary is missing ${k}`);
  assert.deepEqual(Object.keys(rep.judgment).sort(), ['cards', 'pairs']);
});

test('statuses filters only the rows: the index and mentions still see the whole board (amendment 9)', () => {
  const tasks = [
    card(1, { blockedBy: [blocker(2)] }),
    card(2, { status: 'running', labels: ['kb:status:running', 'kb:agent:claude'], blockedBy: [] }),
    card(3, { status: 'done', labels: ['kb:status:done'], state: 'CLOSED', stateReason: 'COMPLETED' }),
  ];
  const rep = report(tasks, { statuses: ['triage'] });
  assert.deepEqual(rep.cards.map((c) => c.number), [1]);
  assert.equal(rep.cards_read, 3, 'cards_read counts the read, not the lane');
  // #2 is a running child of a triage blocker: it is listed under blocks even though it has no row
  const two = report(tasks, { statuses: ['triage', 'running'] });
  assert.deepEqual(row(two, 2).blocks, [1]);
  assert.deepEqual(rep.summary.by_status, { triage: 1, running: 1, done: 1 });
});

test('bodyText rides only on flagged rows — that is the whole token argument', () => {
  const tasks = [
    card(1, { bodyText: 'plain body about #2 with no link ' + 'x'.repeat(500) }),
    card(2),
  ];
  const rep = report(tasks);
  assert.equal(row(rep, 1).needs_judgment, true);
  assert.ok(typeof row(rep, 1).bodyText === 'string');
  assert.equal(row(rep, 2).needs_judgment, false);
  assert.ok(!('bodyText' in row(rep, 2)), 'an unflagged card carries no body');
  // --bodies all / none
  assert.ok('bodyText' in row(report(tasks, { bodies: 'all' }), 2));
  assert.ok(!('bodyText' in row(report(tasks, { bodies: 'none' }), 1)));
});

test('pairs: capped by --pairs and scored highest first', () => {
  // three disjoint pairs — a path a third card named too would be a hub, not evidence
  const tasks = [
    card(1, { kb: { paths: ['src/a.js', 'src/b.js'] } }),
    card(2, { kb: { paths: ['src/a.js', 'src/b.js'] } }),
    card(3, { kb: { paths: ['src/c.js', 'src/d.js'] } }),
    card(4, { kb: { paths: ['src/c.js'] } }),
    card(5, { kb: { paths: ['src/e.js'] } }),
    card(6, { kb: { paths: ['src/e.js'] } }),
  ];
  assert.equal(report(tasks).pairs.length, 3);
  const rep = report(tasks, { pairs: 2 });
  assert.equal(rep.pairs.length, 2);
  assert.ok(rep.pairs[0].score >= rep.pairs[1].score);
  assert.ok(rep.pairs.every((p) => p.score >= 0.4));
  assert.equal(report(tasks, { pairs: 0 }).pairs.length, 0);
});
