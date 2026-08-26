// Argument parsing + command routing. Every command has --json; output is stable for scripts and agents.
import fs from 'node:fs';
import { makeContext } from './board.js';
import { getTask, fetchBoard, assertOnBoard, createIssue, addBlockedBy, removeBlockedBy, loadRun, latestResult, parentResults, issueEvents, issueDatabaseId, addComment, addLabels, setStatus, updateBody, ensureLabels } from './tasks.js';
import { heartbeat, complete, block, unblock, requestReview, requestChanges, promote, archive, withOutbox } from './lifecycle.js';
import { tick, loop, spawnWorker } from './dispatch.js';
import { claim } from './lock.js';
import { contextCommand } from './context.js';
import { stopHook } from './hook.js';
import { init } from './init.js';
import { doctor } from './doctor.js';
import { gc } from './gc.js';
import { STATUSES, DEFAULT_KB, L, computeReady, blockerDone, serializeBodyBlock, parseBodyBlock, lastAttempt } from './model.js';

/** Flags that never take a value, so `hkb complete --from-stdin 13` keeps `13` as a positional. */
const BOOL_FLAGS = new Set(['json', 'from-stdin', 'dry-run', 'triage', 'all', 'spawn', 'yes', 'import', 'no-hook', 'api', 'help']);

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
  if (process.stdin.isTTY) throw usage(`--from-stdin: stdin is a terminal — pipe a JSON object or use a heredoc: hkb complete <n> --from-stdin <<'EOF' ... EOF`);
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

  setup       init [--board slug] [--profiles claude] [--import] [--no-hook]     doctor [--api] [--json]
  tasks       create "title" [--body ..] [--blocked-by 12,13] [--agent claude] [--priority N] [--paths a/,b/]
                     [--model m] [--skills s1,s2] [--max-retries N] [--max-runtime S] [--scheduled-at ISO] [--triage] [--goal ".."]
              list [--status s] [--agent p] [--all] [--json]      show <n> [--json]      context <n>
              link <parent> <child>   unlink <parent> <child>      promote <n>...      archive <n>...
              adopt <n>... [--agent p]     comment <n> "text"      log <n> [--json]    status <n>
  worker      heartbeat <n> [--note ..]     complete <n> --summary ".." [--metadata JSON|path.json] [--artifacts a,b]
              block <n> "reason" [--kind dependency|needs_input|capability|transient]     unblock <n>...
              request-review <n> --summary ".." [--metadata ..] [--reviewer p]     request-changes <n> "reason"
              complete|block|request-review also take --summary-file <p> --metadata-file <p> --reason-file <p>, or
              --from-stdin with one JSON object {summary, metadata, artifacts, reason, kind, reviewer} (no shell quoting)
  dispatch    dispatch [--loop S] [--max N] [--dry-run]     claim <n> [--profile p] [--spawn]     gc [--yes]
  plumbing    hook stop      version

  Global: --board <slug> (or KB_BOARD), --json. Exit codes: 0 ok · 1 error · 2 usage/state · 3 LOCK_LOST.
`;

// Single source of truth for the version: package.json, resolved relative to this file (works from any cwd, no build step).
export function readVersion() {
  return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

const out = (ctx, obj, text) => { process.stdout.write((ctx.json ? JSON.stringify(obj, null, 2) : text ?? JSON.stringify(obj, null, 2)) + '\n'); };
const nums = (pos) => pos.map((p) => Number(String(p).replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n > 0);
const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };
const log = (s) => process.stderr.write(s + '\n');

function taskLine(t) {
  const deps = t.blockedBy?.length ? ` ⇐ ${t.blockedBy.map((b) => (blockerDone(b) ? `#${b.number}✓` : `#${b.number}`)).join(',')}` : '';
  const pr = t.prs?.find((p) => p.state === 'OPEN') ? ` PR#${t.prs.find((p) => p.state === 'OPEN').number}` : '';
  return `#${String(t.number).padEnd(5)} ${(t.status || '?').padEnd(8)} ${(t.agent || '-').padEnd(10)} p${t.kb.priority}  ${t.title}${deps}${pr}${t.needsHuman ? '  ⚠ needs-human' : ''}`;
}

export async function main(argv) {
  const { flags, pos } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.help) { process.stdout.write(HELP); return 0; }
  if (cmd === 'version') { const version = readVersion(); out({ json: !!flags.json }, { version, node: process.version }, `hkb ${version}`); return 0; }
  const ctx = makeContext(flags);
  const argvForOutbox = process.env.KB_NO_OUTBOX ? null : argv;

  switch (cmd) {
    case 'init': return init(ctx, flags, log);
    case 'doctor': return doctor(ctx, flags, (s) => process.stdout.write(s + '\n'));
    case 'hook': {
      if (rest[0] !== 'stop') throw usage('hkb hook stop');
      return stopHook(ctx);
    }
  }
  ctx.requireBoard();

  switch (cmd) {
    case 'create': {
      const title = rest[0];
      if (!title) throw usage('hkb create "title" [--body ..] [--blocked-by n,n] [--agent claude] ...');
      const kb = { ...DEFAULT_KB };
      if (flags.priority !== undefined) kb.priority = Number(flags.priority);
      if (flags.workspace) kb.workspace = flags.workspace;
      if (flags['max-runtime']) kb.max_runtime = Number(flags['max-runtime']);
      if (flags['max-retries'] !== undefined) kb.max_retries = Number(flags['max-retries']);
      if (flags.model) kb.model = flags.model;
      if (flags.skills) kb.skills = String(flags.skills).split(',').map((s) => s.trim()).filter(Boolean);
      if (flags.paths) kb.paths = String(flags.paths).split(',').map((s) => s.trim()).filter(Boolean);
      if (flags['scheduled-at']) kb.scheduled_at = new Date(flags['scheduled-at']).toISOString();
      if (flags['idempotency-key']) kb.idempotency_key = flags['idempotency-key'];
      if (flags.goal) kb.goal = flags.goal;
      const parents = flags['blocked-by'] ? String(flags['blocked-by']).split(',').map((s) => Number(s.replace('#', ''))).filter(Boolean) : [];
      if (kb.idempotency_key) {
        const dupe = (await fetchBoard(ctx, { includeClosed: true })).find((t) => t.kb.idempotency_key === kb.idempotency_key);
        if (dupe) { out(ctx, { number: dupe.number, duplicate: true }, `#${dupe.number} already exists with idempotency_key ${kb.idempotency_key}`); return 0; }
      }
      const agent = flags.agent || (Object.keys(ctx.cfg.profiles)[0] || 'claude');
      let status = 'triage';
      if (!flags.triage) {
        if (!parents.length) status = 'ready';
        else {
          const ps = await Promise.all(parents.map((n) => issueDatabaseId(ctx, n)));
          for (const p of ps) if (!p.labels.includes(L.board(ctx.board))) throw usage(`#${p.number} is not on board "${ctx.board}" — cross-board links are refused`);
          status = ps.every((p) => blockerDone({ state: p.state, stateReason: p.state_reason })) ? 'ready' : 'todo';
        }
      }
      if (kb.scheduled_at && new Date(kb.scheduled_at) > new Date() && status === 'ready') status = 'todo';
      const labels = [L.board(ctx.board), L.status(status), L.agent(agent)];
      await ensureLabels(ctx, [L.agent(agent)]);
      const issue = await createIssue(ctx, { title, body: serializeBodyBlock(kb, flags.body || ''), labels });
      for (const p of parents) await addBlockedBy(ctx, issue.number, p);
      out(ctx, { number: issue.number, status, agent, blocked_by: parents, url: issue.html_url }, `#${issue.number} ${status} (${agent}) ${issue.html_url}`);
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
        process.stdout.write('  ' + taskLine(t) + '\n');
      }
      return 0;
    }
    case 'show': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb show <n>');
      const t = await getTask(ctx, n);
      const { run } = await loadRun(ctx, n);
      const result = await latestResult(ctx, n);
      const parents = await parentResults(ctx, t);
      if (ctx.json) { out(ctx, { ...t, run, result, parents }); return 0; }
      process.stdout.write(`${taskLine(t)}\n${t.url}\n\n${t.bodyText.trim() || '(no description)'}\n\n`);
      process.stdout.write(`kb: ${JSON.stringify(t.kb)}\n`);
      if (t.blockedBy.length) process.stdout.write(`blocked by: ${t.blockedBy.map((b) => `#${b.number} ${b.title || ''} [${blockerDone(b) ? 'done' : String(b.state).toLowerCase()}]`).join('; ')}\n`);
      if (t.prs.length) process.stdout.write(`PRs: ${t.prs.map((p) => `#${p.number} ${p.state}${p.merged ? ' merged' : p.isDraft ? ' draft' : ''}`).join(', ')}\n`);
      if (run.attempts.length) {
        process.stdout.write(`\nattempts (failures ${run.failures}):\n`);
        for (const a of run.attempts) process.stdout.write(`  ${a.attempt}. ${a.profile}@${a.host || '-'} ${a.started_at} → ${a.ended_at || 'active'} ${a.outcome || ''}${a.summary ? ' — ' + a.summary : ''}${a.reason ? ' — ' + a.reason : ''}${a.job ? `\n     job ${a.job}${a.ended_at ? '' : ' · claude attach ' + a.job}` : ''}\n`);
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
      const [p, c] = await Promise.all([getTask(ctx, parent), getTask(ctx, child)]);
      assertOnBoard(ctx, p); assertOnBoard(ctx, c);
      if (cmd === 'link') await addBlockedBy(ctx, child, parent); else await removeBlockedBy(ctx, child, parent);
      const fresh = await getTask(ctx, child);
      if (cmd === 'link' && fresh.status === 'ready' && !computeReady(fresh)) await setStatus(ctx, fresh, 'todo');
      if (cmd === 'unlink' && fresh.status === 'todo' && computeReady(fresh)) await setStatus(ctx, fresh, 'ready');
      out(ctx, { parent, child, status: fresh.status }, `#${child} ${cmd === 'link' ? 'blocked by' : 'no longer blocked by'} #${parent} → ${fresh.status}`);
      return 0;
    }
    case 'promote': {
      const ns = nums(rest);
      if (!ns.length) throw usage('hkb promote <n>...');
      const res = [];
      for (const n of ns) res.push(await promote(ctx, n));
      out(ctx, res, res.map((r) => `#${r.number} → ${r.status}${r.forced ? ' (forced: blockers not done)' : ''}`).join('\n'));
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
        await addLabels(ctx, t, [L.board(ctx.board), L.agent(agent)]);
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
      const r = await withOutbox(ctx, argvForOutbox, () => heartbeat(ctx, n, { note: flags.note }));
      out(ctx, r, r.skipped ? `ok (recent heartbeat; next in ${r.next_in_s}s)` : `heartbeat recorded for #${n} attempt ${r.attempt}`);
      return 0;
    }
    case 'complete': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb complete <n> --summary ".." [--metadata JSON|path] [--artifacts a,b] | --summary-file p --metadata-file p | --from-stdin');
      const p = resolveTerminalInput(cmd, flags, rest);
      const replay = argvForOutbox && terminalArgv(cmd, n, p, { board: ctx.board, attempt: flags.attempt || process.env.KB_ATTEMPT });
      const r = await withOutbox(ctx, replay, () => complete(ctx, n, { summary: p.summary, metadata: p.metadata, artifacts: p.artifacts, attempt: flags.attempt }));
      out(ctx, r, `#${n} → ${r.status}${r.pr ? ` (waiting on PR #${r.pr})` : ''}`);
      return 0;
    }
    case 'block': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb block <n> "reason" [--kind ..] | --reason-file p | --from-stdin');
      const p = resolveTerminalInput(cmd, flags, rest);
      const replay = argvForOutbox && terminalArgv(cmd, n, p, { board: ctx.board, attempt: flags.attempt || process.env.KB_ATTEMPT });
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
      if (!n) throw usage('hkb request-review <n> --summary ".." [--metadata JSON|path] [--reviewer p] | --summary-file p --metadata-file p | --from-stdin');
      const p = resolveTerminalInput(cmd, flags, rest);
      const replay = argvForOutbox && terminalArgv(cmd, n, p, { board: ctx.board, attempt: flags.attempt || process.env.KB_ATTEMPT });
      const r = await withOutbox(ctx, replay, () => requestReview(ctx, n, { summary: p.summary, metadata: p.metadata, reviewer: p.reviewer, attempt: flags.attempt }));
      out(ctx, r, `#${n} → review`);
      return 0;
    }
    case 'request-changes': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb request-changes <n> "reason"');
      const r = await requestChanges(ctx, n, { reason: rest.slice(1).join(' ') });
      out(ctx, r, `#${n} → ${r.status}`);
      return 0;
    }
    case 'claim': {
      const [n] = nums(rest);
      if (!n) throw usage('hkb claim <n> [--profile p] [--spawn]');
      const t = await getTask(ctx, n);
      assertOnBoard(ctx, t);
      const runRec = await loadRun(ctx, n);
      const k = runRec.run.attempts.length + 1;
      const c = await claim(ctx, n, k);
      if (c.result !== 'claimed') { out(ctx, c, `#${n}: ${c.result}${c.error ? ' — ' + c.error.message : ''}`); return c.result === 'held' ? 2 : 1; }
      const profile = flags.profile || t.agent || Object.keys(ctx.cfg.profiles)[0];
      runRec.run.attempts.push({ attempt: k, profile, host: ctx.host, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), manual: !flags.spawn });
      const { saveRun } = await import('./tasks.js');
      await saveRun(ctx, n, runRec);
      await setStatus(ctx, t, 'running', { add: [L.agent(profile)] });
      let pid = null;
      if (flags.spawn) { const s = await spawnWorker(ctx, t, profile, k); pid = s.pid; runRec.run.attempts[k - 1].pid = pid; await saveRun(ctx, n, runRec); }
      out(ctx, { number: n, attempt: k, ref: c.ref, pid }, `#${n} claimed (attempt ${k}, ${c.ref})${pid ? ` pid ${pid}` : `\nexport KB_TASK=${n} KB_ATTEMPT=${k}   # then work, and finish with hkb complete|block|request-review`}`);
      return 0;
    }
    case 'dispatch': {
      const max = flags.max ? Number(flags.max) : Infinity;
      if (flags.loop) {
        const interval = flags.loop === true ? ctx.cfg.dispatch.interval : Number(flags.loop);
        log(`hkb dispatch loop every ${interval}s on ${ctx.repo.nameWithOwner} board "${ctx.board}" (host ${ctx.host}). Ctrl-C to stop.`);
        await loop(ctx, { interval, max, log: (s) => log(`${new Date().toISOString()} ${s}`) });
        return 0;
      }
      const s = await tick(ctx, { max, dryRun: !!flags['dry-run'], log });
      if (ctx.json) out(ctx, s);
      else {
        const n = (k) => s[k].length;
        log(`${flags['dry-run'] ? '[dry-run] ' : ''}reclaimed ${n('reclaimed')} · promoted ${n('promoted')} · claimed ${n('claimed')} · guarded ${n('guarded')} · held ${n('held')} · skipped ${n('skipped')}`);
        for (const c of s.claimed) log(`  claimed #${c.number} attempt ${c.attempt} → ${c.profile}${c.pid ? ' pid ' + c.pid : ''}`);
        for (const g of s.guarded) log(`  guarded #${g.number}: ${g.guard}`);
        for (const k of s.skipped) log(`  skipped #${k.number}: ${k.why}`);
      }
      return 0;
    }
    case 'gc': return gc(ctx, flags, log);
    default:
      throw usage(`unknown command "${cmd}". Run \`hkb help\`.`);
  }
}

export { parseBodyBlock, lastAttempt };
