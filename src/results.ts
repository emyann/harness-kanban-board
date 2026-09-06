import fs from 'node:fs';
import path from 'node:path';

import { boardDir } from './db-url.ts';

/**
 * `results` — the half of ADR-008 that was decided and never shipped.
 *
 * A Job declares `exports` for **paths**, copied out of the worktree into the repository, and
 * `results` for **named, small, structured values** the board keeps on the Attempt. The split is
 * the one Tekton lives with rather than works around: a handoff that can hold a megabyte becomes a
 * worse artifact store, so the size cap is the feature and not a limitation to route around.
 *
 * This is what a Job produces when it is **not coupled to a commit**. "I investigated and there is
 * nothing to change" is a real outcome; so is a report, a decision, a number. Without somewhere to
 * put it, such a Job succeeds and leaves nothing but a session id — which is the complaint
 * `producedNothing` (`src/hkb.ts`) can only state, not answer.
 *
 * It is also what a later reader consumes. ADR-008: *"this is what a later graph node reads —
 * 'review the pull request the previous node opened' needs `results.prUrl`, not prose"* — and what
 * a gated Job's approver reads before deciding (ADR-010).
 */

/**
 * The cap, per result, in bytes.
 *
 * Tekton's is 4096 across all of a Task's results, riding the container termination message; ours is
 * per result because we are not squeezing through that channel. The number is inherited on purpose:
 * it is small enough that nobody mistakes this for file storage, which is what `exports` is for, and
 * an oversized result therefore has an obvious remedy rather than a workaround.
 */
export const RESULT_MAX_BYTES = 4096;

/** The names a Job declared, read back out of its JSON column. Defensive: the column is `Json?`. */
export function declaredResults(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
}

/**
 * A result name must be a plain identifier.
 *
 * It becomes a filename the worker is told to write and a key on a JSON object the board keeps, so
 * anything that could traverse a directory or collide with a key is refused at declaration time —
 * before a worktree is cut, which is the same fence `checkExportPath` sits behind.
 */
export function checkResultName(raw: string): string {
  const name = String(raw ?? '').trim();
  const refuse = (why: string): never => {
    const e = new Error(
      `${why} A result name is a plain identifier — letters, digits, dash, underscore — as in \`--result finding\`.`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  };
  if (!name) refuse('a result name is empty.');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    refuse(`the result name ${JSON.stringify(raw)} is not a plain identifier, so it cannot be a filename or a key.`);
  }
  if (name.length > 64) refuse(`the result name ${JSON.stringify(raw)} is longer than 64 characters.`);
  return name;
}

/**
 * Where an attempt's results are collected — **outside every checkout, on purpose.**
 *
 * Not in the worktree: the worker's diff is the reviewable artifact, and a scratch directory in it
 * is either committed by accident or shows up as untracked noise in every `git status` a reviewer
 * runs. Not in the repository either, for the same reason. It lives beside the board, is created
 * per attempt, and is removed once the values are read — the values themselves are durable because
 * they are on the Attempt row, not because the file survives.
 */
export const resultsDir = (jobId: number, k: number): string =>
  path.join(boardDir(), 'results', `${jobId}-${k}`);

/** Create the collection directory. Called before the run, because its paths go into the prompt. */
export function ensureResultsDir(jobId: number, k: number): string {
  const dir = resultsDir(jobId, k);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The absolute path the worker is told to write each declared result to. */
export function resultPaths(jobId: number, k: number, names: string[]): Record<string, string> {
  const dir = resultsDir(jobId, k);
  return Object.fromEntries(names.map((n) => [n, path.join(dir, n)]));
}

export type Collected = {
  /** Everything the run wrote: the declared values, plus whatever it volunteered. */
  produced: Record<string, string>;
  /** Declared and not written. These fail the attempt. */
  missing: string[];
  /** Over the cap. Declared or not, an oversized value is dropped rather than truncated. */
  oversize: { name: string; bytes: number }[];
  /** Written but never declared — kept, never required. See `collectResults`. */
  volunteered: string[];
};

/**
 * Read back what the run wrote. Presence and size only — never meaning.
 *
 * ADR-008's cheapness is the point: a result is present or it is not, which needs no judgement and
 * no second model. What this deliberately does NOT do is decide whether the value is any *good* —
 * `succeeded` remains a fact about the process, and whether the work is right stays a judgement that
 * belongs to whoever reads it.
 *
 * **Two layers, and the difference is who chose the field.** A *declared* name is the filer's
 * requirement and its absence fails the attempt. Anything else the run left in the directory is
 * **volunteered**: kept, reported, and never required. Hermes' handoff is the second layer alone —
 * freeform metadata the worker defines — which is richer than a declaration and guarantees nothing,
 * since a downstream reader cannot rely on a key existing. Requiring everything is the opposite
 * failure: a Job cannot then say it noticed something nobody thought to ask about.
 *
 * So the directory is read whole, and only the declared half is enforced. The cap applies to both,
 * because a 40 MB volunteered value is a file, and files are what `exports` is for.
 */
export function collectResults(jobId: number, k: number, names: string[]): Collected {
  const out: Collected = { produced: {}, missing: [], oversize: [], volunteered: [] };
  const dir = resultsDir(jobId, k);
  const declared = new Set(names);

  // Everything on disk, not just what was asked for. `withFileTypes` so a directory named like a
  // result is not read as one, and a missing directory is a run that wrote nothing rather than an
  // error — the declared names below still report as missing, which is the accurate account.
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { /* nothing written */ }

  for (const e of entries) {
    if (!e.isFile()) continue;
    // A volunteered name still has to be usable as a JSON key and a filename. The declaration path
    // is checked at file time (`checkResultName`); this is the same fence for the half nobody
    // declared, and a name that fails it is ignored rather than failing someone else's attempt.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const size = fs.statSync(file).size;
    if (size > RESULT_MAX_BYTES) { out.oversize.push({ name: e.name, bytes: size }); continue; }
    out.produced[e.name] = fs.readFileSync(file, 'utf8').trim();
    if (!declared.has(e.name)) out.volunteered.push(e.name);
  }

  // Declared and not produced. Computed from what came back rather than by stat-ing again, so the
  // two halves cannot disagree: an oversized declared value is a shortfall too, and is reported as
  // its own cause rather than silently as a missing one.
  const over = new Set(out.oversize.map((o) => o.name));
  out.missing = names.filter((n) => !(n in out.produced) && !over.has(n));
  out.volunteered.sort();
  return out;
}

/** Remove an attempt's collection directory. Best effort: the values are already on the row. */
export function clearResults(jobId: number, k: number): void {
  fs.rmSync(resultsDir(jobId, k), { recursive: true, force: true });
}

/** What a Job that declared a result and did not produce it owes the operator. */
export function missingResults(id: number, missing: string[], oversize: { name: string; bytes: number }[]): string | null {
  const parts: string[] = [];
  if (missing.length) {
    const one = missing.length === 1;
    parts.push(`declared ${missing.map((m) => `\`${m}\``).join(', ')} and the run left ${one ? 'it' : 'them'} unwritten`);
  }
  for (const o of oversize) {
    parts.push(`wrote \`${o.name}\` at ${o.bytes} bytes, over the ${RESULT_MAX_BYTES}-byte cap — a result is a small value, and a file that size belongs in \`--export\``);
  }
  if (!parts.length) return null;
  return `#${id} ${parts.join('; ')}, so the attempt failed: a declared output that is not there is not work that was done.`;
}
