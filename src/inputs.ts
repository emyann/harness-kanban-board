import fs from 'node:fs';
import path from 'node:path';

/**
 * `inputs` — the read side, and the half ADR-008 never had.
 *
 * ADR-008 gave a Job three ways to hand something over. It gave it **one** way to receive anything:
 * `job.brief`, a string authored at file time and composed only with the protocol, the results
 * contract and the artifacts contract (`src/brief.ts`). Everything else a run knows, it goes and
 * finds — in a worktree it was handed whole.
 *
 * `docs/workflow-study.md` §7 is where this stops being symmetry for its own sake. Artic compiles a
 * workflow into steps that declare the artifacts they read *and* write, and its measured gains come
 * from **the read side** — a reported −63% input tokens and +56 percentage points of
 * repeated-execution consistency. The study's conclusion is the one that matters here: declared
 * inputs *"are not primarily for ordering, they are for **context restriction**"*.
 *
 * ## The thing this is deliberately not
 *
 * The obvious source is another Job's output — `--input plan=#42.plan`. **That is `Job.after` with a
 * payload, and `Job.after` was rejected rather than deferred** (study §2, on four independent counts:
 * it is a `Link` table with arity 1; no core Kubernetes object depends on a sibling of its own kind;
 * the Job controller would have to write another Job's status, which `src/controller.ts` forbids
 * itself in writing; and `after: succeeded` gates on a phase this codebase documents as carrying no
 * judgement). So no source here waits for anything. Both of them read state that is already there,
 * which is the same discipline the controller itself runs on.
 *
 * ## Why the restriction is real rather than hoped for
 *
 * Injecting context does not restrict anything on its own — a worker with `Read` can still go and
 * find whatever it likes, and the study's own layer table puts prompt text at layer 6, *"guarantees
 * nothing; measured guaranteeing nothing twice"*. What makes this the read side and not a
 * convenience is that it **composes with a guard that can refuse**: a Job declared with its inputs
 * and `--allow-tool` narrowed to exclude `Read`, `Glob` and `Grep` sees exactly what it was given and
 * cannot reach further, because `src/admission.ts` denies the rest at layer 2 — *"the only layer that
 * held when `permissionMode` did not"*. Neither half is the feature. The pair is.
 */

/** One declared input: a name the prompt labels it with, and where its content comes from. */
export type InputSpec = { name: string; source: string };

/** What an input actually resolved to, for the prompt and for the Attempt's catalogue. */
export type ResolvedInput = { name: string; source: string; text: string };

export type ResolvedInputs = {
  resolved: ResolvedInput[];
  /** Declared and unresolvable. These fail the attempt BEFORE the run — see `src/controller.ts`. */
  missing: { name: string; source: string; why: string }[];
};

/**
 * The cap, per input, in bytes.
 *
 * Larger than a result's 4 KB because this is a whole file rather than a value, and much smaller
 * than no cap at all because **an input is paid for on every request of the run**, not once: it sits
 * in the prompt, and compaction is what happens to prompts that do not fit. A cap that let a Job
 * inject a megabyte would spend the budget the feature exists to save.
 */
export const INPUT_MAX_BYTES = 64 * 1024;

/** How many Jobs a `board:` input describes. A ceiling on rows as well as bytes, so the shape of the
 * rendering does not depend on how busy the board happens to be. */
export const BOARD_INPUT_ROWS = 50;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `name=source`, checked — or a refusal.
 *
 * Checked at file time, before a worktree exists, for the reason every other declaration is: this
 * one names a file the board will read with the operator's authority and put in front of a model, so
 * a source that was never legal must not become state.
 */
export function checkInputSpec(raw: string): InputSpec {
  const text = String(raw ?? '').trim();
  const refuse = (why: string): never => {
    const e = new Error(
      `${why} An input is \`name=source\`, where source is \`file:<repo-relative-path>\` or \`board\` — as in \`--input schema=file:prisma/schema.prisma\`.`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  };
  if (!text) refuse('an input is empty.');
  const eq = text.indexOf('=');
  if (eq < 1) refuse(`the input ${JSON.stringify(raw)} has no name — write \`name=source\`.`);
  const name = text.slice(0, eq).trim();
  const source = text.slice(eq + 1).trim();
  if (!NAME.test(name)) {
    refuse(`the input name ${JSON.stringify(name)} is not a plain identifier, so it cannot label a block in the prompt.`);
  }
  if (!source) refuse(`the input \`${name}\` names no source.`);

  if (source === 'board') return { name, source };
  if (source.startsWith('file:')) {
    checkInputPath(source.slice(5), refuse);
    return { name, source: `file:${normalizeInputPath(source.slice(5))}` };
  }
  // Named explicitly rather than falling through to "unknown source", because the source everyone
  // reaches for first is the one that does not exist and is not going to.
  if (/^#?\d+\./.test(source) || source.startsWith('job:') || source.startsWith('result:')) {
    refuse(
      `the input \`${name}\` reads another Job's output, and hkb has no such source. An input that waits for a`
      + ' sibling Job is an ordering edge, and ordering between workloads belongs to a kind whose controller'
      + ' creates them (ADR-007 decision 5) — it was rejected as a field, not deferred.',
    );
  }
  return refuse(`the input \`${name}\` names the unknown source ${JSON.stringify(source)}.`);
}

/** Repo-relative, and none of the three ways out. The same fence `checkExportPath` puts on a path. */
function checkInputPath(rel: string, refuse: (why: string) => never): void {
  const p = String(rel ?? '').trim();
  if (!p) refuse('a `file:` input names no path.');
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    refuse(`the input path ${JSON.stringify(p)} is absolute. An input is read relative to the board's repository.`);
  }
  const norm = path.normalize(p).replace(/[\\/]+$/, '');
  if (!norm || norm === '.') refuse(`the input path ${JSON.stringify(p)} names the whole repository rather than a file.`);
  if (/^\.\.([\\/]|$)/.test(norm)) {
    refuse(`the input path ${JSON.stringify(p)} escapes the repository — a declaration is not a licence to read anywhere.`);
  }
  if (norm === '.hkb' || norm.startsWith(`.hkb${path.sep}`)) {
    refuse(`the input path ${JSON.stringify(p)} is inside .hkb/ — the board's own directory, which is not a Job's to read.`);
  }
}

const normalizeInputPath = (rel: string): string =>
  path.normalize(String(rel).trim()).replace(/[\\/]+$/, '').split(path.sep).join('/');

/** The specs a Job declared, off the `Json?` column, defensively. */
export function declaredInputs(value: unknown): InputSpec[] {
  if (!Array.isArray(value)) return [];
  const out: InputSpec[] = [];
  for (const v of value) {
    if (typeof v === 'string') { try { out.push(checkInputSpec(v)); } catch { /* not ours to fail on */ } continue; }
    if (v && typeof v === 'object') {
      const { name, source } = v as { name?: unknown; source?: unknown };
      if (typeof name === 'string' && typeof source === 'string' && NAME.test(name)) out.push({ name, source });
    }
  }
  return out;
}

/**
 * One Job, as a `board:` input sees it. Deliberately the fields `hkb ls` already computes.
 *
 * This is ADR-010 decision 5's *"board arithmetic"* — which Jobs have sat pending, which succeeded
 * and produced nothing, which keep capping on budget. **LLM-free, and one board read**, which is
 * what lets a Job reason about the board without a second model deciding what the board says.
 */
export type BoardRow = {
  id: number;
  name: string;
  phase: string;
  attempts: number;
  lastOutcome: string | null;
  producedNothing: boolean;
};

/**
 * Render the board as a table a model can read and a human can check.
 *
 * Pure, so the projection is testable without a database — the same reason `pickPr` and `gateClaim`
 * are pure. A rendering that drifts from what `hkb ls` shows is a rendering nobody can verify.
 */
export function renderBoard(rows: BoardRow[]): string {
  if (!rows.length) return 'This board has no other Jobs.';
  const shown = rows.slice(0, BOARD_INPUT_ROWS);
  const w = Math.max(...shown.map((r) => r.phase.length));
  const lines = shown.map((r) =>
    `#${String(r.id).padEnd(5)} ${r.phase.padEnd(w)} ${String(r.attempts).padStart(2)}x  ${r.name}`
    + (r.lastOutcome ? `  [${r.lastOutcome}]` : '')
    + (r.producedNothing ? '  — produced nothing' : ''));
  // Said, not silently dropped: a truncated list a reader believes is complete is worse than a short
  // one that says so, and this one is being handed to something that cannot go and check.
  if (rows.length > shown.length) lines.push(`… and ${rows.length - shown.length} more, not shown.`);
  return lines.join('\n');
}

/**
 * Read one `file:` input, or say why not.
 *
 * The realpath containment check is the half a syntax rule cannot make, and it is the same question
 * `refuseOutside` asks of an export: a repository can contain a symlink, and `docs/notes -> /etc`
 * passes every string test above.
 */
export function readFileInput(repoPath: string, rel: string): { text: string } | { why: string } {
  let root: string;
  try {
    root = fs.realpathSync(repoPath);
  } catch {
    return { why: `the board's repository ${repoPath} is not there` };
  }
  const abs = path.resolve(root, rel);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { why: `no such file in the repository: ${rel}` };
  }
  if (!real.startsWith(root + path.sep)) return { why: `${rel} resolves outside the repository` };
  const st = fs.statSync(real);
  if (!st.isFile()) return { why: `${rel} is not a file` };
  if (st.size > INPUT_MAX_BYTES) {
    return { why: `${rel} is ${st.size} bytes, over the ${INPUT_MAX_BYTES}-byte input cap — an input is paid for on every request of the run, so this one belongs in the worktree the run can read` };
  }
  return { text: fs.readFileSync(real, 'utf8') };
}

/** What a Job that declared an input the board could not resolve owes the operator. */
export function missingInputs(id: number, missing: { name: string; why: string }[]): string | null {
  if (!missing.length) return null;
  const one = missing.length === 1;
  return `#${id} declared ${one ? 'an input' : 'inputs'} the board could not read — `
    + missing.map((m) => `\`${m.name}\`: ${m.why}`).join('; ')
    + `. The attempt did not start: a run given less than it declared is not the run that was filed.`;
}
