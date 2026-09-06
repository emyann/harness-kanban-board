import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-watch-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'board.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { watchEvents, watchWhere, eventLine } = await import('../src/watch.ts');

const db = openBoard();
const a = await db.board.create({ data: { slug: 'watched' } });
const b = await db.board.create({ data: { slug: 'elsewhere' } });
const job = await db.job.create({ data: { boardId: a.id, name: 'watched job', brief: 'b' } });
const other = await db.job.create({ data: { boardId: b.id, name: 'other job', brief: 'b' } });

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

const fire = (kind: string, o: { jobId?: number; boardId?: number } = {}) =>
  db.event.create({ data: { kind, actor: 'test', payload: {}, ...o } });

const latest = async () => (await db.event.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }))?.id ?? 0;

/** Run a watch that stops itself once it has `limit` events, or after `ms` whatever happened. */
async function collect(o: { after: number; scope?: Record<string, number>; limit?: number; ms?: number }) {
  const stop = new AbortController();
  const seen: { id: number; kind: string }[] = [];
  const timer = setTimeout(() => stop.abort(), o.ms ?? 1500);
  const cursor = await watchEvents({
    db, scope: o.scope ?? {}, after: o.after, dir, signal: stop.signal, limit: o.limit,
    intervalMs: 25,
    onEvent: (e) => seen.push({ id: e.id, kind: e.kind }),
  });
  clearTimeout(timer);
  return { seen, cursor };
}

// ---------------------------------------------------------------- the pure halves

test('a scope is one of three questions, and the board one has two shapes to cover', () => {
  assert.deepEqual(watchWhere({}), {}, 'every board on this machine');
  assert.deepEqual(watchWhere({ jobId: 7 }), { jobId: 7 });
  // `reclaimed` carries a jobId and no boardId; `daemon_up` carries the reverse. A board watch that
  // asked only for `boardId` would silently drop half its own stream.
  assert.deepEqual(watchWhere({ boardId: 3 }), { OR: [{ boardId: 3 }, { job: { boardId: 3 } }] });
  assert.deepEqual(watchWhere({ jobId: 7, boardId: 3 }), { jobId: 7 }, 'the narrower one wins');
});

test('a watch line leads with the id, because that id is what a consumer feeds back', () => {
  const e = {
    id: 412, at: new Date('2026-09-06T10:00:00.000Z'), kind: 'claimed',
    jobId: 5, boardId: 1, actor: 'host@fake', payload: { k: 2 },
  };
  const line = eventLine(e, true);
  assert.match(line, /^ *412 {2}2026-09-06T10:00:00\.000Z/, 'the id first, right-aligned, then the moment');
  assert.match(line, /#5 +claimed +host@fake +\{"k":2\}$/, 'then the Job, the kind, who did it, and the payload');
  assert.ok(!eventLine(e).startsWith(' '), '`hkb log` prints the same line without one');
  assert.match(eventLine({ ...e, jobId: null, payload: {} }, true), /—/, 'a board-level event has no Job to name');
});

// ---------------------------------------------------------------- the stream

test('everything written after the cursor arrives, in order, exactly once', async () => {
  const from = await latest();
  const run = collect({ after: from, scope: { boardId: a.id }, limit: 3 });
  await fire('one', { jobId: job.id });
  await fire('two', { boardId: a.id });
  await fire('three', { jobId: job.id });
  const { seen, cursor } = await run;

  assert.deepEqual(seen.map((e) => e.kind), ['one', 'two', 'three']);
  assert.deepEqual(seen.map((e) => e.id), [...seen].sort((x, y) => x.id - y.id).map((e) => e.id), 'in id order');
  assert.equal(cursor, seen[2].id, 'and the cursor is the last one emitted');
});

test('a watch that stops and one that resumes from its cursor see each event once', async () => {
  // The property the whole verb is for. A consumer that dies must be able to come back without
  // replaying what it already handled and without a hole where the events it missed should be.
  const from = await latest();
  const first = collect({ after: from, scope: { boardId: a.id }, limit: 2 });
  await fire('a', { jobId: job.id });
  await fire('b', { jobId: job.id });
  const one = await first;
  assert.deepEqual(one.seen.map((e) => e.kind), ['a', 'b']);

  // Written while nobody is watching at all — the gap a poller would lose.
  await fire('gap', { jobId: job.id });

  const second = collect({ after: one.cursor, scope: { boardId: a.id }, limit: 2 });
  await fire('c', { jobId: job.id });
  const two = await second;

  assert.deepEqual(two.seen.map((e) => e.kind), ['gap', 'c'], 'the gap is delivered, and nothing is repeated');
});

test('a board watch never sees another board — the scope is a filter, not a hint', async () => {
  const from = await latest();
  const run = collect({ after: from, scope: { boardId: a.id }, limit: 1, ms: 800 });
  await fire('not mine', { jobId: other.id });
  await fire('not mine either', { boardId: b.id });
  await fire('mine', { jobId: job.id });
  const { seen } = await run;
  assert.deepEqual(seen.map((e) => e.kind), ['mine']);
});

test('a Job watch is narrower still, and sees only its own', async () => {
  const from = await latest();
  const run = collect({ after: from, scope: { jobId: job.id }, limit: 1, ms: 800 });
  await fire('board level', { boardId: a.id });
  await fire('job level', { jobId: job.id });
  const { seen } = await run;
  assert.deepEqual(seen.map((e) => e.kind), ['job level'], 'a Job watch drops its own board’s events');
});

test('an event written just before the abort is still delivered, so the cursor means what it says', async () => {
  const from = await latest();
  const stop = new AbortController();
  const seen: number[] = [];
  const run = watchEvents({
    db, scope: { boardId: a.id }, after: from, dir, signal: stop.signal, intervalMs: 10_000,
    onEvent: (e) => seen.push(e.id),
  });
  // The race: written while the loop is parked on its (very long) fallback wait, then aborted. A
  // watch that returned on the abort without reading again would report a cursor covering an event
  // it never emitted — and the next watch, resuming from it, would skip that event for ever.
  await new Promise((r) => setTimeout(r, 50));
  const e = await fire('last gasp', { jobId: job.id });
  stop.abort();
  const cursor = await run;

  assert.ok(seen.includes(e.id), 'delivered on the way out');
  assert.equal(cursor, e.id);
});

test('the fallback interval alone delivers everything, for a filesystem that cannot watch', async () => {
  // `fs.watch` is a hint. Pointed at a directory the board is not in, nothing will ever poke the
  // latch — so what arrives here arrives because of the timer, which is the guarantee.
  const blind = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-blind-'));
  const from = await latest();
  const stop = new AbortController();
  const seen: string[] = [];
  const timer = setTimeout(() => stop.abort(), 2000);
  const run = watchEvents({
    db, scope: { boardId: a.id }, after: from, dir: blind, signal: stop.signal, limit: 1,
    intervalMs: 30,
    onEvent: (e) => seen.push(e.kind),
  });
  await fire('by the timer', { jobId: job.id });
  await run;
  clearTimeout(timer);
  fs.rmSync(blind, { recursive: true, force: true });
  assert.deepEqual(seen, ['by the timer']);
});

test('catching up from zero replays the whole stream and stops at the end', async () => {
  const all = await db.event.count({ where: { OR: [{ boardId: a.id }, { job: { boardId: a.id } }] } });
  const { seen, cursor } = await collect({ after: 0, scope: { boardId: a.id }, ms: 400 });
  assert.equal(seen.length, all, 'an old cursor never expires — events are append-only');
  assert.equal(cursor, await latest() > 0 ? seen[seen.length - 1].id : 0);
});

test('the filesystem watch is what makes it fast, and it is not silently inert', async () => {
  // The fallback interval is the guarantee; `fs.watch` is the speed, and an optimisation nobody
  // measures is one that can stop working without anyone noticing. So this pins it: with a fallback
  // 30 seconds away, an event that arrives in under two is one the filesystem told us about.
  const from = await latest();
  const stop = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => stop.abort(), 5_000);
  const run = watchEvents({
    db, scope: { boardId: a.id }, after: from, dir, signal: stop.signal, limit: 1,
    intervalMs: 30_000,
    onEvent: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));
  await fire('woken by the filesystem', { jobId: job.id });
  await run;
  clearTimeout(timer);
  const took = Date.now() - started;
  assert.ok(took < 2_000,
    `took ${took}ms with a 30s fallback — either fs.watch is inert or this filesystem cannot report changes`);
});
