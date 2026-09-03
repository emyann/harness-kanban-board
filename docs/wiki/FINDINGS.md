# Findings inbox

One line per suspected code defect, awaiting triage. Not a tracker: every item leaves through one of
four exits — fixed now, promoted into the page that owns it, filed in the issue tracker, or dismissed
with a reason — and the departure gets a `log.md` line. Treat every item as a **claim to re-verify**,
not a fact. Grammar and the triage rules are in `AGENTS.md`.

- [bug] **`hkb archive` always closes as `not_planned`, never `completed`** — `setStatus` sets `task.status = 'archived'` in place, so the `task.status === 'done'` the next line tests can never be true; both drivers do it, so both are wrong the same way. Evidence `src/lifecycle.js` (`archive`), `src/store/github.js` (`setStatus`), `src/store/git.js` (`syncTask`) <!-- repolore:sha=f5e110c captured=2026-09-03 --> → architecture/store-seam
- [bug] **the local store's `saveRun` event payload is always `attempt=null profile=null host=null`** — it reads `rec?.attempts`, but a run record is `{run, id}`, so the attempt it means is `rec.run.attempts`. Visible in `hkb log` on a local board, where those rows carry no attempt number. Evidence `src/store/local.js` (`saveRun`) <!-- repolore:sha=14e51c7 captured=2026-09-03 --> → architecture/local-store
- [cleanup] **`hkb init` needs a forge even for a purely local board** — `init` resolves the repo through `gh repo view` and refuses a checkout with no remote (`no git remotes found`), so the store that exists to work with `gh` logged out cannot be created without one. Evidence `src/init.js` (`detectRepo` / the repo step) <!-- repolore:unanchored captured=2026-09-03 --> → architecture/local-store
