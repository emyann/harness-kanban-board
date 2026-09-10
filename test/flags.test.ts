import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFlag, given, givenList, num, seconds } from '../src/flags.ts';
import { CHECK_COMMAND_MAX_BYTES } from '../src/check.ts';

/**
 * A flag's value, and the four ways `parseArgs` lies about one.
 *
 * No board, no repository, no argv — these are pure, which is what lets them be tested against the
 * refusing case, which is the case that matters. Every refusal here is a bug this project shipped:
 * a bare `--check` filed as the shell command `true`, a bare `--export` declaring an output called
 * `true`, `--check --json` filing a flag as a command, `--max-turns` silently capped at 1.
 *
 * They live in a module of their own because the CLI is no longer the only caller: a workflow
 * file's frontmatter keys are `hkb new`'s flags, so `src/filing.ts` converts the same values with
 * no parser anywhere near them.
 */

const why = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.equal((e as { exitCode?: number }).exitCode, 2, 'a usage refusal is exit code 2');
    return (e as Error).message;
  }
  return assert.fail('expected a refusal');
};

test('a bare flag is the boolean true, and it is refused rather than stringified', () => {
  assert.match(why(() => given(true, '--model')), /--model was given nothing/);
  assert.match(why(() => given(undefined, '--model')), /a bare --model is not a value/);
  // The repeatable form is `[true]`, which walked straight past a `typeof raw !== 'string'` guard.
  assert.match(why(() => givenList([true], '--export')), /--export was given nothing/);
  assert.match(why(() => num(true, '--max-turns')), /a bare --max-turns is not a number/);
});

test('a value that is really the next flag is refused, and the escape is named', () => {
  const msg = why(() => given('--json', '--check'));
  assert.match(msg, /which is a flag rather than a value/);
  assert.match(msg, /--check " --json"/, 'the fix has to be something that works, not a hope');
  assert.match(why(() => given('-x', '--base')), /flag rather than a value/);
  assert.match(why(() => num('--json', '--max-budget')), /flag rather than a number/);
});

test('what is NOT flag-shaped goes through: a bullet, a negative number, a quoted dash', () => {
  assert.equal(given('- add a test', '--brief'), '- add a test');
  assert.equal(given('  spaced  ', '--gate'), 'spaced');
  assert.equal(given(' -x', '--check'), '-x', 'the documented escape reaches a value that starts with a dash');
  assert.equal(given('', '--guide'), '', 'the empty string is a value several flags mean something by');
  assert.equal(num('-3', '--max-budget'), -3, 'a negative number is a number; the range is the caller\'s rule');
  assert.deepEqual(givenList(undefined, '--export'), []);
  assert.deepEqual(givenList('one', '--export'), ['one'], 'a single repeatable arrives unwrapped');
});

test('a clearable flag says so in its own refusal, and only when it has one', () => {
  assert.match(why(() => given(true, '--check', '"none"')), /or --check "none" to clear it/);
  assert.equal(/to clear it/.test(why(() => given(true, '--check'))), false);
});

test('seconds is whole, positive, and bounded by the timer that would have to fire', () => {
  assert.equal(seconds(undefined, '--deadline'), undefined, 'absent means the board answers');
  assert.equal(seconds('none', '--deadline'), null, 'the word clears it');
  assert.equal(seconds('600', '--deadline'), 600);
  assert.match(why(() => seconds('1.5', '--deadline')), /wants a whole number of seconds/);
  // 0 reads as "no deadline" to a person and means "already expired" to the arithmetic.
  assert.match(why(() => seconds('0', '--deadline')), /0 does not mean "no deadline"/);
  assert.match(why(() => seconds('-5', '--deadline')), /wants a positive number of seconds/);
  // Past this a setTimeout delay overflows int32 and Node clamps it to 1ms — the longest possible
  // clock would abort every session the instant it started.
  assert.match(why(() => seconds('2147484', '--deadline')), /the runtime's own timer overflows/);
  assert.equal(seconds('2147483', '--deadline'), 2147483);
});

test('--check none is refused where it files a Job and accepted where it clears one', () => {
  // On a NEW Job there is nothing to clear: the column is already null, and filing `none` files a
  // command that exits 127 — three paid sessions failing a check that can never pass.
  assert.match(why(() => checkFlag('none')), /would file the literal shell command `none`/);
  assert.equal(checkFlag('none', '--check', true), null, 'on `hkb job set` it means what it means everywhere else');
  assert.equal(checkFlag('npm test'), 'npm test');
  assert.equal(checkFlag(''), '', 'the per-Job opt-out: no check, and do not inherit the board\'s');
  const long = 'x'.repeat(CHECK_COMMAND_MAX_BYTES + 1);
  assert.match(why(() => checkFlag(long)), /and the limit is/,
    'past the kernel\'s argument limit `sh -c` cannot be started, so every attempt would fail on the command');
});
