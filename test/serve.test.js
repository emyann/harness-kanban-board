// `hkb serve`: the drag-drop → verb table, the request guards, and the HTTP surface.
// No `gh` and no network — the board reads and the lifecycle verbs are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  COLUMNS, moveDecision, cardOf, boardEtag, parseRoute, checkOrigin, isLoopback,
  logPathFor, tailFile, missingFields, startServer, keyBoards, serveContexts,
} from '../src/serve.js';

const task = (over = {}) => ({
  number: 20, title: 'hkb serve', status: 'ready', agent: 'claude', board: 'default',
  kb: { priority: 1, paths: ['src/serve.js'], scheduled_at: null, goal: null },
  bodyText: '## Why\nbecause', labels: ['kb:board:default', 'kb:status:ready'],
  needsHuman: false, state: 'OPEN', url: 'https://github.com/o/r/issues/20',
  updatedAt: '2026-08-26T07:00:00Z', blockedBy: [], prs: [], ...over,
});

// ---------- moveDecision ----------

test('the legal moves each map to the verb the CLI would run', () => {
  const cases = [
    ['triage', 'todo', ['promote']],
    ['triage', 'ready', ['promote', 'promote']],
    ['todo', 'ready', ['promote']],
    ['blocked', 'ready', ['promote']],
    ['blocked', 'todo', ['unblock']],
    ['ready', 'blocked', ['block']],
    ['running', 'blocked', ['block']],
    ['review', 'ready', ['request-changes']],
    ['review', 'todo', ['request-changes']],
  ];
  for (const [from, to, steps] of cases) {
    const d = moveDecision(task({ status: from }), to);
    assert.equal(d.ok, true, `${from} → ${to} should be legal`);
    assert.deepEqual(d.steps, steps, `${from} → ${to}`);
  }
});

test('block and request-changes ask for a reason before anything is written', () => {
  assert.deepEqual(moveDecision(task({ status: 'ready' }), 'blocked').needs, ['reason']);
  assert.deepEqual(moveDecision(task({ status: 'review' }), 'ready').needs, ['reason']);
  assert.deepEqual(moveDecision(task({ status: 'todo' }), 'ready').needs, []);
});

test('illegal moves are refused with the reason, never silently', () => {
  const refusal = (from, to) => {
    const d = moveDecision(task({ status: from }), to);
    assert.equal(d.ok, false, `${from} → ${to} must be refused`);
    assert.ok(d.reason.length > 10);
    return d.reason;
  };
  assert.match(refusal('ready', 'running'), /dispatcher/);
  assert.match(refusal('ready', 'done'), /hkb complete/);
  assert.match(refusal('ready', 'review'), /request-review/);
  assert.match(refusal('ready', 'triage'), /demotes|archive/);
  assert.match(refusal('ready', 'todo'), /no verb demotes/);
  assert.match(refusal('done', 'ready'), /closed/);
  assert.match(moveDecision(task(), 'nope').reason, /not a column/);
  assert.match(moveDecision(task({ status: null }), 'todo').reason, /hkb adopt/);
});

test('a drop on the column a task is already in is a no-op, not an error', () => {
  const d = moveDecision(task({ status: 'ready' }), 'ready');
  assert.equal(d.ok, true);
  assert.deepEqual(d.steps, []);
});

test('every column is a possible target or explains itself', () => {
  for (const to of COLUMNS) {
    const d = moveDecision(task({ status: 'todo' }), to);
    assert.ok(d.ok || typeof d.reason === 'string');
  }
});

// ---------- payload + etag ----------

test('cardOf keeps the board small and resolves blocker/PR state', () => {
  const c = cardOf(task({
    blockedBy: [{ number: 3, title: 'harness', state: 'CLOSED', stateReason: null }, { number: 4, title: 'refs', state: 'OPEN' }],
    prs: [{ number: 24, state: 'OPEN', isDraft: true, merged: false, url: 'u' }],
  }));
  assert.equal(c.body, undefined);
  assert.equal(c.bodyText, undefined);
  assert.deepEqual(c.blockedBy.map((b) => b.done), [true, false]);
  assert.equal(c.prs[0].isDraft, true);
  assert.equal(c.priority, 1);
  assert.equal(c.ready, false); // one blocker still open
});

test('the ETag follows the tasks and nothing else', () => {
  const a = [cardOf(task())];
  assert.equal(boardEtag(a), boardEtag([cardOf(task())]));
  assert.notEqual(boardEtag(a), boardEtag([cardOf(task({ status: 'running' }))]));
});

// ---------- routing and guards ----------

test('parseRoute covers the whole surface and nothing else', () => {
  assert.deepEqual(parseRoute('/'), { kind: 'page' });
  assert.deepEqual(parseRoute('/api/board'), { kind: 'board' });
  assert.deepEqual(parseRoute('/api/tasks/20'), { kind: 'task', number: 20, key: null });
  assert.deepEqual(parseRoute('/api/tasks/20/log'), { kind: 'log', number: 20, key: null });
  assert.deepEqual(parseRoute('/api/tasks/20/request-changes'), { kind: 'verb', number: 20, verb: 'request-changes', key: null });
  for (const p of ['/api', '/api/tasks', '/api/tasks/x', '/../etc/passwd', '/api/tasks/20/log/2']) assert.equal(parseRoute(p), null, p);
});

test('parseRoute carries the board a request names', () => {
  assert.deepEqual(parseRoute('/api/boards/o~r~default/tasks/20'), { kind: 'task', number: 20, key: 'o~r~default' });
  assert.deepEqual(parseRoute('/api/boards/o~r~default/tasks/20/log'), { kind: 'log', number: 20, key: 'o~r~default' });
  assert.deepEqual(parseRoute('/api/boards/o~r~x/tasks/20/move'), { kind: 'verb', number: 20, verb: 'move', key: 'o~r~x' });
  for (const p of ['/api/boards', '/api/boards/k', '/api/boards/k/tasks', '/api/boards/../tasks/20', '/api/boards/a/b/tasks/20']) {
    assert.equal(parseRoute(p), null, p);
  }
});

// ---------- which boards a server holds ----------

test('keyBoards gives every board a URL-safe key and folds duplicate checkouts into one', () => {
  const c = (nameWithOwner, board, root) => ({ repo: { nameWithOwner }, board, root });
  const boards = keyBoards([
    c('o/a', 'default', '/one'),
    c('o/b', 'default', '/two'),
    c('o/a', 'release', '/one'),
    c('o/a', 'default', '/a-second-checkout'), // same repo, same board: one board, one query
  ]);
  assert.deepEqual(boards.map((b) => b.key), ['o~a~default', 'o~b~default', 'o~a~release']);
  assert.deepEqual(boards.map((b) => b.root), ['/one', '/two', '/one']);
});

/** A checkout `hkb init` would have produced: enough of `.kanban/board.json` for a context. */
function fakeCheckout(nameWithOwner, board = 'default') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-repo-'));
  fs.mkdirSync(path.join(root, '.kanban', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ version: 1, repo: nameWithOwner, board }));
  return root;
}

test('--repos adds checkouts to the one you ran in, and refuses a path that is not a board', () => {
  const here = { root: '/here', repo: { nameWithOwner: 'o/here' }, board: 'default' };
  const other = fakeCheckout('o/other');
  const ctxs = serveContexts(here, { repos: other });
  assert.deepEqual(ctxs.map((c) => c.repo.nameWithOwner), ['o/here', 'o/other']);
  assert.equal(ctxs[1].board, 'default');
  // `#slug` picks a board inside that checkout
  assert.equal(serveContexts(here, { repos: `${other}#release` })[1].board, 'release');

  const gone = path.join(other, 'nope');
  assert.throws(() => serveContexts(here, { repos: gone }), /does not exist/);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-bare-'));
  assert.throws(() => serveContexts(here, { repos: bare }), /hkb init/);
  assert.throws(() => serveContexts(here, { repos: true }), /--repos needs a value/);
});

test('the user-level list is read when no flag is given, and a stale entry is skipped, not fatal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-cfg-'));
  const kept = process.env.KB_CONFIG_HOME;
  process.env.KB_CONFIG_HOME = home;
  try {
    const here = { root: '/here', repo: { nameWithOwner: 'o/here' }, board: 'default' };
    assert.deepEqual(serveContexts(here, {}).map((c) => c.repo.nameWithOwner), ['o/here']); // no file: opt-in
    const other = fakeCheckout('o/other');
    fs.mkdirSync(path.join(home, 'hkb'), { recursive: true });
    fs.writeFileSync(path.join(home, 'hkb', 'boards.json'), JSON.stringify({ version: 1, boards: [other, '/gone/for/good'] }));
    const notes = [];
    const ctxs = serveContexts(here, {}, (s) => notes.push(s));
    assert.deepEqual(ctxs.map((c) => c.repo.nameWithOwner), ['o/here', 'o/other']);
    assert.match(notes.join('\n'), /skipping "\/gone\/for\/good".*does not exist/);
    // an explicit --repos wins over the list
    const third = fakeCheckout('o/third');
    assert.deepEqual(serveContexts(here, { repos: third }).map((c) => c.repo.nameWithOwner), ['o/here', 'o/third']);
  } finally {
    if (kept === undefined) delete process.env.KB_CONFIG_HOME; else process.env.KB_CONFIG_HOME = kept;
  }
});

// ---------- the list is live ----------
// A board added to `boards.json` while the server runs is served without a restart — and a board that
// was already there keeps its cache, which is the whole difference between a reload and a restart.

/**
 * A server whose board list is the real user-level file, with a clock the test moves by hand.
 * Nothing is injected but the reads: `serveContexts` resolves the temp checkouts for real.
 */
async function withLiveServer(fn, flags = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-cfg-'));
  const kept = process.env.KB_CONFIG_HOME;
  process.env.KB_CONFIG_HOME = home;
  fs.mkdirSync(path.join(home, 'hkb'), { recursive: true });
  const file = path.join(home, 'hkb', 'boards.json');
  const writeList = (boards) => fs.writeFileSync(file, JSON.stringify({ version: 1, boards }));
  const raw = (text) => fs.writeFileSync(file, text);

  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-here-'));
  fs.mkdirSync(path.join(here, '.kanban', 'logs'), { recursive: true });
  const ctx = { root: here, repo: { owner: 'o', repo: 'here', nameWithOwner: 'o/here' }, board: 'default', host: 'testhost', _cache: {}, cfg: {} };

  const fetched = []; // one entry per fetchBoard call, so "was this board refetched?" is assertable
  const cards = new Map(); // root -> the tasks that board answers with
  const notes = [];
  let clock = Date.now();
  const deps = {
    // deliberately no `contexts` seam — the list is resolved from boards.json the way `hkb serve` does
    now: () => clock,
    fetchBoard: async (c) => { fetched.push(c.root); return cards.get(c.root) || []; },
    getTask: async (c, n) => task({ number: n }),
    loadRun: async () => ({ run: { failures: 0, attempts: [] } }),
    latestResult: async () => null,
    parentResults: async () => [],
  };
  const s = await startServer(ctx, { port: 0, poll: 30, ...flags }, (m) => notes.push(m), deps);
  const get = (p, opts) => fetch(s.url + p, opts);
  const keysOf = async () => (await (await get('/api/board')).json()).boards.map((b) => b.key);
  try {
    await fn({
      ...s, get, keysOf, notes, fetched, cards, writeList, raw, here,
      tick: () => { clock += 60_000; }, // past the poll interval: the next request re-reads the list
    });
  } finally {
    await new Promise((r) => s.server.close(r));
    if (kept === undefined) delete process.env.KB_CONFIG_HOME; else process.env.KB_CONFIG_HOME = kept;
  }
}

test('a board added to boards.json is served without restarting hkb serve', async () => {
  await withLiveServer(async ({ keysOf, cards, writeList, tick, notes }) => {
    writeList([]);
    assert.deepEqual(await keysOf(), ['o~here~default']);

    const other = fakeCheckout('o/other');
    cards.set(other, [task({ number: 7 })]);
    writeList([other]);
    assert.deepEqual(await keysOf(), ['o~here~default'], 'not before the poll interval is up');

    tick();
    assert.deepEqual(await keysOf(), ['o~here~default', 'o~other~default']);
    assert.match(notes.join('\n'), /board list changed: \+o~other~default — now 2 boards/);
  });
});

test('a new board is addressable at once, and a removed one stops being served', async () => {
  await withLiveServer(async ({ keysOf, get, cards, writeList, tick, notes }) => {
    const other = fakeCheckout('o/other');
    cards.set(other, [task({ number: 7 })]);
    writeList([other]);
    tick();
    assert.deepEqual(await keysOf(), ['o~here~default', 'o~other~default']);
    assert.equal((await get('/api/boards/o~other~default/tasks/7')).status, 200);

    writeList([]);
    tick();
    assert.deepEqual(await keysOf(), ['o~here~default']);
    // the board is gone from the router too, and its cache went with it
    const gone = await get('/api/boards/o~other~default/tasks/7');
    assert.equal(gone.status, 404);
    assert.match((await gone.json()).error, /no board "o~other~default"/);
    assert.match(notes.join('\n'), /board list changed: -o~other~default — now 1 board \(/);
  });
});

test('a board that survives a reload keeps its cache: no board is refetched to add another', async () => {
  await withLiveServer(async ({ keysOf, get, cards, writeList, tick, fetched, here }) => {
    const other = fakeCheckout('o/other');
    cards.set(here, [task()]);
    cards.set(other, [task({ number: 7 })]);
    writeList([other]);
    tick();
    assert.deepEqual(await keysOf(), ['o~here~default', 'o~other~default']);
    assert.deepEqual(fetched, [here, other]); // one read each

    const third = fakeCheckout('o/third');
    cards.set(third, [task({ number: 9 })]);
    writeList([other, third]);
    tick();
    const body = await (await get('/api/board')).json();
    assert.deepEqual(body.boards.map((b) => b.key), ['o~here~default', 'o~other~default', 'o~third~default']);
    assert.deepEqual(fetched, [here, other, third], 'only the board that appeared was read');
    // and the boards that were there still carry the cards they had
    assert.deepEqual(body.boards.map((b) => b.tasks.map((t) => t.number)), [[20], [7], [9]]);
  });
});

test('a stale entry is logged once, not once per reload', async () => {
  await withLiveServer(async ({ keysOf, writeList, tick, notes }) => {
    writeList(['/gone/for/good']);
    tick();
    for (let i = 0; i < 4; i++) { await keysOf(); tick(); }
    const skips = notes.filter((m) => m.startsWith('skipping "/gone/for/good"'));
    assert.equal(skips.length, 1, notes.join('\n'));
    assert.match(skips[0], /does not exist/);
  });
});

test('an unreadable boards.json says so once and keeps the boards the server holds', async () => {
  await withLiveServer(async ({ keysOf, raw, tick, notes }) => {
    const other = fakeCheckout('o/other');
    raw(JSON.stringify({ version: 1, boards: [other] }));
    tick();
    assert.deepEqual(await keysOf(), ['o~here~default', 'o~other~default']);
    raw('{"version": 1, "boards": [');
    for (let i = 0; i < 3; i++) { tick(); assert.deepEqual(await keysOf(), ['o~here~default', 'o~other~default']); }
    assert.equal(notes.filter((m) => m.startsWith('board list:')).length, 1);
    assert.match(notes.join('\n'), /board list:.*not valid JSON.*keeping the 2 board/);
  });
});

test('--repos is an explicit set for this run: it does not reload', async () => {
  const named = fakeCheckout('o/named');
  await withLiveServer(async ({ keysOf, cards, writeList, tick, notes }) => {
    cards.set(named, [task({ number: 7 })]);
    assert.deepEqual(await keysOf(), ['o~here~default', 'o~named~default']);
    const other = fakeCheckout('o/other');
    writeList([other]);
    tick();
    assert.deepEqual(await keysOf(), ['o~here~default', 'o~named~default']);
    assert.equal(notes.some((m) => m.startsWith('board list changed')), false);
  }, { repos: named });
});

test('isLoopback knows what is safe to bind without auth', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.53']) assert.equal(isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '192.168.1.4', 'example.com']) assert.equal(isLoopback(h), false, h);
});

test('checkOrigin refuses DNS rebinding and cross-origin calls', () => {
  assert.equal(checkOrigin({ host: 'localhost:4666' }).ok, true);
  assert.equal(checkOrigin({ host: 'localhost:4666', origin: 'http://localhost:4666' }).ok, true);
  assert.match(checkOrigin({ host: 'evil.test:4666' }).reason, /not loopback/);
  assert.match(checkOrigin({ host: 'localhost:4666', origin: 'https://evil.test' }).reason, /cross-origin/);
  assert.match(checkOrigin({ host: 'localhost:4666', origin: 'http://127.0.0.1:4666' }).reason, /cross-origin/);
  // --host 0.0.0.0 drops the Host guard (the user was warned), but same-origin still holds
  assert.equal(checkOrigin({ host: '192.168.1.4:4666' }, { loopback: false }).ok, true);
  assert.match(checkOrigin({ host: '192.168.1.4:4666', origin: 'http://evil.test' }, { loopback: false }).reason, /cross-origin/);
});

test('missingFields only complains about blank strings', () => {
  assert.deepEqual(missingFields(['reason'], { reason: 'why' }), []);
  assert.deepEqual(missingFields(['reason'], { reason: '  ' }), ['reason']);
  assert.deepEqual(missingFields(['reason', 'kind'], {}), ['reason', 'kind']);
  assert.deepEqual(missingFields(undefined, {}), []);
});

// ---------- worker logs ----------

test('logPathFor stays inside .kanban/logs whatever the run record says', () => {
  const root = '/repo';
  assert.equal(logPathFor(root, { attempts: [] }, 7, 1), path.resolve(root, '.kanban/logs/7-1.log'));
  assert.equal(logPathFor(root, { attempts: [{ attempt: 1, log: '.kanban/logs/7-1.log' }] }, 7, 1), path.resolve(root, '.kanban/logs/7-1.log'));
  assert.equal(logPathFor(root, { attempts: [{ attempt: 1, log: '../../etc/passwd' }] }, 7, 1), null);
  assert.equal(logPathFor(root, { attempts: [{ attempt: 1, log: '/etc/passwd' }] }, 7, 1), null);
});

test('tailFile returns the tail, ANSI-free, and null for a log that does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-log-'));
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, 'start\n[32mgreen[0m\nend\n');
  const t = tailFile(f, 1000);
  assert.equal(t.text, 'start\ngreen\nend\n');
  assert.equal(t.truncated, false);
  assert.equal(tailFile(path.join(dir, 'missing.log')), null);
  assert.equal(tailFile(f, 4).truncated, true);
});

// ---------- the shipped page ----------
// There is no build step, so nothing but this test stands between a typo and a blank board.

const PAGE = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const PAGE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1];

test('the board page parses and ships exactly one inline script', () => {
  assert.equal((PAGE.match(/<script/g) || []).length, 1);
  assert.ok(PAGE_SCRIPT && PAGE_SCRIPT.length > 1000);
  new vm.Script(PAGE_SCRIPT, { filename: 'web/index.html' }); // throws on a syntax error
});

test('the page is self-contained: no build step, no CDN, no external asset', () => {
  assert.equal(/<script[^>]+src=/.test(PAGE), false);
  assert.equal(/<link[^>]+href=["']https?:/.test(PAGE), false);
  assert.equal(/(src|href)=["']\/\//.test(PAGE), false);
  for (const m of PAGE.matchAll(/(?:src|href)=["'](https?:[^"']+)["']/g)) assert.fail(`external asset ${m[1]}`);
});

test('the page draws the columns the server serves', () => {
  const cols = /const COLS = \[([^\]]+)\]/.exec(PAGE_SCRIPT)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(cols, COLUMNS);
});

/**
 * Just enough DOM to run the page: every node memoizes its children by selector, nothing renders.
 * Listeners are kept and `fire()` calls them, so a drag can be replayed the way a browser would.
 */
function fakeDom() {
  const make = () => {
    const q = {};
    const on = {};
    const n = {
      children: [], dataset: {}, attrs: {}, style: { setProperty() {} }, listeners: on,
      textContent: '', className: '', scrollTop: 0, scrollHeight: 0, href: '', title: '', hidden: false,
      classList: {
        s: new Set(), add(...c) { c.forEach((x) => this.s.add(x)); }, remove(...c) { c.forEach((x) => this.s.delete(x)); },
        toggle(c, o) { if (o) this.s.add(c); else this.s.delete(c); }, contains(c) { return this.s.has(c); },
      },
      append(...c) { n.children.push(...c); }, prepend(...c) { n.children.unshift(...c); },
      addEventListener(type, fn) { (on[type] = on[type] || []).push(fn); },
      fire(type, ev = {}) { for (const fn of on[type] || []) fn({ preventDefault() {}, stopPropagation() {}, target: n, ...ev }); },
      setAttribute(k, v) { n.attrs[k] = v; }, remove() {}, focus() {}, closest() { return null; },
      contains() { return false; }, querySelectorAll() { return []; },
      querySelector(s) { return (q[s] ||= make()); },
    };
    let html = '';
    Object.defineProperty(n, 'innerHTML', { get: () => html, set: (v) => { html = v; n.children.length = 0; } });
    return n;
  };
  const roots = {};
  return {
    createElement: () => ({ set innerHTML(v) { this.v = v; }, get content() { const e = make(); e.innerHTML = this.v; e.firstElementChild = e; return e; } }),
    querySelector: (s) => (roots[s] ||= make()),
    querySelectorAll: () => [], addEventListener() {}, body: {}, title: '', hidden: true,
  };
}

const boardPayload = (boards) => ({ columns: COLUMNS, poll: 30, host: 'testhost', fetched_at: new Date().toISOString(), boards });
const oneBoard = (tasks, over = {}) => ({
  key: 'o~r~default', repo: 'o/r', board: 'default', root: '/repo',
  dispatcher: { running: true, pid: 42 }, error: null, stale: false, tasks, ...over,
});

/** Load the page into a vm, with `fetch` answered from `routes`, keyed by exact path. */
function loadPage(document, routes, calls = []) {
  const fetch = async (p, opts) => {
    const pathname = String(p).split('?')[0];
    calls.push({ path: pathname, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
    const body = routes[pathname] || { error: `no fake route for ${pathname}` };
    return { ok: !!routes[pathname], status: routes[pathname] ? 200 : 404, headers: { get: () => '"e1"' }, text: async () => JSON.stringify(body) };
  };
  const ctx = vm.createContext({ document, console, fetch, setTimeout: () => 0, setInterval: () => 0 });
  vm.runInContext(PAGE_SCRIPT, ctx, { filename: 'web/index.html' });
  return { ctx, calls };
}

const colBody = (document, col) => document.querySelector('.col[data-col="' + col + '"]').querySelector('[data-body]').children;

test('the page renders a board payload without touching the DOM it does not have', async () => {
  const document = fakeDom();
  const payload = boardPayload([oneBoard([cardOf(task()), cardOf(task({ number: 21, status: 'running' }))])]);
  const { ctx } = loadPage(document, { '/api/board': payload });
  await ctx.refresh(true);

  assert.equal(colBody(document, 'ready').length, 1);
  assert.equal(colBody(document, 'running').length, 1);
  assert.equal(colBody(document, 'done').length, 1); // the "—" placeholder
  assert.match(colBody(document, 'ready')[0].innerHTML, /#20/);
  assert.match(colBody(document, 'ready')[0].innerHTML, /hkb serve/);
  // one board looks exactly like it always did: no board bar, the repo and its dispatcher in the header
  assert.equal(document.querySelector('#repo').textContent, 'o/r · board "default"');
  assert.equal(document.querySelector('#boards').hidden, true);
  assert.equal(document.querySelector('#board-errors').hidden, true);
  assert.match(document.querySelector('#dispatcher').querySelector('span').textContent, /dispatcher up \(pid 42\)/);
});

test('two boards share the seven columns, and every card says which repo it is from', async () => {
  const document = fakeDom();
  const payload = boardPayload([
    oneBoard([cardOf(task())]),
    oneBoard([cardOf(task({ number: 20, status: 'ready', title: 'other repo, same number' }))],
      { key: 'o~other~default', repo: 'o/other', root: '/other', dispatcher: { running: false, pid: null } }),
  ]);
  const { ctx } = loadPage(document, { '/api/board': payload });
  await ctx.refresh(true);

  const ready = colBody(document, 'ready');
  assert.equal(ready.length, 2); // #20 on two boards is two cards
  assert.deepEqual(ready.map((c) => c.dataset.card), ['o~r~default#20', 'o~other~default#20']);
  assert.match(ready[0].innerHTML, /chip repo[^>]*>r</);
  assert.match(ready[1].innerHTML, /chip repo[^>]*>other</);
  // the header stops naming one repo, and the board bar appears with a chip per board (plus "All")
  assert.equal(document.querySelector('#repo').textContent, '2 boards');
  assert.equal(document.querySelector('#boards').hidden, false);
  assert.equal(document.querySelector('#boards').children.length, 3);
  // one dispatcher up, one not — visible per board
  assert.equal(document.querySelector('#dispatcher').querySelector('span').textContent, 'dispatchers 1/2');
  assert.match(document.querySelector('#boards').children[1].innerHTML, /class="dot on"/);
  assert.match(document.querySelector('#boards').children[2].innerHTML, /class="dot"/);
});

test('a board that failed to read says so and never blanks the others', async () => {
  const document = fakeDom();
  const payload = boardPayload([
    oneBoard([cardOf(task())]),
    oneBoard([], { key: 'o~other~default', repo: 'o/other', error: 'gh: HTTP 401 (auth)', stale: false }),
  ]);
  const { ctx } = loadPage(document, { '/api/board': payload });
  await ctx.refresh(true);
  assert.equal(colBody(document, 'ready').length, 1); // the healthy board still renders
  assert.equal(document.querySelector('#board-errors').hidden, false);
  assert.match(document.querySelector('#board-errors').innerHTML, /o\/other — gh: HTTP 401/);
});

test('a card dragged in one board runs its verb against that board, never the other', async () => {
  const document = fakeDom();
  const payload = boardPayload([
    oneBoard([cardOf(task({ status: 'todo' }))]),
    oneBoard([cardOf(task({ number: 20, status: 'todo' }))], { key: 'o~other~default', repo: 'o/other', root: '/other' }),
  ]);
  const calls = [];
  const { ctx } = loadPage(document, {
    '/api/board': payload,
    '/api/boards/o~other~default/tasks/20/move': { ok: true, number: 20, status: 'ready', key: 'o~other~default' },
  }, calls);
  await ctx.refresh(true);

  // the second card in Todo is the second board's #20 — drag it, exactly as a browser would
  const card = colBody(document, 'todo')[1];
  assert.equal(card.dataset.card, 'o~other~default#20');
  const dt = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k]; } };
  card.fire('dragstart', { dataTransfer: dt });
  assert.equal(dt.data['text/plain'], 'o~other~default#20');
  // the drop lands on the column element the page built, which is the one carrying the drop listener
  const cols = document.querySelector('#board').children;
  cols[COLUMNS.indexOf('ready')].fire('drop', { dataTransfer: dt });
  await new Promise((r) => setImmediate(r));

  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => c.path), ['/api/boards/o~other~default/tasks/20/move']);
  assert.deepEqual(posts[0].body, { to: 'ready' });
  assert.equal(calls.some((c) => c.path.includes('o~r~default')), false); // the other repo was never touched
});

/** The page's top-level functions, with no network — for everything it renders purely. */
function pageCtx() {
  const ctx = vm.createContext({ document: fakeDom(), console, fetch: async () => { throw new Error('offline'); }, setTimeout: () => 0, setInterval: () => 0 });
  vm.runInContext(PAGE_SCRIPT, ctx, { filename: 'web/index.html' });
  return ctx;
}

test('issue bodies are escaped, linked and never able to inject markup', () => {
  const ctx = pageCtx();
  const html = ctx.mdLite('<img src=x onerror=alert(1)> see https://ex.com/a?b=1&c=2, then #14 and `code`');
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="https:\/\/ex\.com\/a\?b=1&amp;c=2"/); // the whole query string, comma trimmed
  assert.match(html, /data-open="14"/);
  assert.match(html, /<code>code<\/code>/);
  const card = ctx.cardHtml({ number: 20, title: '</div><script>x', agent: 'claude', priority: 1, blockedBy: [], prs: [], needsHuman: true });
  assert.equal(card.includes('<script>'), false);
  assert.match(card, /needs human/);
});

// ---------- the drawer's dependency subgraph ----------
// The picture is a layout over the cards /api/board already carries, so it is assertable the way the
// rest of the page is: in the vm, without a DOM, over cards that went through the real `cardOf`.

/** A card exactly as the board serves it — the blockers go through `cardOf`, as /api/board does. */
const boardCard = (number, status, blockedBy = [], over = {}) =>
  cardOf(task({ number, status, title: 'task ' + number, blockedBy, ...over }));
const openIssue = (n) => ({ number: n, title: 'task ' + n, state: 'OPEN', stateReason: null });
const closedIssue = (n) => ({ number: n, title: 'groundwork', state: 'CLOSED', stateReason: null });

/**
 * A diamond: #1 waits on #2 and #3, which both wait on #4. #4 is closed, so it is not a card on the
 * board at all — it exists only as the stub the two cards that name it carry.
 */
const diamond = () => [
  boardCard(1, 'todo', [openIssue(2), openIssue(3)]),
  boardCard(2, 'running', [closedIssue(4)]),
  boardCard(3, 'review', [closedIssue(4)]),
];

test('a diamond on the board comes out of depGraph as four nodes, four edges and three layers', () => {
  const g = pageCtx().depGraph(diamond(), 1);
  // the page's arrays come out of the vm realm, so they are spread into this one to be compared
  assert.deepEqual([...g.nodes].map((x) => x.n).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual([...g.edges].map((e) => e.from + '>' + e.to).sort(), ['1>2', '1>3', '2>4', '3>4']);
  // longest-path layering: the root of the track on top, the shared blocker below both middles
  assert.deepEqual(Object.fromEntries([...g.nodes].map((x) => [x.n, x.layer])), { 1: 0, 2: 1, 3: 1, 4: 2 });
  assert.deepEqual([...g.rows].map((r) => r.length), [1, 2, 1]);
  assert.notEqual(g.rows[1][0].x, g.rows[1][1].x); // the two middles share a row, not a column
  assert.equal(g.rows[0][0].y < g.rows[2][0].y, true);
  assert.equal(g.incomplete, false);
  assert.equal(g.truncated, false);
});

test('the same picture is reached from either end, and a closed blocker is a node, not a hole', () => {
  const g = pageCtx().depGraph(diamond(), 4); // opened on the blocker that is no card on this board
  assert.deepEqual([...g.nodes].map((x) => x.n).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(g.edges.length, 4);
  const four = [...g.nodes].find((x) => x.n === 4);
  assert.deepEqual([four.onBoard, four.done, four.status, four.focus, four.layer], [false, true, 'done', true, 2]);
});

test('nothing is drawn for a card with no blockers and nothing waiting on it', () => {
  const ctx = pageCtx();
  assert.equal(ctx.depGraph([boardCard(9, 'ready')], 9), null);
  assert.equal(ctx.depGraph(diamond(), 99), null); // a number no card on the board mentions
  assert.equal(ctx.graphSvg(null), '');
});

test('every node in the SVG opens its card through the handler the drawer already has', () => {
  const ctx = pageCtx();
  const svg = ctx.graphSvg(ctx.depGraph(diamond(), 1));
  assert.equal((svg.match(/data-open="/g) || []).length, 4); // one anchor per node, no second open path
  assert.equal((svg.match(/<path class="e"/g) || []).length, 4);
  assert.match(svg, /class="n focus"[^>]*data-open="1"/);
  assert.match(svg, /class="n done"[^>]*data-open="4"/);
  assert.match(svg, /#4 ✓/);
  // the columns' own palette, no second one
  for (const c of ['todo', 'running', 'review', 'done']) assert.match(svg, new RegExp('var\\(--' + c + '\\)'));
  // a title is still a title: it goes through esc on its way into the tooltip
  const evil = ctx.graphSvg(ctx.depGraph([
    boardCard(1, 'todo', [openIssue(2)]), boardCard(2, 'ready', [], { title: '</title><img src=x onerror=alert(1)>' }),
  ], 1));
  assert.equal(/<img|<\/title>\s*<img/.test(evil), false);
  assert.match(evil, /&lt;img/);
});

test('when the board can only have some of the edges, the graph says so instead of lying', () => {
  const ctx = pageCtx();
  // the REST-fallback fingerprint (src/tasks.js fills todo/blocked cards only): edges exist, and
  // every card that carries one is todo or blocked — so the closed blockers of the rest are missing
  const g = ctx.depGraph([boardCard(1, 'todo', [openIssue(2)]), boardCard(2, 'running'), boardCard(3, 'review')], 1);
  assert.equal(g.incomplete, true);
  assert.match(ctx.graphSvg(g), /REST fallback/);
  assert.equal(ctx.depGraph(diamond(), 1).incomplete, false); // #2 is running and carries its blocker
});

test('a fan-out too wide to read is capped, and the note says the picture is not all of it', () => {
  const ctx = pageCtx();
  const kids = Array.from({ length: 60 }, (_, i) => openIssue(i + 2));
  const g = ctx.depGraph([boardCard(1, 'todo', kids)].concat(kids.map((k) => boardCard(k.number, 'todo'))), 1);
  assert.equal(g.nodes.length, 40);
  assert.equal(g.truncated, true);
  assert.match(ctx.graphSvg(g), /Showing the 40 tasks nearest #1/);
});

test('a dependency cycle is drawn, not hung on', () => {
  const g = pageCtx().depGraph([boardCard(1, 'todo', [openIssue(2)]), boardCard(2, 'blocked', [openIssue(1)])], 1);
  assert.deepEqual([...g.nodes].map((x) => x.n), [1, 2]);
  assert.equal(g.edges.length, 2);
  assert.deepEqual([...g.rows].map((r) => r.length), [1, 1]); // no blank band where a layer was skipped
});

test('the drawer draws the subgraph above Blocked by, from the board payload and nothing else', async () => {
  const document = fakeDom();
  const payload = boardPayload([oneBoard(diamond(), { key: 'o~r~default' })]);
  const detail = { ...diamond()[0], key: 'o~r~default', repo: 'o/r', board: 'default', bodyText: '', kb: {}, labels: [], run: { attempts: [] }, result: null, parents: [], logs: [] };
  const calls = [];
  const { ctx } = loadPage(document, { '/api/board': payload, '/api/boards/o~r~default/tasks/1': detail }, calls);
  await ctx.refresh(true);
  await ctx.openDrawer('o~r~default', 1);

  const html = document.querySelector('#d-body').innerHTML;
  assert.match(html, /<h3>Dependencies<\/h3><svg class="graph"/);
  assert.equal(html.indexOf('<svg class="graph"') < html.indexOf('Blocked by'), true);
  assert.equal((html.match(/data-open="2"/g) || []).length, 2); // the graph node and the blocker link
  assert.equal((html.match(/data-open="4"/g) || []).length, 1); // only the graph reaches the closed one
  // the drawer read the board it already had: no extra route was called for the picture
  assert.deepEqual([...new Set(calls.map((c) => c.path))], ['/api/board', '/api/boards/o~r~default/tasks/1']);
});

// ---------- the HTTP surface ----------

/**
 * One board's worth of context and injected deps. Every recorded call carries the repo it ran
 * against — that is what makes "the verb landed on the right board" assertable, not eyeballable.
 */
function fixture(tasks, { owner = 'o', repo = 'r', board = 'default', calls = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-serve-'));
  fs.mkdirSync(path.join(root, '.kanban', 'logs'), { recursive: true });
  const nameWithOwner = `${owner}/${repo}`;
  const ctx = { root, repo: { owner, repo, nameWithOwner }, board, host: 'testhost', _cache: {}, cfg: {} };
  const record = (verb) => (c, n, opts) => {
    calls.push({ verb, n, opts, repo: c.repo.nameWithOwner, root: c.root });
    return { number: n, status: verb === 'promote' ? 'ready' : 'blocked' };
  };
  const deps = {
    fetchBoard: async (c) => (c.root === root ? tasks : []),
    getTask: async (c, n) => (c.root === root ? tasks.find((t) => t.number === n) || task({ number: n }) : task({ number: n })),
    loadRun: async () => ({ run: { failures: 0, attempts: [{
      attempt: 1, profile: 'claude', started_at: '2026-08-26T06:52:38Z', log: '.kanban/logs/20-1.log',
      wt: 'kb-20-1', session_id: 'sess-abc', total_cost_usd: 1.5, num_turns: 12,
    }] } }),
    latestResult: async () => null,
    parentResults: async () => [],
    addComment: async (c, n, text) => { calls.push({ verb: 'comment', n, opts: { text }, repo: c.repo.nameWithOwner, root: c.root }); return { html_url: 'https://x/c' }; },
    promote: record('promote'), unblock: record('unblock'), block: record('block'),
    requestChanges: record('request-changes'), archive: record('archive'),
  };
  return { ctx, deps, root, calls };
}

/** A server over N fixtures, sharing one call log; deps come from the first, dispatch is per ctx. */
async function withServers(fixtures, fn) {
  const calls = [];
  const fs_ = fixtures.map((f) => f(calls));
  const merged = { ...fs_[0].deps, contexts: fs_.map((x) => x.ctx) };
  // every board answers from its own fixture, chosen by the ctx the server hands the dep
  const byRoot = new Map(fs_.map((x) => [x.ctx.root, x]));
  merged.fetchBoard = (c) => byRoot.get(c.root).deps.fetchBoard(c);
  merged.getTask = (c, n) => byRoot.get(c.root).deps.getTask(c, n);
  const s = await startServer(fs_[0].ctx, { port: 0, poll: 30 }, () => {}, merged);
  const get = (p, opts) => fetch(s.url + p, opts);
  const post = (p, body, opts = {}) => fetch(s.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(body),
  });
  try { await fn({ boards: fs_, calls, ...s, get, post }); } finally { await new Promise((r) => s.server.close(r)); }
}

async function withServer(tasks, fn) {
  await withServers([(calls) => fixture(tasks, { calls })], (s) => fn({ ...s, ...s.boards[0], root: s.boards[0].root }));
}

test('GET / serves the board page', async () => {
  await withServer([task()], async ({ get }) => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /hkb board/);
    assert.match(html, /api\/board/);
  });
});

test('GET /api/board returns the columns and 304s when nothing changed', async () => {
  await withServer([task(), task({ number: 21, status: 'running', kb: { priority: 0 } })], async ({ get }) => {
    const res = await get('/api/board');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.columns, COLUMNS);
    assert.equal(body.poll, 30);
    assert.equal(body.boards.length, 1);
    const b = body.boards[0];
    assert.equal(b.repo, 'o/r');
    assert.equal(b.board, 'default');
    assert.equal(b.key, 'o~r~default');
    assert.deepEqual(b.tasks.map((t) => t.number), [20, 21]); // priority 1 before priority 0
    assert.equal(b.dispatcher.running, false);
    assert.equal(b.error, null);
    const etag = res.headers.get('etag');
    assert.ok(etag);
    const again = await get('/api/board', { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
  });
});

test('GET /api/tasks/:n is the drawer: body, kb block, attempts, logs', async () => {
  await withServer([task()], async ({ get, root }) => {
    fs.writeFileSync(path.join(root, '.kanban', 'logs', '20-1.log'), 'hello worker\n');
    const t = await (await get('/api/tasks/20')).json();
    assert.equal(t.number, 20);
    assert.equal(t.bodyText, '## Why\nbecause');
    assert.equal(t.kb.priority, 1);
    assert.equal(t.run.attempts.length, 1);
    // the attempt row says what `hkb show` says, including how to attach to the worker
    assert.match(t.run.attempts[0].session, /sess-abc.*12 turns/);
    assert.equal(t.run.attempts[0].resume, 'cd .claude/worktrees/kb-20-1 && claude --resume sess-abc');
    assert.deepEqual(t.logs, [{ attempt: 1, path: path.join('.kanban', 'logs', '20-1.log'), exists: true }]);
    const log = await (await get('/api/tasks/20/log?attempt=1')).json();
    assert.equal(log.text, 'hello worker\n');
    assert.equal((await get('/api/tasks/20/log')).status, 400);
  });
});

test('a legal drag runs the CLI verb; an illegal one is refused with the reason', async () => {
  await withServer([task({ status: 'todo' })], async ({ post, calls }) => {
    const ok = await post('/api/tasks/20/move', { to: 'ready' });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls.map((c) => c.verb), ['promote']);
    const bad = await post('/api/tasks/20/move', { to: 'running' });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.refused, true);
    assert.match(body.error, /dispatcher/);
    assert.equal(calls.length, 1); // nothing was written
  });
});

test('a move that needs a reason asks for it instead of guessing one', async () => {
  await withServer([task({ status: 'ready' })], async ({ post, calls }) => {
    const need = await post('/api/tasks/20/move', { to: 'blocked' });
    assert.equal(need.status, 400);
    assert.deepEqual((await need.json()).needs, ['reason']);
    assert.equal(calls.length, 0);
    const done = await post('/api/tasks/20/move', { to: 'blocked', reason: 'needs the key' });
    assert.equal(done.status, 200);
    assert.deepEqual(calls.map(({ verb, n, opts }) => ({ verb, n, opts })),
      [{ verb: 'block', n: 20, opts: { reason: 'needs the key', kind: 'needs_input' } }]);
  });
});

test('triage → ready promotes twice, the way two `hkb promote` calls would', async () => {
  await withServer([task({ status: 'triage' })], async ({ post, calls }) => {
    assert.equal((await post('/api/tasks/20/move', { to: 'ready' })).status, 200);
    assert.deepEqual(calls.map((c) => c.verb), ['promote', 'promote']);
  });
});

test('the drawer verbs route to the same functions as the CLI', async () => {
  await withServer([task({ status: 'blocked' })], async ({ post, calls }) => {
    await post('/api/tasks/20/unblock', {});
    await post('/api/tasks/20/comment', { text: 'the key is in 1Password' });
    await post('/api/tasks/20/archive', {});
    assert.deepEqual(calls.map((c) => c.verb), ['unblock', 'comment', 'archive']);
    const bad = await post('/api/tasks/20/comment', {});
    assert.equal(bad.status, 400);
    assert.deepEqual((await bad.json()).needs, ['text']);
    assert.equal((await post('/api/tasks/20/frobnicate', {})).status, 400);
  });
});

// ---------- two repos, one server ----------
// #12 on two boards is two different tasks. Every assertion below is against the fake, not the eye.

const twoRepos = (a = [task({ status: 'todo' })], b = [task({ status: 'todo' })]) => [
  (calls) => fixture(a, { repo: 'a', calls }),
  (calls) => fixture(b, { repo: 'b', calls }),
];

test('GET /api/board carries every board, its own tasks and its own dispatcher', async () => {
  await withServers(twoRepos([task()], [task({ number: 7, status: 'running' })]), async ({ get, boards }) => {
    // a dispatcher loop on the first repo only
    fs.writeFileSync(path.join(boards[0].root, '.kanban', 'dispatch.pid'), String(process.pid));
    const body = await (await get('/api/board')).json();
    assert.deepEqual(body.boards.map((b) => b.key), ['o~a~default', 'o~b~default']);
    assert.deepEqual(body.boards.map((b) => b.repo), ['o/a', 'o/b']);
    assert.deepEqual(body.boards.map((b) => b.root), boards.map((x) => x.root));
    assert.deepEqual(body.boards.map((b) => b.tasks.map((t) => t.number)), [[20], [7]]);
    assert.deepEqual(body.boards.map((b) => b.dispatcher.running), [true, false]);
    assert.equal(body.boards[0].dispatcher.pid, process.pid);
  });
});

test('a verb runs against the board the card came from, and only that board', async () => {
  await withServers(twoRepos(), async ({ post, calls, boards }) => {
    const res = await post('/api/boards/o~b~default/tasks/20/move', { to: 'ready' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).key, 'o~b~default');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].verb, 'promote');
    assert.equal(calls[0].n, 20);
    assert.equal(calls[0].repo, 'o/b'); // never o/a, whose #20 is a different task
    assert.equal(calls[0].root, boards[1].root); // and the local state it touched is o/b's checkout

    await post('/api/boards/o~a~default/tasks/20/block', { reason: 'needs the key' });
    assert.deepEqual(calls.map((c) => [c.verb, c.repo]), [['promote', 'o/b'], ['block', 'o/a']]);
    // the drawer verbs route the same way
    await post('/api/boards/o~a~default/tasks/20/comment', { text: 'hi' });
    assert.equal(calls[2].repo, 'o/a');
  });
});

test('an unknown board key is a 404 that names the boards there are', async () => {
  await withServers(twoRepos(), async ({ post, get, calls }) => {
    const res = await post('/api/boards/o~c~default/tasks/20/promote', {});
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no board "o~c~default".*o~a~default, o~b~default/);
    assert.equal((await get('/api/boards/o~c~default/tasks/20')).status, 404);
    assert.equal(calls.length, 0); // nothing was written anywhere
  });
});

test('with several boards an unqualified task call is refused, not guessed', async () => {
  await withServers(twoRepos(), async ({ post, get, calls }) => {
    const res = await post('/api/tasks/20/promote', {});
    assert.equal(res.status, 400);
    const err = (await res.json()).error;
    assert.match(err, /ambiguous/);
    assert.match(err, /\/api\/boards\/<key>\/tasks\/20\/promote/);
    assert.match(err, /o~a~default, o~b~default/);
    assert.equal((await get('/api/tasks/20')).status, 400);
    assert.equal((await get('/api/tasks/20/log?attempt=1')).status, 400);
    assert.equal(calls.length, 0);
  });
});

test('the log tail reaches the file in the board the request names', async () => {
  await withServers(twoRepos(), async ({ get, boards }) => {
    for (const [i, b] of boards.entries()) fs.writeFileSync(path.join(b.root, '.kanban', 'logs', '20-1.log'), `log from repo ${i}\n`);
    const a = await (await get('/api/boards/o~a~default/tasks/20/log?attempt=1')).json();
    const b = await (await get('/api/boards/o~b~default/tasks/20/log?attempt=1')).json();
    assert.equal(a.text, 'log from repo 0\n');
    assert.equal(b.text, 'log from repo 1\n');
    assert.deepEqual([a.repo, b.repo], ['o/a', 'o/b']);
    // and the drawer names its own board, so a follow-up call cannot drift to the other one
    const detail = await (await get('/api/boards/o~b~default/tasks/20')).json();
    assert.equal(detail.key, 'o~b~default');
    assert.equal(detail.repo, 'o/b');
    assert.deepEqual(detail.logs, [{ attempt: 1, path: path.join('.kanban', 'logs', '20-1.log'), exists: true }]);
  });
});

test('a board that cannot be read keeps the others on the page', async () => {
  const boom = () => { throw Object.assign(new Error('gh: HTTP 401'), { kind: 'auth' }); };
  await withServers([
    (calls) => fixture([task()], { repo: 'a', calls }),
    (calls) => { const f = fixture([], { repo: 'b', calls }); f.deps.fetchBoard = boom; return f; },
  ], async ({ get }) => {
    const res = await get('/api/board');
    assert.equal(res.status, 200); // one broken repo is not a broken page
    const body = await res.json();
    assert.deepEqual(body.boards.map((b) => b.tasks.length), [1, 0]);
    assert.equal(body.boards[0].error, null);
    assert.match(body.boards[1].error, /HTTP 401/);
  });
});

test('no auth means the guards must hold: cross-origin, form posts and bad methods are refused', async () => {
  await withServer([task()], async ({ post, get, url, calls }) => {
    const cross = await post('/api/tasks/20/promote', {}, { headers: { origin: 'https://evil.test' } });
    assert.equal(cross.status, 403);
    // a form post needs no preflight, so content-type is a guard too
    const form = await fetch(url + '/api/tasks/20/promote', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'to=ready' });
    assert.equal(form.status, 415);
    assert.equal((await get('/api/tasks/20/promote')).status, 405);
    assert.equal((await get('/nope')).status, 404);
    assert.equal(calls.length, 0);
  });
});
