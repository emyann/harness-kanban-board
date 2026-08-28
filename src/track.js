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
import { blockerDone, sortForDispatch } from './model.js';

/** Statuses a track may start from — for the root and for every node. */
export const TRACK_STARTABLE = ['todo', 'ready'];

/** Does this profile execute whole tracks? `"track": true` on the profile in `.kanban/board.json`. */
export function isTrackProfile(cfg, name) {
  return !!(name && cfg?.profiles?.[name]?.track);
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
 * @returns {{ok, why, waves}} `why` is the reason either way, for the log and for `--json`.
 */
export function trackReadiness(track, cfg, { board = null } = {}) {
  const no = (why) => ({ ok: false, why, waves: [] });
  const root = track.root;
  if (!root) return no('no such task on the board');
  if (!isTrackProfile(cfg, root.agent)) return no(`profile ${root.agent || 'none'} does not run tracks`);
  if (track.cycle) return no(`the subgraph has a cycle: ${track.cycle.map((n) => `#${n}`).join(' → ')}`);
  if (!TRACK_STARTABLE.includes(root.status)) return no(`the root is ${root.status}`);
  if (root.needsHuman) return no(`#${root.number} needs a human`);
  if ((root.prs || []).some((p) => p.state === 'OPEN')) return no(`#${root.number} already has an open PR`);
  if (!track.nodes.length) return no('nothing is blocking it any more — dispatch it as a single node');
  if (track.missing.length) return no(`${track.missing.map((n) => `#${n}`).join(', ')} block the track but are not on board "${board ?? '?'}"`);
  const allowed = trackAgents(cfg, root.agent);
  for (const t of track.nodes) {
    if (!TRACK_STARTABLE.includes(t.status)) return no(`#${t.number} is ${t.status}`);
    if (t.needsHuman) return no(`#${t.number} needs a human`);
    if ((t.prs || []).some((p) => p.state === 'OPEN')) return no(`#${t.number} already has an open PR`);
    // cross-harness tracks are out of scope on purpose: one session is one harness
    if (t.agent && !allowed.has(t.agent)) return no(`#${t.number} runs on ${t.agent}, which a ${root.agent} runner cannot execute`);
  }
  const now = new Date();
  const later = track.order.find((t) => t.kb?.scheduled_at && new Date(t.kb.scheduled_at) > now);
  if (later) return no(`#${later.number} is scheduled for ${later.kb.scheduled_at}`);
  return { ok: true, why: `${track.nodes.length} node${track.nodes.length === 1 ? '' : 's'} then the root`, waves: trackWaves(track) };
}

/**
 * Every track on the board, from the one board read the tick already did — no extra request.
 * @returns {{candidates, covered}}
 *   candidates  track roots not running, best first: `{root, track, ok, why, waves}`
 *   covered     Map<node number, running root number> — the nodes a live runner owns. The tick
 *               must not reclaim them, must not claim them, and must not count their slots: a
 *               track is ONE session, so it is ONE running slot however many nodes it holds.
 */
export function planTracks(tasks, cfg, { board = null } = {}) {
  const byNumber = new Map((tasks || []).map((t) => [t.number, t]));
  const roots = sortForDispatch((tasks || []).filter((t) => isTrackProfile(cfg, t.agent)));
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
    if (taken) { candidates.push({ root, track, ok: false, why: `#${taken.number} is already running in track #${covered.get(taken.number)}`, waves: [] }); continue; }
    candidates.push({ root, track, ...trackReadiness(track, cfg, { board }) });
  }
  return { candidates, covered };
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
 * the runner to `hkb context <n>` for each node's real brief — the same `workerContext` a cold
 * worker gets, fetched when the node starts rather than for all N nodes at spawn time.
 */
export function trackContext({ repo, board, track, attempt, waves = null }) {
  const root = track.root;
  const n = root.number;
  const k = attempt;
  const ws = waves && waves.length ? waves : trackWaves(track);
  const nodeWaves = ws.map((w) => w.filter((t) => t.number !== n)).filter((w) => w.length);
  const first = nodeWaves[0]?.[0]?.number ?? n;
  const L = [];

  L.push(`You are the TRACK RUNNER for hkb track #${n} (attempt ${k}) in ${repo}, board "${board}".`);
  L.push('');
  L.push('A track is a connected subgraph of the board: this root plus everything it is still blocked by.');
  L.push(`You execute all ${track.nodes.length + 1} tasks in this one session, in dependency order. The board is still`);
  L.push('the source of truth: every node is claimed, worked and finished with its own terminal verb, so every');
  L.push('node is a durable checkpoint. Nothing here replaces the worker protocol — it runs it once per node.');
  L.push('If you die halfway, the ordinary dispatcher picks up whatever is left, one cold session per node.');
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
  L.push('3. Do the work on a branch of its own: `git switch -c kb/<n> <base>`, where `<base>` is the branch of');
  L.push('   the node this one is blocked by, or the default branch when it has none.');
  L.push('4. Push and open a **draft** PR whose body contains `Closes #<n>`, based on that same `<base>`:');
  L.push('   `gh pr create --draft --base <base> --title "…" --body "Closes #<n>\\n\\n<what/why/how verified>"`.');
  L.push('   One PR per node, and exactly one `Closes #` in it. That is what makes a node a checkpoint: its');
  L.push('   issue closes when *its* PR merges. A PR that closed several nodes would drag the unfinished ones');
  L.push('   into *review* behind it, and the dispatcher could never finish them for you.');
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

  L.push('## Rules that are different because you are a track');
  L.push('');
  L.push(`- **Heartbeat the root, not the nodes.** \`hkb heartbeat ${n}\` every ~10 minutes of long work. That one`);
  L.push('  lease covers the whole track: the dispatcher will not reclaim a node while this attempt is alive.');
  L.push(`  If it prints \`LOCK_LOST\`, stop **everything** at once — do not commit, do not push, do not call a`);
  L.push('  terminal verb on any node. The track was reclaimed and the board now belongs to someone else.');
  L.push('- **Claim as you go, never up front.** A lock you hold and do not work is a node nobody else can run.');
  L.push('  Claim a node when you are about to start it, and end it before you claim the next.');
  L.push('- **A node that blocks parks only its branch.** `hkb block <n> …`, then skip every node that is blocked');
  L.push('  by it, transitively, and keep going with the rest of the graph. Do not abandon the track for one');
  L.push('  bad node; finish what you can and say in the root\'s summary what you left and why.');
  L.push('- **Stay inside each node\'s `kb.paths`** while you are on that node. They are what let the dispatcher');
  L.push('  run other work beside you; a node that wanders outside them corrupts somebody else\'s worktree.');
  L.push('- **Never `git push --force`.** Never push a lock ref yourself.');
  L.push('');

  L.push('## Finishing the track');
  L.push('');
  L.push(`When every node has ended, do the root's own pass — the one no child could: check that the pieces`);
  L.push('actually fit together, run the project\'s lint and tests over the whole result, and write the docs or');
  L.push(`changelog that only make sense once. Then finish #${n} itself with exactly one terminal verb, the same`);
  L.push('way, and stop. Its summary is the track\'s: what each node landed, what merged, what is still open.');
  L.push('');
  L.push(`Start with \`hkb context ${first}\`.`);
  return L.join('\n');
}
