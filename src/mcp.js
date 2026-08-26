// `hkb mcp` — the board as an MCP server on stdio, plus the config `hkb init --mcp` writes.
//
// MCP over stdio is JSON-RPC 2.0 in newline-delimited JSON, so the protocol is implemented here
// rather than depended on: `initialize`, `tools/list`, `tools/call`, `ping`. Every tool is a wrapper
// around the function `src/cli.js` calls for the same verb and returns the object that verb's
// `--json` prints — one code path, no second source of truth, nothing to keep in sync.
//
// stdout carries protocol frames and nothing else. Everything human goes to stderr, or the client's
// parser breaks on the first log line.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hkbOnPath } from './board.js';
import { getTask, loadRun, latestResult, parentResults, addComment } from './tasks.js';
import { heartbeat, complete, block, unblock, requestReview, createTask, linkTask, withOutbox } from './lifecycle.js';
import { readVersion, terminalArgv } from './cli.js';
import { BLOCK_KINDS } from './model.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };

// ---------- the protocol ----------

export const SERVER_NAME = 'hkb';
/** What we answer `initialize` with when the client asks for something we do not know. */
export const PROTOCOL_VERSION = '2025-06-18';
/** Newest first: an `initialize` naming one of these is echoed back verbatim. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function negotiateProtocol(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
}

/** JSON-RPC 2.0 error codes, plus the two of MCP's own that this server can raise. */
export const RPC = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 };

/** The `instructions` field of `initialize`: the protocol in five lines, for a client that shows it to its model. */
export const INSTRUCTIONS = `hkb is a kanban board whose tasks are GitHub issues labelled kb:*.
A worker's own task number is $KB_TASK; every tool defaults to it, so "task" is only needed for another task.
Start with kanban_show — it carries the spec, the blockers' results and every previous attempt.
While working, call kanban_heartbeat about every 10 minutes. If it answers LOCK_LOST the dispatcher has
taken the task back: stop at once, do not commit, do not complete.
Finish an attempt with exactly one of kanban_complete, kanban_block, kanban_request_review.`;

// ---------- tools ----------

const TASK = { type: 'integer', minimum: 1, description: 'Task (issue) number. Defaults to $KB_TASK, which the dispatcher sets for a worker.' };
const SUMMARY = { type: 'string', minLength: 1, description: 'What changed, for the next worker — not a narrative of what you tried.' };
const METADATA = { type: 'object', description: 'Structured detail for the result comment, e.g. {"changed_files": [..], "verification": [..], "residual_risk": [..]}.' };
const ARTIFACTS = { type: 'array', items: { type: 'string' }, description: 'Paths or URLs this attempt produced.' };
const NUMBER_LIST = { type: 'array', items: { type: 'integer' } };
const STRING_LIST = { type: 'array', items: { type: 'string' } };

/** The `kb` block fields `kanban_create` accepts by their own names, so the tool and the issue body agree. */
const KB_FIELDS = ['priority', 'workspace', 'max_runtime', 'max_retries', 'model', 'skills', 'paths', 'scheduled_at', 'idempotency_key', 'goal'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * One entry per verb. `properties`/`required` are the JSON Schema the client validates against;
 * `run(ctx, number, args)` calls the same function the CLI does — `number` is already resolved from
 * `task` or $KB_TASK, and `replay` names the CLI verb whose argv is queued when GitHub is unreachable.
 */
export const TOOLS = [
  {
    name: 'kanban_show',
    title: 'Show a task',
    readOnly: true,
    description: 'Everything about one task: its spec, the kb block, status, blockers, pull requests, every attempt in the run record, the latest result and the parent tasks\' results. The same object as `hkb show <n> --json`. Read this before doing any work.',
    properties: { task: TASK },
    run: async (ctx, n) => {
      const t = await getTask(ctx, n);
      const { run } = await loadRun(ctx, n);
      const result = await latestResult(ctx, n);
      const parents = await parentResults(ctx, t);
      return { ...t, run, result, parents };
    },
  },
  {
    name: 'kanban_heartbeat',
    title: 'Say this attempt is still alive',
    idempotent: true,
    description: 'Call about every 10 minutes of long work. It is free — a compare-and-swap on the lock ref, no API call. A LOCK_LOST answer means the dispatcher reclaimed the task: stop immediately, do not commit, do not call kanban_complete.',
    properties: { task: TASK, note: { type: 'string', description: 'One line of progress recorded on the attempt. Forces the (costlier) run-comment path — use sparingly.' } },
    run: (ctx, n, a) => heartbeat(ctx, n, { note: a.note }),
  },
  {
    name: 'kanban_complete',
    title: 'Finish the task',
    description: 'The terminal verb for work that is done: closes the attempt, releases the lock, writes the result comment and moves the task to done — or to review while its pull request is still open. Exactly one terminal verb per attempt.',
    properties: { task: TASK, summary: SUMMARY, metadata: METADATA, artifacts: ARTIFACTS },
    required: ['summary'],
    replay: 'complete',
    run: (ctx, n, a) => complete(ctx, n, { summary: a.summary, metadata: a.metadata, artifacts: a.artifacts }),
  },
  {
    name: 'kanban_block',
    title: 'Stop, and say why',
    description: 'The terminal verb for work that cannot proceed. `kind` decides what happens next: dependency puts the task back in todo, transient lets the dispatcher retry, needs_input and capability park it for a human.',
    properties: {
      task: TASK,
      reason: { type: 'string', minLength: 1, description: 'What is in the way, and what would unblock it.' },
      kind: { type: 'string', enum: BLOCK_KINDS, description: BLOCK_KINDS.join(' | ') },
    },
    required: ['reason'],
    replay: 'block',
    run: (ctx, n, a) => block(ctx, n, { reason: a.reason, kind: a.kind || 'generic' }),
  },
  {
    name: 'kanban_request_review',
    title: 'Hand the task to a reviewer',
    description: 'The terminal verb for work that wants a human before it counts as done: closes the attempt, takes the pull request out of draft and moves the task to review.',
    properties: { task: TASK, summary: SUMMARY, metadata: METADATA, reviewer: { type: 'string', description: 'GitHub login to request on the pull request.' } },
    required: ['summary'],
    replay: 'request-review',
    run: (ctx, n, a) => requestReview(ctx, n, { summary: a.summary, metadata: a.metadata, reviewer: a.reviewer }),
  },
  {
    name: 'kanban_comment',
    title: 'Comment on a task',
    description: 'Add a plain comment to the task\'s issue. For progress notes worth keeping; it does not end the attempt and it does not change status.',
    properties: { task: TASK, text: { type: 'string', minLength: 1, description: 'Markdown body of the comment.' } },
    required: ['text'],
    run: async (ctx, n, a) => ({ number: n, url: (await addComment(ctx, n, a.text)).html_url }),
  },
  {
    name: 'kanban_create',
    title: 'Create a task',
    description: 'Add a task to the board. With no blockers it lands in ready; blocked by an open task it lands in todo and is promoted when the blocker is done. Create tasks only when you were asked to — a worker that splits its own work makes the board unreadable.',
    properties: {
      title: { type: 'string', minLength: 1, description: 'One line: the outcome, not the activity.' },
      body: { type: 'string', description: 'The spec — what, done when, and the paths it owns.' },
      blocked_by: { ...NUMBER_LIST, description: 'Task numbers this one waits on. They must be on the same board.' },
      agent: { type: 'string', description: 'Profile that should run it (default: the board\'s first profile).' },
      triage: { type: 'boolean', description: 'Park it in triage for a human to promote, instead of making it ready.' },
      priority: { type: 'integer', description: 'Higher runs first. Default 0.' },
      paths: { ...STRING_LIST, description: 'The files and directories this task owns — the dispatcher will not run two tasks that overlap.' },
      skills: { ...STRING_LIST, description: 'Skills the worker should load.' },
      model: { type: 'string', description: 'Model override for the worker.' },
      max_retries: { type: 'integer', description: 'Attempts before the task needs a human.' },
      max_runtime: { type: 'integer', description: 'Seconds before an attempt is considered stale.' },
      scheduled_at: { type: 'string', description: 'ISO timestamp; the task stays in todo until then.' },
      idempotency_key: { type: 'string', description: 'Creating twice with the same key returns the first task instead of a duplicate.' },
      goal: { type: 'string', description: 'The larger goal this task belongs to.' },
    },
    required: ['title'],
    run: (ctx, _n, a) => createTask(ctx, { title: a.title, body: a.body, agent: a.agent, triage: a.triage, parents: a.blocked_by, kb: pick(a, KB_FIELDS) }),
  },
  {
    name: 'kanban_link',
    title: 'Make one task block another',
    idempotent: true,
    description: 'Record that `child` is blocked by `parent`. A ready child that gains an open blocker drops back to todo, and is promoted again when the blocker closes.',
    properties: {
      parent: { type: 'integer', minimum: 1, description: 'The task that must finish first.' },
      child: { type: 'integer', minimum: 1, description: 'The task that waits.' },
    },
    required: ['parent', 'child'],
    run: (ctx, _n, a) => linkTask(ctx, a.parent, a.child),
  },
  {
    name: 'kanban_unblock',
    title: 'Take a task out of blocked',
    idempotent: true,
    description: 'Clear kb:needs-human and put a blocked (or triaged) task back where its blockers say it belongs — ready when they are all done, todo otherwise. Resets the consecutive-failure count.',
    properties: { task: TASK },
    run: (ctx, n) => unblock(ctx, n),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The `tools/list` entry for one tool: schema plus the hints a client uses to decide what to auto-approve. */
export function toolSpec(t) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: t.properties,
      ...(t.required?.length ? { required: t.required } : {}),
      additionalProperties: false,
    },
    annotations: {
      title: t.title,
      readOnlyHint: !!t.readOnly,
      destructiveHint: false,
      idempotentHint: !!(t.readOnly || t.idempotent),
      openWorldHint: true, // every tool talks to GitHub
    },
  };
}

export const toolList = () => TOOLS.map(toolSpec);

// ---------- arguments ----------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A number a model may have spelled "12" or "#12". null when it is not a positive integer. */
function toInteger(v) {
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/^#/, ''));
  return Number.isInteger(n) ? n : null;
}

function checkValue(tool, key, schema, value) {
  const bad = (want) => usage(`${tool}: "${key}" must be ${want}, got ${Array.isArray(value) ? 'an array' : typeof value}`);
  if (schema.enum && !schema.enum.includes(value)) throw usage(`${tool}: "${key}" must be one of ${schema.enum.join(' | ')}, got ${JSON.stringify(value)}`);
  switch (schema.type) {
    case 'integer': {
      const n = toInteger(value);
      if (n === null) throw bad('an integer');
      if (schema.minimum !== undefined && n < schema.minimum) throw usage(`${tool}: "${key}" must be >= ${schema.minimum}, got ${n}`);
      return n;
    }
    case 'string':
      if (typeof value !== 'string') throw bad('a string');
      if (schema.minLength && !value.trim()) throw usage(`${tool}: "${key}" must not be empty — ${schema.description}`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('true or false');
      return value;
    case 'object':
      if (!isPlainObject(value)) throw bad('a JSON object');
      return value;
    case 'array': {
      // a model that has been writing CLI flags all day sends "a,b" where a list belongs — take it
      const list = typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;
      if (!Array.isArray(list)) throw bad('an array');
      return list.map((item, i) => checkValue(tool, `${key}[${i}]`, schema.items || {}, item));
    }
    default:
      return value;
  }
}

/**
 * Validate `tools/call` arguments against a tool's schema. Clients validate too, but a wrong argument
 * must name the right one rather than reaching GitHub — so this is the boundary, not a nicety.
 * Pure: no I/O, no env. Returns the coerced arguments.
 */
export function validateArgs(tool, args = {}) {
  if (args === undefined || args === null) args = {};
  if (!isPlainObject(args)) throw usage(`${tool.name}: "arguments" must be a JSON object`);
  const known = Object.keys(tool.properties);
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) throw usage(`${tool.name}: unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — it takes ${known.join(', ')}`);
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue; // a client that fills every field with null means "absent"
    out[k] = checkValue(tool.name, k, tool.properties[k], v);
  }
  for (const k of tool.required || []) {
    if (out[k] === undefined) throw usage(`${tool.name}: "${k}" is required — ${tool.properties[k].description}`);
  }
  return out;
}

/** Which task a call is about: the `task` argument, else $KB_TASK, else an error that says so. */
export function resolveTask(args = {}, env = process.env) {
  const n = toInteger(args.task ?? env.KB_TASK ?? '');
  if (n === null || n <= 0) {
    throw usage('which task? pass {"task": <issue number>} — or run the server with KB_TASK set, the way the dispatcher launches a worker');
  }
  return n;
}

// ---------- calling a tool ----------

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/**
 * Run one tool and shape the MCP result. A bad argument or a verb that refuses is *not* a protocol
 * error: the model has to read "LOCK_LOST" or "a summary is required" and fix its next call, and
 * `isError` content is what every client puts in front of it. Only an unknown tool — which no retry
 * can reach — is a JSON-RPC error.
 */
export async function callTool(ctx, name, rawArgs, env = process.env) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    const e = usage(`unknown tool "${name}" — this server has ${TOOLS.map((t) => t.name).join(', ')}`);
    e.rpc = RPC.params;
    throw e;
  }
  ctx._cache = {}; // a server outlives many calls; never answer from a previous call's comments
  try {
    const args = validateArgs(tool, rawArgs);
    const number = tool.properties.task ? resolveTask(args, env) : null;
    const value = await runVerb(ctx, tool, number, args, env);
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
  } catch (e) {
    if (e?.queued) return textResult(e.message); // GitHub unreachable: queued for replay, not a failure
    return textResult(`hkb ${name} failed${e?.exitCode ? ` (exit ${e.exitCode})` : ''}: ${e?.message || e}`, true);
  }
}

/** The verb itself, wrapped in the same offline outbox the CLI uses for the terminal verbs. */
function runVerb(ctx, tool, number, args, env) {
  if (!tool.replay || env.KB_NO_OUTBOX) return tool.run(ctx, number, args);
  const argv = terminalArgv(tool.replay, number, args, { board: ctx.board, attempt: env.KB_ATTEMPT });
  return withOutbox(ctx, argv, () => tool.run(ctx, number, args));
}

// ---------- JSON-RPC ----------

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Handle one parsed message. Returns the response to write, or null for a notification (JSON-RPC
 * forbids answering those) and for anything that is not a request. `session` carries what
 * `initialize` negotiated. Requests before `initialize` are answered rather than refused: a human
 * driving this by hand should be able to pipe in one `tools/list` and see the tools.
 */
export async function handleMessage(msg, session, exec) {
  if (Array.isArray(msg)) return fail(null, RPC.request, 'JSON-RPC batches are not supported — send one message per line');
  if (!isPlainObject(msg)) return fail(null, RPC.request, 'a JSON-RPC message must be an object');
  if (typeof msg.method !== 'string') return null; // a response to something we never asked
  const id = msg.id === undefined ? null : msg.id;
  const isRequest = msg.id !== undefined && msg.id !== null;
  const params = isPlainObject(msg.params) ? msg.params : {};

  switch (msg.method) {
    case 'initialize': {
      session.protocolVersion = negotiateProtocol(params.protocolVersion);
      session.client = params.clientInfo || null;
      return isRequest ? ok(id, {
        protocolVersion: session.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'hkb kanban', version: readVersion() },
        instructions: INSTRUCTIONS,
      }) : null;
    }
    case 'ping':
      return isRequest ? ok(id, {}) : null;
    case 'tools/list':
      return isRequest ? ok(id, { tools: toolList() }) : null;
    case 'tools/call': {
      if (!isRequest) return null;
      if (typeof params.name !== 'string') return fail(id, RPC.params, '"name" is required: {"name": "kanban_show", "arguments": {...}}');
      try {
        return ok(id, await exec(params.name, params.arguments));
      } catch (e) {
        return fail(id, e?.rpc || RPC.internal, e.message);
      }
    }
    default:
      if (!isRequest) return null; // unknown notification: ignore, as JSON-RPC requires
      if (msg.method.startsWith('notifications/')) return null;
      return fail(id, RPC.method, `this server implements initialize, tools/list, tools/call and ping — not "${msg.method}"`);
  }
}

// ---------- the stdio transport ----------

const MAX_LINE = 8 * 1024 * 1024; // a client that never sends a newline must not eat the heap

/**
 * Read newline-delimited JSON-RPC from `input`, write it to `output`, until the input ends.
 * Calls are serialised: they hit the same GitHub board and a client is free to pipeline, but two
 * lifecycle verbs racing on one issue is not something the protocol should have to survive.
 * @returns {Promise<number>} exit code
 */
export function serveStdio(ctx, { input = process.stdin, output = process.stdout, env = process.env, log = () => {} } = {}) {
  const session = { protocolVersion: null, client: null };
  const exec = (name, args) => callTool(ctx, name, args, env);
  const write = (res) => { if (res) output.write(JSON.stringify(res) + '\n'); };

  return new Promise((resolve, reject) => {
    let buffer = '';
    let chain = Promise.resolve();
    const step = async (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { write(fail(null, RPC.parse, `not JSON: ${e.message}`)); return; }
      try { write(await handleMessage(msg, session, exec)); } catch (e) {
        log(`hkb mcp: ${e.stack || e.message}`);
        write(fail(isPlainObject(msg) && msg.id !== undefined ? msg.id : null, RPC.internal, e.message));
      }
    };
    const queue = (line) => { chain = chain.then(() => step(line)); };

    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '').trim();
        buffer = buffer.slice(i + 1);
        if (line) queue(line);
      }
      if (buffer.length > MAX_LINE) {
        buffer = '';
        write(fail(null, RPC.parse, `a single message went past ${MAX_LINE} bytes without a newline — messages are newline-delimited JSON`));
      }
    });
    input.on('error', reject);
    input.on('end', () => { chain.then(() => resolve(0), reject); });
    // a client that dies mid-answer closes the pipe: that is the session ending, not a failure
    output.on?.('error', (e) => (e?.code === 'EPIPE' ? resolve(0) : reject(e)));
  });
}

/** `hkb mcp`. Runs until the client closes stdin. */
export async function mcp(ctx, flags = {}, deps = {}) {
  const log = deps.log || ((s) => process.stderr.write(s + '\n'));
  log(`hkb mcp (v${readVersion()}) on ${ctx.repo.nameWithOwner} board "${ctx.board}" — ${TOOLS.length} tools over stdio${process.env.KB_TASK ? `, KB_TASK=${process.env.KB_TASK}` : ''}`);
  return serveStdio(ctx, { ...deps, log });
}

// ---------- client configuration (`hkb init --mcp`) ----------

export const MCP_FILE = '.mcp.json';
/** The key every generated config uses. Renaming it renames the tools' prefix for the user, so: don't. */
export const MCP_KEY = 'kanban';

const template = (name) => fs.readFileSync(path.join(PKG_ROOT, 'templates', 'mcp', name), 'utf8');
/** For a placeholder inside a TOML basic string — a Windows path is full of backslashes. */
const tomlInner = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

/**
 * How a client should launch this server: `hkb mcp` when hkb is on PATH, else this checkout's
 * `bin/hkb.js` under the node running right now. An MCP client is often started by a GUI with a
 * minimal PATH, so the fallback is absolute on both halves.
 */
export function mcpLaunch({ onPath = hkbOnPath() } = {}) {
  if (onPath) return { command: 'hkb', args: ['mcp'] };
  return { command: process.execPath, args: [path.join(PKG_ROOT, 'bin', 'hkb.js'), 'mcp'] };
}

/** The server entry `.mcp.json` holds under `mcpServers.kanban`, straight out of the template. */
export function mcpEntry(launch = mcpLaunch()) {
  const entry = JSON.parse(template('mcp.json')).mcpServers[MCP_KEY];
  return { ...entry, command: launch.command, args: launch.args };
}

/**
 * `.mcp.json` with our server merged in. Pure: takes the current file text (or null) and returns the
 * text to write. Another server in the file is left exactly as it was — this file is the user's.
 * @returns {{ text: string, changed: boolean, servers: string[] }}
 * @throws when the existing file is not JSON we can safely rewrite
 */
export function mergeMcpJson(current, entry) {
  let doc = { mcpServers: {} };
  if (current && current.trim()) {
    try { doc = JSON.parse(current); } catch (e) {
      throw usage(`${MCP_FILE} is not valid JSON (${e.message}) — fix it, or move it aside and run \`hkb init --mcp\` again`);
    }
    if (!isPlainObject(doc)) throw usage(`${MCP_FILE} must contain a JSON object`);
    if (doc.mcpServers !== undefined && !isPlainObject(doc.mcpServers)) throw usage(`${MCP_FILE}: "mcpServers" must be a JSON object`);
    doc.mcpServers = doc.mcpServers || {};
  }
  const text = JSON.stringify({ ...doc, mcpServers: { ...doc.mcpServers, [MCP_KEY]: entry } }, null, 2) + '\n';
  return { text, changed: text !== current, servers: Object.keys({ ...doc.mcpServers, [MCP_KEY]: entry }) };
}

/**
 * The two configs that are not ours to write: Codex reads MCP servers from the user-level
 * `~/.codex/config.toml`, and VS Code from `.vscode/mcp.json` (a workspace file an editor owns).
 * So they are printed, not generated.
 * @returns {[{ file: string, note: string, text: string }]}
 */
export function mcpSnippets(launch = mcpLaunch()) {
  const vars = {
    args: JSON.stringify(launch.args),
    tomlCommand: tomlInner(launch.command),
    jsonCommand: JSON.stringify(launch.command).slice(1, -1),
  };
  return [
    { file: '~/.codex/config.toml', note: 'Codex reads MCP servers from the user config, not the repo', text: fill(template('codex.toml'), vars).trimEnd() },
    { file: '.vscode/mcp.json', note: 'VS Code / Copilot', text: fill(template('vscode.json'), vars).trimEnd() },
  ];
}

/**
 * Write `.mcp.json` (merging, never clobbering) and return what to tell the user.
 * @returns {{ file: string, changed: boolean, servers: string[], entry: object, snippets: object[] }}
 */
export function installMcp(root, launch = mcpLaunch()) {
  const file = path.join(root, MCP_FILE);
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
  const entry = mcpEntry(launch);
  const merged = mergeMcpJson(current, entry);
  if (merged.changed) fs.writeFileSync(file, merged.text);
  return { file: MCP_FILE, changed: merged.changed, servers: merged.servers, entry, snippets: mcpSnippets(launch) };
}
