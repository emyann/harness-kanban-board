# Local-first hkb — the plan

> The reference every card of tracks A, B and C points at. Decided on 2026-09-02 after a design study
> (its measurements are in §11). ADR-005 and ADR-006 in `docs/wiki/decisions/` record the decisions;
> this file carries the design a worker needs to execute one node of the plan without having read the
> study. Sections are numbered so a card can say "§6.3" and mean one thing.

## 1. What was decided

1. **Vocabulary is plain**: `hkb start | pause | resume | stop [<n>] [--all]`. The Kubernetes words
   (cordon, drain, suspend) appear in ADR-005 as the mental model and nowhere in the CLI.
2. **`hkb pause` (board) freezes running workers**; `--keep-workers` cordons only.
3. **`hkb stop <n>` suspends the card** (`suspended` on the card), so the next tick does not pick it
   up again; `hkb start <n>` clears it.
4. **A `process` worker is paused by a signal freeze** (`SIGSTOP`/`SIGCONT` on its process group); a
   `claude-bg` worker by a checkpoint (`claude stop`, then `claude --bg --resume <session> "continue"`).
5. **A paused board's tick keeps its bookkeeping** (outbox, reconcile, promote, the reap of finished
   cards) and stops claiming and reclaiming.
6. **The GitHub Actions runner is removed** (`init --with-actions`, the `claude-action` profile,
   `mode: trigger`, the `remote` liveness branch). Not refused: deleted. The cloud is a later question.
7. **The Node floor is `>=22.13`, 24 recommended.** On 22 the `node:sqlite` `ExperimentalWarning` is
   silenced in `bin/hkb.js` (§9). CI runs 22, 24 and 26. 22 is dropped in April 2027 with its end of life.
8. **The source of truth is local, in two tiers** (§6): the durable half on a dedicated git branch
   `kb-board`, the live half plus an index in a SQLite file inside the repo's common git directory. A
   board therefore **travels with a `git clone`**, and a board has **one control plane** (one host).
9. **GitHub is retired as a store** and comes back later as a *bridge* adapter (§8). The forge half —
   pull requests, reviews, merges — stays on GitHub throughout, because the code does.
10. **The inbox is the triage lane**, with a quick-add on the web board, the MCP `create` tool, and
    (with the bridge, later) a human-opened issue becoming a triage card.
11. **TypeScript ships transpiled**: native `.ts` runs in a checkout, `dist/` is built by `prepack` in
    `release.yml` and nowhere else (§9).

## 2. Vocabulary — the Kubernetes mapping, corrected

| Kubernetes | hkb | Note |
|---|---|---|
| cluster | every board this machine knows (`~/.config/hkb/boards.json`) | |
| etcd | the store (§6) | today GitHub; after track A, the two tiers |
| node | a **host** running the dispatcher loop | not a board: one host serves several boards |
| kubelet + scheduler + controller-manager | the tick, deliberately one loop (ADR-004) | never split into services |
| namespace + ResourceQuota | a board and its `dispatch.*` caps | |
| Job (backoffLimit, activeDeadlineSeconds) | a card (`failure_limit`, `max_runtime`) | `suspend` is what §3 adds |
| Pod | an attempt | |
| container runtime (CRI) | a profile's `mode`: `process`, `claude-bg`, `manual` | §4 |
| RuntimeClass | a profile | |
| Lease | the lock, renewed by compare-and-swap | |
| taint with a TTL | `profile_paused_until` after a 401/429 | unchanged |
| pod anti-affinity | the `path_overlap` guard | unchanged |
| validating admission webhook | the PreToolUse hook, deny-or-silent | unchanged |
| events | `hkb watch` kinds; after track A, the events table | |
| workflow controller (Argo) | the track runner | pausing a root pauses its subagents: same session |

Two rules follow. **A pause lives on its object**: a worker pause on the attempt row, a card suspend on
the card, a board pause on the board row. **Workers never operate the board**: the four verbs are the
operator's, refused under `KB_TASK` the way `hkb dispatch` is (`refuseIfWorker`, `src/cli.js`) and
denied on the launch line (`CLAUDE_DENY`, `src/board.js`). A worker that wants to stop has `hkb block`.

## 3. The verbs

Worker level (`<n>` is a card; the verb acts on its open attempt, or on the card for `start`):

| verb | scheduling | the attempt | lease and clocks | written where |
|---|---|---|---|---|
| `start <n>` | claims and launches now (today's `claim --spawn`); clears `suspended` | if the last attempt is `stopped` with a `session_id` and its worktree exists, attempt k+1 **resumes that session** in that worktree: `resumes: k` and `wt: kb-<n>-<k>` on the new row. `--fresh` forces a cold attempt. A stopped track root restarts as a track: `trackAlreadyAttempted` ignores `stopped` rows | new lock, new clocks | card, run |
| `pause <n>` | card stays `running`, slot stays spent | **runtime first, row second**: the runtime pauses, the host records `paused_attempts["n/k"]` in `.kanban/state.json` (what the hooks read), then the row gets `paused_at`, `paused_by: <host>`. Local first because the laptop-closing case is the offline case: the row write may queue, and this host's dispatcher cannot reclaim while offline either. A crash between the two leaves a frozen worker with an unpaused row, which the next tick on this host repairs from `state.json` | lock kept; `max_runtime`, `stale_after` and the idle threshold stop counting | state.json, then run |
| `resume <n>` | unchanged | runtime resumes; the row gets `resumed_at` and the window is appended to `pauses[]`. `claude-bg` keeps its job id across the wake; `process` keeps its pid | clocks continue | run |
| `stop <n>` | card returns to `ready`/`todo` by `computeReady` and gets `suspended: {at, by, reason}`; the tick checks `suspended` **before** the `active_pr` guard (a stopped worker usually has a draft PR open), and a last row of `stopped` exempts the card from that guard the way `changes_requested` does | runtime stops gracefully (`claude stop`, or `SIGCONT` then `SIGTERM` then `SIGKILL` after 5 s); row closes with the new neutral outcome `stopped` (`failures` untouched, no `needs-human`); worktree kept, it is the checkpoint. **On a track root, every covered node's open attempt closes as `stopped` in the same call** | lock released | run, card |

Board level (no `<n>`):

| verb | what it does |
|---|---|
| `pause` | sets `board.paused_at/paused_by`. Every tick that reads it claims nothing and reclaims nothing; outbox replay, reconcile, promote and the reap of finished cards keep running. Then pauses every running attempt on this host as above (`--keep-workers` skips that) |
| `resume` | clears the board pause; resumes the attempts this host paused |
| `stop` | the board pause, then `stop <n>` for every running attempt on this host, each with `reason: board stop` |
| `start` | clears the board pause and `suspended` on every card whose reason was `board stop`; the next tick claims them, warm |
| `--all` | the board verb once per entry in the registry, one line each |
| `ps [--all]` | the matching read: what `up --status` prints, plus paused-since, plus one line per running attempt with its runtime state. A new word because `hkb status <n>` is per-card and because `up --status` is pid files and no network while `ps` reads the board |

Everything else that reads the board: the Stop hook stands aside when `state.json` lists the attempt
under `paused_attempts` (it reads the card's status today, and a paused card is still `running`);
`watchChild` (`src/dispatch.js`) drops the card's comments memo before it reads the run record after
an exit, or an operator `stop` on a `process` worker is overwritten with `protocol_violation`; every
verb that closes a row (`block`, `archive`, `request-changes`, a web-board move) calls `runtime.stop`
when the row says paused, or a frozen `claude -p` sits forever holding a worktree; `stopped` joins
`OUTCOMES` and gets its own neutral bucket in `hkb stats` (`summarizeAttempts` files unknown outcomes
under `blocked` today); `hkb show` renders `paused_at` and the `pauses[]` total; `hkb watch` gains
`paused`, `resumed`, `stopped`, `suspended`. Under `--json` each verb returns
`{number, attempt, runtime, action, ok, why}`; the board verbs return one such object per attempt plus
`{board, paused_since}`.

## 4. The runtime seam

Today five places branch on the profile mode: the three tails of `spawnWorker`, the liveness branches
of the reclaim loop, the kill inside `failAttempt`, the reap, and `watchChild` (all `src/dispatch.js`),
plus all of `src/jobs.js`. They become one module per mode:

```
src/runtime/index.js      runtimeFor(attempt | profile) → the adapter
src/runtime/process.js    pid; the launch is detached, so the pid leads its own process group
src/runtime/claude-bg.js  job id; today's jobs.js
src/runtime/manual.js     a human in a terminal

each exports:
  launch(ctx, task, k, opts)        → handle            (spawnWorker's tail)
  inspect(ctx, attempt, {jobs})     → {alive, working, handle, session}
  stop(ctx, attempt)                → bool              (graceful)
  pause(ctx, attempt)               → {ok, why}
  resume(ctx, attempt)              → handle | {ok:false, why}
```

Pure decisions stay in `src/model.js` (`reapDecision`, `classifyJob`, `attemptIdle`, the clock
functions). The one local subprocess a tick makes (`claude agents --json`) stays one call, inside the
adapter. `test/fake-runtime.js`, in the `fake-gh` style, lets `tick` tests run without a `claude` binary.

| runtime | pause | resume | stop | notes |
|---|---|---|---|---|
| `claude-bg` | `claude stop <job>` | `claude --bg --resume <session_id> "continue"` — flag-less (the saved options bring the hooks and the grant back; flags fork a copy), **one short prompt** (a bare wake idles, reporting `state: working`/`status: idle`), cwd = the attempt's worktree. Same job id, same session id, fresh pid | `claude stop` | measured: a stop after 7 of 15 steps resumed at step 8 and finished |
| `process` | `kill(-pid, SIGSTOP)`; refused on `win32` | `SIGCONT` on the group | `SIGCONT` first, then SIGTERM, then SIGKILL after 5 s (today's `killPid` never continues, so a frozen process would only ever get the SIGKILL) | an in-flight API stream may break; the harness retries, as after a laptop sleep |
| `manual` | row only | row only | row only | the human is the runtime |

**The reap bug, fixed in the same step:** `reapDecision` opens with `if (!job || !job.pid) return null`,
and a parked background job has no pid in `claude agents --json` (only a working one does), so the reap
never stops a finished card's parked agent. `claude stop <id>` needs no pid: drop the gate, and stop
giving the fixtures in `test/reap.test.js` a pid the real listing never has.

## 5. Clocks and the sleep the laptop already takes

Every liveness judgement in the tick is a subtraction from wall-clock: `max_runtime` (checked first),
`stale_after`, the idle threshold, `recent_success_window`. Two pure functions in `src/model.js`,
`attemptElapsed(a, now)` and `sinceSignal(a, now)`, subtract the attempt's `pauses[]`
(`[{at, until, by}]`) and replace those subtractions. hkb subtracts rather than resetting the deadline,
because the budget was per attempt.

The loop stamps `last_tick_at` in `state.json`. A tick that wakes to a gap longer than three intervals
knows the host slept and writes that window into `pauses[]` on every attempt that has a **local handle**
(a pid, a job, a `bg` flag — never a `manual` row), one run-record write per such attempt, only after a
sleep, and logs it. Today nothing detects the gap: after a sleep longer than `max_runtime` the first
tick writes every local attempt off as `timed_out`. Limits, stated: a one-shot `hkb dispatch --max 1`
host has no loop to notice a gap; and because a run-record save replaces the whole record, `pauses[]`
is written on resume and after a sleep only, and always after a fresh read.

## 6. The store

### 6.1 Two tiers, and what goes where

| tier | holds | written by | who sees it |
|---|---|---|---|
| the `kb-board` branch | `board.json` (slug, owning host, settings, paused); one `cards/<id>.json` per card (title, body, status, agent, priority, rank, paths, goal, scheduled_at, suspended, needs_human, blockers); one `runs/<id>.json` per card (the closed attempt rows with outcome, summary, session and cost, and the results — today's run and result comments, same fields) | every durable verb, as one commit, from any worktree, CAS on the ref with a retry | every clone, after `git fetch`; its `git log` is the board's history |
| `.git/hkb/index.db` | everything on the branch as tables, plus what is live and host-local: locks, the open attempts' pid, job, worktree, heartbeat and pause fields, the events table | durable verbs after their commit; live writes alone; rebuilt from the branch whenever the stored tip sha is not the branch's | this host's processes: the loop, the workers' verbs, the hooks, `hkb serve` |
| `.kanban/state.json` | unchanged: pid files, exits, the sleep stamp, `paused_attempts` | the loop and the verbs | this host |

The write path: a durable verb commits first and updates the index second; a crash between the two
leaves an index one commit behind, which the next open repairs by comparing its stored tip with
`refs/heads/kb-board`. Live writes never touch git, so the branch's history is a history of decisions.
Locks stay in the index under `UNIQUE(task_id, k)`: a claim is one transaction (insert the lock, insert
the attempt row, set the status), a heartbeat is `UPDATE locks SET beat_at = ? WHERE task_id = ? AND
k = ? AND token = ?`, and zero rows updated is the same `LOCK_LOST` (exit 3) the ref lease gives today.
The orphan-lock sweep in the tick goes away with the torn writes it existed for.

### 6.2 The branch

Written with plumbing, never a checkout: `hash-object -w`, `update-index --cacheinfo` against a
temporary index (`GIT_INDEX_FILE`), `write-tree`, `commit-tree`, `update-ref refs/heads/kb-board <new>
<expected-old>` — the expected-old is the compare-and-swap; a mismatch (another writer landed first)
means re-read and retry. Measured 2026-09-02: from a linked worktree this puts a card on the branch
with the worktree at zero changed files; the CAS refuses a mismatch; a plain `git clone` brings
`origin/kb-board` across. hkb already runs this plumbing for every heartbeat (`casHeartbeat`,
`src/lock.js`). Layout of the tree:

```
board.json            {"version":1,"slug":"default","host":"<hostname>","paused_at":null,"paused_by":null,"settings":{...}}
cards/12.json         {"id":12,"title":"…","body":"…","status":"ready","agent":"claude","priority":2,"rank":null,
                       "paths":["src/x.js"],"goal":"…","scheduled_at":null,"suspended":null,"needs_human":false,
                       "blocked_by":[11],"created_at":"…","updated_at":"…"}
runs/12.json          {"v":1,"failures":0,"block_loops":{},"last_error":null,"attempts":[ ...closed rows... ],
                       "results":[{"attempt":1,"summary":"…","metadata":{},"artifacts":[]}]}
```

One card per file and sorted keys keep the files merge-friendly. The root of the repository is the
*common* git directory's parent, resolved by the existing `mainWorktree` (`src/board.js`) — never
`--show-toplevel`, which in a linked worktree would give each worktree its own board.

**Sync is git.** `hkb sync` pushes `kb-board` to the remote and fast-forwards from it, refusing anything
that is not a fast-forward, because the branch has one writer. The loop runs it at the end of any tick
that made a durable write, throttled and offline-tolerant, when the repo has a remote; `hkb init` says
so in one line and `sync.push: false` in `board.json` turns it off. The remote copy is also the backup.

**One writer.** `board.json` on the branch names the owning host. `hkb dispatch`, `hkb claim` and the
verbs refuse on a host that is not it, naming the takeover flag (`hkb init --take-over`) as the fix. A
friend who clones sees the board read-only in `hkb serve`. Two hosts writing the same branch is not
supported in this version (integer ids would collide; hash ids are the later answer).

### 6.3 The index

```
board     slug, host, paused_at, paused_by, settings_json, tip_sha
tasks     id, title, body, status, agent, priority, rank, paths_json, goal, scheduled_at,
          suspended_json, needs_human, created_at, updated_at
links     blocker_id, blocked_id
attempts  task_id, k, one column per attempt field protocol.md lists (profile, host, started_at,
          ended_at, outcome, reason, pid, job, wt, session_id, transcript_path, total_cost_usd,
          num_turns, duration_ms, terminal_reason, track, track_mode, track_nodes_json, track_branch,
          continues_pr, continues_branch, manual, synthetic, paused_at, pauses_json, …)
runs      task_id, failures, block_loops_json, last_error
locks     task_id, k, token, beat_at                          UNIQUE(task_id, k)
results   task_id, k, summary, metadata_json, artifacts_json
notes     id, task_id, at, actor, text                        (today's human comments)
events    id INTEGER PRIMARY KEY AUTOINCREMENT, at, kind, task_id, payload_json
```

`node:sqlite`, `DatabaseSync`, WAL mode, `timeout` (the busy timeout) on writing connections and `0`
on `hkb serve`'s read connection (a busy wait inside a synchronous call would stall every request
behind it), the schema created once under the loop lock. `node:sqlite` has no change notification, so
nothing wakes on a write by itself: a verb that writes the store sends `SIGUSR1` to the pid in
`.kanban/dispatch.pid` (the loop already listens for `SIGTERM`), and `hkb serve` feeds its stream from
a one-second cursor over `events.id`. Every mutating store call appends an event; that invariant is a
conformance test. `hkb doctor` refuses an index on a 9p or network mount (WSL `/mnt/c`, NFS).

### 6.4 The `Store` interface

The seam (track A, node A3) extracts this from `src/tasks.js` and `src/lock.js`, with the GitHub bodies
behind it and no behaviour change; the two local tiers (A4, A5) implement it; A6 makes it the default.
Method names are the contract every node depends on — do not rename them:

```
open(ctx)                                  → the store for ctx.root (resolves the common git dir)
capabilities()                             → { events: bool }          (GitHub: false; local: true)

board()                                    → { slug, host, paused_at, paused_by, settings }
setBoard(patch)

listTasks({ states })                      → Task[]      (today's fetchBoard shape: number, title, body, kb,
                                                          status, agent, needsHuman, blockedBy[], prs[], state,
                                                          stateReason, createdAt, updatedAt, url)
listClosedRecent()                         → Task[]
getTask(n)                                 → Task
createTask({ title, body, kb, status, agent }) → Task
updateBody(n, body)
setStatus(task, status, { add, remove })   (labels on GitHub; columns locally: status, agent, needs_human)
setAgent(task, agent)   addLabels(task, names)   removeLabel(task, name)
closeTask(n, reason)    reopenTask(n)
addBlockedBy(child, parent)   removeBlockedBy(child, parent)

loadRun(n)                                 → { run, id }   (today's shape)
saveRun(n, runRec)
latestResult(n)   parentResults(task)
addNote(n, text)   listNotes(n)            (today's addComment / listComments for human text)

claim(n, k)                                → { result: 'claimed'|'held'|'unknown', token }
release(n, k)
listLocks()                                → [{ n, k, token, beat_at }]
lockBeatAt(n, k)                           → ISO | null
heartbeat(n, k, expected)                  → 'ok' | 'lost' | 'unavailable'     (the worker side)

events({ after, limit })                   → [{ id, at, kind, number, payload }]   (only when capabilities().events)
```

The pull-request half is **not** the store. `openPrsByHead`, `prMergeStates`, `enableAutoMerge`,
`branchProtection`, `mergePullRequest`, `prChecksState` and `finishPr` move to `src/forge.js` as they
are, and keep calling `src/gh.js`.

## 7. What leaves

**The Actions runner** (track A, node A2): `templates/actions/`, `init --with-actions` and
`actionsFiles`, the `claude-action` profile, `mode: 'trigger'` in `spawnWorker`, the `remote` branch of
the reclaim loop, the doctor checks for the workflows, the README section "Runs when the laptop is
closed", the matching part of `docs/harnesses.md`, `test/actions.test.js`. `--profiles` on `dispatch`
stays: it is how a host says which profiles it launches.

**The GitHub store** (track C, node C2): `src/store/github.js` is deleted once every live board has been
imported; `test/fake-gh.js` shrinks to the forge routes. The forge half changes shape in one place:
with no issue to close, the worker brief stops writing `Closes #n`; a PR is tied to its card by the
`kb-<id>-<k>` branch name (`branchFallbackPrs`, already the fallback today); a merged PR marks its
card `done` through the same listing by head branch that the `active_pr` guard reads, and `hkb merge`
sets `done` itself.

## 8. Later: GitHub as a bridge (kept as a spec, not scheduled)

**Board state flows out. Forge state flows in. Nothing else crosses.** Outbound: a card as an issue with
the `kb:` labels and the body block, a status change as a label change, the run and result records as
comments, a suspended or paused card as the same — the serialisers that exist today, verbatim. Inbound,
only what GitHub owns: a PR opened, merged or closed; an issue closed **by a merged PR** (→ `done`); a
human's comment (→ a note the next brief carries); and, as the one creation-only exception, an issue a
human opens becomes a triage card (the inbox from a phone). An issue closed **by a person** with no
merged PR is board state and lands as an event plus `needs_human`, never as an archive. The bridge
closes an issue itself when a card reaches `done` (GitHub's keyword only closes at merge, only against
the default branch, never for a body edited after the merge). Never inbound: a claim, a lock, an
attempt, a pause. Shape: `src/projects.js` generalised (pure plan, never-throwing apply, throttled
errors, config block, `skipped` under `--json`, doctor check), keyed by a `bridge` table
(`task_id, adapter, remote_id, remote_meta_json, pushed_at, pulled_at`); the Projects mirror becomes a
second adapter of the same interface, mirroring only published cards. Identity: the card id is local;
`12 · gh#57` is how both are shown; `nums` refuses `#57` where an id is expected.

## 9. TypeScript and the Node floor

Measured 2026-09-02: a `.ts` file runs directly on 22.23.2, 24.20.0 and 25.2.1 with no flag and no
warning (type stripping is stable since 24.12), but **Node refuses to strip types under
`node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the tarball must ship JavaScript.
Hence: the checkout runs `src/*.ts` directly; `prepack` (run by `release.yml` only) emits `dist/`;
`bin/hkb.js` loads `dist/` when the package has one and no `.git`, `src/` otherwise. Erasable syntax only
(no `enum`, no parameter properties, no runtime `namespace`), `.ts` in every import specifier,
`verbatimModuleSyntax` (an `import { fn, SomeType }` without `type` is a runtime error under
stripping), `tsc --noEmit` replacing `node --check` in `npm run lint` (which parses `.ts` as JavaScript
and fails), `npm run smoke` proving the tarball. Before any of that, JSDoc is checked with
`tsc --noEmit --checkJs` over the annotations the code already carries (track A, node A1).

The warning filter for `node:sqlite` on Node 22 (measured on 22.23.2), in `bin/hkb.js` before any
import:

```js
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});
```

## 10. The sequence — three tracks

Every node: one PR, `npm run lint && npm test` green, the wiki page the change touches updated
(`node .repolore/scripts/wiki-check.mjs`), a new feature gets a new page. Nodes are sequential unless
the table says they run side by side, and side-by-side nodes have disjoint `paths`.

### Track A — floor, no Actions, the store seam, the two tiers

| node | title | blocked by | paths |
|---|---|---|---|
| A1 | Node floor 22.13 with the SQLite warning silenced; CI on 22/24/26; JSDoc type check; the wording | — | `package.json`, `bin/hkb.js`, `.github/workflows/test.yml`, `tsconfig.json`, `CLAUDE.md`, `README.md` |
| A2 | Remove the GitHub Actions runner | A1 | `templates/actions/`, `src/init.js`, `src/board.js`, `src/dispatch.js`, `src/doctor.js`, `docs/harnesses.md`, `README.md`, `test/actions.test.js` |
| A3 | The store seam: `Store` over tasks.js and lock.js, GitHub behind it, `src/forge.js`, no behaviour change | A2 | `src/store/`, `src/forge.js`, `src/tasks.js`, `src/lock.js`, `src/board.js`, `test/store.test.js`, and the import lines of every caller |
| A4 | The git tier: `src/store/git.js` | A3 | `src/store/git.js`, `test/store-git.test.js` |
| A5 | The index: `src/store/sqlite.js` | A3 | `src/store/sqlite.js`, `test/store-sqlite.test.js` |
| A6 | The local store as the default: `open()` composes the two tiers, `hkb init --import` migrates a GitHub board, `hkb sync`, the owning-host guard, the doctor probes, `hkb gc` drops its comment and beat-chain sweeps | A4, A5 | `src/store/index.js`, `src/store/local.js`, `src/init.js`, `src/cli.js`, `src/doctor.js`, `src/gc.js`, `test/` |
| root A | verify: the conformance suite green on both drivers; a scratch repo initialised with the local store runs create → claim → finish → serve end to end; docs and wiki updated | A6 | |

A4 and A5 run side by side. Their contract is §6.4 and §6.1–6.3; A3 lands the interface and the
conformance suite (`test/store.test.js`, driver-parametrised) they both run against.

### Track B — the control plane verbs on the store

| node | title | blocked by | paths |
|---|---|---|---|
| B1 | The runtime seam (process, claude-bg, manual) and the reap fix | root A | `src/runtime/`, `src/dispatch.js`, `src/jobs.js`, `test/fake-runtime.js`, `test/runtime.test.js`, `test/reap.test.js`, `test/jobs.test.js` |
| B2 | Clocks and the sleep-aware tick | B1 | `src/model.js`, `src/dispatch.js`, `test/model.test.js`, `test/dispatch.test.js`, `docs/wiki/features/up-and-down.md` |
| B3 | `hkb stop <n>` and `hkb start <n>` | B2 | `src/cli.js`, `src/lifecycle.js`, `src/model.js`, `src/dispatch.js`, `src/gc.js`, `src/stats.js`, `src/runtime/`, `skills/kanban/references/protocol.md`, `test/` |
| B4 | `hkb pause <n>` and `hkb resume <n>` | B3 | `src/cli.js`, `src/lifecycle.js`, `src/runtime/`, `src/hook.js`, `src/dispatch.js`, `src/board.js`, `src/watch.js`, `test/` |
| B5 | The board verbs, `--all`, `hkb ps`, the operator's reaction rows | B4 | `src/cli.js`, `src/dispatch.js`, `src/up.js`, `src/lifecycle.js`, `src/doctor.js`, `skills/kanban/SKILL.md`, `README.md`, `test/` |
| B6 | The live web board: the events stream, rank and reorder, the timeline, reopen, the quick-add inbox, the verb buttons; `watch` on the events cursor | B4 | `src/serve.js`, `web/index.html`, `src/watch.js`, `test/serve.test.js`, `test/watch.test.js` |
| root B | verify: every verb exercised on a scratch local board and on this repo's board; wiki pages for the verbs and the web board | B5, B6 | |

B5 and B6 run side by side.

### Track C — tests onto the store double, retire the GitHub store, TypeScript

| node | title | blocked by | paths |
|---|---|---|---|
| C1 | Tests onto a store double: the 121 assertion sites that read `gh.calls`, `lockRefs()`, `runOf()` | root B | `test/` |
| C2 | Retire the GitHub store; the forge half without issues | C1 | `src/store/github.js`, `src/tasks.js`, `src/context.js`, `src/dispatch.js`, `src/lifecycle.js`, `src/forge.js`, `test/fake-gh.js`, `README.md`, `docs/` |
| C3 | TypeScript: native `.ts` in the checkout, `dist/` at publish | C2 | `src/`, `bin/`, `tsconfig.json`, `package.json`, `.github/workflows/release.yml`, `scripts/`, `CLAUDE.md` |
| root C | verify: `npm run smoke` from a clean clone and from the tarball; this repo's own board migrated with `hkb init --import`; release notes | C3 | |

## 11. Measurements this rests on (2026-09-02, Claude Code 2.1.258, Node 24.20.0)

- A `claude --bg` job has a `pid` in `claude agents --json` only while it is on a turn (a `claude
  bg-spare` process, its own process group); parked and stopped jobs have none.
- `claude stop <id>` keeps the conversation (`resumeSessionId`, `respawnFlags` in
  `~/.claude/jobs/<id>/state.json`). `claude --bg --resume <sid>` with flags forks a copy; flag-less it
  wakes the same job id but idles; flag-less with a one-line prompt it continued from step 8 of 15 to done.
- Laptop sleep: nothing in the tick adjusts a clock; after a gap longer than `max_runtime` the first tick
  writes local attempts off as `timed_out`.
- `node:sqlite`: missing on 20.20.2 (`ERR_UNKNOWN_BUILTIN_MODULE`), works with an `ExperimentalWarning`
  on 22.23.2 and 25.2.1, silent on 24.20.0 (docs: Stability 1.2 since 24.15; FTS5 compiled in;
  `backup()` exported; SQLite 3.53.4). The warning is silenced by the filter in §9.
- Type stripping: `node file.ts` runs on 22.23.2, 24.20.0, 25.2.1; fails on 20; refused under
  `node_modules`; `node --check file.ts` fails on every version.
- Node 20 is end-of-life on nodejs.org's release table; 22 and 24 are LTS; 26 is current.
- Hermes keeps its board in `~/.hermes/kanban.db`, is "deliberately single-host", and has no GitHub sync.
- Beads keeps its database out of the working tree and syncs it through `refs/dolt/data` on the git
  remote; its JSONL is "an export for viewers and interchange, not the source of truth".
- The git plumbing of §6.2, from a linked worktree, in a scratch repository: worktree clean, CAS refused
  on mismatch, `origin/kb-board` present after `git clone`.
- GitHub coupling at `7fd6cba`: `src/tasks.js` 36 exports, `src/lock.js` 19, 29 direct transport call
  sites in 6 other files (`projects.js` 11, `doctor.js` 11, `lifecycle.js` 4, `init.js` 1, `watch.js` 1,
  `board.js` 1); 121 test assertion sites read fake-gh internals (`gh.calls` 52, `lockRefs()` 26,
  `runOf()` 43).
