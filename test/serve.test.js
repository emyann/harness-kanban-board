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
  logPathFor, tailFile, missingFields, startServer,
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
  assert.deepEqual(parseRoute('/api/tasks/20'), { kind: 'task', number: 20 });
  assert.deepEqual(parseRoute('/api/tasks/20/log'), { kind: 'log', number: 20 });
  assert.deepEqual(parseRoute('/api/tasks/20/request-changes'), { kind: 'verb', number: 20, verb: 'request-changes' });
  for (const p of ['/api', '/api/tasks', '/api/tasks/x', '/../etc/passwd', '/api/tasks/20/log/2']) assert.equal(parseRoute(p), null, p);
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

/** Just enough DOM to run the page: every node memoizes its children by selector, nothing renders. */
function fakeDom() {
  const make = () => {
    const q = {};
    const n = {
      children: [], dataset: {}, attrs: {}, style: { setProperty() {} },
      textContent: '', className: '', scrollTop: 0, scrollHeight: 0, href: '',
      classList: {
        s: new Set(), add(...c) { c.forEach((x) => this.s.add(x)); }, remove(...c) { c.forEach((x) => this.s.delete(x)); },
        toggle(c, on) { if (on) this.s.add(c); else this.s.delete(c); }, contains(c) { return this.s.has(c); },
      },
      append(...c) { n.children.push(...c); }, prepend(...c) { n.children.unshift(...c); },
      addEventListener() {}, setAttribute(k, v) { n.attrs[k] = v; }, remove() {}, focus() {}, closest() { return null; },
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

test('the page renders a board payload without touching the DOM it does not have', async () => {
  const document = fakeDom();
  const payload = {
    repo: 'o/r', board: 'default', columns: COLUMNS, poll: 30, dispatcher: { running: true, pid: 42 },
    fetched_at: new Date().toISOString(), tasks: [cardOf(task()), cardOf(task({ number: 21, status: 'running' }))],
  };
  const res = { ok: true, status: 200, headers: { get: () => '"e1"' }, text: async () => JSON.stringify(payload) };
  const ctx = vm.createContext({ document, console, fetch: async () => res, setTimeout: () => 0, setInterval: () => 0 });
  vm.runInContext(PAGE_SCRIPT, ctx, { filename: 'web/index.html' });
  await ctx.refresh(true);

  const cards = (col) => document.querySelector('.col[data-col="' + col + '"]').querySelector('[data-body]').children;
  assert.equal(cards('ready').length, 1);
  assert.equal(cards('running').length, 1);
  assert.equal(cards('done').length, 1); // the "—" placeholder
  assert.match(cards('ready')[0].innerHTML, /#20/);
  assert.match(cards('ready')[0].innerHTML, /hkb serve/);
  assert.equal(document.querySelector('#repo').textContent, 'o/r · board "default"');
});

test('issue bodies are escaped, linked and never able to inject markup', () => {
  const ctx = vm.createContext({ document: fakeDom(), console, fetch: async () => { throw new Error('offline'); }, setTimeout: () => 0, setInterval: () => 0 });
  vm.runInContext(PAGE_SCRIPT, ctx, { filename: 'web/index.html' });
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

// ---------- the HTTP surface ----------

function fixture(tasks, calls = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-serve-'));
  fs.mkdirSync(path.join(root, '.kanban', 'logs'), { recursive: true });
  const ctx = { root, repo: { owner: 'o', repo: 'r', nameWithOwner: 'o/r' }, board: 'default', host: 'testhost', _cache: {}, cfg: {} };
  const record = (verb) => (_ctx, n, opts) => { calls.push({ verb, n, opts }); return { number: n, status: verb === 'promote' ? 'ready' : 'blocked' }; };
  const deps = {
    fetchBoard: async () => tasks,
    getTask: async (_c, n) => tasks.find((t) => t.number === n) || task({ number: n }),
    loadRun: async () => ({ run: { attempts: [{ attempt: 1, profile: 'claude', started_at: '2026-08-26T06:52:38Z', log: '.kanban/logs/20-1.log' }], failures: 0 } }),
    latestResult: async () => null,
    parentResults: async () => [],
    addComment: async (_c, n, text) => { calls.push({ verb: 'comment', n, opts: { text } }); return { html_url: 'https://x/c' }; },
    promote: record('promote'), unblock: record('unblock'), block: record('block'),
    requestChanges: record('request-changes'), archive: record('archive'),
  };
  return { ctx, deps, root, calls };
}

async function withServer(tasks, fn) {
  const f = fixture(tasks);
  const s = await startServer(f.ctx, { port: 0, poll: 30 }, () => {}, f.deps);
  const get = (p, opts) => fetch(s.url + p, opts);
  const post = (p, body, opts = {}) => fetch(s.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(body),
  });
  try { await fn({ ...f, ...s, get, post }); } finally { await new Promise((r) => s.server.close(r)); }
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
    assert.equal(body.repo, 'o/r');
    assert.deepEqual(body.columns, COLUMNS);
    assert.equal(body.poll, 30);
    assert.deepEqual(body.tasks.map((t) => t.number), [20, 21]); // priority 1 before priority 0
    assert.equal(body.dispatcher.running, false);
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
    assert.deepEqual(calls, [{ verb: 'block', n: 20, opts: { reason: 'needs the key', kind: 'needs_input' } }]);
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
