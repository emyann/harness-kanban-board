// A track is a connected subgraph of the board: a root task plus everything it is *still* blocked by.
//
// The dispatcher is one engine — a global ready frontier, one cold session per node, perfect
// durability, and a tick of latency plus a re-derived context between every dependent pair. The
// track runner is the second: ONE session executes a whole subgraph like a workflow, nodes in
// dependency order, context flowing in memory. The board stays the source of truth either way —
// every node is claimed, worked and finished with its own terminal verb, so every node is a durable
// checkpoint and a runner that dies mid-track costs nothing but the session. Whatever is left is
// dispatched node by node, by the ordinary tick, with no new crash semantics.
//
// Everything here is pure: a function of the board read the tick already did. No I/O, no request.
// The per-node brief is deliberately *not* built here — `hkb context <n>` prints exactly the
// `workerContext` that node's own cold worker would get, so the runner fetches it at the moment it
// starts the node instead of the dispatcher paying for every node up front.
//
// Every node branches from the track's own integration branch, `kb/track-<root>`
// (`trackBranchName`, `src/model.js`; created at claim time by `ensureTrackBranch`, `src/lock.js`,
// and recorded on the root's attempt row as `track_branch`) — never from a sibling. A **dead
// runner's** leftover nodes are a deliberate, documented gap: `src/context.js`'s ordinary cold
// worker brief does not (yet) look up an ancestor track's branch, so node dispatch picking up what
// a runner left behind bases a fresh worktree on the default branch, not the track branch — it
// cannot see its still-unmerged siblings' work. `hkb doctor`'s `checkTrackBranches` is the safety
// net: it flags a track branch with no live runner so a human can reconcile it by hand (rebase the
// leftover node onto it, or force the root back onto a track profile) rather than the tick silently
// losing the assembled work, which was exactly #227/#229's failure mode this file replaces.
import { blockerDone, sortForDispatch, isTrackRoot, trackBranchName } from './model.js';

/** Statuses a track may start from — for the root and for every node. */
export const TRACK_STARTABLE = ['todo', 'ready'];

/** Does this profile execute whole tracks? `"track": true` on the profile in `.kanban/board.json`. */
export function isTrackProfile(cfg, name) {
  return !!(name && cfg?.profiles?.[name]?.track);
}

/**
 * May this profile's runner fan a wave out to one subagent per node? The tool allow-list is the whole
 * answer: a launch under `--permission-mode dontAsk` DENIES a tool that is not on it rather than
 * prompting, so a brief that told an un-allow-listed runner to spawn would only buy it a refusal.
 * `claude-track` carries `Agent`; every other shipped profile does not, and gets the sequential brief,
 * which is always a correct way to run a track — the board reads the same either way.
 */
export function trackFanout(cfg, name) {
  const tools = cfg?.profiles?.[name]?.allowed_tools;
  return Array.isArray(tools) && tools.includes('Agent');
}

/**
 * Node profiles a track profile can run inside its own session (`track_agents` in board.json).
 * A track with a node outside this set needs a second harness, and one session cannot be two — so
 * it is simply not claimable as a track and falls back to node dispatch. Unset → only its own name.
 */
export function trackAgents(cfg, name) {
  const list = cfg?.profiles?.[name]?.track_agents;
  return new Set(Array.isArray(list) && list.length ? list : [name]);
}

/**
 * The subgraph under a root: the root plus every task it is still blocked by, transitively.
 * A blocker closed as completed is finished work, not a node — so a track shrinks as it runs and a
 * resumed track is exactly what is left of it.
 *
 * @param byNumber Map<number, task> — the open board, keyed by issue number
 * @returns {{root, order, nodes, missing, cycle}}
 *   order    every task in dependency order: blockers first, the root last
 *   nodes    `order` without the root — what has to run before the root's own verify pass
 *   missing  unfinished blockers that are not on this board (another board, or closed as not planned)
 *   cycle    the first cycle found, as issue numbers, or null
 */
export function resolveTrack(rootNumber, byNumber) {
  const n0 = Number(rootNumber);
  const root = byNumber.get(n0) || null;
  const out = { root, order: [], nodes: [], missing: [], cycle: null };
  if (!root) return out;
  const state = new Map(); // number -> 'open' (on the stack) | 'done'
  const visit = (n, path) => {
    if (state.get(n) === 'done') return;
    if (state.get(n) === 'open') { out.cycle = out.cycle || [...path.slice(path.indexOf(n)), n]; return; }
    const t = byNumber.get(n);
    if (!t) { if (!out.missing.includes(n)) out.missing.push(n); return; }
    state.set(n, 'open');
    for (const b of t.blockedBy || []) {
      if (blockerDone(b)) continue; // already merged and closed: not a node of this track
      visit(Number(b.number), [...path, n]);
    }
    state.set(n, 'done');
    out.order.push(t); // post-order: everything this task waits on is already in
  };
  visit(n0, []);
  out.nodes = out.order.filter((t) => t.number !== root.number);
  return out;
}

/**
 * The track split into waves: nothing in a wave depends on anything else in it, so a runner may fan
 * one wave out to subagents. Wave 0 is the frontier — the nodes that can start right now.
 */
export function trackWaves(track) {
  const inTrack = new Set(track.order.map((t) => t.number));
  const depth = new Map();
  for (const t of track.order) { // topological, so every in-track blocker already has a depth
    const deps = (t.blockedBy || [])
      .map((b) => Number(b.number))
      .filter((n) => inTrack.has(n))
      .map((n) => depth.get(n) ?? 0);
    depth.set(t.number, deps.length ? Math.max(...deps) + 1 : 0);
  }
  const waves = [];
  for (const t of track.order) {
    const d = depth.get(t.number);
    (waves[d] = waves[d] || []).push(t);
  }
  return waves.map((w) => w || []);
}

/** Every path any node of the track claims — what the dispatcher's `path_overlap` guard must use. */
export function trackPaths(track) {
  const out = [];
  for (const t of track.order) for (const p of t.kb?.paths || []) if (!out.includes(p)) out.push(p);
  return out;
}

/**
 * May the dispatcher hand this whole subgraph to one session? Pure.
 *
 * Every "no" is a fallback, never an error: node dispatch is the durable engine and is always
 * available, so anything unusual — a node someone else owns, a node on a different harness, a
 * blocker off the board, a node a human has to look at — simply means "dispatch it node by node".
 * Which profile runs it is the decision's, not the label's: an *inferred* track runs on the board's
 * track profile while the root keeps its own `kb:agent:*` (that label is what the root's own node
 * pass, and every fallback to node dispatch, still reads).
 *
 * @param tasks the open board, for the maximality half of `isTrackRoot` — omit and an interior
 *   node of a chain reads as a root of its own.
 * @returns {{ok, why, waves, profile, mode}} `why` is the reason either way, for the log and `--json`.
 */
export function trackReadiness(track, cfg, { board = null, tasks = null } = {}) {
  let no = (why, extra = {}) => ({ ok: false, why, waves: [], profile: null, mode: 'none', ...extra });
  const root = track.root;
  if (!root) return no('no such task on the board');
  const decision = isTrackRoot(root, cfg, { board: tasks });
  if (!decision.track) return no(decision.why, { mode: decision.mode });
  const profileName = decision.profile;
  // from here every refusal is a fallback for a task that *is* a root: keep saying which kind.
  no = (why) => ({ ok: false, why, waves: [], profile: profileName, mode: decision.mode });
  if (track.cycle) return no(`the subgraph has a cycle: ${track.cycle.map((n) => `#${n}`).join(' → ')}`);
  if (!TRACK_STARTABLE.includes(root.status)) return no(`the root is ${root.status}`);
  if (root.needsHuman) return no(`#${root.number} needs a human`);
  if ((root.prs || []).some((p) => p.state === 'OPEN')) return no(`#${root.number} already has an open PR`);
  if (!track.nodes.length) return no('nothing is blocking it any more — dispatch it as a single node');
  if (track.missing.length) return no(`${track.missing.map((n) => `#${n}`).join(', ')} block the track but are not on board "${board ?? '?'}"`);
  const allowed = trackAgents(cfg, profileName);
  for (const t of track.nodes) {
    if (!TRACK_STARTABLE.includes(t.status)) return no(`#${t.number} is ${t.status}`);
    if (t.needsHuman) return no(`#${t.number} needs a human`);
    if ((t.prs || []).some((p) => p.state === 'OPEN')) return no(`#${t.number} already has an open PR`);
    // cross-harness tracks are out of scope on purpose: one session is one harness
    if (t.agent && !allowed.has(t.agent)) return no(`#${t.number} runs on ${t.agent}, which a ${profileName} runner cannot execute`);
  }
  const now = new Date();
  const later = track.order.find((t) => t.kb?.scheduled_at && new Date(t.kb.scheduled_at) > now);
  if (later) return no(`#${later.number} is scheduled for ${later.kb.scheduled_at}`);
  return {
    ok: true,
    why: `${track.nodes.length} node${track.nodes.length === 1 ? '' : 's'} then the root`,
    waves: trackWaves(track),
    profile: profileName,
    mode: decision.mode,
  };
}

/**
 * Every track on the board, from the one board read the tick already did — no extra request.
 *
 * Which tasks are roots is `isTrackRoot`'s answer, not a label's: a task with unfinished children
 * that nothing else is still waiting on is a track by default, on the board's track profile.
 * @returns {{candidates, covered, profiles}}
 *   candidates  track roots not running, best first: `{root, track, ok, why, waves, profile, mode}`
 *   covered     Map<node number, running root number> — the nodes a live runner owns. The tick
 *               must not reclaim them, must not claim them, and must not count their slots: a
 *               track is ONE session, so it is ONE running slot however many nodes it holds.
 *   profiles    Map<root number, profile> — the profile each root runs its track on, which for an
 *               inferred root is not the `kb:agent:*` on the card. The tick counts a running
 *               track's slot against *that* profile's cap, the one whose launch it is using.
 */
export function planTracks(tasks, cfg, { board = null } = {}) {
  const all = tasks || [];
  const byNumber = new Map(all.map((t) => [t.number, t]));
  const decided = all.map((t) => [t, isTrackRoot(t, cfg, { board: all })]).filter(([, d]) => d.track);
  const profiles = new Map(decided.map(([t, d]) => [t.number, d.profile]));
  const roots = sortForDispatch(decided.map(([t]) => t));
  const covered = new Map();
  // live tracks first: a node one runner already owns is off the table for every other track
  const pending = [];
  for (const root of roots) {
    const track = resolveTrack(root.number, byNumber);
    if (root.status === 'running') {
      for (const t of track.nodes) if (!covered.has(t.number)) covered.set(t.number, root.number);
    } else pending.push({ root, track });
  }
  const candidates = [];
  for (const { root, track } of pending) {
    const taken = track.nodes.find((t) => covered.has(t.number));
    if (taken) { candidates.push({ root, track, ok: false, why: `#${taken.number} is already running in track #${covered.get(taken.number)}`, waves: [], profile: profiles.get(root.number), mode: 'none' }); continue; }
    candidates.push({ root, track, ...trackReadiness(track, cfg, { board, tasks: all }) });
  }
  return { candidates, covered, profiles };
}

// ---------- the track as a picture ----------

/**
 * Label text for a mermaid node. Mermaid reads entity codes (`#nnn;`, `#quot;`), so every character
 * that would otherwise change the picture is spelled that way:
 *   `#`  a title containing `#123` renders as one stray glyph — silently wrong, not a parse error
 *   `"`  ends the label
 *   `<>` GitHub renders labels as HTML, so `<n>` is swallowed as an unknown tag
 * `#` is escaped FIRST because it is the escape character itself: doing it last would eat the codes
 * the other three just wrote. Titles are clipped, because one long node makes the whole graph wide.
 */
export function mermaidLabel(text, { max = 56 } = {}) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const clipped = s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
  return clipped.replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/</g, '#60;').replace(/>/g, '#62;');
}

/**
 * The track as `{ nodes, edges }` — the same subgraph `resolveTrack` already walked, in dependency
 * order, each node carrying the wave it sits in. A blocker that is not on this board is a node too,
 * with `onBoard: false`: a hole in the graph is exactly the thing a picture is for.
 */
export function trackGraph(track) {
  if (!track?.root) return { root: null, nodes: [], edges: [], cycle: track?.cycle || null };
  const wave = new Map();
  trackWaves(track).forEach((w, i) => w.forEach((t) => wave.set(t.number, i)));
  const nodes = track.order.map((t) => ({
    number: t.number,
    title: t.title,
    status: t.status || null,
    agent: t.agent || null,
    priority: t.kb?.priority ?? null,
    wave: wave.get(t.number) ?? 0,
    root: t.number === track.root.number,
    onBoard: true,
  }));
  for (const n of track.missing) {
    nodes.push({ number: n, title: null, status: null, agent: null, priority: null, wave: null, root: false, onBoard: false });
  }
  const edges = [];
  const seen = new Set();
  for (const t of track.order) {
    for (const b of t.blockedBy || []) {
      if (blockerDone(b)) continue; // done is finished work, not an edge of what is left
      const key = `${Number(b.number)}→${t.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: Number(b.number), to: t.number });
    }
  }
  return { root: track.root.number, nodes, edges, cycle: track.cycle };
}

/**
 * Stroke only — never `fill`, never `color`. GitHub renders mermaid with a dark theme for dark-mode
 * readers and a light one for everyone else; a classDef that pins a fill or a text colour is
 * unreadable in one of the two, so the theme keeps both and we tint the border.
 */
const NODE_CLASS = {
  triage: 'stroke:#8b949e,stroke-width:1px,stroke-dasharray:4',
  todo: 'stroke:#8b949e,stroke-width:1px',
  ready: 'stroke:#3fb950,stroke-width:2px',
  running: 'stroke:#4493f8,stroke-width:2px',
  blocked: 'stroke:#f85149,stroke-width:2px',
  review: 'stroke:#a371f7,stroke-width:2px',
  done: 'stroke:#3fb950,stroke-width:1px',
  archived: 'stroke:#8b949e,stroke-width:1px',
  offboard: 'stroke:#8b949e,stroke-width:1px,stroke-dasharray:4',
};

const nodeClass = (n) => (!n.onBoard ? 'offboard' : NODE_CLASS[n.status] ? n.status : 'todo');

/**
 * The graph as a mermaid `flowchart TD`, fenced and ready to paste into an issue, a comment or a
 * markdown file — GitHub renders it there. Arrows point the way work flows: blocker → what it
 * unblocks, so the frontier is at the top and the root is the last node at the bottom, drawn as a
 * stadium so it is the one you can pick out.
 */
export function trackMermaid(graph, { fence = true } = {}) {
  const L = ['flowchart TD'];
  for (const n of graph.nodes) {
    const head = mermaidLabel(n.onBoard ? `#${n.number} · ${n.status || '?'}` : `#${n.number} · not on this board`);
    const label = `"${head}${n.onBoard ? `<br>${mermaidLabel(n.title)}` : ''}"`;
    L.push(`  n${n.number}${n.root ? `([${label}])` : `[${label}]`}`);
  }
  for (const e of graph.edges) L.push(`  n${e.from} --> n${e.to}`);
  for (const [cls, def] of Object.entries(NODE_CLASS)) {
    const ids = graph.nodes.filter((n) => nodeClass(n) === cls).map((n) => `n${n.number}`);
    if (!ids.length) continue;
    L.push(`  classDef ${cls} ${def}`);
    L.push(`  class ${ids.join(',')} ${cls}`);
  }
  const body = L.join('\n');
  return fence ? `\`\`\`mermaid\n${body}\n\`\`\`` : body;
}

/**
 * Has this root already had a runner? A track attempt that ended without finishing the track means
 * the fast engine had its go; the durable one takes over, so the remaining nodes are dispatched
 * one cold session each. Reading the root's own run record is the whole check — no per-node reads.
 */
export function trackAlreadyAttempted(run) {
  return (run?.attempts || []).some((a) => a.track && a.ended_at);
}

// ---------- the runner's prompt ----------

const pad = (s, n) => String(s ?? '').padEnd(n);

function nodeLine(t) {
  const deps = t.blockedBy?.filter((b) => !blockerDone(b)) || [];
  const waits = deps.length ? ` ⇐ ${deps.map((b) => `#${b.number}`).join(',')}` : '';
  const paths = t.kb?.paths?.length ? ` — paths ${t.kb.paths.join(', ')}` : ' — no paths declared';
  return `  #${pad(t.number, 5)} ${pad(t.status, 6)} ${pad(t.agent || '-', 13)} p${t.kb?.priority ?? 0}  ${t.title}${waits}${paths}`;
}

/**
 * What the runner is told. Pure, and deliberately cheap: it names the graph and the loop, and sends
 * the runner (or each node's subagent) to `hkb context <n>` for that node's real brief — the same
 * `workerContext` a cold worker gets, fetched when the node starts rather than for all N nodes at
 * spawn time. That is also why the fan-out brief hands a subagent a *pointer* rather than a pasted
 * context: the orchestrator's window stays the size of the plan, not the sum of every node's.
 *
 * `fanout` (the profile allows the `Agent` tool — see `trackFanout`) picks the execution model:
 * one isolated subagent per node with siblings running at the same time, or the older one-node-
 * after-another walk. Everything the board sees is identical; only who does the work moves.
 */
export function trackContext({ repo, board, track, attempt, waves = null, fanout = false, trackBranch = null, defaultBranch = 'main' }) {
  const root = track.root;
  const n = root.number;
  const k = attempt;
  const branch = trackBranch || trackBranchName(n);
  const ws = waves && waves.length ? waves : trackWaves(track);
  const nodeWaves = ws.map((w) => w.filter((t) => t.number !== n)).filter((w) => w.length);
  const first = nodeWaves[0]?.[0]?.number ?? n;
  const wave1 = nodeWaves[0] || [];
  const L = [];

  L.push(`You are the TRACK RUNNER for hkb track #${n} (attempt ${k}) in ${repo}, board "${board}".`);
  L.push('');
  L.push('A track is a connected subgraph of the board: this root plus everything it is still blocked by.');
  L.push(`Its integration branch, \`${branch}\`, already exists — created from \`${defaultBranch}\` the moment this`);
  L.push('track was claimed, and recorded on this attempt so a runner that dies never strands work nothing');
  L.push('can find. Every node branches from it, whatever its blockers, and PRs into it; your own pass runs');
  L.push(`on it and opens the track's one PR into \`${defaultBranch}\`. Do not create a branch of your own for it.`);
  if (fanout) {
    L.push(`You are its ORCHESTRATOR. You hold the plan for all ${track.nodes.length + 1} tasks; you do not work the nodes`);
    L.push('yourself. Each node goes to **its own isolated subagent** — the `Agent` tool with `isolation: "worktree"` —');
    L.push('and the nodes of one wave run **at the same time**, because nothing in a wave depends on anything else in');
    L.push('it. You claim, you spawn, you collect, you move to the next wave; the root is the one node you do yourself.');
  } else {
    L.push(`You execute all ${track.nodes.length + 1} tasks in this one session, in dependency order.`);
  }
  L.push('The board is still the source of truth: every node is claimed, worked and finished with its own terminal');
  L.push('verb, so every node is a durable checkpoint. Nothing here replaces the worker protocol — it runs it once');
  L.push('per node. If you die halfway, the ordinary dispatcher picks up whatever is left, one cold session per node.');
  L.push('');
  L.push(`# Track root #${n}: ${root.title}`);
  L.push('');
  L.push(root.bodyText?.trim() || '(no description)');
  L.push('');
  if (root.kb?.goal) L.push(`## Acceptance criteria (the root)\n${root.kb.goal}\n`);

  L.push(`## The graph — ${track.nodes.length} node${track.nodes.length === 1 ? '' : 's'}, then the root`);
  L.push('');
  nodeWaves.forEach((w, i) => {
    L.push(i === 0
      ? `wave 1 — nothing blocks these; they are the frontier${w.length > 1 ? ', and they are independent of each other' : ''}:`
      : `wave ${i + 1} — blocked by wave ${i}:`);
    for (const t of w) L.push(nodeLine(t));
  });
  L.push('then the root:');
  L.push(nodeLine(root));
  L.push('');
  if (fanout) {
    L.push('Work the waves in order, and **a whole wave at a time**: its nodes are independent of each other and of');
    L.push('nothing else that is left, so they run concurrently — one subagent, one worktree each, because two agents');
    L.push('cannot share a checkout. A wave is done when every node in it has recorded a terminal verb.');
    L.push('');

    L.push('## The wave loop — repeat until the nodes are gone');
    L.push('');
    L.push('1. **Claim the wave.** `hkb claim <n>` once per node in it — one command per Bash call. Each claim creates');
    L.push(`   \`refs/kb/locks/<n>/<attempt>\` and moves the node to *running*. If one answers \`held\`, another worker`);
    L.push('   owns that node: drop it, drop everything it blocks, and carry on with the rest of the wave. Ignore the');
    L.push(`   \`export KB_TASK=…\` line a claim prints — this session's KB_TASK is the root, #${n}, and it must stay that way.`);
    L.push('2. **Spawn one subagent per claimed node, all in one message**, so they actually run at the same time:');
    L.push('   the `Agent` tool, `isolation: "worktree"`, and the per-node brief below as the prompt. Sending them one');
    L.push('   message apart is a sequential track wearing a fan-out coat. Cap it at 4 in flight; a wider wave goes in');
    L.push('   batches of 4. If a spawn itself fails — the worktree could not be created, a budget was hit, the tool');
    L.push('   was denied — that node is claimed but has nobody working it: never leave it that way. Work it yourself');
    L.push('   in this checkout, sequentially, or `hkb block <n> "<why>" --kind transient` to release it before you');
    L.push('   move on to the rest of the wave.');
    L.push(`3. **Heartbeat while they work.** \`hkb heartbeat ${n}\` every ~10 minutes. Your turn may end while children`);
    L.push('   are still running — that is normal, and hkb\'s Stop hook stands aside while a subagent of this attempt is');
    L.push('   live, so you will not be nudged for a verb mid-wave. You cannot wake yourself: the next thing you see is a subagent returning — check on the wave then.');
    L.push('4. **Verify each node recorded a verb** — do not take the subagent\'s word for it. `hkb show <n> --json` and');
    L.push('   read `status`: `done`, `blocked` or `review` means the node ended; still `running` means it did not, and');
    L.push('   nothing else in this session will nudge it (the Stop nudge keys on KB_TASK, which is the root, not the');
    L.push('   child). A node the subagent left `running`:');
    L.push('   - work landed and a PR is open → file the verb yourself from its report: `hkb finish <n> --from-stdin < …`');
    L.push('   - it got nowhere → `hkb block <n> "<what it hit>" --kind transient` and treat it as a blocked node');
    L.push('5. **Only then start the next wave.** A wave with a node still `running` is not finished, and a dependent');
    L.push('   that starts on top of an unfinished blocker has no branch to base itself on.');
    L.push('');

    L.push('## The per-node brief — what you put in each `Agent` prompt');
    L.push('');
    L.push(`Substitute \`<n>\`; every node's base is the track branch, \`${branch}\` — the same one whatever the`);
    L.push('node\'s blockers are, because those blockers already merged into it before this node started. Send');
    L.push('the pointer, not the text: `hkb context <n>` is the same brief a cold worker gets, and letting the');
    L.push('child fetch it keeps your own window the size of the plan.');
    L.push('');
    L.push('```');
    L.push(`You are the worker for hkb task #<n>, one node of track #${n} in ${repo}, board "${board}".`);
    L.push('Work ONLY #<n>. It is already claimed for you — do not run `hkb claim`.');
    L.push('');
    L.push('1. Run `hkb context <n>` first. That is your brief: the body, the `kb` settings, the parent');
    L.push('   results, the prior attempts. Read it before you touch anything — but its current-branch line');
    L.push('   does not apply to you: this checkout is a throwaway `agent-<id>` one, not the node\'s; use');
    L.push(`   \`kb/<n>\`, based on \`${branch}\` (the track branch — see step 2), the next step.`);
    L.push(`2. \`git fetch origin ${branch} && git switch -c kb/<n> origin/${branch}\` and stay inside the node's`);
    L.push('   `kb.paths`. Everything outside them belongs to somebody else\'s worktree, including your siblings');
    L.push('   running right now.');
    L.push(`3. Run \`hkb heartbeat ${n}\` — the root, not #<n> — every ~10 minutes while you work. The orchestrator's`);
    L.push('   own turn ends the moment it spawns you and it cannot wake itself, so this beat from inside you is what');
    L.push('   keeps the whole track from being reclaimed as stale while you are still running.');
    L.push('4. Commit AND push before you return. This worktree is only removed automatically when you leave it');
    L.push('   unchanged — once you commit, it can stick around until a later `hkb gc`; anything you did not push');
    L.push('   is not safe just because the worktree survives.');
    L.push(`5. Open a **draft** PR based on \`${branch}\` whose body contains exactly one \`Closes #<n>\`:`);
    L.push(`   \`gh pr create --draft --base ${branch} --title "…" --body "Closes #<n>\\n\\n<what/why/how verified>"\``);
    L.push('   GitHub only auto-links `Closes #` for a PR into the default branch, so this one will not close the');
    L.push('   issue itself — `hkb finish` still finds it through the head-branch fallback (`kb/<n>` matches whatever');
    L.push('   its base is), and it is the *track branch\'s* own PR into the default branch that actually lands it.');
    L.push('6. Finish with EXACTLY ONE terminal verb, on #<n> and no other number:');
    L.push('   write /tmp/kb-<n>.json with your editor tool, then');
    L.push('   `hkb finish <n> --from-stdin < /tmp/kb-<n>.json`');
    L.push('   {"summary": "<what changed, for the next node>", "metadata": {"changed_files": [...],');
    L.push('    "verification": ["<commands you ran>"], "residual_risk": [...]}}');
    L.push('   - `hkb block <n> "why" --kind needs_input|dependency|capability|transient` if you cannot proceed');
    L.push('   - `hkb request-review <n> --summary "…"` if a reviewer must look first');
    L.push('7. `KB_TASK` in your environment names the track root, not you. Ignore it.');
    L.push('8. One command per Bash call: no `;`, no `&&`, no `$VAR` (`printenv NAME` reads the environment).');
    L.push('   The worktree guard refuses a compound command outright, and a refusal costs you a turn.');
    L.push('9. Do not spawn subagents of your own, and never `git push --force`.');
    L.push('');
    L.push('Report back: the node number, the verb you ran, the PR url, and one line on what you landed.');
    L.push('```');
    L.push('');
  } else {
    L.push('Work the waves in order. Inside one wave the nodes are independent: run them one after another, or');
    L.push('fan them out to subagents if your harness has them — one worktree each, because two agents cannot');
    L.push('share a checkout. The board reads the same either way, so sequence is always a safe answer.');
    L.push('');

    L.push('## The loop — once per node, in the order above');
    L.push('');
    L.push(`1. \`hkb context <n>\` — the exact brief that node's own worker would get: body, \`kb\` settings, parent`);
    L.push('   results, prior attempts. Read it before you touch anything; it is where the decisions live.');
    L.push(`2. \`hkb claim <n>\` — creates \`refs/kb/locks/<n>/<attempt>\` and moves the node to *running*. If it`);
    L.push('   answers `held`, another worker owns that node: leave it alone, skip everything blocked by it, and');
    L.push(`   carry on with the rest. Ignore the \`export KB_TASK=…\` line it prints — this session's KB_TASK is`);
    L.push(`   the root, #${n}, and it must stay that way.`);
    L.push(`3. Do the work on a branch of its own: \`git fetch origin ${branch} && git switch -c kb/<n> origin/${branch}\`.`);
    L.push(`   Every node's base is the track branch, \`${branch}\` — the same one whatever the node's blockers are,`);
    L.push('   because those blockers already merged into it before this node started.');
    L.push(`4. Push and open a **draft** PR whose body contains \`Closes #<n>\`, based on \`${branch}\`:`);
    L.push(`   \`gh pr create --draft --base ${branch} --title "…" --body "Closes #<n>\\n\\n<what/why/how verified>"\`.`);
    L.push('   One PR per node, and exactly one `Closes #` in it. GitHub only auto-links `Closes #` for a PR into');
    L.push('   the default branch, so this one will not close the issue by merging — `hkb finish` still finds it');
    L.push('   through the head-branch fallback (`kb/<n>` matches whatever its base is); it is the track branch\'s');
    L.push('   own PR into the default branch, at the end, that actually lands the work. A PR that closed several');
    L.push('   nodes would drag the unfinished ones into *review* behind it, and the dispatcher could never finish');
    L.push('   them for you — so still exactly one `Closes #` each.');
    L.push('5. Finish the node with EXACTLY ONE terminal verb — the same three any worker has:');
    L.push('```bash');
    L.push('# write /tmp/kb-<n>.json with your editor tool:');
    L.push('# {"summary": "<what changed, for the next node and the next worker>",');
    L.push('#  "metadata": {"changed_files": ["..."], "verification": ["<commands you ran>"], "residual_risk": ["..."]}}');
    L.push('hkb finish <n> --from-stdin < /tmp/kb-<n>.json');
    L.push('```');
    L.push('   `finish` is `complete` under a name no shell claims — say `finish`, and redirect a file rather than');
    L.push('   using a heredoc, so a harness that vets your command line word by word still runs it.');
    L.push('   - `hkb block <n> "why" --kind needs_input|dependency|capability|transient` when that node cannot proceed');
    L.push('   - `hkb request-review <n> --summary "..."` when a reviewer must look before it counts as done');
    L.push('6. Only then start the next node. Its `hkb context` will show the result you just wrote.');
    L.push('');
  }

  L.push('## Rules that are different because you are a track');
  L.push('');
  L.push(`- **Heartbeat the root, not the nodes.** \`hkb heartbeat ${n}\` every ~10 minutes of long work. That one`);
  L.push('  lease covers the whole track: the dispatcher will not reclaim a node while this attempt is alive.');
  L.push(`  If it prints \`LOCK_LOST\`, stop **everything** at once — do not commit, do not push, do not call a`);
  L.push('  terminal verb on any node. The track was reclaimed and the board now belongs to someone else.');
  if (fanout) {
    L.push('- **Claim a wave at a time, never the whole graph.** A lock you hold and are not working is a node nobody');
    L.push('  else can run. Claim the wave you are about to spawn, and let it end before you claim the next.');
  } else {
    L.push('- **Claim as you go, never up front.** A lock you hold and do not work is a node nobody else can run.');
    L.push('  Claim a node when you are about to start it, and end it before you claim the next.');
  }
  L.push('- **A node that blocks parks only its branch.** `hkb block <n> …`, then skip every node that is blocked');
  L.push('  by it, transitively, and keep going with the rest of the graph. Do not abandon the track for one');
  L.push('  bad node; finish what you can and say in the root\'s summary what you left and why.');
  if (fanout) {
    L.push('  A wave is not all-or-nothing either: one subagent blocking parks its dependents, and its siblings still');
    L.push('  finish and still count.');
    L.push('- **`kb.paths` are what make a wave safe.** They are disjoint by construction (`/kanban:decompose` enforces');
    L.push('  it), which is why these nodes can run at once at all. Each subagent stays inside its own; you stay out of');
    L.push('  all of them until the root\'s own pass.');
    L.push('- **One PR per node, and exactly one `Closes #` in it.** That is what makes a node a checkpoint: its issue');
    L.push('  closes when *its* PR merges. Do not let a wave collapse into one PR — it would drag the unfinished nodes');
    L.push('  into *review* behind it, where neither you nor the dispatcher could finish them.');
    L.push('- **You are the only spawner.** Subagents do not spawn subagents, and nothing about a track puts a second');
    L.push('  dispatcher on the board: `hkb dispatch` is what started you, and running it again double-claims work.');
  } else {
    L.push('- **Stay inside each node\'s `kb.paths`** while you are on that node. They are what let the dispatcher');
    L.push('  run other work beside you; a node that wanders outside them corrupts somebody else\'s worktree.');
  }
  L.push('- **One command per Bash call.** No `;`, no `&&`, no `$VAR` — the worktree guard refuses a command it');
  L.push('  cannot verify stays inside the checkout, and a refusal is final. `printenv NAME` reads the environment.');
  L.push('- **Never `git push --force`.** Never push a lock ref yourself.');
  L.push('');

  L.push('## Finishing the track');
  L.push('');
  L.push(`When every node has ended, switch to the track branch itself: \`git fetch origin ${branch} && git switch`);
  L.push(`${branch}\`. It already holds every node's merged work — do the root's own pass there, the one no child`);
  L.push('could: check that the pieces actually fit together, run the project\'s lint and tests over the whole');
  L.push('result, and write the docs or changelog that only make sense once.');
  if (fanout) {
    L.push('That pass is yours: you do it here, in this checkout, on top of the nodes\' merged work, and you are the');
    L.push('only one who has read every subagent\'s report.');
  }
  L.push(`Then open the track's one PR into \`${defaultBranch}\`: \`gh pr create --draft --base ${defaultBranch} --head`);
  L.push(`${branch} --title "…" --body "Closes #${n}\\n\\n<what the track landed>"\`. This is the PR GitHub *does*`);
  L.push(`auto-link, so \`Closes #${n}\` closes the root the ordinary way once it merges. Finish #${n} itself with`);
  L.push('exactly one terminal verb, the same way as any node, and stop. Its summary is the track\'s: what each');
  L.push('node landed, what merged, what is still open.');
  L.push('');
  L.push(`The track branch is not yours to delete. It is cleaned up once the root's own PR merges or the root is`);
  L.push('archived or closed as not planned — `hkb gc` sweeps it the same way it sweeps a finished attempt\'s');
  L.push('worktree, and `hkb doctor` flags one still standing with no live runner.');
  L.push('');
  if (fanout && wave1.length) {
    const spawnIt = wave1.length === 1 ? 'its subagent' : `${wave1.length === 2 ? 'both' : `all ${wave1.length}`} subagents in one message`;
    L.push(`Start with wave 1: claim ${wave1.map((t) => `#${t.number}`).join(', ')}, then spawn ${spawnIt}.`);
  } else {
    L.push(`Start with \`hkb context ${first}\`.`);
  }
  return L.join('\n');
}
