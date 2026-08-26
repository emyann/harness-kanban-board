// Terminal verb inputs: inline flags, files, and one JSON object on stdin. No GitHub calls — resolveTerminalInput is pure
// given injected readers, and the file path uses a real temp dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, resolveTerminalInput, terminalArgv } from '../src/cli.js';

let dir;
const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const stdin = (obj) => ({ readStdin: () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
const usageError = (fn, re) => assert.throws(fn, (e) => { assert.equal(e.exitCode, 2, `exitCode: ${e.message}`); assert.match(e.message, re); return true; });

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-args-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// ---------- parseArgs ----------

test('parseArgs: --from-stdin is boolean so the task number after it stays positional', () => {
  const { flags, pos } = parseArgs(['complete', '--from-stdin', '13']);
  assert.equal(flags['from-stdin'], true);
  assert.deepEqual(pos, ['complete', '13']);
  const b = parseArgs(['show', '--json', '13']);
  assert.equal(b.flags.json, true);
  assert.deepEqual(b.pos, ['show', '13']);
});

// ---------- inline ----------

test('inline: --summary, --metadata JSON, --artifacts (the original form still works)', () => {
  const { flags, pos } = parseArgs(['complete', '13', '--summary', 'did it', '--metadata', '{"changed_files":["a.js"]}', '--artifacts', 'x, y']);
  const p = resolveTerminalInput('complete', flags, pos.slice(1));
  assert.equal(p.summary, 'did it');
  assert.deepEqual(p.metadata, { changed_files: ['a.js'] });
  assert.deepEqual(p.artifacts, ['x', 'y']);
  assert.equal(p.reason, null);
});

test('inline: malformed --metadata JSON is a usage error (exit 2) naming the flag', () => {
  usageError(() => resolveTerminalInput('complete', { summary: 's', metadata: '{not json' }, ['13']), /--metadata must be a JSON object/);
  usageError(() => resolveTerminalInput('complete', { summary: 's', metadata: '[1,2]' }, ['13']), /--metadata must be a JSON object, got an array/); // "[" is inline JSON, not a path
});

test('inline: block takes the positional reason and --kind', () => {
  const { flags, pos } = parseArgs(['block', '13', 'needs the Stripe key', '--kind', 'needs_input']);
  const p = resolveTerminalInput('block', flags, pos.slice(1));
  assert.equal(p.reason, 'needs the Stripe key');
  assert.equal(p.kind, 'needs_input');
  assert.equal(p.summary, null);
});

// ---------- files ----------

test('files: --summary-file and --metadata-file are read from disk; trailing newline is trimmed', () => {
  const s = write('summary.md', 'Added stdin support.\nVerified with npm test.\n');
  const m = write('meta.json', JSON.stringify({ changed_files: ['src/cli.js', 'test/args.test.js'], verification: ['npm test'] }, null, 2) + '\n');
  const p = resolveTerminalInput('complete', { 'summary-file': s, 'metadata-file': m }, ['13']);
  assert.equal(p.summary, 'Added stdin support.\nVerified with npm test.');
  assert.deepEqual(p.metadata, { changed_files: ['src/cli.js', 'test/args.test.js'], verification: ['npm test'] });
  assert.deepEqual(p.artifacts, []);
});

test('files: --metadata <path> is read as a file when the value does not start with "{"', () => {
  const m = write('meta2.json', '{"residual_risk":["none"]}');
  const p = resolveTerminalInput('request-review', { summary: 's', metadata: m }, ['13']);
  assert.deepEqual(p.metadata, { residual_risk: ['none'] });
  const inline = resolveTerminalInput('request-review', { summary: 's', metadata: '  {"a":1}' }, ['13']);
  assert.deepEqual(inline.metadata, { a: 1 });
});

test('files: --reason-file feeds block', () => {
  const r = write('reason.txt', 'waiting on the design decision in #7\n');
  const p = resolveTerminalInput('block', { 'reason-file': r, kind: 'dependency' }, ['13']);
  assert.equal(p.reason, 'waiting on the design decision in #7');
  assert.equal(p.kind, 'dependency');
});

test('files: a missing file is a usage error that names the flag and the path', () => {
  const missing = path.join(dir, 'nope.json');
  usageError(() => resolveTerminalInput('complete', { summary: 's', 'metadata-file': missing }, ['13']), /--metadata-file: cannot read .*nope\.json \(ENOENT\)/);
  usageError(() => resolveTerminalInput('complete', { summary: 's', metadata: missing }, ['13']), /--metadata: cannot read .*nope\.json/);
  usageError(() => resolveTerminalInput('complete', { 'summary-file': path.join(dir, 'nope.md') }, ['13']), /--summary-file: cannot read/);
});

test('files: a metadata file that is not an object is refused', () => {
  const m = write('bad.json', '"just a string"');
  usageError(() => resolveTerminalInput('complete', { summary: 's', 'metadata-file': m }, ['13']), /must be a JSON object, got string/);
});

// ---------- stdin ----------

test('stdin: --from-stdin takes one JSON object {summary, metadata, artifacts}', () => {
  const io = stdin({ summary: 'done via stdin', metadata: { changed_files: ['a', 'b'], verification: ['npm test'] }, artifacts: ['dist/x'] });
  const p = resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], io);
  assert.equal(p.summary, 'done via stdin');
  assert.deepEqual(p.metadata, { changed_files: ['a', 'b'], verification: ['npm test'] });
  assert.deepEqual(p.artifacts, ['dist/x']);
});

test('stdin: block reads {reason, kind}; request-review reads {summary, reviewer}', () => {
  const b = resolveTerminalInput('block', { 'from-stdin': true }, ['13'], stdin({ reason: 'no API key', kind: 'needs_input' }));
  assert.equal(b.reason, 'no API key');
  assert.equal(b.kind, 'needs_input');
  const r = resolveTerminalInput('request-review', { 'from-stdin': true }, ['13'], stdin({ summary: 'please look', reviewer: 'codex' }));
  assert.equal(r.summary, 'please look');
  assert.equal(r.reviewer, 'codex');
});

test('stdin: the done-when payload — the exact bytes printf would send', () => {
  const text = '{"summary":"...","metadata":{"changed_files":["src/cli.js"]}}';
  const p = resolveTerminalInput('complete', { 'from-stdin': true }, ['1'], stdin(text));
  assert.equal(p.summary, '...');
  assert.deepEqual(p.metadata, { changed_files: ['src/cli.js'] });
});

test('stdin: empty, malformed, non-object, or unknown keys are usage errors', () => {
  usageError(() => resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin('')), /nothing on stdin/);
  usageError(() => resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin('{oops')), /--from-stdin must be a JSON object/);
  usageError(() => resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin('[]')), /got an array/);
  usageError(() => resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin({ summmary: 'typo' })), /unknown key\(s\) summmary — allowed: summary, metadata/);
  usageError(() => resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin({ summary: 's', metadata: [1] })), /"metadata" must be a JSON object/);
  usageError(() => resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin({ summary: 's', artifacts: [1] })), /"artifacts" must be a list of strings/);
  const p =resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin({ summary: 's', artifacts: 'a,b' }));
  assert.deepEqual(p.artifacts, ['a', 'b'], 'a comma string is accepted for artifacts');
});

// ---------- precedence + replay ----------

test('precedence: inline > file > stdin, per field', () => {
  const s = write('p-summary.md', 'from file');
  const m = write('p-meta.json', '{"from":"file"}');
  const io = stdin({ summary: 'from stdin', metadata: { from: 'stdin' }, artifacts: ['stdin'] });
  const p = resolveTerminalInput('complete', { 'from-stdin': true, summary: 'inline', 'metadata-file': m }, ['13'], io);
  assert.equal(p.summary, 'inline');
  assert.deepEqual(p.metadata, { from: 'file' });
  assert.deepEqual(p.artifacts, ['stdin']);
  const q = resolveTerminalInput('complete', { 'from-stdin': true, 'summary-file': s, metadata: '{"from":"inline"}' }, ['13'], io);
  assert.equal(q.summary, 'from file');
  assert.deepEqual(q.metadata, { from: 'inline' });
});

test('missing summary stays null here; lifecycle.js is the one that refuses it', () => {
  const p = resolveTerminalInput('complete', {}, ['13']);
  assert.equal(p.summary, null);
  assert.deepEqual(p.metadata, {});
  const q = resolveTerminalInput('complete', { summary: true }, ['13']); // bare --summary with no value
  assert.equal(q.summary, null);
});

test('terminalArgv: the outbox replay form is inline and self-contained', () => {
  const p = resolveTerminalInput('complete', { 'from-stdin': true }, ['13'], stdin({ summary: 'S', metadata: { a: [1] }, artifacts: ['x'] }));
  assert.deepEqual(terminalArgv('complete', 13, p, { board: 'default', attempt: 2 }),
    ['complete', '13', '--summary', 'S', '--metadata', '{"a":[1]}', '--artifacts', 'x', '--board', 'default', '--attempt', '2']);
  const b = resolveTerminalInput('block', { 'from-stdin': true }, ['13'], stdin({ reason: 'why', kind: 'transient' }));
  assert.deepEqual(terminalArgv('block', 13, b, { board: 'default' }), ['block', '13', 'why', '--kind', 'transient', '--board', 'default']);
  const r = resolveTerminalInput('request-review', { summary: 'look', reviewer: 'codex' }, ['13']);
  assert.deepEqual(terminalArgv('request-review', 13, r), ['request-review', '13', '--summary', 'look', '--reviewer', 'codex']);
  // round trip: replaying the inline argv resolves to the same payload
  const { flags, pos } = parseArgs(terminalArgv('complete', 13, p, {}));
  assert.deepEqual(resolveTerminalInput('complete', flags, pos.slice(1)), p);
});
