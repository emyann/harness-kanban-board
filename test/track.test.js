// Tracks: resolving a subgraph out of the board, deciding whether one session may have it, the
// prompt that session gets, and what the tick does with it. The dispatch half runs against the
// in-memory GitHub (test/fake-gh.js) with `["true"]` as every launch template, so no worker runs —
// the point is what the *board* looks like before and after, including after a runner dies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick } from '../src/dispatch.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES, readState, writeState } from '../src/board.js';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KB, L, parseSkillVersion } from '../src/model.js';
import {
  resolveTrack, trackWaves, trackPaths, trackReadiness, planTracks, trackContext,
  trackAlreadyAttempted, isTrackProfile, trackAgents, trackGraph, trackMermaid, mermaidLabel, trackFanout,
} from '../src/track.js';
import { main } from '../src/cli.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

const CFG = {
  profiles: {
    claude: { max_in_progress: 2 },
    codex: { max_in_progress: 1 },
    'claude-track': { track: true, track_agents: ['claude', 'claude-track'], max_in_progress: 1 },
  },
};

/** A task in the shape `toTask` produces, with only the fields tracks read. */
function node(number, { title, status = 'ready', agent = 'claude', blocks = [], kb = {}, prs = [], needsHuman = false, body = 'do it' } = {}) {
  return {
    number,
    title: title || `task ${number}`,
    bodyText: body,
    status,
    agent,
    needsHuman,
    prs,
    kb: { ...DEFAULT_KB, ...kb },
    blockedBy: blocks.map((b) => (typeof b === 'number' ? { number: b, state: 'OPEN', stateReason: null, title: `task ${b}` } : b)),
  };
}
const done = (n) => ({ number: n, state: 'CLOSED', stateReason: 'COMPLETED', title: `task ${n}` });
const by = (tasks) => new Map(tasks.map((t) => [t.number, t]));

// ---------- resolving the subgraph ----------

test('a track is the root plus everything still blocking it, blockers first', () => {
  //   41 → 42 ─┐
  //   43 ──────┴→ 26
  const tasks = [node(41), node(42, { status: 'todo', blocks: [41] }), node(43), node(26, { status: 'todo', agent: 'claude-track', blocks: [42, 43] })];
  const t = resolveTrack(26, by(tasks));

  assert.equal(t.root.number, 26);
  assert.deepEqual(t.order.map((x) => x.number), [41, 42, 43, 26], 'dependency order, the root last');
  assert.deepEqual(t.nodes.map((x) => x.number), [41, 42, 43]);
  assert.deepEqual(t.missing, []);
  assert.equal(t.cycle, null);
});

test('a blocker closed as completed is finished work, not a node — so a track shrinks as it runs', () => {
  const tasks = [node(42, { blocks: [done(41)] }), node(26, { status: 'todo', agent: 'claude-track', blocks: [42] })];
  const t = resolveTrack(26, by(tasks));

  assert.deepEqual(t.order.map((x) => x.number), [42, 26]);
  assert.deepEqual(t.missing, [], '#41 is closed, so it is not missing — it is done');
});

test('an unfinished blocker that is not on this board is `missing`, not silently dropped', () => {
  const tasks = [node(42, { status: 'todo', blocks: [41] }), node(26, { status: 'todo', agent: 'claude-track', blocks: [42] })];
  const t = resolveTrack(26, by(tasks)); // #41 was never added

  assert.deepEqual(t.missing, [41]);
  assert.deepEqual(t.order.map((x) => x.number), [42, 26]);
});

test('a cycle is reported, not walked forever', () => {
  const tasks = [node(41, { blocks: [42] }), node(42, { blocks: [41] }), node(26, { status: 'todo', agent: 'claude-track', blocks: [41] })];
  const t = resolveTrack(26, by(tasks));

  assert.deepEqual(t.cycle, [41, 42, 41]);
});

test('resolveTrack on a number that is not on the board answers empty, never throws', () => {
  const t = resolveTrack(99, by([node(1)]));
  assert.equal(t.root, null);
  assert.deepEqual(t.order, []);
});

test('waves: what may run at once, and what has to wait', () => {
  const tasks = [node(41), node(43), node(42, { status: 'todo', blocks: [41] }), node(26, { status: 'todo', agent: 'claude-track', blocks: [42, 43] })];
  const waves = trackWaves(resolveTrack(26, by(tasks)));

  assert.deepEqual(waves.map((w) => w.map((t) => t.number)), [[41, 43], [42], [26]]);
});

test('trackPaths is the union every node claims — what the path_overlap guard has to see', () => {
  const tasks = [node(41, { kb: { paths: ['src/a.js'] } }), node(43, { kb: { paths: ['docs/', 'src/a.js'] } }), node(26, { status: 'todo', agent: 'claude-track', blocks: [41, 43], kb: { paths: ['README.md'] } })];
  assert.deepEqual(trackPaths(resolveTrack(26, by(tasks))), ['src/a.js', 'docs/', 'README.md']);
});

// ---------- may one session have it? ----------

const chain = (over = {}) => [
  node(41, { ...over[41] }),
  node(42, { status: 'todo', blocks: [41], ...over[42] }),
  node(26, { status: 'todo', agent: 'claude-track', blocks: [42], ...over[26] }),
];
const readiness = (tasks, cfg = CFG) => trackReadiness(resolveTrack(26, by(tasks)), cfg, { board: 'default' });

test('a decomposed goal on a track profile is claimable as one track', () => {
  const r = readiness(chain());
  assert.equal(r.ok, true);
  assert.equal(r.why, '2 nodes then the root');
  assert.deepEqual(r.waves.map((w) => w.map((t) => t.number)), [[41], [42], [26]]);
});

test('every refusal is a fallback to node dispatch, and says which node caused it', () => {
  const cases = [
    [chain({ 26: { agent: 'claude' } }), /profile claude does not run tracks/],
    [chain({ 26: { status: 'running' } }), /the root is running/],
    [chain({ 26: { needsHuman: true } }), /#26 needs a human/],
    [chain({ 26: { prs: [{ number: 9, state: 'OPEN' }] } }), /#26 already has an open PR/],
    [chain({ 41: { status: 'running' } }), /#41 is running/],
    [chain({ 41: { status: 'triage' } }), /#41 is triage/],
    [chain({ 41: { needsHuman: true, status: 'blocked' } }), /#41 is blocked/],
    [chain({ 41: { prs: [{ number: 9, state: 'OPEN' }] } }), /#41 already has an open PR/],
    [chain({ 41: { agent: 'codex' } }), /#41 runs on codex, which a claude-track runner cannot execute/],
    [chain({ 42: { kb: { scheduled_at: ago(-3600) } } }), /#42 is scheduled for/],
  ];
  for (const [tasks, re] of cases) {
    const r = readiness(tasks);
    assert.equal(r.ok, false, `${re} should refuse`);
    assert.match(r.why, re);
  }
});

test('a root with nothing left blocking it is a plain node, not a track', () => {
  const r = readiness([node(26, { status: 'ready', agent: 'claude-track', blocks: [done(41)] })]);
  assert.equal(r.ok, false);
  assert.match(r.why, /nothing is blocking it any more — dispatch it as a single node/);
});

test('a blocker off the board makes the track un-runnable and names it', () => {
  const r = readiness([node(42, { status: 'todo', blocks: [41] }), node(26, { status: 'todo', agent: 'claude-track', blocks: [42] })]);
  assert.equal(r.ok, false);
  assert.match(r.why, /#41 block the track but are not on board "default"/);
});

test('track_agents defaults to the profile itself, so a cross-harness track is refused by default', () => {
  const cfg = { profiles: { claude: {}, 'claude-track': { track: true } } };
  assert.deepEqual([...trackAgents(cfg, 'claude-track')], ['claude-track']);
  assert.equal(isTrackProfile(cfg, 'claude-track'), true);
  assert.equal(isTrackProfile(cfg, 'claude'), false);
  assert.equal(isTrackProfile(cfg, null), false);
  assert.match(readiness(chain(), cfg).why, /#41 runs on claude, which a claude-track runner cannot execute/);
});

test('the shipped claude-track profile runs tracks and can execute the claude profiles', () => {
  const p = DEFAULT_PROFILES['claude-track'];
  assert.equal(p.track, true);
  assert.deepEqual(p.track_agents, ['claude', 'claude-p', 'claude-track']);
  assert.equal(p.max_in_progress, 1, 'one track at a time by default: it is a long session');
  assert.ok(p.launch.includes('{prompt}'));
  for (const name of Object.keys(DEFAULT_PROFILES)) {
    if (name !== 'claude-track') assert.ok(!DEFAULT_PROFILES[name].track, `${name} must stay a node profile`);
  }
});

test('planTracks: a running track owns its nodes; a second track that wants one is refused', () => {
  const tasks = [
    node(41, { status: 'running' }), node(42, { status: 'todo', blocks: [41] }),
    node(26, { status: 'running', agent: 'claude-track', blocks: [42] }),
    node(30, { status: 'todo', agent: 'claude-track', blocks: [42] }),
  ];
  const plan = planTracks(tasks, CFG, { board: 'default' });

  assert.deepEqual([...plan.covered.entries()], [[41, 26], [42, 26]]);
  assert.deepEqual(plan.candidates.map((c) => [c.root.number, c.ok]), [[30, false]]);
  assert.match(plan.candidates[0].why, /#41 is already running in track #26/);
});

test('trackAlreadyAttempted is true only once a track attempt has ended', () => {
  assert.equal(trackAlreadyAttempted(runWith([{ attempt: 1, track: true, started_at: ago(60) }])), false);
  assert.equal(trackAlreadyAttempted(runWith([{ attempt: 1, track: true, started_at: ago(60), ended_at: ago(1) }])), true);
  assert.equal(trackAlreadyAttempted(runWith([{ attempt: 1, started_at: ago(60), ended_at: ago(1) }])), false);
  assert.equal(trackAlreadyAttempted(null), false);
});

// ---------- the track as a picture ----------

/** The worked example from protocol.md: two leaves, one middle node, the root. */
const graphTasks = () => [
  node(41, { title: 'Token bucket + tests' }),
  node(43, { title: 'Document the limits', status: 'todo' }),
  node(42, { title: 'Wire it into the server', status: 'todo', blocks: [41] }),
  node(12, { title: 'Rate-limit the public API', status: 'todo', agent: 'claude-track', blocks: [42, 43] }),
];

test('the graph is the track: one node per task, one edge per unfinished blocker, the wave as depth', () => {
  const g = trackGraph(resolveTrack(12, by(graphTasks())));

  assert.equal(g.root, 12);
  assert.deepEqual(g.nodes.map((n) => n.number), [41, 42, 43, 12], 'dependency order, the root last');
  assert.deepEqual(g.nodes.map((n) => n.wave), [0, 1, 0, 2]);
  assert.deepEqual(g.edges, [{ from: 41, to: 42 }, { from: 42, to: 12 }, { from: 43, to: 12 }]);
  assert.deepEqual(g.nodes.filter((n) => n.root).map((n) => n.number), [12]);
  assert.ok(g.nodes.every((n) => n.onBoard));
  assert.equal(g.cycle, null);
});

test('the mermaid block is a fenced flowchart: blockers on top, arrows to what they unblock, the root a stadium', () => {
  const m = trackMermaid(trackGraph(resolveTrack(12, by(graphTasks()))));

  assert.match(m, /^```mermaid\nflowchart TD\n/);
  assert.match(m, /\n```$/);
  assert.ok(m.includes('  n41["#35;41 · ready<br>Token bucket + tests"]'), m);
  assert.ok(m.includes('  n12(["#35;12 · todo<br>Rate-limit the public API"])'), 'the root is the one node you can pick out');
  assert.ok(m.includes('  n41 --> n42'));
  assert.ok(m.includes('  n43 --> n12'));
  assert.ok(!m.includes('undefined'));
});

test('a title with #123, a quote or angle brackets is escaped — a bare # renders as a wrong glyph, not an error', () => {
  const tasks = [
    node(7, { title: 'Fix the #123 regression' }),
    node(8, { title: 'The "hard" part' }),
    node(9, { title: 'hkb graph <n> --mermaid', status: 'todo', agent: 'claude-track', blocks: [7, 8] }),
  ];
  const m = trackMermaid(trackGraph(resolveTrack(9, by(tasks))));

  assert.ok(m.includes('Fix the #35;123 regression'), m);
  assert.ok(!m.includes('#123'), 'an unescaped #123 is a silently wrong glyph');
  assert.ok(m.includes('The #quot;hard#quot; part'), 'a raw quote would end the label');
  assert.ok(m.includes('hkb graph #60;n#62; --mermaid'), 'GitHub renders labels as HTML: <n> would be swallowed');
  assert.equal(mermaidLabel('#'), '#35;');
  assert.equal(mermaidLabel('"'), '#quot;', 'the # of an entity code must not itself be escaped');
  assert.equal(mermaidLabel('x'.repeat(80)), `${'x'.repeat(55)}…`, 'one long title must not make the whole graph wide');
});

test('classDefs tint the border only — a fill or a text colour is unreadable in one of GitHub\'s two themes', () => {
  const m = trackMermaid(trackGraph(resolveTrack(12, by(graphTasks()))));

  assert.match(m, /classDef ready stroke:/);
  assert.ok(!/fill:/.test(m), 'no fill: the theme owns the background');
  assert.ok(!/color:/.test(m), 'no text colour: the theme owns the text');
  assert.match(m, /class n41 ready/);
  assert.match(m, /class n42,n43,n12 todo/);
});

test('a blocker that is not on this board is drawn, not dropped — a hole is what a picture is for', () => {
  const tasks = [node(42, { status: 'todo', blocks: [41] }), node(12, { status: 'todo', agent: 'claude-track', blocks: [42] })];
  const g = trackGraph(resolveTrack(12, by(tasks))); // #41 was never added

  assert.deepEqual(g.nodes.map((n) => [n.number, n.onBoard]), [[42, true], [12, true], [41, false]]);
  const m = trackMermaid(g);
  assert.ok(m.includes('  n41["#35;41 · not on this board"]'), m);
  assert.ok(m.includes('  n41 --> n42'));
  assert.match(m, /class n41 offboard/);
});

test('a blocker closed as completed is finished work, so it is not in the picture either', () => {
  const tasks = [node(42, { blocks: [done(41)] }), node(12, { status: 'todo', agent: 'claude-track', blocks: [42] })];
  const m = trackMermaid(trackGraph(resolveTrack(12, by(tasks))));

  assert.ok(!m.includes('n41'), 'the track is what is left, and so is its diagram');
  assert.ok(m.includes('  n42 --> n12'));
});

test('`hkb graph <n>` prints the block; --json carries nodes, edges and the very same mermaid', async (t) => {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-graph-'));
  fs.mkdirSync(path.join(dir, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: gh.nameWithOwner }));
  gh.addIssue(kbIssue({ number: 41, title: 'Token bucket + tests', status: 'ready', agent: 'claude' }));
  gh.addIssue(kbIssue({ number: 12, title: 'Rate-limit the public API', status: 'todo', agent: 'claude', blockedBy: [41] }));
  const cwd = process.cwd();
  const restore = gh.install();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  process.chdir(dir);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restore(); fs.rmSync(dir, { recursive: true, force: true }); });

  await main(['graph', '12']);
  const text = printed;
  printed = '';
  await main(['graph', '--mermaid', '12']); // the flag takes no value: 12 stays the positional
  const flagged = printed;
  printed = '';
  await main(['graph', '12', '--json']);
  const j = JSON.parse(printed);

  assert.match(text, /^```mermaid\nflowchart TD\n/);
  assert.ok(text.includes('  n41 --> n12'));
  assert.equal(flagged, text, '--mermaid is what the command does anyway');
  assert.deepEqual(j.nodes.map((n) => n.number), [41, 12]);
  assert.deepEqual(j.edges, [{ from: 41, to: 12 }]);
  assert.equal(j.mermaid + '\n', text, '--json carries exactly what the command prints');
});

// ---------- the runner's prompt ----------

test('the runner prompt names the graph in waves, the per-node loop, and the root heartbeat', () => {
  const tasks = [
    node(41, { title: 'Token bucket', kb: { paths: ['src/limit.js'] } }),
    node(43, { title: 'Docs', kb: { paths: ['docs/'] } }),
    node(42, { title: 'Wire it in', status: 'todo', blocks: [41], kb: { paths: ['src/server.js'] } }),
    node(26, { title: 'Rate-limit the API', status: 'todo', agent: 'claude-track', blocks: [42, 43], body: 'the root brief' }),
  ];
  const track = resolveTrack(26, by(tasks));
  const p = trackContext({ repo: 'acme/board', board: 'default', track, attempt: 2 });

  assert.match(p, /^You are the TRACK RUNNER for hkb track #26 \(attempt 2\) in acme\/board, board "default"\./);
  assert.match(p, /# Track root #26: Rate-limit the API/);
  assert.ok(p.includes('the root brief'), 'the root body is the brief for the last pass');
  // every node, with its scope, in dependency order
  for (const n of [41, 42, 43]) assert.ok(p.includes(`#${n}`), `#${n} must be named`);
  assert.ok(p.indexOf('#41') < p.indexOf('#42'), 'blockers before what they block');
  assert.match(p, /wave 1 — nothing blocks these; they are the frontier, and they are independent of each other:/);
  assert.match(p, /wave 2 — blocked by wave 1:/);
  assert.match(p, /paths src\/server\.js/);
  // the loop
  assert.match(p, /`hkb context <n>`/);
  assert.match(p, /`hkb claim <n>`/);
  // the finishing command must be one a shell-vetting harness will actually run: `finish`, not the
  // `complete` builtin, and a redirect rather than a heredoc (#125)
  assert.match(p, /hkb finish <n> --from-stdin < \/tmp\/kb-<n>\.json/);
  assert.doesNotMatch(p, /hkb complete <n>/);
  assert.doesNotMatch(p, /<<'EOF'/);
  assert.match(p, /hkb block <n> "why" --kind/);
  assert.match(p, /hkb request-review <n> --summary/);
  assert.match(p, /One PR per node, and exactly one `Closes #` in it\./);
  // the three things a track does differently
  assert.match(p, /\*\*Heartbeat the root, not the nodes\.\*\* `hkb heartbeat 26`/);
  assert.match(p, /\*\*Claim as you go, never up front\.\*\*/);
  assert.match(p, /\*\*A node that blocks parks only its branch\.\*\*/);
  assert.match(p, /Start with `hkb context 41`\.$/);
  assert.ok(!p.includes('undefined'), 'no unsubstituted field');
});

test('the runner is told to keep KB_TASK on the root — a node claim must not steal it', () => {
  const track = resolveTrack(26, by(chain()));
  const p = trackContext({ repo: 'acme/board', board: 'default', track, attempt: 1 });
  assert.match(p, /Ignore the `export KB_TASK=…` line it prints — this session's KB_TASK is\n\s+the root, #26, and it must stay that way\./);
});

// ---------- the fan-out brief: one orchestrator, one isolated subagent per node ----------

/** The launch writes the prompt to a file and exits; the tick does not wait for it. */
async function readWhenWritten(file, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (s) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${file} was never written by the launch`);
}

/** the diamond of the acceptance: #41 and #43 are path-disjoint siblings, #42 waits for both. */
const diamond = () => [
  node(41, { title: 'Token bucket', kb: { paths: ['src/limit.js'] } }),
  node(43, { title: 'Docs', kb: { paths: ['docs/'] } }),
  node(42, { title: 'Wire it in', status: 'todo', blocks: [41, 43], kb: { paths: ['src/server.js'] } }),
  node(26, { title: 'Rate-limit the API', status: 'todo', agent: 'claude-track', blocks: [42], body: 'the root brief' }),
];

// The allow-list IS the capability: under `--permission-mode dontAsk` an unlisted tool is denied,
// never prompted, so a brief that told a runner without `Agent` to fan out would only buy it a
// refusal. That is why the brief is picked from the profile rather than assumed.
test('only a profile that may spawn subagents is told to — the allow-list picks the brief', () => {
  assert.equal(trackFanout(DEFAULT_BOARD, 'claude-track'), true, 'the shipped track profile carries Agent');
  assert.equal(trackFanout(DEFAULT_BOARD, 'claude'), false, 'a cold node worker stays single-agent');
  assert.equal(trackFanout(DEFAULT_BOARD, 'codex'), false, 'no allow-list at all is not permission to spawn');
  assert.equal(trackFanout(DEFAULT_BOARD, 'nope'), false);
  assert.equal(trackFanout({ profiles: { x: { allowed_tools: ['Agent'] } } }, 'x'), true);
});

test('the fan-out brief makes the runner an orchestrator: claim the wave, spawn one isolated subagent per node', () => {
  const track = resolveTrack(26, by(diamond()));
  const p = trackContext({ repo: 'acme/board', board: 'default', track, attempt: 1, fanout: true });

  assert.match(p, /^You are the TRACK RUNNER for hkb track #26 \(attempt 1\)/, 'SKILL.md keys off this opening');
  assert.match(p, /You are its ORCHESTRATOR/);
  assert.match(p, /you do not work the nodes\nyourself/);
  // the wave loop, in order
  assert.match(p, /## The wave loop/);
  assert.ok(p.indexOf('**Claim the wave.**') < p.indexOf('**Spawn one subagent per claimed node, all in one message**'));
  assert.match(p, /`isolation: "worktree"`/, 'two agents cannot share a checkout');
  assert.match(p, /\*\*Verify each node recorded a verb\*\*/);
  assert.match(p, /\*\*Only then start the next wave\.\*\*/);
  // the per-node brief the subagent gets: a pointer to its own context, not a pasted one
  assert.match(p, /## The per-node brief/);
  assert.match(p, /Run `hkb context <n>` first/);
  assert.match(p, /Commit AND push before you return/, 'the child worktree is deleted when it returns');
  assert.match(p, /hkb finish <n> --from-stdin < \/tmp\/kb-<n>\.json/);
  assert.match(p, /Do not spawn subagents of your own/);
  assert.doesNotMatch(p, /<<'EOF'/);
  // the siblings of wave 1 are named, and they go out together
  assert.match(p, /Start with wave 1: claim #41, #43, then spawn both subagents in one message\.$/);
  assert.ok(!p.includes('undefined'), 'no unsubstituted field');
});

test('fan-out or not, the per-node protocol and the track rules are the same', () => {
  const track = resolveTrack(26, by(diamond()));
  const seq = trackContext({ repo: 'acme/board', board: 'default', track, attempt: 1 });
  const fan = trackContext({ repo: 'acme/board', board: 'default', track, attempt: 1, fanout: true });

  for (const p of [seq, fan]) {
    assert.match(p, /\*\*Heartbeat the root, not the nodes\.\*\* `hkb heartbeat 26`/);
    assert.match(p, /\*\*A node that blocks parks only its branch\.\*\*/);
    assert.match(p, /Never `git push --force`/);
    assert.match(p, /hkb block <n> "why" --kind/);
    assert.ok(p.includes('kb.paths'), 'scope is a rule in both');
    assert.ok(p.includes('exactly one `Closes #'), 'one PR per node is what makes a node a checkpoint');
  }
  // and the sequential brief never mentions a tool it is not allowed to call
  assert.doesNotMatch(seq, /ORCHESTRATOR|isolation: "worktree"|## The wave loop/);
});

test('the dispatcher hands the runner the brief its profile can actually execute', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-trackprompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'prompt.txt');
  const launch = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.argv[1] || '')`, '{prompt}'];
  const spawner = (tools) => ({
    claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] },
    'claude-track': { mode: 'process', track: true, track_agents: ['claude', 'claude-track'], max_in_progress: 1, model: null, allowed_tools: tools, launch },
  });

  const h = harness({ profiles: spawner(['Agent']) });
  t.after(h.cleanup);
  seedChain(h.gh);
  await h.tick();
  assert.match(await readWhenWritten(out), /You are its ORCHESTRATOR/);

  fs.rmSync(out, { force: true });
  const plain = harness({ profiles: spawner([]) });
  t.after(plain.cleanup);
  seedChain(plain.gh);
  await plain.tick();
  const p = await readWhenWritten(out);
  assert.doesNotMatch(p, /ORCHESTRATOR/, 'a runner that cannot spawn is told to walk the nodes');
  assert.match(p, /## The loop — once per node/);
});

// ---------- the tick ----------

function harness({ dispatch = {}, host = 'test-host', profiles = null } = {}) {
  const gh = new FakeGh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-track-'));
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch },
    profiles: profiles || {
      claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] },
      'claude-track': { mode: 'process', track: true, track_agents: ['claude', 'claude-track'], max_in_progress: 1, model: null, allowed_tools: [], launch: ['true'] },
    },
  };
  const ctx = {
    root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host, json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  const logs = [];
  return {
    gh, ctx, root, logs,
    log: () => logs.join('\n'),
    tick: (opts = {}) => tick(ctx, { log: (m) => logs.push(m), ...opts }),
    cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** #41 → #42 → #26(track root): the three-node chain from the task's "Done when". */
function seedChain(gh, { root = {}, n41 = {}, n42 = {} } = {}) {
  gh.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude', kb: { paths: ['src/a.js'] }, ...n41 }));
  gh.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41], kb: { paths: ['src/b.js'] }, ...n42 }));
  gh.addIssue(kbIssue({ number: 26, status: 'todo', agent: 'claude-track', blockedBy: [42], kb: { paths: ['docs/'] }, ...root }));
}

test('a track root is claimed as ONE session, and its nodes are left to the runner', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.gh);

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.nodes]), [[26, true, [41, 42]]]);
  assert.equal(s.tracks[0].attempt, 1);
  assert.equal(s.tracks[0].profile, 'claude-track');
  assert.deepEqual(s.claimed, [], 'the ready leaf #41 is the runner\'s, not a worker\'s');
  assert.deepEqual(s.skipped, [{ number: 41, why: 'held for track #26' }]);
  assert.equal(h.gh.statusOf(26), 'running');
  assert.equal(h.gh.statusOf(41), 'ready', 'the runner claims it, when it gets there');
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/26/1'], 'one lock: the root');
  const [a] = h.gh.runOf(26).attempts;
  assert.equal(a.track, true);
  assert.deepEqual(a.track_nodes, [41, 42]);
  assert.equal(a.log, '.kanban/logs/26-1.log');
  assert.match(h.log(), /#26: claimed track attempt 1 → claude-track, 3 nodes #41 → #42 → #26/);
});

test('the whole track is one running slot, and its nodes are never reclaimed under it', async (t) => {
  const h = harness({ dispatch: { stale_after: 60, max_in_progress: 2 } });
  t.after(h.cleanup);
  // the runner is alive on the root and has claimed #42; #41 it already finished and closed
  const alive = runWith([{ attempt: 1, host: 'test-host', started_at: ago(120), heartbeat_at: ago(5), pid: process.pid, track: true, track_nodes: [41, 42] }]);
  const claimedByRunner = runWith([{ attempt: 1, host: 'test-host', started_at: ago(600), heartbeat_at: ago(600), manual: true }]);
  h.gh.addIssue(kbIssue({ number: 41, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 42, status: 'running', agent: 'claude', kb: { paths: ['src/b.js'] }, run: claimedByRunner }));
  h.gh.addIssue(kbIssue({ number: 26, status: 'running', agent: 'claude-track', kb: { max_runtime: 86_400, paths: ['docs/'] }, blockedBy: [42], run: alive }));
  h.gh.addIssue(kbIssue({ number: 50, status: 'ready', agent: 'claude', kb: { paths: ['test/z.js'] } }));
  h.gh.refs.set('refs/kb/locks/26/1', 'f'.repeat(40));
  h.gh.refs.set('refs/kb/locks/42/1', 'e'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [], 'a node with no pid of its own is not a crashed worker — it is a checkpoint');
  assert.equal(h.gh.statusOf(42), 'running');
  // two tasks are `running`, but only one session: #50 still gets the second slot
  assert.deepEqual(s.claimed.map((c) => c.number), [50]);
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/26/1', 'refs/kb/locks/42/1', 'refs/kb/locks/50/1'], 'both track locks survive, and #50 got one of its own');
  assert.match(h.log(), /#42: node of running track #26 — the root's heartbeat covers it/);
});

test('the runner dies mid-track: the board keeps what it finished and the plain dispatcher finishes the rest', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  // #41 completed and closed before the runner died; the root attempt has gone quiet
  const deadRunner = runWith([{ attempt: 1, host: 'other-host', started_at: ago(9000), heartbeat_at: ago(9000), track: true, track_nodes: [41, 42] }]);
  h.gh.addIssue(kbIssue({ number: 41, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41], kb: { paths: ['src/b.js'] } }));
  h.gh.addIssue(kbIssue({ number: 26, status: 'running', agent: 'claude-track', blockedBy: [42], kb: { max_runtime: 86_400, paths: ['docs/'] }, run: deadRunner }));
  h.gh.refs.set('refs/kb/locks/26/1', 'f'.repeat(40));

  const first = await h.tick();

  assert.deepEqual(first.reclaimed, [{ number: 26, outcome: 'reclaimed' }]);
  assert.equal(h.gh.statusOf(26), 'todo', 'the root goes back behind its open blocker, not to ready');
  assert.deepEqual(h.gh.lockRefs(), [], 'the root lock is released; the nodes never held one');
  assert.deepEqual(first.promoted, [42], '#41 is closed, so #42 is ready now');

  // the next tick, once the 90-second stale-read guard on our own writes has expired: node dispatch
  // takes over — one cold worker for #42, and no second track attempt
  const state = readState(h.root);
  state.touched = {};
  writeState(h.root, state);
  const second = await h.tick();

  assert.deepEqual(second.claimed.map((c) => [c.number, c.profile]), [[42, 'claude']]);
  assert.deepEqual(second.tracks.map((x) => [x.root, x.ok]), [[26, false]]);
  assert.match(second.tracks[0].why, /a track attempt already ran — node dispatch takes it from here/);
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/42/1']);
});

test('a spawn failure does not burn the track\'s one go — the runner never started', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.ctx.cfg.profiles['claude-track'].launch = ['/does/not/exist/claude'];
  seedChain(h.gh);

  const first = await h.tick();

  assert.deepEqual(first.spawn_failed.map((x) => [x.number, x.track]), [[26, true]]);
  assert.equal(h.gh.statusOf(26), 'todo', 'back behind its open blocker, not forced to ready');
  assert.deepEqual(h.gh.lockRefs(), [], 'the root lock is released, and the nodes are held for the retry');
  assert.deepEqual(first.skipped, [{ number: 41, why: 'held for track #26' }]);
  const [a] = h.gh.runOf(26).attempts;
  assert.equal(a.track, undefined);
  assert.equal(a.track_spawn_failed, true);
  assert.equal(a.outcome, 'spawn_failed');

  // a working binary next time: the track is offered again, not written off
  h.ctx.cfg.profiles['claude-track'].launch = ['true'];
  const state = readState(h.root);
  state.touched = {};
  writeState(h.root, state);
  const second = await h.tick();

  assert.deepEqual(second.tracks.map((x) => [x.root, x.ok, x.attempt]), [[26, true, 2]]);
});

test('a blocked node parks only its branch: the sibling still runs, the track waits for a human', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  //   41 (blocked, needs a human) → 42        43 (untouched sibling)
  //                                  └─ #26 ─┘
  h.gh.addIssue(kbIssue({ number: 41, status: 'blocked', needsHuman: true, agent: 'claude', kb: { paths: ['src/a.js'] } }));
  h.gh.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41], kb: { paths: ['src/b.js'] } }));
  h.gh.addIssue(kbIssue({ number: 43, status: 'ready', agent: 'claude', kb: { paths: ['docs/x.md'] } }));
  h.gh.addIssue(kbIssue({ number: 26, status: 'todo', agent: 'claude-track', blockedBy: [42, 43], kb: { paths: ['README.md'] } }));

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok]), [[26, false]]);
  assert.match(s.tracks[0].why, /#41 is blocked/);
  assert.deepEqual(s.claimed.map((c) => c.number), [43], 'the branch that is not parked keeps moving');
  assert.equal(h.gh.statusOf(42), 'todo');
  assert.equal(h.gh.statusOf(41), 'blocked');
  assert.ok(h.gh.labelsOf(41).includes(L.needsHuman));
  assert.equal(h.gh.statusOf(26), 'todo');
});

test('a track root whose subgraph is done is dispatched as an ordinary node — the verify pass', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 42, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 26, status: 'ready', agent: 'claude-track', blockedBy: [42] }));

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok]), [[26, false]]);
  assert.match(s.tracks[0].why, /nothing is blocking it any more/);
  assert.deepEqual(s.claimed.map((c) => [c.number, c.profile]), [[26, 'claude-track']]);
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/26/1']);
});

test('the path_overlap guard sees the whole track, not just the root', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const live = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.gh.addIssue(kbIssue({ number: 9, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run: live }));
  seedChain(h.gh); // #41 owns src/a.js — inside the running task's src/
  h.gh.refs.set('refs/kb/locks/9/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.why]), [[26, false, 'path_overlap']]);
  assert.equal(h.gh.statusOf(26), 'todo');
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/9/1']);
});

test('a dry run says which track it would take, and writes nothing', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.gh);

  const s = await h.tick({ dryRun: true });

  assert.deepEqual(s.tracks, [{ root: 26, nodes: [41, 42], ok: true, attempt: 1, profile: 'claude-track', dry: true }]);
  assert.deepEqual(s.claimed, [], 'the leaf is the track\'s, so it is not offered to a node worker either');
  assert.equal(h.gh.statusOf(26), 'todo');
  assert.deepEqual(h.gh.lockRefs(), []);
  assert.equal(h.gh.callsMatching('POST').length, 0);
  assert.equal(h.gh.callsMatching('PATCH').length, 0);
  assert.match(h.log(), /#26: \[dry-run\] would run track #41 → #42 → #26 as one claude-track session/);
});

// ---------- the shipped skill ----------

test('the skill teaches the loop the runner is actually given, by the names the code uses', () => {
  const dir = fileURLToPath(new URL('../skills/kanban/', import.meta.url));
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const proto = fs.readFileSync(path.join(dir, 'references', 'protocol.md'), 'utf8');

  assert.match(skill, /^## When you run a track/m, 'the runner has to find its own section');
  for (const bit of ['hkb context <n>', 'hkb claim <n>', 'hkb heartbeat <root>', 'claude-track', 'track_agents']) {
    assert.ok(skill.includes(bit), `SKILL.md must name ${bit}`);
  }
  assert.match(skill, /One PR per node/, 'the PR decision has to be written down where the runner reads it');
  assert.match(proto, /^## Tracks — the second execution engine/m);
  assert.ok(proto.includes('track_nodes'), 'the attempt fields a track adds must be in the data model');
  // the version has to move, or `hkb doctor` will call a stale installed copy current
  assert.equal(parseSkillVersion(skill), '0.7.0');
});

test('with no track profile on the board nothing changes: the same claims, and no track work', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.gh, { root: { agent: 'claude' } });

  const s = await h.tick();

  assert.deepEqual(s.tracks, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [41]);
});
