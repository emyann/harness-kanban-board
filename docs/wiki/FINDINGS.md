# Findings inbox

One line per suspected code defect, awaiting triage. Not a tracker: every item leaves through one of
four exits — fixed now, promoted into the page that owns it, filed in the issue tracker, or dismissed
with a reason — and the departure gets a `log.md` line. Treat every item as a **claim to re-verify**,
not a fact. Grammar and the triage rules are in `AGENTS.md`.

- [cleanup] **`hkb init` needs a forge even for a purely local board** — `init` resolves the repo through `gh repo view` and refuses a checkout with no remote (`no git remotes found`), so the store that exists to work with `gh` logged out cannot be created without one. Evidence `src/init.js` (`detectRepo` / the repo step) <!-- repolore:unanchored captured=2026-09-03 --> → architecture/local-store
