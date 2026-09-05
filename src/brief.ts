/**
 * What every isolated Job is told, on top of its own brief.
 *
 * The worker never merges and never touches the operator's checkout — it commits on the branch it
 * was given and opens a *draft* pull request. A human merges. That is what keeps the Job kind
 * dumb: `succeeded` means the session ended, and whether the work is any good is a judgement made
 * by whoever reads the diff.
 *
 * Stated as a protocol rather than a hope. The two rules a worker could plausibly break — pushing
 * to the default branch, and merging its own work — are named explicitly, because "do not" is
 * cheaper here than discovering it afterwards.
 *
 * `exports` are the Job's declared outputs (ADR-008). They are named here because the controller
 * *fails the attempt* when one is missing, and a contract enforced against someone who was never
 * shown it is a trap rather than a contract. The paths themselves are still checked on disk — this
 * tells the worker what is expected, it does not ask it to report back.
 */
export function withProtocol(brief: string, branch: string, exports: string[] = []): string {
  const declared = exports.length
    ? [
      '',
      'This job must produce these paths, relative to the root of your checkout:',
      ...exports.map((p) => `  - \`${p}\``),
      '',
      'The board copies them out of this worktree when you are done, so they do not need to be',
      'committed — but a path that is not there when you finish fails the attempt.',
    ]
    : [];
  return [
    brief.trim(),
    ...declared,
    '',
    '---',
    '',
    'You are working in a git worktree of your own, already checked out on the branch',
    `\`${branch}\`. When the work is done:`,
    '',
    `  1. Commit it on \`${branch}\`. Write a plain message: a short imperative subject, and a body`,
    '     explaining why if the why is not obvious.',
    `  2. Push it: \`git push -u origin ${branch}\``,
    '  3. Open a DRAFT pull request against the default branch:',
    `     \`gh pr create --draft --title "…" --body "…" --head ${branch}\``,
    '  4. Reply with one line: what you did, and the PR URL.',
    '',
    'Rules:',
    '  - Never push to the default branch, and never merge. A human reviews and merges.',
    '  - Never `git push --force`.',
    '  - Do not add a Co-Authored-By trailer, a session URL, or a "Generated with" line to the',
    '    commit or the PR body. These are public repositories.',
    '  - If you cannot finish, still commit and push what you have, open the draft PR, and say',
    '    plainly what is unfinished. Work that is not pushed is work that is lost.',
  ].join('\n');
}
