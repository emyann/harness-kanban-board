import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HKB_DATABASE_URL ??= `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-prop-')), 'b.db')}`;

const {
  PROPOSAL_ARTIFACT, PROPOSAL_MAX_BYTES, PROPOSAL_MAX_JOBS, PROPOSED_NAME_MAX, PROPOSED_BRIEF_MAX,
  checkProposal, storedProposal, proposalGate, describeProposal, readProposal,
} = await import('../src/proposals.ts');
const { ensureArtifactsDir, artifactPaths } = await import('../src/artifacts.ts');

/**
 * `proposals` — ADR-011's validator, which is the half of that record that is all refusal.
 *
 * The thing on the other side of this parser is a model, so a test that only asks whether it accepts
 * a good proposal proves nothing: it is the same shape of test the admission gate, the worktree base
 * and the lease each passed while silently inert. Every field this module allows is a field a model
 * chose and nobody reviewed, so nearly every assertion below is a REFUSAL.
 */

const ok = (jobs: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ jobs, ...extra });

const refusal = (out: ReturnType<typeof checkProposal>): string => {
  assert.ok('why' in out, `expected a refusal, got ${JSON.stringify(out)}`);
  return (out as { why: string }).why;
};

test('a well-formed proposal is accepted, and only the three allowed keys survive', () => {
  const got = checkProposal(ok([
    { name: 'write the page', brief: 'draft architecture/the-board' },
    { name: 'cheap one', brief: 'a small thing', maxBudgetUsd: 0.5 },
  ]));
  assert.ok(!('why' in got));
  assert.deepEqual(got, {
    jobs: [
      { name: 'write the page', brief: 'draft architecture/the-board' },
      { name: 'cheap one', brief: 'a small thing', maxBudgetUsd: 0.5 },
    ],
    clamped: [],
  });
});

test('a key a proposal may not set is REFUSED by name, never dropped', () => {
  // Named rather than ignored on purpose: a silently dropped `isolate: false` reads as though it
  // had been honoured, and the difference only shows up in what the created Job then does.
  for (const key of ['isolate', 'allowedTools', 'pluginPaths', 'gate', 'exports', 'inputs', 'results', 'proposes', 'boardId', 'phase']) {
    const why = refusal(checkProposal(ok([{ name: 'n', brief: 'b', [key]: 'anything' }])));
    assert.match(why, new RegExp(`\`${key}\``), `${key} must be named in the refusal`);
    assert.match(why, /jobs\[0\]/, 'and the offending path named with it');
  }
});

test('an unknown TOP-LEVEL key is refused too — the only key is `jobs`', () => {
  assert.match(refusal(checkProposal(ok([{ name: 'n', brief: 'b' }], { board: 'other' }))), /`board`/);
  assert.match(refusal(checkProposal(ok([{ name: 'n', brief: 'b' }], { apply: true }))), /`apply`/);
});

test('maxBudgetUsd is CLAMPED down and never up, and the clamp is said out loud', () => {
  const got = checkProposal(ok([{ name: 'n', brief: 'b', maxBudgetUsd: 100 }]), 2);
  assert.ok(!('why' in got));
  assert.equal(got.jobs[0].maxBudgetUsd, 2, 'a proposal cannot buy its successor more than it had');
  assert.equal(got.clamped.length, 1);
  assert.match(got.clamped[0], /\$100\.00.*\$2\.00/, 'the approver reads what was asked for, not just what was allowed');

  const under = checkProposal(ok([{ name: 'n', brief: 'b', maxBudgetUsd: 1 }]), 2);
  assert.ok(!('why' in under));
  assert.equal(under.jobs[0].maxBudgetUsd, 1, 'asking for less is not clamped');
  assert.deepEqual(under.clamped, []);

  // No ceiling means the board has none; the number is then the proposer's own to state.
  const free = checkProposal(ok([{ name: 'n', brief: 'b', maxBudgetUsd: 9 }]), null);
  assert.ok(!('why' in free));
  assert.equal(free.jobs[0].maxBudgetUsd, 9);
});

test('a budget that is not a positive number is refused rather than coerced', () => {
  for (const bad of ['1.5', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, true, {}]) {
    assert.match(
      refusal(checkProposal(ok([{ name: 'n', brief: 'b', maxBudgetUsd: bad }]), 5)),
      /maxBudgetUsd/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('every shape that is not a proposal is refused with a reason a person can act on', () => {
  assert.match(refusal(checkProposal('')), /empty/);
  assert.match(refusal(checkProposal('   ')), /empty/);
  assert.match(refusal(checkProposal('not json')), /not valid JSON/);
  assert.match(refusal(checkProposal('[]')), /not an array|an array/);
  assert.match(refusal(checkProposal('"a string"')), /string/);
  assert.match(refusal(checkProposal('null')), /object/);
  assert.match(refusal(checkProposal('{}')), /no `jobs` array/);
  assert.match(refusal(checkProposal('{"jobs":"one"}')), /no `jobs` array/);
  assert.match(refusal(checkProposal('{"jobs":[]}')), /empty list/);
  assert.match(refusal(checkProposal(ok(['just a string']))), /string, not an object/);
  assert.match(refusal(checkProposal(ok([[]]))), /an array, not an object/);
});

test('a proposed Job without a name or a brief is refused — both are load-bearing', () => {
  assert.match(refusal(checkProposal(ok([{ brief: 'b' }]))), /no `name`/);
  assert.match(refusal(checkProposal(ok([{ name: '   ', brief: 'b' }]))), /no `name`/);
  assert.match(refusal(checkProposal(ok([{ name: 'n' }]))), /no `brief`/);
  assert.match(refusal(checkProposal(ok([{ name: 'n', brief: '  ' }]))), /no `brief`/);
  assert.match(refusal(checkProposal(ok([{ name: 42, brief: 'b' }]))), /no `name`/);
});

test('the caps are what keeps a proposal reviewable, and each one refuses', () => {
  const many = Array.from({ length: PROPOSAL_MAX_JOBS + 1 }, (_, i) => ({ name: `n${i}`, brief: 'b' }));
  assert.match(refusal(checkProposal(ok(many))), new RegExp(`${PROPOSAL_MAX_JOBS + 1} Jobs`));
  // The boundary itself is allowed: a cap that refuses at its own number is off by one.
  assert.ok(!('why' in checkProposal(ok(many.slice(0, PROPOSAL_MAX_JOBS)))));

  assert.match(refusal(checkProposal(ok([{ name: 'x'.repeat(PROPOSED_NAME_MAX + 1), brief: 'b' }]))), /name is \d+ characters/);
  assert.match(refusal(checkProposal(ok([{ name: 'n', brief: 'x'.repeat(PROPOSED_BRIEF_MAX + 1) }]))), /brief is \d+ characters/);

  // The byte cap is checked before the parse, so an enormous file costs a length check and no more.
  const huge = ok([{ name: 'n', brief: 'x'.repeat(PROPOSAL_MAX_BYTES) }]);
  assert.match(refusal(checkProposal(huge)), new RegExp(`${PROPOSAL_MAX_BYTES}-byte cap`));
});

test('names and briefs are trimmed, because a trailing newline is a typo and not content', () => {
  const got = checkProposal(ok([{ name: '  spaced  ', brief: '\nthe brief\n' }]));
  assert.ok(!('why' in got));
  assert.deepEqual(got.jobs[0], { name: 'spaced', brief: 'the brief' });
});

test('storedProposal survives whatever is in the Json column', () => {
  assert.equal(storedProposal(null), null);
  assert.equal(storedProposal('a string'), null);
  assert.equal(storedProposal({}), null);
  assert.equal(storedProposal({ jobs: [] }), null);
  assert.equal(storedProposal({ jobs: [{ name: 'n' }] }), null, 'a half-written row is not a proposal');
  assert.deepEqual(storedProposal({ jobs: [{ name: 'n', brief: 'b' }] }), { jobs: [{ name: 'n', brief: 'b' }], clamped: [] });
  assert.deepEqual(
    storedProposal({ jobs: [{ name: 'n', brief: 'b' }], clamped: ['one', 2] }),
    { jobs: [{ name: 'n', brief: 'b' }], clamped: ['one'] },
  );
});

test('readProposal reads the artifact by its fixed name, and says so when it is not there', () => {
  const dir = ensureArtifactsDir(9001, 1);
  fs.writeFileSync(path.join(dir, PROPOSAL_ARTIFACT), ok([{ name: 'n', brief: 'b' }]));
  const got = readProposal(9001, 1, null);
  assert.ok(!('why' in got));
  assert.equal(got.jobs.length, 1);
  assert.equal(artifactPaths(9001, 1, [PROPOSAL_ARTIFACT])[PROPOSAL_ARTIFACT], path.join(dir, PROPOSAL_ARTIFACT));

  // Never throws: a controller that threw here would turn one Job's bad output into a failed pass.
  assert.match(refusal(readProposal(9002, 1, null)), /no `proposal\.json`/);
});

test('the gate text and the review lines are what a person actually decides on', () => {
  assert.equal(proposalGate(1), '1 Job proposed — approve to file it');
  assert.equal(proposalGate(3), '3 Jobs proposed — approve to file them');

  const p = checkProposal(ok([
    { name: 'first', brief: 'line one\nline two', maxBudgetUsd: 1.5 },
    { name: 'second', brief: `${'x'.repeat(200)}` },
  ]));
  assert.ok(!('why' in p));
  const lines = describeProposal(p);
  assert.match(lines[0], /\[0\] first {2}\[\$1\.50\]/);
  assert.match(lines[0], /line one/);
  assert.ok(!lines[0].includes('line two'), 'one line of the brief — the list is the thing being reviewed');
  assert.ok(lines[1].includes('…'), 'and a long one is cut rather than wrapped over the list');
});
