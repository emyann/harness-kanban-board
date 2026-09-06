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
 */
export function withProtocol(brief: string, branch: string): string {
  return [
    brief.trim(),
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

/**
 * The results contract, appended to whatever brief the Job already has.
 *
 * Separate from `withProtocol` on purpose: that one is the *pull request* protocol and is applied
 * only to an isolated Job, because only an isolated Job has a branch. Results are the opposite case
 * — they matter most to a Job that produces no commit at all — so this is applied to both.
 *
 * The paths are absolute and outside every checkout (`src/results.ts`), so writing one cannot land
 * in the worker's diff. Stated as a hard requirement rather than a suggestion, because the
 * controller enforces it: a declared result that is not written fails the attempt.
 */
export function withResults(brief: string, paths: Record<string, string>): string {
  const names = Object.keys(paths);
  if (!names.length) return brief;
  return [
    brief.trimEnd(),
    '',
    '---',
    '',
    `This Job must produce ${names.length === 1 ? 'one result' : `${names.length} results`}. Write each one to the`,
    'exact path given, as plain text, before you finish:',
    '',
    ...names.map((n) => `  - \`${n}\` → \`${paths[n]}\``),
    '',
    'These are small values the board keeps and hands to whoever reads this Job next — a finding, a',
    'decision, a URL. Keep each under 4 KB; anything larger belongs in the repository as a file.',
    'A declared result you do not write fails the attempt, so if the honest answer is "nothing",',
    'write that.',
  ].join('\n');
}
