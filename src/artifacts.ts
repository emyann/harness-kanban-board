import fs from 'node:fs';
import path from 'node:path';

import { boardDir } from './db-url.ts';

/**
 * `artifacts` — the third declared output, and the one ADR-011 named as its own precondition.
 *
 * ADR-008 gave a Job two ways to hand something over and they cover the two ends of a range:
 * `exports` are **paths the repository keeps**, and `results` are **small values the board keeps**,
 * capped at 4 KB because a handoff that can hold a megabyte is a worse artifact store than the one
 * `exports` already is. Between them is a gap nothing filled: an output that is too large to be a
 * result and does not belong in the repository at all.
 *
 * The motivating case is ADR-011's proposal — a workload's request that the board be changed, which
 * is authored for the controller and would be litter in a commit. But it is not the only one. A Job
 * that investigates and writes forty kilobytes of findings has the same problem today, and
 * `producedNothing` (`src/hkb.ts`) can only report the symptom.
 *
 * **An artifact is a big result, not an uncommitted export**, and that is the whole design.
 *
 * The tempting alternative was to give `exports` a second destination — the copy already takes one
 * (`exportOutputs`, `src/worktree.ts`), so it reads like a call-site change. It is the wrong shape,
 * and `resultsDir` below already says why in its own words: a scratch file written *inside* the
 * checkout "is either committed by accident or shows up as untracked noise in every `git status` a
 * reviewer runs". An output that must not be committed should never be in the tree in the first
 * place, so an artifact is written where a result is written — outside every checkout, at an
 * absolute path the controller hands the worker — and there is no copy step to get wrong.
 *
 * What it does not inherit from `results` is the cap and the clearing. The cap is the point of not
 * being a result. The clearing is impossible: a result is durable because its value is on the
 * Attempt row, and an artifact's value is the file, so the file is the durable thing.
 */

/**
 * A declared artifact name.
 *
 * One path segment, because that is all it needs to be: the name is a *destination*, resolved
 * against a per-attempt directory that starts empty, so there is nothing here to collide with and
 * nothing to overwrite. `checkExportPath` has to police `..`, absolute paths, `.git/` and `.hkb/`
 * precisely because an export names somewhere inside a repository that already has contents; an
 * artifact does not, and the fence that costs nothing is the one that admits no separators at all.
 *
 * Dots are allowed where `checkResultName` refuses them, because an artifact is a file somebody
 * opens — `report.md`, `plan.json` — and a leading dot or a bare `..` is refused by the same rule
 * that admits them. A name may also be produced as a **directory**, which is how an artifact holds
 * more than one file without needing a path syntax.
 */
export function checkArtifactName(raw: string): string {
  const name = String(raw ?? '').trim();
  const refuse = (why: string): never => {
    const e = new Error(
      `${why} An artifact name is one path segment — letters, digits, dash, underscore, and dots between them — as in \`--artifact report.md\`.`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  };
  if (!name) refuse('an artifact name is empty.');
  if (!ARTIFACT_NAME.test(name)) {
    refuse(`the artifact name ${JSON.stringify(raw)} is not a single path segment, so it names somewhere other than this Job's own output directory.`);
  }
  if (name.length > 128) refuse(`the artifact name ${JSON.stringify(raw)} is longer than 128 characters.`);
  return name;
}

/** Segments of word characters joined by single dots. Refuses `..`, `.hidden`, `a/b` and `a\b`. */
const ARTIFACT_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/** The names a Job declared, read back out of its JSON column. Defensive: the column is `Json?`. */
export function declaredArtifacts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
}

/**
 * Where an attempt's artifacts live — beside the board, outside every checkout, and **kept**.
 *
 * The sibling of `resultsDir` (`src/results.ts`) and for the same reasons, with one difference that
 * matters operationally: this directory is not removed when the attempt ends. Nothing else holds
 * what is in it.
 */
export const artifactsDir = (jobId: number, k: number): string =>
  path.join(boardDir(), 'artifacts', `${jobId}-${k}`);

/** Create the directory. Called before the run, because its path goes into the prompt. */
export function ensureArtifactsDir(jobId: number, k: number): string {
  const dir = artifactsDir(jobId, k);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The absolute path the worker is told to write each declared artifact to. */
export function artifactPaths(jobId: number, k: number, names: string[]): Record<string, string> {
  const dir = artifactsDir(jobId, k);
  return Object.fromEntries(names.map((n) => [n, path.join(dir, n)]));
}

/** One artifact that arrived: what it is called, whether it is a file or a directory, how big. */
export type Artifact = { name: string; kind: 'file' | 'dir'; bytes: number };

export type CollectedArtifacts = {
  /** Everything the run left: the declared ones, plus whatever it volunteered. */
  produced: Artifact[];
  /** Declared and not produced. These fail the attempt. */
  missing: string[];
  /** Produced but never declared — kept, never required. Same two layers as `results`. */
  volunteered: string[];
};

/**
 * Read back what the run left. Presence and size only — never meaning, and never contents.
 *
 * The deliberate difference from `collectResults` is that nothing is read: an artifact can be
 * arbitrarily large, which is the point of it, so loading one into the controller to record that it
 * exists would give back the cap by another route. What lands on the Attempt is the *catalogue* —
 * name, kind, size — and the file stays where the worker put it.
 *
 * The two layers hold as they do for results: a **declared** name is the filer's requirement and
 * its absence fails the attempt; anything else in the directory is **volunteered**, kept and
 * reported and never required.
 */
export function collectArtifacts(jobId: number, k: number, names: string[]): CollectedArtifacts {
  const out: CollectedArtifacts = { produced: [], missing: [], volunteered: [] };
  const dir = artifactsDir(jobId, k);
  const declared = new Set(names);

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { /* nothing written */ }

  for (const e of entries) {
    // A volunteered name still has to be a name. The declaration path is checked at file time
    // (`checkArtifactName`); this is the same fence for the half nobody declared, and something
    // unnameable is ignored rather than failing someone else's attempt.
    if (!ARTIFACT_NAME.test(e.name) || e.name.length > 128) continue;
    const full = path.join(dir, e.name);
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.produced.push({ name: e.name, kind: 'dir', bytes: bytesUnder(full) });
    else if (st.isFile()) out.produced.push({ name: e.name, kind: 'file', bytes: st.size });
    else continue;
    if (!declared.has(e.name)) out.volunteered.push(e.name);
  }

  const there = new Set(out.produced.map((a) => a.name));
  out.missing = names.filter((n) => !there.has(n));
  out.produced.sort((a, b) => a.name.localeCompare(b.name));
  out.volunteered.sort();
  return out;
}

/**
 * Every byte under a produced directory.
 *
 * Recorded rather than skipped because **nothing removes an artifact directory**, so the size is
 * the only warning an operator gets that a board is filling up. One walk per declared directory,
 * once, at the end of a run that is already over.
 */
function bytesUnder(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return 0; }
  for (const e of entries) {
    const child = path.join(dir, e.name);
    // `statSync`, not the dirent, so a symlink is counted as what it points at — and never
    // followed out of the tree, because a symlink's own size is what a broken one has.
    const st = fs.statSync(child, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) total += bytesUnder(child);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

/**
 * Remove the directory **only if the run left nothing in it.**
 *
 * Every attempt gets one created up front, because the path goes into the prompt and because a Job
 * that declared nothing may still volunteer something. A Job that declared nothing and volunteered
 * nothing would otherwise leave an empty directory per attempt for ever, and `rmdir` refusing to
 * remove a non-empty directory is exactly the test that needs making.
 */
export function clearEmptyArtifacts(jobId: number, k: number): void {
  try {
    fs.rmdirSync(artifactsDir(jobId, k));
  } catch { /* not empty, or not there: either way there is nothing to do */ }
}

/**
 * A size a human reads at a glance.
 *
 * Here rather than in `src/hkb.ts` because the controller's log line and `hkb show` must agree, and
 * a size formatted two ways in one system is how "did it write 4 KB or 4 MB" becomes a question.
 * Powers of 1024 with the units to match, because this measures a disk.
 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  // One decimal below ten, none above: 9.4 MiB is worth the digit, 431 MiB is not.
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** What a Job that declared an artifact and did not produce it owes the operator. */
export function missingArtifacts(id: number, missing: string[]): string | null {
  if (!missing.length) return null;
  const one = missing.length === 1;
  return `#${id} declared ${missing.map((m) => `\`${m}\``).join(', ')} and the run left ${one ? 'it' : 'them'} unwritten,`
    + ' so the attempt failed: a declared output that is not there is not work that was done.';
}
