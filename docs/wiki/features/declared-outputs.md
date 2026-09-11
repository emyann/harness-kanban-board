---
title: Declared outputs — export, result, artifact
summary: "The three declared outputs and the one rule over them: --export to the repository, --result onto the board as a value, --artifact beside the board as a file; why an undeclared output is litter, and the syntax each refuses before a checkout is ever made."
category: features
kind: explanation
audience: [dev]
read_when: "adding or changing an output kind, asking what a Job is supposed to produce, touching the collection block at the end of a run, or wondering why a succeeded Job failed with no_output"
covers:
  - path: src/results.ts
    sha: a67f369f7e0806ea8fe10d6def7105ff2a65e131
  - path: src/artifacts.ts
    sha: 74efd4d0fc9f6f0e5bcce4379b55f533b81e9e6d
  - path: src/controller.ts
    sha: a50ac9ee35132bd67b57bb593e9771bd851fe741
  - path: src/exports.ts
    sha: afa23e85d0df61d1d0d91587d425df2ad7a872a0
  - path: src/read.ts
    sha: 6225a35a96f1896a1457385bda9eb9d0868490c0
  - path: src/brief.ts
    sha: b3eddf6aebd95fdab1f38424b24851d6a4e3e5a2
  - path: src/hkb.ts
    sha: eb759e566ef71b11caa34cc0945a6e2ae30958cf
  - path: src/db-url.ts
    sha: 075e55c592c972b3505f106ac670a277996f0615
  - path: prisma/schema.prisma
    sha: 364793f9a1174875c3bf644257b6d0cbdf94d25e
generated_at_commit: ebf564a
last_refreshed: 2026-09-10
related: [decisions/adr-008-declared-outputs, decisions/adr-011-proposals-not-board-access, decisions/adr-018-the-boundary, features/proposals, features/workflow-templates, architecture/job-kind, architecture/the-board]
---

# Declared outputs — export, result, artifact

> A Job says in advance what it will produce, and the board is responsible for getting
> that out of the sandbox. Everything else the run leaves behind is litter. Three
> destinations implement the rule — the repository, the board's own row, and a directory
> beside the board — and the interesting parts are the ones a `--help` will not tell you:
> why the shapes differ, why the small one is capped on purpose, and why all three names
> are refused before a workspace is ever cut.

## The rule, and what it costs

The declaration is the contract: a declared output that is not produced **fails the
attempt** (`prisma/schema.prisma:313-318`, `src/controller.ts:1530-1594`). That single rule
is what the three mechanisms exist to serve, and it is what makes `succeeded` mean more
than "a session ended" — the collection block runs after `nextPhase` has already decided
the run went fine, and can still overturn it (`src/controller.ts:1797-1810`).

What it buys is twofold. The workspace becomes disposable: once the declared outputs are
out, whatever is left in it is by definition undeclared, which is the one case where a dirty
tree is not evidence of work worth keeping — and it is what lets the sweep be a TTL over names
rather than a heuristic that inspects trees (`src/workspaces.ts:119-170`,
`howto/running-the-daemon`). And absence becomes legible — a Job that produced
nothing is a fact the board can state rather than a silence an operator has to notice.

What it costs is stated where the cost lands: filing a Job now carries a decision it did
not before (what should this produce?), and the set of output kinds is closed, so
extending it is a code change on purpose rather than a per-Job schema a model can satisfy
by assertion (`docs/wiki/decisions/adr-008-declared-outputs.md`).

## Three destinations, one range

They are not a list of options. They are three points on a range whose axis is *who keeps
the thing and how big it is*:

- **Export** — a repository-relative path the run wrote inside its workspace, copied out
  into `Board.repoPath` before the workspace is collected (`src/exports.ts:103-191`). The
  repository keeps it, which means git keeps it, which means it will be committed.
- **Result** — a small named value the board keeps on the attempt row as a JSON object
  (`prisma/schema.prisma:578`). Capped per value (below).
- **Artifact** — a file kept in a directory beside the board, uncapped; only its catalogue
  — name, kind, size — goes onto the row (`prisma/schema.prisma:609`,
  `src/artifacts.ts:121-150`).

The framing that matters, and the one the module states in its own words: **an artifact is
a big result, not an uncommitted export** (`src/artifacts.ts:6-33`). Between a 4 KB value
and a path the repository commits there was a gap — an output too large to be a result and
with no business in a commit at all — and an artifact fills it from the *result* end.

The rejected alternative is worth knowing because it reads so much cheaper than it is:
give `exports` a second destination. The copy already takes one (`exportOutputs(from, to,
declared)`, `src/exports.ts:103`), so it looks like a call-site change. It is the wrong
shape. An output that must not be committed should never be *inside* the checkout in the
first place, where it is either committed by accident or shows up as untracked noise in
every `git status` a reviewer runs — the argument `resultsDir` already makes for results
(`src/results.ts:63-73`) and `artifacts.ts` reuses verbatim (`src/artifacts.ts:23-28`).
Writing to an absolute path outside every checkout has no copy step to get wrong.

## Why the cap is the feature

`RESULT_MAX_BYTES` is 4096, **per result** (`src/results.ts:24-32`). The number is
inherited from Tekton, whose 4096 is across all of a Task's results because it rides the
Kubernetes container termination message. hkb is not squeezing through that channel, so
the constraint is per value and kept anyway — deliberately, because it is small enough
that nobody mistakes a result for file storage. A handoff that can hold a megabyte becomes
a worse artifact store than the one `exports` already is; that is the failure the cap
prevents, and routing around it reinvents it.

Which makes an oversized result a spec mistake with an obvious remedy rather than a
workaround: the value is **dropped rather than truncated**, reported as its own cause, and
the operator is told in the same sentence where it belonged (`src/results.ts:138`,
`src/results.ts:158-169`). An oversized declared value is a shortfall too, and reported as
oversize rather than silently as missing (`src/results.ts:144-147`).

An artifact has no cap and the prompt says so out loud — leaving it implicit would invite
a worker to summarise something it was asked to hand over whole (`src/brief.ts:68-99`).

## The refusals, and when they fire

All three names are checked at **declaration time**, in `hkb new`, before any workspace
exists (`createJob`, `src/filing.ts:239-246`). An illegal request should never become state, and finding
the fault at file time costs nothing while finding it at collection time costs a whole
run. The export check runs a second time at copy time, because a row can arrive by routes
other than the CLI (`src/exports.ts:115`).

The three fences differ because the three names name different kinds of place:

- A **result name** must be a plain identifier — letters, digits, dash, underscore, ≤64
  characters (`src/results.ts:46-61`). It becomes two things at once: a filename the worker
  is told to write, and a key on the JSON object the board stores. Anything that could
  traverse a directory or collide as a key is refused.
- An **artifact name** is one path segment, with dots permitted *between* segments of word
  characters (`src/artifacts.ts:49-67`). Dots are allowed where a result refuses them
  because an artifact is a file somebody opens — `report.md`, `plan.json` — and the same
  rule that admits them refuses `..` and `.hidden`. It admits no separators at all, which
  is the cheap fence: the name is a destination resolved against a per-attempt directory
  that starts empty, so there is nothing to collide with and nothing to overwrite. A
  declared name may also come back as a **directory**, which is how one artifact holds more
  than one file without needing a path syntax (`src/artifacts.ts:139`).
- An **export path** is the only one that has to police anything, and it polices a lot:
  absolute paths, `..` escapes, `.` naming the whole checkout, and the two directories that
  are not outputs — `.hkb/`, where the board file lives, and `.git/`, which in a worktree is
  a *file* pointing at the admin directory and whose copy would break a checkout in a way
  nobody would connect back to an export declaration (`src/exports.ts:38-67`). The asymmetry
  is the point: an export names somewhere inside a tree that already has contents, and the
  copy happens with the operator's authority and no agent in the loop.

## Collection, and the asymmetry in it

Before the run, the controller builds a path per declared name and creates both collection
directories — always, even when nothing was declared, because a run may volunteer
something (`src/controller.ts:1106-1126`). Those paths go into the prompt as **absolute**
paths, and the worker is told plainly that they are outside its checkout and will not
appear in its diff (`src/brief.ts:68-130`, `src/results.ts:82-86`,
`src/artifacts.ts:91-95`). Nothing is parsed out of a transcript and nothing arrives by
tool call: the worker writes files, the controller reads the directory.

At the end of a run, all three are collected under the same two gates — the attempt
otherwise succeeded, and the holder kept its lease to the end (`src/controller.ts:1530`,
`:1462`, `:1488`). A crashed or capped attempt has not finished the work, so half its
outputs being absent describes the stop it already reported rather than a second finding.
Exports resolve in two passes — plan everything, then copy — so a shortfall never leaves
half a failed run's output mixed into the repository (`src/exports.ts:114-135`).

**And the two passes are split across the completion check**, which is where that same rule
had a hole in it. Asking whether the declared paths are *there* happens early
(`exportOutputs(..., { copy: false })`, `src/controller.ts:1537`), because a missing declared
output is the cheaper cause and has to keep outranking a check that would spend ten minutes finding
a second one. **Copying** them into `Board.repoPath` happens after the check
(`src/controller.ts:1740-1746`) — it used to run about 150 lines earlier, so an attempt the check
went on to *refuse* had already written its files into the operator's repository, which is exactly
what this rule forbids one step out (`features/check`). Nothing is lost by waiting: a refused check
keeps its workspace, and the files are still in it.

**The copy is gated on the check and on nothing else that failed**, and that qualification is the
correction to the move rather than a footnote on it. Carrying the whole `!shortfall` condition
down with the copy quietly changed the shipped-default rule: an export that *was* present stopped
being delivered because a different declared output was missing. (The sharpest case of that was a
conflicted rebase, which is not resumable, so nothing ever delivered it — ADR-018 deleted the
rebase, and `conflicted` has since gone from the `Outcome` enum entirely rather than merely losing
its writer, so the hazard reads as history rather than as a live one.) The principle survives it: what an attempt produced is a durable record of what
happened and is worth keeping whether or not its diff still applies. Copy what is present; let the shortfall be the shortfall; only a check that **refused**
withholds the copy. A stop that lands mid-check copies too — the run finished and produced what
it promised, no verdict was given either way, and recording `exported: []` about files the probe
had just seen was the alternative.

Then the honest asymmetry. A result's **value is read back** — `readFileSync`, trimmed,
onto the row (`src/results.ts:139`). An artifact's is not: `collectArtifacts` stats,
classifies and sizes, and never opens anything (`src/artifacts.ts:109-150`). Reading an
artifact in merely to record that it exists would give back the cap by another route,
which is the one thing an artifact exists not to have. So the row gets a catalogue and the
file stays where the worker put it.

That asymmetry propagates to lifetime. The results directory is removed unconditionally
when the attempt ends, success or failure, because the values are durable by being on the
row rather than by the file surviving (`src/controller.ts:1571`,
`src/results.ts:152-155`). The artifacts directory is removed **only if it is empty** —
`rmdir` refusing a non-empty directory is exactly the test that needs making — because an
artifact's value *is* the file, so nothing else holds it (`src/artifacts.ts:177-189`,
`src/controller.ts:1594`). Nothing removes a non-empty one at all, which is why the
size is walked and recorded: it is the only warning an operator gets that a board is
filling up (`src/artifacts.ts:152-175`), and `hkb show` prints both the sizes and the
directory, since an artifact is the one output whose location a human has to be told
(`src/hkb.ts:1000`).

Both collection directories live under the board's own directory —
`boardDir()/results/<jobId>-<k>` and `boardDir()/artifacts/<jobId>-<k>`
(`src/results.ts:72-73`, `src/artifacts.ts:81-82`), where `boardDir()` is the directory
holding the board file the connection URL names (`src/db-url.ts:26-29`). Not a hardcoded
path: a board reached through `HKB_DATABASE_URL` collects beside itself.

### Two layers: declared and volunteered

Both collectors read their directory **whole** and enforce only the declared half. A
declared name is the filer's requirement and its absence fails the attempt; anything else
the run left is *volunteered* — kept, reported, never required (`src/results.ts:99-150`,
`src/artifacts.ts:109-150`). A volunteered name still has to pass the same syntax fence,
and one that does not is ignored rather than made to fail somebody else's attempt
(`src/results.ts:135`, `src/artifacts.ts:135`). The reasoning is in `collectResults`'
docblock: requiring everything means a Job cannot report something nobody thought to ask
about, and requiring nothing (freeform handoff metadata) guarantees a downstream reader
nothing at all.

## The absence signal

Two different things get called "produced nothing", and they are worth keeping apart.

**A declared output that did not arrive** ends the attempt as `no_output`, not resumable,
with the shortfall message as `lastError` and as the attempt's `reason`
(`src/controller.ts:1810`, `:1767`). It outranks the gate: a run that did not produce
what it promised has nothing worth approving (`src/controller.ts:1797-1812`). Only the
first cause found is reported — export shortfall, then result, then artifact — because two
concatenated shortfalls read worse than one and mean the same thing
(`src/controller.ts:1560`, `:1494`). The messages are written for the person who
has to decide whose mistake it was, which is why they name the value and the remedy rather
than a code (`src/results.ts:158-169`, `src/artifacts.ts:209-215`).

**A Job that succeeded having declared nothing** is the other case, and it is not a
failure. `producedNothing` is a pure predicate over a Job's already known fields — phase, the
three declaration columns, and whether it proposes (`producedNothing`, `src/read.ts:68-83`).
It re-checks nothing, because a Job that reached
`succeeded` having declared any of the three produced it by construction — the collection
block would have failed it otherwise. Being pure is what lets it be tested exhaustively as
a *refusal*: the test enumerates every kind of thing that counts as having left something
behind and asserts each one turns the answer off (`test/hkb.test.ts`, `producedNothing`).
`hkb ls` renders it as a suffix on the row and one summary line, stated and not judged —
"I looked and there is nothing to change" is a real outcome; what is not acceptable is
that it reads exactly like a Job that shipped something (`src/hkb.ts:809-812`).

**A pull request used to count, and ADR-018 stopped it counting.** `Attempt.prUrl` and
`Attempt.prNumber` are gone with the forge read, so the question would have had one answer for
every Job on the board. What replaced it is the honest version and it is ADR-008's own list: a Job
whose deliverable really *is* a pull request declares an output that carries it — a `--result`
holding the URL, say — and that declaration is what the board counts. A branch-name lookup on a
forge speaking for a Job's worth was always the weaker question (`src/read.ts:44-66`).

## The gap that closed: nothing in the core implies a pull request any more

ADR-008 decided that `isolate` returns to meaning one thing — *where* the work runs — and
that the pull-request protocol becomes one declarable output shape among several, selected
by the spec rather than implied by having a worktree
(`docs/wiki/decisions/adr-008-declared-outputs.md`). It stayed open through several
releases: the prompt was assembled as *if there is a worktree, append the protocol* —
commit, push, open a draft PR, "work that is not pushed is work that is lost" — so an
isolated Job whose entire deliverable was a `--result` or an `--artifact` was told to push
work it did not have, on top of a contract telling it to write somewhere outside the
checkout.

ADR-017 decision 5 closed most of it from the other end, by removal rather than by a
switch: the core kept only the **sandbox contract** — commit on your branch, rebase onto your
base, push that branch and nothing else — and said nothing about a forge, a pull request or a
review.

**ADR-018 closed the rest, and it closed it by deleting the contract too.** The test for a line
belonging in the core was always whether the machinery made it true afterwards; the core no longer
rebases, no longer reads pushed state and installs no `pre-push` hook, so none of those lines could
be said. `src/brief.ts` now appends only what is still paired with a refusal — the inputs, the
declared outputs, the check, the guide, the standing rules, the gate and the proposal contract —
and **every git instruction a worker gets is content**, in the workflow file
(`.hkb/workflows/implement.md`, `features/workflow-templates`).

So the gap is closed in the direction ADR-008 wanted, and the remaining question is purely a
content one: a board whose default workflow says "commit, push, open a pull request" appends that
to a result-only Job filed on it too. The board-level answers are `--from` (which suppresses the
default), `--no-isolate` and `--propose` (which the CLI excludes from the default workflow
outright).

## Related

- [ADR-008: A Job declares its outputs](../decisions/adr-008-declared-outputs.md) — the decision, and the annex on what has since been settled
- [ADR-011: Proposals, not board access](../decisions/adr-011-proposals-not-board-access.md) — the record that needed a third output kind
- [features/proposals](proposals.md) — a proposal rides the artifact channel under a name the controller fixes
- [features/workflow-templates](workflow-templates.md) — where the git protocol lives now, and why it is content
- [architecture/the-board](../architecture/the-board.md) — the columns these declarations and catalogues live in
