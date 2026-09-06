# hkb — a workload scheduler for coding agents

File a Job, and one agent runs one brief to completion in a git worktree of its own, then opens a draft pull
request for a human to review. The board is a SQLite file on your machine. The runtime is the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). GitHub is the forge, not the board.

> ### ⚠️ Experimental — expect breaking changes
>
> hkb is under active development and is **not stable**. It is `0.x` and it means it: the schema, the CLI's
> verbs and flags, and the protocol between the controller and a worker all still change without notice.
>
> It is also built *with itself* — hkb's own work is filed as Jobs on an hkb board and written by workers hkb
> schedules — so the parts under construction move fast and land in large pieces.
>
> Practically: pin an exact version if you depend on one, and read the release notes before upgrading. Issues
> and questions are welcome; treat anything here as subject to change until this notice is gone.

## `hkb` — the workload scheduler

The first and only workload kind is a **Job**: one agent, one brief, run to completion. A Job runs in a git
worktree of its own, then commits, pushes and opens a **draft** pull request — a human reviews and merges.
The kanban DAG, cards that depend on cards, is a *second kind that does not exist yet*.

The board is **`~/.hkb/board.db`** — SQLite behind Prisma, one board per machine with a **Board row per
repository**, the way one cluster holds a namespace per project. It is created and migrated the first time
anything touches it. Commands take the board from the repository you are standing in; `--board <slug>` names
one instead, and `HKB_DATABASE_URL` points at a different board file entirely.

### Before you start

- **Node >= 22.18.0.** Measured, not guessed: 22.18.0 is the first release that strips TypeScript types
  without a flag, and a shebang cannot pass one.
- **The [GitHub CLI](https://cli.github.com)**, with `gh auth login` already done — a worker opens its own
  pull request with it, and hkb reads pull requests back through it.
- **A Claude Code login**, which is what the Agent SDK runs a worker on.

```bash
npm i -g hkb-cli        # or: npx hkb-cli --help
```

In a checkout it is `node bin/hkb.ts` — Node runs the TypeScript directly, so there is no build step.

### Quickstart

```bash
cd ~/code/my-project                       # the repository you are in decides which board you mean
hkb new "Add a --dry-run flag" \
  --brief "Add --dry-run to the export command, with a test. Keep it small."
#> #1 Add a --dry-run flag  [pending]  on my-project

hkb run                                    # reconcile once, in the foreground, watching it work
hkb show 1                                 # phase, spec, and every attempt: outcome, cost, session, PR URL
```

`--brief-file <path>` and `--brief -` (stdin) take a brief too long to type, and `--json` works on every verb.

### The verbs

| | |
|---|---|
| `hkb new <name>` | file a Job |
| `hkb ls` | what is on the board (`--all` for every board on the machine) |
| `hkb show <id>` | one screen: spec, phase, every attempt |
| `hkb run [<id>]` | reconcile once, in the foreground |
| `hkb retry <id>` | re-queue a Job that stopped, resuming its session |
| `hkb done <id> "<why>"` · `hkb cancel <id> "<why>"` | the two ends only a human can call |
| `hkb rm <id>` | delete a Job and its attempts |
| `hkb stop` · `hkb start` | the board's kill switch, and clearing it |
| `hkb up` · `hkb down` | the same reconcile pass on a timer, detached |
| `hkb log [<id>]` | what happened, in order |
| `hkb boards` | every board on this machine, and what each one may spend |
| `hkb version` | what this build is |

`hkb run` is the foreground tool — one reconcile, in this process, streaming what the worker does — and it is
the one to reach for when something is wrong, because everything it does is visible. **`hkb up`** is the same
pass on a timer in a detached process, serving every board on the machine; it exists for the work only a clock
can notice, not to make `hkb run` obsolete. `--interval <s>` changes the period, `--status` shows what is up
and what each board may still spend, and **`hkb down`** stops it cleanly, leaving no lease held.

To keep it alive across reboots, put `hkb up --foreground` under a supervisor:
[docs/wiki/howto/running-the-daemon.md](docs/wiki/howto/running-the-daemon.md).

`hkb ls` marks a succeeded Job that opened no pull request and declared no exports as **produced
nothing**, and counts them at the end of the listing. It is a statement, not an accusation — "I
looked, and there is nothing to change" is a real outcome, and so is a `--no-isolate` Job — but a
Job that left nothing behind should not read exactly like one that shipped a diff.

### Stopping for a human: `--gate`

A Job can be told to stop once it has produced what it declared, and wait:

```bash
hkb new "Migrate the sessions table" \
  --brief "Write the migration. Do not run it." \
  --result plan --gate "does this migration look right?"
```

It runs, produces its declared outputs, and goes **`suspended`** rather than finishing.
`hkb show` prints what it is waiting for and what it proposed. Then:

- **`hkb approve <id> ["…"]`** continues it **in the same session**, with your words as the prompt —
  so it applies what it proposed rather than proposing again. Anything you add is an instruction it
  is told to follow, because it is the more recent decision and it came from a person.
- **`hkb reject <id> "<why>"`** ends it, recording who decided and why.

The gate is **one-shot**: after an approval the Job finishes like any other. The approver need not be
you — a delegated agent or an auto-approve policy writes the same record, and `hkb log` shows which.

### Retrying, and the one retry that is not automatic

**`hkb retry <id>`** puts a Job that stopped back on the board, resuming its session. A Job that spent its
whole `--max-budget` is *not* retried automatically — the retry would get the same cap and stop in the same
place, at the same price — so this is where you raise it: `hkb retry 6 --max-budget 4`, and the raise is on the
event log.

**`hkb done`** and **`hkb cancel`** end a Job the machinery cannot end itself: one whose pull request was
reviewed and merged while it sat `pending` on a spent budget, or one nobody wants any more. Two verbs because
they are two different statements about the work; both take a reason, both record the person who made the call
as an Event, and both refuse a Job a worker currently holds (stop the daemon, or wait). Neither is `succeeded`,
which means the session completed, and neither is `hkb rm`, which deletes the record that any of it happened.

### Boards, ceilings and defaults

`hkb boards` lists every board on this machine; `hkb boards add <slug> --repo <path>` points one at a
repository.

`hkb boards set <slug>` carries the board's **ceilings** — `--max-concurrent` (0 drains it), `--daily-budget`
— *and* its **spec defaults**: `--model`, `--effort`, `--max-turns`, `--max-budget`, `--max-retries`. A board
that runs cheap, high-volume work says so once instead of on every `hkb new`.

Resolution is three-deep: the Job's own value wins, the board's default fills what the Job left unset, the
built-in is the last resort. `none` clears a default rather than setting it to the word, and `hkb show` names
which of the three answered each field. **A default is not a ceiling**: a Job may freely override `--model`,
and may not exceed `--daily-budget`.

The ceilings are checked before a claim and never during a run — a ceiling that could stop a running worker
would strand its worktree, while one that declines to start another is only a decision.

### What a Job produces

A pull request, by default — and a Job does not have to be coupled to one. Three declarations, one rule
([ADR-008](docs/wiki/decisions/adr-008-declared-outputs.md),
[ADR-011](docs/wiki/decisions/adr-011-proposals-not-board-access.md)):

- **`--export <path>`** — a file or directory the Job must write. The board copies it out of the worktree
  into the repository *before* the checkout is torn down.
- **`--result <name>`** — a named value the Job must report: a finding, a decision, a URL. The worker writes
  it to a path the board gives it, the board keeps it on the attempt, and `hkb show` prints it. Capped at
  4 KB each.
- **`--artifact <name>`** — a file the Job must produce that the **board** keeps rather than the repository.
  Same contract, no size limit, and the path the worker is given is outside every checkout — so an output
  that should not be committed is never in the tree to be committed by accident. A name may come back as a
  directory. `hkb show` lists what was kept, how big it is, and where.

The three differ only in *where the output goes*: `--export` to the repository, `--result` onto the board
as a value, `--artifact` beside the board as a file. All are repeatable, and **a declared output the run
did not produce fails the attempt** — which is what makes `succeeded` mean more than "the session ended".
An undeclared file left in the checkout is litter and is deleted with it.

Artifacts are **never removed**, because the file is the value — there is no row holding a copy. `hkb show`
prints the size of each for that reason.

A run may also **volunteer** a result or an artifact nobody asked for: anything it writes beside the
declared ones is kept and shown, and never required. The distinction is what is *enforced*, not what is stored — a declaration is
the filer saying "this must exist", and a volunteered value is the Job saying "you did not ask, but you
should know".

`--result` is how a Job **hands something on**, and it is orthogonal to whether the Job commits. Often it
sits alongside a pull request: `--result prUrl` gives whoever reads this Job next a typed value instead of
prose to parse. It is also the only output a Job with no commit to make has — *"I looked, and there is
nothing to change"* is a real outcome, and without somewhere to put it such a Job succeeds and leaves only
a session id.

### What a Job is given

The other direction. **`--input <name>=<source>`** is content the board resolves *before* the run and puts
in the prompt, ahead of the brief that is about it. Three sources, and none of them waits:

- **`file:<path>`** — a file in the repository, read from the board's repo rather than the worktree.
- **`board`** — this board's other Jobs, their phases, attempt counts and outcomes. LLM-free, one read.
- **`value:<literal>`** — a payload the caller supplies. The other two are things hkb goes and *fetches*;
  this is the one a webhook, a button or a controller filing work can *push*.

A `value:` input may also be **interpolated into the brief**, as `{{name}}` or `{{name.field}}`, whichever
way the brief arrived — `--brief`, `--brief-file` or stdin:

```sh
hkb new "review a PR" \
  --brief 'Review PR {{pr.number}} in {{pr.repo}} with a {{style}} eye.' \
  --input 'pr=value:{"number":42,"repo":"example"}' \
  --input style=value:strict
```

The brief is rendered **when the Job is filed**, so what `hkb show` prints is what the run is given, and
a placeholder naming nothing is refused where the operator is standing rather than discovered by a
worker. A value that went into the brief is not also handed over as a data block.

Only `value:` interpolates. A `file:` or `board:` source reaches the run as *data* and never as
*instruction* — otherwise a file in the repository would decide what the agent is told to do. It is the
line Kubernetes draws when it lets `envFrom` fill `env` and never `command`.

An input the board cannot read ends the attempt at `no_input` **without calling the model** — the cheap
mirror of a missing declared output. A source that names another Job's output is refused: that is an
ordering edge, and ordering between workloads belongs to a kind whose controller creates them.

The point is not convenience, it is **restriction**. Content in a prompt restrains nothing by itself — a
worker with `Read` finds whatever it likes. Pair `--input` with an `--allow-tool` list that leaves out
`Read`, `Glob` and `Grep` and the Job sees exactly what it was given, because the admission gate refuses
the rest. Neither half is the feature; the pair is.

`--no-isolate` runs the Job in the current checkout rather than a worktree of its own, for work that has no
business on a branch.

`--allow-tool <name>` (repeatable, or `--allow-tools Read,Grep`) narrows the tool surface a Job may use.
This is a **ceiling the board enforces, not a request**: anything absent is denied in a `PreToolUse` hook
that runs before every other permission rule, so a Job given `Read` and `Grep` *cannot* write, whatever its
brief says. Without it, the runtime's own default applies. `hkb boards set <slug> --allow-tools …` sets the
default for Jobs that name none — a default a Job may still widen, unlike `--daily-budget`, which it cannot
exceed.

`--plugin-dir <path>` (repeatable, or `hkb boards set <slug> --default-plugin-dirs .claude` for a whole
board) grants a Job a directory whose **skills** it may see — usually `.claude`. Without it a worker sees
none of the skills the repository carries, and rebuilds that knowledge from training data. This is the
other half of least privilege and it points the other way: `--allow-tool` narrows what a worker may *do*,
`--plugin-dir` widens what it may *read*, and neither touches the other — the admission gate still denies
every tool a granted skill might suggest.

Two properties worth knowing ([ADR-012](docs/wiki/decisions/adr-012-skills-by-grant-not-by-settings.md)).
hkb **never loads a repository's settings** — `.claude/settings.json` hooks are shell commands the
repository author wrote, and running them is executing the repository rather than reading it; the grant
reaches the same skills without them. And a grant resolves against the board's **repository**, never the
worktree, so changing what it loads takes a merge — which matters because the thing writing to the
repository is the worker.

### Isolation, and the file the tests need

A worktree is a fresh checkout of a commit, so two things are true of it and both matter: uncommitted work in
your tree is invisible inside it, and **gitignored files do not come across**. A repository whose tests need a
gitignored `.env` therefore passes for you and fails in a worker. Declare what to carry across in
`.worktreeinclude` — [docs/wiki/features/worktree-includes.md](docs/wiki/features/worktree-includes.md).

Worktrees are expensive (a worker installs the target repository's dependency tree to run its tests), so they
are reclaimed by a sweep on the daemon's tick rather than at the end of a run: "safe to delete" is a state a
worktree enters later, when its pull request lands.

### How it maps

If you know Kubernetes, the shape is deliberate:

| hkb | Kubernetes |
|---|---|
| Job | Job |
| Attempt | Pod |
| Lease | Lease |
| Board | Namespace |
| `Controller` row | leader election |
| `hkb up` | a resync loop, not a watch |

The controller is **level-triggered**: it reads observed state, compares it to desired state and takes one
step. It is safe to run repeatedly, to interrupt, and to run while another host runs it. Nothing depends on
having seen an event. hkb fuses the controller-manager and the kubelet — it executes the work inline rather
than scheduling it onto a node.

### Local state

- `~/.hkb/board.db` — the board. Back it up by copying the file.
- `~/.hkb/hkb-<board>.log` — what a detached `hkb up` wrote.
- `<repo>/.hkb/worktrees/` — per-attempt checkouts. Gitignored; contents are branches, not files to track.

## Docs

- [docs/wiki/](docs/wiki/index.md) — the code-derived wiki. Start at the index.
- [ADR-007](docs/wiki/decisions/adr-007-workload-scheduler.md) — why hkb is a workload scheduler, and what it
  stopped being.
- [ADR-008](docs/wiki/decisions/adr-008-declared-outputs.md) — a Job declares its outputs.
- [docs/rebuild-plan.md](docs/rebuild-plan.md) — the plan of record, and what is next.
- [docs/releasing.md](docs/releasing.md) — publishing is a tag.

## License

MIT
