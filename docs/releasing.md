# Releasing hkb

Publishing is a tag. [`.github/workflows/release.yml`](../.github/workflows/release.yml) does the rest —
tests, the tag/version check, `npm publish --provenance`, and a clean-room `npx hkb-cli@<version>` that proves the
published tarball actually runs.

There are no npm secrets in this repository. npm publishes `hkb-cli` through a **trusted publisher**: an
identity on npmjs.com that says "GitHub Actions, running `release.yml` in `emyann/harness-kanban-board`, may
publish this package". The npm CLI trades the job's OIDC token for a short-lived credential and signs the
provenance with it, so there is nothing to store, nothing to rotate and nothing to leak.

## Every release: the tag

```bash
npm version patch      # or minor / major — writes package.json and creates the vX.Y.Z tag
git push --follow-tags
```

That is the whole release. `npm version` keeps the tag and `package.json` in step, which matters because the
workflow refuses to publish when they disagree — a tag that says `v1.4.0` over a `package.json` that says
`1.3.0` would put an unfindable version on the registry.

If you tag by hand, the two must match: tag `v1.4.0` ⇄ `"version": "1.4.0"`.

## What the workflow does

| step | why it is there |
| --- | --- |
| `npm run lint`, `npm test` ×2 (UTC and `America/New_York`) | a tag can point at a commit that never went through a pull request |
| `npm run smoke` | packs the tarball, installs it into an empty directory and runs the CLI from there — including `hkb init --no-labels` in a scratch repo, which proves the installed package can still copy the skill and the doc section out of itself. `npm test` proves the source is right; this proves the artifact is. `test.yml` runs it on every push too, but this workflow re-runs the suite itself rather than depending on that one, so it has to re-run the smoke as well |
| tag vs `package.json` | a mismatch is a lie about what is being published; the run fails and names both numbers |
| node ≥ 22.14, npm ≥ 11.5.1 | the floor npm documents for trusted publishing. Node 22 still bundles npm 10, so the step upgrades npm and then checks, rather than discovering it later as a bare "need auth" |
| repository vs `package.json` | only the repository npm trusts can publish. A fork gets a notice with the fix, not a red build |
| `npm publish --provenance --access public` | `id-token: write` lets npm exchange an OIDC token for both the publish credential and a signed attestation, so the package page shows where it was built from. No secret is read |
| `npx -y hkb-cli@<version> version` and `... help`, in a job with **no checkout** | the only step here that proves distribution works. Nothing from this repo is on that runner: if it passes, `npx hkb-cli` works for a stranger |

The verify job retries for up to five minutes — a publish is not instantly readable from every registry edge —
and then fails loudly. Longer than five minutes is not propagation; it is a broken package.

`publishConfig.provenance` is also `true` in `package.json`, so a publish that *cannot* attest fails rather than
quietly shipping unsigned. The practical consequence: releases go through CI. A manual `npm publish` from a
laptop will not work, by design — and now it cannot work, because no human token exists.

## Once, and already done: the trusted publisher

Recorded here because it is invisible from the repository, and because it is the thing to re-check when a
publish starts failing on authentication.

On npmjs.com → package `hkb-cli` → **Settings → Trusted Publisher**:

| field | value |
| --- | --- |
| publisher | GitHub Actions |
| organization or user | `emyann` |
| repository | `harness-kanban-board` |
| workflow filename | `release.yml` |
| environment | *(none)* |

Two consequences worth knowing before you refactor CI:

- **The workflow filename is part of the identity.** Renaming `release.yml`, or moving the `npm publish` step
  into a reusable or separate workflow, breaks publishing until the trusted publisher is updated to match.
- **A fork cannot publish `hkb-cli`, ever.** It has no trusted-publisher identity and there is no token to fall
  back on. The workflow says so in a `::notice::` and stays green: the tag and the tests are still a useful
  signal on a fork, only the publish is not available. To release your own fork, point `package.json`'s
  `repository` at it and configure a trusted publisher for your own package name.

Setting one up for a brand new package is a chicken-and-egg: the Settings page does not exist until the package
does. Publish `0.0.1` by hand once (`npm publish`, with 2FA at the terminal), then configure the trusted
publisher and never touch a token again.

## If a release goes wrong

- **The gate failed on a version mismatch.** Delete the tag (`git push --delete origin vX.Y.Z`), fix
  `package.json`, tag again. Nothing was published.
- **The publish failed on authentication** (`ENEEDAUTH`, `E401`, or a `404` on the OIDC exchange). This is the
  trusted publisher, not a missing secret. Check the four fields above still describe this workflow — a renamed
  file or a moved publish step is the usual cause — and that the `runner` step reported npm ≥ 11.5.1.
- **The publish failed otherwise.** Nothing is on the registry; fix and re-tag. npm will not let the same
  version be published twice, so if the publish half-succeeded, bump the patch rather than trying to reuse the
  number.
- **The publish succeeded but verify failed.** The version is live and broken. `npm deprecate hkb-cli@X.Y.Z "…"`
  with a pointer to the good version, then release a fix. Unpublishing is only possible within 72 hours and
  breaks anyone who already installed it.
