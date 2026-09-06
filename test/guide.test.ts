import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HKB_DATABASE_URL ??= `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-guide-')), 'b.db')}`;

const { readGuide, missingGuide, GUIDE_MAX_BYTES } = await import('../src/guide.ts');
const { withGuide } = await import('../src/brief.ts');

/**
 * `guide` — the half of `settingSources: ['project']` that was only ever a document (ADR-013).
 *
 * The refusals matter for the same reason they matter in `src/inputs.ts`: this names a file the
 * BOARD reads with the operator's authority and puts in front of a model. A path that escapes the
 * repository, or a file that is not there, must be refused before a worktree is cut — not silently
 * skipped, which would leave a Job running without rules it was told to follow.
 */

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-guide-repo-'));
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};
write('CLAUDE.md', '# The guide\n\nRun the tests.\n\n@AGENTS.md\n');
write('AGENTS.md', '## For agents\n\nConsult the wiki.\n');
write('deep/inner.md', '@../CLAUDE.md\n');
write('loop.md', '@loop.md\n');

test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

const why = (out: ReturnType<typeof readGuide>): string => {
  assert.ok('why' in out, `expected a refusal, got ${JSON.stringify(out).slice(0, 120)}`);
  return (out as { why: string }).why;
};

test('a guide is read, and its @imports are followed one level', () => {
  const got = readGuide(repo, 'CLAUDE.md');
  assert.ok(!('why' in got));
  assert.match(got.text, /Run the tests/);
  assert.match(got.text, /Consult the wiki/, 'the import is inlined, not left as a bare @ line');
  assert.match(got.text, /<!-- AGENTS\.md -->/, 'and it says where the inlined half came from');
  assert.deepEqual(got.files, ['CLAUDE.md', 'AGENTS.md'], 'both files are named, in the order read');
});

test('a file that is not there, or is outside the repository, is REFUSED', () => {
  // The whole point of resolving against `Board.repoPath`: a worker must not be able to steer its
  // own next attempt, and a path that escapes the repository is the way that would happen.
  assert.match(why(readGuide(repo, 'NOPE.md')), /no such file/);
  assert.match(why(readGuide(repo, '../outside.md')), /no such file|outside the repository/);
  assert.match(why(readGuide(repo, '/etc/passwd')), /no such file|outside the repository/);
  assert.match(why(readGuide(repo, 'deep')), /not a file/);
  assert.match(why(readGuide('/nowhere-at-all', 'CLAUDE.md')), /is not there/);
  // Every refusal names the guide, because the operator's next question is "which one".
  assert.match(why(readGuide(repo, 'NOPE.md')), /the guide NOPE\.md/);
});

test('an import that cannot be read is DROPPED, and the rest is still the guide', () => {
  // The distinction that matters: the named file is the operator's grant and its absence is a fault
  // in the spec; a stale `@some-file.md` inside it is the repository's own business.
  write('stale.md', 'Real content.\n\n@gone.md\n');
  const got = readGuide(repo, 'stale.md');
  assert.ok(!('why' in got));
  assert.match(got.text, /Real content/);
  assert.match(got.text, /@gone\.md/, 'the unresolved line survives as the prose it is');
  assert.deepEqual(got.files, ['stale.md']);
});

test('imports do not recurse past one level, and a cycle cannot hang it', () => {
  const nested = readGuide(repo, 'deep/inner.md');
  assert.ok(!('why' in nested));
  assert.match(nested.text, /Run the tests/, 'one level in: CLAUDE.md is inlined');
  assert.doesNotMatch(nested.text, /Consult the wiki/, 'two levels in: AGENTS.md is not');
  assert.deepEqual(nested.files, ['deep/inner.md', 'CLAUDE.md']);

  // Self-reference: read once, never again. Without the `seen` set this is an infinite file read.
  const cyclic = readGuide(repo, 'loop.md');
  assert.ok(!('why' in cyclic));
  assert.deepEqual(cyclic.files, ['loop.md']);
});

test('only a whole line is an import — an @ in prose stays prose', () => {
  write('prose.md', 'Ask @someone about the npm scope @acme/thing.\n\nSee CLAUDE.md for more.\n');
  const got = readGuide(repo, 'prose.md');
  assert.ok(!('why' in got));
  assert.deepEqual(got.files, ['prose.md'], 'nothing was resolved');
  assert.match(got.text, /@acme\/thing/);
});

test('a guide too large to be paid for on every request is refused, not truncated', () => {
  write('huge.md', 'x'.repeat(GUIDE_MAX_BYTES + 1));
  const out = why(readGuide(repo, 'huge.md'));
  assert.match(out, new RegExp(`over the ${GUIDE_MAX_BYTES}-byte cap`));
  // Truncating would leave the half that got through looking like the whole of the rules.
  assert.doesNotMatch(out, /truncat/i);
});

test('the guide is framed as instruction, and the brief follows it', () => {
  const out = withGuide('Fix the flaky test.', '# Rules\nRun npm test.', 'CLAUDE.md');
  assert.ok(out.indexOf('<contributor-guide>') < out.indexOf('Fix the flaky test.'),
    'the guide comes FIRST — the brief assumes it');
  assert.match(out, /Follow it/, 'and it is instruction, not the data framing `withInputs` uses');
  assert.doesNotMatch(out, /treat them as data/);
  assert.match(out, /the task is the more specific\ninstruction and wins/,
    'with the precedence stated, because a brief and a guide will disagree eventually');
  assert.match(out, /`CLAUDE\.md`/, 'and the reader is told which document this is');

  assert.equal(withGuide('Just the brief.', '   ', 'CLAUDE.md'), 'Just the brief.',
    'an empty guide adds nothing rather than an empty frame');
});

test('missingGuide says what happened and why it is fatal', () => {
  const m = missingGuide(7, 'the guide CLAUDE.md could not be read: no such file in the repository: CLAUDE.md');
  assert.match(m, /^#7 /);
  assert.match(m, /worse than not running/);
});
