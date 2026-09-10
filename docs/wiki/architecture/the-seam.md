---
title: The seam — filing and reading, out of the CLI's switch
summary: "ADR-015's test asked whether a web board could be built without touching src/hkb.ts. Transitions moved first; this is the other two answers — createJob, and the three read-model functions whose returned object IS what --json prints. Why the input is flag-shaped, why the renderers stayed behind, and what is still in the switch."
category: architecture
kind: explanation
audience: [dev]
read_when: "building a second consumer, adding a verb that files or reads a Job, or wondering why a module takes `max-budget` rather than `maxBudgetUsd`"
covers:
  - path: src/filing.ts
    sha: a3c67c49d8fc5b46e0caac0894bc52d10ca22a17
  - path: src/read.ts
    sha: 6225a35a96f1896a1457385bda9eb9d0868490c0
  - path: src/flags.ts
    sha: 7140df95e7457ce3f2ed4fe3fe38e19476728dd1
  - path: src/hkb.ts
    sha: eb759e566ef71b11caa34cc0945a6e2ae30958cf
  - path: src/spec.ts
    sha: a83486dc8471b6e0358af03bafba75fa363c4032
related:
  [
    architecture/transitions,
    decisions/adr-015-machinery-and-consumer,
    features/workflow-templates,
    gotchas/argv-traps,
    architecture/the-board,
  ]
generated_at_commit: 2b8902f
last_refreshed: 2026-09-10
---

# The seam — filing and reading, out of the CLI's switch

> ADR-015's test: *"Could a web board be built without touching `src/hkb.ts`?"* Three answers were
> needed. *architecture/transitions* moved the first — a Job's phase. This page is the other two:
> **filing** a Job (`src/filing.ts`) and **reading** the board (`src/read.ts`).

## What moved, and what a verb is now

| question | module | the verb that calls it |
|---|---|---|
| file a Job | `createJob` — `src/filing.ts` | `hkb new` |
| every board on this machine | `boardSummaries` / `boardSummary` — `src/read.ts` | `hkb boards` |
| what is on a board | `listJobs` — `src/read.ts` | `hkb ls` |
| one Job, whole | `showJob` — `src/read.ts` | `hkb show` |
| a flag's value, from argv **or a file** | `given`, `givenList`, `num`, `seconds`, `checkFlag` — `src/flags.ts` | all of the above, and `hkb job set` / `hkb boards set` |

A verb is now three statements: parse argv, call one of these, print. `src/hkb.ts` contains no
`db.job.create` and no `db.job.findMany`, and `test/filing.test.ts` and `test/read.test.ts` each
grep for their half — a weak test of a strong rule, and the one that catches the next verb written
back into the switch.

## Filing: the input is flag-shaped, and that is load-bearing

`createJob(db, scope, spec, { by })` takes `spec` keyed by **`hkb new`'s flags without the
dashes** — `max-budget`, `allow-tool`, `plugin-dir`. That reads at first like the CLI leaking into a
module, and it is the opposite: it is the vocabulary this project already committed to three times.
A workflow file's frontmatter keys are those names (`src/templates.ts`, `TEMPLATE_KEYS`), `hkb job
set` takes the same ones (`src/job-spec.ts`), and `hkb --help` is the reference for all three at
once and so cannot drift from any.

The consequence is the one thing an extraction here could most easily break. A workflow **fills what
the caller did not say**, and the fill happens *before* any value is converted (`src/filing.ts`), so
a `max-budget: 2` from a file and a `--max-budget 2` from a line go through the same parse, the same
refusal and the same message. Converting first and merging after would be two code paths for one
vocabulary — which is exactly how a workflow ends up accepting something no operator could type.

A second consumer therefore posts the same object a workflow is, which is the same object a command
line is.

**Precedence, in one sentence:** the caller's value wins, then `--from <workflow>`'s frontmatter,
then the board's default workflow's frontmatter, then the board's own `default*` columns
(`resolveSpec`, `src/spec.ts`), then the built-in. Written as *fill what is absent* rather than as a
merge, so a list REPLACES rather than appends — a `--allow-tool` that could only widen a workflow's
surface would be a grant nobody could narrow.

### The brief is a producer, not a string

`spec.brief` may be `() => Promise<string>`, because `--brief -` blocks until EOF on stdin. Reading
it before the guards turns `hkb new x --from typo --brief -` from an instant refusal into a process
that never returns. Same shape and same reason as `queueJob` and `setJobSpec`.

**The CLI does not always pass one**, and that is load-bearing rather than an omission: `hkb new`
passes `brief: undefined` unless `--brief` or `--brief-file` was given (`src/hkb.ts`), which is what
lets `createJob` fall through to a workflow's body or a triage note's own name. `throwNoBrief` is
the reachable end of that chain, not dead code.

The read happens **immediately before the two side effects** — the board upsert and the Job insert —
so every refusal that can be made without it is. It did not always: the producer and the upsert both
ran above the declaration guards, so `hkb new x --brief - --export ../outside.md` blocked on stdin
for a refusal that needed nothing from stdin, and a refused filing left a `Board` row behind. One
refusal legitimately follows the read and cannot be hoisted — a workflow's unfilled `{{placeholder}}`
is a fact about text nobody has read yet.

### What stayed in the verb

Reading argv (`parseArgs`, `OPTIONS`, `strayWords`, `unknownFlags` — see *gotchas/argv-traps*),
reading a brief off stdin or a file, and printing. Everything between *the arguments are parsed* and
*the row is printed* is the module: the workflow read, every declaration and its refusal by name,
the proposing-Job rules, the check cap, the row and the `created` Event.

## Reading: the returned object IS what `--json` prints

Not "a shape the verb then maps to `--json`" — the same object, emitted verbatim
(`emit(out, rows, …)` in `src/hkb.ts`). That is the whole discipline: there is nothing in between
for the two surfaces to drift across.

They have drifted before, which is why the rule is stated rather than assumed. `hkb new --json`
printed the *resolved* check and `hkb show --json` printed the Job's raw column, so the same Job
answered `"npm test"` to one verb and `null` to the other. `jsonCheck` now lives in `src/spec.ts`,
beside the resolution it formats, and both callers use it.

What the read model carries that a raw row does not:

- **the resolved spec, with each field's source** — `showJob` returns `spec` from `resolveSpec`, so
  a null `model` column becomes `{ value: 'opus', from: 'board' }`. A consumer reading the row alone
  would print nulls and be wrong in the direction that costs money.
- **`producedNothing`** — a `succeeded` Job with no declared export, result or artifact. A pull
  request used to count and no longer does: the core stopped reading the forge, so `Attempt.prUrl`
  had no writer left and the question would have had one answer for every Job on the board
  (*decisions/adr-018-the-boundary*, `src/read.ts`). A Job whose deliverable really is a pull
  request says so by declaring what it hands back — a URL in a result, a file in an artifact.
  Stated, never judged: "I looked, and there is nothing to change" is a real outcome, and
  a proposer is excluded because rows on the board *are* its output.
- **every phase counted** — `boardSummaries` counts all eight, `triage` and `suspended` included,
  even though the CLI's table has no column for those two. A read model that answered six of the
  eight would send a consumer back to SQL for the rest, which is the re-deriving the module exists
  to stop. Giving them a column in the table and in `hkb up --status` is a separate change.

**The renderers stayed in the verb.** `formatDuration`, `describeDefaults`, the column widths, the
attempt tails — those are a terminal's opinion about a screen, and a web board wants none of them.

## `src/flags.ts`: why a third module

`given` and its siblings were written next to the `switch` that consumed them, which was right while
the CLI was the only thing that ever held a flag. It stopped being true when a workflow file's keys
became those flags: the same values now arrive from a file with nothing resembling argv near them,
so `createJob` cannot live downstream of the parser without dragging the parser along.

Every refusal in that module is a bug this project shipped — a bare `--check` filed as the shell
command `true` and "passed" by every attempt, a bare `--export` declaring an output called `true`,
`--check --json` filing a flag as a command. `parseArgs` runs with `strict: false`, where a bare
option is the **boolean** `true` and a bare repeatable one is `[true]`, so `String(...)` is the
whole bug. `test/flags.test.ts` is pure and tests the refusing case.

## What is still in the switch

- **Board operations** — `boards add`, `boards set`, `boards rm`, `stop`, `start`. A different
  object's lifecycle; they should move on the same rule when next touched.
- **`hkb log` and `hkb watch`** — the event stream rather than the board's state, and `src/watch.ts`
  already owns that seam.
- **`hkb run` / `hkb up` / `hkb down`** — the controller and the daemon, which are modules already;
  the verbs wire signals and print.

So the honest status of ADR-015's test: a second consumer can now file a Job, drive it through its
whole life, edit its spec, and read every board, listing and Job page — without touching
`src/hkb.ts`. What it cannot yet do is create or configure a **board**.

## How the tests changed, and what that shows

`test/filing.test.ts` and `test/read.test.ts` call these directly: **no CLI, no argv**, and for
filing not even a repository unless the case is about a workflow. The existing CLI tests were not
changed at all — that is the no-behaviour-change claim checked against a suite that already
exercised every one of these end to end, and it is the same evidence *architecture/transitions*
offered for the first extraction.
