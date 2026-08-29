// One card, one profile. `hkb adopt <n> --agent X` used to *add* `kb:agent:X` beside whatever the
// card already wore, so the issue ended up on two profiles, `agentOf` took the first, and the
// documented way to make a track — `hkb adopt <root> --agent claude-track --status todo` — reported
// success and changed nothing (#113): the root kept dispatching node-by-node as `claude`.
//
// The tests below are the whole story end to end: what adopt writes, what the tick then sees, what
// `hkb claim --profile` does with the same problem, and how doctor names the cards on boards that
// were piloted before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { tick } from '../src/dispatch.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { agentOf, agentsOf } from '../src/model.js';
import { setAgent } from '../src/tasks.js';
import { checkAgentLabels, AGENT_LABEL_CHECK } from '../src/doctor.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const agentLabels = (gh, n) => gh.labelsOf(n).filter((l) => l.startsWith('kb:agent:'));

/**
 * A board in a temp checkout, with the CLI's own context (it reads `.kanban/board.json` from the
 * cwd, exactly as a user's shell does) and a `tick` on the same fake GitHub. `["true"]` is every
 * launch template that matters here; nothing in these tests spawns a worker.
 */
function harness(t, { caps = {} } = {}) {
  const gh = new FakeGh({ caps });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-agent-'));
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    profiles: {
      claude: { mode: 'process', max_in_progress: 2, launch: ['true'] },
      codex: { mode: 'process', max_in_progress: 1, launch: ['true'] },
      'claude-track': { mode: 'process', track: true, track_agents: ['claude', 'claude-track'], max_in_progress: 1, launch: ['true'] },
    },
  };
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify(cfg));
  const ctx = {
    root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  process.chdir(root);
  const logs = [];
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restore(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    gh, ctx, root,
    printed: () => printed,
    log: () => logs.join('\n'),
    tick: (opts = {}) => tick(ctx, { log: (m) => logs.push(m), ...opts }),
  };
}

/** The three-node chain from the worked example in `references/protocol.md`, all on `claude`. */
function seedChain(gh) {
  gh.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude', kb: { paths: ['src/a.js'] } }));
  gh.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41], kb: { paths: ['src/b.js'] } }));
  gh.addIssue(kbIssue({ number: 12, status: 'todo', agent: 'claude', blockedBy: [42], kb: { paths: ['docs/'] } }));
}

// ---------- the resolver ----------

test('agentsOf lists every profile label; agentOf still answers with the first', () => {
  const labels = ['bug', 'kb:status:todo', 'kb:agent:claude', 'kb:board:default', 'kb:agent:claude-track'];
  assert.deepEqual(agentsOf(labels), ['claude', 'claude-track']);
  assert.equal(agentOf(labels), 'claude', 'the read stays first-wins: a broken board must still show and list');
  assert.deepEqual(agentsOf(['kb:status:todo']), []);
  assert.deepEqual(agentsOf(undefined), []);
});

// ---------- adopt ----------

test('adopt onto another profile replaces the label instead of stacking a second one', async (t) => {
  const h = harness(t);
  h.gh.addIssue(kbIssue({ number: 7, status: 'triage', agent: 'claude' }));

  assert.equal(await main(['adopt', '7', '--agent', 'codex', '--status', 'todo']), 0);

  assert.deepEqual(agentLabels(h.gh, 7), ['kb:agent:codex']);
  assert.equal(agentOf(h.gh.labelsOf(7)), 'codex', 'the card resolves to what adopt said it adopted it as');
  assert.equal(h.gh.statusOf(7), 'todo');
  assert.match(h.printed(), /#7 adopted → todo \(codex\)/);
});

test('the worked example: adopting the root as claude-track makes it a claimable track', async (t) => {
  const h = harness(t);
  seedChain(h.gh);

  await main(['adopt', '12', '--agent', 'claude-track', '--status', 'todo']);
  const s = await h.tick({ dryRun: true });

  assert.deepEqual(agentLabels(h.gh, 12), ['kb:agent:claude-track'], 'no manual label surgery left to do');
  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.nodes]), [[12, true, [41, 42]]]);
  assert.deepEqual(s.claimed, [], 'the ready leaf #41 belongs to the runner, not to node dispatch');
  assert.match(h.log(), /#12: \[dry-run\] would run track #41 → #42 → #12 as one claude-track session/);
});

test('adopt repairs a card that already carries two profile labels', async (t) => {
  const h = harness(t);
  // what a board piloted before the fix looks like: adopt added the second label and left the first
  h.gh.addIssue(kbIssue({ number: 12, status: 'todo', agent: 'claude-track', labels: ['kb:agent:claude'] }));
  assert.equal(agentOf(h.gh.labelsOf(12)), 'claude', 'precondition: the stale label is the one that wins');

  await main(['adopt', '12', '--agent', 'claude-track', '--status', 'todo']);

  assert.deepEqual(agentLabels(h.gh, 12), ['kb:agent:claude-track']);
});

test('adopt keeps the labels of the board it is on, and re-adopting the same profile writes nothing', async (t) => {
  const h = harness(t);
  h.gh.addIssue(kbIssue({ number: 7, status: 'todo', agent: 'claude', labels: ['bug'] }));
  await main(['adopt', '7', '--agent', 'claude', '--status', 'todo']);
  const before = h.gh.callsMatching(null, /issues\/7\/labels/).length;

  await main(['adopt', '7', '--agent', 'claude', '--status', 'todo']);

  assert.deepEqual(h.gh.labelsOf(7).sort(), ['bug', 'kb:agent:claude', 'kb:board:default', 'kb:status:todo']);
  assert.equal(h.gh.callsMatching(null, /issues\/7\/labels/).length, before, 'nothing to change is nothing to write');
});

test('setAgent adds the label to a card that has none — a task adopted onto a bare issue', async (t) => {
  const h = harness(t);
  h.gh.addIssue(kbIssue({ number: 9, status: 'triage', agent: null }));

  await main(['adopt', '9', '--agent', 'claude']);

  assert.deepEqual(agentLabels(h.gh, 9), ['kb:agent:claude']);
  assert.equal(h.gh.statusOf(9), 'triage', 'the default status is where triage-only adoption leaves it');
});

test('setAgent adds before it removes, so a half-applied set never leaves a card with no profile', async (t) => {
  const h = harness(t);
  h.gh.addIssue(kbIssue({ number: 7, status: 'todo', agent: 'claude' }));
  h.gh.fail({ method: 'DELETE', path: 'issues/7/labels/' }, { status: 500, message: 'the label DELETE never lands' });
  const task = { number: 7, labels: h.gh.labelsOf(7), agent: 'claude' };

  await assert.rejects(() => setAgent(h.ctx, task, 'codex'));

  assert.deepEqual(agentLabels(h.gh, 7).sort(), ['kb:agent:claude', 'kb:agent:codex'], 'two profiles — the state doctor names — never zero');
});

// ---------- claim ----------

test('`hkb claim <n> --profile p` retargets the card too: it names who is running it', async (t) => {
  const h = harness(t);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));

  assert.equal(await main(['claim', '7', '--profile', 'codex']), 0);

  assert.deepEqual(agentLabels(h.gh, 7), ['kb:agent:codex']);
  assert.equal(h.gh.statusOf(7), 'running');
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/7/1']);
});

test('`hkb claim <n> --spawn` on a card the reviewer sent back records continues_pr like the dispatcher\'s own claim', async (t) => {
  const h = harness(t);
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  const run = runWith([
    { attempt: 1, ended_at: ago(600), outcome: 'review_requested', pr: 42 },
    { attempt: 2, profile: 'reviewer', ended_at: ago(30), outcome: 'changes_requested', synthetic: true },
  ]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  assert.equal(await main(['claim', '7', '--spawn']), 0);

  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.continues_pr, 42, 'a manual --spawn claim gets the same continues_pr bookkeeping as the dispatcher');
});

// ---------- doctor ----------

test('doctor names every card on two profiles, which one it actually runs as, and the fix', async (t) => {
  const h = harness(t);
  h.gh.addIssue(kbIssue({ number: 12, status: 'todo', agent: 'claude-track', labels: ['kb:agent:claude'] }));
  h.gh.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 50, status: 'todo', agent: 'codex', labels: ['kb:agent:claude'] }));
  const results = [];
  const sink = { ok: (name, detail) => results.push({ name, ok: true, detail }), warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }) };

  await checkAgentLabels(h.ctx, sink);

  assert.equal(results.length, 1);
  const [r] = results;
  assert.equal(r.name, AGENT_LABEL_CHECK);
  assert.equal(r.ok, null, 'a warning: the board still works, it just works as the wrong profile');
  assert.match(r.detail, /2 tasks on two profiles at once/);
  assert.match(r.detail, /#12 \(claude \+ claude-track → runs as claude\)/);
  assert.match(r.detail, /#50 \(claude \+ codex → runs as claude\)/);
  assert.ok(!r.detail.includes('#41'), 'a card with one profile label is not a finding');
  assert.match(r.fix, /^hkb adopt 12 50 --agent /);
});

test('doctor is quiet on a clean board, and says how much it looked at', async (t) => {
  const h = harness(t);
  h.gh.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 12, status: 'todo', agent: 'claude-track' }));
  const results = [];
  const sink = { ok: (name, detail) => results.push({ name, ok: true, detail }), warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }) };

  await checkAgentLabels(h.ctx, sink);

  assert.deepEqual(results.map((r) => [r.name, r.ok]), [[AGENT_LABEL_CHECK, true]]);
  assert.match(results[0].detail, /2 open tasks, at most one kb:agent:\* each/);
});

test('the check reads labels only: no per-task dependency call, even without GraphQL blockedBy', async (t) => {
  const h = harness(t, { caps: { blockedByGql: false } });
  h.gh.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41] }));
  h.gh.addIssue(kbIssue({ number: 12, status: 'blocked', agent: 'claude', blockedBy: [42] }));
  const results = [];

  await checkAgentLabels(h.ctx, { ok: (name, detail) => results.push({ name, detail }), warn: (name, detail) => results.push({ name, detail }) });

  assert.equal(results.length, 1);
  assert.deepEqual(h.gh.callsMatching('GET', 'dependencies/blocked_by'), [], 'a check about labels must not cost a board of REST calls');
});

test('a board that will not read is a warning, not a crash — doctor has other checks to run', async (t) => {
  const h = harness(t);
  const results = [];
  const sink = { ok: (name, detail) => results.push({ name, ok: true, detail }), warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }) };

  await checkAgentLabels(h.ctx, sink, { fetch: async () => { throw new Error('502 Bad Gateway'); } });

  assert.equal(results[0].ok, null);
  assert.match(results[0].detail, /could not read the board: 502 Bad Gateway/);
});
