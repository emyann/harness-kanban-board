#!/usr/bin/env node
// Pack hkb the way npm will, install that tarball into an empty directory, and run the CLI from where
// it landed. `npm test` proves the source is correct; this proves the *tarball* is — that `files` in
// package.json still ships everything the CLI reads at runtime, and that `npx hkb-cli` works for someone
// who has none of this repository.
//
// It is the pre-publish half of the pair. The post-publish half lives in .github/workflows/release.yml,
// which does the same thing against the copy npm actually served. This one runs on every push, so a
// tarball regression is caught long before a tag exists.
//
//   node scripts/smoke-pack.mjs                  pack, install, verify, clean up
//   node scripts/smoke-pack.mjs --keep           leave the temp install behind, and print where
//   node scripts/smoke-pack.mjs --verify-only D  skip pack+install; verify the package root at D
//
// Zero dependencies, like everything else here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgName = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;

const REPO = fileURLToPath(new URL('..', import.meta.url));

// Every one of these is read at runtime from the installed package, so a `files` entry that goes
// missing must fail here rather than on a stranger's first `npx hkb-cli init`. The comment on each is the
// code that reads it.
const MUST_SHIP = [
  ['bin/hkb.js', 'the bin npm links as `hkb`'],
  ['src/cli.js', 'the CLI itself'],
  ['package.json', '`hkb version` reads its own version out of it'],
  ['skills/kanban/SKILL.md', '`hkb init` copies the skill from here (src/init.js packageSkillDir)'],
  ['skills/kanban/references/protocol.md', 'the skill links to it; a half-copied skill is worse than none'],
  ['skills/kanban/schema/terminal.json', 'the Codex profile names it in --output-schema'],
  ['templates/doc-section.md', 'the CLAUDE.md/AGENTS.md section `hkb init` splices in'],
  ['templates/actions/kanban-dispatch.yml', '`hkb init --with-actions`'],
  ['templates/copilot/kanban-worker.agent.md', '`hkb init --harness copilot`'],
  ['templates/codex/hooks.json', '`hkb init --harness codex`'],
  ['templates/mcp/mcp.json', '`hkb init --mcp`'],
  ['hooks/hooks.json', 'the Stop hook, referenced by .claude-plugin/plugin.json'],
  ['.claude-plugin/plugin.json', 'what makes the package installable as a Claude Code plugin'],
  ['web/index.html', '`hkb serve` reads it (src/serve.js PAGE_FILE)'],
  ['README.md', ''],
  ['LICENSE', ''],
];

// The other half of an allowlist working: if `files` were deleted altogether, npm would ship the whole
// repository and every check above would still pass.
const MUST_NOT_SHIP = ['test', 'docs', '.kanban', '.github', '.agents', 'CLAUDE.md', 'AGENTS.md'];

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const verifyOnly = argv.includes('--verify-only') ? argv[argv.indexOf('--verify-only') + 1] : null;
if (argv.includes('--verify-only') && !verifyOnly) die('--verify-only needs the path of an installed package root');

const failures = [];
const log = (msg) => process.stdout.write(`${msg}\n`);
const ok = (msg) => log(`  ok    ${msg}`);
const bad = (msg, fix) => { failures.push({ msg, fix }); log(`  FAIL  ${msg}`); };

function die(msg) {
  process.stderr.write(`smoke-pack: ${msg}\n`);
  process.exit(1);
}

/** Run a command, capturing everything. Never throws — the caller decides what a failure means. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input: '', ...opts });
  if (r.error) return { status: 1, out: String(r.error.message) };
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** `npm pack` into `dir`, returning the tarball path. */
function pack(dir) {
  log('packing');
  const r = run('npm', ['pack', '--pack-destination', dir, '--loglevel', 'error'], { cwd: REPO });
  if (r.status !== 0) die(`npm pack failed:\n${r.out}`);
  const tgz = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => path.join(dir, f));
  if (tgz.length !== 1) die(`expected exactly one tarball in ${dir}, found ${tgz.length}`);
  log(`  ${path.basename(tgz[0])} (${(fs.statSync(tgz[0]).size / 1024).toFixed(1)} kB)`);
  return tgz[0];
}

/** Install `tgz` into a fresh package in `dir`. Returns { root, bin } of the installed hkb. */
function install(tgz, dir) {
  log('installing the tarball into an empty directory');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hkb-smoke', version: '0.0.0', private: true }) + '\n');
  const r = run('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error', tgz], { cwd: dir });
  if (r.status !== 0) die(`npm install of the tarball failed:\n${r.out}`);
  const root = path.join(dir, 'node_modules', pkgName);
  if (!fs.existsSync(root)) die(`npm install reported success but ${root} does not exist`);
  return { root, bin: path.join(dir, 'node_modules', '.bin', 'hkb') };
}

/** What the tarball contains, checked against what the code reads. */
function checkContents(root) {
  log(`contents of ${root}`);
  for (const [rel, why] of MUST_SHIP) {
    if (fs.existsSync(path.join(root, rel))) ok(rel);
    else bad(`${rel} is missing${why ? ` — ${why}` : ''}`, `add its top-level directory to "files" in package.json, then re-run: node scripts/smoke-pack.mjs`);
  }
  for (const rel of MUST_NOT_SHIP) {
    if (!fs.existsSync(path.join(root, rel))) ok(`${rel} is not shipped`);
    else bad(`${rel} was shipped and should not be`, 'check that "files" in package.json is still an allowlist of the runtime set');
  }
}

/** The CLI, run from where npm put it — not from this checkout. */
function checkRuns(bin, root, cwd) {
  log(`running ${bin}`);
  // A clean env: KB_TASK in particular would make `hook stop` do real work against a real board.
  const env = { ...process.env };
  for (const k of ['KB_TASK', 'KB_ATTEMPT', 'KB_BOARD', 'KB_PROFILE', 'KB_ROOT']) delete env[k];
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

  const version = run(bin, ['version'], { cwd, env });
  if (version.status !== 0) bad(`\`hkb version\` exited ${version.status}: ${version.out}`, 'the installed package cannot start — check that bin/hkb.js and src/ both shipped');
  else if (version.out !== `hkb ${expected}`) bad(`\`hkb version\` printed "${version.out}", expected "hkb ${expected}"`, 'the bin and the package.json in the tarball disagree');
  else ok(`hkb version → ${version.out}`);

  const help = run(bin, ['help'], { cwd, env });
  if (help.status !== 0) bad(`\`hkb help\` exited ${help.status}: ${help.out}`, 'the CLI starts but cannot print its help');
  else if (!help.out.includes('dispatch')) bad('`hkb help` printed something that is not the help text', 'check src/cli.js HELP');
  else ok(`hkb help → ${help.out.split('\n').length} lines`);

  // The Stop hook is installed into other people's harnesses, so it must be inert — exit 0, no output
  // — in any session that is not a worker. A hook that errors here breaks every session it is in.
  const hook = run(bin, ['hook', 'stop'], { cwd, env, input: '' });
  if (hook.status !== 0) bad(`\`hkb hook stop\` with no KB_TASK exited ${hook.status}: ${hook.out}`, 'the Stop hook must be inert outside a worker — see src/hook.js');
  else ok('hkb hook stop (no KB_TASK) → exit 0');
}

// ---------- main ----------

let dir = null;
try {
  let root;
  let bin;
  // Whatever the mode, the CLI is run from a directory that is not this checkout — a pass that only
  // holds because the process happened to start in the repo would prove nothing.
  let cwd;
  if (verifyOnly) {
    root = path.resolve(verifyOnly);
    if (!fs.existsSync(path.join(root, 'package.json'))) die(`${root} is not a package root (no package.json)`);
    bin = path.join(root, 'bin', 'hkb.js');
    cwd = os.tmpdir();
    log(`verify-only: ${root}\n`);
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-smoke-'));
    const tgz = pack(dir);
    ({ root, bin } = install(tgz, dir));
    cwd = dir;
    log('');
  }

  checkContents(root);
  log('');
  checkRuns(bin, root, cwd);
  log('');

  if (failures.length) {
    process.stderr.write(`smoke-pack: ${failures.length} check${failures.length === 1 ? '' : 's'} failed\n`);
    for (const f of failures) process.stderr.write(`  - ${f.msg}\n    fix: ${f.fix}\n`);
    process.exit(1);
  }
  log(`smoke-pack: the packed artifact installs and runs. ${MUST_SHIP.length + MUST_NOT_SHIP.length} content checks, 3 command checks.`);
} finally {
  if (dir && !keep) fs.rmSync(dir, { recursive: true, force: true });
  else if (dir) log(`kept: ${dir}`);
}
