// Tracks: resolving a subgraph out of the board, deciding whether one session may have it, the
// prompt that session gets, and what the tick does with it. The dispatch half runs against the
// in-memory GitHub (test/fake-gh.js) with `["true"]` as every launch template, so no worker runs —
// the point is what the *board* looks like before and after, including after a runner dies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick, trackConflictPass } from '../src/dispatch.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES, readState, writeState } from '../src/board.js';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KB, L, parseSkillVersion, isTrackRoot, trackProfileFor, unfinishedChildren, trackBranchName, trackBranchRoot, trackBranchConflict } from '../src/model.js';
import {
  resolveTrack, trackWaves, trackPaths, trackReadiness, planTracks, trackContext,
  trackAlreadyAttempted, isTrackProfile, trackAgents, trackGraph, trackMermaid, mermaidLabel, trackFanout,
} from '../src/track.js';
import { main } from '../src/cli.js';
import { FakeGh } from './fake-gh.js';
import { FakeStore, kbIssue, runWith } from './fake-store.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

const CFG = {
  profiles: {
    claude: { max_in_progress: 2 },
    codex: { max_in_progress: 1 },
    'claude-track': { track: true, track_agents: ['claude', 'claude-track'], max_in_progress: 1 },
  },
};

/** A task in the shape `toTask` produces, with only the fields tracks read. */
function node(number, { title, status = 'ready', agent = 'claude', blocks = [], kb = {}, prs = [], needsHuman = false, body = 'do it', labels = [] } = {}) {
  return {
    number,
    title: title || `task ${number}`,
    bodyText: body,
    status,
    agent,
    labels,
    needsHuman,
    prs,
    kb: { ...DEFAULT_KB, ...kb },
    blockedBy: blocks.map((b) => (typeof b === 'number' ? { number: b, state: 'OPEN', stateReason: null, title: `task ${b}` } : b)),
  };
}
const done = (n) => ({ number: n, state: 'CLOSED', stateReason: 'COMPLETED', title: `task ${n}` });
/** An `isTrackRoot` verdict, small enough to assert a table of. */
const pick = (d) => [d.mode, d.track, d.profile];
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
    [chain({ 26: { agent: 'codex' } }), /profile codex does not run tracks/],
    [chain({ 26: { agent: 'claude', labels: [L.noTrack] } }), /kb:no-track — its children run as cold nodes/],
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

test('`hkb track <n>` says which it is and why, and --off/--on is the switch', async (t) => {
  const gh = new FakeGh();
  const store = new FakeStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-trackcmd-'));
  fs.mkdirSync(path.join(dir, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: gh.nameWithOwner }));
  store.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude' }));
  store.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41] }));
  store.addIssue(kbIssue({ number: 12, status: 'todo', agent: 'claude', blockedBy: [42] }));
  const cwd = process.cwd();
  const restore = gh.install();
  const restoreStore = store.install();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  process.chdir(dir);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restoreStore(); restore(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = async (...argv) => { printed = ''; await main(argv); return printed; };

  assert.match(await run('track', '12'), /#12 track: inferred — 1 unfinished child; one claude-track session runs the subgraph/);
  assert.match(printed, /nodes: #41 → #42 → #12/);
  assert.match(await run('track', '42'), /#12 is still blocked by it — it is a node of that track, not a root/);

  await run('track', '12', '--off');
  assert.ok(store.labelsOf(12).includes(L.noTrack));
  const off = JSON.parse(await run('track', '12', '--json'));
  assert.deepEqual([off.mode, off.track, off.nodes], ['opted-out', false, []]);
  assert.match(await run('show', '12'), /^track: opted out — kb:no-track .* \(`hkb track 12 --on` puts it back\)$/m);

  await run('track', '12', '--on');
  assert.ok(!store.labelsOf(12).includes(L.noTrack));
  assert.equal(JSON.parse(await run('show', '12', '--json')).track.mode, 'inferred');
});

test('`hkb graph <n>` prints the block; --json carries nodes, edges and the very same mermaid', async (t) => {
  const gh = new FakeGh();
  const store = new FakeStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-graph-'));
  fs.mkdirSync(path.join(dir, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: gh.nameWithOwner }));
  store.addIssue(kbIssue({ number: 41, title: 'Token bucket + tests', status: 'ready', agent: 'claude' }));
  store.addIssue(kbIssue({ number: 12, title: 'Rate-limit the public API', status: 'todo', agent: 'claude', blockedBy: [41] }));
  const cwd = process.cwd();
  const restore = gh.install();
  const restoreStore = store.install();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  process.chdir(dir);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); restoreStore(); restore(); fs.rmSync(dir, { recursive: true, force: true }); });

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

// #273: `trackFanout` used to read `allowed_tools` off the profile directly, so a root card that
// narrowed its own grant away from `Agent` (`kb.tools`) was still told to fan out — a brief the
// runner's own launch line, built from `effectiveTools`, would then refuse. Routing through the same
// derivation keeps the two in agreement.
test('a card that narrows Agent out of its own grant does not get the fan-out brief', () => {
  const cfg = { profiles: { 'claude-track': { allowed_tools: ['Agent', 'Bash(git *)'] } } };
  const root = node(26, { agent: 'claude-track', kb: { tools: ['Bash(git *)'] } });
  assert.equal(trackFanout(cfg, 'claude-track', root), false, 'kb.tools dropped Agent — no fan-out');
  assert.equal(trackFanout(cfg, 'claude-track'), true, 'with no card the profile grant alone still says yes');
  assert.equal(trackFanout(cfg, 'claude-track', node(26, { agent: 'claude-track' })), true,
    'a card with no kb.tools narrowing leaves the grant untouched');
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
  assert.match(p, /Commit AND push before you return/, 'the child worktree only goes away automatically when left unchanged');
  assert.match(p, /hkb finish <n> --from-stdin < \/tmp\/kb-<n>\.json/);
  assert.match(p, /Do not spawn subagents of your own/);
  assert.doesNotMatch(p, /<<'EOF'/);
  // #197.1: the child's `hkb context <n>` says "work on the current branch" — that is the child's own
  // throwaway checkout, not the node's, so the per-node brief overrides it explicitly
  assert.match(p, /its current-branch line\n\s+does not apply to you/);
  assert.match(p, /`kb\/<n>`, based on `kb\/track-26` \(the track branch — see step 2\), the next step/);
  // #197.1: the orchestrator's own turn ends the moment it spawns a wave and it cannot wake itself
  // (ScheduleWakeup is not allow-listed), so each child must heartbeat the *root*, not itself
  assert.match(p, /Run `hkb heartbeat 26` — the root, not #<n> — every ~10 minutes while you work/);
  // #197.1: a spawn that errors leaves a node claimed with nobody working it — the wave loop must say
  // what to do about it, not just how to spawn
  assert.match(p, /If a spawn itself fails/);
  assert.match(p, /Work it yourself\n\s+in this checkout, sequentially, or `hkb block <n> "<why>" --kind transient`/);
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
  seedChain(h.store);
  await h.tick();
  assert.match(await readWhenWritten(out), /You are its ORCHESTRATOR/);

  fs.rmSync(out, { force: true });
  const plain = harness({ profiles: spawner([]) });
  t.after(plain.cleanup);
  seedChain(plain.store);
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
  const store = new FakeStore({ host });
  const restoreStore = store.install(ctx);
  const logs = [];
  return {
    gh, store, ctx, root, logs,
    log: () => logs.join('\n'),
    tick: (opts = {}) => tick(ctx, { log: (m) => logs.push(m), ...opts }),
    cleanup: () => { restoreStore(); restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** #41 → #42 → #26(track root): the three-node chain from the task's "Done when". */
function seedChain(store, { root = {}, n41 = {}, n42 = {} } = {}) {
  store.addIssue(kbIssue({ number: 41, status: 'ready', agent: 'claude', kb: { paths: ['src/a.js'] }, ...n41 }));
  store.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41], kb: { paths: ['src/b.js'] }, ...n42 }));
  store.addIssue(kbIssue({ number: 26, status: 'todo', agent: 'claude-track', blockedBy: [42], kb: { paths: ['docs/'] }, ...root }));
}

test('a track root is claimed as ONE session, and its nodes are left to the runner', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.store);

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.nodes]), [[26, true, [41, 42]]]);
  assert.equal(s.tracks[0].attempt, 1);
  assert.equal(s.tracks[0].profile, 'claude-track');
  assert.deepEqual(s.claimed, [], 'the ready leaf #41 is the runner\'s, not a worker\'s');
  assert.deepEqual(s.skipped, [{ number: 41, why: 'held for track #26' }]);
  assert.equal(h.store.statusOf(26), 'running');
  assert.equal(h.store.statusOf(41), 'ready', 'the runner claims it, when it gets there');
  assert.deepEqual(await h.store.locks(), ['26/1'], 'one lock: the root');
  const [a] = h.store.runOf(26).attempts;
  assert.equal(a.track, true);
  assert.deepEqual(a.track_nodes, [41, 42]);
  assert.equal(a.log, '.kanban/logs/26-1.log');
  assert.match(h.log(), /#26: claimed track attempt 1 → claude-track \(forced\), 3 nodes #41 → #42 → #26/);
  // the track branch: created from the default branch, at claim time, and recorded on the row —
  // a runner that dies must not strand work nothing on the board can find
  assert.equal(a.track_branch, 'kb/track-26');
  assert.equal(h.gh.refs.get('refs/heads/kb/track-26'), h.gh.refs.get(`refs/heads/${h.gh.defaultBranch}`));
});

test('a track branch already there (a retry after a crashed first claim) is reused, never recreated', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.store);
  // seed the branch as if a previous, now-dead claim already made it, at some other sha —
  // ensureTrackBranch must not try to recreate it and must not lose the existing one
  h.gh.refs.set('refs/heads/kb/track-26', 'c'.repeat(40));

  const s = await h.tick();

  assert.equal(s.tracks[0].ok, true);
  assert.equal(h.gh.refs.get('refs/heads/kb/track-26'), 'c'.repeat(40), 'the existing branch survives untouched');
  const [a] = h.store.runOf(26).attempts;
  assert.equal(a.track_branch, 'kb/track-26');
});

test('the whole track is one running slot, and its nodes are never reclaimed under it', async (t) => {
  const h = harness({ dispatch: { stale_after: 60, max_in_progress: 2 } });
  t.after(h.cleanup);
  // the runner is alive on the root and has claimed #42; #41 it already finished and closed
  const alive = runWith([{ attempt: 1, host: 'test-host', started_at: ago(120), heartbeat_at: ago(5), pid: process.pid, track: true, track_nodes: [41, 42] }]);
  const claimedByRunner = runWith([{ attempt: 1, host: 'test-host', started_at: ago(600), heartbeat_at: ago(600), manual: true }]);
  h.store.addIssue(kbIssue({ number: 41, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 42, status: 'running', agent: 'claude', kb: { paths: ['src/b.js'] }, run: claimedByRunner }));
  h.store.addIssue(kbIssue({ number: 26, status: 'running', agent: 'claude-track', kb: { max_runtime: 86_400, paths: ['docs/'] }, blockedBy: [42], run: alive }));
  h.store.addIssue(kbIssue({ number: 50, status: 'ready', agent: 'claude', kb: { paths: ['test/z.js'] } }));
  h.store.hold(26, 1);
  h.store.hold(42, 1);

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [], 'a node with no pid of its own is not a crashed worker — it is a checkpoint');
  assert.equal(h.store.statusOf(42), 'running');
  // two tasks are `running`, but only one session: #50 still gets the second slot
  assert.deepEqual(s.claimed.map((c) => c.number), [50]);
  assert.deepEqual(await h.store.locks(), ['26/1', '42/1', '50/1'], 'both track locks survive, and #50 got one of its own');
  assert.match(h.log(), /#42: node of running track #26 — the root's heartbeat covers it/);
});

test('the runner dies mid-track: the board keeps what it finished and the plain dispatcher finishes the rest', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  // #41 completed and closed before the runner died; the root attempt has gone quiet
  const deadRunner = runWith([{ attempt: 1, host: 'other-host', started_at: ago(9000), heartbeat_at: ago(9000), track: true, track_nodes: [41, 42] }]);
  h.store.addIssue(kbIssue({ number: 41, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41], kb: { paths: ['src/b.js'] } }));
  h.store.addIssue(kbIssue({ number: 26, status: 'running', agent: 'claude-track', blockedBy: [42], kb: { max_runtime: 86_400, paths: ['docs/'] }, run: deadRunner }));
  h.store.hold(26, 1);

  const first = await h.tick();

  assert.deepEqual(first.reclaimed, [{ number: 26, outcome: 'reclaimed' }]);
  assert.equal(h.store.statusOf(26), 'todo', 'the root goes back behind its open blocker, not to ready');
  assert.deepEqual(await h.store.locks(), [], 'the root lock is released; the nodes never held one');
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
  assert.deepEqual(await h.store.locks(), ['42/1']);
});

test('a spawn failure does not burn the track\'s one go — the runner never started', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.ctx.cfg.profiles['claude-track'].launch = ['/does/not/exist/claude'];
  seedChain(h.store);

  const first = await h.tick();

  assert.deepEqual(first.spawn_failed.map((x) => [x.number, x.track]), [[26, true]]);
  assert.equal(h.store.statusOf(26), 'todo', 'back behind its open blocker, not forced to ready');
  assert.deepEqual(await h.store.locks(), [], 'the root lock is released, and the nodes are held for the retry');
  assert.deepEqual(first.skipped, [{ number: 41, why: 'held for track #26' }]);
  const [a] = h.store.runOf(26).attempts;
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
  h.store.addIssue(kbIssue({ number: 41, status: 'blocked', needsHuman: true, agent: 'claude', kb: { paths: ['src/a.js'] } }));
  h.store.addIssue(kbIssue({ number: 42, status: 'todo', agent: 'claude', blockedBy: [41], kb: { paths: ['src/b.js'] } }));
  h.store.addIssue(kbIssue({ number: 43, status: 'ready', agent: 'claude', kb: { paths: ['docs/x.md'] } }));
  h.store.addIssue(kbIssue({ number: 26, status: 'todo', agent: 'claude-track', blockedBy: [42, 43], kb: { paths: ['README.md'] } }));

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok]), [[26, false]]);
  assert.match(s.tracks[0].why, /#41 is blocked/);
  assert.deepEqual(s.claimed.map((c) => c.number), [43], 'the branch that is not parked keeps moving');
  assert.equal(h.store.statusOf(42), 'todo');
  assert.equal(h.store.statusOf(41), 'blocked');
  assert.ok(h.store.labelsOf(41).includes(L.needsHuman));
  assert.equal(h.store.statusOf(26), 'todo');
});

test('a track root whose subgraph is done is dispatched as an ordinary node — the verify pass', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 42, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 26, status: 'ready', agent: 'claude-track', blockedBy: [42] }));

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok]), [[26, false]]);
  assert.match(s.tracks[0].why, /nothing is blocking it any more/);
  assert.deepEqual(s.claimed.map((c) => [c.number, c.profile]), [[26, 'claude-track']]);
  assert.deepEqual(await h.store.locks(), ['26/1']);
});

test('the path_overlap guard sees the whole track, not just the root', async (t) => {
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const live = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.store.addIssue(kbIssue({ number: 9, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run: live }));
  seedChain(h.store); // #41 owns src/a.js — inside the running task's src/
  h.store.hold(9, 1);

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.why]), [[26, false, 'path_overlap']]);
  assert.equal(h.store.statusOf(26), 'todo');
  assert.deepEqual(await h.store.locks(), ['9/1']);
});

test('a dry run says which track it would take, and writes nothing', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.store);

  const s = await h.tick({ dryRun: true });

  assert.deepEqual(s.tracks, [{ root: 26, nodes: [41, 42], ok: true, attempt: 1, profile: 'claude-track', mode: 'forced', dry: true }]);
  assert.deepEqual(s.claimed, [], 'the leaf is the track\'s, so it is not offered to a node worker either');
  assert.equal(h.store.statusOf(26), 'todo');
  assert.deepEqual(await h.store.locks(), []);
  assert.deepEqual(h.store.writes(), []);
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
  assert.equal(parseSkillVersion(skill), '0.9.0');
});

test('a root nobody adopted is a track anyway: inferred, on the board\'s track profile', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.store, { root: { agent: 'claude' } }); // exactly what /kanban:decompose leaves behind

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.mode, x.profile]), [[26, true, 'inferred', 'claude-track']]);
  assert.deepEqual(s.claimed, [], 'the leaf is the track\'s: no cold session for it');
  assert.equal(h.store.statusOf(26), 'running');
  assert.deepEqual(await h.store.locks(), ['26/1']);
  assert.deepEqual(h.store.labelsOf(26).filter((l) => l.startsWith('kb:agent:')), ['kb:agent:claude'],
    'the decision never rewrites the label — that label is what node dispatch reads on a fallback');
  const [a] = h.store.runOf(26).attempts;
  assert.equal(a.profile, 'claude-track', 'the launch is the track profile\'s, whatever the card says');
  assert.equal(a.track_mode, 'inferred');
});

test('kb:no-track opts a goal out: its children run as cold nodes, one at a time', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  seedChain(h.store, { root: { agent: 'claude', labels: [L.noTrack] } });

  const s = await h.tick();

  assert.deepEqual(s.tracks, [], 'not even a candidate: it is not a root any more');
  assert.deepEqual(s.claimed.map((c) => [c.number, c.profile]), [[41, 'claude']]);
  assert.equal(h.store.statusOf(26), 'todo');
});

test('a board with no track profile at all keeps node dispatch — inference has nothing to infer to', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  delete h.ctx.cfg.profiles['claude-track'];
  seedChain(h.store, { root: { agent: 'claude' } });

  const s = await h.tick();

  assert.deepEqual(s.tracks, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [41]);
});

test('only the outermost root is inferred: an interior node is a node of the bigger track', () => {
  //   41 → 42 → 26, with nothing labelled: 42 has an unfinished child, but 26 is still waiting on it
  const tasks = [node(41), node(42, { status: 'todo', blocks: [41] }), node(26, { status: 'todo', blocks: [42] })];
  const plan = planTracks(tasks, CFG, { board: 'default' });

  assert.deepEqual(plan.candidates.map((c) => [c.root.number, c.ok, c.mode]), [[26, true, 'inferred']]);
  assert.deepEqual([...plan.profiles.entries()], [[26, 'claude-track']]);
  assert.equal(isTrackRoot(tasks[1], CFG, { board: tasks }).track, false, '#42 is a node, not a root');
  assert.match(isTrackRoot(tasks[1], CFG, { board: tasks }).why, /#26 is still blocked by it/);
  assert.equal(isTrackRoot(tasks[1], CFG).track, true, 'in isolation, with no board, it reads as a root of its own');
});

test('isTrackRoot: the graph decides, the label overrides in both directions', () => {
  const withChildren = (over = {}) => node(26, { status: 'todo', blocks: [41, 42], ...over });

  assert.deepEqual(pick(isTrackRoot(withChildren(), CFG)), ['inferred', true, 'claude-track']);
  assert.equal(isTrackRoot(withChildren(), CFG).why, '2 unfinished children');
  assert.equal(isTrackRoot(node(26, { status: 'todo', blocks: [41] }), CFG).why, '1 unfinished child');
  assert.deepEqual(pick(isTrackRoot(withChildren({ agent: 'claude-track' }), CFG)), ['forced', true, 'claude-track']);
  assert.deepEqual(pick(isTrackRoot(withChildren({ labels: [L.noTrack] }), CFG)), ['opted-out', false, null]);
  assert.deepEqual(pick(isTrackRoot(withChildren({ agent: 'codex' }), CFG)), ['none', false, null]);
  // a leaf is never a track, and a root whose children are all done is a plain node again
  assert.deepEqual(pick(isTrackRoot(node(41), CFG)), ['none', false, null]);
  assert.deepEqual(pick(isTrackRoot(node(26, { blocks: [done(41)] }), CFG)), ['none', false, null]);
  // ...but an explicitly adopted root stays forced, so trackReadiness says it in its own words
  assert.deepEqual(pick(isTrackRoot(node(26, { agent: 'claude-track', blocks: [done(41)] }), CFG)), ['forced', true, 'claude-track']);
  assert.deepEqual(pick(isTrackRoot(null, CFG)), ['none', false, null]);

  assert.equal(trackProfileFor(CFG, 'claude'), 'claude-track');
  assert.equal(trackProfileFor(CFG, 'codex'), null, 'track_agents is what a runner can execute');
  assert.equal(trackProfileFor({ profiles: { claude: {} } }, 'claude'), null);
  assert.deepEqual(unfinishedChildren(node(26, { blocks: [41, done(42)] })), [41]);
});

// ---------- surfacing a child-vs-child conflict on the track branch (#245) ----------

test('two children conflicting on the way into the track branch is flagged once, as an event', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const branch = 'kb/track-26';
  const live = runWith([{ attempt: 1, host: h.ctx.host, started_at: ago(60), heartbeat_at: ago(5), track: true, track_branch: branch, track_nodes: [41, 42] }]);
  h.store.addIssue(kbIssue({ number: 26, status: 'running', agent: 'claude-track', kb: { max_runtime: 86_400, paths: ['docs/'] }, run: live }));
  h.gh.refs.set(`refs/heads/${branch}`, 'f'.repeat(40));
  h.gh.addPull({ number: 100, head: 'kb/41', base: branch, mergeable: 'CONFLICTING' });
  h.gh.addPull({ number: 101, head: 'kb/42', base: branch, mergeable: 'MERGEABLE' });

  const s = await h.tick();

  assert.deepEqual(s.track_conflicts.map((c) => [c.root, c.branch, c.conflicting]), [[26, branch, [100]]]);
  assert.ok(h.store.issues.get(26).labels.includes(L.needsHuman), 'the event: kb:needs-human lands on the root');
  assert.ok(h.store.issues.get(26).comments.some((c) => /track conflict/.test(c.body) && /#100/.test(c.body)));

  // a second tick must not re-notify: the attempt row remembers it already flagged this branch
  const [a] = h.store.runOf(26).attempts;
  assert.equal(a.track_conflict_notified, true);
  const before = h.store.issues.get(26).comments.length;
  await h.tick();
  assert.equal(h.store.issues.get(26).comments.length, before, 'no repeat comment once notified');
});

test('trackBranchConflict: fewer than two PRs, or none CONFLICTING, is never a conflict', () => {
  assert.equal(trackBranchConflict(new Map([[1, { mergeable: 'CONFLICTING' }]])), null, 'one PR cannot conflict with itself');
  assert.equal(trackBranchConflict(new Map([[1, { mergeable: 'MERGEABLE' }], [2, { mergeable: 'UNKNOWN' }]])), null, 'UNKNOWN is "ask again", never a false positive');
  assert.deepEqual(trackBranchConflict(new Map([[1, { mergeable: 'CONFLICTING' }], [2, { mergeable: 'MERGEABLE' }]])), [1]);
});

// ---------- naming the track branch (#245) ----------

test('trackBranchName / trackBranchRoot round-trip, and only match hkb\'s own shape', () => {
  assert.equal(trackBranchName(26), 'kb/track-26');
  assert.equal(trackBranchRoot('kb/track-26'), 26);
  assert.equal(trackBranchRoot('kb/26'), null, 'a node\'s own branch is not a track branch');
  assert.equal(trackBranchRoot('kb/track-abc'), null);
});
