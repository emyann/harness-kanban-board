import fs from 'node:fs';
import os from 'node:os';
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
  kb show <id>             one screen: spec, phase, every attempt
  kb run [<id>]            reconcile once, in the foreground   [--fake]
  kb rm <id>               delete a Job and its attempts
  kb stop                  the kill switch: claim nothing on this board  [--board s]
  kb start                 clear it, and show the ceilings

  kb up                    reconcile on a timer, detached      [--interval <s>] [--fake]
       --status            is a daemon up? where is its log?
       --foreground        run the loop here instead of detaching (what a supervisor runs)
  kb down                  stop it, cleanly                    [--timeout <s>]
  kb log [<id>]            what happened, in order             [-n <count>]

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

const PHASES = ['pending', 'running', 'succeeded', 'failed', 'suspended'] as const;
type Phase = (typeof PHASES)[number];

const num = (v: unknown, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw usage(`${flag} wants a number, got ${JSON.stringify(v)}`);
  return n;
};

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      fake: { type: 'boolean' },
      'no-isolate': { type: 'boolean' },
      brief: { type: 'string' },
      'brief-file': { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      board: { type: 'string' },
      phase: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-budget': { type: 'string' },
      'max-retries': { type: 'string' },
      status: { type: 'boolean' },
      foreground: { type: 'boolean' },
      interval: { type: 'string' },
      timeout: { type: 'string' },
      limit: { type: 'string', short: 'n' },
    },
  });

  const [verb, ...rest] = positionals;
  const out: Out = { json: !!values.json };
  if (!verb || values.help) { process.stdout.write(HELP); return 0; }

  const db = openBoard();
  const slug = (values.board as string) || 'default';

  switch (verb) {
    // ---------------------------------------------------------------- new
    case 'new': {
      const name = rest.join(' ').trim();
      if (!name) throw usage('kb new <name> — a Job needs a name');
      const brief = await readBrief(values);
      const board = await db.board.upsert({ where: { slug }, update: {}, create: { slug } });
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
      const jobs = await db.job.findMany({
        where: { board: { slug }, ...(phase ? { phase } : {}) },
        orderBy: { id: 'asc' },
        include: { _count: { select: { attempts: true } } },
      });
      emit(out, jobs.map((j) => ({
        id: j.id, name: j.name, phase: j.phase, attempts: j._count.attempts,
        lastError: j.lastError, sessionId: j.lastSessionId,
      })), () => {
        if (!jobs.length) return console.log(`no jobs on ${slug}`);
        for (const j of jobs) {
          console.log(`#${String(j.id).padEnd(4)} ${j.phase.padEnd(9)} ${String(j._count.attempts).padStart(2)}× ${j.name.slice(0, 64)}`);
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
        console.log(`  phase    ${job.phase}${job.lease ? `  (leased by ${job.lease.holder} until ${job.lease.expiresAt.toISOString()})` : ''}`);
        console.log(`  spec     agent=${job.agent} model=${job.model ?? 'default'} effort=${job.effort ?? 'default'}`);
        console.log(`           maxTurns=${job.maxTurns} maxBudget=$${job.maxBudgetUsd} maxRetries=${job.maxRetries} isolate=${job.isolate}`);
        if (job.lastError) console.log(`  error    ${job.lastError}`);
        if (job.lastSessionId) console.log(`  resume   ${job.lastSessionId}`);
        console.log(`  brief    ${job.brief.split('\n')[0].slice(0, 88)}${job.brief.length > 88 ? ' …' : ''}`);
        if (!job.attempts.length) console.log('  attempts (none yet)');
        for (const a of job.attempts) {
          const cost = a.costUsd ? ` $${a.costUsd.toFixed(4)}` : '';
          console.log(`  k=${a.k}      ${(a.outcome ?? 'running').padEnd(11)}${cost}  ${a.sessionId ?? '—'}`);
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

    // ---------------------------------------------------------------- stop / start
    case 'stop':
    case 'start': {
      const stopping = verb === 'stop';
      const board = await db.board.upsert({ where: { slug }, update: {}, create: { slug } });
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
      const intervalMs = values.interval !== undefined
        ? (num(values.interval, '--interval') as number) * 1000
        : daemon.DEFAULT_INTERVAL_MS;

      if (values.status) {
        const st = daemon.status(slug);
        emit(out, st, () => {
          if (!st.running) {
            console.log(`no daemon on ${slug}${st.stale ? ` (a stale pid file from pid ${st.daemon.pid} was left behind)` : ''}`);
            console.log(`  log      ${st.log}`);
            console.log(`  start it with \`kb up --board ${slug}\``);
          } else {
            const mins = Math.round(st.uptimeMs / 60_000);
            console.log(`up on ${slug} — pid ${st.daemon.pid}, ${mins} min, every ${Math.round(st.daemon.intervalMs / 1000)}s`);
            console.log(`  since    ${st.since.toISOString()}`);
            console.log(`  log      ${st.log}`);
          }
        });
        return st.running ? 0 : 1;
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
          process.stdout.write(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${sig} — stopping after the run in flight
`);
          stopper.abort();
        };
        process.on('SIGTERM', () => onSignal('SIGTERM'));
        process.on('SIGINT', () => onSignal('SIGINT'));

        const pidFile = daemon.claimPidFile(slug, intervalMs);
        try {
          await daemon.loop({
            runtime, cwd: process.cwd(), board: slug, intervalMs, signal: stopper.signal,
          });
        } finally {
          daemon.releasePidFile(slug);
        }
        if (out.json) process.stdout.write(JSON.stringify({ board: slug, pidFile, stopped: true }, null, 1) + '\n');
        return 0;
      }

      const started = daemon.start(slug, { intervalMs, fake: !!values.fake });
      emit(out, started, () => {
        if (!started.started) console.log(started.why);
        else {
          console.log(`up on ${slug} — pid ${started.pid}, every ${Math.round(intervalMs / 1000)}s`);
          console.log(`  log      ${started.log}`);
          console.log(`  stop it  kb down --board ${slug}`);
        }
      });
      return started.started ? 0 : 2;
    }

    case 'down': {
      const timeoutMs = values.timeout !== undefined ? (num(values.timeout, '--timeout') as number) * 1000 : undefined;
      const res = await daemon.stop(slug, { timeoutMs });
      emit(out, res, () => {
        if (res.stopped) console.log(`down — pid ${res.pid} stopped in ${((res.waitedMs ?? 0) / 1000).toFixed(1)}s`);
        else console.log(res.why);
      });
      return res.stopped ? 0 : 1;
    }

    // ---------------------------------------------------------------- log
    case 'log': {
      const id = rest[0] ? num(rest[0], 'kb log <id>') : undefined;
      const limit = values.limit !== undefined ? (num(values.limit, '-n') as number) : 50;
      if (id && !(await db.job.findUnique({ where: { id } }))) {
        throw usage(`no Job #${id} — \`kb ls\` shows what is on the board`);
      }
      const board = await db.board.findUnique({ where: { slug } });
      if (!board) throw usage(`no board "${slug}" — \`kb new\` creates one`);
      // Newest first out of the database so the limit keeps the RECENT events, then reversed for
      // reading: a log you read top to bottom that silently drops its tail is a trap.
      const rows = await db.event.findMany({
        where: id ? { jobId: id } : { OR: [{ boardId: board.id }, { job: { boardId: board.id } }] },
        orderBy: { id: 'desc' },
        take: limit,
      });
      rows.reverse();
      emit(out, rows, () => {
        if (!rows.length) return console.log(id ? `nothing recorded for #${id} yet` : `nothing recorded on ${slug} yet`);
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
      throw usage(`unknown verb "${verb}" — try one of: new, ls, show, run, rm, stop, start, up, down, log`);
  }
}

export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } finally {
    await closeBoard();
  }
}
