// `hkb init --harness copilot|codex`: the files each harness gets generated, the launch templates
// that use them, and the stop-hook payload every harness feeds to `hkb hook stop`. Plus the two
// hooks the default harness gets in `.claude/settings.json`, and what init says it wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { harnessFiles, installHarness, installClaudeHooks, hookSummary, CLAUDE_HOOKS, resolveProfiles, HARNESSES, HARNESS_PROFILE, packageSkillDir } from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES, ensureWorktree } from '../src/board.js';
import { expandLaunch, spawnWorker, tick } from '../src/dispatch.js';
import { checkHarnesses } from '../src/doctor.js';
import { stripFrontmatter, worktreePath } from '../src/model.js';
import { FakeGh, kbIssue } from './fake-gh.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const AGENT = path.join('.github', 'agents', 'kanban-worker.agent.md');
const HOOKS = path.join('.github', 'hooks', 'kanban.json');
const CODEX_HOOKS = path.join('.codex', 'hooks.json');
const CODEX_NOTES = path.join('.codex', 'README.md');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-harness-'));
const fileMap = (name, opts) => Object.fromEntries(harnessFiles(name, opts).map((f) => [f.rel, f.contents]));

test('harnessFiles(copilot) produces exactly the agent and the hook config', () => {
  assert.deepEqual(harnessFiles('copilot').map((f) => f.rel), [AGENT, HOOKS]);
});

test('the generated agent carries the SKILL.md protocol verbatim — one source of truth', () => {
  const agent = fileMap('copilot')[AGENT];
  const body = stripFrontmatter(fs.readFileSync(path.join(packageSkillDir(), 'SKILL.md'), 'utf8')).trimEnd();
  // the only edit is the relative link, which does not resolve from .github/agents/
  const spliced = body.replace(/`references\/protocol\.md`/g, '`.agents/skills/kanban/references/protocol.md`');
  assert.ok(agent.includes(spliced), 'the whole SKILL.md body must be spliced in');
  assert.ok(!agent.includes('{{protocol}}'), 'placeholder left unsubstituted');
  assert.ok(!/`references\/protocol\.md`/.test(agent), 'skill-relative link left pointing nowhere');
  assert.ok(agent.includes('hkb complete $KB_TASK'), 'the terminal verb must survive the splice');
});

test('the generated agent has the front matter Copilot selects it by', () => {
  const agent = fileMap('copilot')[AGENT];
  assert.match(agent, /^---\n/);
  assert.match(agent, /^name: kanban-worker$/m);
  assert.match(agent, /^description: .{20,}/m);
  // the copilot-cli profile asks for this agent by name; the two must not drift apart
  assert.ok(DEFAULT_PROFILES['copilot-cli'].launch.includes('kanban-worker'));
});

test('the generated hook config fires hkb on agentStop', () => {
  const hooks = JSON.parse(fileMap('copilot')[HOOKS]);
  const groups = hooks.hooks.agentStop;
  assert.ok(Array.isArray(groups) && groups.length === 1);
  const [entry] = groups[0].hooks;
  assert.equal(entry.type, 'command');
  assert.equal(entry.command, 'hkb hook stop');
  assert.equal(entry.timeout, 30);
  assert.deepEqual(Object.keys(hooks.hooks), ['agentStop'], 'no other event should be claimed');
});

test('the hook command is substituted, so a repo without hkb on PATH still gets a working hook', () => {
  const hooks = JSON.parse(fileMap('copilot', { command: 'node "/opt/hkb/bin/hkb.js" hook stop' })[HOOKS]);
  assert.equal(hooks.hooks.agentStop[0].hooks[0].command, 'node "/opt/hkb/bin/hkb.js" hook stop');
});

test('an unknown harness names the ones that exist', () => {
  assert.throws(() => harnessFiles('emacs'), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /unknown harness "emacs"\. Known: copilot/);
    return true;
  });
});

test('installHarness writes the files, then reports nothing to do', () => {
  const root = scratch();
  assert.deepEqual(installHarness(root, 'copilot'), [AGENT, HOOKS]);
  assert.ok(fs.existsSync(path.join(root, AGENT)));
  assert.ok(fs.existsSync(path.join(root, HOOKS)));
  assert.deepEqual(installHarness(root, 'copilot'), [], 'idempotent: a second init rewrites nothing');
});

test('installHarness restores a file that drifted, and only that file', () => {
  const root = scratch();
  installHarness(root, 'copilot');
  const hooksBefore = fs.readFileSync(path.join(root, HOOKS), 'utf8');
  fs.writeFileSync(path.join(root, AGENT), 'someone edited the generated agent\n');
  assert.deepEqual(installHarness(root, 'copilot'), [AGENT]);
  assert.ok(fs.readFileSync(path.join(root, AGENT), 'utf8').includes('name: kanban-worker'));
  assert.equal(fs.readFileSync(path.join(root, HOOKS), 'utf8'), hooksBefore);
});

test('`hkb init --harness copilot` sets up for Copilot instead of the claude default', () => {
  const { flags } = parseArgs(['init', '--harness', 'copilot']);
  assert.equal(flags.harness, 'copilot');
  assert.deepEqual(resolveProfiles(flags), { harnesses: ['copilot'], profiles: ['copilot-cli'] });
});

test('naming --profiles keeps them, and the harness still brings its own', () => {
  assert.deepEqual(resolveProfiles({ profiles: 'claude, claude-p', harness: 'copilot' }).profiles, ['claude', 'claude-p', 'copilot-cli']);
  assert.deepEqual(resolveProfiles({ profiles: 'copilot-cli', harness: 'copilot' }).profiles, ['copilot-cli'], 'no duplicate');
  assert.deepEqual(resolveProfiles({}), { harnesses: [], profiles: ['claude'] }, 'no --harness: nothing changes');
  assert.deepEqual(resolveProfiles({ profiles: 'codex' }).profiles, ['codex'], 'a profile with no built-in is still the user\'s call');
});

test('init refuses a harness it cannot generate for, before touching the repo', () => {
  assert.throws(() => resolveProfiles({ harness: 'copilot,emacs' }), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /unknown harness "emacs"\. Known: copilot/);
    return true;
  });
});

test('every harness brings a profile that exists as a built-in', () => {
  for (const h of HARNESSES) assert.ok(DEFAULT_PROFILES[HARNESS_PROFILE[h]], `${h} → ${HARNESS_PROFILE[h]}`);
});

test('the copilot-cli profile runs in a dispatcher-made worktree and allow-lists per command', () => {
  const p = DEFAULT_PROFILES['copilot-cli'];
  assert.equal(p.workspace, 'worktree', 'Copilot CLI has no --worktree flag; the dispatcher makes one');
  assert.equal(p.mode, 'process');
  assert.ok(!p.launch.some((el) => /\{n\}|\{k\}/.test(el)), 'the worktree is the cwd, not an argument');

  const argv = expandLaunch(p.launch, { prompt: 'do the thing', model: 'gpt-5' }, p);
  assert.deepEqual(argv.slice(0, 5), ['copilot', '-p', 'do the thing', '--agent', 'kanban-worker']);
  // one --allow-tool per pattern, and the shell(...) spelling Copilot uses
  const allowed = argv.filter((_, i) => argv[i - 1] === '--allow-tool');
  assert.deepEqual(allowed, p.allowed_tools);
  assert.ok(allowed.includes('shell(hkb:*)') && allowed.includes('shell(git:*)') && allowed.includes('shell(gh:*)'));
  assert.ok(!allowed.some((a) => /shell\([^)]* \*\)/.test(a))); // no space-star spellings
  assert.ok(allowed.includes('--no-ask-user') === false); // flag lives in launch, not the tool list
  assert.ok(allowed.includes('write'));
  const denied = argv.filter((_, i) => argv[i - 1] === '--deny-tool');
  assert.ok(denied.some((d) => /git push --force/.test(d)), 'force-push must be denied at launch');
  assert.deepEqual(argv.slice(-2), ['--model', 'gpt-5']);
});

test('expandLaunch leaves --model out when no model is set, in both flag styles', () => {
  const profile = { allowed_tools: ['shell(a)', 'shell(b)'] };
  assert.deepEqual(
    expandLaunch(['x', '--allow-tool={allowed_tools}', '{model_args}'], {}, profile),
    ['x', '--allow-tool', 'shell(a)', '--allow-tool', 'shell(b)'],
  );
  assert.deepEqual(
    expandLaunch(['x', '--allowedTools', '{allowed_tools}'], {}, profile),
    ['x', '--allowedTools', 'shell(a)', 'shell(b)'],
  );
});

// ---------- the worktree the dispatcher makes for a harness that has no flag for it ----------

function gitRepo() {
  const root = fs.realpathSync(scratch()); // macOS /var → /private/var; git reports the real path
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  return root;
}

test('ensureWorktree makes .claude/worktrees/<name> on its own branch, and reuses it', () => {
  const root = gitRepo();
  const dir = ensureWorktree(root, 'kb-7-1');
  assert.equal(dir, path.join(root, worktreePath('kb-7-1')));
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  const head = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
  assert.equal(head.stdout.trim(), 'kb-7-1');
  assert.equal(ensureWorktree(root, 'kb-7-1'), dir, 'a second call must not fail on the existing worktree');
});

test('ensureWorktree checks out a branch an earlier attempt left behind', () => {
  const root = gitRepo();
  const dir = ensureWorktree(root, 'kb-8-1');
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root }); // branch kb-8-1 survives
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'kb-8-1'], { cwd: root }).status, 0);
  assert.equal(ensureWorktree(root, 'kb-8-1'), dir);
  assert.ok(fs.existsSync(path.join(dir, '.git')));
});

test('ensureWorktree says what failed when git refuses', () => {
  const root = scratch(); // not a git repository
  assert.throws(() => ensureWorktree(root, 'kb-9-1'), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /git worktree add \.claude\/worktrees\/kb-9-1 failed: /);
    return true;
  });
});

test('the tick runs a workspace:worktree profile in the worktree it just created', async (t) => {
  const gh = new FakeGh();
  const root = gitRepo();
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    // the copilot-cli shape, with `true` in place of the real binary
    profiles: { 'copilot-cli': { mode: 'process', workspace: 'worktree', max_in_progress: 1, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'copilot-cli' }));

  const s = await tick(ctx, {});

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  assert.equal(s.claimed[0].wt, 'kb-7-1');
  assert.ok(fs.existsSync(path.join(root, worktreePath('kb-7-1'), '.git')), 'the worker got a checkout of its own');
  const [attempt] = gh.runOf(7).attempts;
  assert.equal(attempt.wt, 'kb-7-1', 'the attempt row records the worktree, for gc and post-mortems');
  assert.equal(attempt.bg, undefined);
});

test('this repo ships the copilot templates the generator reads', () => {
  for (const f of ['kanban-worker.agent.md', 'hooks.json']) {
    assert.ok(fs.existsSync(path.join(REPO, 'templates', 'copilot', f)), `templates/copilot/${f}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('templates'), 'templates/ must be published or --harness breaks on npm installs');
});

// ---------- codex ----------

test('harnessFiles(codex) produces the Stop hook and the notes, and no agent file', () => {
  assert.deepEqual(harnessFiles('codex').map((f) => f.rel), [CODEX_HOOKS, CODEX_NOTES]);
});

test('the generated codex hook config fires hkb on Stop', () => {
  const hooks = JSON.parse(fileMap('codex')[CODEX_HOOKS]);
  assert.deepEqual(Object.keys(hooks.hooks), ['Stop'], 'no other event should be claimed');
  const [entry] = hooks.hooks.Stop[0].hooks;
  assert.deepEqual(entry, { type: 'command', command: 'hkb hook stop', timeout: 30 });
});

test('every harness substitutes the hook command, so a repo without hkb on PATH still works', () => {
  const command = 'node "/opt/hkb/bin/hkb.js" hook stop';
  for (const h of HARNESSES) {
    const json = harnessFiles(h, { command }).find((f) => f.rel.endsWith('.json'));
    const commands = Object.values(JSON.parse(json.contents).hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((e) => e.command)));
    assert.deepEqual(commands, [command], `${h}: one hook, running exactly the command init was given, quotes intact`);
  }
});

test('the codex notes name this repo by absolute path, TOML-escaped', () => {
  const notes = fileMap('codex', { root: 'C:\\Users\\me\\repo' })[CODEX_NOTES];
  assert.match(notes, /^\[projects\."C:\\\\Users\\\\me\\\\repo"\]$/m, 'a Windows path must not smuggle escapes into the TOML');
  assert.match(notes, /^trust_level = "trusted"$/m);
  assert.ok(!notes.includes('{{'), 'placeholder left unsubstituted');
});

test('the codex notes carry the one-time trust steps and no MCP server', () => {
  const notes = fileMap('codex')[CODEX_NOTES];
  assert.match(notes, /`\/hooks`/, 'the TUI route to trusting the project hooks');
  assert.match(notes, /trust_level = "trusted"/, 'the config route');
  assert.match(notes, /network_access = true/, 'without it a worker cannot push, open a PR or heartbeat');
  assert.match(notes, /writable_roots = \[/, 'a worktree commits into the main repo, outside the sandbox');
  assert.ok(!/^\[mcp_servers/m.test(notes), 'hkb workers call the CLI directly — there is no MCP table to generate');
});

test('installHarness(codex) writes both files, then reports nothing to do', () => {
  const root = scratch();
  assert.deepEqual(installHarness(root, 'codex'), [CODEX_HOOKS, CODEX_NOTES]);
  assert.deepEqual(installHarness(root, 'codex'), [], 'idempotent: a second init rewrites nothing');
  const notes = fs.readFileSync(path.join(root, CODEX_NOTES), 'utf8');
  assert.ok(notes.includes(`[projects."${root}"]`), 'installHarness passes the real repo root, not the placeholder');
});

test('`hkb init --harness codex` sets up for Codex instead of the claude default', () => {
  const { flags } = parseArgs(['init', '--harness', 'codex']);
  assert.deepEqual(resolveProfiles(flags), { harnesses: ['codex'], profiles: ['codex'] });
  assert.deepEqual(resolveProfiles({ harness: 'copilot,codex' }).profiles, ['copilot-cli', 'codex']);
});

test('the codex profile runs `codex exec` in a dispatcher-made worktree, sandboxed to it', () => {
  const p = DEFAULT_PROFILES.codex;
  assert.equal(p.workspace, 'worktree', 'Codex has no worktree flag; the dispatcher makes one');
  assert.equal(p.mode, 'process');
  const argv = expandLaunch(p.launch, { worktree: '/w/kb-4-2', prompt: 'do the thing', model: 'gpt-5-codex' }, p);
  assert.deepEqual(argv, [
    'codex', 'exec', '-C', '/w/kb-4-2',
    '--sandbox', 'workspace-write',
    '--output-schema', '.agents/skills/kanban/schema/terminal.json',
    '--model', 'gpt-5-codex', 'do the thing',
  ]);
  assert.deepEqual(expandLaunch(p.launch, { worktree: '/w', prompt: 'p' }, p).slice(-1), ['p'], 'no model: the prompt stays last');
});

test('the schema the codex launch names is committed, where a worktree will find it', () => {
  const i = DEFAULT_PROFILES.codex.launch.indexOf('--output-schema');
  const schema = DEFAULT_PROFILES.codex.launch[i + 1];
  assert.ok(fs.existsSync(path.join(REPO, schema)), `${schema} must exist — codex exec refuses to start without it`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(REPO, schema), 'utf8')).required, ['task', 'verb', 'summary']);
  // in this repo .agents/skills/kanban is a committed symlink to skills/kanban; elsewhere init
  // copies the skill in. Either way the path has to come with the checkout the worker gets.
  const tracked = spawnSync('git', ['ls-files', '.agents/skills/kanban'], { cwd: REPO, encoding: 'utf8' });
  assert.ok(tracked.stdout.trim(), 'the skill has to be committed, or the worker\'s worktree will not have it');
});

test('doctor reports a configured harness only, and names the init that fixes it', () => {
  const root = scratch();
  const rows = [];
  const sink = { ok: (name, detail) => rows.push({ name, ok: true, detail }), warn: (name, detail, fix) => rows.push({ name, ok: null, detail, fix }) };
  const ctx = { root, cfg: { profiles: { claude: {} } } };
  checkHarnesses(ctx, sink);
  assert.deepEqual(rows, [], 'no harness profile, nothing to say');

  ctx.cfg.profiles.codex = DEFAULT_PROFILES.codex;
  checkHarnesses(ctx, sink);
  assert.equal(rows[0].ok, null);
  assert.match(rows[0].detail, /missing \.codex[/\\]hooks\.json, \.codex[/\\]README\.md/);
  assert.equal(rows[0].fix, 'hkb init --harness codex');

  installHarness(root, 'codex');
  rows.length = 0;
  checkHarnesses(ctx, sink);
  assert.equal(rows[0].ok, true, 'generated → clean');
  assert.match(rows[0].detail, /one-time trust/);
});

test('the dispatcher hands codex the worktree it is about to create, as an absolute path', async (t) => {
  const gh = new FakeGh();
  const root = fs.realpathSync(scratch());
  const ctx = {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, profiles: { codex: DEFAULT_PROFILES.codex } },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 12, status: 'ready', agent: 'codex' }));
  const { fetchBoard } = await import('../src/tasks.js');
  const [task] = await fetchBoard(ctx);

  const { argv } = await spawnWorker(ctx, task, 'codex', 3, { dryRun: true });

  assert.equal(argv[argv.indexOf('-C') + 1], path.join(root, worktreePath('kb-12-3')));
  assert.ok(argv[argv.length - 1].includes('#12'), 'the last argument is the task context');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'worktrees')), 'a dry run creates nothing');
});

test('this repo ships the codex templates the generator reads', () => {
  for (const f of ['hooks.json', 'notes.md']) {
    assert.ok(fs.existsSync(path.join(REPO, 'templates', 'codex', f)), `templates/codex/${f}`);
  }
});

// ---------- claude, the default harness: the hooks init writes into .claude/settings.json ----------
// Unlike the generated harness files, these go into a file the operator shares with every other
// session in the repo. So: touch nothing else, and name everything written.

const SETTINGS = path.join('.claude', 'settings.json');
const readSettings = (root) => JSON.parse(fs.readFileSync(path.join(root, SETTINGS), 'utf8'));
const commandsOf = (groups) => groups.flatMap((g) => g.hooks.map((h) => h.command));

test('installClaudeHooks writes both hooks, and reports both as added', () => {
  const root = scratch();
  assert.deepEqual(installClaudeHooks(root, () => {}), ['Stop', 'PreToolUse']);
  const s = readSettings(root);
  assert.deepEqual(Object.keys(s.hooks), ['Stop', 'PreToolUse'], 'no other event should be claimed');
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.equal(s.hooks[event].length, 1);
    const [group] = s.hooks[event];
    assert.equal(group.matcher, '*');
    assert.deepEqual(group.hooks.map((h) => h.type), ['command']);
    assert.equal(group.hooks[0].timeout, 30);
    assert.match(group.hooks[0].command, new RegExp(`hkb.* hook ${verb}$`), `${event} must run \`hkb hook ${verb}\``);
  }
  assert.deepEqual(installClaudeHooks(root, () => {}), [], 'idempotent: a second init adds nothing');
});

test('installClaudeHooks leaves the rest of settings.json alone', () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, SETTINGS), JSON.stringify({
    model: 'opus',
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'make lint' }] }] },
  }, null, 2));

  assert.deepEqual(installClaudeHooks(root, () => {}), ['Stop', 'PreToolUse']);

  const s = readSettings(root);
  assert.equal(s.model, 'opus', 'settings that are not ours must survive');
  assert.deepEqual(commandsOf(s.hooks.Stop).filter((c) => c === 'make lint'), ['make lint'], 'so must the operator\'s own hook');
  assert.equal(commandsOf(s.hooks.Stop).length, 2);
});

test('installClaudeHooks reports a settings.json it cannot parse rather than overwriting it', () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, SETTINGS), '{ not json');
  const said = [];

  assert.equal(installClaudeHooks(root, (s) => said.push(s)), null);

  assert.equal(fs.readFileSync(path.join(root, SETTINGS), 'utf8'), '{ not json', 'the file is the operator\'s, not ours to rewrite');
  assert.match(said.join('\n'), /not valid JSON/);
});

test('init names both hooks it wrote, and says what the second one is for', () => {
  const fresh = hookSummary(['Stop', 'PreToolUse']);
  assert.match(fresh, /^added Stop and PreToolUse hooks to \.claude\/settings\.json/);
  assert.match(hookSummary([]), /^Stop and PreToolUse hooks already present in \.claude\/settings\.json/);
  assert.match(hookSummary(['PreToolUse']), /^added PreToolUse hook to \.claude\/settings\.json; Stop hook already there/);
  for (const line of [fresh, hookSummary([]), hookSummary(['PreToolUse'])]) {
    for (const event of Object.keys(CLAUDE_HOOKS)) assert.ok(line.includes(event), `${event} goes unnamed in: ${line}`);
    assert.match(line, /inert unless KB_TASK is set/, 'an operator reading this has to know both are no-ops in their own sessions');
    assert.match(line, /PreToolUse is the worker permission policy/, 'and what the second one is');
  }
});

test('`hkb help` lists every hook verb the CLI routes', () => {
  const help = spawnSync(process.execPath, [path.join(REPO, 'bin', 'hkb.js'), 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hook stop\|pretool/);
});
