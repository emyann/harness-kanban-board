// A shim. The ref-claim and CAS-heartbeat bodies moved to `src/store/github.js`, where they sit
// beside the issue half they share a driver with (docs/local-first.md §6.4: `claim`, `release`,
// `listLocks`, `lockBeatAt` and `heartbeat` are store methods); the repository's own branches — the
// base sha every claim is cut at and the `kb/track-<root>` integration branches — moved to
// `src/forge.js`, because a board that lives in a git branch still cuts its work from a forge.
// Nothing here but re-exports; new code opens a store instead (`openStore`, src/store/index.js).
export {
  claim, release,
  lockExists, lockSha, lockBeatAt, listLocks,
  localBeatSha, remoteName, casHeartbeat, resyncBeatChain, dropBeatChain, listBeatChains,
} from './store/github.js';
export {
  classifyClaimError, baseSha, staleBaseSha,
  ensureTrackBranch, trackBranchSha, deleteTrackBranch, listTrackBranches,
} from './forge.js';
