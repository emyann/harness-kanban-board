// The user-level board list (`~/.config/hkb/boards.json`): the writer beside `loadUserBoards`.
// Every test runs under a temp `KB_CONFIG_HOME`, so nothing here can touch a real one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadUserBoards, mainWorktree, registerUserBoard, saveUserBoards, userBoardsFile,
} from '../src/board.js';
import { mergeBoardEntry } from '../src/model.js';

const ORIGINAL_CONFIG_HOME = process.env.KB_CONFIG_HOME;
after(() => {
  if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.KB_CONFIG_HOME;
  else process.env.KB_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
});

/** A fresh config home, pointed at by KB_CONFIG_HOME. Returns the boards.json path inside it. */
function configHome() {
  process.env.KB_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-boards-'));
  return userBoardsFile();
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-checkout-'));
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

// ---------- mergeBoardEntry (pure) ----------

test('mergeBoardEntry appends, and appends nothing twice', () => {
  const first = mergeBoardEntry([], '/code/web');
  assert.deepEqual(first, { entries: ['/code/web'], added: true });
  const again = mergeBoardEntry(first.entries, { path: '/code/web', board: null });
  assert.equal(again.added, false);
  assert.deepEqual(again.entries, ['/code/web']);
});

test('mergeBoardEntry compares by the resolver it is given, and leaves the old spelling alone', () => {
  const resolve = (p) => p.replace(/^~/, '/home/you');
  const { entries, added } = mergeBoardEntry(['~/code/web'], '/home/you/code/web', resolve);
  assert.equal(added, false);
  assert.deepEqual(entries, ['~/code/web'], 'the entry a human typed keeps its spelling');
});

test('mergeBoardEntry keys on the board slug too, and writes null as a bare path', () => {
  const one = mergeBoardEntry([], { path: '/code/web', board: null });
  const two = mergeBoardEntry(one.entries, { path: '/code/web', board: 'release' });
  assert.equal(two.added, true);
  assert.deepEqual(two.entries, ['/code/web', { path: '/code/web', board: 'release' }]);
  assert.equal(mergeBoardEntry(two.entries, '/code/web#release').added, false);
});

test('mergeBoardEntry refuses an entry with no path instead of writing a blank one', () => {
  assert.throws(() => mergeBoardEntry([], '   '), (e) => e.exitCode === 2 && /needs a path/.test(e.message));
});

// ---------- registerUserBoard ----------

test('registering into a missing file creates it, in the documented shape', () => {
  const file = configHome();
  const root = scratch();
  assert.equal(fs.existsSync(file), false);

  const res = registerUserBoard(root);
  assert.deepEqual(res, { added: true, file, entries: 1 });
  assert.deepEqual(json(file), { version: 1, boards: [root] });
  assert.deepEqual(loadUserBoards(file), [{ path: root, board: null }]);
});

test('registering the same root twice adds nothing and does not touch the file', () => {
  const file = configHome();
  const root = scratch();
  registerUserBoard(root);
  const before = read(file);
  const mtime = fs.statSync(file).mtimeMs;

  const res = registerUserBoard(root);
  assert.deepEqual(res, { added: false, file, entries: 1 });
  assert.equal(read(file), before, 'the file must be byte-identical');
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'and must not even be rewritten');
});

test('a ~ spelling and its absolute expansion are one entry, in either order', () => {
  const tilde = `~/hkb-registry-${process.pid}-${Date.now()}`; // never created: only the spelling matters
  const abs = path.join(os.homedir(), tilde.slice(2));

  const file = configHome();
  assert.equal(registerUserBoard(tilde).added, true);
  assert.equal(registerUserBoard(abs).added, false, 'absolute after ~');
  assert.deepEqual(json(file).boards, [abs], 'a path hkb adds itself is stored resolved');

  const other = configHome();
  assert.equal(registerUserBoard(abs).added, true);
  assert.equal(registerUserBoard(tilde).added, false, '~ after absolute');
  assert.deepEqual(json(other).boards, [abs]);
});

test('a hand-written ~ entry makes the absolute registration a no-op, spelling intact', () => {
  const file = configHome();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const typed = `~/hkb-code-${process.pid}/web`; // never created: only the two spellings matter
  fs.writeFileSync(file, JSON.stringify({ version: 1, boards: [typed] }, null, 2) + '\n');
  const before = read(file);

  assert.equal(registerUserBoard(path.join(os.homedir(), typed.slice(2))).added, false);
  assert.equal(read(file), before, 'the entry stays spelled the way it was typed');
});

test('hand-written entries survive a registration untouched, and a bare array becomes the object shape', () => {
  const file = configHome();
  const hand = ['~/code/web', { path: '~/code/api', board: 'release' }, '../sibling#next'];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hand) + '\n'); // the bare-array form, as a human may have left it

  const root = scratch();
  const res = registerUserBoard(root, 'staging');
  assert.deepEqual(res, { added: true, file, entries: 4 });

  const after = json(file);
  assert.equal(after.version, 1);
  assert.deepEqual(after.boards.slice(0, 3), hand, 'no entry is reordered, rewritten or normalised');
  assert.deepEqual(after.boards[3], { path: root, board: 'staging' });
});

test('a malformed file is refused with exitCode 2 and left exactly as it was', () => {
  for (const bad of ['{ not json', '{"boards": "../nope"}']) {
    const file = configHome();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bad);
    assert.throws(() => registerUserBoard(scratch()), (e) => e.exitCode === 2 && e.message.includes(file), bad);
    assert.equal(read(file), bad, 'a file a human wrote is never clobbered');
  }
});

test('two registrations of different roots both land — no lost update', () => {
  const file = configHome();
  const a = scratch();
  const b = scratch();
  assert.equal(registerUserBoard(a).added, true);
  assert.equal(registerUserBoard(b).entries, 2);
  assert.deepEqual(json(file).boards, [a, b]);
  assert.deepEqual(loadUserBoards(file).map((s) => s.path), [a, b]);
});

test('the same checkout on two boards is two entries', () => {
  const file = configHome();
  const root = scratch();
  registerUserBoard(root);
  assert.equal(registerUserBoard(root, 'release').added, true);
  assert.deepEqual(json(file).boards, [root, { path: root, board: 'release' }]);
});

// ---------- worktrees ----------

test('a worker worktree registers the main checkout, never itself', () => {
  const file = configHome();
  const root = scratch();
  git(root, 'init', '-q');
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(root, 'config', 'user.email', 'hkb@local');
  git(root, 'config', 'user.name', 'hkb');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'README.md'), '# board\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const wt = path.join(root, '.claude', 'worktrees', 'kb-99-1');
  git(root, 'worktree', 'add', '-q', wt, '-b', 'kb-99-1');
  const main = fs.realpathSync(root);

  assert.equal(mainWorktree(wt), main);
  assert.equal(registerUserBoard(wt).added, true);
  assert.deepEqual(json(file).boards, [main]);
  assert.equal(registerUserBoard(root).added, false, 'the main checkout is already there');
});

test('mainWorktree keeps a path that git knows nothing about', () => {
  const root = scratch();
  assert.equal(mainWorktree(root), root);
  assert.equal(mainWorktree(path.join(root, 'gone')), path.join(root, 'gone'));
});

// ---------- saveUserBoards ----------

test('saveUserBoards creates the directory, writes the object shape and leaves no temp file behind', () => {
  const file = configHome();
  assert.equal(saveUserBoards(['~/code/web'], file), file);
  assert.equal(read(file), JSON.stringify({ version: 1, boards: ['~/code/web'] }, null, 2) + '\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['boards.json']);
});
