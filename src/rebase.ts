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
 * owner: it created the branch, `kb-<id>-<k>` is hkb's namespace on that remote, and the pull
 * request the rewrite lands under is a draft nobody has reviewed yet.
 *
 * The push is `--force-with-lease`, which is the refusal that makes this safe: it compares the
 * remote against our own remote-tracking ref and declines if anything else moved the branch. That
 * is also why `fetchBase` fetches the base branch alone — a blanket `git fetch origin` would
 * refresh `refs/remotes/origin/kb-<id>-<k>` too and turn the lease into a plain `--force`.
 *
 * The brief asks the worker to rebase before it pushes (`src/brief.ts`), so in the common case
 * everything here reports `current` and nothing is rewritten. That pairing is deliberate and is
 * ADR-014's rule applied: the prompt makes it usually true, the mechanism makes it true.
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
};

/**
 * Whether this branch needs replaying, and why — the whole decision, with no I/O in it.
 *
 * Both "nothing" cases are worth naming rather than collapsing, because they are different facts
 * about a run and the operator reads the reason:
 *
 *   - `onBase` — the base is an ancestor of the tip. Either it never moved, or the worker already
 *     rebased because the brief told it to. This is the common case and it must stay free.
 *   - `ahead === 0` — there is nothing to replay. A Job whose deliverable is a result rather than a
 *     diff never commits; and a branch whose commits are already *in* the new base (its pull
 *     request landed while the attempt was still running) reads exactly the same way. Rebasing
 *     either would be a no-op that still rewrites the branch and still costs a force-push.
 */
export function rebasePlan(s: BaseState): { act: 'rebase' | 'nothing'; why: string } {
  if (s.onBase) return { act: 'nothing', why: `already on ${s.label}` };
  if (s.ahead === 0) return { act: 'nothing', why: 'nothing was committed on it' };
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

export type RebaseResult =
  /** Nothing to do, and why not. The common case. */
  | { kind: 'current'; why: string }
  /** Replayed onto the current base, and whether the remote was brought along. */
  | { kind: 'rebased'; label: string; onto: string; pushed: boolean }
  /** It would not replay. The branch is exactly as the worker left it. */
  | { kind: 'conflict'; label: string; why: string }
  /** Replayed here, but the remote still has the old history. */
  | { kind: 'stale'; label: string; why: string };

/**
 * Replay the attempt's branch onto the base as it is *now*, and push if it was already pushed.
 *
 * Fetches first, because a base read out of a local ref is a base as of whenever somebody last
 * pulled. Then one of four outcomes, two of which fail the attempt (`src/controller.ts`).
 *
 * `rebase.autoStash` rather than a bare rebase: an isolated Job may legitimately end with a dirty
 * tree — `exports` and `results` are both channels for handing back files nobody committed — and
 * refusing to rebase because of them would fail attempts for producing exactly what they were
 * asked for. On a conflict `--abort` restores the stash with everything else.
 *
 * Every failure path leaves the branch where it was. That is the property this function is allowed
 * to be trusted for: a checkout may be the only copy of a worker's output, and a rebase left half
 * applied would be this codebase's one irreversible mistake.
 */
export function rebaseOntoBase(root: string, wt: Worktree): RebaseResult {
  fetchBase(root);
  const label = baseRef(root);
  const base = resolveBase(root, label);

  const onBase = git(wt.path, ['merge-base', '--is-ancestor', base, 'HEAD']).status === 0;
  const count = git(wt.path, ['rev-list', '--count', `${base}..HEAD`]);
  const n = Number(count.stdout.trim());
  const ahead = count.status === 0 && Number.isFinite(n) ? n : 0;

  const plan = rebasePlan({ label, ahead, onBase });
  if (plan.act === 'nothing') return { kind: 'current', why: plan.why };

  const r = git(wt.path, ['-c', 'rebase.autoStash=true', 'rebase', base]);
  if (r.status !== 0) {
    // Status ignored: a rebase that never started has nothing to abort, and saying so would be
    // reporting our own cleanup instead of git's reason.
    git(wt.path, ['rebase', '--abort']);
    return { kind: 'conflict', label, why: conflictReason(`${r.stdout}\n${r.stderr}`) };
  }

  // Only a branch the worker actually pushed needs the remote told. One that never left the
  // checkout is rebased and finished — and force-pushing it here would create a pull request's
  // worth of remote state for work that deliberately has none.
  if (!pushedRef(root, wt.branch)) return { kind: 'rebased', label, onto: base, pushed: false };

  const p = gitNet(wt.path, ['push', '--force-with-lease', 'origin', wt.branch]);
  if (p.status !== 0) return { kind: 'stale', label, why: short(p.stderr) || 'git push --force-with-lease failed' };
  return { kind: 'rebased', label, onto: base, pushed: true };
}

/**
 * What the operator has to do about it, or null when there is nothing to do.
 *
 * Both failures name the exact commands, in the worktree they apply to, because the operator
 * reading this is looking at a Job that says `failed` next to a pull request that looks fine — and
 * the whole point of finding the conflict here rather than at merge time is that it arrives with
 * the checkout still on disk to fix it in.
 */
export function rebaseShortfall(jobId: number, wt: Worktree, r: RebaseResult): string | null {
  if (r.kind === 'conflict') {
    return `#${jobId} conflicts with ${r.label}: ${r.why}. The branch is untouched — `
      + `\`git -C ${wt.path} rebase ${r.label}\`, resolve it, then `
      + `\`git -C ${wt.path} push --force-with-lease\`.`;
  }
  if (r.kind === 'stale') {
    return `#${jobId} was rebased onto ${r.label} but the remote still has the old history: `
      + `${r.why}. Push it by hand: \`git -C ${wt.path} push --force-with-lease\`.`;
  }
  return null;
}
