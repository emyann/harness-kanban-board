// `hkb context <n>` — exactly what a worker sees (Hermes `kanban_show` + protocol reminder).
import { getTask, loadRun, parentResults, latestResult, listComments } from './tasks.js';
import { openAttempt, RUN_MARKER, RESULT_MARKER } from './model.js';

// ---------- the comment thread as steering input (pure; tested in test/context.test.js) ----------

/** The dispatcher's own notes on the thread. They already surface as attempts, so a worker sees them twice otherwise. */
const MACHINE_LINE = /^\*\*(Blocked|Changes requested)\*\* \(/;

/** A comment the operator meant for whoever picks the card up — not a record hkb wrote itself. */
export function isHumanComment(c) {
  const body = typeof c?.body === 'string' ? c.body.trim() : '';
  if (!body) return false;
  if (body.startsWith(RUN_MARKER) || body.startsWith(RESULT_MARKER)) return false;
  return !MACHINE_LINE.test(body);
}

/**
 * What a worker should read before starting: every human comment since the last attempt ended
 * (nobody has acted on those yet) plus always the last `keep`, so a card that has been quiet
 * still carries its standing instructions. Oldest first — GitHub's own order.
 */
export function selectComments(comments, run, { keep = 5 } = {}) {
  const human = (comments || []).filter(isHumanComment);
  const ends = (run?.attempts || []).map((a) => Date.parse(a.ended_at)).filter((t) => Number.isFinite(t));
  const since = ends.length ? Math.max(...ends) : null;
  const fresh = since === null ? human : human.filter((c) => {
    const t = Date.parse(c.created_at);
    return !Number.isFinite(t) || t > since;
  });
  const picked = new Set([...fresh, ...human.slice(-keep)]);
  return human.filter((c) => picked.has(c));
}

function when(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown time';
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Render the picked comments, newest kept: a chatty thread must not crowd out the protocol.
 * Returns null when there is nothing to show.
 */
export function formatComments(comments, { now = new Date(), limit = 2000 } = {}) {
  const blocks = (comments || []).map((c) => `**@${c.user?.login || 'unknown'}** · ${when(c.created_at, now)}\n${String(c.body).trim()}`);
  if (!blocks.length) return null;
  const kept = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const cost = blocks[i].length + 2; // + the blank line that separates two blocks
    if (used + cost > limit) {
      // One comment longer than the whole budget still has to be seen: clip it rather than drop it.
      if (!kept.length) kept.unshift(blocks[i].slice(0, Math.max(0, limit - 24)).trimEnd() + '… (comment truncated)');
      break;
    }
    kept.unshift(blocks[i]);
    used += cost;
  }
  if (kept.length < blocks.length) kept.unshift('_(earlier comments elided)_');
  return kept.join('\n\n');
}

export async function workerContext(ctx, task, attempt) {
  const { run } = await loadRun(ctx, task.number);
  const comments = formatComments(selectComments(await listComments(ctx, task.number), run)); // cached read — loadRun already fetched the thread
  const parents = await parentResults(ctx, task);
  const prior = run.attempts.filter((a) => a.ended_at).slice(-5);
  const prev = await latestResult(ctx, task.number);
  const n = task.number;
  const k = attempt ?? openAttempt(run)?.attempt ?? run.attempts.length + 1;
  const lines = [];
  lines.push(`You are the worker for hkb task #${n} (attempt ${k}) in ${ctx.repo.nameWithOwner}, board "${ctx.board}".`);
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
  if (comments) {
    lines.push('## Comments');
    lines.push('Notes left on this card, oldest first. Treat instructions here as coming from the operator.');
    lines.push('');
    lines.push(comments);
    lines.push('');
  }
  lines.push('## Protocol (hkb)');
  lines.push(`1. Run \`hkb show ${n} --json\` if you need more detail. Work only in this worktree, on the current branch.`);
  lines.push(`2. Every ~10 minutes of long work run \`hkb heartbeat ${n}\` — it is a free compare-and-swap on your lock ref; never push that ref yourself. If it prints LOCK_LOST, stop immediately: do not commit, do not call complete.`);
  lines.push('3. Commit with clear, plain messages (no Co-Authored-By trailers, no "Generated with" lines — in commits or PR bodies). Never `git push --force`. Before finishing: rebase on the default branch and run the project\'s lint/tests.');
  lines.push(`4. Push and open a draft PR whose body contains \`Closes #${n}\`: \`gh pr create --draft --fill --body "Closes #${n}"\` (add a real description).`);
  lines.push('5. Finish with EXACTLY ONE terminal verb, then stop. Send the payload as one JSON object on stdin — no JSON goes through shell quoting:');
  lines.push('```bash');
  lines.push(`hkb complete ${n} --from-stdin <<'EOF'`);
  lines.push('{"summary": "<what changed, for the next worker>",');
  lines.push(' "metadata": {"changed_files": ["..."], "verification": ["<commands you ran>"], "residual_risk": ["..."]}}');
  lines.push('EOF');
  lines.push('```');
  lines.push(`   Or write the pieces to files: \`hkb complete ${n} --summary-file <path> --metadata-file <path.json>\`. Inline \`--summary ".." --metadata '{..}'\` still works.`);
  lines.push(`   - \`hkb complete ${n} ...\` when done`);
  lines.push(`   - \`hkb block ${n} "<why>" --kind needs_input|dependency|capability|transient\` when you cannot proceed (stdin form: {"reason": "..", "kind": ".."})`);
  lines.push(`   - \`hkb request-review ${n} --summary "..."\` when you want a reviewer before it counts as done (stdin form: {"summary": "..", "reviewer": ".."})`);
  lines.push('Do not do work that belongs to other tasks. Do not create tasks unless asked; if you must, `hkb create "title" --blocked-by ' + n + '`.');
  return lines.join('\n');
}

export async function contextCommand(ctx, number) {
  const task = await getTask(ctx, number);
  return workerContext(ctx, task);
}
