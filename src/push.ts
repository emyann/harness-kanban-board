import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { boardDir } from './db-url.ts';

/**
 * `push` — the one line of the sandbox contract that is enforced rather than asked for, and the
 * layer it is enforced at.
 *
 * "Never push to the default branch" was prose in `src/brief.ts`, and prose is layer 6 of
 * `docs/workflow-study.md` §4: *"guarantees nothing; measured guaranteeing nothing twice"*. The
 * study's own rule is that determinism belongs at the lowest layer that can REFUSE — and the first
 * answer to that was the `PreToolUse` hook, reading the `Bash` command as text. That answer was
 * measured against a real remote and it did not hold:
 *
 *   - `-f --force-with-lease` — git's `--force` disables the lease, so the pair is a plain force;
 *   - bundled short options (`-fu`, `-fd`), and `:kb-7-1`, git's spelling for a delete;
 *   - `>/dev/null` before a trailing `main`, where the redirect ends the segment a parser reads;
 *   - `-c remote.origin.push=refs/heads/kb-7-1:refs/heads/main`, which **persists in the shared
 *     `.git/config`**, so the controller's own later `--force-with-lease` rewrote `main`;
 *   - `git -c alias.p=push p origin main`, `/usr/bin/git`, `"gi"t`, `sh -c`, `python -c os.system`.
 *
 * And it over-refused in the other direction: `git commit -m "$(cat <<'EOF' … push … EOF)"` — the
 * commit form Claude Code teaches — was refused for mentioning the word, and so were `git stash
 * push`, `git grep push` and a backslash-newline continuation.
 *
 * The fault is not the parser. It is the layer: **what a worker typed and what git does are
 * different strings**, separated by aliases, config, expansion and nested shells. So the decision
 * moves to the place where they have stopped being different — git's own `pre-push` hook, which is
 * handed the resolved local→remote refs after all of that has already happened. There is nothing
 * left to spell around: `git -c alias.p=push p origin main` reaches this hook as
 * `refs/heads/main`, and so does every other form above.
 *
 * ## Where the hook lives, and why it is not in the worktree
 *
 * `core.hooksPath` is set **on the attempt's worktree only**, pointing at `~/.hkb/hooks` — outside
 * every checkout a worker can write. A hook under `.git/hooks` or a repository's own `.githooks`
 * would be a file the worker edits with the tool it edits everything else with, which is a guard
 * that asks permission from the thing it guards. Per-worktree rather than repository-wide
 * (`extensions.worktreeConfig`) so that the operator's own checkout is completely unaffected: their
 * hooks, their pushes, no hkb in the middle.
 *
 * ## What the gate still does
 *
 * Two refusals, both about the hook rather than about the push: `--no-verify`, which skips it, and
 * an attempt to move `core.hooksPath` out from under it. Those are narrow enough to read as text,
 * which is exactly what the branch rule was not.
 *
 * ## What this is not
 *
 * It is not a jail. A worker runs as the operator's user and could chmod the policy back, edit the
 * config, or push from a checkout it made itself. The bar is the honest one: a plausible mistake and
 * a casual escape are refused deterministically, by the same mechanism whatever the prompt says,
 * and `never merge` is prose because a merge on the forge is an API call no git hook ever sees —
 * `src/brief.ts` says which of its lines are which rather than claiming they are all enforced.
 */

/** Who this worker is, for the purpose of deciding what it may push. */
export type PushPolicy = {
  /** The attempt's own branch. The only ref on the remote this worker may write. */
  branch: string;
  /** The repository's default branch, from the same place `baseRef` reads it. Message only. */
  defaultBranch: string;
};

/** One line of what git hands a `pre-push` hook on stdin. */
export type PushRef = {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
};

/** The all-zero object id: git's spelling for "there is nothing here", on either side. */
const ZERO = /^0+$/;

/**
 * The lines git writes to a `pre-push` hook's stdin, as records.
 *
 * `<local ref> <local sha> <remote ref> <remote sha>`, one per ref being updated, and a deletion
 * has `(delete)` and zeros on the local side. Malformed lines are KEPT rather than skipped, with
 * empty fields — `refusePush` refuses what it cannot place, and dropping a line here would be a
 * silent admission of exactly the case worth refusing.
 */
export function parsePrePush(stdin: string): PushRef[] {
  return String(stdin ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * May this push happen? A reason to refuse it, or null.
 *
 * **Pure, and the refusing case is the case that matters** — `src/limits.ts`, `src/liveness.ts` and
 * `src/spec.ts` are the pattern, and a guard only ever tested for what it ALLOWS is how this project
 * shipped three checks that did nothing.
 *
 * The rule is one sentence: every ref this push updates is `refs/heads/<the attempt's branch>`, and
 * none of them is a deletion. That covers the trunk, another Job's branch, `--all`, `--mirror`,
 * `--tags`, a glob refspec and every spelling of a delete, because by the time git calls this hook
 * all of those have already been expanded into the ref list it hands over.
 *
 * A push updating NOTHING is admitted: git runs the hook with empty stdin for an up-to-date push,
 * and refusing there would fail a no-op.
 */
export function refusePush(refs: PushRef[], policy: PushPolicy): string | null {
  const mine = `refs/heads/${policy.branch}`;
  for (const r of refs) {
    if (ZERO.test(r.localSha) || r.localRef === '(delete)' || !r.localSha) {
      return `this push DELETES \`${r.remoteRef || 'a remote ref'}\`. A worker does not delete refs on the `
        + `remote — what it pushed is what a human reads. ${allowed(policy)}`;
    }
    if (r.remoteRef === mine) continue;
    if (r.remoteRef === `refs/heads/${policy.defaultBranch}`) {
      return `this push writes \`${policy.defaultBranch}\`, this repository's default branch. A worker never `
        + 'writes the trunk: it pushes its own branch and a human decides what happens to it. '
        + `${allowed(policy)}`;
    }
    return `this push writes \`${r.remoteRef || '(no ref)'}\`, and this attempt owns \`${policy.branch}\` and `
      + `nothing else — another ref belongs to another Job, or to somebody. ${allowed(policy)}`;
  }
  return null;
}

/** The form that works, named in every refusal so the next command is the right one. */
const allowed = (p: PushPolicy): string => `Push your own branch: \`git push -u origin ${p.branch}\`.`;

// ---------------------------------------------------------------- the two the gate still reads

/**
 * The `Bash` refusals that are left, and they are about the HOOK rather than about the push.
 *
 * Deliberately two narrow patterns and no parser. Everything the parser used to attempt is now
 * decided by git itself; what git cannot defend is being told not to run the hook at all, and that
 * is a flag and a config key — short, literal, and with no legitimate use inside a sandbox.
 *
 * `git config core.hooksPath` is included in the same breath as `-c`, because the persistent form
 * of the same move is the one that already bit us once: a `-c remote.origin.push=…` written into
 * the shared config outlived the command that set it.
 */
export function checkHookEscape(command: string): string | null {
  if (typeof command !== 'string') return null;
  if (/--no-verify\b/.test(command) && /\bgit\b/.test(command) && /\bpush\b/.test(command)) {
    return '`--no-verify` skips the `pre-push` hook that keeps this worktree a sandbox, so it is '
      + 'refused. Push without it — the hook allows your own branch and refuses everything else.';
  }
  if (/\bcore\.hooksPath\b/i.test(command)) {
    return '`core.hooksPath` is what points git at hkb\'s `pre-push` hook, and a worker does not move '
      + 'it. If a repository hook is in your way, say so in your reply rather than disabling it.';
  }
  return null;
}

// ---------------------------------------------------------------- installing it

/**
 * Where the hook and its policies live: **beside the board**, which is outside every checkout.
 *
 * `boardDir()` and not `~/.hkb` directly, for the reason the log files use it — one daemon serves
 * every board, and `HKB_DATABASE_URL` points at a different one. A hook rooted at the home
 * directory would be shared by boards that share nothing else, and a test would write over the
 * operator's.
 */
export const hooksHome = (): string => path.join(boardDir(), 'hooks');

/**
 * The policy file for one worktree, named by the worktree it governs.
 *
 * Keyed by a hash of the real path rather than by the branch, because the hook's only reliable
 * fact about itself is where it is running: git runs a `pre-push` hook with the worktree's top
 * level as its working directory, and the branch is precisely what a worker can change under it.
 *
 * `home` is a parameter and the hook passes it explicitly. It must NOT re-derive it: a hook is a
 * child of `git push`, which is a child of the worker, and `HKB_DATABASE_URL` reaching that far is
 * not something this code gets to assume. A hook that resolved the wrong board's directory would
 * find no policy and admit the push — silently, which is the one failure mode a guard may not have.
 */
export const policyFile = (worktree: string, home = hooksHome()): string =>
  path.join(home, 'policy', `${crypto.createHash('sha1').update(real(worktree)).digest('hex')}.json`);

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

const git = (cwd: string, args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

/**
 * Install the hook and pin this attempt's policy to this worktree.
 *
 * Called at claim time and idempotent, because a controller is level-triggered: it runs on every
 * attempt, over a worktree that may already have been set up by the attempt before it, and the
 * second run must be a no-op rather than a failure.
 *
 * **Pinned at claim time** is the load-bearing half. The branch written here is the one the
 * controller created the worktree on; reading it from the checkout instead would let attempt 1's
 * `git switch develop` license attempt 2 to push `develop`, which is the shape of hole this
 * module exists to close.
 *
 * Returns a reason it could not be installed, or null. A reason is a REFUSAL to run the attempt —
 * an unenforced sandbox that reports itself as enforced is worse than no sandbox, and this project
 * has shipped that exact thing three times.
 */
export function installPushHook(root: string, worktree: string, policy: PushPolicy): string | null {
  const home = hooksHome();
  try {
    fs.mkdirSync(path.join(home, 'policy'), { recursive: true });
    // Removed before it is written, both here and below: these files are left read-only on purpose,
    // and a second claim must be able to rewrite them. `installPushHook` runs on EVERY attempt —
    // a controller is level-triggered, and a guard that installs once and fails afterwards is a
    // guard that stops the board.
    const hook = path.join(home, 'pre-push');
    fs.rmSync(hook, { force: true });
    fs.writeFileSync(hook, shim(), { mode: 0o755 });
    fs.chmodSync(hook, 0o555);
    const file = policyFile(worktree, home);
    // Rewritten every claim, so a resumed attempt on a re-used worktree is governed by the branch
    // THIS attempt was given rather than by the one the last attempt ended on.
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...policy, worktree: real(worktree) }, null, 2)}\n`, { mode: 0o444 });
  } catch (e) {
    return `hkb could not install its \`pre-push\` hook under ${home}: ${(e as Error).message}`;
  }

  // `extensions.worktreeConfig` is what makes `--worktree` legal in a linked worktree, and it is
  // set on the repository once. Its one documented hazard is a repository that keeps `core.bare` or
  // `core.worktree` in the shared config, where enabling the extension changes which worktree those
  // apply to — so that case is refused by name rather than silently converted.
  for (const key of ['core.bare', 'core.worktree']) {
    const v = git(root, ['config', '--local', '--get', key]);
    if (v.status === 0 && v.stdout.trim() && v.stdout.trim() !== 'false') {
      return `${root} sets \`${key}\` in its shared config, and hkb's sandbox needs `
        + '`extensions.worktreeConfig`, which changes what that setting applies to. Move it to '
        + '`.git/config.worktree` by hand first — see `git config --help`, "CONFIGURATION FILE".';
    }
  }
  const ext = git(root, ['config', '--local', 'extensions.worktreeConfig', 'true']);
  if (ext.status !== 0) return `hkb could not enable \`extensions.worktreeConfig\` in ${root}: ${short(ext.stderr)}`;
  const set = git(worktree, ['config', '--worktree', 'core.hooksPath', home]);
  if (set.status !== 0) return `hkb could not point ${worktree} at its \`pre-push\` hook: ${short(set.stderr)}`;
  return null;
}

const short = (s: string): string => String(s ?? '').trim().split('\n')[0] ?? '';

/**
 * The hook itself: a shell shim that runs the decision above in this same package.
 *
 * The shim is shell because git requires an executable, and it is *only* a shim because a rule
 * written twice is a rule that drifts — `refusePush` is the decision, it has an exhaustive test,
 * and the hook must not be a second copy of it in another language.
 *
 * `process.execPath` is baked in rather than resolved from `PATH`. A git hook inherits whatever
 * environment the pushing process had, and under `nvm` a worker's `PATH` routinely does not have
 * the node the daemon is running on it. A hook that cannot find node exits non-zero and refuses
 * every push, which is a sandbox that has become a wall.
 */
function shim(): string {
  const entry = path.resolve(import.meta.dirname, fs.existsSync(path.resolve(import.meta.dirname, 'pre-push.js')) ? 'pre-push.js' : 'pre-push.ts');
  return [
    '#!/bin/sh',
    '# Installed by hkb. The decision is `refusePush` in src/push.ts — do not edit this file.',
    // The hooks directory is baked in rather than re-derived, so the hook needs no environment at
    // all: see `policyFile`. It is this file's own directory, and `$(dirname "$0")` would be the
    // shorter way to say so — but a hook is invoked by git with a path this shim does not control,
    // and a literal cannot be wrong.
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} --hooks ${JSON.stringify(hooksHome())} "$@"`,
    '',
  ].join('\n');
}

/** Read back the policy governing a worktree, or null when nothing governs it. */
export function readPolicy(worktree: string, home?: string): PushPolicy | null {
  try {
    const raw = JSON.parse(fs.readFileSync(policyFile(worktree, home), 'utf8')) as Partial<PushPolicy>;
    if (typeof raw.branch !== 'string' || !raw.branch) return null;
    return { branch: raw.branch, defaultBranch: typeof raw.defaultBranch === 'string' ? raw.defaultBranch : '' };
  } catch {
    return null;
  }
}
