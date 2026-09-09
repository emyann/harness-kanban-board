import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The shipped tool surface, asked what it REFUSES.
 *
 * Every existing test of the gate hands it an `allow` list of its own, which proves the code and
 * not the product: the default surface lived inside the Agent SDK driver and the only way to reach
 * it was to buy a session. `src/runtime/surface.ts` is that decision as a pure module and
 * `src/runtime/fake.ts` builds the same policy from it, so these run a real Job through a real
 * `reconcile` at the shipped defaults and read what the gate actually said.
 *
 * `Skill` is what this file was written for. A worker had never invoked one — ADR-012 measured
 * skills REACHING a worker and nothing measured one being CALLED, because `Skill` was not on the
 * default surface and the gate denies what is not on it. So every plugin grant was inert.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-surface-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'surface.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { reconcile } = await import('../src/controller.ts');
const { fakeRuntime } = await import('../src/runtime/fake.ts');
const { DEFAULT_TOOLS, admissionPolicy, toolSurface } = await import('../src/runtime/surface.ts');

const db = openBoard();
const board = await db.board.upsert({ where: { slug: 'surface' }, update: {}, create: { slug: 'surface' } });

/** `isolate: false` on purpose: nothing here is about worktrees, and one is 620 MB of nothing. */
const mkJob = (name: string, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId: board.id, name, brief: `do ${name}`, isolate: false, ...extra } });

/** One Job, run at whatever surface it resolved to, reporting what the gate said about each call. */
async function askGate(name: string, calls: string[], extra: Record<string, unknown> = {}) {
  const job = await mkJob(name, extra);
  const runtime = fakeRuntime({ calls });
  await reconcile({ runtime, cwd: REPO, board: 'surface', only: job.id, readPr: false });
  return { job, decisions: runtime.decisions };
}

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a Job at the shipped defaults is ALLOWED Skill', async () => {
  const { job, decisions } = await askGate('default-surface', ['Skill']);
  assert.equal(
    (await db.job.findUniqueOrThrow({ where: { id: job.id } })).allowedTools, null,
    'the Job named no surface — this is the default the product ships, not one the test supplied',
  );
  assert.deepEqual(decisions.map((d) => [d.tool, d.allowed]), [['Skill', true]]);
  assert.equal(
    (await db.attempt.findFirstOrThrow({ where: { jobId: job.id } })).denials, 0,
    'and nothing was refused, which is what a plugin grant being live looks like',
  );
});

test('a Job narrowed to Read,Bash is DENIED Skill, in the gate\'s own words', async () => {
  const { decisions } = await askGate('narrowed', ['Skill', 'Read'], { allowedTools: ['Read', 'Bash'] });
  const [skill, read] = decisions;

  assert.equal(skill.allowed, false, 'an operator who narrowed the surface dropped Skill with it');
  assert.match(String(skill.reason), /Skill is not part of this workload's tool surface/);
  assert.match(String(skill.reason), /Available: Read, Bash\./, 'and the model is told what it does have');
  assert.equal(read.allowed, true, 'what it WAS granted still works, or narrowing is just breakage');
});

test('a narrowed Job\'s refusals are counted on the attempt, not turned into a failure', async () => {
  const { job, decisions } = await askGate('counted', ['Skill', 'Agent', 'Read'], { allowedTools: ['Read'] });
  assert.deepEqual(decisions.filter((d) => !d.allowed).map((d) => d.tool), ['Skill', 'Agent']);

  const after = await db.job.findUniqueOrThrow({
    where: { id: job.id }, include: { attempts: { orderBy: { k: 'asc' } } },
  });
  assert.equal(after.attempts[0].denials, 2, 'the ledger `hkb show` reads');
  assert.equal(after.phase, 'succeeded', 'being refused a tool is not a broken run');
});

test('Agent is still denied at the shipped defaults — admitting Skill must not open that door', async () => {
  const { decisions } = await askGate('no-fan-out', ['Agent']);
  assert.equal(decisions[0].allowed, false,
    'a skill that spawns subagents (/code-review) is Agent\'s question, and #63 measures the fence first');
  assert.match(String(decisions[0].reason), /not part of this workload's tool surface/);
});

// ---------------------------------------------------------------- the constant itself

test('DEFAULT_TOOLS carries Skill and not Agent', () => {
  assert.ok(DEFAULT_TOOLS.includes('Skill'), 'the whole of card #65');
  assert.ok(!DEFAULT_TOOLS.includes('Agent'),
    'a fan-out surface is a separate decision with a separate measurement (#63) in front of it');
  assert.ok(!DEFAULT_TOOLS.some((t) => t.startsWith('mcp__')),
    'no MCP tool is on the default surface — ADR-012, and `strictMcpConfig` is the other half');
});

test('an empty surface is not an absent one, at the boundary the default is read', () => {
  // The distinction that decides whether `--allow-tools ""` means anything. `??`, never `||`.
  assert.deepEqual(toolSurface({ allowedTools: [] }), [], 'no tools at all, and Skill is not slipped back in');
  assert.deepEqual(toolSurface({}), DEFAULT_TOOLS);
  assert.deepEqual(admissionPolicy({ allowedTools: [] }).allow, []);
});

test('the policy follows the parent\'s isolation, and the spec cannot widen the surface', () => {
  assert.equal(admissionPolicy({ isolated: false }).subagentIsolation, 'forbid');
  assert.equal(admissionPolicy({ isolated: true }).subagentIsolation, 'force');
  assert.equal(admissionPolicy({}).subagentIsolation, 'force', 'omitted means isolated — the strict rule');
  // `spec.admission` is spread last and carries the sandbox flag and the spawn rule. It must not be
  // a back door onto the tool surface: the surface is the resolved spec and nothing else.
  assert.deepEqual(
    admissionPolicy({ allowedTools: ['Read'], admission: { sandboxed: true } }).allow, ['Read'],
  );
});
