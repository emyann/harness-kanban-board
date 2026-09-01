import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, formatPromote, main, groomOptions, filterGroomLevel, formatGroom } from '../src/cli.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { GROOM_LEVELS } from '../src/model.js';
import { FakeGh, kbIssue } from './fake-gh.js';

test('parseArgs: positionals, --k v, --k=v, booleans, --', () => {
  const { flags, pos } = parseArgs(['create', 'Add auth', '--blocked-by', '12,13', '--priority=2', '--triage', '--json', '--', '--not-a-flag']);
  assert.deepEqual(pos, ['create', 'Add auth', '--not-a-flag']);
  assert.equal(flags['blocked-by'], '12,13');
  assert.equal(flags.priority, '2');
  assert.equal(flags.triage, true);
  assert.equal(flags.json, true);
});

test('parseArgs: a flag followed by another flag is boolean', () => {
  const { flags, pos } = parseArgs(['dispatch', '--dry-run', '--max', '2']);
  assert.equal(flags['dry-run'], true);
  assert.equal(flags.max, '2');
  assert.deepEqual(pos, ['dispatch']);
});

test('formatPromote (#209): every card the cascade touched is named, moved ones grouped by outcome', () => {
  const line = formatPromote([
    { number: 154, status: 'todo', from: 'triage' },
    { number: 155, status: 'todo', from: 'triage' },
    { number: 158, status: 'todo', from: 'triage' },
    { number: 144, status: 'done', unchanged: true, skipped: true, reason: 'already done' },
  ]);
  assert.equal(line, '#154 #155 #158 → todo · #144 already done');
});

test('formatPromote: a forced leaf and a blocker skipped for a human read differently', () => {
  const line = formatPromote([
    { number: 20, status: 'ready', from: 'todo', forced: true },
    { number: 30, status: 'blocked', unchanged: true, skipped: true, reason: 'blocked — needs human' },
  ]);
  assert.equal(line, '#20 → ready (forced: blockers not done) · #30 blocked — needs human');
});

test('hkb promote --triage-only: a card that moved on is skipped, nothing forced (#238)', async (t) => {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-promote-'));
  fs.mkdirSync(path.join(dir, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: gh.nameWithOwner }));
  gh.addIssue(kbIssue({ number: 70, title: 'still in triage', status: 'triage', agent: 'claude' }));
  gh.addIssue(kbIssue({ number: 71, title: 'already moved on', status: 'todo', agent: 'claude' }));

  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  const restore = gh.install();
  process.chdir(dir);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restore(); fs.rmSync(dir, { recursive: true, force: true }); });

  await main(['promote', '70', '71', '--triage-only', '--json']);
  const res = JSON.parse(printed);
  const byNumber = new Map(res.map((r) => [r.number, r]));
  assert.deepEqual(byNumber.get(70), { number: 70, status: 'todo', from: 'triage', forced: false });
  assert.deepEqual(byNumber.get(71), { number: 71, status: 'todo', unchanged: true, skipped: true, reason: 'not in triage — already todo' });
  assert.equal(gh.issues.get(71).labels.includes('kb:status:ready'), false, 'never forced');
});

// ---------- hkb groom (#227): the read verb, its frozen shape, and the unblocked nudge ----------

/** The keys `--json` promises. Frozen: a later finding kind lands in `findings`, nothing is renamed. */
const REPORT_KEYS = ['board', 'read_at', 'cards_read', 'blockers_source', 'summary', 'cards', 'pairs', 'judgment'];
const CARD_KEYS = ['number', 'title', 'status', 'agent', 'priority', 'age_days', 'touched_days', 'paths', 'goal', 'blocked_by', 'blocks', 'findings', 'proposal', 'needs_judgment'];

const SPEC = `## Why\n${'why '.repeat(60)}\n\n## What\n${'what '.repeat(60)}\n\n## Done when\n- [ ] it works\n`;

/** A board with one of each interesting row, and a chdir'd checkout `main()` can run against. */
function groomHarness(t) {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-groom-'));
  fs.mkdirSync(path.join(dir, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: gh.nameWithOwner }));
  gh.addIssue(kbIssue({ number: 1, title: 'the blocker', status: 'done', state: 'CLOSED' }));
  // every blocker done → unblocked → promote, and nothing to judge
  gh.addIssue(kbIssue({ number: 10, title: 'ready to go', status: 'triage', agent: 'claude', blockedBy: [1], body: SPEC, kb: { paths: ['src/ten.js'], goal: 'ten' } }));
  // nothing blocks it, thin body → specify, and nothing to judge either
  gh.addIssue(kbIssue({ number: 11, title: 'a stub', status: 'triage', agent: 'claude', body: 'do it' }));
  // names #11 and is linked to nothing → mentions_unlinked → needs_judgment → carries its body
  gh.addIssue(kbIssue({ number: 12, title: 'the judged one', status: 'triage', agent: 'claude', body: `${SPEC}\nsee #11 for context`, kb: { paths: ['src/twelve.js'], goal: 'twelve' } }));
  gh.addIssue(kbIssue({ number: 13, title: 'already moving', status: 'running', agent: 'claude', body: SPEC, kb: { paths: ['src/thirteen.js'], goal: 'thirteen' } }));

  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  const restore = gh.install();
  process.chdir(dir);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restore(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { gh, run: async (...argv) => { printed = ''; gh.calls.length = 0; await main(argv); return printed; } };
}

const boardQueries = (gh) => gh.calls.filter((c) => c.kind === 'graphql' && String(c.query || '').includes('issues(first: 100'));
const writes = (gh) => gh.calls.filter((c) => c.kind !== 'graphql' && !['GET', null, undefined].includes(c.method));

test('hkb groom --json: one board query, zero writes, and the frozen key set', async (t) => {
  const { gh, run } = groomHarness(t);
  const rep = JSON.parse(await run('groom', '--json'));

  assert.equal(boardQueries(gh).length, 1, 'one board read per groom, whatever the lane');
  assert.deepEqual(writes(gh), [], 'groom is a read, exactly like dispatch --dry-run');
  assert.deepEqual(Object.keys(rep), REPORT_KEYS);
  assert.equal(rep.board, 'default');
  assert.equal(rep.blockers_source, 'graphql');
  assert.deepEqual(Object.keys(rep.summary).sort(), ['by_status', 'hubs', 'lane', 'levels', 'one_slot', 'path_overlap']);
  assert.deepEqual(rep.cards.map((c) => c.number), [10, 11, 12], 'triage/todo/ready by default — #13 is running');
  for (const c of rep.cards) assert.deepEqual(Object.keys(c).filter((k) => k !== 'bodyText'), CARD_KEYS);
  const ten = rep.cards.find((c) => c.number === 10);
  assert.equal(ten.proposal, 'promote');
  assert.ok(ten.findings.some((f) => f.kind === 'unblocked' && f.level === 'act'));
});

test('hkb groom: only a card needing judgment carries its bodyText — the whole token argument', async (t) => {
  const { run } = groomHarness(t);
  const flagged = JSON.parse(await run('groom', '--json'));
  const has = (rep, n) => Object.hasOwn(rep.cards.find((c) => c.number === n), 'bodyText');

  assert.deepEqual(flagged.judgment.cards, [12]);
  assert.ok(has(flagged, 12), 'the judged card is the one a human was asked to read');
  assert.ok(!has(flagged, 10) && !has(flagged, 11), 'a card nobody has to judge carries no body at all');

  const all = JSON.parse(await run('groom', '--json', '--bodies', 'all'));
  for (const c of all.cards) assert.ok(Object.hasOwn(c, 'bodyText'));
  const none = JSON.parse(await run('groom', '--json', '--bodies', 'none'));
  for (const c of none.cards) assert.ok(!Object.hasOwn(c, 'bodyText'));
});

test('hkb groom prints one row per card, each ending in its proposal, under a header and a footer', async (t) => {
  const { run } = groomHarness(t);
  const text = await run('groom', '--status', 'triage');
  const rows = text.split('\n').filter((l) => /^#\d/.test(l));

  assert.deepEqual(rows.map((l) => Number(/^#(\d+)/.exec(l)[1])), [10, 11, 12]);
  for (const r of rows) assert.match(r, / ⇒ (promote|specify|link-under|reprioritise|judge|none)$/);
  assert.match(text, /^\d+ cards · .* · hubs: /);
  assert.match(text, /\nact \d+ · ask \d+ · info \d+ · judge \d+ cards?, \d+ pairs? · blockers from graphql\n$/);
  assert.match(rows.find((r) => r.startsWith('#10')), / ⇡ unblocked {2}⇒ promote$/);
});

test('hkb groom --level narrows the rows without rewriting the report', async (t) => {
  const { run } = groomHarness(t);
  const act = JSON.parse(await run('groom', '--json', '--level', 'act'));

  assert.ok(act.cards.length && act.cards.every((c) => c.findings.some((f) => f.level === 'act')));
  assert.ok(!act.cards.some((c) => c.number === 12), 'nothing mechanical on the judged card');
  assert.deepEqual(act.judgment.cards, [], 'judgment.cards follows the rows it is derived from');
  assert.equal(act.summary.lane, 3, 'the counts stay the whole lane, which is what they are for');
});

test('hkb list: a triage card whose blockers are all done says so, in memory', async (t) => {
  const { gh, run } = groomHarness(t);
  const text = await run('list', '--status', 'triage');

  assert.match(text, /#10 .* ⇐ #1✓ {2}⇡ unblocked/);
  assert.ok(!/#11 .*⇡ unblocked/.test(text), 'no blockers at all is not "unblocked" — it is the default');
  assert.deepEqual(writes(gh), [], 'the nudge costs no write and no extra request');
});

test('groomOptions: unknown --level and --bodies exit 2 naming the list', () => {
  for (const [flags, re] of [
    [{ level: 'urgent' }, /^--level: unknown level "urgent" — one of act, ask, info, needs_judgment$/],
    [{ level: true }, /^--level: unknown level true/],
    [{ bodies: 'some' }, /^--bodies: unknown value "some" — one of flagged, all, none$/],
    [{ status: 'nope' }, /^--status: unknown lane "nope" — one of /],
    [{ pairs: 'lots' }, /^--pairs: a whole number/],
  ]) {
    assert.throws(() => groomOptions(flags), (e) => e.exitCode === 2 && re.test(e.message), JSON.stringify(flags));
  }
  assert.deepEqual(groomOptions({}), { statuses: ['triage', 'todo', 'ready'], level: null, bodies: 'flagged', pairs: 10, all: false });
  assert.deepEqual(groomOptions({ status: 'triage', level: 'ask', bodies: 'none', pairs: '0', all: true }), { statuses: ['triage'], level: 'ask', bodies: 'none', pairs: 0, all: true });
  for (const l of GROOM_LEVELS) assert.equal(groomOptions({ level: l }).level, l);
});

// ---------- hkb edit (#237): the write half of the kb block ----------

test('hkb edit <n> --paths/--goal/--scheduled-at/--priority sets exactly those keys', async (t) => {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-edit-'));
  fs.mkdirSync(path.join(dir, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: gh.nameWithOwner }));
  gh.addIssue(kbIssue({
    number: 50, title: 'edit me', status: 'todo', agent: 'claude', body: SPEC,
    kb: { paths: ['src/old.js'], goal: 'old goal', priority: 1, scheduled_at: null, max_runtime: 1800, max_retries: 4, model: 'sonnet', skills: ['s1'], workspace: 'worktree' },
  }));
  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  const restore = gh.install();
  process.chdir(dir);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restore(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = async (...argv) => { printed = ''; await main(argv); return printed; };

  await run('edit', '50', '--paths', 'src/new.js,src/other.js', '--goal', 'new goal', '--scheduled-at', '2026-09-02T00:00:00Z', '--priority', '3');
  const shown = JSON.parse(await run('show', '50', '--json'));
  assert.deepEqual(shown.kb.paths, ['src/new.js', 'src/other.js']);
  assert.equal(shown.kb.goal, 'new goal');
  assert.equal(shown.kb.scheduled_at, '2026-09-02T00:00:00Z');
  assert.equal(shown.kb.priority, 3);
  // everything not named on the command line survives untouched
  assert.equal(shown.kb.max_runtime, 1800);
  assert.equal(shown.kb.max_retries, 4);
  assert.equal(shown.kb.model, 'sonnet');
  assert.deepEqual(shown.kb.skills, ['s1']);
  assert.equal(shown.kb.workspace, 'worktree');

  // a second, narrower edit changes only what it names
  await run('edit', '50', '--priority', '2');
  const again = JSON.parse(await run('show', '50', '--json'));
  assert.equal(again.kb.priority, 2);
  assert.deepEqual(again.kb.paths, ['src/new.js', 'src/other.js'], 'untouched by the priority-only edit');
  assert.equal(again.kb.goal, 'new goal', 'untouched by the priority-only edit');
});

test('hkb edit <n>... with no field flag is a usage error', async () => {
  await assert.rejects(() => main(['edit', '50']), (e) => e.exitCode === 2);
});

// ---------- every `hkb edit` line hkb groom suggests is a command that runs ----------

/** Tokenize a suggested shell line: splits on whitespace, "double quotes" kept together and stripped. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

test('hkb groom: every hkb edit line it suggests is a command hkb edit actually runs', async (t) => {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-edit-suggest-'));
  fs.mkdirSync(path.join(dir, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: gh.nameWithOwner }));

  // malformed_kb: the block at the top of the body is not valid JSON
  const malformed = kbIssue({ number: 100, title: 'bad kb block', status: 'triage', agent: 'claude', body: SPEC, kb: { paths: ['src/hundred.js'], goal: 'hundred' } });
  malformed.body = '<!-- kb: {not json -->\n' + SPEC;
  gh.addIssue(malformed);

  // no_paths: kb.paths is empty
  gh.addIssue(kbIssue({ number: 101, title: 'no paths', status: 'triage', agent: 'claude', body: SPEC, kb: { paths: [], goal: 'a goal' } }));

  // broad_path: #113's own path covers three other lane cards
  gh.addIssue(kbIssue({ number: 110, title: 'wide a', status: 'triage', agent: 'claude', body: SPEC, kb: { paths: ['src/wide/a.js'], goal: 'a' } }));
  gh.addIssue(kbIssue({ number: 111, title: 'wide b', status: 'todo', agent: 'claude', body: SPEC, kb: { paths: ['src/wide/b.js'], goal: 'b' } }));
  gh.addIssue(kbIssue({ number: 112, title: 'wide c', status: 'ready', agent: 'claude', body: SPEC, kb: { paths: ['src/wide/c.js'], goal: 'c' } }));
  gh.addIssue(kbIssue({ number: 113, title: 'wide itself', status: 'triage', agent: 'claude', body: SPEC, kb: { paths: ['src/wide'], goal: 'wide' } }));

  // priority_inversion: #120 (p0) blocks #121 (p2) — the blocker is dispatched last
  gh.addIssue(kbIssue({ number: 120, title: 'low priority blocker', status: 'todo', agent: 'claude', body: SPEC, kb: { paths: ['src/blocker.js'], goal: 'blocker', priority: 0 } }));
  gh.addIssue(kbIssue({ number: 121, title: 'urgent, blocked', status: 'todo', agent: 'claude', body: SPEC, kb: { paths: ['src/urgent.js'], goal: 'urgent', priority: 2 }, blockedBy: [120] }));

  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  const restore = gh.install();
  process.chdir(dir);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restore(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = async (...argv) => { printed = ''; await main(argv); return printed; };

  const rep = JSON.parse(await run('groom', '--json', '--status', 'triage,todo,ready'));
  const edits = rep.cards.flatMap((c) => c.findings).map((f) => f.suggests).filter((s) => typeof s === 'string' && s.startsWith('hkb edit '));
  assert.ok(edits.some((s) => /^hkb edit 100 /.test(s)), 'malformed_kb suggested');
  assert.ok(edits.some((s) => /^hkb edit 101 /.test(s)), 'no_paths suggested');
  assert.ok(edits.some((s) => /^hkb edit 113 /.test(s)), 'broad_path suggested');
  assert.ok(edits.some((s) => /^hkb edit 120 /.test(s)), 'priority_inversion suggested');
  assert.ok(edits.length >= 4, 'all four findings fired');

  for (const line of edits) {
    const [, ...argv] = tokenize(line); // drop the leading "hkb"
    await run(...argv); // throws on a usage error — the whole point of the test
  }
});

test('filterGroomLevel and formatGroom are pure over the report shape', () => {
  const card = (number, findings, extra = {}) => ({ number, title: `t${number}`, status: 'triage', agent: 'claude', priority: 1, age_days: 2, touched_days: 1, paths: [], goal: null, blocked_by: [], blocks: [], findings, proposal: 'none', needs_judgment: false, ...extra });
  const rep = {
    board: 'default', read_at: '2026-09-01T00:00:00.000Z', cards_read: 2, blockers_source: 'rest',
    summary: { by_status: { triage: 2 }, hubs: [{ path: 'src/model.js', cards: 4 }], one_slot: 1, levels: { act: 1, ask: 1, info: 0, needs_judgment: 0 }, lane: 2, path_overlap: 'running' },
    cards: [card(1, [{ kind: 'unblocked', level: 'act', evidence: 'all done', suggests: 'hkb promote 1' }], { proposal: 'promote' }), card(2, [{ kind: 'thin_spec', level: 'ask', evidence: 'body is 12 chars', suggests: null }])],
    pairs: [{ a: 1, b: 2, score: 0.5, shared: ['src/a.js'], why: 'will serialize under path_overlap' }],
    judgment: { cards: [2], pairs: [] },
  };
  const act = filterGroomLevel(rep, 'act');
  assert.deepEqual(act.cards.map((c) => c.number), [1]);
  assert.deepEqual(act.judgment.cards, []);
  assert.equal(filterGroomLevel(rep, null), rep, 'no --level is the report itself');
  assert.deepEqual(rep.cards.map((c) => c.number), [1, 2], 'the input is never mutated');

  const text = formatGroom(rep);
  assert.match(text, /^2 cards · 2 triage · hubs: src\/model\.js \(4\)/);
  assert.ok(text.includes('  ⇒ promote'));
  assert.ok(text.includes('      unblocked (act): all done → hkb promote 1'));
  assert.ok(text.includes('      thin_spec (ask): body is 12 chars\n'), 'a finding with nothing to suggest prints no arrow');
  assert.ok(text.includes('  #1 ~ #2  0.5  src/a.js — will serialize under path_overlap'));
  assert.match(text, /act 1 · ask 1 · info 0 · judge 1 card, 0 pairs · blockers from rest$/);
  assert.ok(!/duplicate/i.test(text), 'the CLI never says duplicate');
});
