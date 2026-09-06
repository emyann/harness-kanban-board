import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openBoard, closeBoard } from './db.ts';
import { reconcile } from './controller.ts';
import { checkExportPath } from './worktree.ts';
import { checkResultName, RESULT_MAX_BYTES } from './results.ts';
import { checkArtifactName, artifactsDir, bytes } from './artifacts.ts';
import { checkPluginPath, pluginList } from './plugins.ts';
import { checkInputSpec, declaredInputs } from './inputs.ts';
import { fakeRuntime } from './runtime/fake.ts';
import * as daemon from './daemon.ts';
import { EFFORTS, boardDefaults, hasDefaults, resolveSpec, type SpecSource } from './spec.ts';
import { PACKAGE_ROOT } from './paths.ts';
import type { Runtime } from './runtime/index.ts';

/**
 * `hkb` — the CLI.
 *
 * Every verb arrived because something concrete demanded it. The CLI this one replaced had
 * thirty-six, and that is the shape it is trying not to grow back into.
 *
 * `hkb run` is still the foreground tool — one reconcile, in this process, streaming what the
 * worker does — and it is still the one to reach for when something is wrong, because everything
 * it does is visible. `hkb up` is the same pass on a timer in a detached process; it exists for the
 * work only a clock can notice (`src/daemon.ts`), not to make `hkb run` obsolete.
 *
 * Argument parsing is `node:util`'s `parseArgs` rather than a hand-rolled one — the retired CLI's
 * parser silently ate a value that began with two dashes, and there was no reason to inherit that.
 */

const usage = (msg: string) => {
  const e = new Error(msg) as Error & { exitCode: number };
  e.exitCode = 2;
  return e;
};

const HELP = `hkb — run one agent against one brief

  hkb new <name>            file a Job
       --brief <text> | --brief-file <path> | --brief - (stdin)
       --model <m>  --effort low|medium|high|xhigh|max
       --max-turns <n>  --max-budget <usd>  --max-retries <n>
       --no-isolate     run in the current checkout instead of its own worktree
       --allow-tool <t> the tool surface this Job may use, repeatable. Anything absent is
                        DENIED at admission, not merely discouraged. Without it the runtime's
                        own default applies; --allow-tools Read,Grep says the same in one
                        argument.
       --export <path>  a file or directory the Job must produce, repo-relative. It is
                        copied into the repository before the worktree is torn down, and
                        a declared path the run did not write fails the attempt. Repeatable.
       --gate <question>  stop after producing, and wait for a person. The Job suspends once it
                        has produced what it declared; \`hkb approve <id>\` continues it in the
                        same session with your instruction as the prompt, \`hkb reject\` ends it.
       --plugin-dir <p> a directory, repo-relative, whose skills this Job may see — usually
                        \`.claude\`. Resolved against the board's REPOSITORY, never the worktree,
                        so only a merge changes what it loads. Repeatable; it grants what a
                        worker may READ, and nothing about what it may do.
       --input <n=src>  what the Job is GIVEN, repeatable. Source is \`file:<repo-path>\` or
                        \`board\` (this board's Jobs, phases and outcomes). Read before the run and
                        put in the prompt; an input the board cannot read fails the attempt
                        without spending one. Narrow --allow-tool alongside it and the Job sees
                        what it was given and no more.
       --result <name>  a named value the Job must produce — a finding, a decision, a URL.
                        The board keeps it on the attempt and \`hkb show\` prints it, so a Job
                        that makes no commit still leaves something behind. Repeatable.
       --artifact <name> a FILE the Job must produce, kept beside the board rather than
                        committed. Same contract as --result with no size limit: for a report,
                        a dataset, a proposal. A name may come back as a directory. Repeatable.
       --board <slug>   default: default

  hkb ls                    what is on the board        [--phase p] [--board s]
       --all               every board on this machine, with a BOARD column
  hkb show <id>             one screen: spec, phase, every attempt
  hkb run [<id>]            reconcile once, in the foreground   [--fake]
  hkb retry <id>            re-queue a Job that stopped, resuming its session
       --max-budget <usd>  required when it stopped on max_budget: the same cap
                           would stop it in the same place
       --max-turns <n>  --max-retries <n>
  hkb approve <id> ["…"]    let a gated Job go on, in the same session, with your words
  hkb reject <id> "<why>"   end a gated Job: what it proposed is not wanted
  hkb done <id> "<why>"     end it: the aim was achieved by other means
  hkb cancel <id> "<why>"   end it: stop, this is not wanted
  hkb rm <id>               delete a Job and its attempts
  hkb stop                  the kill switch: claim nothing on this board  [--board s]
  hkb start                 clear it, and show the ceilings

  hkb up                    reconcile every board on a timer, detached  [--interval <s>]
       --status            which boards are served, by what, since when — and what
                           each may still spend and claim
       --foreground        run the loop here instead of detaching (what a supervisor runs)
  hkb down                  stop it, cleanly                    [--timeout <s>]
  hkb log [<id>]            what happened, in order             [-n <count>]
       --since <dur>       only what is newer than 90s, 30m, 2h, 3d

  hkb boards                every board on this machine
  hkb boards add <slug>     point a board at a repository       [--repo <path>]
  hkb boards rm <slug>      remove a board and everything on it [--force]
  hkb boards set <slug>     the ceilings and the spec defaults, without SQL
       --max-concurrent <n>  how many Jobs the board runs at once (0 drains it)
       --daily-budget <usd>|none
       --model <m>|none  --effort <e>|none  --max-turns <n>|none
       --max-budget <usd>|none  --max-retries <n>|none
       --allow-tools <a,b>|none  the default tool surface for Jobs that name none
       --default-plugin-dirs <a,b>|none  directories, repo-relative, whose skills every Job
                        on this board may see — \`.claude\` is the usual one

  hkb version               what this build is

A board's defaults fill in what a Job did not say: the Job's own value wins, the board's
default fills a null, the built-in is the last resort. \`none\` clears a default rather
than setting it to the word, and \`hkb show\` names the source of every resolved field.

The board is ~/.hkb/board.db — one per machine, a Board per repository, the way one
cluster holds a namespace per project. \`--board\` picks one; without it the repository
you are standing in decides. HKB_DATABASE_URL points at a different board entirely.

  --json on every verb. Exit 2 is usage or state.
`;

/**
 * The version, read out of the package the running code is actually in.
 *
 * `hkb version` is the one verb that must work before anything else does: the release workflow
 * installs the freshly published tarball on a clean runner and matches this against the tag, so a
 * build that cannot say what it is fails the release rather than shipping. It must therefore open
 * no board — a fresh machine would otherwise get `~/.hkb/board.db` created by a version check.
 */
function packageVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

/**
 * What a Job left behind, and whether that is anything at all.
 *
 * `succeeded` means the session ended. Nothing in the machinery requires it to have produced
 * anything: `withProtocol` (`src/brief.ts`) *asks* for a pull request in prose, and only when the
 * Job is isolated; `nextPhase` decides the phase from the runtime's status alone. That separation is
 * deliberate — "I looked, and there is nothing to change" is a real outcome, and so is a Job that
 * runs in the operator's own checkout. But the absence has to be legible, or a board of fifty
 * succeeded Jobs where five produced nothing reads as uniform.
 *
 * Three things count, and they are ADR-008's own list. A **pull request** on any attempt. A
 * **declared export**, and a **declared result** — both of which count without being re-checked
 * here, because a declared output the run did not produce already fails the attempt
 * (`src/worktree.ts`, `src/results.ts`, `src/artifacts.ts`), so a Job that reached `succeeded`
 * having declared any of the three produced it by construction.
 *
 * Pure, and asked only of a Job that succeeded. A failed, cancelled or `done` Job producing nothing
 * is not news — marking those would be noise, which is how a signal stops being read.
 */
export function producedNothing(
  job: { phase: string; pr: string | null; exports: string[]; results?: string[]; artifacts?: string[] },
): boolean {
  if (job.phase !== 'succeeded') return false;
  return !job.pr
    && job.exports.length === 0
    && (job.results?.length ?? 0) === 0
    && (job.artifacts?.length ?? 0) === 0;
}

/** A Job's declared exports, from the `Json?` column, defensively. */
export function declaredExports(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
}

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

/**
 * The *person*, for the one decision only a person can make.
 *
 * `whoami()` names a process, which is the right answer for everything a process decided. `hkb done`
 * and `hkb cancel` decide nothing — a human did, and the process is only the typing. So the actor on
 * those Events is a name rather than a pid, which is also what makes them read differently in
 * `hkb log` from the runtime's own transitions without anyone having to know which kinds are which.
 */
const operator = () => `${process.env.USER ?? process.env.USERNAME ?? 'someone'}@${os.hostname()}`;

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
 * A repository with no board yet still resolves — to a slug named after it, which `hkb new` will
 * create and point at the checkout. Reading verbs simply find nothing, which is the truth.
 *
 * Two boards on one checkout is a supported arrangement — `hkb boards add` allows it so different
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
  // types back, so it is ordered the way `hkb boards` orders it.
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

const PHASES = ['pending', 'running', 'succeeded', 'failed', 'suspended', 'done', 'cancelled'] as const;
type Phase = (typeof PHASES)[number];

/** The two phases an operator writes, and the verb that writes each. */
const BY_HAND = { done: 'done', cancel: 'cancelled' } as const;
type ByHandVerb = keyof typeof BY_HAND;

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

/**
 * A board's spec defaults on one line, for the human output.
 *
 * Only what is set: a row of `model=— effort=— maxTurns=—` is five columns of nothing, and the
 * absence of the line is the same information with none of the noise. `(none)` when the board has
 * no opinion at all, because `hkb boards set` prints this unconditionally and a blank tail there
 * would read as truncated output rather than as an answer.
 */
export function describeDefaults(d: ReturnType<typeof boardDefaults>): string {
  const parts = [
    d.model !== null ? `model=${d.model}` : null,
    d.effort !== null ? `effort=${d.effort}` : null,
    d.maxTurns !== null ? `maxTurns=${d.maxTurns}` : null,
    d.maxBudgetUsd !== null ? `maxBudget=$${d.maxBudgetUsd}` : null,
    d.maxRetries !== null ? `maxRetries=${d.maxRetries}` : null,
    // The two list-valued defaults, which said nothing here until now. A board-wide grant nobody
    // can see is the kind of state that becomes a surprise: `allowedTools` decides what every Job
    // on this board may DO, and `pluginPaths` what every Job may READ (ADR-012).
    d.allowedTools !== null ? `allowTools=${d.allowedTools.join('|') || '(none)'}` : null,
    d.pluginPaths !== null ? `plugins=${d.pluginPaths.join('|') || '(none)'}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' ') : '(none)';
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
      version: { type: 'boolean' },
      fake: { type: 'boolean' },
      force: { type: 'boolean' },
      'no-isolate': { type: 'boolean' },
      // Repeatable: a Job with two deliverables declares two paths, and the alternative — one
      // comma-separated string — makes a filename containing a comma undeclarable.
      export: { type: 'string', multiple: true },
      // Repeatable for the same reason `--export` is: a Job with two named values declares two.
      result: { type: 'string', multiple: true },
      artifact: { type: 'string', multiple: true },
      'plugin-dir': { type: 'string', multiple: true },
      'default-plugin-dirs': { type: 'string' },
      input: { type: 'string', multiple: true },
      gate: { type: 'string' },
      // Repeatable, for the same reason `--export` is: a tool name is a token, and one
      // comma-separated string makes the empty list ("this Job may call nothing") unsayable.
      'allow-tool': { type: 'string', multiple: true },
      'allow-tools': { type: 'string' },
      brief: { type: 'string' },
      'brief-file': { type: 'string' },
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
  // `help` as a verb as well as a flag: it is what a person types first, and answering "unknown
  // verb: help" to it is the kind of small friction this project treats as a bug.
  if (!verb || verb === 'help' || values.help) { process.stdout.write(HELP); return 0; }
  // Before `openBoard()` on purpose — see packageVersion(). `--version` too, because that is what
  // every other CLI answers to and being told "unknown verb" for it is a small, avoidable insult.
  if (verb === 'version' || values.version) {
    const version = packageVersion();
    emit(out, { version }, () => process.stdout.write(`hkb ${version}\n`));
    return 0;
  }

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
      if (!name) throw usage('hkb new <name> — a Job needs a name');
      const brief = await readBrief(values);
      const board = await db.board.upsert({
        where: { slug },
        update: {},
        // A board created by filing work in a repository is pointed at that repository. Without it
        // a machine-level daemon would have nowhere to cut the worktree.
        create: { slug, repoPath: scope.repoPath },
      });
      const effort = values.effort as string | undefined;
      if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
        throw usage(`--effort must be one of ${EFFORTS.join('|')}, got ${effort}`);
      }
      // Checked here, at admission, rather than when the copy runs: an export path that escapes the
      // worktree is an illegal request, and an illegal request should never become state. The same
      // check runs again at copy time, because a row can arrive by other routes than this one.
      const exports = ((values.export as string[] | undefined) ?? []).map(checkExportPath);
      // Checked at file time, before a worktree exists — a name that cannot be a filename or a JSON
      // key is a fault in the spec, and finding it here costs nothing while finding it later costs
      // a run.
      const results = ((values.result as string[] | undefined) ?? []).map(checkResultName);
      // Same reasoning one medium over: a name that cannot be a single path segment is a fault in
      // the spec, and finding it here costs nothing while finding it after a run costs the run.
      const artifacts = ((values.artifact as string[] | undefined) ?? []).map(checkArtifactName);
      // Checked at file time for the same reason an export path is: a grant is resolved into an
      // absolute path with no agent in the loop, so a path that was never legal must not become
      // state. Null when the flag was absent, so the board's grant can answer; an EMPTY list is
      // only reachable through `--plugin-dir ""` and means "grant this Job nothing".
      const pluginPaths = values['plugin-dir'] !== undefined
        ? (values['plugin-dir'] as string[]).map((v) => v.trim()).filter(Boolean).map(checkPluginPath)
        : null;
      // Checked at file time like every other declaration, and for the sharpest version of the same
      // reason: this one names a file the BOARD will read with the operator's authority and put in
      // front of a model. A source that was never legal must not become state.
      const inputs = ((values.input as string[] | undefined) ?? []).map(checkInputSpec);
      const gate = typeof values.gate === 'string' ? values.gate.trim() : undefined;
      if (values.gate !== undefined && !gate) throw usage('--gate needs the question a human is being asked, as in --gate "does this migration look right?"');
      // Null when the flag was absent, so the board's default can answer. An EMPTY list is only
      // reachable through `--allow-tools ""`, and it means what it says: no tools at all.
      const allowedTools = values['allow-tool'] !== undefined
        ? (values['allow-tool'] as string[]).map((t) => t.trim()).filter(Boolean)
        : values['allow-tools'] !== undefined
          ? String(values['allow-tools']).split(',').map((t) => t.trim()).filter(Boolean)
          : null;
      const job = await db.job.create({
        data: {
          boardId: board.id, name, brief,
          // Null rather than `[]` for a Job that declares nothing: "produces no file" and "produced
          // none of the files it promised" are different facts, and only the second is a failure.
          ...(exports.length ? { exports } : {}),
          ...(results.length ? { results } : {}),
          ...(artifacts.length ? { artifacts } : {}),
          ...(inputs.length ? { inputs } : {}),
          ...(gate ? { gate } : {}),
          model: (values.model as string) ?? null,
          effort: effort ?? null,
          isolate: !values['no-isolate'],
          allowedTools,
          pluginPaths,
          // Null, not a number, when the flag was not given. A Job that recorded 20 turns because
          // nobody said otherwise would outrank its board's default for ever — "unset" staying
          // legible is the whole reason these columns are nullable. See `src/spec.ts`.
          maxTurns: num(values['max-turns'], '--max-turns') ?? null,
          maxBudgetUsd: num(values['max-budget'], '--max-budget') ?? null,
          maxRetries: num(values['max-retries'], '--max-retries') ?? null,
        },
      });
      await db.event.create({
        data: { kind: 'created', jobId: job.id, boardId: board.id, actor: whoami(), payload: { name } },
      });
      emit(out, { id: job.id, name: job.name, phase: job.phase, board: slug, exports, results, artifacts, inputs }, () =>
        console.log(`#${job.id} ${job.name}  [${job.phase}]  on ${slug}`
          + (exports.length ? `\n  must produce  ${exports.join(', ')}` : '')
          + (results.length ? `\n  must report   ${results.join(', ')}` : '')
          + (artifacts.length ? `\n  must hand over ${artifacts.join(', ')}` : '')
          + (inputs.length ? `\n  is given      ${inputs.map((i) => `${i.name}=${i.source}`).join(', ')}` : '')));
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
        //
        // The attempts' pull requests come back with the listing rather than in a second query per
        // row: a board-wide read already exists here, and "one board read per pass" is the rule
        // this listing has always followed.
        include: {
          _count: { select: { attempts: true } },
          board: { select: { slug: true } },
          attempts: { select: { prUrl: true }, orderBy: { k: 'desc' } },
        },
      });
      const rows = jobs.map((j) => {
        const exports = declaredExports(j.exports);
        const results = declaredExports(j.results);
        const artifacts = declaredExports(j.artifacts);
        const pr = j.attempts.find((a) => a.prUrl)?.prUrl ?? null;
        return {
          id: j.id, board: j.board.slug, name: j.name, phase: j.phase, attempts: j._count.attempts,
          lastError: j.lastError, sessionId: j.lastSessionId,
          // Carried on every row, whatever the phase, for the reason `hkb boards` carries its
          // defaults either way: a consumer inferring absence from a missing key reads a shape,
          // not a record.
          pr, exports, results, artifacts,
          producedNothing: producedNothing({ phase: j.phase, pr, exports, results, artifacts }),
        };
      });
      emit(out, rows, () => {
        if (!rows.length) return console.log(all ? 'no jobs on any board' : `no jobs on ${slug}`);
        const w = all ? Math.max(...rows.map((r) => r.board.length)) : 0;
        for (const r of rows) {
          const board = all ? `${r.board.padEnd(w)}  ` : '';
          // Stated, not judged. A Job that looked and found nothing to change is a real outcome —
          // what is not acceptable is that it reads exactly like one that shipped a pull request.
          const empty = r.producedNothing ? '  — produced nothing' : '';
          console.log(`${board}#${String(r.id).padEnd(4)} ${r.phase.padEnd(9)} ${String(r.attempts).padStart(2)}× ${r.name.slice(0, 64)}${empty}`);
        }
        const empty = rows.filter((r) => r.producedNothing).length;
        if (empty) {
          console.log(`\n${empty} of ${rows.filter((r) => r.phase === 'succeeded').length} succeeded `
            + `${empty === 1 ? 'Job' : 'Jobs'} produced no pull request and declared no outputs.`);
        }
      });
      return 0;
    }

    // ---------------------------------------------------------------- show
    case 'show': {
      const id = num(rest[0], 'hkb show <id>');
      if (!id) throw usage('hkb show <id> — which Job?');
      const job = await db.job.findUnique({
        where: { id },
        include: { attempts: { orderBy: { k: 'asc' } }, lease: true, board: true },
      });
      if (!job) throw usage(`no Job #${id} — \`hkb ls\` shows what is on the board`);
      // What this Job will run with, and where each value came from. The raw columns are on the
      // object too, but most of them are null now, and a null `model` is not an answer to "which
      // model does this run on" — the board may have answered it.
      const spec = resolveSpec(job, job.board);
      emit(out, { ...job, spec }, () => {
        console.log(`#${job.id} ${job.name}`);
        // One board per machine, one Board per repository: a Job you did not expect is usually a
        // Job on a board you were not thinking about. Which board, and which checkout it will run
        // in, comes before anything about the Job itself.
        console.log(
          `  board    ${job.board.slug}  `
          + `${job.board.repoPath ?? '(no repo — `hkb boards add ' + job.board.slug + ' --repo <path>`)'}`,
        );
        console.log(`  phase    ${job.phase}${job.lease ? `  (leased by ${job.lease.holder} until ${job.lease.expiresAt.toISOString()})` : ''}`);
        // A phase a human wrote must say so, and say who and why. `done` next to a spent budget
        // and two failed attempts is otherwise a contradiction the reader has to go and resolve in
        // `hkb log`, and `succeeded` is deliberately not reused for it: that word means the session
        // completed, and this one did not.
        if (job.endedBy) {
          console.log(`  ended    by ${job.endedBy}${job.finishedAt ? `, ${job.finishedAt.toISOString()}` : ''}`);
          console.log(`           ${job.endedFor}`);
        }
        console.log(`  spec     isolate=${job.isolate} timeoutMs=${job.timeoutMs}`);
        // The surface the run will actually get. `(runtime default)` is an answer, not a blank:
        // it says nobody narrowed this Job, which is the difference between a Job that may write
        // and a Job that was deliberately stopped from writing.
        console.log(`  tools    ${spec.allowedTools.value?.join(', ') ?? '(runtime default)'}`
          + `  [${spec.allowedTools.from}]`);
        // What this Job may READ, as distinct from what it may DO. A granted directory widens the
        // skills a worker sees and nothing about the tools it may call — the admission gate is
        // unchanged by it (ADR-012).
        console.log(`  plugins  ${spec.pluginPaths.value?.join(', ') || '(none granted)'}`
          + `  [${spec.pluginPaths.from}]`);
        // One line per resolved field, with its source named. Three levels answer these five
        // questions, and printing only the winner turns "why did this run on Opus" into
        // archaeology across two tables — a spec you cannot trace is worse than one you repeat.
        const where = (from: SpecSource) =>
          from === 'job' ? 'set on the Job'
            : from === 'board' ? `from board ${job.board.slug}`
            : 'built-in default';
        const traced: [string, string, SpecSource][] = [
          ['model', spec.model.value ?? '(the harness default)', spec.model.from],
          ['effort', spec.effort.value ?? '(the harness default)', spec.effort.from],
          ['maxTurns', String(spec.maxTurns.value), spec.maxTurns.from],
          ['maxBudget', `$${spec.maxBudgetUsd.value}`, spec.maxBudgetUsd.from],
          ['maxRetries', String(spec.maxRetries.value), spec.maxRetries.from],
        ];
        const vw = Math.max(...traced.map(([, v]) => v.length));
        for (const [k, v, from] of traced) {
          console.log(`           ${k.padEnd(10)} ${v.padEnd(vw)}  ${where(from)}`);
        }
        // What it must produce, beside how it runs — the half of the spec ADR-008 added, and the
        // one that decides whether a completed session counts as a success.
        // Before the outputs, because that is the order the run sees them in.
        const given = declaredInputs(job.inputs);
        if (given.length) console.log(`  inputs   ${given.map((i) => `${i.name}=${i.source}`).join(', ')}`);
        if (Array.isArray(job.exports) && job.exports.length) console.log(`  exports  ${job.exports.join(', ')}`);
        if (Array.isArray(job.results) && job.results.length) console.log(`  results  ${job.results.join(', ')}`);
        if (Array.isArray(job.artifacts) && job.artifacts.length) console.log(`  files    ${job.artifacts.join(', ')}`);
        if (job.gate) console.log(`  gate     ${job.gate}`);
        if (job.suspendedFor) console.log(`  waiting  ${job.suspendedFor} — \`hkb approve ${job.id}\` or \`hkb reject ${job.id} "…"\``);
        if (job.lastError) console.log(`  error    ${job.lastError}`);
        if (job.lastSessionId) console.log(`  resume   ${job.lastSessionId}`);
        console.log(`  brief    ${job.brief.split('\n')[0].slice(0, 88)}${job.brief.length > 88 ? ' …' : ''}`);
        if (!job.attempts.length) console.log('  attempts (none yet)');
        for (const a of job.attempts) {
          // Spent, against the cap this attempt was frozen at. The frozen number and not today's
          // resolution, which is what makes the pair readable at all: an attempt that stopped on
          // `max_budget` says so only next to the cap that stopped it, and the board's default may
          // have moved since — possibly *because* of this attempt.
          //
          // `!= null` and not a truthiness test: an attempt that really cost $0.0000 has reported
          // a cost, and "up to $0.50" would describe it as still owing money it will never spend.
          const cost = a.costUsd != null
            ? ` $${a.costUsd.toFixed(4)} of $${a.maxBudgetUsd.toFixed(2)}`
            : ` up to $${a.maxBudgetUsd.toFixed(2)}`;
          // An attempt in flight has no `endedAt`, and elapsed-so-far is exactly what you want to
          // know about one: the trailing `+` says the number is still climbing.
          const took = formatDuration((a.endedAt ?? new Date()).getTime() - a.startedAt.getTime())
            + (a.endedAt ? '' : '+');
          console.log(`  k=${a.k}      ${(a.outcome ?? 'running').padEnd(11)}${took.padStart(7)}${cost}  ${a.sessionId ?? '—'}`);
          // What the run actually did, for the attempt whose value is not a diff. Printed only when
          // the runtime measured it — an attempt refused at the gate has no turn count, and `0 turns`
          // would be a claim about a run that never happened. Denials are shown only when non-zero:
          // a refusal is news, and "0 refusals" on every line is not.
          // What the run reported, which for a Job with no commit is the whole of its output. One
          // line per value, indented under its attempt, truncated where a value is long — the full
          // text is on the row for `--json`, and a screen is for orientation.
          if (a.results && typeof a.results === 'object') {
            for (const [name, value] of Object.entries(a.results as Record<string, string>)) {
              const flat = String(value).replace(/\s+/g, ' ').trim();
              console.log(`           ${name}: ${flat.length > 96 ? `${flat.slice(0, 96)}…` : flat}`);
            }
          }
          if (a.turns != null) {
            const denied = a.denials ? `, ${a.denials} tool refusal${a.denials === 1 ? '' : 's'}` : '';
            console.log(`           ${a.turns} turn${a.turns === 1 ? '' : 's'}${denied}`);
          }
          // The reviewable artifact. It is the point of the run, so it gets its own line rather
          // than being something you go and look for.
          if (a.prUrl) console.log(`           PR #${a.prNumber}  ${a.prUrl}`);
          else if (a.branch) console.log(`           branch ${a.branch} — no pull request found`);
          // The other reviewable artifact, and the one that is not on a forge: what this attempt
          // took out of its checkout and left in the repository.
          // What this attempt was FED, beside what it cost. The pair is the measurement — an input
          // is paid for on every request of the run, so its size sits next to `turns` above.
          if (Array.isArray(a.inputs) && a.inputs.length) {
            const fed = a.inputs as { name: string; source: string; bytes: number }[];
            console.log(`           given ${fed.map((i) => `${i.name} ${bytes(i.bytes)}`).join(', ')}`);
          }
          if (Array.isArray(a.exported) && a.exported.length) console.log(`           exported ${a.exported.join(', ')}`);
          // The third one, and the only output whose location a human has to be told: an artifact
          // is deliberately not in the repository and not on a forge, so a line that named the
          // files without naming the directory would describe something unfindable. Sizes because
          // nothing removes these — see `src/artifacts.ts`.
          if (Array.isArray(a.artifacts) && a.artifacts.length) {
            const kept = a.artifacts as { name: string; kind: string; bytes: number }[];
            console.log(`           kept ${kept.map((f) => `${f.name}${f.kind === 'dir' ? '/' : ''} ${bytes(f.bytes)}`).join(', ')}`);
            console.log(`           in ${artifactsDir(job.id, a.k)}`);
          }
          if (a.reason) console.log(`           ${a.reason.slice(0, 100)}`);
        }
      });
      return 0;
    }

    // ---------------------------------------------------------------- run
    case 'run': {
      const only = rest[0] ? num(rest[0], 'hkb run <id>') : undefined;
      if (only && !(await db.job.findUnique({ where: { id: only } }))) {
        throw usage(`no Job #${only} — \`hkb ls\` shows what is on the board`);
      }
      const runtime: Runtime = values.fake
        ? fakeRuntime()
        : (await import('./runtime/claude.ts')).claudeRuntime;

      const report = await reconcile({
        runtime, cwd: process.cwd(), only, board: slug,
        onEvent: out.json ? undefined : (l) => console.log(l),
        // Tagged with the Job for the same reason the controller's own lines are: a board that
        // runs two at once interleaves these, and `taskId` is the only thing that untangles them.
        onRuntimeEvent: out.json ? undefined : (e) => {
          if (e.kind === 'tool') console.log(`#${e.taskId}   -> ${e.name}`);
          if (e.kind === 'text') console.log(`#${e.taskId}    : ${e.text}`);
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
      const id = num(rest[0], 'hkb rm <id>');
      if (!id) throw usage('hkb rm <id> — which Job?');
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
      const id = num(rest[0], 'hkb retry <id>');
      if (!id) throw usage('hkb retry <id> — which Job? `hkb ls --phase failed` shows the candidates');
      const job = await db.job.findUnique({
        where: { id },
        include: {
          lease: true, board: true,
          attempts: { where: { endedAt: { not: null } }, orderBy: { k: 'desc' }, take: 1 },
        },
      });
      if (!job) throw usage(`no Job #${id} — \`hkb ls\` shows what is on the board`);
      if (job.lease) {
        throw usage(`#${id} is leased by ${job.lease.holder} — it is running now. Wait for it, or let the lease expire.`);
      }
      if (job.phase === 'pending') throw usage(`#${id} is already pending — \`hkb run ${id}\` works it now`);
      if (job.phase === 'running') {
        throw usage(`#${id} says running with no lease — \`hkb run\` reclaims it, and re-queueing it by hand would race that`);
      }

      const budget = num(values['max-budget'], '--max-budget');
      const turns = num(values['max-turns'], '--max-turns');
      const retries = num(values['max-retries'], '--max-retries');
      // Two different caps, and conflating them is how this guard gets it wrong now that a board
      // can supply one. `ranUnder` is what the failed attempt was frozen at — the number that
      // actually stopped it, read off the Attempt because the Job's column is null for every Job
      // that inherited its cap, and because the board's default may have moved since. `wouldGet`
      // is what the next attempt gets, which is today's resolution unless `--max-budget` overrides
      // it. They differ exactly when the board was raised after the failure, and there the retry
      // genuinely buys something: refusing it would send an operator to override a limit that is
      // no longer in the way.
      const last = job.attempts[0];
      const resolved = resolveSpec(job, job.board).maxBudgetUsd.value;
      const ranUnder = last?.maxBudgetUsd ?? resolved;
      const wouldGet = budget ?? resolved;
      // The guard. Re-queueing a budget-capped Job under the same cap buys exactly what the
      // automatic retry used to: the same run, the same stopping point, the same bill.
      if (last?.outcome === 'max_budget' && !(wouldGet > ranUnder)) {
        throw usage(
          `#${id} spent its whole $${ranUnder.toFixed(2)} budget and stopped with work left — running it `
          + `again under $${wouldGet.toFixed(2)} stops in the same place, at the same price. Give it a bigger `
          + `one: \`hkb retry ${id} --max-budget ${(ranUnder * 2).toFixed(2)}\`, or file a smaller brief.`,
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
      const raise = budget !== undefined && budget !== ranUnder
        ? { maxBudgetUsd: { from: ranUnder, to: budget } } : {};
      await db.event.create({
        data: {
          kind: 'requeued', jobId: id, boardId: job.boardId, actor: whoami(),
          payload: { was: job.phase, ...raise, resume: job.lastSessionId },
        },
      });
      emit(out, {
        id, phase: 'pending', maxBudgetUsd: budget ?? wouldGet, resume: job.lastSessionId, ...raise,
      }, () => {
        const cap = budget !== undefined && budget !== ranUnder
          ? `  maxBudget $${ranUnder.toFixed(2)} → $${budget.toFixed(2)}` : '';
        // A resumed Job does not start over, and an operator about to watch it needs to know that
        // before they wonder why the branch already has commits on it.
        const from = job.lastSessionId ? `  (resumes ${job.lastSessionId})` : '  (starts cold)';
        console.log(`#${id} pending again${cap}${from}`);
      });
      return 0;
    }

    // ---------------------------------------------------------------- done / cancel
    /**
     * End a Job the machinery cannot end itself.
     *
     * The gap this closes: a Job whose pull request was reviewed and merged while it sat `pending`
     * on a spent budget. The work is done; the board does not know, and the next reconcile spends
     * the whole cap redoing merged work. Until this verb the only thing that stopped it was
     * `hkb rm`, which deletes the Job, its attempts and its events — so the choice was between
     * re-running work that already landed and destroying the record that it did, on a board whose
     * whole point is the record.
     *
     * TWO verbs, not one with a `--reason`. They are different statements about the work —
     * "this achieved its aim by other means" and "stop, this is not wanted" — and the operator
     * knows which one they mean at the moment they type it. A single verb would push that
     * statement into free text, where it can be read by a person and by nothing else; `hkb ls
     * --phase cancelled` would have no answer. The reason is still required by both, because it
     * says *what* landed or *why* it was dropped, which the phase never can.
     *
     * This is the one place a phase is asked for rather than observed, which is exactly what makes
     * it an operator verb: it is recorded as a transition, with the person as the actor, and never
     * as a silent update.
     */
    // ---------------------------------------------------------------- approve / reject
    // The two ends of ADR-010's gate. `approve` is the only verb in this CLI that hands an agent an
    // instruction, which is why it goes on the Event stream with an actor: an approval nobody can
    // attribute is not a decision, it is a state change.
    case 'approve':
    case 'reject': {
      const id = num(rest[0], `hkb ${verb} <id>`);
      if (!id) throw usage(`hkb ${verb} <id> — which Job?`);
      const note = rest.slice(1).join(' ').trim();
      if (verb === 'reject' && !note) {
        throw usage(`hkb reject ${id} "<why>" — a rejection without a reason tells the next reader nothing.`);
      }
      const job = await db.job.findUnique({ where: { id }, include: { lease: true } });
      if (!job) throw usage(`no Job #${id}`);
      // Refused rather than queued. A Job that is not waiting has nothing to approve, and saying so
      // beats writing an approval that the next reconcile ignores.
      if (job.phase !== 'suspended') {
        throw usage(`#${id} is ${job.phase}, not suspended — there is nothing waiting to be decided. `
          + `Only a gated Job that has produced what it declared waits here.`);
      }
      if (job.lease) {
        throw usage(`#${id} is held by ${job.lease.holder} — wait for the run to end, or \`hkb down\`.`);
      }
      const actor = os.userInfo().username;

      if (verb === 'reject') {
        await db.$transaction([
          db.job.update({
            where: { id },
            data: {
              phase: 'cancelled', endedBy: actor, endedFor: note, finishedAt: new Date(),
              suspendedFor: null,
            },
          }),
          db.event.create({
            data: { kind: 'rejected', jobId: id, boardId: job.boardId, actor, payload: { note } },
          }),
        ]);
        emit(out, { id, phase: 'cancelled', by: actor, why: note }, () =>
          console.log(`#${id} rejected by ${actor} — ${note}`));
        return 0;
      }

      // The approval itself is the Event, durable and never consumed; the phase change is what the
      // controller acts on. Both in one transaction, because a phase moved without the event that
      // explains it would give the next attempt the brief again instead of the instruction.
      await db.$transaction([
        db.event.create({
          data: { kind: 'approved', jobId: id, boardId: job.boardId, actor, payload: note ? { note } : {} },
        }),
        db.job.update({ where: { id }, data: { phase: 'pending', suspendedFor: null } }),
      ]);
      emit(out, { id, phase: 'pending', by: actor, note: note || null }, () =>
        console.log(`#${id} approved by ${actor} — it resumes on the next pass`
          + (note ? `, told: ${note}` : '')));
      return 0;
    }

    case 'done':
    case 'cancel': {
      const phase = BY_HAND[verb as ByHandVerb];
      const id = num(rest[0], `hkb ${verb} <id>`);
      if (!id) throw usage(`hkb ${verb} <id> "<reason>" — which Job?`);
      // Joined the way `hkb new` joins a name, so an unquoted reason is not silently truncated to
      // its first word.
      const reason = rest.slice(1).join(' ').trim();
      if (!reason) {
        throw usage(
          `hkb ${verb} ${id} needs a reason — ${verb === 'done'
            ? 'what achieved the aim instead, e.g. `hkb done ' + id + ' "PR #364 was reviewed and merged"`'
            : 'why it is not wanted, e.g. `hkb cancel ' + id + ' "superseded by #12"`'}`,
        );
      }

      const job = await db.job.findUnique({ where: { id }, include: { lease: true } });
      if (!job) throw usage(`no Job #${id} — \`hkb ls\` shows what is on the board`);

      // The same rule as `hkb rm`, for the same reason: a lease is a worker that is running right
      // now, and concluding its Job out from under it would leave it reporting to a record that
      // says the question was already settled. The daemon is a thing the operator can stop, so
      // say so rather than racing it.
      if (job.lease) {
        throw usage(
          `#${id} is leased by ${job.lease.holder} — it is running. `
          + `\`hkb down\` stops the daemon, or wait for the run to finish (the lease lapses by `
          + `${job.lease.expiresAt.toISOString()}), then \`hkb ${verb} ${id}\` again.`,
        );
      }
      if (job.phase === 'succeeded') {
        throw usage(`#${id} already succeeded — the runtime concluded it, and \`hkb ${verb}\` is for the Jobs it cannot. \`hkb show ${id}\` has the attempts.`);
      }
      if (job.phase === phase) {
        throw usage(`#${id} is already ${phase}${job.endedBy ? ` — ${job.endedBy} said so: ${job.endedFor}` : ''}`);
      }
      // Between `done` and `cancelled` a restatement IS allowed, and deliberately: they are both
      // the operator's own word, a mistyped verb is easy, and the alternative escape is `hkb rm` —
      // the very trap this verb exists to remove. The correction is another Event, so the log
      // keeps both statements in order rather than pretending the first never happened.

      const at = new Date();
      const by = operator();
      const updated = await db.job.update({
        where: { id },
        data: { phase, endedBy: by, endedFor: reason, finishedAt: at },
      });
      // An attempt still open on a Job with no lease was never heard from again — `lost` is the
      // Outcome that already means exactly that. Closing it is not cosmetic: `hkb show` renders an
      // open attempt as elapsed-so-far, so a terminal Job would print a duration that climbs for
      // ever. Scoped to `endedAt: null`, so a finished attempt is never rewritten.
      await db.attempt.updateMany({
        where: { jobId: id, endedAt: null },
        data: { endedAt: at, outcome: 'lost', reason: `#${id} was ${phase} by ${by} while this attempt was open` },
      });
      await db.event.create({
        data: {
          kind: phase, jobId: id, boardId: job.boardId, actor: by,
          payload: { from: job.phase, reason },
        },
      });

      emit(out, {
        id, board: slug, name: job.name, phase: updated.phase, from: job.phase,
        endedBy: by, endedFor: reason, finishedAt: at,
      }, () => {
        console.log(`#${id} ${phase} — ${job.name}  (was ${job.phase})`);
        console.log(`  ${reason}`);
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
          console.log(`${slug} started — ${cap}, runs up to ${updated.maxConcurrent} at once`);
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
                + `since ${r.stoppedAt!.toISOString()} — \`hkb start --board ${r.slug}\` to resume`);
            }
            const ceiling = r.dailyBudgetUsd === null
              ? `$${r.spent24h.toFixed(2)} spent in 24h, no ceiling`
              : `$${r.spent24h.toFixed(2)} of $${r.dailyBudgetUsd.toFixed(2)} spent in 24h`;
            // "N concurrent" alone told an operator a capacity and not whether any of it was in
            // use — and, before the ceiling was real, not even whether it could be.
            console.log(`${pad}  limits  ${r.liveLeases} of ${r.maxConcurrent} slots running, ${ceiling}`);
            if (r.repoPath) console.log(`${pad}  repo    ${r.repoPath}`);
            // A daemon runs the code it started with. Saying so beats discovering it.
            if (r.behind) {
              console.log(`${pad}  BEHIND  started from ${r.version}; the checkout is now ${r.behind}`
                + ' — `hkb down && hkb up` to pick it up');
            }
          }
          // One line, because a daemon serving every board writes one log and a board-scoped one
          // writes its own: naming a single file per row would be right only half the time.
          if (rows.some((r) => r.running)) console.log(`\nlogs in ${daemon.boardDir()}`);
        });
        return rows.some((r) => r.running) ? 0 : 1;
      }

      // The loop, in this process. `hkb up` without `--foreground` spawns exactly this.
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
        console.log(`  status   hkb up --status`);
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
        if (!name) throw usage('hkb boards add <slug> [--repo <path>] — what is the board called?');
        const repo = (values.repo as string) || gitRoot(process.cwd());
        if (!repo) throw usage('hkb boards add needs --repo <path>, or to be run inside a git repository');
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
        if (!name) throw usage('hkb boards set <slug> --max-concurrent <n> --daily-budget <usd> --model <m> — which board?');
        const board = await db.board.findUnique({ where: { slug: name } });
        if (!board) throw usage(`no board "${name}" — \`hkb boards\` lists the ones on this machine`);

        const data: Record<string, unknown> = {};

        // ---- the spec defaults. `none` clears one, the same word `--daily-budget none` already
        // uses: an unset default and a default of zero are different configurations, and a flag
        // that could only ever set a value would leave no way back to "no opinion".
        const CLEAR = 'none';
        /** A `--flag <value>|none` that stores a string. */
        const setString = (flag: string, column: string, check?: (v: string) => void) => {
          if (values[flag] === undefined) return;
          const raw = String(values[flag]).trim();
          if (!raw) throw usage(`--${flag} was given nothing — pass a value, or "${CLEAR}" to clear the default`);
          if (raw === CLEAR) { data[column] = null; return; }
          check?.(raw);
          data[column] = raw;
        };
        /** A `--flag <number>|none`. `ok` is what the number has to be, and `want` must say so. */
        const setNumber = (flag: string, column: string, ok: (n: number) => boolean, want: string) => {
          if (values[flag] === undefined) return;
          const raw = String(values[flag]).trim();
          if (raw === CLEAR) { data[column] = null; return; }
          const n = num(raw, `--${flag}`) as number;
          if (!ok(n)) throw usage(`--${flag} wants ${want}, or "${CLEAR}" to clear the default — got ${raw}`);
          data[column] = n;
        };

        setString('model', 'defaultModel');
        setString('effort', 'defaultEffort', (v) => {
          if (!(EFFORTS as readonly string[]).includes(v)) {
            throw usage(`--effort must be one of ${EFFORTS.join('|')}, or "${CLEAR}" to clear the default — got ${v}`);
          }
        });
        // A Job needs at least one turn to do anything, so 0 turns is a Job that cannot run rather
        // than a board that runs cheaply. `maxRetries` 0 IS meaningful — one attempt, no retries.
        setNumber('max-turns', 'defaultMaxTurns', (n) => Number.isInteger(n) && n >= 1, 'a whole number of turns, 1 or more');
        setNumber('max-budget', 'defaultMaxBudgetUsd', (n) => n > 0, 'dollars above zero');
        setNumber('max-retries', 'defaultMaxRetries', (n) => Number.isInteger(n) && n >= 0, 'a whole number of retries, 0 or more');
        // A list, so it takes the comma-separated form rather than the repeatable one: `boards set`
        // is a single statement about the board, and a repeatable flag here would read as adding to
        // a list rather than replacing it.
        // Repeatable would read as adding to a list; `boards set` is one statement about the
        // board, so this replaces — same reasoning as `--allow-tools` below.
        if (values['default-plugin-dirs'] !== undefined) {
          const raw = String(values['default-plugin-dirs']).trim();
          if (!raw) throw usage(`--default-plugin-dirs was given nothing — pass a comma-separated list of repo-relative directories, or "${CLEAR}" to clear the grant`);
          data.defaultPluginPaths = raw === CLEAR
            ? null
            : raw.split(',').map((v) => v.trim()).filter(Boolean).map(checkPluginPath);
        }
        if (values['allow-tools'] !== undefined) {
          const raw = String(values['allow-tools']).trim();
          if (!raw) throw usage(`--allow-tools was given nothing — pass a comma-separated list, or "${CLEAR}" to clear the default`);
          data.defaultAllowedTools = raw === CLEAR ? null : raw.split(',').map((t) => t.trim()).filter(Boolean);
        }

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
          throw usage(
            'hkb boards set needs something to set — a ceiling (--max-concurrent <n>, --daily-budget <usd>|none)'
            + ' or a spec default (--model, --effort, --max-turns, --max-budget,'
            + ' --max-retries, --allow-tools, --default-plugin-dirs; "none" clears one)',
          );
        }

        const after = await db.board.update({ where: { id: board.id }, data });
        // Still `ceilings_set`, though it now records defaults too. That kind is what `hkb log`
        // already shows for this command, and the payload names exactly which columns moved;
        // renaming it would break every board's existing history to fix a word.
        await db.event.create({
          data: { kind: 'ceilings_set', boardId: board.id, actor: whoami(), payload: data as never },
        });
        const defaults = boardDefaults(after);
        emit(out, {
          board: after.slug, maxConcurrent: after.maxConcurrent, dailyBudgetUsd: after.dailyBudgetUsd,
          defaults,
        }, () => {
          console.log(
            `${after.slug} — ${after.dailyBudgetUsd === null ? 'no ceiling' : `$${after.dailyBudgetUsd}/24h`}, `
            + `runs up to ${after.maxConcurrent} at once`);
          // Printed whenever the board has any, not only when this command changed one: the
          // question after `hkb boards set --model` is what the board now says, not what moved.
          console.log(`  defaults  ${describeDefaults(defaults)}`);
        });
        return 0;
      }

      if (rest[0] === 'rm') {
        const name = rest[1];
        if (!name) throw usage('hkb boards rm <slug> [--force] — which board?');
        const board = await db.board.findUnique({
          where: { slug: name },
          include: { controller: true, _count: { select: { jobs: true } } },
        });
        if (!board) throw usage(`no board "${name}" — \`hkb boards\` lists the ones on this machine`);

        // No `--force` past this one, deliberately. A daemon holding this board is reconciling it
        // right now, and the delete cascades to the Leases it is holding and the Jobs it is
        // running: the worker would keep going with nothing left to report to. Stopping the
        // daemon is a thing the operator can do, so make them do it.
        if (board.controller && daemon.controllerIsLive(board.controller as daemon.ControllerRow)) {
          throw usage(`${name} is led by ${board.controller.holder} — run \`hkb down --board ${name}\` first, then remove it`);
        }
        const jobs = board._count.jobs;
        if (jobs && !values.force) {
          throw usage(`${name} has ${jobs} job${jobs === 1 ? '' : 's'}, and removing a board deletes its jobs, attempts, leases and events with it — pass --force to mean it`);
        }

        await db.board.delete({ where: { id: board.id } });
        // `boardId` would cascade away with the board it names, so this Event carries none and the
        // slug in the payload is the whole record. The same trade `hkb rm` makes for a Job.
        await db.event.create({
          data: { kind: 'board_removed', actor: whoami(), payload: { slug: name, repoPath: board.repoPath, jobs } },
        });
        emit(out, { removed: name, jobs }, () =>
          console.log(`removed ${name}${jobs ? ` and ${jobs} job${jobs === 1 ? '' : 's'}` : ''}`));
        return 0;
      }
      if (rest[0]) throw usage(`hkb boards has no subcommand "${rest[0]}" — try \`hkb boards\`, \`hkb boards add <slug>\`, \`hkb boards set <slug>\` or \`hkb boards rm <slug>\``);

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
          // Separate in the JSON, one column in the table. A consumer that wants to tell a merged
          // Job from an abandoned one can; a reader counting what is left to do only needs to know
          // that neither is.
          done: by('done'), cancelled: by('cancelled'),
          spent24h: spend._sum.costUsd ?? 0,
          maxConcurrent: b.maxConcurrent,
          dailyBudgetUsd: b.dailyBudgetUsd,
          // Always in `--json`, set or not: a consumer that has to infer a missing default from a
          // missing key is reading a shape rather than a record.
          defaults: boardDefaults(b),
          hasDefaults: hasDefaults(b),
        };
      }));
      emit(out, rows, () => {
        if (!rows.length) return console.log('no boards yet — `hkb new` inside a repository creates one');
        const w = Math.max(5, ...rows.map((r) => r.board.length));
        const d = Math.max(6, ...rows.map((r) => r.daemon.length + (r.paused ? 10 : 0)));
        console.log(`${'BOARD'.padEnd(w)}  ${'DAEMON'.padEnd(d)}  PEND   RUN    OK  FAIL  ENDED      24H  REPO`);
        for (const r of rows) {
          const flag = r.paused ? ' (stopped)' : '';
          console.log(
            `${r.board.padEnd(w)}  ${(r.daemon + flag).padEnd(d)}  ${String(r.pending).padStart(4)}  `
            + `${String(r.running).padStart(4)}  ${String(r.succeeded).padStart(4)}  ${String(r.failed).padStart(4)}  `
            + `${String(r.done + r.cancelled).padStart(5)}  `
            + `${('$' + r.spent24h.toFixed(2)).padStart(7)}  `
            + `${r.repoPath ?? '(no repo — `hkb boards add ' + r.board + ' --repo <path>`)'}`,
          );
          // A continuation line rather than five more columns: the table is already at the width
          // of a terminal, and a board with no defaults — which is most of them — pays nothing.
          if (r.hasDefaults) console.log(`${' '.repeat(w)}  defaults  ${describeDefaults(r.defaults)}`);
        }
      });
      return 0;
    }

    // ---------------------------------------------------------------- log
    case 'log': {
      const id = rest[0] ? num(rest[0], 'hkb log <id>') : undefined;
      const limit = values.limit !== undefined ? (num(values.limit, '-n') as number) : 50;
      // `-n` is the wrong axis for "what happened while I was at lunch": a count answers how much
      // to read, not how far back. The two compose — the window narrows first, the count caps it.
      const window = values.since !== undefined ? parseDuration(String(values.since)) : undefined;
      const since = window !== undefined ? new Date(Date.now() - window) : undefined;
      if (id && !(await db.job.findUnique({ where: { id } }))) {
        throw usage(`no Job #${id} — \`hkb ls\` shows what is on the board`);
      }
      const board = await db.board.findUnique({ where: { slug } });
      if (!board) throw usage(`no board "${slug}" — \`hkb new\` creates one`);
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
      throw usage(`unknown verb "${verb}" — try one of: new, ls, show, run, retry, done, cancel, rm, stop, start, up, down, log, boards`);
  }
}

export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } finally {
    await closeBoard();
  }
}
