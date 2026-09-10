import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openBoard, closeBoard } from './db.ts';
import { ensureSchema } from './schema.ts';
import { databaseUrl } from './db-url.ts';
import { reconcile } from './controller.ts';
import { checkExportPath } from './exports.ts';
import {
  approveJob, concludeJob, queueJob, rejectJob, removeJob, retryJob, triageJob,
} from './transitions.ts';
import { describeChange, setJobSpec, type Settable } from './job-spec.ts';
import { createJob } from './filing.ts';
import { boardSummary, boardSummaries, listJobs, showJob, PHASES, type Phase } from './read.ts';
import {
  checkFlag, given, givenList, num, seconds, usage,
} from './flags.ts';
import { checkResultName, RESULT_MAX_BYTES } from './results.ts';
import { checkArtifactName, artifactsDir, bytes } from './artifacts.ts';
import { parseLabels, jobLabels, describeLabels } from './labels.ts';
import { PROPOSAL_ARTIFACT, describeProposal, storedProposal } from './proposals.ts';
import { eventLine, watchEvents, watchWhere, WATCH_FALLBACK_MS } from './watch.ts';
import { checkPluginPath, pluginList } from './plugins.ts';
import { CHECK_COMMAND_MAX_BYTES, describeCheck, storedCheck } from './check.ts';
import { checkInputSpec, declaredInputs, renderBrief, describeSource } from './inputs.ts';
import { workflowPath, WORKFLOW_DIR } from './templates.ts';
import { toolSurface } from './runtime/surface.ts';
import { fakeRuntime } from './runtime/fake.ts';
import * as daemon from './daemon.ts';
import { EFFORTS, boardDefaults, type SpecSource } from './spec.ts';
import { PACKAGE_ROOT } from './paths.ts';
import type { Runtime } from './runtime/index.ts';

/**
 * The two predicates the listing prints, kept importable from here.
 *
 * They moved to `src/read.ts` with the rest of the read model — a rendered marker whose predicate
 * lives in the CLI is the same "a second consumer re-derives it" problem one layer down — and are
 * re-exported because this module is where everything that reads a board has always found them.
 */

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

const HELP = `hkb — run one agent against one brief

  hkb new <name>            file a Job
       --brief <text> | --brief-file <path> | --brief - (stdin)
       --from <workflow>  file it from \`${WORKFLOW_DIR}/<workflow>.md\` in this board's
                        REPOSITORY: the frontmatter is the spec, the body is the brief. The keys
                        ARE the flags below, without the dashes — \`max-budget: 2\`,
                        \`allow-tool: [Read, Write]\` — so this help is the format's reference too,
                        and a key that is not a flag is refused by name. Anything you also pass
                        on the line WINS over the file, and the workflow's own \`name:\` is the
                        Job's name if you give none. It is expanded once, here: the Job holds
                        the values and editing the file later changes nothing already filed.
       --model <m>  --effort low|medium|high|xhigh|max
       --max-turns <n>  --max-budget <usd>  --max-retries <n>
       --attempt-deadline <s>  one attempt's wall clock, in seconds. Kubernetes'
                        \`template.spec.activeDeadlineSeconds\`: a session that outruns it is
                        stopped, and the attempt is RETRIED like any other failure. 1800 unless
                        the board says otherwise.
       --deadline <s>   the whole JOB's wall clock, across every attempt, from the first one's
                        start. Kubernetes' \`activeDeadlineSeconds\`, and its rule comes with it:
                        this OUTRANKS --max-retries. A Job past it ends \`deadline_exceeded\`
                        with no further attempt, however many retries remain. Unset by default —
                        the per-attempt clock always applies; this one when somebody asks.
       --no-isolate     run in the current checkout instead of its own worktree
       --allow-tool <t> the tool surface this Job may use, repeatable. Anything absent is
                        DENIED at admission, not merely discouraged. Without it the runtime's
                        own default applies, and \`Skill\` is on it — a Job granted a
                        --plugin-dir needs it to INVOKE what it was granted, so a narrowed
                        list drops that ability unless it names it too. \`Agent\` is not on
                        the default: one Job is one agent.
                        --allow-tools Read,Grep says the same in one argument.
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
       --input <n=src>  what the Job is GIVEN, repeatable. Four sources:
                          \`file:<repo-path>\`  a file in the board's repository
                          \`board\`             this board's Jobs, phases and outcomes
                          \`value:<literal>\`   a payload the caller pushes, not one hkb fetches
                          \`self:<field>\`      this Job about itself — id, name, board, attempt,
                                              slot, repo
                        Read before the run and put in the prompt; an input the board cannot read
                        fails the attempt without spending one. Narrow --allow-tool alongside it
                        and the Job sees what it was given and no more.
                        \`self:slot\` is the one that answers "which concurrent worker am I" — a
                        small integer no other live run holds, for a port or a database name.
                        A \`value:\` may also be interpolated into the brief as {{name}} or
                        {{name.field}} — whichever way the brief arrived. Only \`value:\`, because
                        the brief is instruction and a fetched source is data.
       --result <name>  a named value the Job must produce — a finding, a decision, a URL.
                        The board keeps it on the attempt and \`hkb show\` prints it, so a Job
                        that makes no commit still leaves something behind. Repeatable.
       --label k=v      group this Job, repeatable — \`workflow=release\`, \`area=parser\`.
                        A map, not a tag list, so two labels compose; \`hkb ls --label k=v\`
                        selects on them. Nothing schedules off a label: it is how you find
                        work again, not how work finds work.
       --artifact <name> a FILE the Job must produce, kept beside the board rather than
                        committed. Same contract as --result with no size limit: for a report,
                        a dataset, a proposal. A name may come back as a directory. Repeatable.
       --guide <path>   the repository's contributor guide, repo-relative — usually CLAUDE.md.
                        Read from the board's repository and put in FRONT of the brief as
                        standing instruction, so a worker follows the rules the repository
                        already writes down instead of the brief restating them. Follows one
                        level of \`@import\`. Defaults to the board's --guide.
       --check "<cmd>"  the command that says whether the work BEHAVES: run in the attempt's
                        workspace after the run, on the tree as the session left it, and a
                        non-zero exit fails the attempt. hkb's worker is an agent session, so
                        it has no exit code of its own — --export and --result reconstruct one
                        for files, this one for behaviour. It runs through the shell, so
                        \`npm run lint && npm test\` is one check. The worker is told the command
                        up front, and a failed one is told to the retry with its output.
                        Defaults to the board's --check; nothing runs unless one of the two is
                        set. \`--check ""\` is this Job running NO check and not inheriting the
                        board's — for an investigation with no suite to pass.
       --triage         file it WITHOUT queueing it: a Job in triage is never claimed, so this
                        is where something you noticed goes until you have decided it is work.
                        The brief is optional here — the name is the brief until \`hkb queue\`
                        gives it a real one.
       --propose        this Job PROPOSES Jobs instead of filing them. It writes one JSON
                        file, you read it, and the controller creates the rows on approval —
                        so a worker that decomposes work needs no board access at all, and a
                        retried attempt cannot double-file anything. Implies a gate.
       --board <slug>   default: default

  hkb ls                    what is on the board        [--phase p] [--board s]
       --all               every board on this machine, with a BOARD column
       --label k=v         only Jobs carrying that label, repeatable and ANDed. Equality
                           only, on purpose: \`!=\`, \`in\` and \`notin\` are a query language,
                           and \`--label workflow=release --label step=draft\` is the question
                           labels were wanted for.
  hkb show <id>             one screen: spec, phase, every attempt
  hkb run [<id>]            reconcile once, in the foreground   [--fake]
  hkb retry <id>            re-queue a Job that stopped, resuming its session
       --max-budget <usd>  required when it stopped on max_budget: the same cap
                           would stop it in the same place
       --max-turns <n>  --max-retries <n>
       --attempt-deadline <s>|none  --deadline <s>|none  seconds; "none" clears it back to
                        the board's answer
  hkb queue <id> ["…"]      a triage item is work after all: queue it, optionally re-briefed
  hkb triage <id>           the other way — file a pending Job back under "not yet"
  hkb approve <id> ["…"]    let a gated Job go on, in the same session, with your words
                            — or, for a --propose Job, file what it proposed
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
  hkb watch [<id>]          follow the stream as it happens     [--all] [-n <count>]
       --after <event>     resume exactly where a previous watch stopped — every line
                           leads with the id to feed back, so a consumer that dies
                           misses nothing
       --since <dur>       start from a moment instead: 90s, 30m, 2h
       --timeout <s>       stop after this long, for a script that waits for one thing
                        \`--json\` streams one event per line; the header goes to stderr, so
                        \`hkb watch --json | jq\` is exactly the events.

  hkb job set <id>          change a filed Job's spec, without SQL — the same flags \`hkb new\`
                            takes. Every change goes on the event stream with its before and
                            after, because a Job's spec is what the NEXT attempt gets and the
                            ones behind it ran under something else.

  hkb boards                every board on this machine
  hkb boards add <slug>     point a board at a repository       [--repo <path>]
  hkb boards rm <slug>      remove a board and everything on it [--force]
  hkb boards set <slug>     the ceilings and the spec defaults, without SQL
       --max-concurrent <n>  how many Jobs the board runs at once (0 drains it)
       --daily-budget <usd>|none
       --model <m>|none  --effort <e>|none  --max-turns <n>|none
       --max-budget <usd>|none  --max-retries <n>|none
       --attempt-deadline <s>|none  the per-attempt wall clock every Job here inherits
       --deadline <s>|none  a Job-wide wall clock for every Job filed here. Unset ships
                        nothing: this is the one deadline that ENDS a Job rather than
                        retrying it, and a default that silently ends work is not a default
       --allow-tools <a,b>|none  the default tool surface for Jobs that name none. Same
                        rule as --allow-tool above and one level more dangerous: a board
                        default that omits \`Skill\` turns skill invocation off for every
                        Job filed here at once, including ones granted a --plugin-dir.
       --default-plugin-dirs <a,b>|none  directories, repo-relative, whose skills every Job
                        on this board may see — \`.claude\` is the usual one
       --guide <path>|none  the contributor guide every Job on this board reads, repo-relative
                        — \`CLAUDE.md\` is the usual one
       --check "<cmd>"|none  the command every Job on this board must pass — usually the one
                        the contributor guide names, as in \`npm run lint && npm test\`. A Job's
                        own --check wins, and \`hkb job set <id> --check ""\` opts one Job out of
                        this entirely; with neither set, nothing runs.
       --workflow <name>|none  how work on this board FINISHES: the workflow in
                        \`${WORKFLOW_DIR}/\` whose frontmatter fills what a Job did not say when it
                        is filed, and whose BODY is appended as standing steps when it RUNS —
                        commit, push, "open a draft pull request". hkb itself says NOTHING about
                        git: the core requires no commit, push or rebase, so every step that wants
                        one lives here (ADR-018). Composed at claim time rather than stored, so
                        \`hkb queue <id> "…"\` cannot drop it and editing the file changes the next
                        attempt. A Job filed with \`--from\` ignores it — that workflow governs —
                        and so do \`--propose\` and \`--no-isolate\`, which have no workspace for
                        the steps to be about. Null appends nothing.

  hkb migrate               apply this build's pending migrations to the board, deliberately
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
  if (values.brief !== undefined) {
    // `--brief --json` filed the word `--json` as a two-character brief and ran a paid session on
    // it; `given` is the same guard every other string flag has.
    const brief = given(values.brief, '--brief');
    if (brief) return brief;
  }
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
    // Both wall clocks, in the seconds the flags take. The Job-wide one is the louder of the two
    // and is printed as such: it is the only default here that ENDS a Job rather than shaping it,
    // and a board silently capping every Job's total wall time is exactly the kind of surprise this
    // line exists to prevent.
    d.attemptDeadlineSeconds !== null ? `attemptDeadline=${d.attemptDeadlineSeconds}s` : null,
    d.activeDeadlineSeconds !== null ? `deadline=${d.activeDeadlineSeconds}s across every attempt` : null,
    // The two list-valued defaults, which said nothing here until now. A board-wide grant nobody
    // can see is the kind of state that becomes a surprise: `allowedTools` decides what every Job
    // on this board may DO, and `pluginPaths` what every Job may READ (ADR-012).
    d.allowedTools !== null ? `allowTools=${d.allowedTools.join('|') || '(none)'}` : null,
    d.pluginPaths !== null ? `plugins=${d.pluginPaths.join('|') || '(none)'}` : null,
    // And the third thing a board hands every worker: the document it reads as standing instruction
    // (ADR-013). Same reasoning as the two above — a grant nobody can see becomes a surprise.
    d.guide !== null ? `guide=${d.guide}` : null,
    // And the command every Job on this board has to pass. The loudest of them all, since it is a
    // shell line that runs with the daemon's privileges and decides whether an attempt failed —
    // a board-wide check nobody can see is exactly the surprise this line exists to prevent.
    d.check !== null ? `check=${d.check}` : null,
    // And the steps every hand-filed Job on this board is given on top of its brief. The loudest of
    // the three grants for the same reason as the check: it is text that reaches a worker as
    // instruction, and a board that silently appends "open a pull request" to every brief is a
    // surprise the operator should be able to read off one line (ADR-017 decision 1).
    d.workflow !== null ? `workflow=${d.workflow}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' ') : '(none)';
}

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

/**
 * Every flag hkb parses, in one place so that two things can read it: `parseArgs`, and the check
 * that refuses a flag nobody declared. Under `strict: false` an unknown long option is silently a
 * boolean, so the table is the only thing that knows what a real flag is (`unknownFlags`).
 */
const OPTIONS = {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      fake: { type: 'boolean' },
      force: { type: 'boolean' },
      'no-isolate': { type: 'boolean' },
      // Repeatable: a Job with two deliverables declares two paths, and the alternative — one
      // comma-separated string — makes a filename containing a comma undeclarable.
      export: { type: 'string', multiple: true },
      // `key=value`, repeatable — on `hkb new` it labels the Job, on `hkb ls` it selects. One flag
      // for both, because the thing you filed with is the thing you look for.
      label: { type: 'string', multiple: true },
      // Repeatable for the same reason `--export` is: a Job with two named values declares two.
      result: { type: 'string', multiple: true },
      artifact: { type: 'string', multiple: true },
      'plugin-dir': { type: 'string', multiple: true },
      'default-plugin-dirs': { type: 'string' },
      guide: { type: 'string' },
      // The completion check: one shell line, never repeatable. Two commands are `a && b`, which
      // the shell already spells better than a flag could, and a list would need a rule for what
      // happens after the first non-zero exit — which is the one thing this feature is about.
      check: { type: 'string' },
      // `hkb new` takes the name as a positional; `hkb job set` needs a flag for it. Declared here
      // and NOT optional to declare: `parseArgs` runs with `strict: false`, where an undeclared
      // long option is a boolean — so `--name "a better name"` yielded `true`, and the Job was
      // renamed to the literal string "true" with the words pushed into positionals.
      name: { type: 'string' },
      input: { type: 'string', multiple: true },
      gate: { type: 'string' },
      // The ref the checkout is cut from. One value, never repeatable: a branch has one base, and
      // a second would be a merge nobody asked for.
      // A boolean, because the only thing that may be proposed is Jobs (ADR-011 decision 6). It
      // becomes the string the column holds, so the closed set can grow without a flag change.
      propose: { type: 'boolean' },
      // File it without queueing it. The capture half of a state `pending` could not hold.
      triage: { type: 'boolean' },
      // Repeatable, for the same reason `--export` is: a tool name is a token, and one
      // comma-separated string makes the empty list ("this Job may call nothing") unsayable.
      'allow-tool': { type: 'string', multiple: true },
      'allow-tools': { type: 'string' },
      brief: { type: 'string' },
      'brief-file': { type: 'string' },
      // One workflow, expanded into this Job at file time. Not repeatable: two templates would need
      // a rule for which one wins per key, and "the flag you typed wins over the file" is the only
      // precedence anyone should have to hold.
      from: { type: 'string' },
      // The board's default workflow, on `hkb boards set`. A name, never a body: the file is read
      // from the board's repository, so what a board appends to every brief changes by merge.
      workflow: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      board: { type: 'string' },
      all: { type: 'boolean' },
      phase: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-budget': { type: 'string' },
      'max-retries': { type: 'string' },
      'attempt-deadline': { type: 'string' },
      deadline: { type: 'string' },
      'max-concurrent': { type: 'string' },
      'daily-budget': { type: 'string' },
      status: { type: 'boolean' },
      repo: { type: 'string' },
      foreground: { type: 'boolean' },
      interval: { type: 'string' },
      timeout: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      since: { type: 'string' },
      // The watch cursor. An id, not a duration — `--since` is "how far back", `--after` is
      // "resume exactly here", and only the second one survives a restart without gaps.
      after: { type: 'string' },
} as const;

/**
 * A `parseArgs` token, as much of one as this needs. Structural rather than imported, so the
 * decisions below can be tested against plain objects with no parser in the way.
 *
 * `value` is present on an option token **only when it consumed one**, which is the field both
 * checks below turn on: a boolean flag swallows nothing, so nothing after it can have spilled.
 */
export type ArgToken = { kind: string; index: number; name?: string; rawName?: string; value?: string };

/**
 * Words left over after the name, which is what an unquoted value looks like.
 *
 * The bug, filed as triage #40 and reproduced exactly:
 *
 *     hkb new "review the parser" --input page=value:the wiki page
 *
 * `--input` takes one token, so it gets `page=value:the`; `wiki` and `page` fall through as
 * positionals; and `hkb new` joins every positional into the Job's NAME. A Job called *"review the
 * parser wiki page"* whose input is the single word `the`, filed with no complaint.
 *
 * ## The rule, and the two wrong versions before it
 *
 * `hkb new`'s name is **every positional**, so the only question worth asking is *which positionals
 * are the name*. They are: the ones before the first flag, or — when there are none there — the
 * first one after it. Everything beyond that is a leftover.
 *
 *     hkb new "a name" --input k=v:x y      →  `y` is a leftover
 *     hkb new --triage "an idea"            →  the idea IS the name
 *     hkb new --triage "a" --input k=v:x y  →  `a` is the name, `y` is a leftover
 *     hkb new my great job --brief "x"      →  all three words are the name
 *     hkb new "a" --brief x -- more         →  `--` says the rest is positional
 *
 * The first version was "any positional after any option", which refused four documented forms. The
 * second asked whether a positional appeared before the *first* flag and gave up if not — which
 * made the whole check inert the moment a boolean led the line, so the third example above went
 * through silently. Both were caught by review rather than by tests, and the reason is the same
 * one both times: the tests said what the guard must refuse and never what it must allow.
 *
 * ## Why only `hkb new`
 *
 * `queue`, `done`, `cancel`, `approve` and `reject` join their trailing positionals into prose too,
 * and there they cannot be told apart from a spilled value: `hkb cancel 1 --board b "superseded"`
 * and `hkb cancel 1 --board my board name` produce the same token shape, and the first is ordinary.
 * Guarding them would mean giving up the greedy join — which exists so an unquoted reason is not
 * silently truncated to its first word, i.e. to prevent the *other* silent failure. One or the
 * other; this keeps the join and guards the verb where the name is unambiguous.
 */
export function strayWords(tokens: ArgToken[]): { words: string[]; after: string | null } {
  const none: { words: string[]; after: string | null } = { words: [], after: null };
  const verbAt = tokens.find((t) => t.kind === 'positional')?.index;
  if (verbAt === undefined) return none;

  // `--` is the standard way to say *everything after this is a positional*, and a guard with no
  // override is one that eventually gets in the way.
  const terminator = tokens.find((t) => t.kind === 'option-terminator')?.index ?? Infinity;
  const after = tokens.filter((t) => t.index > verbAt && t.index < terminator);
  const firstFlag = after.find((t) => t.kind === 'option');
  if (!firstFlag) return none;

  const positionals = after.filter((t) => t.kind === 'positional');
  const beforeFlags = positionals.filter((t) => t.index < firstFlag.index);
  // The name is what came before the flags — or, if nothing did, the first thing after them.
  const strays = beforeFlags.length
    ? positionals.filter((t) => t.index > firstFlag.index)
    : positionals.slice(1);
  if (!strays.length) return none;

  // The flag the leftovers came straight after, named ONLY if it consumed a value: only then can it
  // have spilled one, and only then is "quote it" the fix. `--brief x --json b` blames nothing.
  const nearest = after.filter((t) => t.kind === 'option' && t.index < strays[0].index).pop();
  const spilled = nearest?.value !== undefined ? nearest : undefined;
  return { words: strays.map((t) => t.value ?? ''), after: spilled?.name ? `--${spilled.name}` : null };
}

/**
 * Flags nobody declared, which `parseArgs` accepts as booleans rather than refusing.
 *
 * This is the *other* half of the same bug and the reason `hkb job set --name "a better name"`
 * renamed a Job to the literal string `"true"`: under `strict: false` an undeclared long option is
 * not an error, it is a boolean, and its intended argument falls through as a positional.
 *
 * Checked here rather than by turning on `strict: true` because strict mode throws Node's own error
 * — no exit code of ours, no message naming the fix, and it fires before the `--help` path that a
 * person mistyping a flag is most likely to want next.
 */
export function unknownFlags(tokens: ArgToken[], declared: Iterable<string>): string[] {
  const known = new Set(declared);
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== 'option' || !t.name || known.has(t.name)) continue;
    // `rawName` is what was typed — `-z` stays `-z`, rather than being echoed back as `--z`, which
    // is a different thing and not what is on their screen.
    seen.add(t.rawName || `--${t.name}`);
  }
  return [...seen];
}

/**
 * The verbs `strayWords` is asked about — one, and see its docstring for why the other five cannot
 * be. A set rather than an equality check because the honest answer is "the ones where the name is
 * unambiguous", and that list is a property of the verbs rather than of this line.
 */
const GUARDED = new Set(['new']);

export async function main(argv: string[]): Promise<number> {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    tokens: true,
    options: OPTIONS,
  });
  const [verb, ...rest] = positionals;
  const out: Out = { json: !!values.json };
  // `help` as a verb as well as a flag: it is what a person types first, and answering "unknown
  // verb: help" to it is the kind of small friction this project treats as a bug.
  if (!verb || verb === 'help' || values.help) { process.stdout.write(HELP); return 0; }
  // A flag nobody declared. Under `strict: false` it is silently a boolean and its argument falls
  // through as a positional — which is how `hkb job set --name "a better name"` renamed a Job to
  // the literal string "true" (`gotchas/argv-traps`). Checked for every verb, because a misspelling
  // is a misspelling whichever one it follows.
  //
  // **After the help path**, deliberately: this module's own argument for not using `strict: true`
  // is that strict mode errors before `--help` can answer, and a person who has just mistyped a
  // flag is exactly the person about to ask for it. `hkb new --brefi x --help` prints the help.
  const unknown = unknownFlags(tokens as ArgToken[], Object.keys(OPTIONS));
  if (unknown.length) {
    throw usage(
      `unknown ${unknown.length === 1 ? 'flag' : 'flags'}: ${unknown.map((f) => `\`${f}\``).join(', ')}`
      + ` — \`hkb --help\` lists what each verb takes. An undeclared flag is not an error to the`
      + ` argument parser, it is a boolean, so this would otherwise have been accepted and its value`
      + ` filed as something else.`,
    );
  }

  // A value that lost its quotes. AFTER the unknown-flag check above, and that order is the fix for
  // a real misdiagnosis: `hkb new n --brefi "do it"` is a misspelled flag, and reported as a stray
  // word it sent the operator to re-quote a value that was already quoted. See `strayWords` — the
  // reason this is a refusal rather than a best guess is that the two readings need opposite fixes,
  // and only the person who typed it knows which they meant.
  if (GUARDED.has(verb)) {
    const stray = strayWords(tokens as ArgToken[]);
    if (stray.words.length) {
      const where = verb === 'new' ? 'name' : 'message';
      throw usage(
        `hkb ${verb}: ${stray.words.length === 1 ? 'a stray word' : `${stray.words.length} stray words`} after `
        + `${stray.after ? `\`${stray.after}\`` : 'a flag'} — ${stray.words.map((w) => `\`${w}\``).join(', ')}. `
        + (stray.after
          ? `A value with spaces in it needs quoting, as in ${stray.after} "…"; text that belongs to the ${where} goes before the flags.`
          : `Text that belongs to the ${where} goes before the flags, or after \`--\`.`),
      );
    }
  }
  // Before `openBoard()` on purpose — see packageVersion(). `--version` too, because that is what
  // every other CLI answers to and being told "unknown verb" for it is a small, avoidable insult.
  if (verb === 'version' || values.version) {
    const version = packageVersion();
    emit(out, { version }, () => process.stdout.write(`hkb ${version}\n`));
    return 0;
  }

  // Also before `openBoard()`, and it has to be: opening the board is the thing that would apply
  // the migrations, so a verb whose whole job is to apply them deliberately cannot go through it.
  if (verb === 'migrate') {
    const file = databaseUrl().replace(/^file:/, '');
    const got = ensureSchema(file, undefined, { asked: true });
    emit(out, { board: file, ...got }, () => {
      if (!got.applied.length) console.log(`${file} is already up to date (${got.alreadyApplied} migrations)`);
      else console.log(`${file} — applied ${got.applied.length}:\n${got.applied.map((m) => `  ${m}`).join('\n')}`);
    });
    return 0;
  }

  const db = openBoard();
  // `up`, `down` and `boards` are machine-wide when no board is named, and so is `ls --all`;
  // everything else means the repository you are in. Resolving here keeps that one decision in one
  // place — but it also means resolution happens BEFORE the verb runs, so a verb that wants no
  // board has to say so here rather than by ignoring the answer. `ls --all` ignored it, and once
  // `resolveBoard` learned to refuse an ambiguous checkout it started refusing for a board that
  // command never reads.
  // Through `given` like every other string flag: a bare `--board` is the boolean `true`, and it
  // reached `prisma.board.findUnique` as one — a raw client error with no exit code of ours and
  // nothing in it naming the fix.
  const named = values.board !== undefined ? (given(values.board, '--board') || undefined) : undefined;
  const machineWide = ['up', 'down', 'boards'].includes(verb) || (verb === 'ls' && !!values.all);
  const scope = machineWide
    ? { slug: named ?? '', repoPath: null, known: false }
    : await resolveBoard(db, named);
  const slug = scope.slug;

  switch (verb) {
    // ---------------------------------------------------------------- new
    case 'new': {
      // Parse, call, print — and nothing else. Everything between "the arguments are parsed" and
      // "the row is printed" is `createJob` (`src/filing.ts`): the workflow read and its
      // fill-what-is-absent rule, every declaration and its refusal by name, the proposing-Job
      // rules, the row and the Event. What is left here is what only a terminal has — argv, and a
      // brief that may be waiting on stdin.
      //
      // The spec goes over under the FLAG NAMES, because that is the vocabulary a workflow file's
      // frontmatter already uses and `hkb job set` already takes: one spelling of `max-budget`
      // across three surfaces, and `hkb --help` is the reference for all of them.
      const filed = await createJob(db, scope, {
        ...values,
        // `hkb new`'s name is every positional, joined — see `strayWords` for why the leftovers
        // after a flag are refused rather than swept in here. Undefined when nothing was typed, so
        // that a workflow's own `name:` can answer.
        name: rest.join(' ').trim() || undefined,
        // A PRODUCER, so `--brief -` cannot block on stdin for a `--from` that does not exist.
        // Absent unless one of the two flags was given: what a Job with no brief falls back to —
        // the workflow's body, the name of a triage note, or a refusal — is `createJob`'s rule.
        brief: values.brief !== undefined || values['brief-file'] !== undefined
          ? () => readBrief(values)
          : undefined,
      }, { by: whoami() });
      const r = filed.row;
      const check = r.check;
      emit(out, r, () =>
        console.log(`#${r.id} ${r.name}  [${r.phase}]  on ${r.board}`
          + (r.phase === 'triage' ? `  — noted, not queued. \`hkb queue ${r.id}\` when it is work` : '')
          // Named because the Job no longer remembers: a workflow is expanded at file time and gone,
          // so this line is the only place the two are ever seen together.
          + (filed.from ? `\n  from workflow ${filed.from.name}${filed.from.description ? ` — ${filed.from.description}` : ''}` : '')
          // Said out loud for the same reason: this brief is not only what was typed, and a worker
          // that is going to be told something the operator did not write should not be the first
          // to find out.
          + (filed.standingSteps ? `\n  finishes with ${filed.standingSteps.name}${filed.standingSteps.description ? ` — ${filed.standingSteps.description}` : ''}  [board ${r.board}]` : '')
          + (r.exports.length ? `\n  must produce  ${r.exports.join(', ')}` : '')
          + (r.results.length ? `\n  must report   ${r.results.join(', ')}` : '')
          + (r.artifacts.length ? `\n  must hand over ${r.artifacts.join(', ')}` : '')
          + (r.inputs.length ? `\n  is given      ${r.inputs.map((i) => `${i.name}=${describeSource(i)}`).join(', ')}` : '')
          // Echoed back because a grouping nobody can see is a surprise — the same argument
          // `describeDefaults` makes for a board's defaults.
          + (Object.keys(r.labels).length ? `\n  labels        ${describeLabels(r.labels)}` : '')
          + (r.proposes ? `\n  proposes      Jobs — it writes \`${PROPOSAL_ARTIFACT}\` and waits for you to approve` : '')
          // Echoed for the same reason the declared outputs are: it is half the completion
          // condition, and a Job whose attempt can fail on a command nobody printed is a surprise.
          // Traced like every other resolved value: the command and where it came from. An
          // explicit opt-out is said out loud too — on a board WITH a default it is the more
          // surprising of the two, and silence there reads as "nobody configured anything".
          // Never for a proposing Job: it runs none, so naming the board's command here would
          // promise a judgement nobody is going to make. See `hkb show`, which says the same.
          + (r.proposes
            ? ''
            : check.value
              ? `\n  must pass     ${check.value}  [${check.source}]`
              : check.value === ''
                ? '\n  must pass     nothing — this Job opts out of the board\'s check'
                : '')));
      return 0;
    }

    // ---------------------------------------------------------------- ls
    case 'ls': {
      const phase = values.phase as Phase | undefined;
      // NOT checked here. `listJobs` refuses an unknown phase in its own words, and two wordings
      // for one refusal is the drift this extraction exists to stop — one layer further down than
      // the drift it was written for.
      // Two ways to say which board, meaning opposite things. Letting one silently win would make
      // the same command line list one board or all of them depending on an order nobody can see.
      const all = !!values.all;
      if (all && named) {
        throw usage(`--all is every board on this machine and --board ${named} is one — they contradict each other. Drop whichever you did not mean.`);
      }
      // Equality, ANDed, and parsed BEFORE the read: a malformed selector is a usage error, and an
      // empty listing is the one answer it must never give — that reads as "nothing matches".
      const selector = parseLabels(givenList(values.label, '--label'));
      // The read model, emitted verbatim under `--json`. What is left in this verb is the table:
      // the widths, the marker and the tail, which are a terminal's opinion about a screen.
      const rows = await listJobs(db, { slug: all ? null : slug }, { phase, labels: selector });
      emit(out, rows, () => {
        // The selector is named back in the empty case, because "no jobs on default" when you asked
        // for one label is an answer to a question you did not ask.
        const asked = Object.keys(selector).length ? ` labelled ${describeLabels(selector)}` : '';
        if (!rows.length) return console.log(all ? `no jobs${asked} on any board` : `no jobs${asked} on ${slug}`);
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
      // One object: the row, the board, the lease, the attempts, and the spec resolved with each
      // field's source named (`src/read.ts`). `--json` is that object; everything below is the
      // screen it makes.
      const job = await showJob(db, id);
      const { spec, standingSteps: steps } = job;
      emit(out, job, () => {
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
        // Both deadlines, resolved and traced like every other spec field. Seconds, because that is
        // the unit Kubernetes named them in and the one the flags take.
        const deadline = spec.activeDeadlineSeconds;
        console.log(`  spec     isolate=${job.isolate}`);
        console.log(`  attempt-deadline ${spec.attemptDeadlineSeconds.value}s  [${spec.attemptDeadlineSeconds.from}]`);
        console.log(`  deadline ${deadline.value == null ? '(none — the Job may run as long as its retries allow)' : `${deadline.value}s across every attempt`}  [${deadline.from}]`);
        // The surface the run will actually get, RESOLVED — the list itself rather than the words
        // `(runtime default)`, which named neither what is on it nor what is missing. An operator
        // debugging a refused skill read that line and learned nothing; the source is still printed
        // beside it, so "nobody narrowed this Job" is still visible without being the whole answer.
        //
        // Free, and only free since `src/runtime/surface.ts` exists: the constant used to live
        // inside the SDK driver where reaching it meant buying a session, which is why this was
        // deferred to #55 in the first place. `toolSurface` is pure and importable now.
        console.log(`  tools    ${toolSurface({ allowedTools: spec.allowedTools.value ?? undefined }).join(', ') || '(none — this Job may call nothing)'}`
          + `  [${spec.allowedTools.from}]`);
        // What this Job may READ, as distinct from what it may DO. A granted directory widens the
        // skills a worker sees and nothing about the tools it may call — the admission gate is
        // unchanged by it (ADR-012).
        console.log(`  plugins  ${spec.pluginPaths.value?.join(', ') || '(none granted)'}`
          + `  [${spec.pluginPaths.from}]`);
        // The other document a worker reads with the operator's authority, beside the skills. Named
        // even when absent, because "no guide" is the answer to "why did it not follow CLAUDE.md".
        console.log(`  guide    ${spec.guide.value ?? '(none granted)'}  [${spec.guide.from}]`);
        // The other half of the completion condition, printed even when there is none: "no check"
        // is the answer to "why did this succeed when the tests are red", and at the shipped
        // defaults it is the answer every Job gives (ADR-016 §3).
        // Three states, and the middle one is a decision rather than a silence: `''` is a Job that
        // opted out of its board's check (`checkValue`, `src/spec.ts`), and printing it as the
        // built-in absence would hide the very thing the operator set.
        // A PROPOSING Job runs none whatever the board says (`src/controller.ts`), so printing the
        // board's command against one would be the same surprise this line exists to prevent,
        // pointing the other way: a check nobody will run, named as though it decides something.
        console.log(job.proposes && spec.check.value
          ? `  check    (none — a proposing Job changes nothing to check; ${spec.check.from} sets \`${spec.check.value}\`)`
          : `  check    ${spec.check.value === null ? '(none — nothing verifies the work)' : spec.check.value === '' ? '(none)' : spec.check.value}  [${spec.check.from}]`);
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
        // How this Job is GROUPED, printed with the spec rather than with the outputs: a label is
        // something the filer said about the Job, and one nobody can see is a grouping that
        // surprises whoever later asks `hkb ls --label` and does not find it.
        const labels = jobLabels(job.labels);
        if (Object.keys(labels).length) console.log(`  labels   ${describeLabels(labels)}`);
        // What it must produce, beside how it runs — the half of the spec ADR-008 added, and the
        // one that decides whether a completed session counts as a success.
        // Before the outputs, because that is the order the run sees them in.
        const given = declaredInputs(job.inputs);
        if (given.length) console.log(`  inputs   ${given.map((i) => `${i.name}=${describeSource(i)}`).join(', ')}`);
        if (Array.isArray(job.exports) && job.exports.length) console.log(`  exports  ${job.exports.join(', ')}`);
        if (Array.isArray(job.results) && job.results.length) console.log(`  results  ${job.results.join(', ')}`);
        if (Array.isArray(job.artifacts) && job.artifacts.length) console.log(`  files    ${job.artifacts.join(', ')}`);
        if (job.proposes) console.log(`  proposes ${job.proposes} — written to \`${PROPOSAL_ARTIFACT}\`, applied by the controller once approved`);
        if (job.gate) console.log(`  gate     ${job.gate}`);
        // Where it came from, when it came from a proposal. An observation the controller made, so
        // it is worth more than a line in a brief claiming the same thing.
        if (job.proposedByJobId != null) {
          console.log(`  proposed by #${job.proposedByJobId} attempt ${job.proposedByK}, item ${job.proposalIndex}`);
        }
        if (job.suspendedFor) console.log(`  waiting  ${job.suspendedFor} — \`hkb approve ${job.id}\` or \`hkb reject ${job.id} "…"\``);
        if (job.lastError) console.log(`  error    ${job.lastError}`);
        if (job.lastSessionId) console.log(`  resume   ${job.lastSessionId}`);
        console.log(`  brief    ${job.brief.split('\n')[0].slice(0, 88)}${job.brief.length > 88 ? ' …' : ''}`);
        // The part of the brief nobody typed. Named like every other resolved field's source, and
        // for the same reason: a worker is told these steps, and an operator reading this screen to
        // find out why it opened a pull request should not have to read the whole brief to see it.
        if (steps) console.log(`  steps    standing steps from workflow ${steps}, appended when it runs`);
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
          // The clock this attempt was frozen at, printed beside the cap it was frozen at — and
          // that is the whole justification for the column existing. A frozen value nothing reads
          // is two records of one fact answering no question, which is the trap `maxBudgetUsd`'s
          // own comment names; it earns its place by being the number an operator wants next to
          // `timed_out` when the board's default has moved since.
          const clock = ` / ${a.attemptDeadlineSeconds}s`;
          // An attempt in flight has no `endedAt`, and elapsed-so-far is exactly what you want to
          // know about one: the trailing `+` says the number is still climbing.
          const took = formatDuration((a.endedAt ?? new Date()).getTime() - a.startedAt.getTime())
            + (a.endedAt ? '' : '+');
          // 13, not 11: `check_failed` is twelve characters and overflowed the column, so the row
          // an operator is reading precisely because something went wrong was the one that lost its
          // alignment. The width is the longest Outcome plus the gutter.
          console.log(`  k=${a.k}      ${(a.outcome ?? 'running').padEnd(17)}${took.padStart(7)}${cost}${clock}  ${a.sessionId ?? '—'}`);
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
          // What this attempt PROPOSED — the thing the approver actually reads before saying yes,
          // so it is printed in full rather than summarised away. `hkb show --json` carries the
          // whole brief of each; this is the list a person decides on.
          const proposed = storedProposal(a.proposal);
          if (proposed) {
            console.log(`           proposes ${proposed.jobs.length} Job${proposed.jobs.length === 1 ? '' : 's'}:`);
            for (const line of describeProposal(proposed)) console.log(`           ${line}`);
            for (const c of proposed.clamped) console.log(`           ! ${c}`);
          }
          if (a.turns != null) {
            const denied = a.denials ? `, ${a.denials} tool refusal${a.denials === 1 ? '' : 's'}` : '';
            console.log(`           ${a.turns} turn${a.turns === 1 ? '' : 's'}${denied}`);
          }
          // What this attempt took out of its workspace and left in the repository. The pull
          // request line that used to lead here went with the forge read (ADR-018): a Job whose
          // deliverable is a pull request hands its URL back as a declared result, and that is what
          // the board prints — a fact the Job promised rather than one a branch lookup guessed.
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
          // What the check said, when one refused this attempt. The tails are printed rather than
          // summarised: they are the evidence, an operator's next move is to read them, and the
          // alternative is asking them to go and run the command again to see what it already said.
          const checked = storedCheck(a.check);
          if (checked) {
            console.log(`           ${describeCheck(checked)}`);
            // BOTH streams, each said out loud. They are kept in two windows (`src/check.ts`), so
            // an unlabelled join would put them back together in an order neither of them had —
            // and the label is what tells a runner's progress noise from its summary.
            //
            // Only where there IS something. `''.split('\n')` is `['']`, so a check that printed
            // nothing on a stream drew a blank indented line under itself and called it evidence.
            for (const [stream, text] of [['stdout', checked.stdout], ['stderr', checked.stderr]] as const) {
              if (!text) continue;
              console.log(`             ${stream}:`);
              for (const line of text.split('\n')) console.log(`               ${line}`);
            }
          }
          // Not when a check already spoke: `Attempt.reason` holds that same sentence for the
          // benefit of `hkb ls` and `--json`, and printing it under the tail would say it twice.
          if (a.reason && !checked) console.log(`           ${a.reason.slice(0, 100)}`);
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

      // One pass in this process, and it needs the same stop wiring `hkb up --foreground` has.
      // Without a signal, `Ctrl-C` here killed the CLI and left everything the pass had started
      // running: the worker, and — because `runCheck` reads `deps.signal` and nothing else — a
      // detached test suite in the worktree with no timeout of its own left to bound it. Exiting
      // is what the handler must NOT do, for the reason `up --foreground` gives: the lease is
      // released on the way out of `reconcile`, so the job is to ask and then let it unwind.
      const stopper = new AbortController();
      const onSigint = () => {
        if (stopper.signal.aborted) return;
        if (!out.json) console.log('SIGINT — stopping the run in flight');
        stopper.abort();
      };
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigint);
      try {
        const report = await reconcile({
          runtime, cwd: process.cwd(), only, board: slug, signal: stopper.signal,
          onEvent: out.json ? undefined : (l) => console.log(l),
          // Tagged with the Job for the same reason the controller's own lines are: a board that
          // runs two at once interleaves these, and `taskId` is the only thing that untangles them.
          onRuntimeEvent: out.json ? undefined : (e) => {
            if (e.kind === 'tool') console.log(`#${e.taskId}   -> ${e.name}`);
            if (e.kind === 'text') console.log(`#${e.taskId}    : ${e.text}`);
          },
        });
        // `filed` counts, because applying an approved proposal is work this pass did without
        // claiming anything: a run that created three Jobs and reported "nothing pending" would be
        // saying the opposite of what it just did.
        const moved = report.claimed.length + report.reclaimed.length + report.filed.length;
        emit(out, report, () => {
          if (report.refused) console.log(`refused: ${report.refused}`);
          else if (!moved) console.log(only ? `#${only} is not pending — nothing to do` : 'nothing pending');
          else {
            console.log(`${report.succeeded.length} succeeded, ${report.failed.length} failed, ${report.retrying.length} to retry`
              + (report.filed.length ? `, ${report.filed.length} filed from a proposal` : '')
              // Last and named, because it is the only one of these that is a request: the others say
              // what the machine did, this one says what it now needs from a person.
              + (report.suspended.length ? `, ${report.suspended.length} waiting for you` : ''));
          }
        });
      } finally {
        // Removed whatever happened. `hkb run` is also the library-ish entry point every test calls,
        // and a handler left on `process` per call is a listener leak with a warning at ten.
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigint);
      }
      return 0;
    }

    // ---------------------------------------------------------------- rm
    case 'rm': {
      const id = num(rest[0], 'hkb rm <id>');
      if (!id) throw usage('hkb rm <id> — which Job?');
      const r = await removeJob(db, id, { by: whoami() });
      emit(out, r, () => console.log(`removed #${r.removed}`));
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
      const budget = num(values['max-budget'], '--max-budget');
      const turns = num(values['max-turns'], '--max-turns');
      const retries = num(values['max-retries'], '--max-retries');
      const r = await retryJob(db, id, {
        by: whoami(),
        ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
        ...(turns !== undefined ? { maxTurns: turns } : {}),
        ...(retries !== undefined ? { maxRetries: retries } : {}),
      });
      // `raised` under its own key, because the old line spread `{ maxBudgetUsd: {from,to} }` over
      // a `maxBudgetUsd: <number>` — so the field's TYPE changed on the raise path only, and a
      // consumer doing arithmetic on it broke exactly when something interesting happened.
      emit(out, {
        id: r.id, phase: r.phase, maxBudgetUsd: r.maxBudgetUsd, resume: r.resume,
        ...(r.raised ? { raised: r.raised } : {}),
      }, () => {
        const cap = r.raised
          ? `  maxBudget $${r.raised.from.toFixed(2)} → $${r.raised.to.toFixed(2)}` : '';
        // A resumed Job does not start over, and an operator about to watch it needs to know that
        // before they wonder why the branch already has commits on it.
        const from = r.resume ? `  (resumes ${r.resume})` : '  (starts cold)';
        console.log(`#${r.id} pending again${cap}${from}`);
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
      const actor = os.userInfo().username;

      if (verb === 'reject') {
        const r = await rejectJob(db, id, { note, by: actor });
        emit(out, r, () => console.log(`#${r.id} rejected by ${r.by} — ${r.why}`));
        return 0;
      }

      const r = await approveJob(db, id, { note, by: actor });
      // Two different things happen next, and saying the wrong one sends a reader looking for a
      // run that will never start. A proposing Job is not resumed: the controller applies what it
      // proposed and the Job is finished (ADR-011). Every other gated Job continues its session
      // with the approver's words as the prompt (ADR-010 decision 4).
      emit(out, r, () =>
        console.log(`#${r.id} approved by ${r.by} — ${r.proposes
          ? 'the controller files what it proposed on the next pass'
          : 'it resumes on the next pass'}`
          + (r.note ? `, told: ${r.note}` : '')));
      return 0;
    }

    case 'done':
    case 'cancel': {
      const phase = BY_HAND[verb as ByHandVerb];
      const id = num(rest[0], `hkb ${verb} <id> "<reason>"`);
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
      const r = await concludeJob(db, id, { phase, reason, by: operator() });
      emit(out, { ...r, board: slug }, () => {
        console.log(`#${r.id} ${r.phase} — ${r.name}  (was ${r.from})`);
        console.log(`  ${r.endedFor}`);
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
        const repo = (values.repo !== undefined ? given(values.repo, '--repo') : '') || gitRoot(process.cwd());
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
          // `given`, never `String(...)`: a bare `--check` came back as the boolean `true` and was
          // filed as the shell command `true`, which every attempt then "passed". See `given`.
          const raw = given(values[flag], `--${flag}`, `"${CLEAR}"`);
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
        for (const [flag, field] of [['attempt-deadline', 'defaultAttemptDeadlineSeconds'], ['deadline', 'defaultActiveDeadlineSeconds']] as const) {
          const v = seconds(values[flag], `--${flag}`);
          if (v !== undefined) data[field] = v;
        }
        // A list, so it takes the comma-separated form rather than the repeatable one: `boards set`
        // is a single statement about the board, and a repeatable flag here would read as adding to
        // a list rather than replacing it.
        // Repeatable would read as adding to a list; `boards set` is one statement about the
        // board, so this replaces — same reasoning as `--allow-tools` below.
        if (values['default-plugin-dirs'] !== undefined) {
          const raw = given(values['default-plugin-dirs'], '--default-plugin-dirs', `"${CLEAR}"`);
          if (!raw) throw usage(`--default-plugin-dirs was given nothing — pass a comma-separated list of repo-relative directories, or "${CLEAR}" to clear the grant`);
          data.defaultPluginPaths = raw === CLEAR
            ? null
            : raw.split(',').map((v) => v.trim()).filter(Boolean).map(checkPluginPath);
        }
        // Stored verbatim, checked only for being non-empty: the controller reads an exit code and
        // knows nothing about the command (ADR-016 §3), so validating it here would be hkb having
        // an opinion about a shell line it cannot parse. `none` clears it, like every other default.
        setString('check', 'defaultCheck', (v) => {
          // The same cap `hkb new --check` has: the command reaches `spawn` as one argv token.
          if (Buffer.byteLength(v, 'utf8') > CHECK_COMMAND_MAX_BYTES) {
            throw usage(`--check is ${Buffer.byteLength(v, 'utf8')} bytes, and the limit is ${CHECK_COMMAND_MAX_BYTES} — put the command in a script and name that.`);
          }
        });
        // One path, not a list: a repository has one contributor guide, and a second one would be
        // two documents disagreeing about the same rules with no way to say which wins.
        if (values.guide !== undefined) {
          const raw = given(values.guide, '--guide', `"${CLEAR}"`);
          if (!raw) throw usage(`--guide was given nothing — pass a repo-relative path like CLAUDE.md, or "${CLEAR}" to clear the grant`);
          data.defaultGuide = raw === CLEAR ? null : checkExportPath(raw);
        }
        // The workflow whose body every hand-filed Job on this board finishes with, and whose
        // frontmatter fills what the Job did not say (ADR-017 decision 1).
        //
        // The NAME is checked and the file is not, which is the same call `--base` above makes and
        // for a sharper reason: the usual way to set this is in the pull request that
        // ADDS the workflow file, so refusing a name whose file is not merged yet would refuse the
        // one command anybody is going to run. `hkb new` is where a missing file is caught, with the
        // operator standing there and nothing yet created.
        if (values.workflow !== undefined) {
          const raw = given(values.workflow, '--workflow', `"${CLEAR}"`);
          if (!raw) throw usage(`--workflow was given nothing — pass a workflow name like implement, or "${CLEAR}" to append nothing to a brief`);
          if (raw === CLEAR) data.defaultWorkflow = null;
          else {
            // Refuses a name that could never be a workflow, and normalises the `.md` an operator
            // who tab-completed the file will have typed.
            workflowPath(raw, '--workflow');
            data.defaultWorkflow = raw.trim().replace(/\.md$/, '');
          }
        }
        if (values['allow-tools'] !== undefined) {
          const raw = given(values['allow-tools'], '--allow-tools', `"${CLEAR}"`);
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
            + ' --max-retries, --allow-tools, --default-plugin-dirs, --guide, --check,'
            + ' --workflow; "none" clears one)',
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

      // Every board on this machine, in the shape `--json` prints: the counts by phase, the
      // ceilings, the 24-hour spend and whether a daemon is serving it (`src/read.ts`). The table
      // below is this verb's own — the widths and the continuation line are a terminal's
      // opinion, and a second consumer wants the rows and none of that.
      // `--board` answers here now. `boardSummary` existed with no caller — `hkb boards --board hkb`
      // printed the whole machine and the function that would have answered it sat one module over,
      // written and tested. A rung that is possible and already built is not a workflow to document.
      const rows = named ? [await boardSummary(db, named)] : await boardSummaries(db);
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
        // The same renderer `hkb watch` uses, so the two views of one stream cannot drift apart.
        for (const e of rows) console.log(eventLine(e));
      });
      return 0;
    }

    // ---------------------------------------------------------------- queue / triage
    // The two ends of the line `pending` could not draw. `pending` means *wants to run* — a daemon
    // claims it — so a Job you have noticed but not decided on had nowhere to be. The board-wide
    // answers (stop it, drain it to zero concurrency) answer a per-Job question with a per-board
    // switch, and the alternative was to lose the note.
    case 'queue':
    case 'triage': {
      const id = num(rest[0], `hkb ${verb} <id>`);
      if (!id) throw usage(`hkb ${verb} <id> — which Job?`);

      if (verb === 'queue') {
        // The brief may be rewritten HERE and nowhere else, so this is the one verb that reads one.
        // Passed as a PRODUCER: `--brief -` blocks until EOF on stdin, and reading it before the
        // guards turned `hkb queue 999 --brief -` from an instant refusal into a hang.
        const inline = rest.slice(1).join(' ').trim();
        const brief = inline
          || (values.brief !== undefined || values['brief-file'] !== undefined
            ? () => readBrief(values)
            : null);
        const r = await queueJob(db, id, { brief, by: whoami() });
        emit(out, r, () =>
          console.log(`#${r.id} queued${r.rebriefed ? ', with a new brief' : ''} — it runs on the next pass`));
        return 0;
      }

      const r = await triageJob(db, id, { by: whoami() });
      emit(out, r, () => console.log(`#${r.id} back to triage — nothing will claim it`));
      return 0;
    }

    // ---------------------------------------------------------------- job set
    // The Job-side twin of `hkb boards set`, and the third consumer of one flag vocabulary: these
    // are the names `hkb new` parses and a workflow file's frontmatter uses, so `hkb --help`
    // documents all three at once and cannot drift from any of them.
    case 'job': {
      const sub = rest[0];
      if (sub !== 'set') {
        throw usage(`hkb job set <id> — the only subcommand${sub ? `, not "${sub}"` : ''}. \`hkb show <id>\` prints a Job, \`hkb ls\` lists them.`);
      }
      const id = num(rest[1], 'hkb job set <id>');
      if (!id) throw usage('hkb job set <id> — which Job?');
      // Fixed arity, so a leftover is not absorbed into anything — it is silently DROPPED, which is
      // the same fault wearing the other face. `hkb job set 1 --name a better name` set the name to
      // `a` and threw away `better name` without a word.
      if (rest.length > 2) {
        throw usage(
          `hkb job set takes one id, and got ${rest.slice(2).map((w) => `\`${w}\``).join(', ')} as well`
          + ` — a value with spaces in it needs quoting, as in --name "…".`,
        );
      }

      // Parsed and CHECKED here, by the same functions `hkb new` uses, so a value that could never
      // have been filed cannot be set either. `none` clears, the way it does on `hkb boards set`.
      const CLEAR = 'none';
      const changes: Partial<Record<Settable, unknown>> = {};
      const str = (flag: string, field: Settable, check?: (v: string) => unknown) => {
        if (values[flag] === undefined) return;
        // See `given`, and the same bug it names: `String(true)` is the word `true`.
        const raw = given(values[flag], `--${flag}`, `"${CLEAR}"`);
        if (!raw) throw usage(`--${flag} was given nothing — pass a value, or "${CLEAR}" to clear it`);
        changes[field] = raw === CLEAR ? null : (check ? check(raw) : raw);
      };
      const number = (flag: string, field: Settable, ok: (n: number) => boolean, wants: string) => {
        if (values[flag] === undefined) return;
        if (String(values[flag]).trim() === CLEAR) { changes[field] = null; return; }
        const n = num(values[flag], `--${flag}`) as number;
        if (!ok(n)) throw usage(`--${flag} wants ${wants}, got ${n}`);
        changes[field] = n;
      };
      // Repeatable flags REPLACE rather than append, the same choice `hkb boards set` made and for
      // the same reason: this is one statement about the Job, and a flag that appended would give
      // no way to remove a value at all.
      const list = (flag: string, field: Settable, check: (v: string) => unknown) => {
        if (values[flag] === undefined) return;
        // `givenList`, not a cast: a bare repeatable flag is `[true]` and `.trim()` on it threw a
        // raw TypeError, and `--export --json` filed `--json` as the path.
        const items = givenList(values[flag], `--${flag}`);
        changes[field] = items.length === 1 && items[0] === CLEAR ? null : items.map(check);
      };

      str('name', 'name');
      str('model', 'model');
      str('effort', 'effort', (v) => {
        if (!(EFFORTS as readonly string[]).includes(v)) throw usage(`--effort must be one of ${EFFORTS.join('|')}, or "${CLEAR}"`);
        return v;
      });
      str('gate', 'gate');
      str('guide', 'guide', checkExportPath);
      // Its own parse rather than `str`, and the difference is only the length cap and the refusal
      // of a value that is a flag. `none` means here what it means on every other field of this
      // verb: put the column back to null — which for a check is "inherit the board's default
      // again", the state a Job filed without `--check` is already in. Refusing it made
      // `hkb job set --check none` unusable and pointed the operator at leaving the flag out, which
      // on a verb that only writes what it is given is a no-op. See `checkFlag`; `--check ""` is
      // still the different thing, the per-Job opt-out that inherits nothing.
      if (values.check !== undefined) changes.check = checkFlag(values.check, '--check', true);
      number('max-turns', 'maxTurns', (n) => Number.isInteger(n) && n >= 1, 'a whole number of turns, 1 or more');
      number('max-budget', 'maxBudgetUsd', (n) => n > 0, 'dollars above zero');
      number('max-retries', 'maxRetries', (n) => Number.isInteger(n) && n >= 0, 'a whole number of retries, 0 or more');
      // Through `seconds()`, the same parser `hkb new` uses, which is this verb's own stated rule:
      // "a value that could never have been filed cannot be set either". Four inline copies of the
      // predicate meant `--deadline 0` explained itself on one verb and not on the other.
      for (const [flag, field] of [['attempt-deadline', 'attemptDeadlineSeconds'], ['deadline', 'activeDeadlineSeconds']] as const) {
        const v = seconds(values[flag], `--${flag}`);
        if (v !== undefined) changes[field] = v;
      }
      list('plugin-dir', 'pluginPaths', checkPluginPath);
      list('export', 'exports', checkExportPath);
      list('result', 'results', checkResultName);
      list('artifact', 'artifacts', checkArtifactName);
      list('input', 'inputs', checkInputSpec);
      // `--allow-tool` WINS over `--allow-tools`, which is `hkb new`'s precedence and must not be
      // the other way round here: this field is the ceiling `src/admission.ts` enforces, and two
      // verbs resolving the same pair of flags differently is a security surface that depends on
      // which command you typed.
      if (values['allow-tool'] !== undefined) {
        list('allow-tool', 'allowedTools', (v) => v);
      } else if (values['allow-tools'] !== undefined) {
        const raw = given(values['allow-tools'], '--allow-tools', `"${CLEAR}"`);
        if (!raw) throw usage(`--allow-tools was given nothing — pass a comma-separated list, or "${CLEAR}" to clear it`);
        changes.allowedTools = raw === CLEAR ? null : raw.split(',').map((t) => t.trim()).filter(Boolean);
      }
      if (values.label !== undefined) {
        const given = givenList(values.label, '--label').filter(Boolean);
        // `null` for an empty list as well as for `none`: `hkb new` stores null for an unlabelled
        // Job, and `{}` here would be a second spelling of the same absence.
        changes.labels = !given.length || (given.length === 1 && given[0] === CLEAR)
          ? null
          : parseLabels(given);
      }
      // The brief, which `hkb queue` calls rewritable nowhere else — true of the note-becomes-an-
      // instruction moment, and never a reason a typo should cost a Job its id and its history.
      // Settable here and RECORDED, like every other field (`src/job-spec.ts`).
      //
      // RENDERED the way `hkb new` renders it, against the `value:` inputs — the ones being set in
      // this same command if any, otherwise the ones the Job already carries. Without it a brief
      // set here reached the worker with `{{page}}` in it literally, while the identical flags on
      // `hkb new` would have interpolated: the same words, two meanings, depending on the verb.
      //
      // Read through a PRODUCER, so `--brief -` cannot block on stdin for a Job that does not
      // exist. `queueJob` documents that trap and this verb had reintroduced it.
      const brief = values.brief !== undefined || values['brief-file'] !== undefined
        ? () => readBrief(values)
        : null;

      const r = await setJobSpec(db, id, changes, {
        by: operator(),
        ...(brief ? { brief } : {}),
        render: (text, inputs) => {
          const supplied = new Map(
            inputs.filter((i): i is { name: string; value: string } => 'value' in i).map((i) => [i.name, i.value]),
          );
          const out2 = renderBrief(text, supplied, new Set(inputs.map((i) => i.name)));
          return { text: out2.text, used: out2.used };
        },
      });
      emit(out, r, () => {
        if (!r.changed.length) return console.log(`#${r.id} unchanged — every value given is the one it already had`);
        console.log(`#${r.id} ${r.changed.length === 1 ? '1 field' : `${r.changed.length} fields`} set  (${r.phase})`);
        for (const c of r.changed) console.log(`  ${describeChange(c)}`);
      });
      return 0;
    }

    // ---------------------------------------------------------------- watch
    // The third question about the board. `ls` answers what is true now and `log` answers what
    // happened up to now; this one answers "tell me when something happens", which everything that
    // wants to react to hkb has otherwise had to fake by polling one of the other two and diffing.
    case 'watch': {
      const id = rest[0] ? num(rest[0], 'hkb watch <id>') : undefined;
      const all = !!values.all;
      if (all && named) {
        throw usage(`--all is every board on this machine and --board ${named} is one — they contradict each other. Drop whichever you did not mean.`);
      }
      if (values.after !== undefined && values.since !== undefined) {
        throw usage('--after <id> resumes exactly where a previous watch stopped and --since <dur> starts from a moment — they answer the same question differently, so give one.');
      }
      if (id && !(await db.job.findUnique({ where: { id } }))) {
        throw usage(`no Job #${id} — \`hkb ls\` shows what is on the board`);
      }
      const board = all || id ? null : await db.board.findUnique({ where: { slug } });
      if (!all && !id && !board) throw usage(`no board "${slug}" — \`hkb new\` creates one`);
      const scope = id ? { jobId: id } : board ? { boardId: board.id } : {};

      // Where to join the stream. The default is the END of it — a watch is about what happens
      // next, and replaying a month of history because somebody typed `hkb watch` would bury it.
      let after: number;
      if (values.after !== undefined) {
        after = num(values.after, '--after') as number;
      } else if (values.since !== undefined) {
        const at = new Date(Date.now() - parseDuration(String(values.since)));
        // The id just before the window, so the first event INSIDE it is the first one emitted.
        const first = await db.event.findFirst({
          where: { ...watchWhere(scope), at: { gte: at } }, orderBy: { id: 'asc' }, select: { id: true },
        });
        // Nothing of ours in the window, so join at the end of OUR stream. Scoped like the branch
        // below rather than reading the machine's newest event: the two cannot deliver different
        // events (nothing of ours sits between them, or `first` would have found it), but only one
        // of them is a position in this stream, and that is the number the header prints and the
        // operator copies into `--after`.
        after = first ? first.id - 1 : ((await db.event.findFirst({
          where: watchWhere(scope), orderBy: { id: 'desc' }, select: { id: true },
        }))?.id ?? 0);
      } else {
        after = (await db.event.findFirst({
          where: watchWhere(scope), orderBy: { id: 'desc' }, select: { id: true },
        }))?.id ?? 0;
      }

      const limit = values.limit !== undefined ? (num(values.limit, '-n') as number) : undefined;
      const seconds = values.timeout !== undefined ? num(values.timeout, '--timeout') : undefined;
      const stop = new AbortController();
      // Ctrl-C is the ordinary way out and must not read as a failure: a watch that was interrupted
      // did its job. The cursor goes to stderr on the way out so the next one can resume.
      const onSigint = () => stop.abort();
      process.on('SIGINT', onSigint);
      const timer = seconds ? setTimeout(() => stop.abort(), seconds * 1000) : null;

      // stderr, not stdout, and in both modes. `--json` is a STREAM here — one event per line, not
      // one object at the end, because a stream you have to wait for the end of is a list. Keeping
      // the header off stdout is what lets `hkb watch --json | jq` be exactly the events.
      const what = id ? `#${id}` : all ? 'every board' : slug;
      process.stderr.write(`watching ${what} from event ${after}${seconds ? ` for ${seconds}s` : ''} — ctrl-c to stop\n`);

      let cursor = after;
      try {
        cursor = await watchEvents({
          db, scope, after, dir: daemon.boardDir(), signal: stop.signal, limit,
          intervalMs: WATCH_FALLBACK_MS,
          onEvent: (e) => console.log(out.json ? JSON.stringify(e) : eventLine(e, true)),
        });
      } finally {
        if (timer) clearTimeout(timer);
        process.off('SIGINT', onSigint);
      }
      process.stderr.write(`stopped at event ${cursor} — resume with \`hkb watch --after ${cursor}\`\n`);
      return 0;
    }

    default:
      throw usage(`unknown verb "${verb}" — try one of: new, ls, show, run, retry, done, cancel, rm, stop, start, up, down, log, watch, queue, triage, job, boards, migrate`);
  }
}

export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } finally {
    await closeBoard();
  }
}
