// A shim. The bodies moved to `src/store/github.js` (board state, behind the `Store` seam) and
// `src/forge.js` (pull requests, which are not board state — docs/local-first.md §6.4). Nothing
// here but re-exports, so no caller changed when the seam went in; new code opens a store instead
// (`openStore`, src/store/index.js) and this file goes when the last import of it does.
export {
  detectCaps, normalizeCardGrants, fetchBoard, fetchClosedRecent, getTask, assertOnBoard,
  blockersOf, blockersKnown,
  listComments, findRunComment, loadRun, saveRun, deleteComment, latestResult, addComment, parentResults,
  ensureLabels, setStatus, addLabels, setAgent, removeLabel,
  createIssue, updateBody, closeIssue, reopenIssue, issueDatabaseId, addBlockedBy, removeBlockedBy, issueEvents,
} from './store/github.js';
export {
  openPrsByHead, branchFallbackPrs, prMergeStates, enableAutoMerge, prChecksState, mergePullRequest, branchProtection,
} from './forge.js';
