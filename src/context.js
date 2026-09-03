// `hkb context <n>` — exactly what a worker sees (Hermes `kanban_show` + protocol reminder).
import { openStore } from './store/index.js';
import { activePrGuard, openAttempt, capabilityCommand, CAPABILITIES, RUN_MARKER, RESULT_MARKER, effectiveTools } from './model.js';

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

/**
 * The PR this attempt must continue, or null. Derived from the card, so `hkb context <n>` shows the
 * same block the dispatcher put in the worker's brief: an open PR under a latest `changes_requested`
 * row is a continuation, and anything else is not (`activePrGuard`, src/model.js).
 * `checkedOut` and `stale` are the two things the card cannot answer — the dispatcher passes them in
 * when it made the worktree on that branch itself (`worktreeOnBranch`, src/board.js): `checkedOut`
 * true means the checkout is at the PR's remote head; `stale` names why a checkout that exists on the
 * branch could not be fast-forwarded to it.
 */
export function continuation(task, run, { checkedOut = false, stale = null } = {}) {
  const g = activePrGuard(run?.attempts || [], task.prs);
  if (!g.continues) return null;
  return { number: g.pr.number, branch: g.pr.headRefName || null, base: g.pr.baseRefName || null, checkedOut, stale };
}

/**
 * The one block a continuing worker must not miss: which PR is open, that the review is on it, and
 * that pushing to its branch is the whole job — a second PR for one card is the failure this
 * prevents (#153).
 */
function continuationBlock(cont, { base }) {
  const b = cont.branch;
  const lines = [
    `## Continue PR #${cont.number} — do not open a second one`,
    '',
    `PR #${cont.number}${b ? ` (branch \`${b}\`)` : ''} is open with **changes requested** — the reviewer's note is the`,
    'latest attempt below. Continue that PR rather than starting again: a second PR for one card is the',
    'one thing that must not happen here.',
    '',
  ];
  if (cont.checkedOut) {
    lines.push(`- This worktree is already checked out on \`${b}\`, so an ordinary \`git push\` updates PR #${cont.number}.`);
  } else if (cont.stale && b) {
    lines.push(`- This worktree is checked out on \`${b}\`, but it could not be fast-forwarded to the PR's remote head (${cont.stale}). Catch it up first: \`git fetch origin ${b} && git reset --hard origin/${b}\`, then push as usual.`);
  } else if (b) {
    lines.push(`- This worktree is on a fresh branch. Take the PR's head first: \`git fetch origin ${b} && git reset --hard FETCH_HEAD\`, and push with \`git push origin HEAD:${b}\`.`);
  }
  lines.push(
    `- Merge \`origin/${base}\` into it before you finish (\`git fetch origin ${base} && git merge origin/${base}\`) — never rebase-and-force, never \`git push --force\`.`,
    `- Finish with \`hkb finish\` as usual: the card goes back to *review* on the same PR. Do **not** run \`gh pr create\`.`,
    '',
  );
  return lines;
}

/**
 * The capability intents this card triggers, in the order the brief renders them. Pure.
 *
 * A card triggers an intent by what it *is*, never by naming a command: a card with acceptance
 * criteria is work with an outcome to state (`goal`); a card continuing a PR that came back with
 * changes requested has work that already exists to re-read before touching it (`review`). Whether
 * the worker is then told a command is the profile's business (`capabilityCommand`) — an intent no
 * profile binds simply renders nothing extra, which is today's brief.
 *
 * `specify` is deliberately never triggered here: turning a one-liner into a spec happens *before* a
 * card is dispatched, so no worker brief is the place for it.
 */
export function briefIntents(task, { cont = null } = {}) {
  const intents = [];
  if (task?.kb?.goal) intents.push('goal');
  if (cont) intents.push('review');
  return intents;
}

/**
 * One line naming what **this** harness calls `intent`, or null when nothing binds it. Pure.
 *
 * The command text comes from the board's own config and nowhere else — hkb knows the intent and
 * what it means (`CAPABILITIES`), never the command. `null` is the ordinary answer: every board that
 * has never heard of `capabilities` gets a byte-identical brief to the one it got before.
 */
/**
 * One line naming the MCP servers this worker may reach, or null when nothing narrows them. Pure.
 *
 * The answer comes from `effectiveTools` (src/model.js) — the one derivation of what a launch may
 * use — and is never recomputed here. #130 is what this line is for: a worker that could not tell
 * whether the repo's own `react-aria` server was available built the components from training
 * knowledge and said nothing. Naming the set (and naming it as *empty* when it is empty) turns a
 * silent guess into a disclosable refusal.
 *
 * `null` is the ordinary answer: a board that declares no `mcp` and no posture renders the brief it
 * rendered before this existed, byte for byte.
 */
export function mcpLine(profile, task, board = null) {
  const { posture, allow, deny } = effectiveTools(profile, task, board).mcp;
  if (posture === 'inherit') {
    const except = deny.length ? ` — except ${deny.map((s) => '`' + s + '`').join(', ')}, which this board withholds from workers` : '';
    if (!allow) return `MCP: you inherit this session's MCP servers${except}.`;
    const only = allow.length ? allow.map((s) => '`' + s + '`').join(', ') : 'none';
    return `MCP: of this session's servers this card may use ${only}${except}.`;
  }
  if (!allow) return null;
  if (!allow.length) return 'MCP: no MCP server is available to you. If the work needs one, say so — do not work around it.';
  return `MCP servers available to you: ${allow.map((s) => '`' + s + '`').join(', ')}. Any other MCP server is denied — say so rather than guessing.`;
}

export function capabilityLine(profile, intent) {
  const cmd = capabilityCommand(profile, intent);
  if (!cmd) return null;
  return `On this harness that is \`${cmd}\` — ${CAPABILITIES[intent]}.`;
}

export async function workerContext(ctx, task, attempt, { continuePr = null, profile = null } = {}) {
  const store = await openStore(ctx);
  const { run } = await store.loadRun(task.number);
  // `listNotes` is the interface's name for the thread a person wrote on, and it has already dropped
  // hkb's own run and result records. `isHumanComment` still runs over what is left — it also hides
  // the dispatcher's own **Blocked**/**Changes requested** lines, which are notes by any store's
  // reckoning — and the two pure functions below keep reading a comment's own shape, so the rows are
  // handed to them in it.
  const notes = (await store.listNotes(task.number))
    .map((c) => ({ id: c.id, body: c.text, created_at: c.at, user: { login: c.actor } }));
  const comments = formatComments(selectComments(notes, run)); // cached read — loadRun already fetched the thread
  const parents = await store.parentResults(task);
  const prior = run.attempts.filter((a) => a.ended_at).slice(-5);
  const prev = await store.latestResult(task.number);
  const n = task.number;
  const k = attempt ?? openAttempt(run)?.attempt ?? run.attempts.length + 1;
  const lines = [];
  lines.push(`You are the worker for hkb task #${n} (attempt ${k}) in ${ctx.repo.nameWithOwner}, board "${ctx.board}".`);
  lines.push('');
  lines.push(`# Task #${n}: ${task.title}`);
  lines.push('');
  lines.push(task.bodyText.trim() || '(no description)');
  lines.push('');
  const cont = continuePr ?? continuation(task, run);
  const base = cont?.base || ctx.cfg?.default_branch || 'main';
  // The profile that will run this card. Only its `capabilities` map is read here, and only to name
  // what this harness calls an intent the card already triggers: an unbound intent adds nothing, so a
  // board that declares none renders exactly the brief it rendered before capabilities existed.
  const prof = profile ?? ctx.cfg?.profiles?.[task.agent] ?? null;
  const intents = briefIntents(task, { cont });
  const bound = (intent) => (intents.includes(intent) ? capabilityLine(prof, intent) : null);
  const goalCmd = bound('goal');
  if (task.kb.goal) lines.push(`## Acceptance criteria\n${task.kb.goal}\n${goalCmd ? goalCmd + '\n' : ''}`);
  if (task.kb.paths?.length) lines.push(`Scope: this task owns ${task.kb.paths.map((p) => '`' + p + '`').join(', ')} — stay inside it.\n`);
  if (task.kb.skills?.length) lines.push(`Skills to apply: ${task.kb.skills.map((s) => '`/' + s + '`').join(', ')}\n`);
  const mcp = mcpLine(prof, task, ctx.cfg);
  if (mcp) lines.push(`${mcp}\n`);
  if (cont) {
    lines.push(...continuationBlock(cont, { base }));
    const reviewCmd = bound('review');
    if (reviewCmd) lines.push(`Read what is already there before you change it. ${reviewCmd}`, '');
  }
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
  const where = cont?.checkedOut
    ? `Work only in this worktree — it is already checked out on \`${cont.branch}\`, PR #${cont.number}'s branch.`
    : cont
      ? 'Work only in this worktree, on the branch of the PR you are continuing (see above).'
      : 'Work only in this worktree, on the current branch.';
  lines.push(`1. Run \`hkb show ${n} --json\` if you need more detail. ${where}`);
  lines.push(`2. Every ~10 minutes of long work run \`hkb heartbeat ${n}\` — it is a free compare-and-swap on your lock ref; never push that ref yourself. If it prints LOCK_LOST, stop immediately: do not commit, do not file a terminal verb.`);
  // a continued branch is already pushed, so rebasing it would need the force-push the protocol forbids
  const upToDate = cont ? `merge \`origin/${base}\` in (never rebase: this branch is already pushed)` : 'rebase on the default branch';
  lines.push(`3. Commit with clear, plain messages (no Co-Authored-By trailers, no "Generated with" lines — in commits or PR bodies). Never \`git push --force\`. Before finishing: ${upToDate} and run the project's lint/tests.`);
  lines.push(cont
    ? `4. PR #${cont.number} already exists and already closes #${n} — push to its branch${cont.branch ? ` (\`${cont.branch}\`)` : ''} instead of opening one, and never \`--force\`.`
    : `4. Push and open a draft PR whose body contains \`Closes #${n}\`: \`gh pr create --draft --fill --body "Closes #${n}"\` (add a real description).`);
  lines.push('5. Finish with EXACTLY ONE terminal verb, then stop. Send the payload as one JSON object on stdin — no JSON goes through shell quoting. Write the file, then redirect it:');
  lines.push('```bash');
  lines.push(`# write /tmp/kb-${n}.json with your editor tool:`);
  lines.push('# {"summary": "<what changed, for the next worker>",');
  lines.push('#  "metadata": {"changed_files": ["..."], "verification": ["<commands you ran>"], "residual_risk": ["..."]}}');
  lines.push(`hkb finish ${n} --from-stdin < /tmp/kb-${n}.json`);
  lines.push('```');
  lines.push(`   \`finish\` is \`complete\` — the same verb under a name no shell claims. Say \`finish\`: \`complete\` is a bash builtin, so a harness that vets your command word by word may refuse to run it, and a heredoc (\`<<'EOF'\`) may be refused too. A redirect from a file is accepted everywhere.`);
  lines.push(`   Or write the pieces to files: \`hkb finish ${n} --summary-file <path> --metadata-file <path.json>\`. Inline \`--summary ".." --metadata '{..}'\` still works.`);
  lines.push(`   - \`hkb finish ${n} ...\` when done`);
  lines.push(`   - \`hkb block ${n} "<why>" --kind needs_input|dependency|capability|transient\` when you cannot proceed (stdin form: {"reason": "..", "kind": ".."})`);
  lines.push(`   - \`hkb request-review ${n} --summary "..."\` when you want a reviewer before it counts as done (stdin form: {"summary": "..", "reviewer": ".."})`);
  lines.push(`6. **If a tool or command is refused, disclose it — do not work around it.** Your launch decides what you may run and it denies rather than prompts, so a refusal is final: no rewording, no second route, no disabling the check. When there is no allow-listed way to do the work, run \`hkb block ${n} "needs <tool>: <why>" --kind capability\` (describe what you need, do not paste the refused command) and stop. A refusal of \`hkb complete\` itself is never a reason to block — that one has another name: \`hkb finish\`.`);
  lines.push('Never run `hkb dispatch` — it is what dispatched you; a second dispatcher double-claims tasks. Do not do work that belongs to other tasks. Do not create tasks unless asked; if you must, `hkb create "title" --blocked-by ' + n + '`.');
  return lines.join('\n');
}

export async function contextCommand(ctx, number) {
  const task = await (await openStore(ctx)).getTask(number);
  return workerContext(ctx, task);
}
