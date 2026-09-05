import fs from 'node:fs';
import path from 'node:path';

/**
 * Declared outputs: getting a Job's deliverable out of the sandbox before the sandbox dies.
 *
 * ADR-008. A worktree is the pod filesystem and dies with the run, and `git push` is the only
 * artifact store hkb has — so a Job whose deliverable is an *uncommitted* file has no correct
 * outcome today. `removeWorktree` either deletes the artifact with the checkout, or
 * `worktreeHasWork` sees the dirty tree and keeps the worktree for ever; Phase 5 left 6.1 GB the
 * second way.
 *
 * Bazel's sandbox states the rule this module implements: it *"moves the known output artifacts
 * out of the sandbox into the execroot and deletes the sandbox"*, which is what prevents
 * *"littering the execroot with unknown output files."* Read against hkb, the sandbox is the
 * worktree, the execroot is `Board.repoPath`, and the litter is the 6.1 GB.
 *
 * Two rules do the work here, and both are refusals:
 *
 *   1. **A declared export the worker did not produce fails the attempt.** Without it a
 *      declaration buys nothing — it is a copy loop, not a contract, and `succeeded` goes on
 *      meaning only that a session ended.
 *   2. **A path that escapes the worktree is not an output.** A declaration says what a Job
 *      produces; it is not a licence to write anywhere on the machine. `..`, an absolute path and
 *      a symlink pointing out of the checkout are all refused, and the third is the one that would
 *      otherwise slip past a string check.
 */

/** What a declared path could not be. Null when it is a path we will accept. */
export function refuseExportPath(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return 'an export needs a path — name a file or directory the job produces, like "dist/report.json"';
  }
  const p = raw.trim();
  if (p.startsWith('~')) {
    return `"${p}" starts with ~, which is a shell shorthand for a directory outside the checkout — `
      + 'an export is relative to the repository root, so write it as a path inside the repository';
  }
  // `C:\x` is absolute on Windows and `path.isAbsolute` on posix says it is not. Nothing here runs
  // on Windows yet, but a path that means "the root of a drive" must never read as relative.
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    return `"${p}" is an absolute path — an export is relative to the repository root, so drop the `
      + 'leading separator and name the path the job writes inside its own checkout';
  }
  const norm = path.normalize(p);
  if (norm === '..' || norm.startsWith(`..${path.sep}`)) {
    return `"${p}" escapes the worktree — an export names something the job produced inside its own `
      + 'checkout, so remove the ".." and point at a path under the repository root';
  }
  if (normalizeExportPath(p) === '') {
    return `"${p}" is the checkout itself — an export names one thing the job produced, so point at `
      + 'the file or directory rather than at the whole repository';
  }
  return null;
}

/** The accepted spelling of a declared path: no `./`, no trailing separator, one form to compare. */
export function normalizeExportPath(raw: string): string {
  const norm = path.normalize(raw.trim()).replace(/[\\/]+$/, '');
  return norm === '.' ? '' : norm;
}

/**
 * What an attempt's declared outputs did, and did not, do.
 *
 * `problems` is prose rather than a code because it is read by an operator in `kb log` and by a
 * model in `Attempt.reason` — both of which need to know what to do next, and neither of which
 * gains anything from a taxonomy.
 */
export type ExportResult = {
  /** Repo-relative paths now present in the board's repository. In declared order. */
  copied: string[];
  /** One line per declared output that did not make it, each saying what to do about it. */
  problems: string[];
};

/** Did every declared output make it out? The attempt's verdict, in one place. */
export const exportsOk = (r: ExportResult): boolean => r.problems.length === 0;

/**
 * The declared paths on a Job, as written by `kb new --export`.
 *
 * Total: a column that does not parse is a problem to report, never a throw out of the middle of a
 * reconcile pass. `null` and `[]` both mean "nothing on disk", which is the honest default for a
 * Job whose output is a pull request.
 */
export function parseExports(raw: string | null | undefined): { paths: string[]; problems: string[] } {
  if (raw === null || raw === undefined || !String(raw).trim()) return { paths: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return {
      paths: [],
      problems: [`the job's exports are not valid JSON: ${String(raw).slice(0, 120)} — refile the Job `
        + 'with `kb new --export <path>`, which writes the column, rather than editing it by hand'],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      paths: [],
      problems: ['the job\'s exports must be a JSON array of paths, like ["dist/report.json"] — refile '
        + 'the Job with `kb new --export <path>`'],
    };
  }
  const paths: string[] = [];
  const problems: string[] = [];
  for (const entry of parsed) {
    const why = typeof entry === 'string' ? refuseExportPath(entry) : 'an export must be a string path';
    if (why) problems.push(`declared export ${JSON.stringify(entry)} is not usable: ${why}`);
    else paths.push(normalizeExportPath(entry as string));
  }
  return { paths, problems };
}

/**
 * Move a Job's declared outputs from the worktree into the board's repository.
 *
 * Never partial-and-silent: everything that could be copied is copied, and everything that could
 * not is named. The caller decides what a problem costs — which is the attempt, per ADR-008.
 */
export function exportOutputs(from: string, to: string, declared: string | null | undefined): ExportResult {
  const { paths, problems } = parseExports(declared);
  const copied: string[] = [];
  if (!paths.length) return { copied, problems };
  // The sandbox's real location, so a symlinked path inside it can be measured against something.
  const root = realOrNull(from);
  if (!root) {
    problems.push(`the worktree ${from} is gone — nothing could be exported from it`);
    return { copied, problems };
  }

  for (const rel of paths) {
    const src = path.resolve(from, rel);
    // A string check catches `..`; it does not catch `dist` being a symlink to /tmp. Resolve the
    // source and require it to still be under the worktree, which is the check that actually holds.
    const real = realOrNull(src);
    if (!real) {
      problems.push(
        `declared export "${rel}" was not produced — the job succeeded without writing it. Either the `
        + 'worker must create it, or the Job should not declare it',
      );
      continue;
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      problems.push(
        `declared export "${rel}" resolves to ${real}, outside the worktree — an export is something `
        + 'the job produced in its own checkout, so it is refused rather than copied out',
      );
      continue;
    }
    const dest = path.resolve(to, rel);
    // The destination is derived from a path already proven relative, so this cannot fail — but the
    // cost of proving it again is one string compare, and the cost of being wrong is a write outside
    // the repository.
    const destRoot = path.resolve(to);
    if (dest !== destRoot && !dest.startsWith(destRoot + path.sep)) {
      problems.push(`declared export "${rel}" would land outside ${destRoot} — refused`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // `recursive` is what makes a declared directory work: `.claude/skills/sdk-docs/` is one
      // declaration, not one per file. `force` overwrites, because a second attempt that produced
      // a better artifact should replace the first one's.
      fs.cpSync(real, dest, { recursive: true, force: true });
      copied.push(rel);
    } catch (e) {
      problems.push(
        `declared export "${rel}" could not be copied into ${to}: ${(e as Error).message} — `
        + 'check the destination is writable, then re-run the Job',
      );
    }
  }
  return { copied, problems };
}

/** `realpathSync`, as a question rather than an exception. Null means "not there". */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
