import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  withArtifacts, withCheck, withGuide, withInputs, withResults, withStandingRules,
} from '../src/brief.ts';

/**
 * What a worker is told — and, far more importantly here, what it is **not**.
 *
 * This file used to hold the sandbox contract's tests: commit on your branch, rebase onto your base,
 * push that branch and nothing else. The rule that justified every one of those lines was that *the
 * machinery made it true afterwards* — the controller rebased, a `pre-push` hook refused, the sweep
 * read pushed state. ADR-018 deleted all three, so the same rule now deletes the lines.
 *
 * So the tests here are the refusing kind, which is the only kind that proves this: **the core must
 * say nothing about git**, at the shipped defaults, in every shape of brief it composes. A test that
 * asked whether the good parts are still present would pass just as happily with the contract
 * quietly restored.
 */

/**
 * The file's SOURCE with comments stripped — the ban is on what hkb SAYS to a worker, not on
 * explaining why it no longer says it. A rationale that cannot name the thing it removed is a
 * rationale nobody can check, and the header of `src/brief.ts` is where that derivation lives.
 *
 * Crude, and deliberately: it is a `//` inside a string literal away from being wrong, and there is
 * no such string in that file. A parser here would be a second implementation of TypeScript to
 * decide a question one regex answers.
 */
const SAID = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'brief.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Every git instruction the core used to issue, plus the two it never did.
 *
 * Each entry killed a real line. They are checked against the *composed* brief as well as the
 * source, because a helper that reintroduces one through an interpolated string would slip past a
 * source scan.
 */
const GIT_VOCABULARY: [RegExp, string][] = [
  [/\bgit (commit|push|rebase|switch|checkout)\b/i, 'a git command'],
  [/\bcommit\b/i, 'committing'],
  [/\bpush\b/i, 'pushing'],
  [/\brebase\b/i, 'rebasing'],
  [/\bbranch\b/i, 'a branch'],
  [/\bworktree\b/i, 'a worktree'],
  [/\bpull request\b/i, 'a pull request'],
  [/\bgh pr\b/i, 'the forge CLI'],
  [/--force-with-lease/i, 'a force-push licence'],
  [/--no-verify/i, 'a hook bypass'],
];

test('the core says nothing about git — not in what it composes, and not in what it could', () => {
  for (const [pattern, what] of GIT_VOCABULARY) {
    assert.doesNotMatch(
      SAID,
      pattern,
      `src/brief.ts mentions ${what}. The core requires no commit, push or rebase (ADR-018), so `
      + 'nothing here is enforced by anything about git and none of it may be said. A step that '
      + 'wants those is content, in a workflow file.',
    );
  }
});

test('every shape of composed brief is free of it, at the shipped defaults', () => {
  // The full composition the controller performs for an ordinary isolated Job, in its own order.
  const shapes: [string, string][] = [
    ['the brief alone', withStandingRules('Do the work.')],
    ['with a guide', withGuide(withStandingRules('Do the work.'), '# rules\nbe careful\n', 'CLAUDE.md')],
    ['with declared outputs', withArtifacts(withResults(withStandingRules('Do the work.'), { notes: '/tmp/a/notes.md' }), { log: '/tmp/a/log.txt' })],
    ['with a check', withCheck(withStandingRules('Do the work.'), 'npm test')],
    ['with an input', withInputs(withStandingRules('Do the work.'), [{ name: 'schema', source: 'file:db.sql', text: 'CREATE TABLE t(id INT);' }])],
  ];
  for (const [shape, text] of shapes) {
    for (const [pattern, what] of GIT_VOCABULARY) {
      assert.doesNotMatch(text, pattern, `${shape} mentions ${what}`);
    }
  }
});

test('what it DOES still say is the half that is still enforced', () => {
  // Each of these is paired with a refusal somewhere: a declared output that is not there fails the
  // attempt, a check that exits non-zero fails it, an unreadable input fails it before a session is
  // bought. That pairing is the whole test for a line belonging in this file.
  const results = withResults('Do the work.', { notes: '/tmp/a/notes.md' });
  assert.match(results, /notes/, 'a declared result is named by path');
  assert.match(results, /\/tmp\/a\/notes\.md/);

  const checked = withCheck('Do the work.', 'npm test');
  assert.match(checked, /npm test/, 'the command it will be judged by, before it is judged');

  const guided = withGuide('Do the work.', '# rules\nbe careful\n', 'CLAUDE.md');
  assert.match(guided, /CLAUDE\.md/, 'the guide is attributed to where it came from');
  assert.match(guided, /be careful/);

  const fed = withInputs('Do the work.', [{ name: 'schema', source: 'file:db.sql', text: 'CREATE TABLE t(id INT);' }]);
  assert.match(fed, /schema/);
  assert.match(fed, /CREATE TABLE/, 'the material is on the page, before the brief that is about it');
});

test('a worker is still told the three standing rules (ADR-014)', () => {
  const ruled = withStandingRules('Do the work.');
  assert.notEqual(ruled, 'Do the work.', 'the rules reach every worker, unconditionally');
  assert.match(ruled, /Do the work\./, 'and the brief survives them');
});
