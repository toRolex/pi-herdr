# spec43 result ACK fixture diagnosis (2026-10-11)

## Scope and cause

- Independent owned JJ workspace based on integration `88be1fe4`; no changes to #51 worker, old workspaces/bookmarks/stash or old evidence.
- #51 supplied the exact command: `HOME="$PWD/.scratch/t51/home" JITI_FS_CACHE=false JITI_MODULE_CACHE=false node tests/spec43-t3-result.mjs`.
- Reproduced original line 140: actual `delivered`, expected `pending` (not the reverse). Source-bound registered consumption legitimately confirms the real SessionManager disk receipt. The fixture's injected ACK failure was absent: disabled Jiti module caching gives the separately imported DeliveryLedger a different class identity from the source dependency.
- Added a repeated-import identity assertion: RED under the exact disabled-cache environment. Explicit `moduleCache: true` fixes the fixture's fault-injection binding without changing production source or the public `registerResultTool.execute` seam. All semantic assertions remain, including persisted receipt, failed-ACK pending ledger, one confirmation error, durable repair, and no duplicate body.
- The old fixture's real JSONL receipt was valid durable evidence of body persistence; it was NOT evidence that the intended ACK write failure had occurred. Prototype patching a separate class cannot force the host-bound ledger to fail. No mock/in-memory return is promoted to durable host evidence.
- Evidence destination can be overridden by `SPEC43_T3_RESULT_EVIDENCE_DIR` (URL, resolved relative to the test). Diagnostic runs use owned `.scratch/result-diag/evidence/`, leaving old evidence untouched.

## Actual checks

- Original single-file command: exit 1 at line 140 (`delivered` versus `pending`). Log: `.scratch/result-diag/red.txt`.
- Same command with added module identity assertion: exit 1 at the new identity guard. Log: `.scratch/result-diag/identity-red.txt`.
- Same HOME and disabled-cache flags plus owned evidence destination, with explicit fixture module cache: exit 0. All real ExtensionRunner/provider scenarios pass (push-first, pull-first, queued-stale, parallel-pulls, concurrent-push-pull). Log: `.scratch/result-diag/green.txt`.
- Fresh integration advanced to `0ca25bb150cc`; merged with fixture fix `0f9aedd4`, then reran the same single-file command: exit 0. Final log `.scratch/result-diag/final-green.txt`; final evidence `.scratch/result-diag/final-evidence/`. No conflicts.
- This is local real SDK/SessionManager disk evidence with offline provider, not a production service/network claim. Only this test file was run.

## Deviations

- Workspace creation with `--ignore-working-copy` created an empty owned workspace but could not initialize its revision; initialized only that new workspace with `jj new spec43-20261011-integration`. No old working copy was snapshotted or edited.
- Narrow fixture repair only; no production source change, no other ticket work, no full suite, no publish or service/permission operations.
