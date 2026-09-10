import { spawnSync } from 'node:child_process';
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
 * Where the runtime puts a workspace of that name.
 *
 * **Only for the sweep.** A live attempt never guesses this: the runtime reports the real path back
 * as `WorkerOutcome.workspacePath`, and that is the one the outputs are collected from. This
 * reconstruction exists because the sweep runs long after the session is gone and has nothing left
 * to ask — the same position Kubernetes' garbage collector is in.
 */
export const workspacePath = (root: string, name: string): string =>
  path.join(root, '.claude', 'worktrees', name);

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
export function existingWorkspaces(root: string): Set<string> {
  const out = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8', timeout: 20_000,
  });
  const names = new Set<string>();
  if (out.status !== 0 || !out.stdout) return names;
  for (const line of out.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const name = path.basename(line.slice('worktree '.length).trim());
    if (/^kb-\d+$/.test(name)) names.add(name);
  }
  return names;
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
  return jobs
    .filter((j) => !j.resumable && j.finishedAt != null && j.finishedAt.getTime() <= cutoff)
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
export function removeWorkspace(root: string, name: string): Swept {
  const git = (args: string[]) =>
    spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20_000 });

  const dir = workspacePath(root, name);
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
