import test from 'node:test';
import assert from 'node:assert/strict';

import { checkLabel, parseLabels, jobLabels, selects, describeLabels, MAX_LABELS } from '../src/labels.ts';

/**
 * Pure logic, so the case that matters is testable: the **refusal**. `checkLabel` is a fence in the
 * same family as `checkResultName` and `checkArtifactName`, and a fence proven only by what it lets
 * through is the failure mode CLAUDE.md names — every guard here gets a test that makes it refuse.
 */

test('a label that is not `key=value` in plain tokens is refused by name', () => {
  const bad: [string, RegExp][] = [
    ['', /empty/],
    ['   ', /empty/],
    ['workflow', /no `=`/],
    ['=release', /no key/],
    ['workflow=', /no value/],
    ['workflow= ', /no value/],
    // The separator has one meaning, so a second `=` lands in the value and fails as a token.
    ['workflow=a=b', /not a plain token/],
    ['work flow=release', /key.*not a plain token/],
    ['workflow=re lease', /value.*not a plain token/],
    // A comma would survive the map and break every line that prints one.
    ['workflow=a,b', /value.*not a plain token/],
    ['work/flow=release', /key.*not a plain token/],
    ['-workflow=release', /key.*not a plain token/],
    ['workflow-=release', /key.*not a plain token/],
    ['.workflow=release', /key.*not a plain token/],
    ['workflow=release.', /value.*not a plain token/],
    [`${'a'.repeat(64)}=x`, /key.*not a plain token/],
    [`x=${'a'.repeat(64)}`, /value.*not a plain token/],
  ];
  for (const [raw, why] of bad) {
    assert.throws(() => checkLabel(raw), why, `\`${raw}\` should have been refused`);
    // Exit 2 is usage-or-state, which is what a bad flag is; and the message says what a label is.
    assert.throws(() => checkLabel(raw), (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /--label workflow=release/);
      return true;
    });
  }
});

test('a key and a value are tokens with dots, dashes and underscores between them', () => {
  assert.deepEqual(checkLabel('workflow=release'), { key: 'workflow', value: 'release' });
  assert.deepEqual(checkLabel(' area = parser '), { key: 'area', value: 'parser' });
  assert.deepEqual(checkLabel('app.kubernetes.io/x'.replace('/x', '') + '=hkb-1_2'), {
    key: 'app.kubernetes.io', value: 'hkb-1_2',
  });
  assert.deepEqual(checkLabel('a=b'), { key: 'a', value: 'b' });
  assert.deepEqual(checkLabel(`${'a'.repeat(63)}=${'b'.repeat(63)}`).key.length, 63);
});

test('one key twice with two values is refused, rather than one of them winning', () => {
  assert.throws(
    () => parseLabels(['workflow=release', 'workflow=triage']),
    /given twice.*release.*triage/s,
  );
  // The same value twice is a repeat, not a contradiction — nothing is lost by allowing it.
  assert.deepEqual(parseLabels(['a=1', 'a=1']), { a: '1' });
  assert.deepEqual(parseLabels(['workflow=release', 'step=draft']), { workflow: 'release', step: 'draft' });
  assert.deepEqual(parseLabels([]), {});
});

test('more labels than the cap is refused: a label groups a Job, it does not carry its data', () => {
  const many = Array.from({ length: MAX_LABELS + 1 }, (_, i) => `k${i}=v`);
  assert.throws(() => parseLabels(many), new RegExp(`over the cap of ${MAX_LABELS}`));
  assert.equal(Object.keys(parseLabels(many.slice(0, MAX_LABELS))).length, MAX_LABELS);
});

test('a malformed column reads as no labels rather than throwing mid-listing', () => {
  assert.deepEqual(jobLabels(null), {});
  assert.deepEqual(jobLabels(undefined), {});
  assert.deepEqual(jobLabels('workflow=release'), {});
  assert.deepEqual(jobLabels(['workflow', 'release']), {});
  assert.deepEqual(jobLabels({ workflow: 42 }), {});
  // One unreadable pair does not hide the readable ones — the map is filtered, not dropped.
  assert.deepEqual(jobLabels({ workflow: 'release', bad: { nested: true }, 'no spaces': 'x' }), { workflow: 'release' });
});

test('a selector is equality, ANDed, and an empty one matches everything', () => {
  const job = { workflow: 'release', step: 'draft' };
  assert.equal(selects(job, {}), true);
  assert.equal(selects({}, {}), true);
  assert.equal(selects(job, { workflow: 'release' }), true);
  assert.equal(selects(job, { workflow: 'release', step: 'draft' }), true);
  // The refusals: a wrong value, a key that is not there, and one requirement of two failing.
  assert.equal(selects(job, { workflow: 'triage' }), false);
  assert.equal(selects(job, { area: 'parser' }), false);
  assert.equal(selects(job, { workflow: 'release', area: 'parser' }), false);
  assert.equal(selects({}, { workflow: 'release' }), false);
  // No prefix or substring matching: equality means equality, which is what keeps it explainable.
  assert.equal(selects(job, { workflow: 'rel' }), false);
});

test('labels print key-sorted, so two Jobs with the same labels print alike', () => {
  assert.equal(describeLabels({ step: 'draft', workflow: 'release' }), 'step=draft, workflow=release');
  assert.equal(describeLabels({ workflow: 'release', step: 'draft' }), 'step=draft, workflow=release');
  assert.equal(describeLabels({}), '');
});
