// `hkb mcp`: the hand-rolled JSON-RPC, the tool schemas, and the promise that a tool is the CLI verb
// and not a copy of it — `kanban_show` is asserted byte-for-byte against `hkb show --json`.
// No `gh` and no network: the in-memory GitHub is the transport, stdin/stdout are plain objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  TOOLS, toolList, toolSpec, callTool, handleMessage, serveStdio, validateArgs, resolveTask,
  negotiateProtocol, PROTOCOL_VERSION, PROTOCOL_VERSIONS, RPC, INSTRUCTIONS,
  mcpEntry, mcpLaunch, mcpSnippets, mergeMcpJson, installMcp, MCP_FILE, MCP_KEY,
} from '../src/mcp.js';
import { main } from '../src/cli.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { FakeGh } from './fake-gh.js';
import { FakeStore, kbIssue, runWith } from './fake-store.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-mcp-'));
const byName = (n) => TOOLS.find((t) => t.name === n);

/** A board with one running task, and a ctx pointing at it. */
function harness({ issues = [kbIssue({ number: 7, status: 'running', agent: 'claude', run: runWith([{ attempt: 1, started_at: '2026-08-26T01:00:00Z', lock_sha: 'a'.repeat(40) }]) })] } = {}) {
  const gh = new FakeGh();
  const store = new FakeStore();
  const root = scratch();
  for (const i of issues) store.addIssue(i);
  const cfg = { ...DEFAULT_BOARD, repo: gh.nameWithOwner };
  const ctx = {
    root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  const restoreStore = store.install(ctx);
  return { gh, store, ctx, root, cleanup: () => { restoreStore(); restore(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** Call a tool the way a client would, and hand back the parsed structuredContent. */
async function call(ctx, name, args, env = {}) {
  const r = await callTool(ctx, name, args, { KB_NO_OUTBOX: '1', ...env });
  return r;
}
const payload = (r) => {
  assert.equal(r.isError, undefined, `expected success, got: ${r.content[0].text}`);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, 'the text and the structured result must be the same object');
  return r.structuredContent;
};

// ---------- the tool table ----------

test('the server exposes exactly the nine verbs of the protocol', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), [
    'kanban_show', 'kanban_heartbeat', 'kanban_complete', 'kanban_block',
    'kanban_request_review', 'kanban_comment', 'kanban_create', 'kanban_link', 'kanban_unblock',
  ]);
});

test('every tool advertises a schema a client can validate against', () => {
  for (const spec of toolList()) {
    assert.match(spec.name, /^kanban_[a-z_]+$/);
    assert.ok(spec.description.length > 40, `${spec.name} needs a description an agent can act on`);
    assert.equal(spec.inputSchema.type, 'object');
    assert.equal(spec.inputSchema.additionalProperties, false, `${spec.name}: a typo must be refused, not ignored`);
    for (const [k, s] of Object.entries(spec.inputSchema.properties)) {
      assert.ok(s.type, `${spec.name}.${k} has no type`);
      assert.ok(s.description, `${spec.name}.${k} has no description`);
    }
    for (const k of spec.inputSchema.required || []) {
      assert.ok(spec.inputSchema.properties[k], `${spec.name} requires "${k}" but does not declare it`);
    }
  }
});

test('only kanban_show is advertised as read-only', () => {
  const read = toolList().filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
  assert.deepEqual(read, ['kanban_show']);
  assert.ok(toolList().every((t) => t.annotations.openWorldHint), 'every tool talks to GitHub');
});

test('the terminal verbs are the three the protocol allows, and they replay through the outbox', () => {
  assert.deepEqual(TOOLS.filter((t) => t.replay).map((t) => t.replay), ['complete', 'block', 'request-review']);
});

// ---------- arguments ----------

test('validateArgs coerces what a model actually sends', () => {
  assert.deepEqual(validateArgs(byName('kanban_show'), { task: '#7' }), { task: 7 });
  assert.deepEqual(validateArgs(byName('kanban_show'), {}), {});
  assert.deepEqual(validateArgs(byName('kanban_show'), { task: null }), {}, 'null means absent');
  assert.deepEqual(
    validateArgs(byName('kanban_complete'), { task: 7, summary: 'done', artifacts: 'a.md,b.md' }).artifacts,
    ['a.md', 'b.md'],
    'a comma string where a list belongs is taken, not refused',
  );
});

test('a wrong argument names the right one, and never reaches GitHub', () => {
  const bad = (tool, args, re) => assert.throws(() => validateArgs(byName(tool), args), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, re);
    return true;
  });
  bad('kanban_show', { issue: 7 }, /unknown argument issue — it takes task/);
  bad('kanban_complete', { task: 7 }, /"summary" is required — What changed/);
  bad('kanban_complete', { task: 7, summary: '  ' }, /must not be empty/);
  bad('kanban_block', { reason: 'x', kind: 'whatever' }, /"kind" must be one of dependency \| needs_input/);
  bad('kanban_show', { task: 'seven' }, /"task" must be an integer/);
  bad('kanban_complete', { task: 7, summary: 'ok', metadata: [] }, /"metadata" must be a JSON object/);
  bad('kanban_comment', { task: 7, text: 5 }, /"text" must be a string/);
});

test('the task defaults to KB_TASK, and says so when there is none', () => {
  assert.equal(resolveTask({ task: 12 }, {}), 12);
  assert.equal(resolveTask({}, { KB_TASK: '9' }), 9);
  assert.equal(resolveTask({ task: 12 }, { KB_TASK: '9' }), 12, 'an explicit task wins');
  assert.throws(() => resolveTask({}, {}), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /pass \{"task": <issue number>\}.*KB_TASK/s);
    return true;
  });
});

// ---------- JSON-RPC ----------

const rpc = (msg, session = {}, exec = async () => ({ content: [] })) => handleMessage(msg, session, exec);

test('initialize answers with a version, the tools capability and the protocol instructions', async () => {
  const session = {};
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'claude', version: '1' } } }, session);
  assert.equal(res.result.protocolVersion, '2025-03-26', 'a version we support is echoed back');
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.result.serverInfo.name, 'hkb');
  assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.equal(res.result.instructions, INSTRUCTIONS);
  assert.equal(session.client.name, 'claude');
  assert.match(INSTRUCTIONS, /LOCK_LOST/);
});

test('an unknown protocol version gets ours, never an error', () => {
  assert.equal(negotiateProtocol('2199-01-01'), PROTOCOL_VERSION);
  assert.equal(negotiateProtocol(undefined), PROTOCOL_VERSION);
  for (const v of PROTOCOL_VERSIONS) assert.equal(negotiateProtocol(v), v);
});

test('tools/list works before initialize, so a human can drive this by hand', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(res.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 2);
});

test('notifications are never answered; unknown methods are, with the list of what exists', async () => {
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  assert.equal(await rpc({ jsonrpc: '2.0', id: 3, result: {} }), null, 'a response to nothing we asked');
  const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(res.error.code, RPC.method);
  assert.match(res.error.message, /initialize, tools\/list, tools\/call and ping/);
});

test('ping answers empty, batches and non-objects are refused', async () => {
  assert.deepEqual((await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' })).result, {});
  assert.match((await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).error.message, /batches are not supported/);
  assert.equal((await rpc('nope')).error.code, RPC.request);
});

test('tools/call needs a name, and an unknown tool is a protocol error naming the real ones', async () => {
  const exec = (name) => callTool({ _cache: {} }, name, {}, {});
  assert.match((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} }, {}, exec)).error.message, /"name" is required/);
  const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'kanban_nope' } }, {}, exec);
  assert.equal(res.error.code, RPC.params);
  assert.match(res.error.message, /unknown tool "kanban_nope" — this server has kanban_show/);
});

// ---------- the stdio transport ----------

/** Feed `lines` to the server and collect the frames it writes back. */
async function pipe(ctx, chunks, env = {}) {
  const written = [];
  const output = { write: (s) => { written.push(s); return true; } };
  const input = Readable.from(chunks);
  await serveStdio(ctx, { input, output, env: { KB_NO_OUTBOX: '1', ...env } });
  assert.ok(written.every((s) => s.endsWith('\n')), 'every frame must be newline-delimited');
  return written.map((s) => JSON.parse(s));
}

test('a handshake and a tools/list over one chunk of stdin answer in order, and nothing else', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  const frames = await pipe(h.ctx, [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n',
  ]);

  assert.deepEqual(frames.map((f) => f.id), [1, 2], 'the notification is not answered');
  assert.equal(frames[1].result.tools.length, TOOLS.length);
  assert.deepEqual(h.store.calls, [], 'the handshake must not touch the board');
  assert.deepEqual(h.gh.requests, [], 'nor the forge');
});

test('a half-line is held until its newline arrives; junk gets a parse error and the stream survives', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  const frames = await pipe(h.ctx, ['{"jsonrpc":"2.0","id":1,"met', 'hod":"ping"}\n', 'not json\n', '{"jsonrpc":"2.0","id":2,"method":"ping"}\n']);

  assert.deepEqual(frames.map((f) => f.id), [1, null, 2]);
  assert.equal(frames[1].error.code, RPC.parse);
});

// ---------- the tools, against the in-memory board ----------

test('kanban_show returns exactly what `hkb show --json` prints', async (t) => {
  const h = harness();
  const cwd = process.cwd();
  fs.mkdirSync(path.join(h.root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(h.root, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: h.gh.nameWithOwner }));
  process.chdir(h.root);
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  t.after(() => { process.stdout.write = write; process.chdir(cwd); h.cleanup(); });

  const viaMcp = payload(await call(h.ctx, 'kanban_show', {}, { KB_TASK: '7' }));
  await main(['show', '7', '--json']);

  assert.deepEqual(viaMcp, JSON.parse(printed), 'one code path, or this drifts the first time show changes');
  assert.equal(viaMcp.number, 7);
  assert.equal(viaMcp.status, 'running');
  assert.equal(viaMcp.run.attempts.length, 1);
});

test('kanban_complete closes the attempt, exactly as the CLI verb does', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  const r = payload(await call(h.ctx, 'kanban_complete', { summary: 'wired the MCP server', metadata: { changed_files: ['src/mcp.js'] }, no_pr: 'no PR needed for this test' }, { KB_TASK: '7', KB_ATTEMPT: '1' }));

  assert.deepEqual({ number: r.number, attempt: r.attempt, status: r.status }, { number: 7, attempt: 1, status: 'done' });
  assert.equal(h.store.statusOf(7), 'done');
  assert.equal(h.store.runOf(7).attempts[0].outcome, 'completed');
  const result = h.store.issues.get(7).comments.find((c) => c.body.startsWith('<!-- kb-result -->'));
  assert.match(result.body, /wired the MCP server/);
  assert.match(result.body, /src\/mcp\.js/);
});

test('a verb that refuses comes back as content the model can read, not a protocol error', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  const r = await call(h.ctx, 'kanban_block', { task: 7, reason: 'need the API token' , kind: 'needs_input' });
  assert.equal(payload(r).status, 'blocked');

  const quiet = h.store.calls.length;
  const missing = await call(h.ctx, 'kanban_complete', { task: 7 });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /"summary" is required/);
  assert.equal(h.store.calls.length, quiet, 'a bad call is refused before it reaches the board at all');

  const nowhere = await call(h.ctx, 'kanban_show', {});
  assert.equal(nowhere.isError, true);
  assert.match(nowhere.content[0].text, /which task\?/);

  const gone = await call(h.ctx, 'kanban_show', { task: 999 });
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /hkb kanban_show failed \(exit 2\): issue #999 not found/);
});

test('kanban_create, kanban_link and kanban_unblock drive the board the way the CLI does', async (t) => {
  const h = harness({ issues: [kbIssue({ number: 3, status: 'ready', agent: 'claude' })] });
  t.after(h.cleanup);

  const made = payload(await call(h.ctx, 'kanban_create', { title: 'ship it', body: 'the spec', blocked_by: [3], paths: ['src/mcp.js'], priority: 2 }));
  assert.equal(made.status, 'todo', 'an open blocker means todo');
  assert.deepEqual(made.blocked_by, [3]);
  assert.equal(h.store.statusOf(made.number), 'todo');
  assert.match(h.store.issues.get(made.number).body, /"paths":\["src\/mcp\.js"\]/);
  assert.match(h.store.issues.get(made.number).body, /"priority":2/);

  const alone = payload(await call(h.ctx, 'kanban_create', { title: 'no blockers' }));
  assert.equal(alone.status, 'ready');

  assert.equal(payload(await call(h.ctx, 'kanban_link', { parent: 3, child: alone.number })).status, 'todo');
  assert.equal(h.store.issues.get(alone.number).blockedBy.length, 1);

  await call(h.ctx, 'kanban_block', { task: alone.number, reason: 'waiting', kind: 'needs_input' });
  assert.equal(payload(await call(h.ctx, 'kanban_unblock', { task: alone.number })).status, 'todo');
  assert.ok(!h.store.labelsOf(alone.number).includes('kb:needs-human'), 'unblock clears needs-human');
});

test('kanban_comment adds a comment and answers with its url', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  const r = payload(await call(h.ctx, 'kanban_comment', { task: 7, text: 'halfway through' }));

  assert.equal(r.number, 7);
  assert.match(r.url, /issuecomment-/);
  assert.ok(h.store.issues.get(7).comments.some((c) => c.body === 'halfway through'));
});

test('a call clears the per-command cache, so a long-lived server never answers from a stale read', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  await call(h.ctx, 'kanban_show', { task: 7 });
  h.store.addComment(7, 'someone commented while the server was up');
  const seen = payload(await call(h.ctx, 'kanban_comment', { task: 7, text: 'x' }));

  assert.ok(seen.url);
  assert.equal(h.ctx._cache['comments:7'], undefined);
});

// ---------- `hkb init --mcp` ----------

test('the entry written for .mcp.json is the one the docs promise', () => {
  assert.deepEqual(mcpEntry({ command: 'hkb', args: ['mcp'] }), { type: 'stdio', command: 'hkb', args: ['mcp'] });
  const { text } = mergeMcpJson(null, mcpEntry({ command: 'hkb', args: ['mcp'] }));
  assert.deepEqual(JSON.parse(text), { mcpServers: { kanban: { type: 'stdio', command: 'hkb', args: ['mcp'] } } });
});

test('merging into .mcp.json leaves every other server exactly as it was', () => {
  const current = JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: true }, null, 2) + '\n';
  const { text, changed, servers } = mergeMcpJson(current, mcpEntry({ command: 'hkb', args: ['mcp'] }));
  const doc = JSON.parse(text);
  assert.deepEqual(doc.mcpServers.other, { command: 'x' });
  assert.equal(doc.extra, true);
  assert.deepEqual(servers, ['other', 'kanban']);
  assert.equal(changed, true);
  assert.equal(mergeMcpJson(text, mcpEntry({ command: 'hkb', args: ['mcp'] })).changed, false, 'a second init rewrites nothing');
});

test('a .mcp.json we cannot safely rewrite stops with the fix, and is not clobbered', () => {
  for (const [bad, re] of [['{oops', /not valid JSON/], ['[]', /must contain a JSON object/], ['{"mcpServers": 4}', /"mcpServers" must be a JSON object/]]) {
    assert.throws(() => mergeMcpJson(bad, mcpEntry()), (e) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, re);
      return true;
    });
  }
});

test('installMcp writes the file, and says what changed', () => {
  const root = scratch();
  const launch = { command: 'hkb', args: ['mcp'] };
  const first = installMcp(root, launch);
  assert.equal(first.changed, true);
  assert.equal(first.file, MCP_FILE);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, MCP_FILE), 'utf8')).mcpServers[MCP_KEY], launch && { type: 'stdio', ...launch });
  assert.equal(installMcp(root, launch).changed, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the printed VS Code snippet carries the same launch as .mcp.json, escaped for its format', () => {
  const launch = { command: 'C:\\node\\node.exe', args: ['C:\\hkb\\bin\\hkb.js', 'mcp'] };
  const [, vscode] = mcpSnippets(launch, { onPath: true }); // onPath: true keeps codex's own launch out of the way
  assert.equal(vscode.file, '.vscode/mcp.json');
  const doc = JSON.parse(vscode.text);
  assert.deepEqual(doc.servers.kanban, { type: 'stdio', ...launch });
});

test('the printed Codex snippet is always absolute, never the project-relative form .mcp.json gets', () => {
  const launch = { command: 'node', args: ['node_modules/hkb-cli/bin/hkb.js', 'mcp'] };
  const [codex] = mcpSnippets(launch, { onPath: false, pkgRoot: REPO });
  assert.equal(codex.file, '~/.codex/config.toml');
  assert.match(codex.text, /^\[mcp_servers\.kanban\]$/m);
  const bin = path.join(REPO, 'bin', 'hkb.js');
  assert.match(codex.text, new RegExp(`^args = \\["${bin.replace(/\\/g, '\\\\\\\\')}","mcp"\\]$`, 'm'));
  assert.ok(!codex.text.includes('{{'), 'placeholder left unsubstituted');

  const [onPath] = mcpSnippets(launch, { onPath: true });
  assert.match(onPath.text, /^command = "hkb"$/m, 'hkb on PATH: the codex snippet trusts it too, even when .mcp.json names a repo-carried copy');
});

test('a backslash in the resolved path is escaped, not smuggled into the TOML', () => {
  const [codex] = mcpSnippets(mcpLaunch({ onPath: true }), { onPath: false, pkgRoot: 'C:\\hkb' });
  const argsLine = codex.text.split('\n').find((l) => l.startsWith('args'));
  assert.match(argsLine, /\\\\hkb/, 'a lone backslash would break the TOML basic string');
});

test('with hkb neither in the repo nor on PATH, .mcp.json still gets bare `hkb` — never an absolute, this-machine-only path', () => {
  const shared = mcpLaunch({ onPath: false });
  assert.deepEqual(shared, { command: 'hkb', args: ['mcp'] });
});

test('but the private Codex config, which nothing commits, is absolute on both halves in that case', () => {
  const private_ = mcpLaunch({ onPath: false, shared: false });
  assert.equal(private_.command, process.execPath);
  assert.equal(private_.args[0], path.join(REPO, 'bin', 'hkb.js'));
  assert.ok(fs.existsSync(private_.args[0]));
  assert.equal(private_.args[1], 'mcp');
});

test('this repo ships the mcp templates the generator reads', () => {
  for (const f of ['mcp.json', 'codex.toml', 'vscode.json']) {
    assert.ok(fs.existsSync(path.join(REPO, 'templates', 'mcp', f)), `templates/mcp/${f}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('templates'), 'templates/ must be published or --mcp breaks on npm installs');
});
