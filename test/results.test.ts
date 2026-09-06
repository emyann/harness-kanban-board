import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HKB_DATABASE_URL ??= `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-res-')), 'b.db')}`;

const {
  declaredResults, checkResultName, collectResults, ensureResultsDir, resultPaths,
  missingResults, clearResults, resultsDir, RESULT_MAX_BYTES,
} = await import('../src/results.ts');

/**
 * `results` — ADR-008's other half, and the thing a Job produces when it is not coupled to a commit.
 *
 * Every assertion here is about a REFUSAL, because that is the only half of this contract worth
 * having: `exports` and `results` both exist to make `succeeded` mean more than "a session ended",
 * and a declaration nothing enforces would be the sixth inert one this project has shipped.
 */

test('a result name must be usable as both a filename and a JSON key', () => {
  assert.equal(checkResultName('finding'), 'finding');
  assert.equal(checkResultName(' prUrl '), 'prUrl', 'trimmed, because a trailing space is a typo not a name');
  assert.equal(checkResultName('a-b_c9'), 'a-b_c9');

  for (const bad of ['', '   ', '../escape', 'a/b', 'a.b', 'has space', 'x'.repeat(65)]) {
    assert.throws(
      () => checkResultName(bad),
      (e: Error & { exitCode?: number }) => {
        assert.equal(e.exitCode, 2, 'a usage error, not a crash');
        assert.match(e.message, /plain identifier/, 'and the message says what a name may be');
        return true;
      },
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('declaredResults survives whatever is in the Json column', () => {
  assert.deepEqual(declaredResults(['a', 'b']), ['a', 'b']);
  assert.deepEqual(declaredResults(null), []);
  assert.deepEqual(declaredResults('finding'), [], 'a bare string is not a list of names');
  assert.deepEqual(declaredResults([1, 'a', '', '  ']), ['a'], 'non-strings and blanks are dropped');
});

test('a declared result the run did not write is MISSING, and says so', () => {
  const jobId = 9001;
  ensureResultsDir(jobId, 1);
  const paths = resultPaths(jobId, 1, ['written', 'forgotten']);
  fs.writeFileSync(paths.written, 'the answer\n');

  const got = collectResults(jobId, 1, ['written', 'forgotten']);
  assert.deepEqual(got.produced, { written: 'the answer' }, 'trimmed — a trailing newline is not content');
  assert.deepEqual(got.missing, ['forgotten']);
  assert.deepEqual(got.oversize, []);

  const owed = missingResults(jobId, got.missing, got.oversize);
  assert.match(owed!, /`forgotten`/, 'the message names the one that is missing');
  assert.match(owed!, /not work that was done/);
  clearResults(jobId, 1);
});

test('a result over the cap is refused, and the message names the remedy', () => {
  const jobId = 9002;
  ensureResultsDir(jobId, 1);
  const paths = resultPaths(jobId, 1, ['huge']);
  fs.writeFileSync(paths.huge, 'x'.repeat(RESULT_MAX_BYTES + 1));

  const got = collectResults(jobId, 1, ['huge']);
  assert.deepEqual(got.produced, {}, 'an oversized value is not kept — the cap is the contract');
  assert.deepEqual(got.missing, []);
  assert.equal(got.oversize.length, 1);

  const owed = missingResults(jobId, got.missing, got.oversize);
  assert.match(owed!, /over the 4096-byte cap/);
  assert.match(owed!, /--export/, 'and points at the mechanism that is for files');
  clearResults(jobId, 1);
});

test('a result exactly at the cap is kept — the boundary is not off by one', () => {
  const jobId = 9003;
  ensureResultsDir(jobId, 1);
  fs.writeFileSync(resultPaths(jobId, 1, ['edge']).edge, 'y'.repeat(RESULT_MAX_BYTES));
  const got = collectResults(jobId, 1, ['edge']);
  assert.equal(got.oversize.length, 0);
  assert.equal(got.produced.edge.length, RESULT_MAX_BYTES);
  clearResults(jobId, 1);
});

test('nothing declared owes nothing', () => {
  assert.equal(missingResults(1, [], []), null, 'a Job that declared nothing has no shortfall');
});

test('a directory where a value should be is missing, not produced', () => {
  // The failure mode a bare existsSync would get wrong.
  const jobId = 9004;
  const dir = ensureResultsDir(jobId, 1);
  fs.mkdirSync(path.join(dir, 'finding'));
  const got = collectResults(jobId, 1, ['finding']);
  assert.deepEqual(got.missing, ['finding']);
  assert.deepEqual(got.produced, {});
  clearResults(jobId, 1);
});

test('the collection directory is outside every checkout', () => {
  // The reason it is not in the worktree: a scratch file there is either committed by accident or
  // shows up as untracked noise in the diff a human reviews.
  const dir = resultsDir(7, 2);
  assert.match(dir, /results[/\\]7-2$/);
  assert.doesNotMatch(dir, /worktrees/, 'never inside a worker checkout');
});

/**
 * The volunteered layer — who chooses the fields.
 *
 * hkb's declaration is the filer's requirement: absent, the attempt fails. Hermes' handoff is the
 * other layer alone — freeform metadata the *worker* defines — which is richer and guarantees
 * nothing, because a downstream reader cannot rely on a key existing. Requiring everything is the
 * opposite failure: a Job cannot then say it noticed something nobody thought to ask about.
 *
 * So both, and the distinction is what is *enforced* — never what is kept.
 */
test('a value the run volunteered is kept, and never required', () => {
  const jobId = 9101;
  ensureResultsDir(jobId, 1);
  const paths = resultPaths(jobId, 1, ['finding']);
  fs.writeFileSync(paths.finding, 'the declared one');
  fs.writeFileSync(path.join(path.dirname(paths.finding), 'noticed'), 'a thing nobody asked about');

  const got = collectResults(jobId, 1, ['finding']);
  assert.deepEqual(got.produced, { finding: 'the declared one', noticed: 'a thing nobody asked about' });
  assert.deepEqual(got.volunteered, ['noticed'], 'named as volunteered, so a reader can tell them apart');
  assert.deepEqual(got.missing, [], 'and volunteering nothing required is not a shortfall');
  clearResults(jobId, 1);
});

test('a run that declared nothing can still volunteer', () => {
  const jobId = 9102;
  const dir = ensureResultsDir(jobId, 1);
  fs.writeFileSync(path.join(dir, 'summary'), 'what I did');

  const got = collectResults(jobId, 1, []);
  assert.deepEqual(got.produced, { summary: 'what I did' });
  assert.deepEqual(got.volunteered, ['summary']);
  assert.deepEqual(got.missing, []);
  clearResults(jobId, 1);
});

test('volunteering does not excuse a declared value that is missing', () => {
  // The refusal that keeps the two layers apart: a run cannot substitute something it chose to
  // write for something it was required to write.
  const jobId = 9103;
  const dir = ensureResultsDir(jobId, 1);
  fs.writeFileSync(path.join(dir, 'something-else'), 'not what was asked for');

  const got = collectResults(jobId, 1, ['finding']);
  assert.deepEqual(got.missing, ['finding'], 'still a shortfall');
  assert.deepEqual(got.volunteered, ['something-else']);
  assert.match(missingResults(jobId, got.missing, got.oversize)!, /`finding`/);
  clearResults(jobId, 1);
});

test('the cap applies to a volunteered value too — a huge one is a file, not a handoff', () => {
  const jobId = 9104;
  const dir = ensureResultsDir(jobId, 1);
  fs.writeFileSync(path.join(dir, 'dump'), 'z'.repeat(RESULT_MAX_BYTES + 1));

  const got = collectResults(jobId, 1, []);
  assert.deepEqual(got.produced, {}, 'not kept');
  assert.equal(got.oversize.length, 1);
  // But it does not fail an attempt that required nothing: an oversized VOLUNTEERED value is the
  // run's own mistake to be told about, not a broken promise. The shortfall message still names it.
  assert.match(missingResults(jobId, got.missing, got.oversize)!, /over the 4096-byte cap/);
  clearResults(jobId, 1);
});

test('a name that could not be a filename or a key is ignored, not fatal', () => {
  const jobId = 9105;
  const dir = ensureResultsDir(jobId, 1);
  fs.writeFileSync(path.join(dir, 'ok'), 'kept');
  fs.writeFileSync(path.join(dir, 'has.dot'), 'ignored');
  fs.mkdirSync(path.join(dir, 'a-directory'));

  const got = collectResults(jobId, 1, []);
  assert.deepEqual(got.produced, { ok: 'kept' }, 'the odd ones are skipped, not read and not fatal');
  assert.deepEqual(got.volunteered, ['ok']);
  clearResults(jobId, 1);
});
