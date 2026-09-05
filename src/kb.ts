import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openBoard, closeBoard } from './db.ts';
import { reconcile } from './controller.ts';
import { fakeRuntime } from './runtime/fake.ts';
import * as daemon from './daemon.ts';
import type { Runtime } from './runtime/index.ts';

/**
 * `kb` — the CLI for the ADR-007 core.
 *
 * Ten verbs, and each one arrived because something concrete demanded it. The old CLI has
 * thirty-six and that is the shape this one is trying not to grow into.
 *
 * `kb run` is still the foreground tool — one reconcile, in this process, streaming what the
 * worker does — and it is still the one to reach for when something is wrong, because everything
 * it does is visible. `kb up` is the same pass on a timer in a detached process; it exists for the
 * work only a clock can notice (`src/daemon.ts`), not to make `kb run` obsolete.
 *
 * Argument parsing is `node:util`'s `parseArgs` rather than a hand-rolled one — the old CLI's
 * parser silently eats a value that begins with two dashes, and there is no reason to inherit
 * that.
 */

const usage = (msg: string) => {
  const e = new Error(msg) as Error & { exitCode: number };
  e.exitCode = 2;
  return e;
};

const HELP = `kb — run one agent against one brief

  kb new <name>            file a Job
       --brief <text> | --brief-file <path> | --brief - (stdin)
       --agent <a>  --model <m>  --effort low|medium|high|xhigh|max
       --max-turns <n>  --max-budget <usd>  --max-retries <n>
       --no-isolate     run in the current checkout instead of its own worktree
       --board <slug>   default: default

  kb ls                    what is on the board        [--phase p] [--board s]
       --all               every board on this machine, with a BOARD column
  kb show <id>             one screen: spec, phase, every attempt
  kb run [<id>]            reconcile once, in the foreground   [--fake]
  kb retry <id>            re-queue a Job that stopped, resuming its session
       --max-budget <usd>  required when it stopped on max_budget: the same cap
                           would stop it in the same place
       --max-turns <n>  --max-retries <n>
  kb rm <id>               delete a Job and its attempts
  kb stop                  the kill switch: claim nothing on this board  [--board s]
  kb start                 clear it, and show the ceilings

  kb up                    reconcile every board on a timer, detached  [--interval <s>]
       --status            which boards are served, by what, since when — and what
                           each may still spend and claim
       --foreground        run the loop here instead of detaching (what a supervisor runs)
  kb down                  stop it, cleanly                    [--timeout <s>]
  kb log [<id>]            what happened, in order             [-n <count>]
       --since <dur>       only what is newer than 90s, 30m, 2h, 3d

  kb boards                every board on this machine
  kb boards add <slug>     point a board at a repository       [--repo <path>]
  kb boards rm <slug>      remove a board and everything on it [--force]
  kb boards set <slug>     the ceilings, without SQL
       --max-concurrent <n>  --daily-budget <usd>|none

The board is ~/.hkb/board.db — one per machine, a Board per repository, the way one
cluster holds a namespace per project. \`--board\` picks one; without it the repository
you are standing in decides. HKB_DATABASE_URL points at a different board entirely.

  --json on every verb. Exit 2 is usage or state.
`;

type Out = { json: boolean };
function emit(out: Out, data: unknown, human: () => void) {
  if (out.json) process.stdout.write(JSON.stringify(data, null, 1) + '\n');
  else human();
}

async function readBrief(values: Record<string, unknown>): Promise<string> {
  if (typeof values['brief-file'] === 'string') {
    const p = values['brief-file'];
    if (!fs.existsSync(p)) throw usage(`no such file: ${p} — --brief-file wants a path that exists`);
    return fs.readFileSync(p, 'utf8').trim();
  }
  // `--brief -` is the only way to read stdin, and it is explicit on purpose. Sniffing
  // `!process.stdin.isTTY` looks convenient and hangs forever the moment nothing is piped —
  // under a test runner, a cron, or a daemon, stdin is not a TTY and never closes.
  if (values.brief === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const piped = Buffer.concat(chunks).toString('utf8').trim();
    if (!piped) throw usage('--brief - was given but nothing arrived on stdin');
    return piped;
  }
  if (typeof values.brief === 'string' && values.brief.trim()) return values.brief.trim();
  throw usage('a Job needs a brief — pass --brief "…", --brief-file <path>, or --brief - to read stdin');
}

/** Who did an operator-initiated thing. The same shape a lease holder uses, minus the runtime. */
const whoami = () => `${os.hostname()}/${process.pid}@cli`;

/** The repository containing a directory, or null if it is not in one. */
export function gitRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? fs.realpathSync(out) : null;
  } catch {
    return null;
  }
}

export type Scope = { slug: string; repoPath: string | null; known: boolean };

/**
 * Which board a command means.
 *
 * With one board per machine and a Board per repository, `--board` on every command would be the
 * tedious-but-possible rung this project treats as a bug report. So: the flag wins; otherwise the
 * repository you are standing in decides, matched on `repoPath`; otherwise `default`.
 *
 * A repository with no board yet still resolves — to a slug named after it, which `kb new` will
 * create and point at the checkout. Reading verbs simply find nothing, which is the truth.
 *
 * Two boards on one checkout is a supported arrangement — `kb boards add` allows it so different
 * work can run under different budgets — so when the cwd matches more than one there is no answer
 * to infer, only a choice the operator has to make. It is asked for rather than guessed.
 */
export async function resolveBoard(
  db: ReturnType<typeof openBoard>,
  explicit?: string,
  cwd = process.cwd(),
): Promise<Scope> {
  if (explicit) {
    const b = await db.board.findUnique({ where: { slug: explicit } });
    return { slug: explicit, repoPath: b?.repoPath ?? gitRoot(cwd), known: !!b };
  }
  const root = gitRoot(cwd);
  if (!root) {
    const b = await db.board.findUnique({ where: { slug: 'default' } });
    return { slug: 'default', repoPath: b?.repoPath ?? null, known: !!b };
  }
  // By slug, not by id: the listing in the error below is something an operator reads and then
  // types back, so it is ordered the way `kb boards` orders it.
  const here = await db.board.findMany({ where: { repoPath: root }, orderBy: { slug: 'asc' } });
  if (here.length > 1) {
    throw usage(
      `${here.length} boards point at ${root}: ${here.map((b) => b.slug).join(', ')}`
      + ' — pass --board <slug> to say which one you mean',
    );
  }
  if (here.length === 1) return { slug: here[0].slug, repoPath: here[0].repoPath, known: true };
  return { slug: path.basename(root), repoPath: root, known: false };
}

const PHASES = ['pending', 'running', 'succeeded', 'failed', 'suspended'] as const;
type Phase = (typeof PHASES)[number];

/**
 * How long something took, compact enough to sit on an attempt line beside the cost.
 *
 * A cost with no duration beside it hides the difference between a run that finished in four
 * seconds and one that burned an hour of wall clock — today they print identically.
 *
 * The unit steps at a minute and at an hour, and truncates rather than rounds: a second short of
 * an hour must read `59m`, never `60m`, which is an hour that has not happened yet.
 */
export function formatDuration(ms: number): string {
  // Clock skew between the host that wrote `startedAt` and the one that wrote `endedAt` can put the
  // end before the start. A negative duration is not a fact worth printing.
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const num = (v: unknown, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw usage(`${flag} wants a number, got ${JSON.stringify(v)}`);
  return n;
};

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const UNITS = 's (seconds), m (minutes), h (hours) or d (days)';

/**
 * A short duration — `90s`, `30m`, `2h`, `3d` — as milliseconds.
 *
 * A bare number is refused rather than assumed. Every tool that guesses picks a different unit
 * (`sleep` seconds, `at` minutes, `find -mtime` days), so `--since 30` reads as thirty of whatever
 * the reader last used; being wrong by a factor of 1440 is silent, because a window that is too
 * wide still prints plausible-looking events. The unit is one character and it removes the whole
 * question, so it is required.
 *
 * Pure: it throws usage errors and touches nothing else, which is what makes it testable alone.
 */
export function parseDuration(input: string, flag = '--since'): number {
  const raw = input.trim();
  if (!raw) throw usage(`${flag} wants a duration like 30m, 2h or 3d — it was empty`);
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(raw);
  if (!m) throw usage(`${flag} does not understand ${JSON.stringify(raw)} — it wants a number and a unit, like 30m, 2h or 3d`);
  const [, digits, unit] = m;
  if (!unit) {
    throw usage(`${flag} ${digits} has no unit — write ${digits}m for minutes, or use ${UNITS}`);
  }
  const ms = UNIT_MS[unit];
  if (ms === undefined) throw usage(`${flag} does not know the unit "${unit}" — use ${UNITS}`);
  const n = Number(digits);
  if (!(n > 0)) {
    throw usage(`${flag} wants a positive duration, got ${raw} — it means "newer than this long ago", so it only points backwards`);
  }
  return n * ms;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      fake: { type: 'boolean' },
      force: { type: 'boolean' },
      'no-isolate': { type: 'boolean' },
      brief: { type: 'string' },
      'brief-file': { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      board: { type: 'string' },
      all: { type: 'boolean' },
      phase: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-budget': { type: 'string' },
      'max-retries': { type: 'string' },
      'max-concurrent': { type: 'string' },
      'daily-budget': { type: 'string' },
      status: { type: 'boolean' },
      repo: { type: 'string' },
      foreground: { type: 'boolean' },
      interval: { type: 'string' },
      timeout: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      since: { type: 'string' },
    },
  });

  const [verb, ...rest] = positionals;
  const out: Out = { json: !!values.json };
  if (!verb || values.help) { process.stdout.write(HELP); return 0; }

  const db = openBoard();
  // `up`, `down` and `boards` are machine-wide when no board is named, and so is `ls --all`;
  // everything else means the repository you are in. Resolving here keeps that one decision in one
  // place — but it also means resolution happens BEFORE the verb runs, so a verb that wants no
  // board has to say so here rather than by ignoring the answer. `ls --all` ignored it, and once
  // `resolveBoard` learned to refuse an ambiguous checkout it started refusing for a board that
  // command never reads.
  const named = (values.board as string) || undefined;
  const machineWide = ['up', 'down', 'boards'].includes(verb) || (verb === 'ls' && !!values.all);
  const scope = machineWide
    ? { slug: named ?? '', repoPath: null, known: false }
    : await resolveBoard(db, named);
  const slug = scope.slug;

  switch (verb) {
    // ---------------------------------------------------------------- new
    case 'new': {
      const name = rest.join(' ').trim();
      if (!name) throw usage('kb new <name> — a Job needs a name');
      const brief = await readBrief(values);
      const board = await db.board.upsert({
        where: { slug },
        update: {},
        // A board created by filing work in a repository is pointed at that repository. Without it
        // a machine-level daemon would have nowhere to cut the worktree.
        create: { slug, repoPath: scope.repoPath },
      });
      const effort = values.effort as string | undefined;
      if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
        throw usage(`--effort must be one of low|medium|high|xhigh|max, got ${effort}`);
      }
      const job = await db.job.create({
        data: {
          boardId: board.id, name, brief,
          agent: (values.agent as string) ?? undefined,
          model: (values.model as string) ?? null,
          effort: effort ?? null,
          isolate: !values['no-isolate'],
          maxTurns: num(values['max-turns'], '--max-turns'),
          maxBudgetUsd: num(values['max-budget'], '--max-budget'),
          maxRetries: num(values['max-retries'], '--max-retries'),
        },
      });
      await db.event.create({
        data: { kind: 'created', jobId: job.id, boardId: board.id, actor: whoami(), payload: { name } },
      });
      emit(out, { id: job.id, name: job.name, phase: job.phase, board: slug }, () =>
        console.log(`#${job.id} ${job.name}  [${job.phase}]  on ${slug}`));
      return 0;
    }

    // ---------------------------------------------------------------- ls
    case 'ls': {
      const phase = values.phase as Phase | undefined;
      if (phase && !PHASES.includes(phase)) throw usage(`--phase must be one of ${PHASES.join('|')}`);
      // Two ways to say which board, meaning opposite things. Letting one silently win would make
      // the same command line list one board or all of them depending on an order nobody can see.
      const all = !!values.all;
      if (all && named) {
        throw usage(`--all is every board on this machine and --board ${named} is one — they contradict each other. Drop whichever you did not mean.`);
      }
      const jobs = await db.job.findMany({
        where: { ...(all ? {} : { board: { slug } }), ...(phase ? { phase } : {}) },
        orderBy: [{ board: { slug: 'asc' } }, { id: 'asc' }],
        // The board is included whatever the scope, because `--json` carries it either way: a
        // consumer that has to branch on the flags it passed is reading a shape, not a record.
        include: { _count: { select: { attempts: true } }, board: { select: { slug: true } } },
      });
      emit(out, jobs.map((j) => ({
        id: j.id, board: j.board.slug, name: j.name, phase: j.phase, attempts: j._count.attempts,
        lastError: j.lastError, sessionId: j.lastSessionId,
      })), () => {
        if (!jobs.length) return console.log(all ? 'no jobs on any board' : `no jobs on ${slug}`);
        const w = all ? Math.max(...jobs.map((j) => j.board.slug.length)) : 0;
        for (const j of jobs) {
          const board = all ? `${j.board.slug.padEnd(w)}  ` : '';
          console.log(`${board}#${String(j.id).padEnd(4)} ${j.phase.padEnd(9)} ${String(j._count.attempts).padStart(2)}× ${j.name.slice(0, 64)}`);
        }
      });
      return 0;
    }

    // ---------------------------------------------------------------- show
    case 'show': {
      const id = num(rest[0], 'kb show <id>');
      if (!id) throw usage('kb show <id> — which Job?');
      const job = await db.job.findUnique({
        where: { id },
        include: { attempts: { orderBy: { k: 'asc' } }, lease: true, board: true },
      });
      if (!job) throw usage(`no Job #${id} — \`kb ls\` shows what is on the board`);
      emit(out, job, () => {
        console.log(`#${job.id} ${job.name}`);
        // One board per machine, one Board per repository: a Job you did not expect is usually a
        // Job on a board you were not thinking about. Which board, and which checkout it will run
        // in, comes before anything about the Job itself.
        console.log(
          `  board    ${job.board.slug}  `
          + `${job.board.repoPath ?? '(no repo — `kb boards add ' + job.board.slug + ' --repo <path>`)'}`,
        );
        console.log(`  phase    ${job.phase}${job.lease ? `  (leased by ${job.lease.holder} until ${job.lease.expiresAt.toISOString()})` : ''}`);
        console.log(`  spec     agent=${job.agent} model=${job.model ?? 'default'} effort=${job.effort ?? 'default'}`);
        console.log(`           maxTurns=${job.maxTurns} maxBudget=$${job.maxBudgetUsd} maxRetries=${job.maxRetries} isolate=${job.isolate}`);
        if (job.lastError) console.log(`  error    ${job.lastError}`);
        if (job.lastSessionId) console.log(`  resume   ${job.lastSessionId}`);
        console.log(`  brief    ${job.brief.split('\n')[0].slice(0, 88)}${job.brief.length > 88 ? ' …' : ''}`);
        if (!job.attempts.length) console.log('  attempts (none yet)');
        for (const a of job.attempts) {
          const cost = a.costUsd ? ` $${a.costUsd.toFixed(4)}` : '';
          // An attempt in flight has no `endedAt`, and elapsed-so-far is exactly what you want to
          // know about one: the trailing `+` says the number is still climbing.
          const took = formatDuration((a.endedAt ?? new Date()).getTime() - a.startedAt.getTime())
            + (a.endedAt ? '' : '+');
          console.log(`  k=${a.k}      ${(a.outcome ?? 'running').padEnd(11)}${took.padStart(7)}${cost}  ${a.sessionId ?? '—'}`);
          // The reviewable artifact. It is the point of the run, so it gets its own line rather
          // than being something you go and look for.
          if (a.prUrl) console.log(`           PR #${a.prNumber}  ${a.prUrl}`);
          else if (a.branch) console.log(`           branch ${a.branch} — no pull request found`);
          if (a.reason) console.log(`           ${a.reason.slice(0, 100)}`);
        }
      });
      return 0;
    }

    // ---------------------------------------------------------------- run
    case 'run': {
      const only = rest[0] ? num(rest[0], 'kb run <id>') : undefined;
      if (only && !(await db.job.findUnique({ where: { id: only } }))) {
        throw usage(`no Job #${only} — \`kb ls\` shows what is on the board`);
      }
      const runtime: Runtime = values.fake
        ? fakeRuntime()
        : (await import('./runtime/claude.ts')).claudeRuntime;

      const report = await reconcile({
        runtime, cwd: process.cwd(), only, board: slug,
        onEvent: out.json ? undefined : (l) => console.log(l),
        onRuntimeEvent: out.json ? undefined : (e) => {
          if (e.kind === 'tool') console.log(`         -> ${e.name}`);
          if (e.kind === 'text') console.log(`          : ${e.text}`);
        },
      });
      const moved = report.claimed.length + report.reclaimed.length;
      emit(out, report, () => {
        if (report.refused) console.log(`refused: ${report.refused}`);
        else if (!moved) console.log(only ? `#${only} is not pending — nothing to do` : 'nothing pending');
        else console.log(`${report.succeeded.length} succeeded, ${report.failed.length} failed, ${report.retrying.length} to retry`);
      });
      return 0;
    }

    // ---------------------------------------------------------------- rm
    case 'rm': {
      const id = num(rest[0], 'kb rm <id>');
      if (!id) throw usage('kb rm <id> — which Job?');
      const job = await db.job.findUnique({ where: { id }, include: { lease: true } });
      if (!job) throw usage(`no Job #${id} — nothing to remove`);
      if (job.lease) throw usage(`#${id} is leased by ${job.lease.holder} — it is running. Wait for it, or let the lease expire.`);
      await db.job.delete({ where: { id } });
      // `jobId` would cascade away with the Job it names, taking the record of the deletion with
      // it. The board keeps this one.
      await db.event.create({
        data: { kind: 'removed', boardId: job.boardId, actor: whoami(), payload: { id, name: job.name } },
      });
      emit(out, { removed: id }, () => console.log(`removed #${id}`));
      return 0;
    }

    // ---------------------------------------------------------------- retry
    // The deliberate re-queue. `nextPhase` retries what a retry could plausibly change and stops
    // at what it cannot — a Job that spent its whole budget gets the same cap next time, so the
    // controller fails it rather than making the same wall again. Raising the cap is a change to
    // the Job's spec, which belongs to whoever filed it: this is where they make it, in one
    // command, and the raise goes on the event stream so the extra money has a name against it.
    case 'retry': {
      const id = num(rest[0], 'kb retry <id>');
      if (!id) throw usage('kb retry <id> — which Job? `kb ls --phase failed` shows the candidates');
      const job = await db.job.findUnique({
        where: { id },
        include: { lease: true, attempts: { where: { endedAt: { not: null } }, orderBy: { k: 'desc' }, take: 1 } },
      });
      if (!job) throw usage(`no Job #${id} — \`kb ls\` shows what is on the board`);
      if (job.lease) {
        throw usage(`#${id} is leased by ${job.lease.holder} — it is running now. Wait for it, or let the lease expire.`);
      }
      if (job.phase === 'pending') throw usage(`#${id} is already pending — \`kb run ${id}\` works it now`);
      if (job.phase === 'running') {
        throw usage(`#${id} says running with no lease — \`kb run\` reclaims it, and re-queueing it by hand would race that`);
      }

      const budget = num(values['max-budget'], '--max-budget');
      const turns = num(values['max-turns'], '--max-turns');
      const retries = num(values['max-retries'], '--max-retries');
      // The guard. Re-queueing a budget-capped Job under its own cap buys exactly what the
      // automatic retry used to: the same run, the same stopping point, the same bill.
      if (job.attempts[0]?.outcome === 'max_budget' && !(budget !== undefined && budget > job.maxBudgetUsd)) {
        throw usage(
          `#${id} spent its whole $${job.maxBudgetUsd.toFixed(2)} budget and stopped with work left — running it `
          + 'again under the same cap stops in the same place, at the same price. Give it a bigger one: '
          + `\`kb retry ${id} --max-budget ${(job.maxBudgetUsd * 2).toFixed(2)}\`, or file a smaller brief.`,
        );
      }
      if (budget !== undefined && !(budget > 0)) {
        throw usage(`--max-budget wants dollars above zero, got ${budget} — a Job with no budget cannot run at all`);
      }

      await db.job.update({
        where: { id },
        data: {
          phase: 'pending',
          finishedAt: null,
          lastError: null,
          ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
          ...(turns !== undefined ? { maxTurns: turns } : {}),
          ...(retries !== undefined ? { maxRetries: retries } : {}),
        },
      });
      // Recorded, because "the cap was raised, by whom, from what" is the one fact that makes a
      // second $2 attempt legible six weeks later.
      const raise = budget !== undefined && budget !== job.maxBudgetUsd
        ? { maxBudgetUsd: { from: job.maxBudgetUsd, to: budget } } : {};
      await db.event.create({
        data: {
          kind: 'requeued', jobId: id, boardId: job.boardId, actor: whoami(),
          payload: { was: job.phase, ...raise, resume: job.lastSessionId },
        },
      });
      emit(out, {
        id, phase: 'pending', maxBudgetUsd: budget ?? job.maxBudgetUsd, resume: job.lastSessionId, ...raise,
      }, () => {
        const cap = budget !== undefined && budget !== job.maxBudgetUsd
          ? `  maxBudget $${job.maxBudgetUsd.toFixed(2)} → $${budget.toFixed(2)}` : '';
        // A resumed Job does not start over, and an operator about to watch it needs to know that
        // before they wonder why the branch already has commits on it.
        const from = job.lastSessionId ? `  (resumes ${job.lastSessionId})` : '  (starts cold)';
        console.log(`#${id} pending again${cap}${from}`);
      });
      return 0;
    }

    // ---------------------------------------------------------------- stop / start
    case 'stop':
    case 'start': {
      const stopping = verb === 'stop';
      const board = await db.board.upsert({
        where: { slug }, update: {}, create: { slug, repoPath: scope.repoPath },
      });
      const updated = await db.board.update({
        where: { id: board.id },
        data: stopping
          ? { pausedAt: new Date(), pausedBy: `${process.env.USER ?? 'someone'}@${process.pid}` }
          : { pausedAt: null, pausedBy: null },
      });
      await db.event.create({
        data: { kind: stopping ? 'board_stopped' : 'board_started', boardId: board.id, actor: whoami() },
      });
      emit(out, {
        board: slug, stopped: !!updated.pausedAt, pausedBy: updated.pausedBy,
        maxConcurrent: updated.maxConcurrent, dailyBudgetUsd: updated.dailyBudgetUsd,
      }, () => {
        if (stopping) {
          console.log(`${slug} stopped — nothing new will be claimed. A run already going is left alone.`);
        } else {
          const cap = updated.dailyBudgetUsd === null ? 'no ceiling' : `$${updated.dailyBudgetUsd}/24h`;
          console.log(`${slug} started — ${cap}, ${updated.maxConcurrent} concurrent`);
        }
      });
      return 0;
    }

    // ---------------------------------------------------------------- up / down
    case 'up': {
      // A floor, because there was not one: `--interval 0` ran 2221 passes in three seconds,
      // hammering the board. The loop is time-driven and nothing it watches has a sub-minute
      // tolerance, so a sub-second interval is always a mistake rather than a preference.
      const seconds = num(values.interval, '--interval');
      if (seconds !== undefined && !(seconds >= 1)) {
        throw usage(`--interval is in seconds and must be at least 1, got ${seconds} — the default is ${daemon.DEFAULT_INTERVAL_MS / 1000}`);
      }
      const intervalMs = seconds !== undefined ? seconds * 1000 : daemon.DEFAULT_INTERVAL_MS;

      if (values.status) {
        const rows = await daemon.status(named);
        emit(out, rows, () => {
          if (!rows.length) return console.log(named ? `no board "${named}"` : 'no boards yet');
          const w = Math.max(...rows.map((r) => r.slug.length));
          for (const r of rows) {
            const who = r.running
              ? `up    ${r.holder}  ${Math.round((r.uptimeMs ?? 0) / 60_000)} min, every ${Math.round((r.intervalMs ?? 0) / 1000)}s`
              : r.stale ? `down  (a stale controller row from ${r.holder} was left behind)` : 'down';
            console.log(`${r.slug.padEnd(w)}  ${who}`);
            const pad = ' '.repeat(w);
            // First, because it is the answer to "why is nothing running" more often than any
            // ceiling is, and a stopped board with a healthy daemon reads as fine without it.
            if (r.stopped) {
              console.log(`${pad}  STOPPED ${r.stoppedBy ? `by ${r.stoppedBy}, ` : ''}`
                + `since ${r.stoppedAt!.toISOString()} — \`kb start --board ${r.slug}\` to resume`);
            }
            const ceiling = r.dailyBudgetUsd === null
              ? `$${r.spent24h.toFixed(2)} spent in 24h, no ceiling`
              : `$${r.spent24h.toFixed(2)} of $${r.dailyBudgetUsd.toFixed(2)} spent in 24h`;
            console.log(`${pad}  limits  ${r.maxConcurrent} concurrent, ${ceiling}`);
            if (r.repoPath) console.log(`${pad}  repo    ${r.repoPath}`);
            // A daemon runs the code it started with. Saying so beats discovering it.
            if (r.behind) {
              console.log(`${pad}  BEHIND  started from ${r.version}; the checkout is now ${r.behind}`
                + ' — `kb down && kb up` to pick it up');
            }
          }
          // One line, because a daemon serving every board writes one log and a board-scoped one
          // writes its own: naming a single file per row would be right only half the time.
          if (rows.some((r) => r.running)) console.log(`\nlogs in ${daemon.boardDir()}`);
        });
        return rows.some((r) => r.running) ? 0 : 1;
      }

      // The loop, in this process. `kb up` without `--foreground` spawns exactly this.
      if (values.foreground) {
        const runtime: Runtime = values.fake
          ? fakeRuntime()
          : (await import('./runtime/claude.ts')).claudeRuntime;
        const stopper = new AbortController();
        // SIGTERM does NOT exit here. Exiting is what would leave a lease held: the release is
        // written after the worker stops, on the way out of `reconcile`, so the handler's only job
        // is to ask, and then to let the loop unwind on its own.
        const onSignal = (sig: string) => {
          if (stopper.signal.aborted) return;
          process.stdout.write(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${sig} — stopping after the run in flight\n`);
          stopper.abort();
        };
        process.on('SIGTERM', () => onSignal('SIGTERM'));
        process.on('SIGINT', () => onSignal('SIGINT'));

        await daemon.loop({
          runtime, cwd: process.cwd(), board: named, intervalMs, signal: stopper.signal,
        });
        return 0;
      }

      const started = daemon.start({ board: named, intervalMs, fake: !!values.fake });
      emit(out, started, () => {
        console.log(`up${named ? ` on ${named}` : ' on every board'} — pid ${started.pid}, every ${Math.round(intervalMs / 1000)}s`);
        console.log(`  log      ${started.log}`);
        console.log(`  status   kb up --status`);
      });
      return 0;
    }

    case 'down': {
      const timeoutMs = values.timeout !== undefined ? (num(values.timeout, '--timeout') as number) * 1000 : undefined;
      const res = await daemon.stop({ board: named, timeoutMs });
      emit(out, res, () => {
        if (res.stopped) console.log(`down — pid ${res.pid} stopped in ${((res.waitedMs ?? 0) / 1000).toFixed(1)}s`);
        else console.log(res.why);
      });
      return res.stopped ? 0 : 1;
    }

    // ---------------------------------------------------------------- boards
    case 'boards': {
      if (rest[0] === 'add') {
        const name = rest[1];
        if (!name) throw usage('kb boards add <slug> [--repo <path>] — what is the board called?');
        const repo = (values.repo as string) || gitRoot(process.cwd());
        if (!repo) throw usage('kb boards add needs --repo <path>, or to be run inside a git repository');
        const abs = path.resolve(repo);
        if (!fs.existsSync(path.join(abs, '.git'))) {
          throw usage(`${abs} is not a git repository — a board runs Jobs in a checkout, and workers need a branch to push`);
        }
        const board = await db.board.upsert({
          where: { slug: name }, update: { repoPath: abs }, create: { slug: name, repoPath: abs },
        });
        await db.event.create({ data: { kind: 'board_added', boardId: board.id, actor: whoami(), payload: { repoPath: abs } } });
        emit(out, { board: board.slug, repoPath: abs }, () =>
          console.log(`${board.slug} -> ${abs}`));
        return 0;
      }
      if (rest[0] === 'set') {
        const name = rest[1] ?? named;
        if (!name) throw usage('kb boards set <slug> --max-concurrent <n> --daily-budget <usd> — which board?');
        const board = await db.board.findUnique({ where: { slug: name } });
        if (!board) throw usage(`no board "${name}" — \`kb boards\` lists the ones on this machine`);

        const data: Record<string, unknown> = {};
        if (values['max-concurrent'] !== undefined) {
          const n = num(values['max-concurrent'], '--max-concurrent') as number;
          // 0 is meaningful — it drains a board without stopping it — but a negative is a typo,
          // and a fractional one silently floors somewhere far from here.
          if (!Number.isInteger(n) || n < 0) throw usage(`--max-concurrent wants a whole number of slots, 0 or more, got ${n}`);
          data.maxConcurrent = n;
        }
        if (values['daily-budget'] !== undefined) {
          const raw = String(values['daily-budget']);
          if (raw === 'none') data.dailyBudgetUsd = null;
          else {
            const v = num(raw, '--daily-budget') as number;
            if (!(v >= 0)) throw usage(`--daily-budget wants dollars, 0 or more, or "none" for no ceiling — got ${raw}`);
            data.dailyBudgetUsd = v;
          }
        }
        if (!Object.keys(data).length) {
          throw usage('kb boards set needs something to set — --max-concurrent <n> or --daily-budget <usd>|none');
        }

        const after = await db.board.update({ where: { id: board.id }, data });
        await db.event.create({
          data: { kind: 'ceilings_set', boardId: board.id, actor: whoami(), payload: data as never },
        });
        emit(out, {
          board: after.slug, maxConcurrent: after.maxConcurrent, dailyBudgetUsd: after.dailyBudgetUsd,
        }, () => console.log(
          `${after.slug} — ${after.dailyBudgetUsd === null ? 'no ceiling' : `$${after.dailyBudgetUsd}/24h`}, `
          + `${after.maxConcurrent} concurrent`));
        return 0;
      }

      if (rest[0] === 'rm') {
        const name = rest[1];
        if (!name) throw usage('kb boards rm <slug> [--force] — which board?');
        const board = await db.board.findUnique({
          where: { slug: name },
          include: { controller: true, _count: { select: { jobs: true } } },
        });
        if (!board) throw usage(`no board "${name}" — \`kb boards\` lists the ones on this machine`);

        // No `--force` past this one, deliberately. A daemon holding this board is reconciling it
        // right now, and the delete cascades to the Leases it is holding and the Jobs it is
        // running: the worker would keep going with nothing left to report to. Stopping the
        // daemon is a thing the operator can do, so make them do it.
        if (board.controller && daemon.controllerIsLive(board.controller as daemon.ControllerRow)) {
          throw usage(`${name} is led by ${board.controller.holder} — run \`kb down --board ${name}\` first, then remove it`);
        }
        const jobs = board._count.jobs;
        if (jobs && !values.force) {
          throw usage(`${name} has ${jobs} job${jobs === 1 ? '' : 's'}, and removing a board deletes its jobs, attempts, leases and events with it — pass --force to mean it`);
        }

        await db.board.delete({ where: { id: board.id } });
        // `boardId` would cascade away with the board it names, so this Event carries none and the
        // slug in the payload is the whole record. The same trade `kb rm` makes for a Job.
        await db.event.create({
          data: { kind: 'board_removed', actor: whoami(), payload: { slug: name, repoPath: board.repoPath, jobs } },
        });
        emit(out, { removed: name, jobs }, () =>
          console.log(`removed ${name}${jobs ? ` and ${jobs} job${jobs === 1 ? '' : 's'}` : ''}`));
        return 0;
      }
      if (rest[0]) throw usage(`kb boards has no subcommand "${rest[0]}" — try \`kb boards\`, \`kb boards add <slug>\`, \`kb boards set <slug>\` or \`kb boards rm <slug>\``);

      const serving = await daemon.status();
      const boards = await db.board.findMany({ orderBy: { slug: 'asc' }, include: { jobs: { select: { phase: true } } } });
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await Promise.all(boards.map(async (b) => {
        const spend = await db.attempt.aggregate({
          _sum: { costUsd: true },
          where: { job: { boardId: b.id }, startedAt: { gte: since } },
        });
        const by = (ph: string) => b.jobs.filter((j) => j.phase === ph).length;
        const d = serving.find((s) => s.slug === b.slug);
        return {
          board: b.slug,
          repoPath: b.repoPath,
          daemon: d?.running ? 'up' : 'down',
          paused: !!b.pausedAt,
          pending: by('pending'), running: by('running'),
          succeeded: by('succeeded'), failed: by('failed'),
          spent24h: spend._sum.costUsd ?? 0,
          maxConcurrent: b.maxConcurrent,
          dailyBudgetUsd: b.dailyBudgetUsd,
        };
      }));
      emit(out, rows, () => {
        if (!rows.length) return console.log('no boards yet — `kb new` inside a repository creates one');
        const w = Math.max(5, ...rows.map((r) => r.board.length));
        const d = Math.max(6, ...rows.map((r) => r.daemon.length + (r.paused ? 10 : 0)));
        console.log(`${'BOARD'.padEnd(w)}  ${'DAEMON'.padEnd(d)}  PEND   RUN    OK  FAIL      24H  REPO`);
        for (const r of rows) {
          const flag = r.paused ? ' (stopped)' : '';
          console.log(
            `${r.board.padEnd(w)}  ${(r.daemon + flag).padEnd(d)}  ${String(r.pending).padStart(4)}  `
            + `${String(r.running).padStart(4)}  ${String(r.succeeded).padStart(4)}  ${String(r.failed).padStart(4)}  `
            + `${('$' + r.spent24h.toFixed(2)).padStart(7)}  `
            + `${r.repoPath ?? '(no repo — `kb boards add ' + r.board + ' --repo <path>`)'}`,
          );
        }
      });
      return 0;
    }

    // ---------------------------------------------------------------- log
    case 'log': {
      const id = rest[0] ? num(rest[0], 'kb log <id>') : undefined;
      const limit = values.limit !== undefined ? (num(values.limit, '-n') as number) : 50;
      // `-n` is the wrong axis for "what happened while I was at lunch": a count answers how much
      // to read, not how far back. The two compose — the window narrows first, the count caps it.
      const window = values.since !== undefined ? parseDuration(String(values.since)) : undefined;
      const since = window !== undefined ? new Date(Date.now() - window) : undefined;
      if (id && !(await db.job.findUnique({ where: { id } }))) {
        throw usage(`no Job #${id} — \`kb ls\` shows what is on the board`);
      }
      const board = await db.board.findUnique({ where: { slug } });
      if (!board) throw usage(`no board "${slug}" — \`kb new\` creates one`);
      // Newest first out of the database so the limit keeps the RECENT events, then reversed for
      // reading: a log you read top to bottom that silently drops its tail is a trap.
      const rows = await db.event.findMany({
        where: {
          ...(id ? { jobId: id } : { OR: [{ boardId: board.id }, { job: { boardId: board.id } }] }),
          ...(since ? { at: { gte: since } } : {}),
        },
        orderBy: { id: 'desc' },
        take: limit,
      });
      rows.reverse();
      emit(out, rows, () => {
        if (!rows.length) {
          const what = id ? `for #${id}` : `on ${slug}`;
          // An empty window is not an empty log, and saying "nothing recorded yet" when the board
          // has a month of history would read as data loss.
          return console.log(since
            ? `nothing ${what} in the last ${values.since}`
            : `nothing recorded ${what} yet`);
        }
        for (const e of rows) {
          const who = e.actor ? `  ${e.actor}` : '';
          const extra = e.payload && Object.keys(e.payload as object).length
            ? `  ${JSON.stringify(e.payload)}` : '';
          console.log(`${e.at.toISOString()}  ${(e.jobId ? `#${e.jobId}` : '—').padEnd(5)} ${e.kind.padEnd(13)}${who}${extra}`);
        }
      });
      return 0;
    }

    default:
      throw usage(`unknown verb "${verb}" — try one of: new, ls, show, run, retry, rm, stop, start, up, down, log, boards`);
  }
}

export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } finally {
    await closeBoard();
  }
}
