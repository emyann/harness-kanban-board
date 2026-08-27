# Releasing hkb

Publishing is a tag. [`.github/workflows/release.yml`](../.github/workflows/release.yml) does the rest —
tests, the tag/version check, `npm publish --provenance`, and a clean-room `npx hkb-cli@<version>` that proves the
published tarball actually runs.

Two things stay with a human, because they are credentials and a decision.

## Once: the npm token

```bash
npm token create --read-only=false     # an automation token, on an account that can publish `hkb`
gh secret set NPM_TOKEN                # paste it when prompted
```

Until that secret exists the workflow still runs on a tag — tests and all — and then prints a `::notice::`
saying how to create it, and publishes nothing. It never fails red for a missing token, and a fork never sees
the secret at all.

Use an **automation** token: it is exempt from 2FA prompts, which a CI publish cannot answer.

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
| `npm run smoke` | packs the tarball, installs it into an empty directory and runs the CLI from there. `npm test` proves the source is right; this proves the artifact is. `test.yml` runs it on every push too, but this workflow re-runs the suite itself rather than depending on that one, so it has to re-run the smoke as well |
| tag vs `package.json` | a mismatch is a lie about what is being published; the run fails and names both numbers |
| `NPM_TOKEN` preflight | a missing secret is a notice with the fix, not a red build |
| `npm publish --provenance --access public` | `id-token: write` lets npm exchange an OIDC token for a signed attestation, so the package page shows where it was built from |
| `npx -y hkb-cli@<version> version` and `... help`, in a job with **no checkout** | the only step here that proves distribution works. Nothing from this repo is on that runner: if it passes, `npx hkb-cli` works for a stranger |

The verify job retries for up to five minutes — a publish is not instantly readable from every registry edge —
and then fails loudly. Longer than five minutes is not propagation; it is a broken package.

`publishConfig.provenance` is also `true` in `package.json`, so a publish that *cannot* attest fails rather than
quietly shipping unsigned. The practical consequence: releases go through CI. A manual `npm publish` from a
laptop will not work, by design.

## If a release goes wrong

- **The gate failed on a version mismatch.** Delete the tag (`git push --delete origin vX.Y.Z`), fix
  `package.json`, tag again. Nothing was published.
- **The publish failed.** Nothing is on the registry; fix and re-tag. npm will not let the same version be
  published twice, so if the publish half-succeeded, bump the patch rather than trying to reuse the number.
- **The publish succeeded but verify failed.** The version is live and broken. `npm deprecate hkb@X.Y.Z "…"`
  with a pointer to the good version, then release a fix. Unpublishing is only possible within 72 hours and
  breaks anyone who already installed it.
