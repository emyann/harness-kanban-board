// The Projects v2 mirror, decided in pure functions: which option a status maps to, what the
// tick must write, and what every failure tells the user to do. No `gh`, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchOption, optionMap, missingStatuses, optionInputs, optionName, parseProjectSpec,
  isMirrorConfigured, planSync, projectError, parseTokenScopes, hasProjectScope, SCOPE_FIX,
} from '../src/projects.js';
import { STATUSES, L } from '../src/model.js';

const opt = (name, id = name.toLowerCase()) => ({ id, name });
const KB_OPTIONS = STATUSES.map((s) => opt(optionName(s), `opt-${s}`));
const OPTIONS = Object.fromEntries(STATUSES.map((s) => [s, `opt-${s}`]));
const BOARD = L.board('default');

const item = (number, status, over = {}) => ({
  id: `item-${number}`,
  number,
  optionId: status ? `opt-${status}` : null,
  optionName: status ? optionName(status) : null,
  labels: [BOARD, ...(status ? [L.status(status)] : [])],
  ...over,
});
const task = (number, status) => ({ number, nodeId: `I_${number}`, status });

// ---------- options ----------

test('a status matches its own option, case and punctuation insensitively', () => {
  assert.equal(matchOption('running', [opt('Running', 'x')]).id, 'x');
  assert.equal(matchOption('running', [opt('RUNNING', 'x')]).id, 'x');
  assert.equal(matchOption('todo', [opt('To do', 'x')]).id, 'x');
  assert.equal(matchOption('triage', [opt('Ready'), opt('Triage', 'x')]).id, 'x');
  assert.equal(matchOption('running', []), null);
  assert.equal(matchOption('running', null), null);
});

test('the GitHub default columns are reused instead of duplicated', () => {
  const github = [opt('Todo', 'a'), opt('In Progress', 'b'), opt('Done', 'c')];
  assert.equal(matchOption('todo', github).id, 'a');
  assert.equal(matchOption('running', github).id, 'b');
  assert.equal(matchOption('done', github).id, 'c');
  assert.equal(matchOption('review', github), null);
  assert.deepEqual(missingStatuses(github), ['triage', 'ready', 'blocked', 'review', 'archived']);
});

test('the exact name wins over an alias', () => {
  const both = [opt('Backlog', 'alias'), opt('Todo', 'exact')];
  assert.equal(matchOption('todo', both).id, 'exact');
});

test('optionMap maps every kb status it can, and only those', () => {
  assert.deepEqual(optionMap(KB_OPTIONS), OPTIONS);
  assert.deepEqual(optionMap([opt('Done', 'd'), opt('Sprint 4', 's')]), { done: 'd' });
  assert.deepEqual(missingStatuses(KB_OPTIONS), []);
  assert.deepEqual(optionMap([]), {});
});

test('option inputs append the missing statuses and keep every existing option', () => {
  const existing = [{ id: 'a', name: 'Todo', color: 'ORANGE', description: 'mine' }];
  const inputs = optionInputs(existing, ['ready', 'running']);
  assert.deepEqual(inputs[0], { name: 'Todo', color: 'ORANGE', description: 'mine' });
  assert.deepEqual(inputs.map((o) => o.name), ['Todo', 'Ready', 'Running']);
  assert.ok(inputs.every((o) => typeof o.color === 'string' && typeof o.description === 'string'));
  // a fresh field: every kb status, nothing dropped
  assert.deepEqual(optionInputs([], STATUSES).map((o) => o.name), STATUSES.map(optionName));
});

// ---------- --project <spec> ----------

test('--project takes a number, a #number, a project URL or "new"', () => {
  assert.deepEqual(parseProjectSpec('3'), { kind: 'number', number: 3, owner: null });
  assert.deepEqual(parseProjectSpec('#3'), { kind: 'number', number: 3, owner: null });
  assert.deepEqual(parseProjectSpec(' new '), { kind: 'new', number: null, owner: null });
  assert.deepEqual(parseProjectSpec('NEW'), { kind: 'new', number: null, owner: null });
  assert.deepEqual(parseProjectSpec('https://github.com/users/emyann/projects/7'), { kind: 'number', number: 7, owner: 'emyann' });
  assert.deepEqual(parseProjectSpec('https://github.com/orgs/acme/projects/12/views/1'), { kind: 'number', number: 12, owner: 'acme' });
});

test('--project explains itself instead of guessing', () => {
  for (const bad of [true, '', 'later', '0', '-2', 'https://github.com/emyann/repo']) {
    assert.throws(() => parseProjectSpec(bad), (e) => e.exitCode === 2 && /--project/.test(e.message), `accepted ${bad}`);
  }
});

test('the mirror is off until board.json carries a whole project block', () => {
  const full = { project: { id: 'PVT_1', status_field_id: 'F_1', options: OPTIONS } };
  assert.equal(isMirrorConfigured(full), true);
  assert.equal(isMirrorConfigured({}), false);
  assert.equal(isMirrorConfigured(null), false);
  assert.equal(isMirrorConfigured({ project: null }), false);
  assert.equal(isMirrorConfigured({ project: { id: 'PVT_1', status_field_id: 'F_1', options: {} } }), false);
  assert.equal(isMirrorConfigured({ project: { id: 'PVT_1', options: OPTIONS } }), false);
});

// ---------- the plan ----------

test('an item already in the right column costs no write', () => {
  const plan = planSync([item(1, 'ready')], [task(1, 'ready')], OPTIONS, { boardLabel: BOARD });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.adds, []);
});

test('a transition this tick moves the card', () => {
  const plan = planSync([item(1, 'ready')], [task(1, 'running')], OPTIONS, { boardLabel: BOARD });
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0], { item: 'item-1', number: 1, from: 'Ready', to: 'running', optionId: 'opt-running' });
});

test('a drag in the Project UI is repaired from the labels', () => {
  // the human dropped #1 in Done; the label still says running, and the label wins
  const dragged = item(1, 'done', { labels: [BOARD, L.status('running')] });
  const plan = planSync([dragged], [], OPTIONS, { boardLabel: BOARD });
  assert.deepEqual(plan.updates.map((u) => [u.number, u.to]), [[1, 'running']]);
});

test('an issue that left the open board is mirrored from what the tick decided', () => {
  const plan = planSync([item(9, 'review')], [], OPTIONS, { extra: { 9: 'done' }, boardLabel: BOARD });
  assert.deepEqual(plan.updates.map((u) => [u.number, u.from, u.to]), [[9, 'Review', 'done']]);
});

test('the tick beats a stale label read', () => {
  const stale = item(4, 'ready', { labels: [BOARD, L.status('ready')] });
  const plan = planSync([stale], [task(4, 'running')], OPTIONS, { extra: { 4: 'done' }, boardLabel: BOARD });
  assert.deepEqual(plan.updates.map((u) => u.to), ['running']); // the open board is fresher than `extra`
});

test('issues missing from the project are added with their status', () => {
  const plan = planSync([], [task(1, 'ready'), task(2, 'running')], OPTIONS, { boardLabel: BOARD });
  assert.deepEqual(plan.adds, [
    { number: 1, content: 'I_1', to: 'ready', optionId: 'opt-ready' },
    { number: 2, content: 'I_2', to: 'running', optionId: 'opt-running' },
  ]);
  assert.equal(plan.deferred, 0);
});

test('adds are capped per tick and the rest is reported, never dropped silently', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => task(i + 1, 'ready'));
  const plan = planSync([], tasks, OPTIONS, { boardLabel: BOARD, maxAdds: 2 });
  assert.deepEqual(plan.adds.map((a) => a.number), [1, 2]);
  assert.equal(plan.deferred, 3);
});

test('the Project may hold whatever else it likes', () => {
  const items = [
    item(1, 'ready'),
    { id: 'draft', number: null, optionId: null, optionName: null, labels: [] }, // a draft card
    item(50, null, { labels: ['bug'] }), // an issue nobody put on the board
    item(60, 'done', { labels: [L.board('other'), L.status('running')] }), // another board's task
  ];
  const plan = planSync(items, [task(1, 'ready')], OPTIONS, { boardLabel: BOARD });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.adds, []);
});

test('a status with no option is reported, not written', () => {
  const partial = { ready: 'opt-ready' };
  const plan = planSync([item(1, 'ready')], [task(1, 'ready'), task(2, 'running')], partial, { boardLabel: BOARD });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.adds.map((a) => [a.number, a.optionId]), [[2, null]]);
  assert.deepEqual(plan.unmapped, [{ number: 2, status: 'running' }]);
});

test('planSync survives empty and missing input', () => {
  assert.deepEqual(planSync(null, null, OPTIONS), { updates: [], adds: [], deferred: 0, unmapped: [] });
  assert.deepEqual(planSync([], [], {}), { updates: [], adds: [], deferred: 0, unmapped: [] });
});

// ---------- errors and scopes ----------

test('a missing scope says exactly what to run', () => {
  const e = projectError(new Error("GraphQL failed (200): Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project']"));
  assert.equal(e.kind, 'scope');
  assert.equal(e.fix, SCOPE_FIX);
  assert.equal(projectError(new Error('Resource not accessible by personal access token')).kind, 'scope');
});

test('a deleted project is a mirror problem, never a board problem', () => {
  const e = projectError(new Error('Could not resolve to a ProjectV2 with the number 4.'));
  assert.equal(e.kind, 'missing');
  assert.match(e.fix, /board\.json/);
  assert.equal(projectError({ kind: 'notfound', message: 'GraphQL failed (404)' }).kind, 'missing');
  assert.equal(projectError({ message: 'project not found' }).kind, 'missing');
});

test('anything else is passed through verbatim', () => {
  const e = projectError(new Error('GraphQL failed (502): upstream'));
  assert.equal(e.kind, 'error');
  assert.equal(e.fix, null);
  assert.match(e.message, /502/);
  assert.equal(projectError(null).kind, 'error');
});

test('token scopes are read from gh auth status, or admitted to be unknown', () => {
  const modern = "  ✓ Logged in to github.com account emyann\n  - Token scopes: 'gist', 'read:org', 'repo', 'project'\n";
  assert.deepEqual(parseTokenScopes(modern), ['gist', 'read:org', 'repo', 'project']);
  assert.equal(hasProjectScope(parseTokenScopes(modern)), true);
  const old = '  ✓ Token scopes: gist, read:org, repo\n';
  assert.deepEqual(parseTokenScopes(old), ['gist', 'read:org', 'repo']);
  assert.equal(hasProjectScope(parseTokenScopes(old)), false);
  // a fine-grained PAT: gh reports no scopes at all — unknown, not "missing"
  assert.equal(parseTokenScopes('✓ Logged in to github.com account emyann'), null);
  assert.equal(hasProjectScope(null), null);
  assert.equal(hasProjectScope(parseTokenScopes('Token scopes: ')), false);
});

test('read:project alone is not enough to move a card', () => {
  assert.equal(hasProjectScope(['repo', 'read:project']), false);
  assert.equal(hasProjectScope(['repo', 'project']), true);
});
