---
title: The Node floor and the JSDoc type check
summary: Why the floor moved to 22.13 and what it bought — `node:sqlite` for the local store, one warning silenced at the entry point without silencing any other, a type check over the JSDoc the code already carried, and a CI matrix that tests the floor and the current line rather than one version in the middle.
category: concepts
kind: explanation
audience: [dev]
read_when: "changing engines.node, adding a devDependency, editing bin/hkb.js, or making `npm run lint` fail on something that is not a syntax error"
covers:
  - path: package.json
    sha: efdedd05f3d4cbc3981999ac4a7a95bcd36904f7
  - path: bin/hkb.js
    sha: 46f698dc947f46392cfd0bdd592315269c3cd071
  - path: tsconfig.json
    sha: 1cf5d8e7c742578ddfec7462f50de161ddf31bd2
  - path: types/hkb.d.ts
    sha: b9583e1ccba5a8c72390813b5563ace17d69e433
  - path: .github/workflows/test.yml
    sha: 52d8567c27bedbe1e8cb73e7f9ccfaecaeb72e99
generated_at_commit: 2a3a7e3
last_refreshed: 2026-09-02
related:
  - decisions/adr-006-local-store.md
---

# The Node floor and the JSDoc type check

> `engines.node` used to say `>=20` — a line nodejs.org lists as end-of-life, and one where the
> module the local store is built on does not exist at all. Raising the floor to `>=22.13` is what
> ADR-006 needs; the rest of this page is the three things that came with it, because each one is
> the kind of decision that looks arbitrary a year later.

## The floor is 22.13, and 24 is what to develop on

`package.json` declares `"engines": {"node": ">=22.13"}`. Two reasons, both from ADR-006:

- **`node:sqlite`.** The store's index tier is a SQLite file under the common git directory. The
  module is missing on 20 (`ERR_UNKNOWN_BUILTIN_MODULE`), present-but-experimental on 22, and quiet
  on 24. A floor of 20 would promise a Node the store cannot run on.
- **Type stripping.** Track C runs `.ts` sources directly in a checkout. That works on 22 and up and
  fails on 20.

22 is the floor rather than 24 because it is an LTS line people are actually on; it goes away in
April 2027 with its end of life, and the floor moves then. `README.md` says ">= 22.13, 24 recommended"
for the same reason: the floor is what hkb supports, not what a contributor should install.

## One warning is silenced — and exactly one

On 22, importing `node:sqlite` emits an `ExperimentalWarning` on **every command**. That is noise a
user cannot act on, and it would greet everyone on the floor version. `bin/hkb.js` installs a filter
before it loads anything:

```js
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});
```

Two details are load-bearing:

- The entry point loads `src/cli.js` with a **dynamic** `await import(...)`, not a static one. Static
  imports are hoisted, so with a static import the filter would be installed *after* the module graph
  had already been evaluated — too late for a warning raised during it (`bin/hkb.js`).
- It replaces the default listener rather than passing `--no-warnings`. A blanket silence would hide
  a real deprecation; this one prints every warning that is not the SQLite line. `test/cli.test.js`
  pins all three cases: an ordinary command writes nothing to stderr, the SQLite warning is dropped,
  and any other warning still prints.

## `tsc --noEmit` checks the JSDoc; nothing is compiled

`npm run lint` is the `node --check` loop it always was, followed by `npm run typecheck`
(`tsc --noEmit`). `tsconfig.json` sets `allowJs` + `checkJs` over `bin/`, `src/`, `scripts/` and
`types/`, with `strict: false`. It is a **checker, not a build**: there is no emit, no `dist/`, and
no build step to run before the CLI works.

`typescript` and `@types/node` are `devDependencies`, and that is the whole of hkb's dependency
story — the runtime rule ("keep it dependency-free") is unchanged, because nothing under `src/`
imports either one. `node bin/hkb.js version` in a fresh clone with no `npm install` still works, and
`npm run smoke` proves the packed tarball runs with nothing installed beside it.

There is no committed lock file, so CI runs a plain `npm install` before `npm run lint` and every
`setup-node` keeps `package-manager-cache: false` (a cache restore *fails* the step when it finds no
lock file).

### `types/hkb.d.ts` — the two shapes JavaScript cannot state

Turning the check on surfaced a few hundred complaints, almost all of them one of two kinds: an
inferred object type narrower than the code's actual contract, and a callback default (`log = () => {}`)
inferred as taking no arguments. Those were fixed where they are written, as JSDoc — no runtime
change anywhere.

Two shapes are stated once in `types/hkb.d.ts` instead, because they are conventions the whole
codebase shares rather than any one function's business:

- **`Error` carries hkb's fields.** `CLAUDE.md` states the rule — throw `Error` with `.exitCode`
  (2 = usage/state, 3 = LOCK_LOST, 4 = the loop asking for a restart) — and roughly sixty sites read
  it back. Declaring it once beats annotating each.
- **`HkbAttempt`** is one row of a card's run record. Nearly every field is optional because a row is
  written in stages (a pid when the worker spawns, an outcome when it ends), so inference from any
  single construction site sees only that site's half.

The file emits nothing; it exists only for the checker.

## CI tests the two ends, not the middle

`.github/workflows/test.yml` runs four jobs:

- `test` on **22 and 24** — the floor and the recommended line. Two floors is a real signal (an API
  that only exists on 24 has to fail somewhere), which is why this one is a matrix where the previous
  single-version job was not. Each runs the suite twice, under `TZ=UTC` and `TZ=America/New_York`.
- `smoke` (`scripts/smoke-pack.mjs`) on **22 and 26** — the floor and the current line. It packs,
  installs and runs the tarball, so a `files` entry that stops shipping `skills/` fails here rather
  than on a stranger's first `npx hkb-cli init`. It deliberately runs **no** `npm install`: the
  tarball has to work with nothing installed beside it, which is what keeps `typescript` invisible to
  a user.

The Node these jobs install is the Node that runs `hkb`; it is unrelated to the Node the actions
themselves run on.

## Related

- [ADR-006: the local store](../decisions/adr-006-local-store.md)
