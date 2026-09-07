import { spawnSync } from 'node:child_process';
import {
  NET_ENV, NET_TIMEOUT_MS, baseRef, fetchBase, pushedRef, resolveBase, type Worktree,
} from './worktree.ts';

/**
 * Keeping an attempt's branch on the base it will actually be merged into.
 *
 * A worktree is cut from `origin/<default>` at claim time and never touched again, so the longer a
 * batch runs the further every branch drifts from what the human will merge. Measured on
 * 2026-09-06: four parallel Jobs cost four hand-rebases, and 82 line-number citations in the wiki
 * drifted because every branch was cut from a base that then moved. `docs/wiki/gotchas/merge-composition.md`
 * is the history.
 *
 * This is the **cheap half** of `docs/rebuild-plan.md` item 10, and the boundary is worth stating
 * because the temptation is to keep going: it makes the branch sit on the *current* base at the
 * moment the attempt ends. It does not make per-PR CI compose, it does not survive the base moving
 * again five minutes later, and it cannot tell you that two textually clean branches broke the same
 * invariant. The honest fix is the base becoming a spec field so a graph's children branch from
 * their parent (`docs/workflow-study.md` §4.1), and that is the DAG's precondition, not this.
 *
 * ## Why the controller does this and the worker cannot
 *
 * The worker is told never to force-push, and that rule stays. But a branch that has already been
 * pushed and whose base has since moved can only be rebased by rewriting what is on the remote —
 * so if the worker may not, and a human should not have to, the controller must. It is a defensible
 * owner: it created the branch, and `kb-<id>-<k>` is hkb's namespace on that remote.
 *
 * The rest of that argument used to be "the pull request it lands under is a draft nobody has
 * reviewed", and nothing checked it. A gated Job (ADR-010) suspends *precisely* so a human reads
 * the diff, and the approved attempt would then have rewritten the branch under their review
 * comments. So the caller passes `mayRewrite`, and a pull request that is no longer a draft stops
 * this dead: the argument now holds because it is enforced rather than asserted.
 *
 * The push is `--force-with-lease`, which is the refusal that makes the rest safe: it compares the
 * remote against our own remote-tracking ref and declines if anything else moved the branch. That
 * is also why `fetchBase` fetches the base branch alone — a blanket `git fetch origin` would
 * refresh `refs/remotes/origin/kb-<id>-<k>` too and turn the lease into a plain `--force`.
 *
 * ## What blocks an attempt and what only gets said
 *
 * Three states are the Job's problem and fail the attempt: the rebase would not replay, the lease
 * refused because somebody else moved the branch, and the replay worked while the autostash did
 * not. One is *ours* and does not: a push that failed to reach the remote. A twenty-second timeout
 * on a big repository, an auth blip, or a momentarily unreachable forge would otherwise fail an
 * attempt whose work succeeded and is already on the remote with a pull request open — a
 * transient network fault is not evidence about the work, and the state it leaves is the state
 * that existed before this module did.
 */

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/** The same call, over the network and unable to ask a question. See `NET_ENV`. */
const gitNet = (cwd: string, args: string[]) => spawnSync('git', args, {
  cwd,
  encoding: 'utf8',
  timeout: NET_TIMEOUT_MS,
  env: { ...process.env, ...NET_ENV },
});

const short = (s: string) => (s || '').trim().split('\n').pop() || '';

/** Everything the decision needs, and every one of them an answer git gave. */
export type BaseState = {
  /** The base as a ref an operator would type: `origin/main`. */
  label: string;
  /** Commits the branch carries that the base does not. */
  ahead: number;
  /** Is the base already an ancestor of the branch tip — is the branch on top of it? */
  onBase: boolean;
  /** May the remote be rewritten? False once a human is reading the pull request. */
  mayRewrite: boolean;
  /** Has this branch been pushed? A branch that has not needs no permission to be rewritten. */
  pushed: boolean;
};

/**
 * Whether this branch needs replaying, and why — the whole decision, with no I/O in it.
 *
 * The three "nothing" cases are worth naming rather than collapsing, because they are different
 * facts about a run and the operator reads the reason:
 *
 *   - `onBase` — the base is an ancestor of the tip. Either it never moved, or the worker already
 *     rebased because the brief told it to. This is the common case and it must stay free.
 *   - `ahead === 0` — there is nothing to replay. A Job whose deliverable is a result rather than a
 *     diff never commits; and a branch whose commits are already *in* the new base (its pull
 *     request landed while the attempt was still running) reads exactly the same way. Rebasing
 *     either would be a no-op that still rewrites the branch and still costs a force-push.
 *   - a pushed branch under a pull request somebody has taken out of draft. Rebasing locally and
 *     not pushing would only split the two, so the whole operation is off.
 */
export function rebasePlan(s: BaseState): { act: 'rebase' | 'nothing'; why: string } {
  if (s.onBase) return { act: 'nothing', why: `already on ${s.label}` };
  if (s.ahead === 0) return { act: 'nothing', why: 'nothing was committed on it' };
  if (s.pushed && !s.mayRewrite) {
    return { act: 'nothing', why: 'its pull request is no longer a draft — a person is reading it' };
  }
  return { act: 'rebase', why: `${s.label} moved under it` };
}

/**
 * The line of git's rebase output an operator actually needs.
 *
 * git says a lot on a failed rebase — what it auto-merged, what it could not apply, and a
 * paragraph about `--continue` that is addressed to someone standing in the tree. The `CONFLICT`
 * lines name the files, which is the only part that tells a reader whose change collided. Capped at
 * three because this ends up in `Attempt.reason`, which is 300 characters.
 */
export function conflictReason(out: string): string {
  const lines = (out || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const conflicts = lines.filter((l) => l.startsWith('CONFLICT'));
  if (conflicts.length) {
    const more = conflicts.length > 3 ? ` (+${conflicts.length - 3} more)` : '';
    return conflicts.slice(0, 3).join('; ') + more;
  }
  // Not every refusal is a conflict — a dirty tree that would not autostash, a base that vanished.
  const err = lines.find((l) => l.startsWith('error:') || l.startsWith('fatal:'));
  return err ?? lines[lines.length - 1] ?? 'git gave no reason';
}

/** git's unmerged status codes, and the whole set of them. */
const UNMERGED = /^(DD|AU|UD|UA|DU|AA|UU) /;

/**
 * Paths left conflicted in the checkout, read out of `git status --porcelain`.
 *
 * This is the check for a rebase that **exits 0 and did not finish the job**: `--autostash` that
 * replays every commit and then cannot reapply the stash reports success, leaves an unmerged index
 * with conflict markers in the tree, and keeps the worker's uncommitted work in an unnamed stash
 * entry. Believing the exit code there means reporting `rebased`, force-pushing, recording the
 * attempt as succeeded, and handing the operator a mess with no line in the log about it.
 *
 * **The state, never the message.** The first version of this matched git's own
 * "Applying autostash resulted in conflicts" and passed on git 2.43 and failed on 2.55, because
 * that is prose and prose is not an interface. An unmerged index is the condition actually being
 * asked about, and its porcelain codes are documented and stable.
 */
export function conflictedPaths(porcelain: string): string[] {
  return (porcelain || '').split('\n')
    .filter((l) => UNMERGED.test(l))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * Did the remote refuse us, or did we fail to reach it?
 *
 * The difference decides whether the attempt fails. A refusal is `--force-with-lease` doing its
 * job — somebody else's commit is on our branch and a person has to decide about it. Everything
 * else is the network, and the network is not evidence about the work.
 */
export function pushRefused(out: string): boolean {
  return /\[rejected\]|stale info|non-fast-forward/i.test(out || '');
}

export type RebaseResult = (
  /** Nothing to do, and why not. The common case. */
  | { kind: 'current'; why: string }
  /** Replayed onto the current base, and whether the remote was brought along. */
  | { kind: 'rebased'; label: string; onto: string; pushed: boolean }
  /** It would not replay. The branch is exactly as the worker left it. Blocks. */
  | { kind: 'conflict'; label: string; why: string }
  /** The lease refused: somebody else moved the branch on the remote. Blocks. */
  | { kind: 'rejected'; label: string; why: string }
  /** Replayed, but the worker's uncommitted work did not come back with it. Blocks. */
  | { kind: 'autostash'; label: string; why: string }
  /** Replayed here; the remote could not be reached. Said out loud, does not block. */
  | { kind: 'unpushed'; label: string; why: string }
) & {
  /**
   * Why the base could not be refreshed, when it could not be. Everything below then ran against
   * the ref as it stood, which is no worse than before this module existed — but it is the sort of
   * thing that must not be silent, and it usually predicts the push failing too.
   */
  staleBase?: string;
};

/**
 * Replay the attempt's branch onto the base as it is *now*, and push if it was already pushed.
 *
 * Fetches first, because a base read out of a local ref is a base as of whenever somebody last
 * pulled. Then one of six outcomes, three of which fail the attempt (`src/controller.ts`).
 *
 * `rebase.autoStash` rather than a bare rebase: an isolated Job may legitimately end with a dirty
 * tree — `exports` and `results` are both channels for handing back files nobody committed, and
 * exporting *copies* rather than moves, so a Job with declared outputs has a dirty tree every time.
 * Refusing to rebase on that would switch the feature off for exactly the Jobs that use it. The
 * cost is `conflictedPaths`, which catches the case git reports as success.
 *
 * Every failure path leaves the branch where it was, except the autostash one where the replay
 * genuinely happened. That is the property this function is allowed to be trusted for: a checkout
 * may be the only copy of a worker's output, and a rebase left half applied would be this
 * codebase's one irreversible mistake.
 */
export function rebaseOntoBase(
  root: string,
  wt: Worktree,
  opts: { mayRewrite?: boolean } = {},
): RebaseResult {
  const fetched = fetchBase(root);
  // A repository with no remote is a normal repository, not a failure to report.
  const staleBase = !fetched.fetched && fetched.why && !/no remote/.test(fetched.why)
    ? fetched.why
    : undefined;
  const label = baseRef(root);
  const base = resolveBase(root, label);

  const onBase = git(wt.path, ['merge-base', '--is-ancestor', base, 'HEAD']).status === 0;
  const count = git(wt.path, ['rev-list', '--count', `${base}..HEAD`]);
  const n = Number(count.stdout.trim());
  const ahead = count.status === 0 && Number.isFinite(n) ? n : 0;
  const pushed = !!pushedRef(root, wt.branch);

  const plan = rebasePlan({ label, ahead, onBase, pushed, mayRewrite: opts.mayRewrite !== false });
  if (plan.act === 'nothing') return { kind: 'current', why: plan.why, staleBase };

  const r = git(wt.path, ['-c', 'rebase.autoStash=true', 'rebase', base]);
  const said = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) {
    // Status ignored: a rebase that never started has nothing to abort, and saying so would be
    // reporting our own cleanup instead of git's reason.
    git(wt.path, ['rebase', '--abort']);
    return { kind: 'conflict', label, why: conflictReason(said), staleBase };
  }
  // Nothing is pushed on this path. The commits are replayed and correct, but the tree they sit in
  // has conflict markers in it and a stash entry to reconcile — one place for a person to stand
  // and fix it is worth more than a remote that agrees with half of it.
  const stuck = conflictedPaths(git(wt.path, ['status', '--porcelain']).stdout);
  if (stuck.length) {
    const named = stuck.slice(0, 3).join(', ') + (stuck.length > 3 ? ` (+${stuck.length - 3} more)` : '');
    return {
      kind: 'autostash',
      label,
      why: `the commits replayed and the uncommitted work did not come back: ${named}`,
      staleBase,
    };
  }

  // The replay happened, so this checkout is now measured from the NEW base. `Worktree.base` is
  // what the sweep counts unpushed commits from when a branch has never been pushed; left at the
  // old base it would count every commit the new base brought as work that exists only here — an
  // inflated "push them" message, and a checkout kept for ever on it. Updated here rather than at
  // the call site because a caller that forgets gets a wrong number rather than a type error.
  wt.base = base;

  // Only a branch the worker actually pushed needs the remote told. One that never left the
  // checkout is rebased and finished — and force-pushing it here would create a pull request's
  // worth of remote state for work that deliberately has none.
  if (!pushed) return { kind: 'rebased', label, onto: base, pushed: false, staleBase };

  const p = gitNet(wt.path, ['push', '--force-with-lease', 'origin', wt.branch]);
  if (p.status !== 0) {
    const why = short(p.stderr) || 'git push --force-with-lease failed';
    const out = `${p.stdout}\n${p.stderr}`;
    return pushRefused(out)
      ? { kind: 'rejected', label, why, staleBase }
      : { kind: 'unpushed', label, why, staleBase };
  }
  return { kind: 'rebased', label, onto: base, pushed: true, staleBase };
}

/**
 * What the operator has to do about it, or null when nothing blocks.
 *
 * Every blocking message names the exact commands, in the worktree they apply to, because the
 * operator reading this is looking at a Job that says `failed` next to a pull request that looks
 * fine — and the whole point of finding this here rather than at merge time is that it arrives
 * with the checkout still on disk to fix it in.
 */
export function rebaseShortfall(jobId: number, wt: Worktree, r: RebaseResult): string | null {
  const fix = `\`git -C ${wt.path} push --force-with-lease\``;
  if (r.kind === 'conflict') {
    return `#${jobId} conflicts with ${r.label}: ${r.why}. The branch is untouched — `
      + `\`git -C ${wt.path} rebase ${r.label}\`, resolve it, then ${fix}.`;
  }
  if (r.kind === 'rejected') {
    return `#${jobId} was rebased onto ${r.label} and the remote refused it: ${r.why}. `
      + `Somebody else moved \`${wt.branch}\` — read it before you overwrite it, then ${fix}.`;
  }
  if (r.kind === 'autostash') {
    return `#${jobId} was rebased onto ${r.label} but ${r.why}. The checkout has conflict markers `
      + `in it and the files are in \`git -C ${wt.path} stash list\`. Nothing was pushed. `
      + `Resolve the tree, then ${fix}.`;
  }
  return null;
}

/** What is worth saying out loud without failing anything. Null when there is nothing to say. */
export function rebaseNote(jobId: number, wt: Worktree, r: RebaseResult): string | null {
  if (r.kind === 'unpushed') {
    return `#${jobId} was rebased onto ${r.label} here, but the remote could not be reached: `
      + `${r.why}. The pull request still shows the branch as it was — `
      + `\`git -C ${wt.path} push --force-with-lease\` when the remote is back.`;
  }
  if (r.staleBase) return `could not refresh the base — ${r.staleBase}; used the ref as it stands`;
  return null;
}
