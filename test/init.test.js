// `hkb init` — the cold-start path, driven end to end against a temp git repo and the fake gh.
//
// A stranger's first command used to be the least-tested path in the project: the suite covered
// init's helpers one by one and nothing called `init()` itself, so all three bugs the first outside
// adoption found lived in the *composition* — which profiles a fresh board is seeded with (#72),
// which hooks get written versus reported (#73), what the shipped ignore list contains (#74). Each
// of those has a test below that fails if it is reintroduced.
//
// The transport is `test/fake-gh.js`, installed inside `src/gh.js`, so nothing here spawns `gh` or
// touches the network; `--repo owner/name` is what lets init skip `detectRepo`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init, ensureGitignore, GITIGNORE_LINES, CLAUDE_HOOKS, agentsSkillDir, packageSkillDir, readSkillVersion } from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { makeContext, DEFAULT_PROFILES } from '../src/board.js';
import { L, STATUSES } from '../src/model.js';
import { FakeGh } from './fake-gh.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-init-'));
const lines = (root) => fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');

// ---------- the .gitignore block, on its own ----------
// The list of ignored paths is the same lesson twice: once in this repo's own `.gitignore`, once in
// the one every adopter gets. `.kanban/dispatch.pid` was added here and never shipped, so an adopter
// who ran `hkb dispatch --loop` and then `git add -A` committed a pidfile carrying their host and
// pid. The subset test below is what keeps the two in step.

test('every path hkb writes locally is ignored — the pidfile included', () => {
  const root = scratch();
  assert.equal(ensureGitignore(root), true);
  const written = lines(root);
  for (const w of GITIGNORE_LINES) assert.ok(written.includes(w), `${w} missing from the generated .gitignore`);
  assert.ok(written.includes('.kanban/dispatch.pid'), 'the dispatcher pidfile must be ignored');
  assert.ok(!written.includes('.kanban/board.json'), 'board.json is tracked on purpose');
});

test('a repo that already has the lines is left untouched', () => {
  const root = scratch();
  ensureGitignore(root);
  const before = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.equal(ensureGitignore(root), false, 'nothing to add');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), before);
});

test('an existing .gitignore keeps its own lines and gains only what it lacks', () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.kanban/logs/\n');
  assert.equal(ensureGitignore(root), true);
  const written = lines(root);
  assert.ok(written.includes('node_modules/'), 'the repo\'s own entries survive');
  assert.equal(written.filter((l) => l === '.kanban/logs/').length, 1, 'no duplicate for a line already there');
  assert.ok(written.includes('.kanban/dispatch.pid'));
});

test('CRLF and indented entries still count as present', () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, '.gitignore'), GITIGNORE_LINES.join('\r\n') + '\r\n');
  assert.equal(ensureGitignore(root), false, 'a Windows checkout must not re-append the whole block');
});

test("this repo's .gitignore is a superset — a lesson learned here ships to adopters", () => {
  const own = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const w of GITIGNORE_LINES) {
    assert.ok(own.includes(w), `${w} is shipped by \`hkb init\` but not ignored in hkb's own repo`);
  }
  const drift = own.filter((l) => l.startsWith('.kanban/') && l !== '.kanban/board.json' && !GITIGNORE_LINES.includes(l));
  assert.deepEqual(drift, [], 'hkb ignores a .kanban/ path locally that `hkb init` does not ship');
});

// ---------- the whole command, driven ----------

const NWO = 'acme/board'; // what FakeGh answers for; init takes it from --repo, so detectRepo never runs
const BOARD_FILE = path.join('.kanban', 'board.json');
const SETTINGS = path.join('.claude', 'settings.json');
// what a re-run must leave byte-identical
const FOOTPRINT = [BOARD_FILE, SETTINGS, '.gitignore', 'CLAUDE.md', 'AGENTS.md', path.join('.agents', 'skills', 'kanban', 'SKILL.md')];

function gitRepo() {
  const root = fs.realpathSync(scratch()); // macOS /var → /private/var; git reports the real path
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q', '-b', 'main');
  return root;
}

/** Every file in `dir`, relative and sorted — for "the copy is the package, whole". */
const tree = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? tree(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]))
  .sort();

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const board = (root) => JSON.parse(read(root, BOARD_FILE));
const settings = (root) => JSON.parse(read(root, SETTINGS));
const snapshot = (root) => Object.fromEntries(FOOTPRINT.map((rel) => [rel, read(root, rel)]));
/** The names of the labels init actually created, in the order it asked for them. */
const created = (gh) => gh.callsMatching('POST', '/labels').map((c) => c.body.name);

/**
 * Run the real `init()` the way the CLI does — real arg parsing, real context, fake transport — in a
 * temp git repo. Returns the repo, the fake (so a test can look at what was sent) and the log lines.
 */
async function runInit(extra = [], { root = gitRepo(), gh = new FakeGh() } = {}) {
  const cwd = process.cwd();
  const restore = gh.install();
  const printed = [];
  process.chdir(root);
  try {
    const { flags } = parseArgs(['init', '--repo', NWO, ...extra]);
    const code = await init(makeContext(flags), flags, (s) => printed.push(s));
    return { root, gh, printed, code };
  } finally {
    process.chdir(cwd);
    restore();
  }
}

test('a fresh board is seeded with exactly the profiles asked for (#72)', async () => {
  const bare = await runInit();
  assert.equal(bare.code, 0);
  assert.deepEqual(Object.keys(board(bare.root).profiles), ['claude'], 'a bare init means claude, not all six built-ins');

  const narrowed = await runInit(['--profiles', 'claude-p']);
  assert.deepEqual(Object.keys(board(narrowed.root).profiles), ['claude-p'], '--profiles has to be able to narrow, not only widen');

  const two = await runInit(['--profiles', 'claude,claude-track']);
  assert.deepEqual(Object.keys(board(two.root).profiles), ['claude', 'claude-track']);
  assert.deepEqual(board(two.root).profiles.claude, DEFAULT_PROFILES.claude, 'a seeded profile is the built-in, verbatim');

  const harness = await runInit(['--harness', 'codex']);
  assert.deepEqual(Object.keys(board(harness.root).profiles), ['codex'], 'a harness brings its own profile and replaces the default');
  assert.ok(fs.existsSync(path.join(harness.root, '.codex', 'hooks.json')), 'and its generated files');
});

test('the label set that reaches GitHub is the board\'s, and nothing else is written (#72)', async () => {
  const { root, gh, printed } = await runInit();
  const want = [...STATUSES.map(L.status), L.board('default'), L.needsHuman, L.agent('claude')];

  assert.deepEqual(created(gh).sort(), [...want].sort());
  assert.equal(created(gh).length, 11, 'eight statuses + board + needs-human + one agent — the count is the regression');
  assert.deepEqual(created(gh).filter((l) => l.startsWith('kb:agent:')), ['kb:agent:claude'], 'no labels for harnesses this repo will never install');
  assert.ok(printed.some((l) => l.startsWith('created labels: ')));

  const stray = gh.calls.filter((c) => !/\/labels(\?|$)/.test(c.path || ''));
  assert.deepEqual(stray, [], 'init reads and writes labels; anything else is a call an adopter did not ask for');
  assert.equal(board(root).repo, NWO);
  assert.equal(board(root).board, 'default');
  assert.equal(board(root).default_branch, 'main');
});

test('both hooks land in .claude/settings.json, and init names both (#73)', async () => {
  const { root, printed } = await runInit();
  const hooks = settings(root).hooks;

  assert.deepEqual(Object.keys(hooks).sort(), Object.keys(CLAUDE_HOOKS).sort(), 'the file gets exactly the hooks init claims to write');
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    const entry = hooks[event][0];
    assert.equal(entry.matcher, '*');
    assert.match(entry.hooks[0].command, new RegExp(`hkb(\\.js")? hook ${verb}$`), `${event} must run \`hkb hook ${verb}\``);
    assert.equal(entry.hooks[0].timeout, 30);
  }
  const said = printed.find((l) => l.includes('.claude/settings.json'));
  assert.ok(said, 'init must say what it did to a settings file the operator shares with every session in the repo');
  for (const event of Object.keys(CLAUDE_HOOKS)) assert.ok(said.includes(event), `wrote the ${event} hook but did not name it: "${said}"`);
});

test('the shipped ignore list reaches the adopter, pidfile included (#74)', async () => {
  const { root } = await runInit();
  const written = lines(root).map((l) => l.trim());
  for (const w of GITIGNORE_LINES) assert.ok(written.includes(w), `${w} missing from the .gitignore \`hkb init\` wrote`);
  assert.ok(written.includes('.kanban/dispatch.pid'), 'a pidfile carrying host and pid must never be committable by accident');
  assert.ok(!written.includes('.kanban/board.json'), 'board.json is tracked on purpose');
});

test('the skill is copied out of the package, whole, and the harness link points at it', async () => {
  const { root, printed } = await runInit();
  const installed = agentsSkillDir(root);

  assert.ok(!fs.lstatSync(installed).isSymbolicLink(), 'an adopter gets a copy: a link would point into a package they may uninstall');
  assert.deepEqual(tree(installed), tree(packageSkillDir()), 'the whole packaged skill, file for file');
  assert.equal(read(installed, 'SKILL.md'), fs.readFileSync(path.join(packageSkillDir(), 'SKILL.md'), 'utf8'));
  const version = readSkillVersion(packageSkillDir());
  assert.ok(version, 'the packaged SKILL.md must carry metadata.version, or doctor cannot spot a stale copy');
  assert.equal(board(root).skill_version, version, 'board.json remembers which version was copied');
  assert.ok(printed.some((l) => l.includes(`.agents/skills/kanban v${version}`)));

  const claudeSkill = path.join(root, '.claude', 'skills', 'kanban');
  assert.ok(fs.existsSync(path.join(claudeSkill, 'SKILL.md')), '.claude/skills/kanban must resolve to the installed skill');
  if (fs.lstatSync(claudeSkill).isSymbolicLink()) {
    assert.equal(fs.readlinkSync(claudeSkill), path.join('..', '..', '.agents', 'skills', 'kanban'));
  }
});

test('the CLAUDE.md / AGENTS.md section is the packaged one, spliced between markers', async () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# their repo\n\ntheir own instructions\n');
  await runInit([], { root });

  const section = fs.readFileSync(path.join(REPO, 'templates', 'doc-section.md'), 'utf8').trim();
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    assert.ok(read(root, f).includes(`<!-- hkb:start -->\n${section}\n<!-- hkb:end -->`), `${f} must carry the packaged section verbatim`);
  }
  assert.match(read(root, 'CLAUDE.md'), /^# their repo\n\ntheir own instructions\n/, 'whatever was already there stays, above the block');
});

test('a second init changes nothing on disk and creates no labels', async () => {
  const first = await runInit();
  const before = snapshot(first.root);
  const posts = created(first.gh).length;

  const { printed } = await runInit([], first);

  assert.deepEqual(snapshot(first.root), before, 'a re-run must be a no-op: no duplicate section, no re-copied skill, no churn');
  assert.equal(created(first.gh).length, posts, 'the labels already exist — creating them again is a write nobody asked for');
  assert.ok(printed.includes('labels already present'));
  assert.equal(settings(first.root).hooks.Stop.length, 1, 'no duplicate hook entry');
  assert.equal(lines(first.root).filter((l) => l.trim() === '.kanban/dispatch.pid').length, 1, 'no duplicate ignore line');
  assert.equal(read(first.root, 'CLAUDE.md').match(/<!-- hkb:start -->/g).length, 1, 'no second section');
});

test('a re-run is additive: a profile added by hand survives and gets its label', async () => {
  const first = await runInit();
  const cfg = board(first.root);
  cfg.profiles.codex = { ...DEFAULT_PROFILES.codex, max_in_progress: 3 }; // the operator's own edit
  fs.writeFileSync(path.join(first.root, BOARD_FILE), JSON.stringify(cfg, null, 2) + '\n');

  await runInit(['--profiles', 'claude'], first);

  const after = board(first.root);
  assert.deepEqual(Object.keys(after.profiles), ['claude', 'codex'], 're-running init must never silently delete work');
  assert.equal(after.profiles.codex.max_in_progress, 3, "and never overwrite the operator's edit");
  assert.ok(created(first.gh).includes(L.agent('codex')), 'a profile on the board gets its kb:agent label');
});

test('--no-labels writes every local file and sends nothing', async () => {
  const { root, gh, printed } = await runInit(['--no-labels']);

  assert.deepEqual(gh.calls, [], 'the offline path must not reach the transport at all');
  for (const rel of FOOTPRINT) assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is local — --no-labels must still write it`);
  assert.ok(printed.some((l) => l.includes('--no-labels') && l.includes(NWO)), 'and say which labels it did not create, and where');
  assert.ok(printed.some((l) => l.includes('hkb init') && l.includes('without --no-labels')), 'and what to run to finish the job');
});

test('--no-labels says no to the flags that cannot be done offline, before writing anything', async () => {
  for (const flag of ['--import', '--project=new']) {
    const root = gitRepo();
    await assert.rejects(() => runInit(['--no-labels', flag], { root }), (e) => {
      assert.equal(e.exitCode, 2, 'a request that cannot be honoured is a usage error');
      assert.match(e.message, new RegExp(`--${flag.replace(/^--|=.*$/g, '')} needs the API`));
      assert.match(e.message, /Run `hkb init .*--no-labels` now/, 'and the message names both halves of the fix');
      return true;
    });
    assert.equal(fs.existsSync(path.join(root, BOARD_FILE)), false, 'nothing was written on the way out');
  }
});
