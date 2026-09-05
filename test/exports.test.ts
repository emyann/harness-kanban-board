import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  exportOutputs, exportsOk, normalizeExportPath, parseExports, refuseExportPath,
} from '../src/exports.ts';

/**
 * The declared-output rules, on a real filesystem.
 *
 * Both of the rules worth having here are refusals — a declared path that was not produced fails,
 * and a declared path that leaves the checkout is not copied — so that is what these test. A test
 * that only showed the copy loop copying would pass against a version with no guards at all.
 */

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-exp-'));
const sandbox = () => {
  const from = scratch();
  const to = scratch();
  return { from, to, cleanup: () => { fs.rmSync(from, { recursive: true, force: true }); fs.rmSync(to, { recursive: true, force: true }); } };
};

// ---------------------------------------------------------------- the path itself

test('a path that climbs out of the worktree is refused, and the message says what to do', () => {
  const why = refuseExportPath('../outside.txt');
  assert.ok(why, 'a declared output is not a licence to write anywhere');
  assert.match(why, /escapes the worktree/);
  assert.match(why, /remove the "\.\."/, 'and it says what to do next');
});

test('a path that climbs out in the middle is refused too — normalising is the check', () => {
  assert.match(refuseExportPath('dist/../../etc/passwd') ?? '', /escapes the worktree/);
});

test('an absolute path is refused', () => {
  assert.match(refuseExportPath('/etc/passwd') ?? '', /absolute path/);
  assert.match(refuseExportPath('C:\\Windows\\x') ?? '', /absolute path/);
});

test('a home-relative path is refused — ~ is a directory outside the checkout', () => {
  assert.match(refuseExportPath('~/.claude/skills/x') ?? '', /shell shorthand/);
});

test('the whole checkout is not an output', () => {
  assert.match(refuseExportPath('.') ?? '', /the checkout itself/);
  assert.match(refuseExportPath('  ') ?? '', /an export needs a path/);
});

test('an ordinary path inside the checkout is accepted, in one spelling', () => {
  assert.equal(refuseExportPath('dist/report.json'), null);
  assert.equal(refuseExportPath('.claude/skills/sdk-docs/'), null);
  assert.equal(normalizeExportPath('./.claude/skills/sdk-docs/'), path.join('.claude', 'skills', 'sdk-docs'));
});

// ---------------------------------------------------------------- the column

test('exports that are not JSON are a problem to report, not a throw mid-reconcile', () => {
  const r = parseExports('dist/report.json');
  assert.deepEqual(r.paths, []);
  assert.match(r.problems[0], /not valid JSON/);
  assert.match(r.problems[0], /kb new --export/, 'and it says how the column is meant to be written');
});

test('no exports at all is not a problem — it is the default', () => {
  assert.deepEqual(parseExports(null), { paths: [], problems: [] });
  assert.deepEqual(parseExports('[]'), { paths: [], problems: [] });
});

// ---------------------------------------------------------------- the copy

test('a declared file lands in the destination, and is reported as copied', () => {
  const { from, to, cleanup } = sandbox();
  fs.mkdirSync(path.join(from, 'dist'));
  fs.writeFileSync(path.join(from, 'dist', 'report.json'), '{"ok":true}');

  const r = exportOutputs(from, to, '["dist/report.json"]');
  assert.equal(exportsOk(r), true, r.problems.join('; '));
  assert.deepEqual(r.copied, [path.join('dist', 'report.json')]);
  assert.equal(fs.readFileSync(path.join(to, 'dist', 'report.json'), 'utf8'), '{"ok":true}');
  cleanup();
});

test('a declared directory recurses — one declaration, not one per file', () => {
  const { from, to, cleanup } = sandbox();
  fs.mkdirSync(path.join(from, '.claude', 'skills', 'sdk-docs'), { recursive: true });
  fs.writeFileSync(path.join(from, '.claude', 'skills', 'sdk-docs', 'SKILL.md'), '# skill');
  fs.writeFileSync(path.join(from, '.claude', 'skills', 'sdk-docs', 'ref.md'), 'ref');

  const r = exportOutputs(from, to, '[".claude/skills/sdk-docs/"]');
  assert.equal(exportsOk(r), true, r.problems.join('; '));
  assert.equal(fs.readFileSync(path.join(to, '.claude', 'skills', 'sdk-docs', 'SKILL.md'), 'utf8'), '# skill');
  assert.ok(fs.existsSync(path.join(to, '.claude', 'skills', 'sdk-docs', 'ref.md')));
  cleanup();
});

test('a declared path the worker did not produce is a problem, named', () => {
  const { from, to, cleanup } = sandbox();
  const r = exportOutputs(from, to, '["dist/report.json"]');
  assert.equal(exportsOk(r), false, 'this is the rule that makes the declaration worth writing');
  assert.deepEqual(r.copied, []);
  assert.match(r.problems[0], /was not produced/);
  assert.equal(fs.existsSync(path.join(to, 'dist')), false, 'and nothing was created in its place');
  cleanup();
});

test('a symlink pointing out of the worktree is refused — the string check is not enough', () => {
  const { from, to, cleanup } = sandbox();
  const elsewhere = scratch();
  fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'not ours');
  // `dist` normalises to a path inside the worktree and resolves to one outside it. This is the
  // case a `..` check cannot see, which is why the source is resolved before it is copied.
  fs.symlinkSync(elsewhere, path.join(from, 'dist'));

  const r = exportOutputs(from, to, '["dist/secret.txt"]');
  assert.equal(exportsOk(r), false);
  assert.match(r.problems[0], /outside the worktree/);
  assert.equal(fs.existsSync(path.join(to, 'dist')), false, 'refused, not copied');
  fs.rmSync(elsewhere, { recursive: true, force: true });
  cleanup();
});

test('a bad declaration does not stop a good one — everything is copied, everything is named', () => {
  const { from, to, cleanup } = sandbox();
  fs.writeFileSync(path.join(from, 'good.txt'), 'here');
  const r = exportOutputs(from, to, '["../escape.txt", "good.txt", "gone.txt"]');
  assert.deepEqual(r.copied, ['good.txt']);
  assert.equal(r.problems.length, 2, 'both the refusal and the miss are reported');
  assert.equal(exportsOk(r), false);
  cleanup();
});
