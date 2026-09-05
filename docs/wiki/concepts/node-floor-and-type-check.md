---
title: The Node floor and the type check
summary: The floor is >=22.18.0, measured — the first release that strips types unflagged, which a shebang cannot ask for. Why a published hkb must be JavaScript (Node refuses to strip under node_modules), how the publish transpile works, and what the CI matrix is for.
category: concepts
kind: explanation
audience: [dev]
read_when: "changing engines.node, adding a devDependency, editing the tsconfigs or the publish transpile, or making `npm run lint` fail on something that is not a type error"
covers:
  - path: package.json
    sha: 02ee69e9b3b3113a1826ffc0798b80a91a2c02ba
  - path: tsconfig.json
    sha: b080b89e99af5295b81b32d725d2a7272cbb57d9
  - path: tsconfig.build.json
    sha: f64569f3260ba5d1552f826369456ce5d78c1af0
  - path: bin/hkb.ts
    sha: 698dd0e673a442929b7314d6bb409f87f89b8251
  - path: src/paths.ts
    sha: 3c4e482cf042b60a4356ec3dd994279b24fcb28d
  - path: scripts/smoke-pack.mjs
    sha: abccc0340f0034e8f40aa9a30796fac84655f603
  - path: .github/workflows/test.yml
    sha: 00de5dbbc45ef525e6b45fdd34902b38df20128a
generated_at_commit: 54ad569
last_refreshed: 2026-09-05
related: [decisions/adr-006-local-store, decisions/adr-005-control-plane, architecture/store-seam]
---

# The Node floor, the publish transpile, and the type check

## The floor is 22.18.0, and it was measured

`bin/hkb.ts` is TypeScript with a `#!/usr/bin/env node` shebang. A shebang cannot pass flags
portably, so the floor is the first release where **type stripping is on without one**. Measured on
the real binaries, running the real CLI:

| | |
|---|---|
| 20.20.2 | fails — `ERR_UNKNOWN_FILE_EXTENSION` |
| 22.17.1 | fails unflagged; works with `--experimental-strip-types` |
| **22.18.0** | **works, no flag, no warning on stderr** |
| 22.23.2 / 24.x / 25.x | works |

`npm test` gives the same result on 22.18.0 as on 24.20.0, so the floor is the whole stack — Prisma
and the `better-sqlite3` native binding included — not just the parser.

Node 22 is LTS until 2027, so this floor does not push anyone onto a newer major. Nothing in the
sources needs *transform* rather than erasure: there is no `enum`, `namespace`, or parameter
property anywhere, and Prisma generates `const X = {…} as const` plus a type, not a TS `enum`.

## A published `hkb` cannot be TypeScript

> **Node refuses to strip types for any file under `node_modules`** —
> `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, on every version, by design.

This is not a version problem and no flag lifts it. It splits cleanly by *how the package arrived*:

- a **checkout** runs `.ts` directly — the everyday case, no build;
- an **`npm link` / `file:` install** also runs `.ts`, because the bin symlink's realpath is the
  checkout, not `node_modules`;
- a **registry or tarball install** does not, because the files really are under `node_modules`.

So `bin.hkb` points at `dist/bin/hkb.js`, produced by `prepack` (`tsconfig.build.json`, about a
second). ADR-006 had already decided "TypeScript transpiled at publish"; it was simply never
implemented, because nothing was published that needed it until `hkb` became a bin.

`rewriteRelativeImportExtensions` in `tsconfig.json` is what makes the emit correct — the `.ts`
specifiers the sources need become `.js` in `dist/`.

## Two layouts, so paths are found rather than assumed

`src/paths.ts` exists because `path.resolve(import.meta.dirname, '..')` is right in a checkout and
wrong under `dist/`, which is one directory deeper — and wrong only in the layout nobody runs while
developing. The package root is found by walking up to a `package.json` (`dist/` has none, so both
layouts agree), and the daemon's re-exec target is resolved *beside its own module*, so a checkout
carrying a stale `dist/` does not spawn the stale one.

## The smoke test is what proves any of this

Content checks cannot catch it: pointing `bin.hkb` at `bin/hkb.ts` passes every "is the file in the
tarball" assertion and produces a binary that cannot start. `npm run smoke` therefore **runs the
installed `hkb`** — `--help`, then `hkb new`, which creates and migrates a board from the packaged
`prisma/migrations` and so also proves that directory is in `files`. Both failures were reproduced
deliberately and both are caught.
