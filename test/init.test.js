// `hkb init`'s footprint on the repo it is run in — currently the `.gitignore` block.
//
// The list of ignored paths is the same lesson twice: once in this repo's own `.gitignore`, once in
// the one every adopter gets. `.kanban/dispatch.pid` was added here and never shipped, so an adopter
// who ran `hkb dispatch --loop` and then `git add -A` committed a pidfile carrying their host and
// pid. The subset test below is what keeps the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGitignore, GITIGNORE_LINES } from '../src/init.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-init-'));
const lines = (root) => fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');

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
