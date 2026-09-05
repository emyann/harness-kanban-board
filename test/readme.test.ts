import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { main } from '../src/hkb.ts';
import { MACHINE_DB_PATH } from '../src/db-url.ts';

/**
 * The README's `hkb` section documents a CLI that is still being built, so the failure worth
 * guarding is drift: a verb renamed or dropped, still promised to a reader who cannot check.
 * Written as a refusal — the section may not name a verb `hkb --help` does not list, and may not
 * name a board path that is not where the code puts the board.
 */

const README = fs.readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf8');

/** The section, from its heading to the next one. */
const section = (() => {
  const start = README.indexOf('## `hkb` — the workload scheduler');
  assert.notEqual(start, -1, 'README.md has no `hkb` section — a reader arriving today finds only the retired CLI');
  const end = README.indexOf('\n## ', start + 1);
  return README.slice(start, end === -1 ? undefined : end);
})();

/** `hkb --help`, captured. `main` prints it and returns before it opens a board, so there is none to make. */
async function help(): Promise<string> {
  // `node --test` multiplexes its own reporter frames over this stream; pass them through, as test/hkb.test.ts does.
  const RUNNER_FRAME = /\btest:(enqueue|dequeue|start|pass|fail|plan|diagnostic|complete|coverage|stderr|stdout|watch)\b/;
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    const text = String(s);
    // Forwarded, not dropped. Swallowing a frame does not just lose a line: the parent process's
    // reporter is a state machine over that stream, and a missing `test:start` crashes it
    // (`assert(subtest.data.name === data.name)`) after every subtest has already passed.
    if (RUNNER_FRAME.test(text)) return write(s as never);
    chunks.push(text);
    return true;
  };
  try {
    await main([]);
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }
  return chunks.join('');
}

test('the README\'s hkb section names no verb the CLI does not have', async () => {
  const text = await help();
  // A *documented command*, not every sentence with the word `hkb` in it: either backticked, which
  // is how the prose and the verb table name one, or at the start of a line, which is how the
  // fenced examples do. "hkb reads pull requests back through it" is prose about the tool and is
  // not a promise that `hkb reads` exists.
  const named = [...new Set([...section.matchAll(/(?:^|`)hkb ([a-z][a-z-]*)/gm)].map((m) => m[1]))];
  assert.ok(named.length >= 4, `only ${named.length} verbs found in the section — the regex or the section moved`);
  for (const verb of named) {
    assert.ok(
      text.includes(`hkb ${verb}`),
      `README documents \`hkb ${verb}\`, which \`hkb --help\` does not list — rename it in both or drop it from the README`,
    );
  }
});

test('the README\'s board path is the one the code uses', () => {
  assert.ok(
    section.includes('~/.hkb/board.db'),
    'the section must say where the board is; the code puts it at ' + MACHINE_DB_PATH,
  );
  assert.ok(
    MACHINE_DB_PATH.endsWith(path.join('.hkb', 'board.db')),
    `the board moved to ${MACHINE_DB_PATH} — the README still says ~/.hkb/board.db`,
  );
  assert.ok(
    section.includes('HKB_DATABASE_URL'),
    'the section must name the override, or a reader has no way to point hkb at another board',
  );
});
