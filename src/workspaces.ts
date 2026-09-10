import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * What hkb still knows about a workspace after the git protocol left: its **name**, and when it is
 * safe to collect.
 *
 * Everything else — creating it, keeping its base current, carrying gitignored files into it,
 * locking it against a concurrent sweep, returning a resumed session to it — is the runtime's, and
 * was measured to already exist there (ADR-018). What is left is the two things a *Job controller*
 * owns in Kubernetes: it asks for a volume by name, and it decides when the volume goes.
 *
 * ## Why the name is per Job and not per attempt
 *
 * `kb-<jobId>`, not `kb-<jobId>-<k>`. The harness reopens an existing worktree when a run asks for a
 * name that is already there, and — with the default `"fresh"` base — resets it to the default
 * branch only when doing so loses nothing: no uncommitted changes, no untracked files, still on the
 * branch it was given, and either no commits of its own or a merged-and-deleted remote branch.
 *
 * That is exactly the judgement `newestWorktree` and `heldWork` existed to make, made by the party
 * that can see the whole picture. A per-attempt name would defeat it: attempt 2 would ask for a name
 * that has never existed, get a fresh checkout, and resume a session whose transcript describes a
 * tree it cannot see — the precise failure those two functions were written to prevent.
 */
export const workspaceName = (jobId: number): string => `kb-${jobId}`;

/**
 * The workspace name a directory belongs to, or null if it is not one of ours.
 *
 * Two shapes, because a board that predates ADR-018 has checkouts on disk from the scheme before it:
 *
 *   - `kb-<jobId>`        — what hkb asks for now, one workspace per Job.
 *   - `kb-<jobId>-<k>`    — the old per-attempt checkout under `.hkb/worktrees/`. Recognised so the
 *                           sweep can collect it; otherwise every workspace an upgrading board
 *                           already had would be orphaned on disk for ever, which is a worse
 *                           upgrade than the one this replaces.
 *
 * Matched on the *directory name* and mapped back to a Job id, so the TTL question can be asked
 * about it like any other.
 */
export function workspaceJobId(dir: string): number | null {
  const m = /^kb-(\d+)(?:-\d+)?$/.exec(path.basename(dir));
  return m ? Number(m[1]) : null;
}

/**
 * How long a finished Job's workspace survives it — `ttlSecondsAfterFinished`, as a built-in until
 * it is a spec field.
 *
 * **Deliberately not Kubernetes' default.** There, an unset TTL means *never clean up*, which is
 * safe because a finished Job holds a few kilobytes of API object. Here a workspace is an entire
 * checkout of the repository, so "never" fills the disk of anyone who runs a board for a week. An
 * hour is the window an operator has to go and look at what a run left, which is the only thing the
 * old inspect-the-tree heuristic was really buying.
 */
export const BUILT_IN_TTL_SECONDS = 3600;

/**
 * The workspaces that actually exist, in one call.
 *
 * **The sweep must start here, not from the board.** Asking the board for finished Jobs and trying
 * to remove each one's workspace spawns two git processes per Job per tick and — because
 * `removeWorkspace` reports an absent workspace as removed, which it must — writes a `swept` event
 * every time, for ever. A board with 200 finished Jobs would produce 1,200 rows an hour describing
 * nothing happening. CLAUDE.md states the rule this breaks: *no per-Job calls when a board-wide one
 * exists*, and `git worktree list` is the board-wide one.
 *
 * Only the workspaces hkb itself asked for, by name, so a worktree the operator made is never a
 * candidate however old it is.
 */
export function existingWorkspaces(root: string): { jobId: number; path: string }[] {
  const out = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8', timeout: 20_000,
  });
  if (out.status !== 0 || !out.stdout) return [];
  const found: { jobId: number; path: string }[] = [];
  for (const line of out.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    // **The absolute path git reported, kept.** An earlier version returned only the basename and
    // let `removeWorkspace` rebuild `<root>/.claude/worktrees/<name>` — so a worktree anywhere else
    // was found, missed by the remove, reported as *removed* (an absent workspace must be a
    // success, or the sweep reports the same thing for ever), and logged on every tick in
    // perpetuity. That is the exact runaway this function was written to end, reintroduced by
    // guessing a path that was already in hand. The rule is the same one `workspacePath` used to
    // break: reported, never reconstructed.
    const dir = line.slice('worktree '.length).trim();
    const jobId = workspaceJobId(dir);
    if (jobId != null) found.push({ jobId, path: dir });
  }
  return found;
}

/**
 * A Job as the sweep sees it.
 *
 * `resumable` is the one that is not about time, and it is the one that prevents the failure this
 * whole naming scheme exists to prevent. A Job can be **finished and still resumable**: `max_budget`
 * ends `failed` while keeping `lastSessionId`, precisely so `hkb retry <id> --max-budget <more>`
 * continues the session rather than re-buying it. Its workspace is the tree that session's transcript
 * describes, so collecting it on a clock would wake the retry in a checkout with none of its work —
 * and an operator following the advice hkb itself printed is exactly who would hit it.
 *
 * **It is narrower than "has a session".** A Job an operator `cancel`led or marked `done` keeps its
 * `lastSessionId` too, and so does one that exhausted its retries — but nothing is going to resume
 * any of them, and treating them as resumable would mean a workspace per such Job kept for ever with
 * no reason an operator could see. `hkb retry` is what resumes, and it acts on a *failed* Job; that
 * is the whole of the condition (`src/daemon.ts` computes it).
 */
export type Collectable = { id: number; finishedAt: Date | null; phase: string; resumable: boolean };

/**
 * Which workspaces may be collected — `ttlSecondsAfterFinished`, and nothing else.
 *
 * **This replaces a heuristic, and that is the point of it.** The old sweep asked the tree what was
 * in it: a checkout with uncommitted changes or unpushed commits was kept, everything else taken.
 * That question only had an answer while the core required a push, it needed `pushedRef`,
 * `heldWork` and `whyKept` to ask it, and it was wrong in both directions — it kept a tree for ever
 * when a branch was never pushed, and it had no opinion at all about age.
 *
 * `batch/v1` answers the same question with a field, and the answer does not depend on inspecting
 * anything: **a finished Job's workspace is collectable once its TTL has elapsed.** A Job that has
 * not finished keeps its workspace whatever its age, because a later attempt resumes *in* it.
 *
 * Pure, so the refusing cases are the ones the tests can be exhaustive about: not finished, finished
 * too recently, still resumable, and a TTL of zero meaning "immediately" rather than "never".
 */
export function collectable(jobs: Collectable[], now: Date, ttlSeconds: number): number[] {
  const cutoff = now.getTime() - ttlSeconds * 1000;
  // `=== false`, not `!j.resumable`: a caller that does not say must PROTECT, never collect. Getting
  // it wrong one way keeps a workspace that could have gone, which costs disk; the other way deletes
  // work, which costs an afternoon. A guard has to fail in the cheaper direction — and a caller that
  // never sets it makes the sweep inert rather than destructive, which the tests below catch.
  return jobs
    .filter((j) => j.resumable === false && j.finishedAt != null && j.finishedAt.getTime() <= cutoff)
    .map((j) => j.id);
}

export type Swept = { name: string; removed: boolean; why: string };

/**
 * Take one workspace back.
 *
 * Two calls, and the order matters: the runtime holds a `git worktree lock` on a workspace for the
 * length of the run and releases it at the end, but a run killed mid-flight leaves the lock behind —
 * so the unlock is attempted first and its failure is not interesting (a workspace that was never
 * locked is the common case).
 *
 * **Never `--force`.** git's own refusal is the safety net that replaces `heldWork`: a tree holding
 * uncommitted or untracked work is refused, and refused is *reported*, not worked around. Everything
 * the Job declared has already been collected by then (ADR-008), so what is left is undeclared — but
 * "undeclared" is a statement about the Job's promises, not proof that a human would not have wanted
 * the file, and the cost of being wrong here is somebody's afternoon. A tree git will not take is
 * left on disk and named, and `git worktree remove --force` is the operator's own deliberate move.
 */
export function removeWorkspace(root: string, dir: string): Swept {
  const git = (args: string[]) =>
    spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20_000 });

  const name = path.basename(dir);
  git(['worktree', 'unlock', dir]);
  const gone = git(['worktree', 'remove', dir]);
  if (gone.status === 0) return { name, removed: true, why: '' };

  const why = (gone.stderr || gone.stdout || 'git worktree remove failed').trim().split('\n')[0];
  // Already gone is a success, not a failure: the sweep is level-triggered and runs against whatever
  // is there, so a workspace a previous pass or the operator removed must not be reported for ever.
  if (/is not a working tree|No such file or directory/i.test(why)) {
    return { name, removed: true, why: '' };
  }
  return { name, removed: false, why: why.slice(0, 200) };
}

/**
 * Disarm what the deleted `pre-push` fence left on this machine.
 *
 * **This is the one part of ADR-018 that a code change alone does not finish**, and it breaks a live
 * board rather than merely leaving litter. The old fence set `core.hooksPath` to `~/.hkb/hooks` on
 * each attempt's worktree — per-worktree, via `extensions.worktreeConfig`, so the operator's own
 * checkout was untouched — and wrote a shim there that `exec`s `dist/src/pre-push.js`. That file is
 * gone, and the tarball no longer ships it. A push from any surviving worktree would fail with a
 * hook that cannot start: hkb breaking a repository on the way out.
 *
 * Removing the directory is what fixes it, and it fixes it completely. A `core.hooksPath` pointing
 * at somewhere that does not exist is not an error to git — it simply finds no hooks — so every
 * stale per-worktree setting becomes inert the moment this runs, with nothing to unset and no need
 * to enumerate worktrees hkb may no longer know about.
 *
 * Idempotent, and silent when there is nothing there, because it runs on an upgrade path that most
 * boards will take exactly once.
 */
export function retireLegacyPushHooks(boardDir: string): string | null {
  const hooks = path.join(boardDir, 'hooks');
  if (!fs.existsSync(hooks)) return null;
  fs.rmSync(hooks, { recursive: true, force: true });
  return hooks;
}
