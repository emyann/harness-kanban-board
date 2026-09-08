import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readTemplate, workflowPath, placeholders, WORKFLOW_DIR, TEMPLATE_KEYS, TEMPLATE_MAX_BYTES } from '../src/templates.ts';

/**
 * The format is machinery (ADR-015 decision 3), so what is tested here is what it REFUSES.
 *
 * Every guard in this project that turned out to be silently inert was inert because nothing tested
 * that it said no — so a workflow that sets an unknown key, that escapes the repository, that says
 * one thing twice or that has no brief each gets a test asserting the refusal and the fix in it.
 * Accepting a good file is one test; the other twenty are the product.
 */

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hkb-tpl-'));
  fs.mkdirSync(path.join(dir, WORKFLOW_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return dir;
}

const wf = (body: string) => `${WORKFLOW_DIR}/${body}`;

const GOOD = `---
name: draft
description: Draft one page
model: claude-opus-5
max-budget: 2
allow-tool: [Read, Grep, Write]
guide: CLAUDE.md
plugin-dir: [.claude]
gate: does this page earn its place?
---

Draft ONE page about {{page}}.
`;

const why = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.equal((e as { exitCode?: number }).exitCode, 2, 'a bad workflow is a usage error, exit 2');
    return (e as Error).message;
  }
  return assert.fail('expected a refusal, got none');
};

test('a workflow parses into flags and a brief', () => {
  const dir = repo({ [wf('draft.md')]: GOOD });
  const t = readTemplate(dir, 'draft');
  assert.equal(t.name, 'draft');
  assert.equal(t.description, 'Draft one page');
  assert.deepEqual(t.spec, {
    model: 'claude-opus-5',
    'max-budget': '2',
    'allow-tool': ['Read', 'Grep', 'Write'],
    guide: 'CLAUDE.md',
    'plugin-dir': ['.claude'],
    gate: 'does this page earn its place?',
  });
  assert.equal(t.brief, 'Draft ONE page about {{page}}.');
  // The keys are the flags: `--from` sets nothing `hkb new` does not already have a name for.
  for (const k of Object.keys(t.spec)) assert.ok(k in TEMPLATE_KEYS, `${k} is not a flag`);
});

test('a trailing .md is accepted, because that is what a tab-completing author types', () => {
  const dir = repo({ [wf('draft.md')]: GOOD });
  assert.equal(readTemplate(dir, 'draft.md').name, 'draft');
});

test('a workflow that is not there names the path it looked for, and what is', () => {
  const dir = repo({ [wf('draft.md')]: GOOD, [wf('other.md')]: GOOD.replace('name: draft', 'name: other') });
  const msg = why(() => readTemplate(dir, 'missing'));
  assert.match(msg, /no workflow `missing`/);
  assert.ok(msg.includes(path.join(dir, WORKFLOW_DIR, 'missing.md')), `the refusal must name the path: ${msg}`);
  assert.match(msg, /`draft`/);
  assert.match(msg, /`other`/);
});

test('an empty workflow directory says what a workflow IS rather than listing nothing', () => {
  const dir = repo({});
  assert.match(why(() => readTemplate(dir, 'draft')), /Nothing is in \.hkb\/workflows\/ yet/);
});

test('a board with no repository is refused, with the command that gives it one', () => {
  assert.match(why(() => readTemplate(null, 'draft')), /hkb boards add/);
});

// --- the fence ------------------------------------------------------------

test('a name cannot climb out of the workflow directory', () => {
  for (const bad of ['../../etc/passwd', 'a/b', './draft', '..', 'wiki/draft']) {
    assert.match(why(() => workflowPath(bad)), /not a workflow name/, `${bad} was allowed`);
  }
});

test('a workflow that is a symlink out of the repository is refused', () => {
  const dir = repo({ [wf('draft.md')]: GOOD });
  const outside = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hkb-out-')), 'evil.md');
  fs.writeFileSync(outside, GOOD.replace('name: draft', 'name: evil'));
  fs.symlinkSync(outside, path.join(dir, WORKFLOW_DIR, 'evil.md'));
  assert.match(why(() => readTemplate(dir, 'evil')), /resolves outside the repository/);
});

// --- the keys are the flags ----------------------------------------------

test('a key that is not a flag is refused BY NAME, and the message lists the ones that are', () => {
  const dir = repo({ [wf('draft.md')]: '---\nname: draft\ntimeout: 30\n---\nbody\n' });
  const msg = why(() => readTemplate(dir, 'draft'));
  assert.match(msg, /`timeout` is not a key a workflow has/);
  assert.match(msg, /max-budget/);
  assert.match(msg, /hkb --help/);
});

test('the keys a workflow may set are all flags `hkb new` parses', async () => {
  // The claim this whole format rests on, checked against the parser rather than against a list
  // written twice: a key here that `hkb new` does not accept is a key nobody could have filed by hand.
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'hkb.ts'), 'utf8');
  for (const key of Object.keys(TEMPLATE_KEYS)) {
    assert.ok(
      new RegExp(`^\\s+'?${key}'?: \\{ type:`, 'm').test(src),
      `\`${key}\` is a workflow key but not an option \`hkb new\` parses`,
    );
  }
});

test('`brief` and `board` are refused with their own reason, not as unknown keys', () => {
  const brief = repo({ [wf('d.md')]: '---\nname: d\nbrief: hello\n---\nbody\n' });
  assert.match(why(() => readTemplate(brief, 'd')), /the BODY of the file is the brief/);
  const board = repo({ [wf('d.md')]: '---\nname: d\nboard: other\n---\nbody\n' });
  assert.match(why(() => readTemplate(board, 'd')), /operator's choice, not the workflow's/);
});

test('a scalar where a list belongs is one item; a list where a scalar belongs is refused', () => {
  const one = repo({ [wf('d.md')]: '---\nname: d\nallow-tool: Read\n---\nbody\n' });
  assert.deepEqual(readTemplate(one, 'd').spec['allow-tool'], ['Read']);
  const many = repo({ [wf('d.md')]: '---\nname: d\nmodel: [a, b]\n---\nbody\n' });
  assert.match(why(() => readTemplate(many, 'd')), /`model` takes one value, not a list/);
});

test('a shell `[ … ]` test is a command, not a list — the brackets are part of the value', () => {
  // `check: [ -f dist/index.js ]` is the POSIX spelling of `test -f dist/index.js`. The generic
  // bracket rule read it as a list and refused it with a suggested fix — `check: -f dist/index.js`
  // — that would have filed a command exiting 127 on every attempt of that Job.
  const t = repo({ [wf('d.md')]: '---\nname: d\ncheck: [ -f dist/index.js ]\n---\nbody\n' });
  assert.equal(readTemplate(t, 'd').spec.check, '[ -f dist/index.js ]');

  // And an actual list mistake is still refused — with quoting named as the other fix, because for
  // a value whose brackets are real, stripping them is the wrong repair.
  const many = repo({ [wf('d.md')]: '---\nname: d\ncheck: [a, b]\n---\nbody\n' });
  const said = why(() => readTemplate(many, 'd'));
  assert.match(said, /`check` takes one value, not a list/);
  assert.match(said, /quote it: `check: "\[a, b\]"`/);

  // A key that really does take a list is untouched by the exemption.
  const list = repo({ [wf('d.md')]: '---\nname: d\nallow-tool: [Read, Grep]\n---\nbody\n' });
  assert.deepEqual(readTemplate(list, 'd').spec['allow-tool'], ['Read', 'Grep']);
});

test('a switch is true or false and nothing else', () => {
  const yes = repo({ [wf('d.md')]: '---\nname: d\ntriage: true\npropose: false\n---\nbody\n' });
  assert.deepEqual(readTemplate(yes, 'd').spec, { triage: true, propose: false });
  const no = repo({ [wf('d.md')]: '---\nname: d\ntriage: yes\n---\nbody\n' });
  assert.match(why(() => readTemplate(no, 'd')), /`triage` is a switch/);
});

// --- the grammar ----------------------------------------------------------

test('a file with no frontmatter is refused, and told what the two halves are', () => {
  const dir = repo({ [wf('d.md')]: 'just a brief\n' });
  assert.match(why(() => readTemplate(dir, 'd')), /does not begin with a `---` line/);
});

test('frontmatter that is never closed is refused', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\nmodel: x\n' });
  assert.match(why(() => readTemplate(dir, 'd')), /never closes it/);
});

test('a block list is refused, with the line number and the one-line form', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\nallow-tool:\n  - Read\n---\nbody\n' });
  const msg = why(() => readTemplate(dir, 'd'));
  assert.match(msg, /line 3/);
  assert.match(msg, /has no value/);
});

test('a line that is not `key: value` is refused by its number', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\nthis is prose\n---\nbody\n' });
  const msg = why(() => readTemplate(dir, 'd'));
  assert.match(msg, /line 3/);
  assert.match(msg, /is not `key: value`/);
});

test('a key set twice is refused rather than last-one-wins', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\nmodel: a\nmodel: b\n---\nbody\n' });
  assert.match(why(() => readTemplate(dir, 'd')), /set twice/);
});

test('a `name:` that disagrees with the filename is refused', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: copied-from-elsewhere\n---\nbody\n' });
  assert.match(why(() => readTemplate(dir, 'd')), /but the file is `d\.md`/);
});

test('blank lines and # comments are ignored; a colon in a value is not a separator', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\n\n# why this model\nmodel: a\ngate: is this right: yes or no?\n---\nbody\n' });
  const t = readTemplate(dir, 'd');
  assert.deepEqual(t.spec, { model: 'a', gate: 'is this right: yes or no?' });
});

test('quotes are stripped, in a scalar and in a list', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\ngate: "is it?"\nallow-tool: ["Read", \'Write\']\n---\nbody\n' });
  const t = readTemplate(dir, 'd');
  assert.equal(t.spec.gate, 'is it?');
  assert.deepEqual(t.spec['allow-tool'], ['Read', 'Write']);
});

test('a key with no value is refused rather than read as empty', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\nmodel:\n---\nbody\n' });
  assert.match(why(() => readTemplate(dir, 'd')), /`model` has no value/);
});

test('an empty list is refused — absence is how a workflow says nothing', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\nallow-tool: []\n---\nbody\n' });
  assert.match(why(() => readTemplate(dir, 'd')), /empty list/);
});

test('frontmatter with no body is refused: the body IS the brief', () => {
  const dir = repo({ [wf('d.md')]: '---\nname: d\nmodel: a\n---\n\n   \n' });
  assert.match(why(() => readTemplate(dir, 'd')), /has frontmatter and no body/);
});

test('a workflow over the cap is refused, and pointed at the guide instead', () => {
  const dir = repo({ [wf('d.md')]: `---\nname: d\n---\n${'x'.repeat(TEMPLATE_MAX_BYTES + 1)}\n` });
  const msg = why(() => readTemplate(dir, 'd'));
  assert.match(msg, new RegExp(`over the ${TEMPLATE_MAX_BYTES}-byte cap`));
  assert.match(msg, /contributor guide/);
});

// --- placeholders ---------------------------------------------------------

test('placeholders are found once each, dotted paths by their root', () => {
  assert.deepEqual(placeholders('a {{page}} b {{ spine }} c {{page}} d {{x.y.z}}').sort(), ['page', 'spine', 'x']);
  assert.deepEqual(placeholders('nothing here'), []);
});

// --- the dogfood ----------------------------------------------------------

test('this repository`s own workflows parse, and come through the user door', () => {
  // ADR-015 decision 4: hkb's own workflows are ordinary workflows. The failure that rule exists to
  // prevent is a user door nobody walks through — so the guard is that OUR files are read by the
  // same `readTemplate` a user's are, from the same directory, with no privileged path in between.
  const REPO = path.resolve(import.meta.dirname, '..');
  const dir = path.join(REPO, WORKFLOW_DIR);
  const ours = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.ok(ours.includes('draft-wiki-page'), 'the repository ships no workflow of its own — decision 4 is a declaration nothing enforces');

  for (const name of ours) {
    const t = readTemplate(REPO, name);
    assert.ok(t.description, `${name} has no description — it is the line a person reads when choosing`);
    assert.ok(t.brief.length > 200, `${name} has a brief too short to be one`);
  }

  // And nothing ships in the package: a workflow is repository content, not a file the CLI reads
  // out of its own tarball, so it is deliberately absent from `files`.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { files: string[] };
  assert.ok(
    !pkg.files.some((f) => f.replace(/^\.\//, '').startsWith('.hkb')),
    'a workflow reached `files` — hkb\'s own workflows are content in this repository, not a privileged path in the package',
  );
});

test('the shipped workflow declares every placeholder its brief refers to', () => {
  // The other half of the dogfood: a workflow whose brief says `{{page}}` is unfileable without
  // `--input page=value:…`, and the only place that contract is written down is the brief itself.
  const t = readTemplate(path.resolve(import.meta.dirname, '..'), 'draft-wiki-page');
  assert.deepEqual(placeholders(t.brief).sort(), ['cover', 'page', 'sources', 'wrong']);
});
