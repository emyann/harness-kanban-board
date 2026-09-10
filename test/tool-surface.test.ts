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
  await reconcile({ runtime, cwd: REPO, board: 'surface', only: job.id });
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

// ---------------------------------------------------------------- the review's findings, as tests

/**
 * What the first implementation of this card got wrong, each with the test that would have caught it.
 *
 * The pattern is CLAUDE.md's: a guard is not proven by a test that asks whether it allows. Every one
 * of these asserts a REFUSAL — the surface does not leak, the skill fence does not open, a per-run
 * field does not widen the isolation rule, the SDK is not handed the deprecated spelling.
 */
const { skillFilter } = await import('../src/runtime/surface.ts');
const { queryOptions } = await import('../src/runtime/claude.ts');
const { discoverSkills } = await import('../src/plugins.ts');

test('the shipped default cannot be mutated through what toolSurface hands out', () => {
  // It used to return the module-level array itself, into the SDK options, the gate and the fake at
  // once — so one `push` anywhere permanently rewrote the default for every later Job in the
  // process, with no board write and nothing in `hkb show` to explain it.
  const first = toolSurface({});
  first.push('Agent');
  assert.ok(!toolSurface({}).includes('Agent'), 'a caller widened the shipped default for everyone');
  assert.throws(() => (DEFAULT_TOOLS as string[]).push('Agent'), 'and the constant itself is frozen');
});

test('a per-run admission field cannot override the isolation rule computed from the spec', () => {
  // `subagentIsolation` is already a field on AdmissionPolicy, so the day WorkerSpec.admission gains
  // it a caller could silently turn an isolated Job's spawns loose in the parent's worktree.
  const policy = admissionPolicy({
    isolated: true,
    admission: { subagentIsolation: 'forbid', sandboxed: true } as never,
  });
  assert.equal(policy.subagentIsolation, 'force', 'the spec decides isolation, not the caller');
  assert.equal(policy.sandboxed, true, 'and everything else on admission still gets through');
  assert.deepEqual(policy.allow, [...DEFAULT_TOOLS], 'the surface is the resolved spec, not a per-run override');
});

// ---- the skill fence

test('a Job granted nothing may invoke NO skill, which is the whole point', () => {
  // The regression the review found: `Skill` on the surface with this unset let every ordinary Job
  // invoke the operator's own ~/.claude skills — content nobody granted. `[]` is what shuts it.
  assert.deepEqual(skillFilter([], [...DEFAULT_TOOLS]), []);
});

test('a narrowed surface turns the fence off too, not just the gate', () => {
  assert.deepEqual(skillFilter(['prisma-cli'], ['Read', 'Bash']), [],
    'an operator who dropped Skill has said no, and the SDK must hear it');
});

test('a granted skill is emitted in BOTH spellings, so the fence does not rest on a guess', () => {
  // sdk.d.ts: an entry matches "the exact canonical name (e.g. my-plugin:my-skill) or a `:name`
  // suffix of it". Whether a local plugin's skills are canonically bare or qualified is not
  // something hkb controls, and emitting both matches either way.
  assert.deepEqual(skillFilter(['prisma-cli'], [...DEFAULT_TOOLS]), ['prisma-cli', ':prisma-cli']);
});

test('the fence is deduplicated and ordered, so two grants of one skill are one entry', () => {
  assert.deepEqual(skillFilter(['b', 'a', 'b', ' a ', ''], [...DEFAULT_TOOLS]), ['a', ':a', 'b', ':b']);
});

test('discoverSkills reads the granted directories and nothing else', () => {
  const root = fs.mkdtempSync(path.join(dir, 'grant-'));
  const skills = path.join(root, 'skills');
  fs.mkdirSync(path.join(skills, 'real'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'real', 'SKILL.md'), '---\nname: real\n---\nbody\n');
  // A directory with no SKILL.md is not a skill, and a loose file is not one either.
  fs.mkdirSync(path.join(skills, 'not-a-skill'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'loose.md'), 'x');
  // A SYMLINKED skill counts: this repository's own `.claude/skills/*` are symlinks into
  // `.agents/skills/`, so a grant that skipped them would be inert in the shipped layout.
  const target = path.join(root, 'elsewhere', 'linked');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: linked\n---\nbody\n');
  fs.symlinkSync(target, path.join(skills, 'linked'));

  assert.deepEqual(discoverSkills([root]), ['linked', 'real']);
  assert.deepEqual(discoverSkills([path.join(dir, 'nope')]), [], 'an unreadable grant enables nothing');
  assert.deepEqual(discoverSkills([]), []);
});

// ---- what the SDK is actually handed

const spec = (over: Record<string, unknown> = {}) => ({
  taskId: 1, attempt: 1, prompt: 'do it', cwd: dir, ...over,
} as never);

test('the resolved surface REACHES the SDK options, which nothing asserted before', () => {
  // Delete `allowedTools` from the options object and the whole suite used to stay green: the only
  // importer of claudeRuntime is a live test that skips without an API key.
  const o = queryOptions(spec(), new AbortController());
  for (const t of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash']) {
    assert.ok(o.allowedTools?.includes(t), `${t} is on the shipped surface and must be advertised`);
  }
  assert.ok(!o.allowedTools?.includes('Agent'), 'and Agent is not: one Job is one agent');
  assert.equal(o.permissionMode, 'dontAsk');
  assert.deepEqual(o.settingSources, [], 'the operator`s CLAUDE.md and settings stay out');
  assert.equal(o.strictMcpConfig, true);
});

test('`Skill` is NOT handed to allowedTools — that spelling is deprecated at the pinned SDK', () => {
  // sdk.d.ts:1447 on allowedTools: "passing 'Skill' here is deprecated — use the skills option
  // instead". On the bump that drops the deprecated handling, dontAsk denies Skill again and every
  // plugin grant goes inert with no error and no failing test: this card's own bug, returning.
  const o = queryOptions(spec(), new AbortController());
  assert.ok(!o.allowedTools?.includes('Skill'));
  // But the GATE still allows it, because a skill invocation is a tool call admission judges.
  assert.ok(admissionPolicy({}).allow?.includes('Skill'));
});

test('a Job with no grant is handed an EMPTY skills list, not an absent one', () => {
  // Absent is not "off": sdk.d.ts says omitting it means "no SDK auto-configuration. The CLI's own
  // defaults still apply, so this is **not** skills off."
  const o = queryOptions(spec(), new AbortController());
  assert.deepEqual(o.skills, [], 'ungranted user-level skills stay unreachable');
});

test('a granted plugin directory reaches the SDK as its own skills, and only its own', () => {
  const root = fs.mkdtempSync(path.join(dir, 'plug-'));
  fs.mkdirSync(path.join(root, 'skills', 'only-this'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'only-this', 'SKILL.md'), '---\nname: only-this\n---\nb\n');
  const o = queryOptions(spec({ plugins: [root] }), new AbortController());
  assert.deepEqual(o.skills, ['only-this', ':only-this']);
  assert.equal(o.plugins?.length, 1);
});

test('a Job narrowed away from Skill is handed no skills even when it was granted a directory', () => {
  const root = fs.mkdtempSync(path.join(dir, 'plug2-'));
  fs.mkdirSync(path.join(root, 'skills', 'granted'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'granted', 'SKILL.md'), '---\nname: granted\n---\nb\n');
  const o = queryOptions(spec({ plugins: [root], allowedTools: ['Read'] }), new AbortController());
  assert.deepEqual(o.skills, []);
  assert.deepEqual(o.allowedTools, ['Read']);
});

// ---- the fake, held to the driver it stands in for


test('a DENIED call still emits a tool event, because that is what the real driver does', async () => {
  // The driver emits one per `tool_use` block on the assistant message, which the model produces
  // BEFORE the PreToolUse hook runs — so a real run shows the operator `-> Skill` and a denial.
  // Suppressing it here made any test of "is a refusal visible" pass on the fake and be wrong.
  const rt = fakeRuntime({ calls: ['Agent'] });
  const seen: string[] = [];
  const out = await rt.run(spec({ allowedTools: ['Read'] }), (e) => {
    if (e.kind === 'tool') seen.push(e.name);
  });
  assert.equal(out.denials, 1, 'the call was refused');
  assert.deepEqual(seen, ['Agent'], 'and the operator still saw it attempted');
});

test('decisions can be reset, so a second pass is not read through the first', async () => {
  // One runtime instance outlives many runs; the index reads these tests use would otherwise take
  // the first pass's entries while appearing to assert the second's.
  const rt = fakeRuntime({ calls: ['Read'] });
  await rt.run(spec());
  assert.equal(rt.decisions.length, 1);
  await rt.run(spec());
  assert.equal(rt.decisions.length, 2, 'it accumulates, which is the trap');
  rt.reset();
  assert.deepEqual(rt.decisions, []);
});
