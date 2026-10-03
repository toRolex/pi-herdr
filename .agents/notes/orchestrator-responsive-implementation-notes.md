# Orchestrator responsive bug

## Playbook checklist

- [x] 1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables). Don't hand the repro to the user. A debug or instrumentation protocol that says to ask the user does not override this. You drive the instrumented runtime. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. Won't reproduce directly, force it: synthesize the trigger, tighten conditions, or instrument until it fires.
- [x] 2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Cursor's `/loop` command. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
- [x] 3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default `grok-4.6-fast-xhigh`) with a specific scope. Review the diff.
- [x] 4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
- [ ] 5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd-pstack** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
  skip: shared dirty tree contains unrelated changes; keep test delivery uncommitted.
- [ ] 6. Run **Opening a PR**.
  skip: no product fix is warranted; shared dirty tree is not a safe PR base.

## Throughput checkpoint

Deliver a seconds-scale repro first. Root-cause evidence and ranked hypotheses go to orchestrator before implementation. Independent how/why investigators are owned by orchestrator. Cross-function fix requires architect exploration before implementation. Only task files may change.

## Data shapes

- `GetResultParams` is inspection input. Model-facing registration omits wait and strips extra input. Internal workflow host uses wait intentionally in background.
- `SpawnRecord` owns background lifecycle and session metadata, not parent turn lifetime.
- `SteeredMessage` is asynchronous local completion report. `MessageParams` is cross-pane interactive input. They share a user-visible symptom but not a transport.
- Parent turn can be `tool pending`, `provider streaming`, or `settled`; child liveness must not keep the first two alive by itself.

## Evidence

- Repo HEAD 6b570ec, herdr 0.9.3.
- `5938572` explicitly made model-facing spawn return accepted starting/queued. Current result registration is snapshot-only. Current workflow registration detaches `started.done`.
- Former diagnostic proved Enter creates steer while receiving pi streams; idle receiver does not queue steer. That is not evidence of the parent tool hang.
- Unrelated dirty tree baseline retained, including deleted CONTEXT.md and untracked skill links.

## Decision trail

- Fix Root Causes changed the choice from editing delivery flags to measuring the active parent turn/tool boundary first.
- Model the Domain separates model-facing snapshots from internal workflow waiting. Do not remove the latter simply to eliminate wait.
- Prove It Works requires actual CLI/TUI delivery and parent settling, not mocked send assertions.

## Deviations

- No raw git worktree or commits/PR. Orchestrator delegated a narrow runtime inspection after how investigator failed twice. Read only the final 30 entries of the screenshot parent's session, exposing tool IDs/timestamps and truncated arguments, not project source or the full conversation.
- No product code fix. Current code already implements the required non-blocking boundary; editing it would obscure the stale-runtime diagnosis.
- Architect skipped because delivery adds tests/fixtures only, with no production cross-function fix.

## Confirmed mechanism

Live parent w5J:p1 pid95702 started 2026-10-02 11:44. Disk package is 6b570ec/1.0.0. Narrow runtime trace records get_result(wait:true) from 06:49:26 to 07:53:52 (64m26s), then 07:56:37 to 08:03:56 (7m20s), then 08:06:33 to 08:11:56 (5m23s). The 08:12:09 call had no result at inspection. Thus the actual parent runs the old wait-accepting registration. Exact loaded closure version is inferred, not inspected in memory. Disk update does not replace already-registered closures. 4418297 removed model-facing result wait on Sep28; 5938572 removed model-facing spawn wait on Oct3.

Busy pi Enter intentionally queues steer until the real tool finishes. Changing it to followUp cannot release an awaiting tool. A settled parent receives messages as ordinary turns. Busy-time Enter remains unchanged.

## Verification

- `node tests/turn-release-live.mjs --legacy-result` exited 1 after 2.5s with `AssertionError: parent must finish within 2.5s while child has 8s of work`. Legacy adapter restores old wait-forwarding at the registered tool boundary; all CLI/TUI, get engine, spawning and child tools remain real.
- Current `node tests/turn-release-live.mjs` passed. Latest parent settled in 433ms; spawn/result returned, ordinary user turn succeeded while child worked, real messageAgent CLI delivery reached idle parent, child completion and workflow reports arrived asynchronously.
- Independent orchestrator run passed at 439ms and observed legacy RED.
- Related suites passed message 45/45, workflow 134/134, workflow-journal-saved 61/61, delivery 101/101. Delivery requires removing all inherited PI_HERDR child env, particularly PI_HERDR_IDLE_REARM_MS; a partial cleanup reproduced 4 environment-contaminated assertions.
- LSP changed three test files clean, 0 diagnostics. `npm run typecheck` passed.
- Plain npm test under child environment failed substrate because inherited PI_HERDR_SESSION changes its no-op assertion and sidecar setup. Re-run with child env removed progressed through spawn grid tests but exceeded 100s; full suite is inconclusive, not green.
- Test uses unique per-invocation child names and verifies temp cwd ownership before saving pane/tab IDs. Cleanup closes the invocation's uniquely named parent first, then tracks matching owned children for 5s and closes recorded child tabs. Early legacy failure exercises cleanup. The 5s sweep is a finite safeguard, not proof against arbitrary late launcher completion. The test does not claim every pending OS launch is synchronously cancelled by parent close. Snapshot asserts successful non-error structured status; workflow completion must include CHILD_COMPLETE, not just run name.
- The deterministic provider selects stop after tool results. This proves parent/child lifecycle separation, not that any real model always chooses to stop instead of polling or sleeping. Message completion asserts a new parent answer rather than a stale idle state.
- Test cleanup targets only the invocation's children and parent tab. Child group tabs auto-remove after pane completion. No pre-existing acceptance panes were interrupted.

## Safe activation

Fresh pi process loading current package is verified. Do not send Escape or abort to existing parent without permission. Allow its outstanding child wait to complete naturally, then `/reload` to replace extension closures. Reload resets in-memory spawn registry and may abort workflow-owned children via shutdown, so retain handle/session metadata first; for safest continuity use a fresh parent while old process/children finish. No legal API swaps a registered execute closure that is already awaiting.
