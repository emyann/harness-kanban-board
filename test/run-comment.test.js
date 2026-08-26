import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRunComment, RUN_MARKER, serializeRunComment, emptyRun } from '../src/model.js';

const runBody = (pid) => {
  const run = emptyRun();
  run.attempts.push({ attempt: 1, profile: 'claude', host: 'h', started_at: '2026-08-26T04:37:58Z', pid });
  return serializeRunComment(run);
};

test('pickRunComment: newest run comment wins, older ones are duplicates', () => {
  const comments = [
    { id: 1, body: 'just a comment' },
    { id: 2, body: runBody(null) },   // created before the pid was known
    { id: 3, body: '<!-- kb-result -->\nsummary' },
    { id: 4, body: runBody(6048) },   // written by the second (erroneous) create
  ];
  const { chosen, duplicates } = pickRunComment(comments);
  assert.equal(chosen.id, 4);
  assert.deepEqual(duplicates.map((c) => c.id), [2]);
  assert.ok(chosen.body.startsWith(RUN_MARKER));
});

test('pickRunComment: none or one', () => {
  assert.deepEqual(pickRunComment([]), { chosen: null, duplicates: [] });
  assert.deepEqual(pickRunComment([{ id: 9, body: 'x' }]), { chosen: null, duplicates: [] });
  const one = pickRunComment([{ id: 5, body: runBody(1) }]);
  assert.equal(one.chosen.id, 5);
  assert.equal(one.duplicates.length, 0);
});
