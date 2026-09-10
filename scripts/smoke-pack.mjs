#!/usr/bin/env node
// Pack hkb the way npm will, install that tarball into an empty directory, and run the CLI from
// where it landed. `npm test` proves the source is correct; this proves the *tarball* is — that
// `files` in package.json still ships everything the CLI reads at runtime, and that `npx hkb-cli`
// works for someone who has none of this repository.
//
// It is the pre-publish half of a pair. The post-publish half lives in .github/workflows/release.yml,
// which does the same thing against the copy npm actually served. This one runs on every push, so a
// tarball regression is caught long before a tag exists.
//
//   node scripts/smoke-pack.mjs                  pack, install, verify, clean up
//   node scripts/smoke-pack.mjs --keep           leave the temp install behind, and print where
//   node scripts/smoke-pack.mjs --verify-only D  skip pack+install; verify the package root at D

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgName = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
const REPO = fileURLToPath(new URL('..', import.meta.url));

// Every one of these is read at runtime from the installed package, so a `files` entry that goes
// missing must fail here rather than on a stranger's first `npx hkb-cli`. The comment on each is
// the code that reads it.
//
// What ships is `dist/` and `prisma/` — not `src/`. The published bin is the transpile, because
// **Node refuses to strip types under `node_modules`** (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING,
// on every version, by design), so the TypeScript would be dead weight in the tarball: nothing an
// installed hkb runs could ever resolve to it.
const MUST_SHIP = [
  ['dist/bin/hkb.js', 'the bin npm links as `hkb` — the prepack transpile, never the .ts'],
  ['dist/src/hkb.js', 'the verbs'],
  ['dist/src/daemon.js', '`hkb up`'],
  ['dist/src/schema.js', 'creates and migrates the board on first touch'],
  ['dist/src/generated/prisma/client.js', 'the generated Prisma client — committed as .ts and emitted here, because this tarball has no `prisma generate`'],
  ['prisma/schema.prisma', 'the schema the migrations were generated from'],
  ['prisma/migrations', 'READ AT RUNTIME: ensureSchema applies these SQL files to make ~/.hkb/board.db exist'],
  ['package.json', '`hkb version` reads its own version out of it'],
  ['README.md', ''],
  ['LICENSE', ''],
];

// The other half of an allowlist working: if `files` were deleted altogether, npm would ship the
// whole repository and every check above would still pass. `src` is here rather than in MUST_SHIP
// on purpose — see the note above.
const MUST_NOT_SHIP = ['src', 'test', 'docs', 'scripts', '.hkb', '.github', '.agents', 'CLAUDE.md', 'AGENTS.md'];

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
    else bad(`${rel} is missing${why ? ` — ${why}` : ''}`, 'add its top-level directory to "files" in package.json, then re-run: node scripts/smoke-pack.mjs');
  }
  for (const rel of MUST_NOT_SHIP) {
    if (!fs.existsSync(path.join(root, rel))) ok(`${rel} is not shipped`);
    else bad(`${rel} was shipped and should not be`, 'check that "files" in package.json is still an allowlist of the runtime set');
  }
}

/**
 * The CLI, run from where npm put it — not from this checkout.
 *
 * This is the check that would have caught the mistake this file exists for. `hkb` is authored in
 * TypeScript, and Node refuses to strip types under `node_modules`, so a `bin` pointing at the
 * `.ts` passes every content check above and produces a binary that cannot start. Only running the
 * installed binary proves it.
 *
 * The verbs are chosen for what they touch: `version` reads the package's own package.json and must
 * open no board, `new` creates and migrates one from `prisma/migrations` (the directory `files` has
 * forgotten before), and `boards` reads it back.
 */
function checkRuns(bin, root, cwd) {
  if (!fs.existsSync(bin)) return bad('npm linked no `hkb` binary', 'check the `bin` map in package.json');
  log(`running ${bin}`);
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const board = path.join(cwd, 'smoke-board.db');
  const env = { ...process.env, HKB_DATABASE_URL: `file:${board}` };

  const version = run(bin, ['version'], { cwd, env });
  if (version.status !== 0) {
    return bad(`\`hkb version\` exited ${version.status}: ${version.out}`,
      'the installed hkb cannot start — if this is ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, `bin.hkb` is pointing at TypeScript instead of the dist transpile');
  }
  if (version.out !== `hkb ${expected}`) {
    bad(`\`hkb version\` printed "${version.out}", expected "hkb ${expected}"`,
      'the bin and the package.json in the tarball disagree — release.yml matches this same line against the tag');
  } else ok(`hkb version → ${version.out}`);
  // Asking what is installed must not leave a database behind. test/hkb.test.ts asserts this against
  // the source; here it is asserted against the artifact, where PACKAGE_ROOT resolves differently.
  if (fs.existsSync(board)) bad('`hkb version` created a board', 'the version verb must return before openBoard() — see src/hkb.ts');
  else ok('and created no board doing it');

  const help = run(bin, ['--help'], { cwd, env });
  if (help.status !== 0) bad(`\`hkb --help\` exited ${help.status}: ${help.out}`, 'the CLI starts but cannot print its help');
  else ok(`hkb --help → ${help.out.split('\n').length} lines`);

  const filed = run(bin, ['new', 'smoke', '--brief', 'x', '--board', 'smoke', '--no-isolate', '--json'], { cwd, env });
  if (filed.status !== 0) {
    return bad(`\`hkb new\` exited ${filed.status}: ${filed.out}`,
      'the board could not be created — check that `prisma` is in `files`, since ensureSchema reads prisma/migrations at runtime');
  }
  if (!fs.existsSync(board)) return bad('`hkb new` exited 0 but wrote no board file', `expected ${board}`);
  ok('hkb new → created and migrated a board from the packaged prisma/migrations');

  const boards = run(bin, ['boards', '--json'], { cwd, env });
  if (boards.status !== 0 || !boards.out.includes('"smoke"')) {
    return bad(`\`hkb boards\` did not list the board just created: ${boards.out}`, 'check src/hkb.ts boards');
  }
  ok('hkb boards → lists it');
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
    bin = path.join(root, 'dist', 'bin', 'hkb.js');
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-smoke-cwd-'));
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
  log(`smoke-pack: the packed artifact installs and runs from outside this repository. ${MUST_SHIP.length + MUST_NOT_SHIP.length} content checks, 5 command checks.`);
} finally {
  if (dir && !keep) fs.rmSync(dir, { recursive: true, force: true });
  else if (dir) log(`kept: ${dir}`);
}
