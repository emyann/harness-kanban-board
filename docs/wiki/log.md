# Wiki log

Append-only journal of notable wiki operations, newest **last** — one `##`
line each, so future sessions get recency awareness for free. Never rewrite
history.

<!-- Format:
## YYYY-MM-DD — <added|refreshed|superseded|archived> <category/slug> (why)
-->

## 2026-08-27 — added architecture/overview (seeded at init)

## 2026-08-27 — added decisions/adr-004-roles-and-adoption (from the 7-agent roles evaluation; status proposed)

## 2026-08-27 — refreshed architecture/overview (reclaim now honors `manual`; prose already correct, re-stamped)

## 2026-08-27 — refreshed architecture/overview (no-op re-stamp: #66's seats vocabulary sync touched only comments and help strings in cli.js/model.js/context.js; no claim on the page changed)

## 2026-08-27 — refreshed decisions/adr-004-roles-and-adoption (all three consequences shipped as #68/#69/#70; added an "As shipped" section, anchored the two Context citations to `6c0e81f` now that #68/#69 fixed them, seat vocabulary added to GLOSSARY, status proposed → accepted)

## 2026-08-27 — refreshed architecture/overview + decisions/adr-004-roles-and-adoption (no-op re-stamp: #72 narrowed what `hkb init` seeds into board.json; the cli.js/dispatch.js churn is one help string and one skip message, and no claim on either page changed)

## 2026-08-27 — refreshed architecture/overview + decisions/adr-004-roles-and-adoption (no-op re-stamp: #73 changed one help string in cli.js — `hook stop` → `hook stop|pretool`; no claim on either page changed)

## 2026-08-27 — refreshed architecture/overview + decisions/adr-004-roles-and-adoption (no-op re-stamp: #78 added `init --no-labels` (its offline path, for the tarball smoke) — cli.js churn is one BOOL_FLAGS entry and two help lines, and neither page makes a claim about init's flags)

## 2026-08-27 — added features/web-board (#87 made one `hkb serve` hold several checkouts; serve.js and web/index.html were covered by no page at all, so the whole feature was a freshness blind spot)

## 2026-08-27 — refreshed architecture/overview + decisions/adr-004-roles-and-adoption (no-op re-stamp for #87: cli.js gained two `--repos` help lines, model.js three pure board-key helpers, board.js the `makeContextAt` split plus the user-level board list; no claim on either page changed. One anchor fixed on ADR-004 — `src/cli.js:176` → `:181` for the exit-code help line, which the `--repos` lines and #88 shifted; the `6c0e81f`-pinned `cli.js:419` citation is historical and stays)

## 2026-08-27 — added features/auto-merge (#89 made merging board policy: `dispatch.merge.mode` `manual`|`auto`, the tick enabling GitHub's own auto-merge once per PR, and the branch-protection gate doctor hard-fails on — no page covered who lands an agent's PR)

## 2026-08-27 — refreshed architecture/overview for #89 (one claim tightened: "judgment — whether a PR merges — lives outside the loop" now says what `merge.mode: auto` does and does not change, and points at the new page)

## 2026-08-27 — refreshed decisions/adr-004-roles-and-adoption (no-op re-stamp for #89: dispatch.js and protocol.md moved, but the seat decision is untouched — merge authority stays the operator's, and the dispatcher only enables a GitHub mechanism the operator opted into, never a merge of its own)

## 2026-08-27 — added features/planning-commands (#92: SKILL.md advertised `/kanban:specify` and `/kanban:decompose` while nothing registered them — the page records why they are commands and not `hkb` verbs, how one `commands/` source is registered by both the plugin and `hkb init`, and the three checks that now fail before an adopter does)

## 2026-08-27 — refreshed features/auto-merge (no-op re-stamp for #92: `src/doctor.js` gained an unrelated `checkCommands`; every merge-policy claim on the page — `checkMergePolicy` as a hard failure, the branch-protection gate, the ops view — is untouched)

## 2026-08-27 — refreshed decisions/adr-004-roles-and-adoption (#92 moved SKILL.md and protocol.md but not the seat decision, so no superseding record: the planning commands are operator-seat tooling and the dispatcher still holds no LLM. One citation corrected — exit code 4 is `protocol.md:257`, one line lower after the decompose paragraph was reworded)

## 2026-08-27 — added features/update-notice (#93 gave the CLI half of "is this install old": one npm dist-tag GET a day, in doctor and in the dispatcher loop, with the compound false green — a stale CLI whose packaged skill matches the installed one — as the case it exists for. src/registry.js was covered by no page at all)

## 2026-08-27 — refreshed architecture/overview for #93 (one claim added rather than changed: the loop does two things a tick does not — the token and version notices, at most once a day and outside `tick()` because they write state.json. src/doctor.js added to covers, since the page now cites it)

## 2026-08-27 — refreshed features/planning-commands (#93 shifted two anchors and nothing else: `installCommands` `src/init.js:124-132` → `:131-139` (a `packageVersion` helper went in above it) and `checkCommands` `src/doctor.js:42-48` → `:43-49` (one import line). Every claim about the commands is untouched)

## 2026-08-27 — refreshed features/auto-merge + decisions/adr-004-roles-and-adoption (no-op re-stamp for #93: doctor.js gained the version check, dispatch.js two calls in `loop`, board.js one default key; no merge-policy or seat claim changed. One anchor corrected on ADR-004 — the `a.remote || a.manual` line is `src/dispatch.js:486`, not `:427`, which had drifted before #93 touched the file; the `6c0e81f`-pinned Context citations stay as they are)

## 2026-08-27 — refreshed architecture/overview + features/auto-merge + features/update-notice (no-op re-stamp for #99: model.js gained the pure `mergeBoardEntry` and board.js the user-board-list writer (`saveUserBoards`, `mainWorktree`, `registerUserBoard`), all additive. No claim on any of the three pages is about that list — the page that describes it, features/web-board, covers serve.js and stays fresh; it gets the writer when #98 makes one visible to a user)

## 2026-08-27 — refreshed features/web-board for #101 (one claim added: the user-level board list is now live — `reloadBoards` re-runs `serveContexts` at most once per poll interval, on the requests the page already makes, and every board still in the list keeps its state object. Five anchors that had drifted with the new code were corrected)

## 2026-08-27 — refreshed features/planning-commands + features/update-notice (no-op re-stamp for #100: `hkb init` gained a step 7 that registers the checkout it set up in the user-level board list, plus a `--json` payload, and scripts/smoke-pack.mjs now runs every command against a throwaway `KB_CONFIG_HOME` so its scratch repo cannot land on a maintainer's list. No claim on either page is about any of that; one anchor shifted by the new import line — `installCommands` `src/init.js:131-139` → `:132-140`. The page that owns the board list, features/web-board, covers serve.js and is still fresh: the whole "the list maintains itself" story is #102's to write, now that #101 has made serve pick the list up while it runs)

## 2026-08-28 — refreshed features/web-board for #98 (the writing half of the user-level board list, which #99's log line deferred to here: a new "How a checkout gets on the list" section — `registerUserBoard` called once from `hkb init`'s last step, the three properties that make registering without asking defensible (idempotent by resolved path + slug over an append-only merge and an atomic rename, never silent, never fatal), a linked worktree registering its main checkout instead of itself, and why the entry is a bare path and not `path#board`. The "filesystem is never scanned" promise gained the distinction that keeps it true: running `hkb init` in a directory *is* the act of naming it. `src/board.js` and `src/init.js` joined `covers` — the page cited board.js with no freshness anchor before)

## 2026-08-28 — refreshed architecture/overview + features/auto-merge + decisions/adr-004-roles-and-adoption (no-op re-stamp for #98's two synthesis edits: one help line in src/cli.js, and `mergeBoardEntry`'s NUL key separator written as an escape instead of a literal byte, so grep and ripgrep stop treating src/model.js as binary and skipping it. No claim on any of the three pages is about either. One present-tense anchor shifted by the help line — adr-004 `src/cli.js:181` → `:182`; that record's two `6c0e81f`-pinned citations are historical by construction and were left alone)

## 2026-08-28 — refreshed features/web-board for #108 (a new "The drawer draws the subgraph" section: the focused card's dependency subgraph as inline SVG, drawn from the `blockedBy` already on every `/api/board` card — no route, no fetch, no server change. Records the four decisions that make it readable (every edge between the collected nodes, so a diamond comes back; a finished blocker is a node from the stub that names it, since `fetchBoard` reads open issues only; the column palette and the existing `data-open` handler reused; nothing drawn when there is nothing to draw), the layout's accepted limits and the two renderers it may never become — a module `<script>` breaks every vm page test, a CDN breaks the self-containment assertions — and the one case the picture can be wrong: the REST-fallback fingerprint `edgesMayBeMissing` reads off the payload it already has, since widening `fillBlockedByRest` is a per-task call Values 2 and 3 forbid. `covers` unchanged; "Dependency subgraph" added to the glossary)

## 2026-08-28 — refreshed architecture/overview (no-op re-stamp for #119: the Stop hook now writes the session identity onto every attempt the session is answerable for, not only `KB_TASK`'s — a track runner's nodes get `session_id`/`transcript_path` from the pending `.kanban/sessions/<n>-<k>` markers `hkb claim` leaves inside a session, so the set is on disk and costs no board read. The page's one hook claim is that the Stop/PreToolUse hooks enforce the worker guard rails, and that is untouched; the src/cli.js drift it was already stale for is #111's `hkb graph` command, equally not a claim on this page. The story belongs to features/tracks, still waiting to be drafted)

## 2026-08-28 — refreshed architecture/overview for #115 (a real edit, not a re-stamp: "Workers are any harness" said a worker is "pointed at one card with `KB_TASK` set", and for the DEFAULT profile that was never true — `claude --bg` hands the launch to a session daemon that was started long before, so the dispatcher's environment stops at the CLI. Two new paragraphs record the asymmetry and both answers to it: `whichAttempt` reads the attempt back out of the `kb-<n>-<k>` checkout, the same identity `matchJobByWorktree` already matches jobs by; and session identity — `CLAUDE_CODE_SESSION_ID` plus the job record `currentSession` reads — is written by the terminal verb rather than the Stop hook, because the verb is the one thing every worker runs and it is already writing that row. `sessionForAttempt`'s "only an attempt this session ran" rule is what keeps an operator's own terminal out of it and what gives a track's nodes the runner's transcript. `src/jobs.js` added to `covers`; "Transcript" added to the glossary. The page's other claims were re-read and hold; the src/cli.js, src/tasks.js and src/doctor.js drift it was already stale for is #124/#127/#131, none of them a claim here)

## 2026-08-28 — refreshed architecture/overview (targeted, unstamped) for #125: the terminal-verb paragraph now says why the verb needed a second spelling — `complete` is a bash builtin and Claude Code refuses it, and heredocs, in a worktree-isolated session, so `VERB_ALIASES` in src/cli.js resolves `finish` before routing. NOT re-stamped: the page was already stale for #124/#127/#131 drift this task did not verify, and stamping would bless claims it did not read
