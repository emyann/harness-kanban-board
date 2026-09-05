import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A scratch database per run, migrated the same way production is.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-ctl-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { reconcile, reconcileToRest, nextPhase } = await import('../src/controller.ts');
const { fakeRuntime } = await import('../src/runtime/fake.ts');
const { admissionCallback } = await import('../src/admission.ts');

const db = openBoard();
const board = await db.board.upsert({ where: { slug: 'test' }, update: {}, create: { slug: 'test' } });
const cwd = REPO;

const mkJob = (name: string, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId: board.id, name, brief: `do ${name}`, ...extra } });

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the pure decision

test('nextPhase: a completed run succeeds and is not resumable', () => {
  const d = nextPhase({ status: 'completed' } as never, 1, 2);
  assert.equal(d.phase, 'succeeded');
  assert.equal(d.resumable, false);
});

test('nextPhase: a turn cap is resumable and retries while budget remains', () => {
  const d = nextPhase({ status: 'max_turns' } as never, 1, 2);
  assert.equal(d.phase, 'pending');
  assert.equal(d.outcome, 'max_turns');
  assert.equal(d.resumable, true, 'a turn cap left a session worth continuing');
});

test('nextPhase: maxRetries 2 means three attempts, then failed', () => {
  assert.equal(nextPhase({ status: 'crashed' } as never, 1, 2).phase, 'pending');
  assert.equal(nextPhase({ status: 'crashed' } as never, 2, 2).phase, 'pending');
  assert.equal(nextPhase({ status: 'crashed' } as never, 3, 2).phase, 'failed', 'out of retries');
});

test('nextPhase: a wall-clock timeout is OUR stop, and it is resumable', () => {
  const d = nextPhase({ status: 'timeout' } as never, 1, 2);
  assert.equal(d.outcome, 'timed_out');
  assert.equal(d.phase, 'pending');
  assert.equal(d.resumable, true, 'the clock ran out, not the work — the session is worth continuing');
});

test('nextPhase: a refusal never retries — the same brief gets the same answer', () => {
  const d = nextPhase({ status: 'refused' } as never, 1, 5);
  assert.equal(d.phase, 'failed');
  assert.equal(d.resumable, false);
});

test('nextPhase: a runtime that threw is a crash, not a success', () => {
  assert.equal(nextPhase(null, 1, 2).outcome, 'crashed');
});

// ---------------------------------------------------------------- the loop

test('a pending job runs, succeeds, and records the session pointer', async () => {
  const job = await mkJob('happy');
  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.deepEqual(r.succeeded, [job.id]);

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(after.attempts.length, 1);
  assert.ok(after.attempts[0].sessionId, 'the session id is the one SDK fact we keep');
  assert.equal(after.finishedAt !== null, true);
});

test('the lease is released when the attempt ends', async () => {
  const job = await mkJob('lease-released');
  await reconcile({ runtime: fakeRuntime(), cwd });
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null);
});

test('a failing job retries up to maxRetries, then fails', async () => {
  const job = await mkJob('flaky', { maxRetries: 2 });
  await reconcileToRest({ runtime: fakeRuntime({ failTasks: [job.id] }), cwd });
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed');
  assert.equal(after.attempts.length, 3, '1 initial + 2 retries');
});

test('known contention is refused by the gate before any claim is attempted', async () => {
  const job = await mkJob('contended');
  // somebody else got there first and still holds it; maxConcurrent is 1
  await db.lease.create({
    data: { jobId: job.id, holder: 'other-host', token: 't', expiresAt: new Date(Date.now() + 600_000) },
  });
  const r = await reconcile({ runtime: fakeRuntime(), cwd, board: 'test' });
  assert.match(r.refused ?? '', /concurrent slots/, 'the cheap check catches it first');
  assert.ok(!r.claimed.includes(job.id));
  assert.equal((await db.attempt.count({ where: { jobId: job.id } })), 0, 'and runs nothing');
  await db.lease.delete({ where: { jobId: job.id } });
});

test('a genuine race is lost at the compare-and-swap, not at the gate', async () => {
  // Room to spare, so the gate admits — and the lease insert is then the only thing standing
  // between two processes and a double run. This is the path the gate cannot cover: two hosts
  // that both read "one slot free" in the same instant.
  const board = await db.board.findFirstOrThrow({ where: { slug: 'test' } });
  await db.board.update({ where: { id: board.id }, data: { maxConcurrent: 5 } });
  const job = await mkJob('raced');
  await db.lease.create({
    data: { jobId: job.id, holder: 'won-the-race', token: 't', expiresAt: new Date(Date.now() + 600_000) },
  });

  const r = await reconcile({ runtime: fakeRuntime(), cwd, board: 'test' });
  assert.equal(r.refused, null, 'the gate had no objection');
  assert.ok(r.skipped.includes(job.id), 'the loser skips rather than throwing');
  assert.equal((await db.attempt.count({ where: { jobId: job.id } })), 0, 'and runs nothing');

  await db.lease.delete({ where: { jobId: job.id } });
  await db.board.update({ where: { id: board.id }, data: { maxConcurrent: 1 } });
});

test('an expired lease is reclaimed and its orphaned attempt is marked lost', async () => {
  const job = await mkJob('abandoned');
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: 'dead-host' } });
  await db.lease.create({
    data: { jobId: job.id, holder: 'dead-host', token: 't', expiresAt: new Date(Date.now() - 1000) },
  });

  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.ok(r.reclaimed.includes(job.id));
  const orphan = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(orphan.outcome, 'lost', 'nobody ever reported it');
  assert.ok(orphan.endedAt);
});

test('reconcile is idempotent: a second pass on a settled board does nothing', async () => {
  await mkJob('settle-me');
  await reconcileToRest({ runtime: fakeRuntime(), cwd });
  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.deepEqual(r.claimed, []);
  assert.deepEqual(r.reclaimed, []);
});

// ---------------------------------------------------------------- admission
// The gate is a PreToolUse hook, not canUseTool: `bypassPermissions` and bare `allowedTools`
// entries both shadow canUseTool, and the SDK says so in a warning. Verified against the real
// SDK: a parent that omits isolation gets it injected.

const pre = (tool: string, input: Record<string, unknown>) =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1' }) as never;
const spec = (r: Awaited<ReturnType<ReturnType<typeof admissionCallback>>>) =>
  (r as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};

test('admission injects isolation onto an Agent spawn that omitted it', async () => {
  const gate = admissionCallback({});
  const o = spec(await gate(pre('Agent', { prompt: 'go', subagent_type: 'worker' })));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal((o.updatedInput as Record<string, unknown>).isolation, 'worktree',
    'not asked for in a prompt — injected');
});

test('admission leaves an already-isolated spawn alone', async () => {
  const gate = admissionCallback({});
  const o = spec(await gate(pre('Agent', { prompt: 'go', isolation: 'worktree' })));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal(o.updatedInput, undefined, 'nothing to change');
});

test('a policy can refuse a spawn, and the model is told why', async () => {
  const gate = admissionCallback({
    admitSpawn: (input) => (String(input.description ?? '').includes('#2') ? '#2 is blocked by #1' : null),
  });
  const denied = spec(await gate(pre('Agent', { description: '#2 do the join' })));
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(String(denied.permissionDecisionReason), /blocked by #1/);

  const allowed = spec(await gate(pre('Agent', { description: '#1 do the root' })));
  assert.equal(allowed.permissionDecision, 'allow');
});

test('the allowlist is enforced by the hook, not by the permission mode', async () => {
  // Measured: a nested session ran `Agent` under permissionMode dontAsk with Agent absent from
  // allowedTools. Hooks run first and are client-side, so this is the layer that actually holds.
  const gate = admissionCallback({ allow: ['Read', 'Bash'] });
  const denied = spec(await gate(pre('Agent', { prompt: 'fan out' })));
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(String(denied.permissionDecisionReason), /tool surface/);
  assert.equal(spec(await gate(pre('Read', { file_path: 'x' }))).permissionDecision, 'allow');
});

test('no allowlist means the hook enforces none — the mode decides', async () => {
  const gate = admissionCallback({});
  assert.equal(spec(await gate(pre('Bash', { command: 'ls' }))).permissionDecision, 'allow');
});

test('admission denies a tool the workload may never use', async () => {
  const gate = admissionCallback({ deny: ['WebFetch'] });
  assert.equal(spec(await gate(pre('WebFetch', {}))).permissionDecision, 'deny');
  assert.equal(spec(await gate(pre('Read', {}))).permissionDecision, 'allow');
});

test('a non-PreToolUse event is not the gate\'s business', async () => {
  const gate = admissionCallback({ deny: ['Read'] });
  const r = await gate({ hook_event_name: 'PostToolUse', tool_name: 'Read' } as never);
  assert.deepEqual(r, {}, 'no opinion, rather than a wrong one');
});
