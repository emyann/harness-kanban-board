import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { parsePrePush, readPolicy, refusePush } from './push.ts';

/**
 * The `pre-push` hook's entry point — the executable half of `src/push.ts`.
 *
 * Run by git, not by hkb: `~/.hkb/hooks/pre-push` is a three-line shell shim that execs this file,
 * so the decision lives in one place and in one language (see `shim` there).
 *
 * ## Every exit path admits, except the one that refuses
 *
 * A hook is on the path of every push in the worktree it governs, including the controller's own
 * `--force-with-lease` after a rebase (`src/rebase.ts`). So the failure mode to design against is
 * not "something got through" — it is "nothing can push any more, and the message is a stack
 * trace". A worktree with no policy is a worktree hkb does not govern, and the operator's own
 * checkout is exactly that: it exits 0. So does an unreadable stdin, a git that will not answer,
 * or a policy file somebody truncated.
 *
 * That is a deliberate asymmetry and it is the right way round *because the sandbox is not the only
 * guard*: what is admitted here still meets a controller that reads what actually landed. What a
 * hard failure here would produce is a board where nothing can finish.
 */
const worktree = (): string | null => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  const out = r.status === 0 ? r.stdout.trim() : '';
  return out || null;
};

function main(): number {
  const root = worktree();
  if (!root) return 0;
  // `--hooks <dir>`, written into the shim at install time. Not read from the environment: this
  // process is a grandchild of the worker, and `HKB_DATABASE_URL` reaching it is not something to
  // assume — see `policyFile`. Absent means the shim is older than this file, and the default is
  // then the only answer there is.
  const at = process.argv.indexOf('--hooks');
  const policy = readPolicy(root, at === -1 ? undefined : process.argv[at + 1]);
  if (!policy) return 0;

  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {
    return 0;
  }

  const why = refusePush(parsePrePush(stdin), policy);
  if (!why) return 0;
  // On stderr and prefixed, because this text lands in the middle of git's own output and a worker
  // reading it has to be able to tell who refused. The exit code is what stops the push; the line
  // is what tells it the next command.
  process.stderr.write(`hkb: ${why}\n`);
  return 1;
}

process.exit(main());
