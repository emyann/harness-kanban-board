import fs from 'node:fs';
import path from 'node:path';

/** The board's own directory, which a declared output may never reach into. */
const BOARD_DIR = '.hkb';

/**
 * What a Job takes back out of its workspace, before the workspace goes.
 *
 * **This is not a git concept and it never was**, which is why it no longer lives in
 * `src/worktree.ts`. It is ADR-008's execroot: a Job declares in advance what it will produce, the
 * declared paths are moved out of wherever the session ran, and only then may that place be torn
 * down. Bazel does exactly this and has no opinion about version control; so does a Kubernetes
 * `initContainer` writing into an `emptyDir` that a sidecar later ships.
 *
 * What Kubernetes does NOT have is this function, and the reason is worth stating: a Pod's volume
 * outlives the Pod when it is a PersistentVolume, so nothing has to *rescue* an output — the
 * workload writes to storage that stays. hkb's workspace dies with the attempt, so the declared
 * outputs are copied to the one place that persists. `ttlSecondsAfterFinished` is the field that
 * makes "when does the workspace go" a spec question rather than a heuristic, and when it lands the
 * ordering here is what it orders.
 */
/**
 * A declared export path, normalised — or a refusal.
 *
 * Bazel's rule, which ADR-008 adopts, is that the *known* outputs move out of the sandbox and the
 * rest is litter. A declaration is therefore a thing the board acts on with the operator's
 * authority: it names a source inside the worktree AND a destination inside the repository, and the
 * copy happens with no agent in the loop to sanity-check it. So the syntax is checked before it is
 * ever used — `..` and an absolute path are the two spellings of "somewhere else", and `.hkb/`
 * is the board's own directory, where a copy would land on top of the worktrees and the board file
 * itself.
 *
 * Refused, not silently dropped, and for the reason `refuseTheBoard` gives above: a path this wrong
 * is one whose author did not mean what they wrote, and the copy it produces is somebody's
 * afternoon.
 */
export function checkExportPath(raw: string): string {
  const rel = String(raw ?? '').trim();
  const refuse = (why: string): never => {
    const e = new Error(
      `${why} Declare a path inside the repository instead, as in \`--export .claude/skills/sdk-docs/\`.`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  };
  if (!rel) refuse('an export path is empty — there is no file it could name.');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    refuse(`the export path ${JSON.stringify(rel)} is absolute, so it points outside the worktree — a declared output is not a licence to write anywhere.`);
  }
  // A trailing separator is how a directory is usually written, and it means nothing to the copy.
  const norm = path.normalize(rel).replace(/[\\/]+$/, '');
  if (!norm || norm === '.') refuse(`the export path ${JSON.stringify(rel)} names the whole checkout rather than an output.`);
  if (/^\.\.([\\/]|$)/.test(norm)) {
    refuse(`the export path ${JSON.stringify(rel)} escapes the worktree — a declared output is not a licence to write anywhere.`);
  }
  if (norm === BOARD_DIR || norm.startsWith(`${BOARD_DIR}${path.sep}`)) {
    refuse(`the export path ${JSON.stringify(rel)} is inside ${BOARD_DIR}/ — the board's own directory, where the worktrees and the board file live, and never a place a Job writes.`);
  }
  // The other directory that is not an artifact. In a worktree `.git` is a *file* pointing at the
  // admin directory, and copying it over the repository's own `.git` is a way to break a checkout
  // in a manner nobody would connect back to an export declaration.
  if (norm === '.git' || norm.startsWith(`.git${path.sep}`)) {
    refuse(`the export path ${JSON.stringify(rel)} is inside .git — the repository's own plumbing, not something a Job produces.`);
  }
  return norm.split(path.sep).join('/');
}

/** What an attempt handed over, and what it owed and did not. */
export type ExportResult = {
  /** The paths that arrived at the destination, a declared directory expanded into its files. */
  exported: string[];
  /** Declared paths that were not in the checkout. Every one of these fails the attempt. */
  missing: string[];
};

/**
 * Move the declared outputs from the checkout into the repository. **Then** the sandbox may go.
 *
 * The order is the design and not an implementation detail: a worktree is the pod filesystem and
 * dies with the run, so an artifact that is still in it when it is removed was never produced. This
 * is Bazel's execroot, one machine, no artifact store — see ADR-008.
 *
 * A missing path is *returned*, not thrown: it is a fact about the run that the caller records on
 * the attempt, in the same shape as every other outcome. A path that is not a path — escaping,
 * absolute, reaching into the board — is thrown, because it was never a legal declaration and the
 * fix is to the Job rather than to the work.
 *
 * `from === to` is the un-isolated Job: the work already happened in the destination, so there is
 * nothing to move and the declaration is a check that it is there.
 *
 * **Nothing is copied until every declaration holds.** A shortfall fails the attempt, and a failed
 * attempt that has already written half of itself into the repository is the worse of the two
 * outcomes: the operator gets an artifact from a run nobody accepted, mixed into the tree with no
 * mark on it. Two passes — resolve, then copy — cost one extra `stat` per path.
 *
 * `copy: false` asks only the first question. That is the same rule one step further out: a missing
 * declaration has to be found EARLY, because it outranks everything that follows it, while the write
 * into the operator's repository has to happen LATE, once nothing left can still refuse the attempt.
 * The controller asks twice for exactly that reason (`src/controller.ts`) — a completion check runs
 * between the two, and a check that refuses must leave no file behind.
 */
export function exportOutputs(
  from: string,
  to: string,
  declared: string[],
  opts: { copy?: boolean } = {},
): ExportResult {
  const inPlace = path.resolve(from) === path.resolve(to);
  const missing: string[] = [];
  /** Each declaration, resolved to the repo-relative files it stands for. */
  const plan: string[] = [];

  for (const raw of declared) {
    const rel = checkExportPath(raw);
    const src = path.join(from, rel);
    const st = fs.statSync(src, { throwIfNoEntry: false });
    if (!st) {
      missing.push(rel);
      continue;
    }
    refuseOutside(from, src, rel);
    if (!st.isDirectory()) {
      plan.push(rel);
      continue;
    }
    const files = filesUnder(from, src, rel);
    // An empty declared directory is still a produced directory — the declaration held, there was
    // simply nothing in it — so it is created at the destination rather than reported missing. The
    // trailing slash is how the record says "a directory, and it was empty".
    plan.push(...(files.length ? files : [`${rel}/`]));
  }
  if (missing.length) return { exported: [], missing };

  if (!inPlace && opts.copy !== false) {
    for (const rel of plan) {
      if (rel.endsWith('/')) fs.mkdirSync(path.join(to, rel), { recursive: true });
      else copyOut(path.join(from, rel), path.join(to, rel));
    }
  }
  return { exported: plan, missing };
}

/** Overwrites: the artifact is the point, and a stale copy at the destination is not worth keeping. */
function copyOut(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Every file under a declared directory, repo-relative, depth-first in readdir order. */
function filesUnder(root: string, dir: string, rel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    const child = path.join(dir, entry.name);
    refuseOutside(root, child, childRel);
    // `statSync` rather than the dirent, so a symlink is classified by what it points at — and
    // `refuseOutside` has already established that what it points at is inside the checkout.
    const st = fs.statSync(child, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.push(...filesUnder(root, child, childRel));
    else if (st.isFile()) out.push(childRel);
  }
  return out;
}

/**
 * The other half of the escape check, and the half a syntax rule cannot make.
 *
 * `..` and a leading `/` are how a *declaration* escapes; a symlink is how the filesystem does it
 * behind an innocent-looking one. `exports: ["out"]` where `out -> /etc` would otherwise copy `/etc`
 * into the repository. The question is asked of the resolved path, so it holds however it is spelled.
 */
function refuseOutside(root: string, p: string, rel: string): void {
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(p);
    realRoot = fs.realpathSync(root);
  } catch {
    return; // Gone between the listing and the check: nothing to copy, and nothing to refuse either.
  }
  if (real === realRoot || real.startsWith(realRoot + path.sep)) return;
  const e = new Error(
    `the export path ${JSON.stringify(rel)} resolves to ${real}, outside the checkout — a symlink that `
    + 'leaves the worktree makes the copy a way to read anything on this machine. Export a real path '
    + 'inside the checkout instead.',
  ) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}
