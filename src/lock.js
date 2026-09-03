// A shim. The ref-claim and CAS-heartbeat bodies moved to `src/store/github.js`, where they sit
// beside the issue half they share a driver with (docs/local-first.md §6.4: `claim`, `release`,
// `listLocks`, `lockBeatAt` and `heartbeat` are store methods). Nothing here but re-exports; new
// code opens a store instead (`openStore`, src/store/index.js).
export {
  baseSha, staleBaseSha, classifyClaimError, claim, release,
  ensureTrackBranch, trackBranchSha, deleteTrackBranch, listTrackBranches,
  lockExists, lockSha, lockBeatAt, listLocks,
  localBeatSha, remoteName, casHeartbeat, resyncBeatChain, dropBeatChain, listBeatChains,
} from './store/github.js';
