import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openBoard, closeBoard } from './db.ts';
import { ensureSchema } from './schema.ts';
import { databaseUrl } from './db-url.ts';
import { reconcile } from './controller.ts';
import { checkExportPath, checkRef } from './worktree.ts';
import {
  approveJob, concludeJob, queueJob, rejectJob, removeJob, retryJob, triageJob,
} from './transitions.ts';
import { describeChange, setJobSpec, type Settable } from './job-spec.ts';
import { checkResultName, RESULT_MAX_BYTES } from './results.ts';
import { checkArtifactName, artifactsDir, bytes } from './artifacts.ts';
import { parseLabels, jobLabels, selects, describeLabels } from './labels.ts';
import { PROPOSAL_ARTIFACT, describeProposal, storedProposal } from './proposals.ts';
import { eventLine, watchEvents, watchWhere, WATCH_FALLBACK_MS } from './watch.ts';
import { checkPluginPath, pluginList } from './plugins.ts';
import { CHECK_COMMAND_MAX_BYTES, describeCheck, storedCheck } from './check.ts';
import { checkInputSpec, declaredInputs, renderBrief, describeSource } from './inputs.ts';
import {
  readTemplate, placeholders, workflowPath, WORKFLOW_DIR,
  type Template,
} from './templates.ts';
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

/**
 * The string a `--flag <value>` was actually given, or a refusal.
 *
 * **`String(values.x)` is the bug this exists to stop.** `parseArgs` runs here with `strict: false`,
 * and a bare `--flag` at the end of a line comes back as the BOOLEAN `true` — so `String(...)` turns
 * it into the word `true` and a non-empty guard waves it through. A bare `--check` was filed as the
 * shell command `true`: `hkb show` printed `check true [job]`, and every attempt of that Job passed
 * a check that verified nothing. That is a guard that is inert while looking present, which is the
 * failure this project keeps finding and the reason `--gate` one line over is written
 * `typeof values.gate === 'string'`.
 *
 * **A value that begins with a dash is refused too**, and it is the same bug one step along.
 * `parseArgs` under `strict: false` hands a string option *the next token*, whatever it is — so
 * `hkb new n --check --json` files the shell command `--json`, the check that judges every attempt
 * of that Job is a flag, and `--json` is silently not in effect either. Nothing legitimate is lost:
 * a shell line, a ref, a path and a comma-separated list all begin with something else, and a value
 * that really does start with a dash is reachable as `--check " -x"` or after `--`. This is the
 * third of the argv traps in `docs/wiki/gotchas/argv-traps.md`, and the first two do not cover it —
 * the option consumed a token, so nothing falls through as a stray positional to be caught.
 *
 * The empty string is NOT refused here — several flags mean something by it — so a caller that has
 * no use for one still has to say so. See `checkFlag`.
 */
function given(raw: unknown, flag: string, clear?: string): string {
  if (typeof raw !== 'string') {
    throw usage(
      `${flag} was given nothing — a bare ${flag} is not a value. Pass one after it, as in `
      + `${flag} "…"${clear ? `, or ${flag} ${clear} to clear it` : ''}.`,
    );
  }
  // Tested on the RAW value, before the trim: `--flag " -x"` is the escape the message below
  // prescribes, and trimming first refused it with the same message — no spelling reached a value
  // that really starts with a dash.
  // FLAG-shaped: a dash followed by a letter, or two dashes. A brief that opens with a Markdown
  // bullet (`- add a test`) and a negative number are values; `-x` and `--json` are the trap.
  if (/^--?[A-Za-z]/.test(raw)) {
    const v = raw.trim();
    throw usage(
      `${flag} was given \`${v}\`, which is a flag rather than a value — \`${flag} ${v}\` would file `
      + `\`${v}\` as ${flag}'s value and drop ${v} itself. The argument parser hands a string option `
      + `the next token whatever it is. Quote a value that really starts with a dash, with a space in `
      + `front of it: ${flag} " ${v}".`,
    );
  }
  return raw.trim();
}

/**
 * The same rule for a repeatable flag: every item is a string, and none of them is a flag.
 *
 * `--export`, `--result`, `--artifact`, `--input`, `--label`, `--allow-tool` and `--plugin-dir` are
 * `multiple: true`, so a bare one comes back as `[true]` rather than as `true` — which walked
 * straight past `typeof raw !== 'string'` and was filed as the literal path, name or tool `true`.
 * `hkb new x --export` declared an output called `true`, and the attempt failed for not producing
 * it. One helper, so a flag added later gets the guard by using it rather than by remembering.
 */
function givenList(raw: unknown, flag: string): string[] {
  if (raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((v) => given(v, flag));
}

/**
 * The completion check as a flag value, for `hkb new` and `hkb job set`.
 *
 * Almost everything is stored verbatim, because the controller reads an exit code and knows nothing
 * about the command (ADR-016 §3). Three shapes are not:
 *
 *   - **a bare `--check`, or one handed the next flag.** See `given`.
 *   - **a command longer than `CHECK_COMMAND_MAX_BYTES`.** `sh -c` passes the whole line as one
 *     argument and the kernel refuses one past `MAX_ARG_STRLEN`, so `spawn` throws `E2BIG` — every
 *     attempt of that Job would fail its check without the work being looked at. Refused where it
 *     is written rather than where it is run. See `src/check.ts`.
 *   - **`none` on `hkb new`.** Every other `--flag none` on this CLI clears a value, and on a *new*
 *     Job there is nothing to clear: the column is already null, which is what inheriting the
 *     board's default IS. Filing it as written files the literal command `none` — exit 127,
 *     `check_failed`, resumed and re-failed until the retries are gone: three paid sessions for a
 *     command that can never pass.
 *
 * On `hkb job set` it is not refused, because there `none` has the meaning it has everywhere else
 * on that verb: **put the column back to null, and inherit the board's default again**. That is
 * what `str()` one line down does for every other field, and what README's own sentence says. The
 * distinction is not a special case for `check`, it is the ordinary one between setting a value and
 * clearing one — a verb that files a row cannot clear a column that does not exist yet.
 *
 * `--check ""` is a VALUE on both, and a different one: no check, and do NOT inherit (`checkValue`
 * in `src/spec.ts`). The board keeps `none` too, for the same reason `hkb job set` does.
 */
function checkFlag(raw: unknown, flag = '--check', clears = false): string | null {
  const v = given(raw, flag);
  if (v === 'none') {
    if (clears) return null;
    throw usage(
      `${flag} none would file the literal shell command \`none\`, which exits 127 — every attempt `
      + `would fail its check and burn a retry. A Job filed with no ${flag} already inherits the `
      + `board's default, so leave ${flag} out for that. For a Job that runs NO check, and does not `
      + `inherit the board's, use ${flag} "".`,
    );
  }
  if (Buffer.byteLength(v, 'utf8') > CHECK_COMMAND_MAX_BYTES) {
    throw usage(
      `${flag} is ${Buffer.byteLength(v, 'utf8')} bytes, and the limit is ${CHECK_COMMAND_MAX_BYTES} — `
      + 'a check runs as `sh -c <the whole line>`, and past the kernel\'s own argument limit it cannot '
      + 'be started at all, so every attempt would fail on the command rather than on the work. Put it '
      + `in a script the repository holds and name that: ${flag} "./scripts/verify.sh".`,
    );
  }
  return v;
}

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
       --no-isolate     run in the current checkout instead of its own worktree
       --base <ref>     the ref this Job branches from, and is kept on top of. Defaults to the
                        repository's default branch. A step that starts from an earlier Job's
                        branch — \`--base kb-33-1\` — starts from where that one finished, which is
                        how work chains: a coding Job's output IS a branch. A plain name is tried
                        as written and then as \`origin/<name>\`; a ref that names nothing fails
                        the Job before a session is bought.
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
                                              slot, branch, base, worktree, repo
                        Read before the run and put in the prompt; an input the board cannot read
                        fails the attempt without spending one. Narrow --allow-tool alongside it
                        and the Job sees what it was given and no more.
                        \`self:slot\` is the one that answers "which concurrent worker am I" — a
                        small integer no other live run holds, for a port or a database name.
                        \`self:base\` is the resolved ref this Job's branch was cut from —
                        \`origin/main\`, or \`origin/kb-33-1\` for a step chained onto another — so a
                        step's own steps can say "open it against your base" and mean it.
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
                        checkout after the run and after the rebase onto the base, and a
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
       --allow-tools <a,b>|none  the default tool surface for Jobs that name none
       --default-plugin-dirs <a,b>|none  directories, repo-relative, whose skills every Job
                        on this board may see — \`.claude\` is the usual one
       --guide <path>|none  the contributor guide every Job on this board reads, repo-relative
                        — \`CLAUDE.md\` is the usual one
       --base <ref>|none  the ref every Job on this board branches from, for a repository whose
                        trunk is not what \`origin/HEAD\` points at
       --check "<cmd>"|none  the command every Job on this board must pass — usually the one
                        the contributor guide names, as in \`npm run lint && npm test\`. A Job's
                        own --check wins, and \`hkb job set <id> --check ""\` opts one Job out of
                        this entirely; with neither set, nothing runs.
       --workflow <name>|none  how work on this board FINISHES: the workflow in
                        \`${WORKFLOW_DIR}/\` whose frontmatter fills what a Job did not say when it
                        is filed, and whose BODY is appended as standing steps when it RUNS —
                        "open a draft pull request against your base". hkb itself tells a worker
                        only what the machinery makes true afterwards (commit on your branch,
                        rebase onto your base, push that branch and nothing else), so anything past
                        that is a step's content and lives here. Composed at claim time rather than
                        stored, so \`hkb queue <id> "…"\` cannot drop it and editing the file
                        changes the next attempt. A Job filed with \`--from\` ignores it — that
                        workflow governs — and so do \`--propose\` and \`--no-isolate\`, which
                        have no branch for the steps to be about. Null appends nothing.

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
  job: {
    phase: string; pr: string | null; exports: string[];
    results?: string[]; artifacts?: string[]; proposes?: string | null;
  },
): boolean {
  if (job.phase !== 'succeeded') return false;
  // A PROPOSING Job that reached `succeeded` had its proposal applied — the controller only writes
  // that phase after filing the rows (`applyProposals`, `src/controller.ts`). Rows on the board are
  // the most concrete output anything here produces, and calling it "produced nothing" was the
  // complaint reading its own answer wrong.
  if (job.proposes) return false;
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
  if (values.brief !== undefined) {
    // `--brief --json` filed the word `--json` as a two-character brief and ran a paid session on
    // it; `given` is the same guard every other string flag has.
    const brief = given(values.brief, '--brief');
    if (brief) return brief;
  }
  throw usage('a Job needs a brief — pass --brief "…", --brief-file <path>, or --brief - to read stdin');
}

/**
 * The completion check under `--json`, in ONE shape wherever it appears.
 *
 * `hkb new --json` printed the RESOLVED check and `hkb show --json` printed the Job's raw column, so
 * the same Job answered `"npm test"` to one verb and `null` to the other — and a script that filed
 * work and then polled it saw a check appear out of nowhere. The resolved value is the one both
 * print, because it is the one that will run; `source` says which of the three levels answered, so
 * nothing is lost by not printing the column (`resolveSpec`, `src/spec.ts`).
 */
/**
 * The check as the controller will RUN it. A proposing Job runs none whatever the board says
 * (`runsCheck` in the controller), so `--json` says null for it rather than a resolved command the
 * human line already qualifies away — the two verbs and the two forms answer the same.
 */
const jsonCheck = (t: { value: string | null; from: string }, proposes?: string | null) =>
  (proposes ? { value: null, source: 'proposes' } : { value: t.value, source: t.from });

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

const PHASES = ['triage', 'pending', 'running', 'succeeded', 'failed', 'suspended', 'done', 'cancelled'] as const;
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
    // And the third thing a board hands every worker: the document it reads as standing instruction
    // (ADR-013). Same reasoning as the two above — a grant nobody can see becomes a surprise.
    d.guide !== null ? `guide=${d.guide}` : null,
    // And the ref every Job on this board branches from. Same reasoning again: a board silently
    // building on something other than the repository's default branch is a surprise waiting in a
    // diff nobody can explain.
    d.base !== null ? `base=${d.base}` : null,
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

const num = (v: unknown, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  // A bare `--max-turns` is the boolean `true`, and `Number(true)` is 1 — a ceiling of one turn,
  // filed silently. The same idiom `given` refuses for strings.
  if (typeof v !== 'string') throw usage(`${flag} was given nothing — a bare ${flag} is not a number. Pass one after it.`);
  if (v.trim().startsWith('-') && !/^-\d/.test(v.trim())) {
    throw usage(`${flag} was given \`${v}\`, which is a flag rather than a number — the parser hands a flag the next token whatever it is.`);
  }
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
      base: { type: 'string' },
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
      // A workflow is read BEFORE anything else happens — before the board is upserted, before a
      // name is settled — because a `--from` that is not there must fail naming the path it looked
      // for, with nothing created. It resolves against the board's REPOSITORY, never the cwd and
      // never a worktree: the same fence as a guide and a plugin grant (`src/templates.ts`).
      const tpl = values.from !== undefined ? readTemplate(scope.repoPath, given(values.from, '--from')) : null;
      // The BOARD's default workflow — how work on this board finishes (ADR-017 decision 1).
      //
      // Only when nobody said `--from`. With one, that workflow governs entirely: composing the two
      // would mean a workflow author could not write a step that finishes differently from the
      // board, and "the more specific thing wins" is the precedence rule everywhere else here.
      //
      // Not for a `--propose` Job either, and for the reason `withWorktree` exists in
      // `src/brief.ts`: a proposing Job's whole output is one JSON file, so a brief that also ends
      // in "commit it and open a pull request" is not an instruction a worker can follow. Measured
      // once already, on the protocol this replaces.
      //
      // Read from the BOARD row rather than from `scope`, because the row is where the default is,
      // and the board may not exist yet — filing the first Job in a repository creates it, and a
      // board that does not exist has no default to apply.
      let dflt: Template | null = null;
      if (!tpl && !values.propose && !values['no-isolate']) {
        const known = await db.board.findUnique({ where: { slug }, select: { defaultWorkflow: true } });
        const wanted = known?.defaultWorkflow?.trim();
        if (wanted) {
          // Refused HERE, by name, with nothing created — the same rule `--from` follows. A board
          // pointing at a workflow that is not in the repository is a mistake the operator can fix
          // in one command, and discovering it at claim time would mean a Job that is missing the
          // steps everything else on the board got.
          try {
            dflt = readTemplate(scope.repoPath, wanted);
          } catch (e) {
            throw usage(
              `board ${slug} files every Job with the workflow \`${wanted}\`, and ${(e as Error).message}`
              + ` Add the file, or point the board somewhere else: \`hkb boards set ${slug} --workflow <name>|none\`.`,
            );
          }
          // A default workflow's body is appended to somebody else's brief, so there is nothing for
          // a placeholder to be filled from — `--input` on the line belongs to the Job's own brief.
          // Refused rather than passed through, because the literal text `{{page}}` in a worker's
          // instructions is the one outcome nobody would have chosen.
          const want = placeholders(dflt.brief);
          if (want.length) {
            throw usage(
              `the workflow \`${dflt.name}\` is board ${slug}'s default, and its body refers to `
              + `${want.map((n) => `\`{{${n}}}\``).join(', ')} — standing steps are appended to every brief filed here, `
              + 'so there is nothing to fill them from. Write the steps without placeholders, or use it with '
              + `\`hkb new --from ${dflt.name}\`, where the Job can declare the inputs.`,
            );
          }
        }
      }
      // Whether the operator TYPED `--check`, read before the workflow fills the gaps below — after
      // the fill, `values.check` no longer says which of the two it came from.
      const checkTyped = values.check !== undefined;
      if (tpl) {
        // The whole precedence rule, and it is `src/spec.ts`'s grain: **the more specific value
        // wins**, so a flag the operator typed outranks the file. Written as "fill what is absent"
        // rather than as a merge, so a list flag REPLACES the workflow's list instead of appending
        // to it — a `--allow-tool` that could only widen a workflow's surface would be a grant
        // nobody could narrow.
        for (const [k, v] of Object.entries(tpl.spec)) {
          if ((values as Record<string, unknown>)[k] === undefined) (values as Record<string, unknown>)[k] = v;
        }
      }
      // The board's default fills the same gaps the same way — the line wins, then the file, then
      // the board's own `default*` columns, which `src/spec.ts` resolves later against whatever is
      // still null. Only the BODY composes differently (see `withStandingSteps`); the spec half is
      // `--from`'s rule exactly, because a default that could not be overridden on the line would be
      // a ceiling, and a ceiling is a different kind of fact.
      if (dflt) {
        for (const [k, v] of Object.entries(dflt.spec)) {
          if ((values as Record<string, unknown>)[k] === undefined) (values as Record<string, unknown>)[k] = v;
        }
      }
      // A workflow names itself, so `hkb new --from draft-wiki-page` is a whole command. A name
      // typed on the line still wins — it is the more specific value, exactly as a flag is.
      const name = rest.join(' ').trim() || tpl?.name || '';
      if (!name) throw usage('hkb new <name> — a Job needs a name');
      // A triage item is a note, and a note that demanded a brief would not get written down. The
      // name IS the brief until somebody decides what the work is, which is what `hkb queue` is for.
      const triage = !!values.triage;
      const wroteBrief = values.brief !== undefined || values['brief-file'] !== undefined;
      // The workflow's body is the brief; `--brief` still overrides it, on the same rule as every
      // other key. Ordered before the triage fallback so `--from` on a triage item is still briefed.
      const brief = tpl && !wroteBrief ? tpl.brief
        : triage && !wroteBrief ? name
        : await readBrief(values);
      const board = await db.board.upsert({
        where: { slug },
        update: {},
        // A board created by filing work in a repository is pointed at that repository. Without it
        // a machine-level daemon would have nowhere to cut the worktree.
        create: { slug, repoPath: scope.repoPath },
      });
      // Every one of these goes through `given`/`givenList` rather than a cast, and that is the
      // whole of closing the bare-flag idiom: a bare `--model` was stored as the boolean `true` and
      // a bare `--export` as the path `true`, because `parseArgs` under `strict: false` makes a
      // valueless option a boolean and a valueless REPEATABLE one a `[true]`. One flag at a time was
      // how this got fixed for `--check` and missed everywhere else.
      const model = values.model !== undefined ? (given(values.model, '--model') || null) : null;
      const effort = values.effort !== undefined ? given(values.effort, '--effort') : undefined;
      if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
        throw usage(`--effort must be one of ${EFFORTS.join('|')}, got ${effort}`);
      }
      // Checked here, at admission, rather than when the copy runs: an export path that escapes the
      // worktree is an illegal request, and an illegal request should never become state. The same
      // check runs again at copy time, because a row can arrive by other routes than this one.
      const exports = givenList(values.export, '--export').map(checkExportPath);
      // Checked at file time, before a worktree exists — a name that cannot be a filename or a JSON
      // key is a fault in the spec, and finding it here costs nothing while finding it later costs
      // a run.
      const results = givenList(values.result, '--result').map(checkResultName);
      // Same reasoning one medium over: a name that cannot be a single path segment is a fault in
      // the spec, and finding it here costs nothing while finding it after a run costs the run.
      const artifacts = givenList(values.artifact, '--artifact').map(checkArtifactName);
      // The same fence again, for the same reason: a label that is not `key=value` in plain tokens
      // is a fault in the spec, and a Job filed under a group nobody can name or select is worse
      // than a refusal — it is a Job that is quietly not in the group its filer thinks it is in.
      const labels = parseLabels(givenList(values.label, '--label'));
      // Checked at file time for the same reason an export path is: a grant is resolved into an
      // absolute path with no agent in the loop, so a path that was never legal must not become
      // state. Null when the flag was absent, so the board's grant can answer; an EMPTY list is
      // only reachable through `--plugin-dir ""` and means "grant this Job nothing".
      const pluginPaths = values['plugin-dir'] !== undefined
        ? givenList(values['plugin-dir'], '--plugin-dir').filter(Boolean).map(checkPluginPath)
        : null;
      // Checked at file time like every other declaration, and for the sharpest version of the same
      // reason: this one names a file the BOARD will read with the operator's authority and put in
      // front of a model. A source that was never legal must not become state.
      let inputs = givenList(values.input, '--input').map(checkInputSpec);
      // A workflow's placeholders, asked about here because `renderBrief` deliberately will not.
      // Interpolation is opt-in — a Job that declares no input is left alone, so that a brief written
      // before the feature existed still means what it says — and that opt-in is exactly wrong for a
      // workflow, whose author opted in by writing `{{page}}`. Without this the Job would be filed
      // with the literal text in its instructions and nothing would ever say so.
      if (tpl && !inputs.length) {
        const want = placeholders(brief);
        if (want.length) {
          throw usage(
            `the workflow \`${tpl.name}\` needs ${want.map((n) => `\`{{${n}}}\``).join(', ')}, and this Job declares no inputs`
            + ` — pass ${want.map((n) => `--input ${n}=value:…`).join(' ')}. Only \`value:\` inputs interpolate, because the`
            + ' brief is instruction and a fetched source reaches the run as data.',
          );
        }
      }
      // The brief is rendered HERE, against the `value:` inputs only, so what the board stores is
      // what the run is given — `hkb show` and the prompt cannot disagree. It applies to whichever
      // way the brief arrived: `--brief`, `--brief-file` or stdin all land in one string above.
      const supplied = new Map(
        inputs.filter((i): i is { name: string; value: string } => 'value' in i).map((i) => [i.name, i.value]),
      );
      const rendered = renderBrief(brief, supplied, new Set(inputs.map((i) => i.name)));
      // A value that went into the brief does not also arrive as a data block. Dropping it here
      // rather than remembering it keeps the run path with one rule: everything in `inputs` is
      // rendered, and nothing is rendered twice.
      inputs = inputs.filter((i) => !rendered.used.has(i.name));
      // The standing steps are NOT composed here, and that is the correction ADR-017's review forced.
      // What the board's default workflow contributes at file time is its FRONTMATTER — the spec
      // fields filled above — and nothing else. Its body reaches the worker at claim time, from the
      // board as it is then (`src/controller.ts`), for three reasons this verb cannot fix on its
      // own: `hkb queue <id> "…"` replaces a brief wholesale and would drop steps baked into it,
      // a `--no-isolate` Job has no branch for them to talk about, and they belong AFTER the sandbox
      // contract rather than before it. The refusals above still run here, where the operator is
      // standing: a board pointing at a workflow that is not in the repository is worth catching
      // before the Job exists, not on the pass that would have run it.
      const briefText = rendered.text;
      // A repo-relative path, checked at file time like every other declaration and for the same
      // reason as an input's: it names a file the BOARD will read with the operator's authority and
      // put in front of a model, so a path that was never legal must not become state. Undefined
      // when the flag is absent, so the board's grant answers.
      const guide = values.guide !== undefined ? (given(values.guide, '--guide') || null) : undefined;
      if (guide) checkExportPath(guide);
      // The completion check, stored verbatim. NOT validated beyond the two shapes that could never
      // have been meant, and that is the whole design: the controller reads 0 / not-0 and knows
      // nothing about what the command does (ADR-016 §3), so anything else hkb refused here would be
      // hkb having an opinion about a shell line it does not run and cannot parse. Undefined when
      // the flag is absent, so the board's default answers.
      const check = values.check !== undefined ? checkFlag(values.check) : undefined;
      let gate = values.gate !== undefined ? given(values.gate, '--gate') : undefined;
      // A PROPOSING Job has nothing to check. It changes nothing in the tree — its whole output is
      // `proposal.json`, read by the controller and applied only after a person approves it — so
      // there is no behaviour for a command to judge and no state for it to judge in. Worse than
      // useless: a failed check outranks the gate in `nextPhase`, so a red one (and on a proposing
      // Job every one is red, because the tree is unchanged) sent the Job round the retry loop
      // instead of suspending. Measured at the shipped defaults: three attempts, the same proposal
      // stored three times, and not one Job ever filed. The controller refuses to run it either;
      // this is the half that says so before the money is spent.
      if (values.propose && values.check !== undefined) {
        throw usage(
          'a proposing Job has nothing to check — its output is the proposal, not a change to the '
          + 'tree, so there is nothing for a command to judge. Drop the check '
          + (tpl?.spec.check !== undefined && !checkTyped
            ? `(\`check:\` in workflow ${tpl.name})`
            : '(--check)')
          + ', or drop --propose and file the work itself.',
        );
      }
      if (values.gate !== undefined && !gate) throw usage('--gate needs the question a human is being asked, as in --gate "does this migration look right?"');
      const rawBase = typeof values.base === 'string' ? values.base.trim() : undefined;
      if (values.base !== undefined && !rawBase) throw usage('--base needs the ref to branch from, as in --base origin/kb-33-1 — leave it out for the repository\'s default branch');
      // Checked here rather than only where git is called: a ref reaches git as a bare argv token,
      // so one beginning with a dash is an option (`--upload-pack=…` runs a command). See `validRef`.
      const base = rawBase === undefined ? undefined : checkRef(rawBase, '--base');
      // Two flags that mean opposite things, typed together: --no-isolate runs in the current
      // checkout, so there is no branch to cut from a base and nothing would ever read it. Refused
      // rather than ignored — a spec field that is stored, printed and never honoured is the silent
      // failure this project's fifth value forbids.
      //
      // A base arriving from the BOARD's default is deliberately NOT refused here. It is not a
      // contradiction the filer wrote, and refusing would make one `--no-isolate` Job unfileable on
      // such a board — there is no per-Job clear to escape with, and there cannot easily be one:
      // `pick` in `src/spec.ts` reads a null column as *unset*, so a cleared value falls straight
      // through to the board default again. That gap is shared by every board-defaulted field. What
      // is fixed instead is the visible half: `hkb show` does not present a base to a Job that
      // cannot use one.
      if (base && values['no-isolate']) {
        throw usage('--base and --no-isolate contradict each other: --no-isolate runs in the current checkout, so there is no branch to cut from a base. Drop one.');
      }
      // A proposing Job is a gated Job, and not by convention: ADR-011 applies nothing without an
      // approval, so a proposal with no approver would be a proposal nothing ever reads. The
      // operator's own question wins if they asked one; this is only the default, and the controller
      // replaces it with the count once a proposal has actually been validated.
      const proposes = values.propose ? 'jobs' : null;
      if (proposes && !gate) gate = 'a proposal to review';
      // Null when the flag was absent, so the board's default can answer. An EMPTY list is only
      // reachable through `--allow-tools ""`, and it means what it says: no tools at all.
      const allowedTools = values['allow-tool'] !== undefined
        ? givenList(values['allow-tool'], '--allow-tool').filter(Boolean)
        // `given`, never `String(...)`: a bare `--allow-tools` came back as the boolean `true` and
        // was filed as a tool surface of exactly one tool, named `true` — a Job allowed to call
        // nothing, which is the one narrowing that looks identical to a working one until it runs.
        : values['allow-tools'] !== undefined
          ? given(values['allow-tools'], '--allow-tools').split(',').map((t) => t.trim()).filter(Boolean)
          : null;
      const job = await db.job.create({
        data: {
          boardId: board.id, name, brief: briefText,
          // Null rather than `[]` for a Job that declares nothing: "produces no file" and "produced
          // none of the files it promised" are different facts, and only the second is a failure.
          ...(exports.length ? { exports } : {}),
          ...(results.length ? { results } : {}),
          ...(artifacts.length ? { artifacts } : {}),
          ...(inputs.length ? { inputs } : {}),
          // Null rather than `{}` for an unlabelled Job, on the same rule as every other Json?
          // column here: the absence of a value is what "nobody said" looks like.
          ...(Object.keys(labels).length ? { labels } : {}),
          ...(gate ? { gate } : {}),
          ...(guide !== undefined ? { guide } : {}),
          ...(check !== undefined ? { check } : {}),
          // The ref this Job branches from, or nothing. NOT resolved here: `hkb new` may be filing
          // the second step of a chain before the first has pushed the branch it names, and a
          // check at file time would refuse the one workflow the field exists for. It is checked
          // when the checkout is made, where a missing ref fails the Job by name (`src/controller.ts`).
          ...(base ? { base } : {}),
          ...(triage ? { phase: 'triage' as const } : {}),
          proposes,
          model,
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
        data: { kind: 'created', jobId: job.id, boardId: board.id, actor: whoami(), payload: { name, ...(triage ? { phase: 'triage' } : {}) } },
      });
      // RESOLVED, not the Job's own column. `check ?? null` printed nothing for a Job that
      // inherits the board's — which is the configuration the README recommends, and precisely the
      // "an attempt can fail on a command nobody printed" surprise this echo exists to prevent. The
      // board row is already in hand, so this costs nothing and reads like `hkb show`.
      const filedCheck = resolveSpec(job, board).check;
      emit(out, { id: job.id, name: job.name, phase: job.phase, board: slug, exports, results, artifacts, inputs, labels, proposes, check: jsonCheck(filedCheck, proposes), from: tpl?.name ?? null, standingSteps: dflt?.name ?? null }, () =>
        console.log(`#${job.id} ${job.name}  [${job.phase}]  on ${slug}`
          + (triage ? `  — noted, not queued. \`hkb queue ${job.id}\` when it is work` : '')
          // Named because the Job no longer remembers: a workflow is expanded at file time and gone,
          // so this line is the only place the two are ever seen together.
          + (tpl ? `\n  from workflow ${tpl.name}${tpl.description ? ` — ${tpl.description}` : ''}` : '')
          // Said out loud for the same reason: this brief is not only what was typed, and a worker
          // that is going to be told something the operator did not write should not be the first
          // to find out.
          + (dflt ? `\n  finishes with ${dflt.name}${dflt.description ? ` — ${dflt.description}` : ''}  [board ${slug}]` : '')
          + (exports.length ? `\n  must produce  ${exports.join(', ')}` : '')
          + (results.length ? `\n  must report   ${results.join(', ')}` : '')
          + (artifacts.length ? `\n  must hand over ${artifacts.join(', ')}` : '')
          + (inputs.length ? `\n  is given      ${inputs.map((i) => `${i.name}=${describeSource(i)}`).join(', ')}` : '')
          // Echoed back because a grouping nobody can see is a surprise — the same argument
          // `describeDefaults` makes for a board's defaults.
          + (Object.keys(labels).length ? `\n  labels        ${describeLabels(labels)}` : '')
          + (proposes ? `\n  proposes      Jobs — it writes \`${PROPOSAL_ARTIFACT}\` and waits for you to approve` : '')
          // Echoed for the same reason the declared outputs are: it is half the completion
          // condition, and a Job whose attempt can fail on a command nobody printed is a surprise.
          // Traced like every other resolved value: the command and where it came from. An
          // explicit opt-out is said out loud too — on a board WITH a default it is the more
          // surprising of the two, and silence there reads as "nobody configured anything".
          // Never for a proposing Job: it runs none, so naming the board's command here would
          // promise a judgement nobody is going to make. See `hkb show`, which says the same.
          + (proposes
            ? ''
            : filedCheck.value
              ? `\n  must pass     ${filedCheck.value}  [${filedCheck.from}]`
              : filedCheck.value === ''
                ? '\n  must pass     nothing — this Job opts out of the board\'s check'
                : '')));
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
      // Equality, ANDed, and parsed BEFORE the read: a malformed selector is a usage error, and an
      // empty listing is the one answer it must never give — that reads as "nothing matches".
      //
      // The filtering itself happens over the rows rather than in the `where`, because Prisma's
      // JSON filters are PostgreSQL and MySQL only and SQLite cannot ask the question in SQL. This
      // listing already reads its board in one query and shapes the rows in memory, so a selector
      // is a `filter` over a read that was happening anyway (`src/labels.ts`).
      const selector = parseLabels(givenList(values.label, '--label'));
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
        const labels = jobLabels(j.labels);
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
          pr, exports, results, artifacts, labels,
          producedNothing: producedNothing({ phase: j.phase, pr, exports, results, artifacts, proposes: j.proposes }),
        };
        // Filtered on the built row rather than before it: the row is where a label has already
        // been read defensively out of the column, and reading it twice to save shaping a handful
        // of rows nobody will print would be the more expensive kind of thrift.
      }).filter((r) => selects(r.labels, selector));
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
      const job = await db.job.findUnique({
        where: { id },
        include: { attempts: { orderBy: { k: 'asc' } }, lease: true, board: true },
      });
      if (!job) throw usage(`no Job #${id} — \`hkb ls\` shows what is on the board`);
      // What this Job will run with, and where each value came from. The raw columns are on the
      // object too, but most of them are null now, and a null `model` is not an answer to "which
      // model does this run on" — the board may have answered it.
      const spec = resolveSpec(job, job.board);
      // `check` is the resolved one here, overriding the raw column the spread carries — the same
      // object `hkb new --json` prints, so the two verbs cannot disagree about the command that
      // will judge this Job. See `jsonCheck`. Every other raw column is left as it is: they are
      // traced under `spec` alongside, and this is the one that was answering two ways.
      // Where this Job's standing steps will come from — the BOARD's default workflow, read now,
      // because that is when the controller reads it too. It used to be recovered from the stored
      // brief, which was a record of what the board's default was on the day the Job was filed; the
      // steps are composed at claim time now (`src/controller.ts`), so the honest answer to "what
      // will this Job be told" is the board's answer today.
      //
      // Null for a proposing Job and for a `--no-isolate` one, which are the two populations the
      // controller does not compose them for: printing a workflow name beside a Job that will never
      // see it is the kind of quiet disagreement this line exists to prevent.
      const steps = job.proposes || job.isolate === false ? null : (job.board?.defaultWorkflow?.trim() || null);
      emit(out, { ...job, check: jsonCheck(spec.check, job.proposes), spec, standingSteps: steps }, () => {
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
          // Where the branch starts. Printed with the traced spec rather than beside the pull
          // request, because it is a thing somebody CHOSE — and "why does this diff contain that
          // other Job's commits" is the question it answers.
          //
          // Omitted entirely for an un-isolated Job, which cuts no branch. A board's `defaultBase`
          // resolves onto every Job it carries, so this line otherwise told an operator that a Job
          // running in their own checkout branches from `origin/develop` — a fact about a checkout
          // that will never be made.
          ...(job.isolate
            ? [['base', spec.base.value ?? "(the repository's default branch)", spec.base.from] as [string, string, SpecSource]]
            : []),
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
          // An attempt in flight has no `endedAt`, and elapsed-so-far is exactly what you want to
          // know about one: the trailing `+` says the number is still climbing.
          const took = formatDuration((a.endedAt ?? new Date()).getTime() - a.startedAt.getTime())
            + (a.endedAt ? '' : '+');
          // 13, not 11: `check_failed` is twelve characters and overflowed the column, so the row
          // an operator is reading precisely because something went wrong was the one that lost its
          // alignment. The width is the longest Outcome plus the gutter.
          console.log(`  k=${a.k}      ${(a.outcome ?? 'running').padEnd(13)}${took.padStart(7)}${cost}  ${a.sessionId ?? '—'}`);
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
        // Not validated against the repository here, and deliberately. `boards set` may run on a
        // host that is not the one the daemon runs on, and a ref that does not exist YET is the
        // normal case for a board whose trunk is created by the work itself. The check is at claim
        // time, where the answer is about the checkout being made rather than about the string.
        if (values.base !== undefined) {
          const raw = given(values.base, '--base', `"${CLEAR}"`);
          if (!raw) throw usage(`--base was given nothing — pass a ref like origin/develop, or "${CLEAR}" to go back to the repository's default branch`);
          data.defaultBase = raw === CLEAR ? null : checkRef(raw, '--base');
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
            + ' --max-retries, --allow-tools, --default-plugin-dirs, --guide, --base, --check,'
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
      str('base', 'base', (v) => checkRef(v, '--base'));
      number('max-turns', 'maxTurns', (n) => Number.isInteger(n) && n >= 1, 'a whole number of turns, 1 or more');
      number('max-budget', 'maxBudgetUsd', (n) => n > 0, 'dollars above zero');
      number('max-retries', 'maxRetries', (n) => Number.isInteger(n) && n >= 0, 'a whole number of retries, 0 or more');
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
