import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HKB_DATABASE_URL ??= `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-art-')), 'b.db')}`;

const {
  checkArtifactName, declaredArtifacts, artifactsDir, ensureArtifactsDir, artifactPaths,
  collectArtifacts, clearEmptyArtifacts, missingArtifacts, bytes,
} = await import('../src/artifacts.ts');

/**
 * `artifacts` — ADR-011's channel: the output that is too big to be a result and does not belong in
 * the repository. The gap between ADR-008's two halves.
 *
 * Every assertion here is a REFUSAL or a boundary, for the reason `test/results.test.ts` gives: a
 * declaration nothing enforces is the shape this project has shipped five times and had to delete.
 */

test('an artifact name is one path segment, and dots are the only punctuation', () => {
  assert.equal(checkArtifactName('report.md'), 'report.md');
  assert.equal(checkArtifactName(' plan '), 'plan', 'trimmed, because a trailing space is a typo not a name');
  assert.equal(checkArtifactName('a-b_c9.tar.gz'), 'a-b_c9.tar.gz');

  // Each of these names somewhere other than the Job's own output directory, which is the whole
  // point of the check: the name is a destination the controller resolves with no agent in the loop.
  for (const bad of ['', '   ', '..', '../escape', 'a/b', 'a\\b', '/abs', '.hidden', 'a.', '.', 'x'.repeat(129)]) {
    assert.throws(
      () => checkArtifactName(bad),
      (e: Error & { exitCode?: number }) => e.exitCode === 2 && /artifact name/.test(e.message),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('declaredArtifacts survives whatever is in the Json column', () => {
  assert.deepEqual(declaredArtifacts(['a', 'b']), ['a', 'b']);
  assert.deepEqual(declaredArtifacts(null), []);
  assert.deepEqual(declaredArtifacts('report.md'), [], 'a bare string is not a list of names');
  assert.deepEqual(declaredArtifacts([1, '', '  ', 'ok']), ['ok'], 'and the junk in one is dropped');
});

test('a declared artifact the run did not write is missing; one it did is catalogued', () => {
  const dir = ensureArtifactsDir(101, 1);
  fs.writeFileSync(path.join(dir, 'report.md'), 'x'.repeat(5000));

  const got = collectArtifacts(101, 1, ['report.md', 'plan.json']);
  assert.deepEqual(got.missing, ['plan.json'], 'declared and not there — this fails the attempt');
  assert.deepEqual(got.produced, [{ name: 'report.md', kind: 'file', bytes: 5000 }]);
  assert.deepEqual(got.volunteered, []);

  // The cap is the thing an artifact does not have. 5000 bytes is past RESULT_MAX_BYTES, and it is
  // recorded rather than refused — that difference is the entire reason this channel exists.
  assert.ok(got.produced[0].bytes > 4096, 'no size limit, and that is the feature');
});

test('a declared name may come back as a directory, and its bytes are counted through', () => {
  const dir = ensureArtifactsDir(102, 1);
  fs.mkdirSync(path.join(dir, 'site', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'site', 'index.html'), 'ab');
  fs.writeFileSync(path.join(dir, 'site', 'assets', 'app.js'), 'cdefg');

  const got = collectArtifacts(102, 1, ['site']);
  assert.deepEqual(got.missing, []);
  assert.deepEqual(got.produced, [{ name: 'site', kind: 'dir', bytes: 7 }],
    'recursive, because nothing removes these and the size is the only warning an operator gets');
});

test('what the run volunteered is kept and never required; what cannot be named is ignored', () => {
  const dir = ensureArtifactsDir(103, 1);
  fs.writeFileSync(path.join(dir, 'asked-for'), 'a');
  fs.writeFileSync(path.join(dir, 'noticed'), 'bb');
  // Not a legal name. It is skipped rather than failing somebody else's attempt — the same fence
  // `collectResults` puts round the half nobody declared.
  fs.writeFileSync(path.join(dir, '.stray'), 'ccc');

  const got = collectArtifacts(103, 1, ['asked-for']);
  assert.deepEqual(got.missing, []);
  assert.deepEqual(got.volunteered, ['noticed'], 'kept, reported, never required');
  assert.deepEqual(got.produced.map((a) => a.name), ['asked-for', 'noticed'], 'and `.stray` is not there');
});

test('collecting from a directory that was never written is a run that wrote nothing, not an error', () => {
  const got = collectArtifacts(999, 9, ['report.md']);
  assert.deepEqual(got.produced, []);
  assert.deepEqual(got.missing, ['report.md'], 'which is the accurate account, and it fails the attempt');
});

/**
 * The guard that has to refuse: an attempt's directory is created up front whether or not anything
 * was declared, because the path goes into the prompt. If the cleanup removed a directory with
 * something in it, the artifact channel would delete the only copy of its own output.
 */
test('the empty-directory sweep removes an empty one and REFUSES a full one', () => {
  ensureArtifactsDir(104, 1);
  clearEmptyArtifacts(104, 1);
  assert.equal(fs.existsSync(artifactsDir(104, 1)), false, 'nothing was written, so nothing is kept');

  const dir = ensureArtifactsDir(105, 1);
  fs.writeFileSync(path.join(dir, 'report.md'), 'the only copy');
  clearEmptyArtifacts(105, 1);
  assert.equal(fs.existsSync(path.join(dir, 'report.md')), true,
    'a non-empty directory survives the sweep — the file IS the artifact, and nothing else holds it');
});

test('the paths handed to the worker are absolute and inside the attempt directory', () => {
  const paths = artifactPaths(106, 2, ['report.md', 'plan']);
  for (const p of Object.values(paths)) {
    assert.ok(path.isAbsolute(p), 'absolute, because the worker resolves it from its own worktree');
    assert.equal(path.dirname(p), artifactsDir(106, 2));
  }
  // The property the channel exists for: an artifact is never inside a checkout, so writing one
  // cannot land in a worker's diff (`src/results.ts` states the same reasoning for results).
  assert.ok(!artifactsDir(106, 2).includes(`${path.sep}.git`));
});

test('missingArtifacts names what is owed, or says nothing at all', () => {
  assert.equal(missingArtifacts(7, []), null, 'no shortfall, no sentence');
  assert.match(missingArtifacts(7, ['plan.json']) ?? '', /#7 declared `plan\.json`.*unwritten/);
  assert.match(missingArtifacts(7, ['a', 'b']) ?? '', /`a`, `b` and the run left them unwritten/);
});

test('bytes reads as a size a human recognises', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(1023), '1023 B');
  assert.equal(bytes(1024), '1.0 KiB');
  assert.equal(bytes(5000), '4.9 KiB');
  assert.equal(bytes(10 * 1024 * 1024), '10 MiB', 'no decimal above ten — the digit stops earning its place');
  assert.equal(bytes(-1), '?');
});
