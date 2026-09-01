// Argument parsing + command routing. Every command has --json; output is stable for scripts and agents.
import fs from 'node:fs';
import { makeContext, makeHookContext } from './board.js';
import { getTask, fetchBoard, assertOnBoard, loadRun, latestResult, parentResults, issueEvents, addComment, addLabels, ensureLabels, removeLabel, setAgent, setStatus, updateBody, blockersOf, blockersKnown } from './tasks.js';
import { heartbeat, complete, block, unblock, requestReview, requestChanges, promote, archive, createTask, linkTask, withOutbox, envAttempt, mergeCard } from './lifecycle.js';
import { tick, loop, spawnWorker } from './dispatch.js';
import { serve } from './serve.js';
import { up, down } from './up.js';
import { watch, tail } from './watch.js';
import { stats } from './stats.js';
import { claim } from './lock.js';
import { contextCommand } from './context.js';
import { resolveTrack, trackGraph, trackMermaid } from './track.js';
import { stopHook, markSessionClaim } from './hook.js';
import { init, packageVersion } from './init.js';
import { doctor } from './doctor.js';
import { gc } from './gc.js';
import { STATUSES, DEFAULT_KB, L, blockerDone, parseBodyBlock, lastAttempt, formatSession, formatDenials, resumeCommand, activePrGuard, isTrackRoot, groomBoard, computeReady, pathOverlapGuard, GROOM_LEVELS } from './model.js';

/** Flags that never take a value, so `hkb complete --from-stdin 13` keeps `13` as a positional. */
const BOOL_FLAGS = new Set(['json', 'from-stdin', 'dry-run', 'triage', 'all', 'spawn', 'yes', 'import', 'no-hook', 'shared-hooks', 'no-labels', 'api', 'mcp', 'with-actions', 'mermaid', 'serve', 'off', 'on', 'help']);

export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !BOOL_FLAGS.has(key)) { flags[key] = next; i++; } else flags[key] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

// ---------- terminal verb inputs (complete | block | request-review) ----------
// The protocol must not depend on shell quoting of JSON: every field can come inline, from a file, or from one JSON
// object on stdin. Per field the precedence is inline > --*-file > --from-stdin. No GitHub calls happen here.

const STDIN_KEYS = ['summary', 'metadata', 'artifacts', 'reason', 'kind', 'reviewer'];
const TERMINAL_VERBS = ['complete', 'block', 'request-review'];

/**
 * `finish` is `complete` under a name no shell claims — the same verb, spelled so a worker can run it.
 *
 * `complete` is a bash builtin (`complete -C <cmd>` runs a string through a shell), so a harness that
 * vets a worker's command line word by word sees the builtin, not hkb's verb. Claude Code does: in a
 * worktree-isolated session — which is every `claude --bg` worker, the default profile — `hkb complete
 * <n>` is refused with "this command runs a string through complete, which can't be verified to stay
 * inside the worktree", whatever the arguments and however the word is quoted. `block` and
 * `request-review` are not builtins and run fine, so the one verb a *successful* worker needs was the
 * only one it could not type, and the attempt died as a protocol_violation instead (#125).
 *
 * Resolved before routing, so nothing downstream learns a second name: the run record, the outbox
 * replay (`terminalArgv`) and the board all still say `complete`.
 */
export const VERB_ALIASES = { finish: 'complete' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);
const list = (v, label) => {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((s) => typeof s === 'string')) return v;
  throw usage(`${label} must be a list of strings (or a comma-separated string)`);
};

function parseObject(text, label) {
  let v;
  try { v = JSON.parse(text); } catch (e) { throw usage(`${label} must be a JSON object: ${e.message}`); }
  if (!isPlainObject(v)) throw usage(`${label} must be a JSON object, got ${Array.isArray(v) ? 'an array' : typeof v}`);
  return v;
}

function readStdinSync() {
  // A heredoc is the nicest form and the first thing to suggest, but not every harness will run one —
  // Claude Code refuses `<<'EOF'` outright in a worktree-isolated session — so name the redirect too.
  if (process.stdin.isTTY) throw usage(`--from-stdin: stdin is a terminal — redirect a JSON file (hkb finish <n> --from-stdin < payload.json), pipe one, or use a heredoc: hkb finish <n> --from-stdin <<'EOF' ... EOF`);
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { throw usage(`--from-stdin: could not read stdin (${e.code || e.message}) — pipe a JSON object, or use --summary-file/--metadata-file`); }
}

/**
 * Pure resolution of a terminal verb's payload from parsed args. `io.readFile(path)` and `io.readStdin()` are
 * injectable so tests use a temp dir and a string instead of a real stdin.
 * Returns { summary, metadata, artifacts, reason, kind, reviewer } — validation of *required* fields stays in lifecycle.js.
 */
export function resolveTerminalInput(verb, flags, rest, io = {}) {
  if (!TERMINAL_VERBS.includes(verb)) throw usage(`resolveTerminalInput: not a terminal verb: ${verb}`);
  const readFile = io.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const readStdin = io.readStdin || readStdinSync;
  const readOrExplain = (flag, p) => {
    try { return readFile(p); } catch (e) {
      throw usage(`--${flag}: cannot read ${p} (${e.code || e.message}) — write the file first, or pass the value inline / with --from-stdin`);
    }
  };

  let stdin = {};
  if (flags['from-stdin']) {
    const text = readStdin();
    if (!text || !text.trim()) throw usage(`--from-stdin: nothing on stdin — pipe a JSON object, e.g. printf '%s' '{"summary":"..."}' | hkb ${verb} <n> --from-stdin`);
    stdin = parseObject(text, '--from-stdin');
    const unknown = Object.keys(stdin).filter((k) => !STDIN_KEYS.includes(k));
    if (unknown.length) throw usage(`--from-stdin: unknown key(s) ${unknown.join(', ')} — allowed: ${STDIN_KEYS.join(', ')}`);
  }

  // summary: --summary > --summary-file > stdin.summary
  let summary = str(flags.summary);
  if (summary === null && flags['summary-file']) summary = readOrExplain('summary-file', String(flags['summary-file'])).trim();
  if (summary === null && stdin.summary !== undefined) {
    if (typeof stdin.summary !== 'string') throw usage('--from-stdin: "summary" must be a string');
    summary = stdin.summary;
  }

  // metadata: --metadata (inline JSON, or a path when it does not start with "{") > --metadata-file > stdin.metadata
  let metadata = {};
  const inline = str(flags.metadata);
  if (inline !== null) {
    metadata = /^[{[]/.test(inline.trimStart())
      ? parseObject(inline, '--metadata')
      : parseObject(readOrExplain('metadata', inline), `--metadata (file ${inline})`);
  } else if (flags['metadata-file']) {
    const p = String(flags['metadata-file']);
    metadata = parseObject(readOrExplain('metadata-file', p), `--metadata-file (${p})`);
  } else if (stdin.metadata !== undefined) {
    if (!isPlainObject(stdin.metadata)) throw usage('--from-stdin: "metadata" must be a JSON object');
    metadata = stdin.metadata;
  }

  // artifacts: --artifacts a,b > stdin.artifacts
  const artifacts = flags.artifacts !== undefined ? list(str(flags.artifacts), '--artifacts') : list(stdin.artifacts, '--from-stdin "artifacts"');

  // reason (block): positional > --reason-file > stdin.reason
  let reason = rest.slice(1).join(' ') || null;
  if (reason === null && flags['reason-file']) reason = readOrExplain('reason-file', String(flags['reason-file'])).trim();
  if (reason === null && stdin.reason !== undefined) {
    if (typeof stdin.reason !== 'string') throw usage('--from-stdin: "reason" must be a string');
    reason = stdin.reason;
  }

  const kind = str(flags.kind) ?? str(stdin.kind) ?? null;
  const reviewer = str(flags.reviewer) ?? str(stdin.reviewer) ?? null;
  return { summary, metadata, artifacts, reason, kind, reviewer };
}

/**
 * The inline-flag form of a resolved payload. Used for the offline outbox: replay re-spawns `hkb <argv>` without a
 * stdin or the worker's temp files, so the queued command must be self-contained. No shell is involved, so no quoting.
 */
export function terminalArgv(verb, number, p, { board, attempt } = {}) {
  const argv = [verb, String(number)];
  if (verb === 'block') {
    if (p.reason) argv.push(p.reason);
    if (p.kind) argv.push('--kind', p.kind);
  } else {
    if (p.summary) argv.push('--summary', p.summary);
    if (p.metadata && Object.keys(p.metadata).length) argv.push('--metadata', JSON.stringify(p.metadata));
    if (p.artifacts?.length) argv.push('--artifacts', p.artifacts.join(','));
    if (verb === 'request-review' && p.reviewer) argv.push('--reviewer', p.reviewer);
  }
  if (board) argv.push('--board', board);
  if (attempt) argv.push('--attempt', String(attempt));
  return argv;
}

const HELP = `hkb — a portable, frugal kanban for coding agents on GitHub Issues

  setup       init [--board slug] [--profiles a,b] [--harness copilot|codex] [--with-actions] [--mcp] [--import]
                   [--no-hook] [--shared-hooks] [--no-labels] [--project <number|new>]
                   --no-labels + --repo owner/name writes every local file and sends nothing (no gh, no network)
                   the Stop/PreToolUse hooks ride the worker launch (claude --settings), so no settings file is
                   written; --shared-hooks puts them in the tracked .claude/settings.json for every session too
              doctor [--api] [--json]
  tasks       create "title" [--body ..] [--blocked-by 12,13] [--agent claude] [--priority N] [--paths a/,b/]
                     [--model m] [--skills s1,s2] [--max-retries N] [--max-runtime S] [--scheduled-at ISO] [--triage] [--goal ".."]
                     --priority is a number and higher wins (0 unfiled/default, 1 normal, 2 next up, 3 urgent)
                     --triage files it unstarted, else it lands ready
                     --skills grants the Skill tool on hkb's default profiles (Skill is in CLAUDE_TOOLS);
                     a custom profile needs "Skill" in its own allowed_tools too, or hkb doctor flags it
              list [--status s] [--agent p] [--all] [--json]      show <n> [--json]      context <n>
                    a triage card whose blockers are all done is flagged ⇡ unblocked
              groom [--status triage,todo,ready] [--all] [--pairs N] [--level act|ask|info]
                    [--bodies flagged|all|none] [--json]   the lane as a proposal table — unblocked,
                    thin spec, overlap, mentions — from one board read. A read like dispatch --dry-run:
                    it writes nothing. Only a card needing judgment carries its bodyText
              graph <n> [--mermaid] [--json]   the track rooted at <n> — the root plus everything still
                    blocking it — as a fenced mermaid block GitHub renders in issues, comments and files:
                    hkb comment 12 "$(hkb graph 12)"      --json adds { nodes, edges, mermaid }
              track <n> [--off|--on] [--json]   whether #n runs as ONE orchestrated session and why.
                    A card with unfinished children is a track by default; --off (kb:no-track) runs
                    them as cold nodes instead, --on undoes it, --agent <a track profile> forces one
              edit <n>... [--paths a,b] [--goal ".."] [--scheduled-at ISO] [--priority N]
                    sets exactly the kb keys named — every other key is left as read; the write half of
                    what hkb groom's unblocked/no_paths/malformed_kb/broad_path/priority_inversion suggest
              link <parent> <child>   unlink <parent> <child>      promote <n>...      archive <n>...
              adopt <n>... [--agent p]     comment <n> "text"      log <n> [--json]    status <n>
  worker      heartbeat <n> [--note ..]     finish <n> --summary ".." [--metadata JSON|path.json] [--artifacts a,b]
              block <n> "reason" [--kind dependency|needs_input|capability|transient]     unblock <n>...
              request-review <n> --summary ".." [--metadata ..] [--reviewer <github-user>]   request-changes <n> "reason"
              finish|block|request-review also take --summary-file <p> --metadata-file <p> --reason-file <p>, or
              --from-stdin with one JSON object {summary, metadata, artifacts, reason, kind, reviewer} (no shell quoting)
              finish is complete — the same verb under a name no shell claims: complete is a bash builtin,
              so a harness that vets a command word by word (Claude Code in a worktree) refuses to run it
  operator    merge <n> [--summary ".."]   merges #n's PR under dispatch.merge.mode "operator" once a
                    review is on the card (a named reviewer, or --summary naming what was checked);
                    refuses naming the condition otherwise, and refuses outright under "manual"/"auto"
  dispatch    up [--serve] [--loop S] [--port N]   start the dispatcher loop — and with --serve the board
                    server — detached, idempotently, logging to .kanban/logs/<dispatch|serve>.log.
                    Already running is reported, never started twice; up is not a supervisor and
                    never restarts (exit 4 is the loop asking one to)
              up --status [--json]     one line per process: running pid, since when, which log
              down [--serve]           SIGTERM what the pid files name, then wait for them to be gone
                    before saying stopped; workers are left alone. --json adds failed[] and the exit
                    code is non-zero for a signal that failed or a process that outlived the wait
              dispatch [--loop S] [--max N] [--profiles a,b] [--dry-run]     claim <n> [--profile p] [--spawn]
              gc [--yes]
  board       serve [--port 4666] [--host 127.0.0.1] [--poll 30]   local web board; drag-drop runs the same verbs
                    [--repos ../other,../third#release]   several checkouts on one page, one server, one port;
                    without the flag, the boards in ~/.config/hkb/boards.json join this one — hkb init keeps that
                    list, and a running server re-reads it, so a checkout you just set up needs no restart
              stats [--since 7d|all] [--json]   attempts per outcome, duration, spawns vs the daily cap, spend per profile
  live        watch [--interval 30] [--kinds completed,blocked,..] [--polls N] [--json]   one line per transition
              tail <n> [--interval 30] [--kinds ..] [--polls N] [--json]   follow one task's attempts and comments
              both poll with If-None-Match: an unchanged board answers 304 and costs no rate limit
  mcp         mcp   the same verbs as MCP tools (kanban_show, kanban_complete, ...) on stdio;
                    hkb init --mcp writes .mcp.json and prints the Codex and VS Code equivalents
  plumbing    hook stop|pretool|subagentstop      version

  Global: --board <slug> (or KB_BOARD), --json.
  Exit codes: 0 ok · 1 error · 2 usage/state · 3 LOCK_LOST (stop now) · 4 the dispatcher loop gave itself up
              (a supervisor — cron, systemd, Actions — or hkb up starts a fresh one).
`;

// Single source of truth for the version: package.json, resolved relative to the package, not the
// cwd. It lives in init.js, next to the package root every other package read goes through.
export { packageVersion as readVersion };

const out = (ctx, obj, text) => { process.stdout.write((ctx.json ? JSON.stringify(obj, null, 2) : text ?? JSON.stringify(obj, null, 2)) + '\n'); };
const nums = (pos) => pos.map((p) => Number(String(p).replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n > 0);
const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };

/**
 * One line per outcome `promote` produced, cards sharing an outcome grouped together — a cascade that
 * moves several cards must never read like it moved one (#209). Moved cards get an arrow; skipped and
 * unchanged cards get their reason instead, so a human can see at a glance what a drag actually did.
 */
export function formatPromote(res) {
  const groups = [];
  const byLabel = new Map();
  for (const r of res) {
    const label = r.unchanged ? (r.reason || `already ${r.status}`) : `→ ${r.status}${r.forced ? ' (forced: blockers not done)' : ''}`;
    let g = byLabel.get(label);
    if (!g) { g = { label, numbers: [] }; byLabel.set(label, g); groups.push(g); }
    g.numbers.push(r.number);
  }
  return groups.map((g) => `${g.numbers.map((n) => `#${n}`).join(' ')} ${g.label}`).join(' · ');
}
const log = (s) => process.stderr.write(s + '\n');

// ---------- groom: a read, like `hkb dispatch --dry-run` ----------

/** Which lanes get a row when `--status` is not given. */
const GROOM_STATUSES = ['triage', 'todo', 'ready'];
/** What `--bodies` accepts. `flagged` is the default and the whole token argument. */
const GROOM_BODIES = ['flagged', 'all', 'none'];

/**
 * `hkb groom`'s flags, validated before a single request goes out. Pure, so the error text is a
 * unit test rather than a network round trip. Unknown `--level`/`--bodies` values exit 2 naming the
 * list they had to choose from, per the error rule in CLAUDE.md.
 */
export function groomOptions(flags = {}) {
  const statuses = flags.status === undefined ? [...GROOM_STATUSES] : list(str(flags.status), '--status');
  if (!statuses.length) throw usage(`--status: name at least one lane, comma-separated. Known: ${STATUSES.join(', ')}`);
  for (const s of statuses) if (!STATUSES.includes(s)) throw usage(`--status: unknown lane "${s}" — one of ${STATUSES.join(', ')}`);

  const level = flags.level === undefined ? null : str(flags.level);
  if (flags.level !== undefined && (level === null || !GROOM_LEVELS.includes(level))) {
    throw usage(`--level: unknown level ${JSON.stringify(level ?? flags.level)} — one of ${GROOM_LEVELS.join(', ')}`);
  }

  const bodies = flags.bodies === undefined ? 'flagged' : str(flags.bodies);
  if (flags.bodies !== undefined && (bodies === null || !GROOM_BODIES.includes(bodies))) {
    throw usage(`--bodies: unknown value ${JSON.stringify(bodies ?? flags.bodies)} — one of ${GROOM_BODIES.join(', ')}`);
  }

  let pairs = 10;
  if (flags.pairs !== undefined) {
    pairs = Number(flags.pairs);
    if (!Number.isInteger(pairs) || pairs < 0) throw usage(`--pairs: a whole number of pairs to list, not ${JSON.stringify(flags.pairs)}`);
  }
  return { statuses, level, bodies, pairs, all: !!flags.all };
}

/**
 * `--level` is a view over the rows, not a second report: `summary` and `pairs` stay the whole
 * lane's truth (that is what the counts are for), and only `cards` — with `judgment.cards`, which is
 * derived from them — narrows to the rows carrying a finding at that level.
 */
export function filterGroomLevel(rep, level) {
  if (!level) return rep;
  const cards = rep.cards.filter((c) => c.findings.some((f) => f.level === level));
  const kept = new Set(cards.map((c) => c.number));
  return { ...rep, cards, judgment: { ...rep.judgment, cards: rep.judgment.cards.filter((n) => kept.has(n)) } };
}

/**
 * The human report: a header a person can scan, one `taskLine` row per card ending in its proposal
 * with the evidence under it, the pair block, and a footer counting what is waiting.
 * `byNumber` is the board read the report came from — the rows are rendered from the real tasks so
 * `hkb groom` and `hkb list` print the same card the same way.
 */
export function formatGroom(rep, byNumber = new Map()) {
  const s = rep.summary;
  const open = Object.entries(s.by_status).reduce((n, [, v]) => n + v, 0);
  const lanes = Object.keys(s.by_status).sort().map((k) => `${s.by_status[k]} ${k}`).join(' · ');
  const hubs = s.hubs.length ? s.hubs.map((h) => `${h.path} (${h.cards})`).join(', ') : '(none)';
  const lines = [`${open} card${open === 1 ? '' : 's'} · ${lanes} · hubs: ${hubs}`, ''];

  if (!rep.cards.length) lines.push('(no card matches)');
  for (const c of rep.cards) {
    const t = byNumber.get(c.number);
    const row = t ? taskLine(t, { known: true }) : `#${String(c.number).padEnd(5)} ${(c.status || '?').padEnd(8)} ${(c.agent || '-').padEnd(10)} p${c.priority}  ${c.title}`;
    lines.push(`${row}  ⇒ ${c.proposal}`);
    for (const f of c.findings) lines.push(`      ${f.kind} (${f.level}): ${f.evidence}${f.suggests ? ` → ${f.suggests}` : ''}`);
  }

  if (rep.pairs.length) {
    lines.push('', `pairs (${s.one_slot} would take one slot under path_overlap: ${s.path_overlap ?? 'off'})`);
    for (const p of rep.pairs) lines.push(`  #${p.a} ~ #${p.b}  ${p.score}  ${p.shared.join(', ')} — ${p.why}`);
  }

  const l = s.levels;
  lines.push('', `act ${l.act || 0} · ask ${l.ask || 0} · info ${l.info || 0} · judge ${rep.judgment.cards.length} card${rep.judgment.cards.length === 1 ? '' : 's'}, ${rep.judgment.pairs.length} pair${rep.judgment.pairs.length === 1 ? '' : 's'} · blockers from ${rep.blockers_source}`);
  return lines.join('\n');
}

/**
 * The dispatcher's life is not a worker's to touch: `dispatch` is what dispatched you, `up` starts a
 * second one and `down` stops the one watching your own attempt. The PreToolUse hook refuses the same
 * three command lines (`DENY_PATTERNS`, src/model.js); this is the layer that holds when a worker's
 * harness has no hook at all.
 */
function refuseIfWorker(cmd) {
  if (!process.env.KB_TASK) return;
  throw usage(`you are worker for task #${process.env.KB_TASK} — workers never start or stop the dispatcher (\`hkb ${cmd}\`): it is what dispatched you, a second one against the live board causes double-claims, and stopping it strands every attempt it is watching. Test dispatch logic with the fake-gh test double: node --test test/dispatch.test.js`);
}

/**
 * One line per card. `known` says whether this task's `blockedBy` is a real answer (`blockersKnown`,
 * src/tasks.js) — the ` ⇡ unblocked` nudge is computed here in memory, from the same rule
 * `groomBoard` uses (≥ 1 blocker, all done, not parked by `scheduled_at`), and is never guessed: on a
 * read that did not fill blockers an empty list means "not looked up", not "nothing blocks it".
 * No new field, no write, no extra request — a triage card whose blockers are all done says so.
 */
function taskLine(t, { known = false } = {}) {
  const deps = t.blockedBy?.length ? ` ⇐ ${t.blockedBy.map((b) => (blockerDone(b) ? `#${b.number}✓` : `#${b.number}`)).join(',')}` : '';
  const pr = t.prs?.find((p) => p.state === 'OPEN') ? ` PR#${t.prs.find((p) => p.state === 'OPEN').number}` : '';
  const unblocked = known && t.status === 'triage' && (t.blockedBy?.length || 0) >= 1 && computeReady(t) ? '  ⇡ unblocked' : '';
  return `#${String(t.number).padEnd(5)} ${(t.status || '?').padEnd(8)} ${(t.agent || '-').padEnd(10)} p${t.kb.priority}  ${t.title}${deps}${pr}${unblocked}${t.needsHuman ? '  ⚠ needs-human' : ''}`;
}

/**
 * One line for an `isTrackRoot` verdict: what the dispatcher will do with this card, why, and the
 * command that overrides it. The override is named next to the answer on purpose — the mode is
 * inferred now, so the only thing a human still has to know is how to say no.
 */
function trackLine(d, n) {
  if (d.mode === 'inferred') return `inferred — ${d.why}; one ${d.profile} session runs the subgraph (\`hkb track ${n} --off\` runs them as cold nodes instead)`;
  if (d.mode === 'forced') return `forced — ${d.why}`;
  if (d.mode === 'opted-out') return `opted out — ${d.why} (\`hkb track ${n} --on\` puts it back)`;
  return `no — ${d.why}`;
}

export async function main(argv) {
  const { flags, pos } = parseArgs(argv);
  const [typed, ...rest] = pos;
  const cmd = VERB_ALIASES[typed] || typed;
  if (!cmd || cmd === 'help' || flags.help) { process.stdout.write(HELP); return 0; }
  if (cmd === 'version') { const version = packageVersion(); out({ json: !!flags.json }, { version, node: process.version }, `hkb ${version}`); return 0; }
  if (cmd === 'hook') {
    // A hook never throws its way onto a worker's tool call (#184): `makeContext`/`ctx.requireBoard()`
    // are for a human who can read the error, `makeHookContext` is for a guard rail that must stand
    // aside instead when its own config is unreadable.
    const ctx = makeHookContext(flags);
    if (rest[0] === 'stop') return stopHook(ctx);
    if (rest[0] === 'pretool') { const { preToolHook } = await import('./hook.js'); return preToolHook(ctx); }
    if (rest[0] === 'subagentstop') { const { subagentStopHook } = await import('./hook.js'); return subagentStopHook(ctx); }
    throw usage('hkb hook stop|pretool|subagentstop');
  }
  const ctx = makeContext(flags);
  const argvForOutbox = process.env.KB_NO_OUTBOX ? null : argv;

  switch (cmd) {
    case 'init': return init(ctx, flags, log);
    case 'doctor': return doctor(ctx, flags, (s) => process.stdout.write(s + '\n'));
  }
  ctx.requireBoard();

  switch (cmd) {
    case 'create': {
      const title = rest[0];
      if (!title) throw usage('hkb create "title" [--body ..] [--blocked-by n,n] [--agent claude] ...');
      const kb = {};
      if (flags.priority !== undefined) kb.priority = Number(flags.priority);
      if (flags.workspace) kb.workspace = flags.workspace;
      if (flags['max-runtime']) kb.max_runtime = Number(flags['max-runtime']);
      if (flags['max-retries'] !== undefined) kb.max_retries = Number(flags['max-retries']);
      if (flags.model) kb.model = flags.model;
      if (flags.skills) kb.skills = list(str(flags.skills), '--skills');
      if (flags.paths) kb.paths = list(str(flags.paths), '--paths');
      if (flags['scheduled-at']) kb.scheduled_at = String(flags['scheduled-at']);
      if (flags['idempotency-key']) kb.idempotency_key = flags['idempotency-key'];
      if (flags.goal) kb.goal = flags.goal;
      const parents = flags['blocked-by'] ? String(flags['blocked-by']).split(',').map((s) => Number(s.replace('#', ''))).filter(Boolean) : [];
      const r = await createTask(ctx, { title, body: flags.body || '', kb, agent: flags.agent, parents, triage: !!flags.triage });
      out(ctx, r, r.duplicate
        ? `#${r.number} already exists with idempotency_key ${kb.idempotency_key}`
        : `#${r.number} ${r.status} (${r.agent}) ${r.url}`);
      return 0;
    }
    case 'list': {
      const tasks = await fetchBoard(ctx, { includeClosed: !!flags.all });
      let rows = tasks;
      if (flags.status) rows = rows.filter((t) => t.status === flags.status);
      if (flags.agent) rows = rows.filter((t) => t.agent === flags.agent);
      if (ctx.json) { out(ctx, rows.map(({ body, ...t }) => t)); return 0; }
      const order = STATUSES;
      rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.number - b.number);
      if (!rows.length) { process.stdout.write(`(no tasks on board "${ctx.board}")\n`); return 0; }
      let cur = null;
      for (const t of rows) {
        if (t.status !== cur) { cur = t.status; process.stdout.write(`\n${cur.toUpperCase()}\n`); }
        process.stdout.write('  ' + taskLine(t, { known: blockersKnown(tasks, t) }) + '\n');
      }
      return 0;
    }
    // The lane, judged by arithmetic. One board read (blockers filled for every open card), then the
    // pure `groomBoard` — no LLM, and **no writes**: `hkb groom` is a read exactly like
    // `hkb dispatch --dry-run`, and nothing here may change a status, a label or a body.
    case 'groom': {
      const o = groomOptions(flags); // validated before the request, so a typo costs nothing
      const tasks = await fetchBoard(ctx, { includeClosed: o.all, blockers: 'all' });
      const rep = filterGroomLevel(groomBoard(tasks, {
        now: new Date(),
        caps: ctx.caps,
        pairs: o.pairs,
        statuses: o.statuses,
        board: ctx.board,
        guard: pathOverlapGuard(ctx.cfg),
        bodies: o.bodies,
        // provenance lives on the array `fetchBoard` returned and does not survive a reshape,
        // so it is read here, against that array, and handed to the pure function as a fact
        blockersFilled: blockersOf(tasks).filled,
      }), o.level);
      out(ctx, rep, formatGroom(rep, new Map(tasks.map((t) => [t.number, t]))));
      return 0;
    }
    case 'show': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb show <n>');
      const t = await getTask(ctx, n);
      const { run } = await loadRun(ctx, n);
      const result = await latestResult(ctx, n);
      const parents = await parentResults(ctx, t);
      // the card in isolation: `hkb show` reads one issue, and only the board knows whether
      // something else is still blocked by this one. `hkb track <n>` is the answer that does.
      const trackVerdict = isTrackRoot(t, ctx.cfg);
      if (ctx.json) { out(ctx, { ...t, run, result, parents, track: trackVerdict }); return 0; }
      process.stdout.write(`${taskLine(t, { known: true })}\n${t.url}\n\n${t.bodyText.trim() || '(no description)'}\n\n`);
      process.stdout.write(`kb: ${JSON.stringify(t.kb)}\n`);
      if (t.blockedBy.length) process.stdout.write(`blocked by: ${t.blockedBy.map((b) => `#${b.number} ${b.title || ''} [${blockerDone(b) ? 'done' : String(b.state).toLowerCase()}]`).join('; ')}\n`);
      if (trackVerdict.mode !== 'none' || trackVerdict.children.length) process.stdout.write(`track: ${trackLine(trackVerdict, n)}\n`);
      if (t.prs.length) process.stdout.write(`PRs: ${t.prs.map((p) => `#${p.number} ${p.state}${p.merged ? ' merged' : p.isDraft ? ' draft' : ''}`).join(', ')}\n`);
      if (run.attempts.length) {
        process.stdout.write(`\nattempts (failures ${run.failures}):\n`);
        for (const a of run.attempts) {
          // `@host` is who *claimed* it; a `remote` attempt then ran somewhere else entirely (Actions),
          // which is why it has no pid and why only its heartbeat says it is alive.
          process.stdout.write(`  ${a.attempt}. ${a.profile}@${a.host || '-'}${a.remote ? ' → off-host' : ''} ${a.started_at} → ${a.ended_at || 'active'} ${a.outcome || ''}${a.summary ? ' — ' + a.summary : ''}${a.reason ? ' — ' + a.reason : ''}\n`);
          if (a.job) process.stdout.write(`     job ${a.job}${a.ended_at ? '' : ' · claude attach ' + a.job}\n`);
          const session = formatSession(a);
          if (session) process.stdout.write(`     ${session}\n`);
          if (a.terminal_reason) process.stdout.write(`     ended: ${a.terminal_reason}\n`);
          const denials = formatDenials(a);
          if (denials) process.stdout.write(`     denied: ${denials}\n`);
          const resume = resumeCommand(a, n);
          if (resume) process.stdout.write(`     ${resume}\n`);
        }
      }
      if (result) process.stdout.write(`\nlatest result: ${result.summary}\n`);
      for (const p of parents) if (p.result) process.stdout.write(`\nparent #${p.number}: ${p.result.summary}\n`);
      return 0;
    }
    case 'context': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb context <n>');
      process.stdout.write((await contextCommand(ctx, n)) + '\n');
      return 0;
    }
    case 'graph': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb graph <n> [--mermaid] [--json]');
      // one board read, then the same walk the dispatcher does: the root plus what is still blocking it
      const tasks = await fetchBoard(ctx);
      const track = resolveTrack(n, new Map(tasks.map((t) => [t.number, t])));
      if (!track.root) throw usage(`no open task #${n} on board "${ctx.board}" — \`hkb list\` shows what is there`);
      const g = trackGraph(track);
      const mermaid = trackMermaid(g);
      out(ctx, { ...g, mermaid }, mermaid);
      return 0;
    }
    // Will this card run as a track, and why — plus the one switch that overrides the answer.
    // Reads the whole board because the decision is a graph one: a card something else is still
    // blocked by is a node of that bigger track, not a root of its own.
    case 'track': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb track <n> [--off] [--on] [--json]');
      const tasks = await fetchBoard(ctx);
      const t = tasks.find((x) => x.number === n) || await getTask(ctx, n);
      if (flags.off || flags.on) {
        if (flags.off && flags.on) throw usage('hkb track <n> takes --off or --on, not both');
        if (flags.off) { await ensureLabels(ctx, [L.noTrack]); await addLabels(ctx, t, [L.noTrack]); }
        else await removeLabel(ctx, t, L.noTrack);
      }
      const d = isTrackRoot(t, ctx.cfg, { board: tasks });
      const track = d.track ? resolveTrack(n, new Map(tasks.map((x) => [x.number, x]))) : null;
      const nodes = track ? track.nodes.map((x) => x.number) : [];
      out(ctx, { number: n, ...d, nodes }, `#${n} track: ${trackLine(d, n)}${nodes.length ? `\nnodes: ${nodes.map((x) => `#${x}`).join(' → ')} → #${n}` : ''}`);
      return 0;
    }
    case 'status': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb status <n>');
      const t = await getTask(ctx, n);
      out(ctx, { number: n, status: t.status }, t.status || 'none');
      return 0;
    }
    case 'link':
    case 'unlink': {
      const [parent, child] = nums(rest);
      if (!parent || !child) throw usage(`hkb ${cmd} <parent> <child>`);
      const r = await linkTask(ctx, parent, child, { unlink: cmd === 'unlink' });
      out(ctx, r, `#${child} ${r.linked ? 'blocked by' : 'no longer blocked by'} #${parent} → ${r.status}`);
      return 0;
    }
    case 'promote': {
      const ns = nums(rest);
      if (!ns.length) throw usage('hkb promote <n>...');
      const res = [];
      for (const n of ns) res.push(...await promote(ctx, n));
      out(ctx, res, formatPromote(res));
      return 0;
    }
    // The write half of the kb block: `hkb groom`'s `unblocked`/`no_paths`/`malformed_kb`/`broad_path`/
    // `priority_inversion` findings all suggest an `hkb edit` line — this is the verb that runs it.
    // Only the flags actually passed change; every other key of the kb block is left exactly as read.
    case 'edit': {
      const ns = nums(rest);
      if (!ns.length) throw usage('hkb edit <n>... [--paths a,b] [--goal ".."] [--scheduled-at ISO] [--priority N]');
      const fields = {};
      if (flags.paths !== undefined) fields.paths = list(str(flags.paths), '--paths');
      if (flags.goal !== undefined) fields.goal = str(flags.goal);
      if (flags['scheduled-at'] !== undefined) fields.scheduled_at = str(flags['scheduled-at']);
      if (flags.priority !== undefined) fields.priority = Number(flags.priority);
      if (!Object.keys(fields).length) throw usage('hkb edit <n>... needs at least one of --paths/--goal/--scheduled-at/--priority');
      const res = [];
      for (const n of ns) {
        const t = await getTask(ctx, n);
        const kb = { ...t.kb, ...fields };
        await updateBody(ctx, t, kb);
        res.push({ number: n, kb });
      }
      out(ctx, res, res.map((r) => `#${r.number} kb: ${Object.keys(fields).join(', ')} set`).join('\n'));
      return 0;
    }
    case 'archive': {
      const ns = nums(rest);
      if (!ns.length) throw usage('hkb archive <n>...');
      const res = [];
      for (const n of ns) res.push(await archive(ctx, n));
      out(ctx, res, res.map((r) => `#${r.number} archived`).join('\n'));
      return 0;
    }
    case 'adopt': {
      const ns = nums(rest);
      if (!ns.length) throw usage('hkb adopt <n>... [--agent p] [--status triage]');
      const agent = flags.agent || Object.keys(ctx.cfg.profiles)[0];
      const status = flags.status || 'triage';
      const res = [];
      for (const n of ns) {
        const t = await getTask(ctx, n);
        if (!t.kb || !t.body.includes('<!-- kb:')) await updateBody(ctx, t, { ...DEFAULT_KB }, t.body);
        await addLabels(ctx, t, [L.board(ctx.board)]);
        await setAgent(ctx, t, agent); // one kb:agent:* label, so re-adopting onto another profile takes
        await setStatus(ctx, t, status);
        res.push({ number: n, status, agent });
      }
      out(ctx, res, res.map((r) => `#${r.number} adopted → ${r.status} (${r.agent})`).join('\n'));
      return 0;
    }
    case 'comment': {
      const [n] = nums(rest);
      if (!n || !rest[1]) throw usage('hkb comment <n> "text"');
      const c = await addComment(ctx, n, rest.slice(1).join(' '));
      out(ctx, { number: n, url: c.html_url }, c.html_url);
      return 0;
    }
    case 'log': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb log <n>');
      const { run } = await loadRun(ctx, n);
      const events = await issueEvents(ctx, n);
      const rows = [
        ...events.map((e) => ({ at: e.created_at, kind: e.event, detail: e.label?.name || e.assignee?.login || e.state_reason || '', actor: e.actor?.login })),
        ...run.attempts.flatMap((a) => [
          { at: a.started_at, kind: 'claimed', detail: `attempt ${a.attempt} ${a.profile}@${a.host || ''}` },
          ...(a.heartbeat_at ? [{ at: a.heartbeat_at, kind: 'heartbeat', detail: `attempt ${a.attempt}` }] : []),
          ...(a.ended_at ? [{ at: a.ended_at, kind: a.outcome, detail: a.summary || a.reason || '' }] : []),
        ]),
      ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      if (ctx.json) { out(ctx, rows); return 0; }
      for (const r of rows) process.stdout.write(`${r.at}  ${String(r.kind).padEnd(20)} ${r.detail || ''}${r.actor ? '  (' + r.actor + ')' : ''}\n`);
      return 0;
    }
    case 'heartbeat': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb heartbeat <n> [--note ..]');
      const r = await withOutbox(ctx, argvForOutbox, () => heartbeat(ctx, n, { note: flags.note, attempt: flags.attempt }));
      const how = r.skipped ? `ok (recent heartbeat; next in ${r.next_in_s}s)`
        : r.mode === 'ref' ? `#${n} attempt ${r.attempt}: lease held on ${r.ref} → ${String(r.sha).slice(0, 7)}${r.resynced ? ' (chain resynced)' : ''}`
          : `heartbeat recorded for #${n} attempt ${r.attempt}`;
      out(ctx, r, how);
      return 0;
    }
    case 'complete': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb finish <n> --summary ".." [--metadata JSON|path] [--artifacts a,b] | --summary-file p --metadata-file p | --from-stdin   (finish = complete)');
      const p = resolveTerminalInput(cmd, flags, rest);
      const replay = argvForOutbox && terminalArgv(cmd, n, p, { board: ctx.board, attempt: flags.attempt || envAttempt(n) });
      const r = await withOutbox(ctx, replay, () => complete(ctx, n, { summary: p.summary, metadata: p.metadata, artifacts: p.artifacts, attempt: flags.attempt }));
      out(ctx, r, `#${n} → ${r.status}${r.pr ? ` (waiting on PR #${r.pr}${r.pr_continued ? ', continued' : ''})` : ''}`);
      return 0;
    }
    case 'block': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb block <n> "reason" [--kind ..] | --reason-file p | --from-stdin');
      const p = resolveTerminalInput(cmd, flags, rest);
      const replay = argvForOutbox && terminalArgv(cmd, n, p, { board: ctx.board, attempt: flags.attempt || envAttempt(n) });
      const r = await withOutbox(ctx, replay, () => block(ctx, n, { reason: p.reason, kind: p.kind || 'generic', attempt: flags.attempt }));
      out(ctx, r, `#${n} → ${r.status}${r.block_loop_detected ? ' (block loop detected — needs human)' : ''}`);
      return 0;
    }
    case 'unblock': {
      const ns = nums(rest);
      if (!ns.length) throw usage('hkb unblock <n>...');
      const res = [];
      for (const n of ns) res.push(await unblock(ctx, n));
      out(ctx, res, res.map((r) => `#${r.number} → ${r.status}`).join('\n'));
      return 0;
    }
    case 'request-review': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb request-review <n> --summary ".." [--metadata JSON|path] [--reviewer <github-user>] | --summary-file p --metadata-file p | --from-stdin');
      const p = resolveTerminalInput(cmd, flags, rest);
      const replay = argvForOutbox && terminalArgv(cmd, n, p, { board: ctx.board, attempt: flags.attempt || envAttempt(n) });
      const r = await withOutbox(ctx, replay, () => requestReview(ctx, n, { summary: p.summary, metadata: p.metadata, reviewer: p.reviewer, attempt: flags.attempt }));
      out(ctx, r, `#${n} → review`);
      return 0;
    }
    case 'request-changes': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb request-changes <n> "reason"');
      const r = await requestChanges(ctx, n, { reason: rest.slice(1).join(' ') });
      out(ctx, r, `#${n} → ${r.status}${r.pr ? ` (PR #${r.pr} stays open; the next attempt continues it)` : ''}`);
      return 0;
    }
    case 'merge': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb merge <n> [--summary ".."]   merges under dispatch.merge.mode "operator" once a review is on the card');
      const r = await mergeCard(ctx, n, { summary: flags.summary });
      out(ctx, r, `#${n} → PR #${r.pr} merged (${r.method})`);
      return 0;
    }
    case 'claim': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb claim <n> [--profile p] [--spawn]');
      const t = await getTask(ctx, n);
      assertOnBoard(ctx, t);
      const runRec = await loadRun(ctx, n);
      const k = runRec.run.attempts.length + 1;
      // an open PR with the reviewer's changes_requested row on top is a continuation, exactly like
      // the dispatcher's own claim (`activePrGuard`, src/model.js) — a manual claim gets the same
      // `continues_pr`/`continues_branch` bookkeeping, or `finish` will not say "continued" (#162)
      const g = activePrGuard(runRec.run.attempts, t.prs);
      const continuePr = g.continues ? g.pr : null;
      const c = await claim(ctx, n, k);
      if (c.result !== 'claimed') { out(ctx, c, `#${n}: ${c.result}${c.error ? ' — ' + c.error.message : ''}`); return c.result === 'held' ? 2 : 1; }
      const profile = flags.profile || t.agent || Object.keys(ctx.cfg.profiles)[0];
      runRec.run.attempts.push({ attempt: k, profile, host: ctx.host, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), lock_sha: c.sha, manual: !flags.spawn, ...(continuePr ? { continues_pr: continuePr.number } : {}) });
      const { saveRun } = await import('./tasks.js');
      await saveRun(ctx, n, runRec);
      // Claimed by hand from inside another task's session — a track runner working a node. Leave
      // the marker that tells this session's Stop hook to stamp that node with the session id too.
      if (!flags.spawn) markSessionClaim(ctx.root, n, k, { profiles: ctx.cfg?.profiles });
      await setStatus(ctx, t, 'running');
      await setAgent(ctx, t, profile); // `--profile` names who is running it, so it replaces the old label
      let pid = null;
      if (flags.spawn) {
        const s = await spawnWorker(ctx, t, profile, k, { continuePr });
        pid = s.pid;
        runRec.run.attempts[k - 1].pid = pid;
        if (s.continued?.branch) runRec.run.attempts[k - 1].continues_branch = s.continued.branch;
        if (s.continued?.branch && s.continued.why) runRec.run.attempts[k - 1].continues_branch_stale = s.continued.why;
        await saveRun(ctx, n, runRec);
      }
      out(ctx, { number: n, attempt: k, ref: c.ref, pid }, `#${n} claimed (attempt ${k}, ${c.ref})${pid ? ` pid ${pid}` : `\nexport KB_TASK=${n} KB_ATTEMPT=${k}   # then work, and finish with hkb complete|block|request-review`}`);
      return 0;
    }
    case 'up': {
      refuseIfWorker(cmd);
      return await up(ctx, flags, (s) => process.stdout.write(s + '\n'));
    }
    case 'down': {
      refuseIfWorker(cmd);
      return await down(ctx, flags, (s) => process.stdout.write(s + '\n'));
    }
    case 'dispatch': {
      refuseIfWorker(cmd);
      const max = flags.max ? Number(flags.max) : Infinity;
      // `--profiles a,b`: claim only tasks on these profiles. The Actions dispatcher passes
      // `--profiles claude-action` so an Actions runner never tries to launch a laptop-only harness.
      const profiles = flags.profiles ? list(str(flags.profiles), '--profiles') : null;
      for (const p of profiles || []) if (!ctx.cfg.profiles[p]) throw usage(`--profiles: no profile "${p}" in board.json. Known: ${Object.keys(ctx.cfg.profiles).join(', ')}`);
      if (flags.loop) {
        const interval = flags.loop === true ? ctx.cfg.dispatch.interval : Number(flags.loop);
        log(`hkb dispatch loop every ${interval}s on ${ctx.repo.nameWithOwner} board "${ctx.board}" (host ${ctx.host})${profiles ? `, profiles ${profiles.join(', ')}` : ''}. Ctrl-C to stop.`);
        await loop(ctx, { interval, max, profiles, log: (s) => log(`${new Date().toISOString()} ${s}`) });
        return 0;
      }
      const s = await tick(ctx, { max, dryRun: !!flags['dry-run'], profiles, log });
      if (ctx.json) out(ctx, s);
      else {
        const n = (k) => s[k].length;
        log(`${flags['dry-run'] ? '[dry-run] ' : ''}reclaimed ${n('reclaimed')} · promoted ${n('promoted')} · claimed ${n('claimed')} · tracks ${s.tracks.filter((x) => x.ok).length}/${n('tracks')} · guarded ${n('guarded')} · held ${n('held')} · skipped ${n('skipped')}`);
        for (const t of s.tracks) log(`  track #${t.root} (${t.nodes.length + 1} nodes): ${t.ok ? `claimed attempt ${t.attempt} → ${t.profile}` : t.why}`);
        for (const c of s.claimed) log(`  claimed #${c.number} attempt ${c.attempt} → ${c.profile}${c.pid ? ' pid ' + c.pid : ''}`);
        for (const g of s.guarded) {
          const collides = (g.collides_with || []).map((c) => `#${c.number} (${c.paths.join(', ')})`).join('; ');
          log(`  guarded #${g.number}: ${g.guard}${collides ? ` — collides with ${collides}` : ''}`);
        }
        for (const k of s.skipped) log(`  skipped #${k.number}: ${k.why}`);
      }
      return 0;
    }
    case 'watch': return watch(ctx, flags);
    case 'tail': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb tail <n> [--interval 30] [--kinds ..] [--polls N] [--json]');
      return tail(ctx, n, flags);
    }
    case 'stats': return stats(ctx, flags);
    case 'serve': return serve(ctx, flags, log);
    // imported here, not at the top: mcp.js imports this module back for the version and the outbox argv
    case 'mcp': { const { mcp } = await import('./mcp.js'); return mcp(ctx, flags); }
    case 'gc': return gc(ctx, flags, log);
    default:
      throw usage(`unknown command "${cmd}". Run \`hkb help\`.`);
  }
}

export { parseBodyBlock, lastAttempt };
