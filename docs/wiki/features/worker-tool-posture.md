---
title: Worker tool posture — what power an unattended worker holds, and who decided it
summary: The board states whether a profile inherits the session's tools or curates its own list, names the MCP servers that answer covers, and lets a card lower the ceiling — one posture, derived in one place, printed by doctor.
category: features
kind: explanation
audience: [dev, operator]
read_when: "changing what a worker may run — a profile's tools/mcp keys, kb.tools/kb.mcp on a card, effectiveTools, or the launch line's allow-list"
covers:
  - path: src/model.js
    sha: 27854e20c9e609f08ab2c49afd2f83eb0fdf08c1
  - path: src/board.js
    sha: 0e4a4ad473531aaea01d951afa45c21be1839cc3
  - path: src/context.js
    sha: 0eecc3f46fa4d71d3fa12598b474c76e0bc7733d
  - path: src/init.js
    sha: c905bab09d496c7b7fe2aaa0c92d2109fdd30432
  - path: src/doctor.js
    sha: 03a19a3c5f2cab7dcae844c9290ed34c03637b80
  - path: src/dispatch.js
    sha: 90ed0ce8799b29e82a2e96f4cde8f0bb98c6dc00
related: [concepts/tool-grant-ceiling, features/denied-tools-ledger, features/capability-map, features/harness-profiles]
generated_at_commit: 237bb61
last_refreshed: 2026-09-02
---

# Worker tool posture

## What it is for

Until this feature, hkb had exactly one answer to "what may a worker run", and
nobody had chosen it. `CLAUDE_TOOLS` in `src/board.js` is a fixed allowlist, and
every Claude profile launches `--permission-mode dontAsk`, where an unlisted tool
is **denied, not prompted** (`src/board.js`, the `launch` arrays). So hkb shipped
the *curated* end of the range silently, on every board it ever initialised.

That default fails in two directions at once, and both were live:

- **Too narrow, silently.** The launch line passes no MCP configuration, so a
  worker inherits whatever `.mcp.json` the repo has and is then refused every tool
  those servers expose — because `allowed_tools` never named them. The measured
  cost is in `features/denied-tools-ledger`: 208 native denials across 56 of 71
  attempts, and not one ended the attempt. Every worker routed around and said
  nothing.
- **Too wide, dangerously.** An unattended worker holding an MCP server that
  writes to production is a blast radius nobody approved, and there was no way to
  say "these servers, and not that one" short of hand-editing one flat list.

The feature makes the posture something a board **states**, and makes the
statement mean something at three levels: the profile, the card, and the report.

## The vocabulary

Two keys on a profile in `.kanban/board.json`, both validated at load in
`loadBoard` (`src/board.js`) so a typo fails loudly instead of resolving to a
silent default:

| Key | Values | Meaning |
| --- | --- | --- |
| `tools` | `"inherit"` \| `"curate"` | the posture. **Absent means `curate`** — every board that predates the field keeps its behaviour with no edit (`toolPosture`, `src/model.js`) |
| `mcp` | array of server names | means *opposite things* at the two postures: under `curate` the servers a worker **may** reach, under `inherit` the servers to **exclude** |

The asymmetry in `mcp` is the point, not an inconsistency. A whitelist alone
cannot express "this board never touches production supabase" on a board that
otherwise inherits; a subtraction alone cannot make the repo's own `react-aria`
server reachable on a curated one. Both directions had to be expressible.

Two keys on a **card** — `kb.tools` and `kb.mcp` — narrow the profile's grant and
can never widen it. That invariant has its own page:
`concepts/tool-grant-ceiling`.

## One derivation, and why that matters most

Everything above resolves in exactly one function:

```
effectiveTools(profile, task, board) -> { tools, dropped, mcp }
```

in `src/model.js`. It is pure, it takes the profile, the card and the board, and
it returns not just the grant but **what it dropped and why** (`dropped` entries
carry `{ tool, source, reason }`).

This single-derivation rule is the load-bearing design decision, and it predates
the posture itself — it was built as its own seam precisely so that the posture
and the capability map (`features/capability-map`) could not each grow a private
answer. Every consumer asks it rather than reading `allowed_tools`:

- `src/dispatch.js` — `expandLaunch` fills the `{allowed_tools}` token from it,
  and `spawnWorker` reports `tools_dropped` so a narrowed grant is *named* at
  spawn rather than reaching the worker as a silent `dontAsk` refusal.
- `src/hook.js` — the PreToolUse policy reads the same derivation the launch did.
- `src/track.js` — a track's fan-out does too.
- `src/context.js` — `mcpLine` renders the servers into the worker's brief beside
  `kb.skills`, so a worker can *tell* what it has instead of guessing.
- `src/doctor.js` — both new checks ask `effectiveTools`; neither recomputes.

Grep for `allowed_tools` under `src/` and the only hits are the definitions in
`src/board.js`, comments pointing at this rule, and the `{allowed_tools}` template
token. That is the invariant worth preserving.

## Under `curate`, naming a server is what grants it

A subtlety worth stating because it surprised the integration: under `curate`,
declaring `"mcp": ["react-aria"]` does not merely *filter* the grant, it **adds**
`mcp__react-aria__*` to it (`applyProfileMcp`, `src/model.js`). Naming the server
is what makes the repo's own `.mcp.json` server reachable at all — that is the
fix for the denied-server story above. So a profile with one tool and two named
servers has a ceiling of three, and `hkb doctor` prints three.

`"mcp": []` means no server at all. A profile with `allowed_tools: null` — Codex,
where `--sandbox` is the whole policy — is left untouched, since adding one server
would turn "no allow-list" into an allow-list of one.

## What an operator sees

- **`hkb init`** prints one line naming the posture the board got and what the
  other one would mean (`src/init.js`). It deliberately does *not* write the key
  into `board.json`, so a fresh board's profiles stay identical to
  `DEFAULT_PROFILES`. The posture is stated in prose and resolved by default.
- **`hkb doctor`** gained two checks (`src/doctor.js`):
  - `tool posture` — one line per profile: posture, ceiling size, and which
    reading its MCP list is under. Printed unconditionally, because a posture
    nobody can see is indistinguishable from no posture at all. On this repo's own
    board it reads `claude: curate, 45 tools, mcp: none · claude-track: curate,
    46 tools, mcp: none`.
  - `card grants` — flags any open card asking for what its profile does not
    grant, and is silent on a board where no card names either key.

## Status and known gaps

Landed: the posture field and its resolver, the `mcp` key at both postures, the
card-level narrowing path, both doctor checks, and the worker brief's MCP line.

The gap that matters, and it is the feature's own headline:

> **`inherit` does not yet inherit.** `toolPosture` is consumed by `src/doctor.js`
> and `src/init.js` only — `src/dispatch.js` never consults it. An `inherit`
> profile's launch line still carries an explicit `--allowedTools` list under
> `--permission-mode dontAsk`, so it behaves as `curate` minus its exclusions
> rather than deferring to the session's own environment. The *subtraction* half
> is genuinely enforced (an excluded server's grant is stripped from the
> allow-list, and `dontAsk` denies what is not listed); the *inheritance* half is
> declared, validated and printed but not yet spent at the launch.

Smaller, also open:

- The denied-tools ledger records what a worker was *refused* but not what it
  *used* — "which grant is nobody using" is as much a dial input as "which denial
  keeps happening" (`features/denied-tools-ledger`).
