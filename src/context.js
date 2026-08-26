// `ghk context <n>` — exactly what a worker sees (Hermes `kanban_show` + protocol reminder).
import { getTask, loadRun, parentResults, latestResult } from './tasks.js';
import { openAttempt } from './model.js';

export async function workerContext(ctx, task, attempt) {
  const { run } = await loadRun(ctx, task.number);
  const parents = await parentResults(ctx, task);
  const prior = run.attempts.filter((a) => a.ended_at).slice(-5);
  const prev = await latestResult(ctx, task.number);
  const n = task.number;
  const k = attempt ?? openAttempt(run)?.attempt ?? run.attempts.length + 1;
  const lines = [];
  lines.push(`You are the worker for ghkanban task #${n} (attempt ${k}) in ${ctx.repo.nameWithOwner}, board "${ctx.board}".`);
  lines.push('');
  lines.push(`# Task #${n}: ${task.title}`);
  lines.push('');
  lines.push(task.bodyText.trim() || '(no description)');
  lines.push('');
  if (task.kb.goal) lines.push(`## Acceptance criteria\n${task.kb.goal}\n`);
  if (task.kb.paths?.length) lines.push(`Scope: this task owns ${task.kb.paths.map((p) => '`' + p + '`').join(', ')} — stay inside it.\n`);
  if (task.kb.skills?.length) lines.push(`Skills to apply: ${task.kb.skills.map((s) => '`/' + s + '`').join(', ')}\n`);
  if (parents.length) {
    lines.push('## Parent task results');
    for (const p of parents) {
      lines.push(`### #${p.number} ${p.title || ''} (${String(p.state).toLowerCase()})`);
      if (p.result) {
        lines.push(p.result.summary || '(no summary)');
        if (p.result.metadata && Object.keys(p.result.metadata).length) lines.push('```json\n' + JSON.stringify(p.result.metadata, null, 2) + '\n```');
      } else lines.push('(no structured result recorded)');
      lines.push('');
    }
  }
  if (prior.length) {
    lines.push('## Prior attempts on this task');
    for (const a of prior) lines.push(`- attempt ${a.attempt} (${a.profile}): **${a.outcome}**${a.summary ? ' — ' + a.summary : ''}${a.reason ? ' — ' + a.reason : ''}`);
    if (prev?.metadata?.retry_notes) lines.push(`- retry notes: ${prev.metadata.retry_notes}`);
    lines.push('');
  }
  lines.push('## Protocol (ghkanban)');
  lines.push(`1. Run \`ghk show ${n} --json\` if you need more detail. Work only in this worktree, on the current branch.`);
  lines.push(`2. Every ~10 minutes of long work run \`ghk heartbeat ${n}\`. If it prints LOCK_LOST, stop immediately: do not commit, do not call complete.`);
  lines.push('3. Commit with clear messages. Never `git push --force`. Before finishing: rebase on the default branch and run the project\'s lint/tests.');
  lines.push(`4. Push and open a draft PR whose body contains \`Closes #${n}\`: \`gh pr create --draft --fill --body "Closes #${n}"\` (add a real description).`);
  lines.push('5. Finish with EXACTLY ONE terminal verb, then stop:');
  lines.push(`   - \`ghk complete ${n} --summary "<what changed, for the next worker>" --metadata '{"changed_files":[...],"verification":["<commands you ran>"],"residual_risk":["..."]}'\``);
  lines.push(`   - \`ghk block ${n} "<why>" --kind needs_input|dependency|capability|transient\` when you cannot proceed`);
  lines.push(`   - \`ghk request-review ${n} --summary "..."\` when you want a reviewer before it counts as done`);
  lines.push('Do not do work that belongs to other tasks. Do not create tasks unless asked; if you must, `ghk create "title" --blocked-by ' + n + '`.');
  return lines.join('\n');
}

export async function contextCommand(ctx, number) {
  const task = await getTask(ctx, number);
  return workerContext(ctx, task);
}
