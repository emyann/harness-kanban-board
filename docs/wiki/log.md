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
