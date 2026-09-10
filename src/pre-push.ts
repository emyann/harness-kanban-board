import fs from 'node:fs';
import path from 'node:path';
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
const gitOut = (args: string[]): string => {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : '';
};

/**
 * Which repository this push is happening in, from whichever worktree of it we are standing in.
 *
 * `--git-common-dir` is the shared `.git` — the same answer from the main checkout, from an
 * attempt's worktree, and from the `<repo>/.claude/worktrees/agent-<id>` the harness cuts for a
 * subagent. That last one is why this exists: the policy used to be filed under the ATTEMPT's path
 * and was simply not found from a subagent's checkout, so the hook allowed everything there
 * (measured, #63).
 */
const repoRoot = (): string | null => {
  const common = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  // `<root>/.git` for an ordinary repository; a bare one answers with itself.
  return path.basename(common) === '.git' ? path.dirname(common) : common;
};

function main(): number {
  const root = repoRoot();
  if (!root) return 0;
  // `--hooks <dir>`, written into the shim at install time. Not read from the environment: this
  // process is a grandchild of the worker, and `HKB_DATABASE_URL` reaching it is not something to
  // assume — see `policyFile`. Absent means the shim is older than this file, and the default is
  // then the only answer there is.
  const at = process.argv.indexOf('--hooks');
  const policy = readPolicy(root, at === -1 ? undefined : process.argv[at + 1]);
  if (!policy) return 0;

  // The operator's own checkout is not governed, and this is the line that says so. The policy is
  // filed per REPOSITORY now, so without this the hook would refuse the operator's own pushes from
  // their own clone for as long as a Job held a lease on it. Every OTHER worktree of the repository
  // is governed — the attempt's, and the one the harness cuts for a subagent, which is the hole
  // this replaced a per-worktree `core.hooksPath` to close.
  const here = gitOut(['rev-parse', '--show-toplevel']);
  if (here && policy.mainWorktree && here === policy.mainWorktree) return chain(policy);

  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {
    return 0;
  }

  const why = refusePush(parsePrePush(stdin), policy);
  if (!why) return chain(policy, stdin);
  // On stderr and prefixed, because this text lands in the middle of git's own output and a worker
  // reading it has to be able to tell who refused. The exit code is what stops the push; the line
  // is what tells it the next command.
  process.stderr.write(`hkb: ${why}\n`);
  return 1;
}

/**
 * Hand off to the repository's own `pre-push`, when it had one before hkb pointed the repository
 * here (`foreignHooks`, `src/push.ts`).
 *
 * After our refusal, never instead of it: hkb's rule is the one that must not be skippable, and a
 * repository's own hook is the one that must not be silently lost. Pointing the whole repository at
 * hkb's hooks would otherwise disable husky, lefthook or a committed `.githooks` for the operator
 * as much as for a worker.
 *
 * Its stdin is the ref list it would have been given, re-fed, because we consumed the real one.
 */
function chain(policy: { chain: string | null }, stdin = ''): number {
  if (!policy.chain) return 0;
  const hook = path.join(policy.chain, 'pre-push');
  try {
    if (!fs.existsSync(hook)) return 0;
  } catch {
    return 0;
  }
  const r = spawnSync(hook, process.argv.slice(2).filter((a) => a !== '--hooks' && a !== process.argv[process.argv.indexOf('--hooks') + 1]), {
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  return r.status ?? 0;
}

process.exit(main());
