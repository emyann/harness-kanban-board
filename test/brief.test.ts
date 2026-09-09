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
const contract = (base?: { base?: string; rebaseOnto?: string; fetch?: boolean }) =>
  withSandbox('Do the work.', BRANCH, base);

test('a worker is told its branch, and to commit on it', () => {
  const text = contract();
  assert.match(text, /Do the work\./, 'the brief is still the brief');
  assert.match(text, /`kb-7-1`/);
  assert.match(text, /Commit it on `kb-7-1`/);
  // The refusal behind it: `ahead` and `onBase` read commits, so work left in the tree is invisible.
  assert.match(text, /Uncommitted work is work nothing can see/);
});

test('and to push it — the line ADR-017 nearly moved out one card too early', () => {
  // The derivation said a push is a step's content. The core still READS pushed state: `pushedRef`
  // decides whether a rebase is legal, and `sweepWorktrees` keeps a checkout for ever when its work
  // "has never been pushed anywhere". Taken out with `Board.defaultWorkflow` unset — every board on
  // its first day — every Job commits, replies, and is recorded `succeeded — produced nothing`.
  assert.match(contract({ rebaseOnto: 'origin/main' }), /git push -u origin kb-7-1/);
});

test('and NOT to open anything, name a reviewer, or carry an attribution rule', () => {
  const text = contract({ rebaseOnto: 'origin/main' });
  for (const gone of [/pull request/i, /gh pr/i, /draft/i, /Co-Authored-By/i, /human reviews/i]) {
    assert.doesNotMatch(text, gone, 'the core stopped saying this; a workflow file says it now');
  }
});

test('the rebase is asked for BEFORE the finish, and the fetch is still narrowed to one branch', () => {
  // "Before you push" was a sentence about a step the core no longer OWNS, though it still asks for
  // it. The refusal is about the branch being on the base when the attempt ends, which is what this
  // says. The narrowed fetch stays: `src/rebase.ts` lease-pushes against the remote-tracking refs,
  // so a worker that fetched everything would clobber the ref that protects another Job's push.
  const text = contract({ rebaseOnto: 'origin/main' });
  assert.match(text, /Before you finish, rebase onto the base/);
  assert.match(text, /git fetch origin main && git rebase origin\/main/);
  assert.doesNotMatch(text, /BEFORE you push/);
  assert.match(text, /ONE branch/);
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
  assert.match(text, /2\. Push it/, 'and the numbering closes over the gap');
  assert.match(text, /3\. Reply with one line/);
});

test('the base is named even when nothing may be rebased onto it', () => {
  // The resumed chain step, and the failure it caused: `rebaseOnto` is undefined once the branch is
  // on the remote, so the worker was told nothing about its base at all — and the workflow step
  // that says "open it against your base" had no base to mean. Its pull request opened against the
  // default branch carrying its parent's commits, the exact failure a base exists to prevent.
  const text = contract({ base: 'origin/kb-33-1' });
  assert.doesNotMatch(text, /rebase/);
  assert.match(text, /Your base .* is `origin\/kb-33-1`/);
});

test('the rules say which of them hkb refuses on, and which one it only asks', () => {
  const text = contract();
  assert.match(text, /Rules, and hkb refuses on these/);
  assert.match(text, /`kb-7-1` is the only branch you may push/);
  assert.match(text, /refused by a git hook/);
  assert.match(text, /Never `git push --force`/);
  assert.match(text, /still commit and push what you have/);
  // `never merge` is the one line with nothing behind it — a merge on the forge is an API call no
  // git hook is on the path of. A file claiming every line is enforced may not quietly carry one
  // that is not, so it is grouped under a sentence that says so.
  const asking = text.slice(text.indexOf('one rule that is asking'));
  assert.match(asking, /Never merge/);
  assert.doesNotMatch(text.slice(0, text.indexOf('one rule that is asking')), /Never merge/);
});

test('a --force-with-lease licence is NOT handed to the worker', () => {
  // #427 granted one, and it reopened a hole the controller closes for itself: `mayRewrite` in
  // `src/rebase.ts` refuses to rewrite a branch whose pull request is out of draft, precisely so an
  // approved resume cannot rewrite a branch somebody is reviewing. A worker with a blanket licence
  // walks straight through that.
  assert.doesNotMatch(contract({ rebaseOnto: 'origin/main' }), /--force-with-lease/);
});

test('a Job whose deliverable is not a diff is told about the sandbox and nothing else', () => {
  const text = withWorktree('Write the report.', BRANCH);
  assert.match(text, /sandbox, not/);
  assert.doesNotMatch(text, /pull request/i);
  assert.doesNotMatch(text, /Commit it on/);
});
