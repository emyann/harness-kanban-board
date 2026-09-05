import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { main } from '../src/kb.ts';
import { MACHINE_DB_PATH } from '../src/db-url.ts';

/**
 * The README's `kb` section documents a CLI that is still being built, so the failure worth
 * guarding is drift: a verb renamed or dropped, still promised to a reader who cannot check.
 * Written as a refusal — the section may not name a verb `kb --help` does not list, and may not
 * name a board path that is not where the code puts the board.
 */

const README = fs.readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf8');

/** The section, from its heading to the next one — so the pre-ADR-007 prose below is not scanned. */
const section = (() => {
  const start = README.indexOf('## `kb` — the workload scheduler');
  assert.notEqual(start, -1, 'README.md has no `kb` section — a reader arriving today finds only the retired CLI');
  const end = README.indexOf('\n## ', start + 1);
  return README.slice(start, end === -1 ? undefined : end);
})();

/** `kb --help`, captured. `main` prints it and returns before it opens a board, so there is none to make. */
async function help(): Promise<string> {
  // `node --test` multiplexes its own reporter frames over this stream; pass them through rather
  // than capturing them, as test/kb.test.ts does — a swallowed frame takes the run's report with it.
  const RUNNER_FRAME = /\btest:(enqueue|dequeue|start|pass|fail|plan|diagnostic|complete|coverage|stderr|stdout|watch)\b/;
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    const text = String(s);
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

test('the README\'s kb section names no verb the CLI does not have', async () => {
  const text = await help();
  const named = [...new Set([...section.matchAll(/\bkb ([a-z][a-z-]*)/g)].map((m) => m[1]))];
  assert.ok(named.length >= 4, `only ${named.length} verbs found in the section — the regex or the section moved`);
  for (const verb of named) {
    assert.ok(
      text.includes(`kb ${verb}`),
      `README documents \`kb ${verb}\`, which \`kb --help\` does not list — rename it in both or drop it from the README`,
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
    'the section must name the override, or a reader has no way to point kb at another board',
  );
});
