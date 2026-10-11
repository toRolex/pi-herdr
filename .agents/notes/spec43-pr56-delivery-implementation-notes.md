# spec43 PR56 delivery fixes

## Scope / seams

- Fixed baseline: 99431428cd7b3fc9937866281a8e29dc6fea7891; branch spec43-fix-delivery.
- SP1 / SP3 / R9 / R11 only. Main confirmed seams: registerDelivery notification entry; registered result/wait tools; real SDK + SessionManager durable host receipts and provider context.
- Own delivery event/governance entry (not pane-close section), src/sessionfile.ts helper, src/tools/result.ts and this group's tests/notes. Do not edit spawn/wait, parent group's ledger/push/parent-delivery or lifecycle close section. Production spawn/wait helper wiring is merger-owned; current version-control integration is parent-owned, no commit/merge/push or jj snapshot here.
- Offline only: strip inherited HERDR/PI_HERDR identity, inject fake fleet/close/status; symlink verified original integration node_modules (SDK 1.0.4), never modify dependencies.

## Decisions (evolving)

- SP1: legacy identityReviewRequired must deny new default body claims; preserve pre-existing durable receiver receipt / migrated pending as references only. No guessed historical identity.
- SP3: accepted stable agent/run start failures need one durable error declaration+immutable event archive before Push. Coordinated immediate spawn persistence with lifecycle and wait recovery with parent group.
- R9/R11: use notification-store acceptance and its own stable arbitration identity; diagnostic pushError cannot prove acceptance. Original completion reference belongs in non-arbitrating metadata.

## Red / green evidence

### Preserved first-pass evidence (not rerun/redone)

- SP1: `/tmp/spec43-pr56-delivery-SP1-red.log` showed legacy Push body acceptance; SP1-green passed. New Pull claims are denied for identity-review entries; existing receipts/pending remain references.
- R9: `/tmp/spec43-pr56-delivery-R9-red.log` showed failed durable acceptance not retried; R9-green passed. Diagnostic persistence does not imply notify-store acceptance.
- R11: `/tmp/spec43-pr56-delivery-R11-red.log` showed governance eventId equaled completion identity; R11-green covered both notice-before-final-commit and final-before-notice-commit. Real SDK JSONL/provider receives one complete final body.
- SP3 delivery-tick seam: SP3-red was `timeout` vs `available`; SP3-green passed normal/quiet/none, wait reference, Pull/event addressing and ACK. SP3-recovery passed unseeded ENOTDIR recovery, stable seed reconstruction, lineage/submitted preservation, and immutable archive plus bridge failure recovery.

### 2026-10-08 continuation — fixture first, real red next

- The old SDK SP3 failure was NOT a verified defect red: `isolated:true` with `cwd` was rejected by validation before acceptance. Fixed by removing spawn-param cwd; isolated resolves cwd via production launch rules and injected worktree adapter.
- Two further fixture corrections: capacity counts only receiver-owned registry panes, so add the fake occupying record (fleet alone did not queue); SDK 1.0.4 AgentSession uses `setActiveToolsByName`, not `setActiveTools`.
- `/tmp/spec43-pr56-delivery-SP3-sdk-real-red.log`: after all fixture fixes, actual queued acceptance + explicit queue drain rejection reaches real SDK wait assertion: `timeout` vs `available`. No delivery tick, Pull, or helper ran before wait. This is the real production no-tick defect red.
- `--persist-accepted-failure` explicitly invokes helper and writes receiver registry after launch rejection. The exact same real SDK/SessionManager flow then passes wait→Pull→ACK→no duplicate body→explicit followup with same agentId/new runId→old failure reread. `/tmp/spec43-pr56-delivery-SP3-sdk-helper-green.log`. This is helper-adapter green ONLY, not production spawn/wait wiring green. Default command keeps the defect red.

### Additional vertical helper fixes

- SP3-committed-retry: changed name/startError after a saved acceptance formerly threw committed-event conflict (real red); helper now validates existing immutable start-error archive identity/body and reuses original bytes/body. No infinite governance from merely changed diagnostic prose. `/tmp/spec43-pr56-delivery-SP3-committed-retry-{red,green}.log`. A missing host file initially blocked an added Pull assertion; fixed fixture, NOT counted as another defect red.
- SP3-late-pull: delayed older Pull formerly overwrote newer run `.exit` (real red); helper preserves a differently identified durable terminal bridge and returns its own immutable failure archive. Result consumes that returned sidecar only after registry publication, rather than reinterpreting latest bridge. `/tmp/spec43-pr56-delivery-SP3-late-pull-{red,green}.log`.
- SP3-pending-identity: early worktree failure can precede pendingRunId activation. Helper now refuses a different pendingRunId before writing any substrate/event; the caller must activate the accepted identity. Real red Missing expected exception→green, old run receives no failure archive/bridge. `/tmp/spec43-pr56-delivery-SP3-pending-identity-{red,green}.log`.
- SP3-archive-recovery (protective regressions, not claimed new defect red): archive temporary ENOENT→storage recovery; conflicting agentId/sequence and identityReviewRequired refuse overwrite; non-pi/no-startError no-op; registry publication EISDIR yields governance note/no body/no ledger claim, recovery consumes retained immutable failure. `/tmp/spec43-pr56-delivery-SP3-archive-recovery-green.log`.

### Final local matrix

- `env -u HERDR_BIN_PATH node tests/spec43-pr56-delivery-fixes.mjs`: 8 groups green (SP1, SP3, SP3-recovery, SP3-committed-retry, SP3-late-pull, SP3-archive-recovery, SP3-pending-identity, R9); `/tmp/spec43-pr56-delivery-final-local-green.log`.
- `env -u HERDR_BIN_PATH node tests/spec43-pr56-delivery-sdk.mjs R11`: both actual host-commit orderings green; `/tmp/spec43-pr56-delivery-final-sdk-R11-green.log`.
- `env -u HERDR_BIN_PATH node tests/spec43-pr56-delivery-sdk.mjs SP3 --persist-accepted-failure`: explicitly helper-wired real SDK flow green; `/tmp/spec43-pr56-delivery-final-sdk-helper-green.log`.
- `env -u HERDR_BIN_PATH node tests/spec43-pr56-delivery-sdk.mjs SP3`: expected genuine production red, `timeout` vs `available`; `/tmp/spec43-pr56-delivery-final-sdk-no-tick-red.log`.
- `env -u HERDR_BIN_PATH npm run typecheck`: green; `/tmp/spec43-pr56-delivery-final-typecheck.log`.
- Tests clear inherited HERDR/PI_HERDR identity and select their own fail-fast fake Herdr binary, so an unexpected adapter can never alter a real pane. Verified runtime SDK 1.0.4 / Node v24.19.0; no claim for 1.0.2/Node22/Windows in this continuation.

## Merger integration contract — not implemented here

`saveAcceptedStartFailure(record: AcceptedStartFailureRecord): errorSidecar | undefined` is synchronous. Non-pi/no-startError returns undefined; unactivated pending identity, missing/review identity, storage or committed-identity conflict throws. Empty substrate uses stable acceptance time/run; never inserts fictitious assistant history, changes lineage, submitted, startedAt or pane ownership. A returned sidecar is a durable immutable event, not proof of receiver body delivery. Different terminal bridge is preserved; event archive remains authoritative.

1. In `src/spawn.ts` queue drain failure (`startRecordNow` result at current ~1764), and detached async start result/rejection (~2128), finalize definitive *accepted* failure with original error in startError, correct accepted run identity, helper, then registry persistence. Catch both rejected Result and thrown/rejected Promise. Persistence failure remains visible/retryable; do not retry launch of that accepted failed run simply to retry storage. Preserve the original startError/accepted identity in the registry even when helper throws, and persist any newly seeded sessionPath as well; record storage failure separately as governance pushError, not as a replacement launch error. Detached callbacks must also catch/report registry persistence rejection rather than leak an unhandled promise. Do not mark delivery/ACK/submitted true.
2. Activate accepted `pendingRunId` before any failure can be attributed: current startRecordNow attempts isolated worktree at ~1206 but activates pendingRunId at ~1222. An early failure otherwise names the preceding run. Merger must coordinate lifecycle's run reset; helper deliberately throws instead of guessing/promoting identity itself. Do not blindly save every startError: retry-in-flight idle-followup submission failure, uncertain submission, and synchronous spawn refusal before returned acceptance are not definitive accepted-start events.
3. `src/tools/wait.ts` discover/findEvent recovery for old persisted definitive startError: call helper under identity guard, persist newly seeded sessionPath, keep storage failure unavailable (diagnostic only), then inspect durable event. For name/current-run lookup, include current immutable `.completion-<record.runId>.json` fallback, not just `.exit`, because delayed retry preserves another run bridge. Handle each missing/invalid candidate independently so absent `.exit` cannot hide a valid archive. Enforce eventId/body and exact agent/run/sequence; legacy review remains unavailable. Retained historical event lookup is allowed by eventId with same-agent identity, never with another agent's archive. No body/claim/ACK in wait; preserve parent group's deadline/abort fixes.
4. Result and delivery already call helper for storage recovery; they are not a substitute for production failure-point persistence. Use helper-returned canonical sidecar, especially when latest bridge belongs elsewhere. Direct helper or a forced tick before wait cannot be used to claim no-tick production green.
5. Merger must run default SDK SP3 (no adapter flag) green after wiring, plus thrown async-start failure and old-registry/no-tick restoration, correct pendingRunId early failure, storage retry without second launch, and newer bridge/archive fallback. Add both new scripts to integration npm test; the default SDK script includes SP3 and R11 and is intentionally red until production wiring lands. Full suite/typecheck/SDK matrix belongs to integration; no old evidence regeneration here.

## Deviations / limits

- No live pane / CLI / TUI; no across-crash exactly-once claim. package.json test list unchanged. Full suite is explicitly deferred to integration, avoiding regeneration of older evidence in this worktree.
- Bridge identity check + publication is synchronous within the supported single writer; not an atomic multi-process compare-and-replace guarantee. Hardlink/rename/fsync failures stay visible/retryable; Windows and real power-loss durability are not verified.
- Original-worktree phase: no version-control command/snapshot, submit, merge, push, reset, restore or cleanup of retained worktree state ran. That phase edited only src/sessionfile.ts, src/tools/result.ts, the two delivery tests, and this existing note; earlier delivery.ts fixes were preserved unchanged.

## Authorized jj workspace continuation

- Coordinator authorized existing `/Users/rolex/Documents/Codes/githubProject/MyProject/pi-herdr.spec43-pr56-jj-delivery` (base 9943142, described change mtyqpzlrumku), jj-only writes, Git read-only. No initialization or snapshot of the original main/worktree; effective Git/jj identity and change author both rolex <torolex@163.com>.
- Target src/delivery.ts, src/sessionfile.ts and src/tools/result.ts were Read and compared byte-for-byte to 9943142 before replacement. Three new files created with Write; all six source copies initially byte-for-byte matched the preserved original delivery worktree. No old evidence copied; all fresh logs use `/tmp/spec43-pr56-jj-delivery-*`.
- Before integration merge: 8 local groups, SDK helper-adapter SP3, both SDK R11 orderings and typecheck passed; default SDK SP3 remained actual wait timeout vs available. Logs `/tmp/spec43-pr56-jj-delivery-pre-{local-green,sdk-helper-green,sdk-R11-green,typecheck,sdk-no-tick-red}.log`.
- Executed requested `jj new @ spec43-pr56-jj-integration -m 'merge(spec43): 交付修复纳入当前整合基点'`. Integration at merge was xquwxokvvzrs / 07ca3943e2e9 (child+lifecycle already integrated); other parent mtyqpzlrumku / 190d08f71914 (six delivery files). Merge change xmtyvwuoytuq had no conflicts; lifecycle close changes retained automatically, without touching original worktree.
- After merge: all 8 local groups, actual SDK helper-adapter SP3, both SDK R11 orderings and typecheck passed again. Default SDK SP3 still fails at wait timeout vs available, not a fixture error; no assertion weakened or production entry patched. Fresh logs `/tmp/spec43-pr56-jj-delivery-post-{local-green,sdk-helper-green,sdk-R11-green,typecheck,sdk-no-tick-red}.log`.
- Production spawn/wait blocker and helper contract above still apply. Only spec43-pr56-jj-delivery bookmark is to be created/moved to this merge change. No push, other workspace/bookmark edits, original-worktree modification, or old evidence copy.
