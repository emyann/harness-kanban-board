import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { withSandbox, withWorktree } from '../src/brief.ts';

/**
 * The sandbox contract, held to its own definition.
 *
 * ADR-017 decision 5, and the boundary inventory of 2026-09-07 in one line: *the git sandbox
 * contract is core; the pull request is one consumer's opinion.* The contract is the refusals — what
 * the core tells a worker is exactly what the controller will refuse on afterwards, and every other
 * line is a workflow's content. So the tests here are about what is NOT said as much as what is.
 */

// ---------------------------------------------------------------- the inventory's own test

/**
 * The file's SOURCE, with its comments stripped — the ban is on what hkb SAYS to a worker, not on
 * explaining why it no longer says it. A rationale that cannot name the thing it removed is a
 * rationale nobody can check, and the header of `src/brief.ts` is where the derivation lives.
 *
 * Crude, and deliberately: it is a `//` inside a string literal away from being wrong, and there is
 * no such string in this file. A parser here would be a second implementation of TypeScript to
 * decide a question one regex answers.
 */
const SAID = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'brief.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the core says nothing about pull requests — that is a step\'s content', () => {
  for (const phrase of ['pull request', 'gh pr', 'draft', 'co-authored-by']) {
    assert.ok(
      !SAID.toLowerCase().includes(phrase),
      `src/brief.ts still says "${phrase}" to a worker. Nothing refuses on it, so it belongs in a `
      + 'workflow file (`.hkb/workflows/`), not in the machinery — ADR-017 decision 5.',
    );
  }
});

// ---------------------------------------------------------------- what it does say

const BRANCH = 'kb-7-1';
const contract = (base?: { rebaseOnto?: string; fetch?: boolean }) =>
  withSandbox('Do the work.', BRANCH, base);

test('a worker is told its branch, and to commit on it', () => {
  const text = contract();
  assert.match(text, /Do the work\./, 'the brief is still the brief');
  assert.match(text, /`kb-7-1`/);
  assert.match(text, /Commit it on `kb-7-1`/);
  // The refusal behind it: `ahead` and `onBase` read commits, so work left in the tree is invisible.
  assert.match(text, /Uncommitted work is work nothing can see/);
});

test('and NOT to push, open anything, or leave the attribution off a body nobody asked for', () => {
  const text = contract({ rebaseOnto: 'origin/main' });
  for (const gone of [/git push/, /pull request/i, /gh pr/i, /draft/i, /Co-Authored-By/i, /human reviews/i]) {
    assert.doesNotMatch(text, gone, 'the core stopped saying this; a workflow file says it now');
  }
});

test('the rebase is asked for BEFORE the finish, not before the push', () => {
  // "Before you push" was a sentence about a step the core no longer knows this Job takes. The
  // refusal is about the branch being on the base when the attempt ends, which is what this says.
  const text = contract({ rebaseOnto: 'origin/main' });
  assert.match(text, /Before you finish, rebase onto the base/);
  assert.match(text, /git fetch origin main && git rebase origin\/main/);
  assert.doesNotMatch(text, /BEFORE you push/);
  // And the argument for the narrowed fetch is gone with the force-push it protected.
  assert.doesNotMatch(text, /ONE branch/);
});

test('a chain step is told to rebase onto ITS base, and not to fetch a branch hkb tracks', () => {
  const text = contract({ rebaseOnto: 'origin/kb-33-1', fetch: false });
  assert.match(text, /git rebase origin\/kb-33-1/);
  assert.doesNotMatch(text, /git fetch/, 'that fetch would clobber the ref a lease compares against');
  assert.match(text, /hkb tracks that branch itself/, 'said out loud, or it reads as an omission');
});

test('a repository with no remote is told to rebase onto nothing at all', () => {
  // `baseRef` answers `HEAD` where there is no origin, and `git fetch origin HEAD` is an
  // instruction to fail. The step is omitted rather than emitted broken.
  const text = contract({ rebaseOnto: 'HEAD' });
  assert.doesNotMatch(text, /rebase/);
  assert.match(text, /2\. Reply with one line/, 'and the numbering closes over the gap');
});

test('the three rules are the three the machinery can refuse', () => {
  const text = contract();
  assert.match(text, /Never push to the default branch, and never merge/);
  assert.match(text, /Never force-push any branch but `kb-7-1`/);
  assert.match(text, /--force-with-lease/);
  assert.match(text, /still commit what you have/);
  // The old absolute. Nothing forbids a lease-checked force any more — the worker owns its branch.
  assert.doesNotMatch(text, /Never `git push --force`/);
});

test('a Job whose deliverable is not a diff is told about the sandbox and nothing else', () => {
  const text = withWorktree('Write the report.', BRANCH);
  assert.match(text, /sandbox, not/);
  assert.doesNotMatch(text, /pull request/i);
  assert.doesNotMatch(text, /Commit it on/);
});
