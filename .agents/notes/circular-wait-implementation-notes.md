# Circular wait repair

## Bug fix checklist

- [x] 1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables). Don't hand the repro to the user. A debug or instrumentation protocol that says to ask the user does not override this. You drive the instrumented runtime. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. Won't reproduce directly, force it: synthesize the trigger, tighten conditions, or instrument until it fires.
- [x] 2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Cursor's `/loop` command. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
- [x] 3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default `grok-4.6-fast-xhigh`) with a specific scope. Review the diff.
- [x] 4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
- [ ] 5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd-pstack** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
  skip: User forbids commits. Keep failing evidence and patch uncommitted.
- [ ] 6. Run **Opening a PR**.
  skip: User requests product repair without commits or PR.

## Throughput checkpoint

- Blocking first steps. Full skill and SDK reads, owned live circular RED, root cause to orchestrator, architect selection before production implementation.
- Independent workstreams. Orchestrator owns architect exploration. This worker owns circular regression and selected minimal production patch. No shared file writers.
- Shared mutable state. Unique temporary cwd and agent-name prefix per invocation. Never inspect other project transcripts or interrupt preexisting agents. Close only matched test cwd and unique names.
- Smallest safe decomposition. One worker owns communication proof and product patch so the regression exercises the exact changed path. Architect must choose before implementation.

## Data shape

CircularExchange is a state sequence. Parent waits for child completion. Child sends CHILD_QUESTION_NEEDS_ACK through real messageAgent and stays in live model/tool loop. Parent must consume that message and send PARENT_ACK through real messageAgent. Child may emit CHILD_COMPLETE_AFTER_ACK only when the model context contains ACK.

Foreground result waits and background workflow result waits are different owners. A foreground wait blocks model consumption of queued steering. A background wait must continue without preventing the orchestrator from processing messages.

## Principles read and applied

Fix Root Causes requires a circular repro, not a stopped provider or settled receiver.
Model the Domain separates wait ownership and models the exchange before test logic.
Test Behavior, Not Implementation requires a real child question, actual parent ACK, actual child ACK consumption and completion.
Prove It Works requires the same real CLI/TUI loop after patch.
Build the Lever creates tests/circular-wait-live.mjs so the reviewer can rerun the complete exchange.
Laziness Protocol constrains the patch to the demonstrated wait/message boundary, with no unrelated abort or transport redesign unless the architect justifies it.

## Evidence

node tests/circular-wait-live.mjs reproduced twice after fixture boot corrections. Legacy adapter forwards wait=true into current real result engine. Parent and child are real isolated Pi TUI processes.

Exact failed output on second confirmed run.

```text
QUESTION_SENT parent=working child=idle
RED parent consumed question and replied=false; elapsed=2509ms
Steering: <agent-message from="circular-ekdqa7" to="orchestrator">
herdr_get_agent_result target="circular-ekdqa7" wait=true
CHILD_STATE agent_status=working
$ sleep 0.1
AssertionError: parent must consume child question and send ACK within 2.5s while waiting for child
```

The initial child idle observation occurs immediately after boot. The later actual CLI status is working and the pane shows repeated sleep tools. The child never settles before ACK. The parent has no ACK result or consumed question entry. Steering shows physical delivery but cannot establish model consumption.

## Ranked hypotheses sent before implementation

1. Foreground wait ignores incoming input and only ends on child terminal status. Prediction. Wake this wait on input without aborting other tools and the parent can consume the queued question.
2. Message lost or addressed incorrectly. Refuted by real envelope queued in parent Steering.
3. Child is actually idle and result inspection is incorrect. Refuted by live working status and repeated tool loop waiting for ACK.
4. Switching steer to followUp fixes scheduling. Rejected by SDK contract. Both need the running tool to complete first.

## Root cause and options

Child completion requires parent ACK. Parent result wait requires child completion. Parent model consumption of the queued child message requires result tool completion. This closes the cycle. Current snapshot-only adapter does not remove the internal wait engine or repair this mechanism for previously wait-forwarding adapters.

Sent root cause and options to orchestrator. Await architect selection before crossing function boundaries.

A. Foreground-only input event wake returns an interim result. Background workflow wait remains terminal-only.
B. Mailbox transport plus message-aware foreground waits.
C. Bounded foreground wait with explicit continuation guidance.

## Input event probe and baseline controls

The tool-pending input event is measured, not inferred. A parent input handler wrote an input event at 1791020848841 with streamingBehavior=steer and the actual child envelope. At the next 2.523s checkpoint the result tool was still pending, the message remained Steering, and child bash polling remained working. Input observation is early enough to wake the foreground result wait. The fixture log records event payload only, no session secrets.

Snapshot control passed a strict real ACK receipt assertion and CHILD_COMPLETE_AFTER_ACK assertion. node tests/circular-wait-live.mjs --snapshot. This does not count as the product fix.

Busy parent control passed node tests/circular-wait-live.mjs --snapshot --busy. The parent starts independent bash sleep 7 in the same model tool batch as result inspection. At child question arrival the parent is working and input streamingBehavior=steer. Parent ACK is sent after the unrelated tool completes naturally, within the 2.5s question deadline. The unrelated tool result must include UNRELATED_TOOL_FINISHED and must not be an error. This checks no collateral abort. A tool that never ends is deliberately outside this release mechanism.

Background workflow control passed the same complete exchange. node tests/circular-wait-live.mjs --snapshot --workflow. The parent ran a real background workflow; child sent the actual question; the parent actually sent ACK; child consumed ACK before completion. This remains required after the patch.

The orchestrator launched two independent architects. Candidate A initially restored model-facing wait and defaulted wake off. Both choices are rejected. Current snapshot-only tool schema stays unchanged. A revised sketch uses an extension-scoped default wake observed by legacy-compatible direct engine callers, with explicit background opt-out in the workflow host. The epoch must remain fixed for the entire call. Poll and wake listener must clean up the loser. No product edit until orchestrator selects.

## Selected patch and verification

The orchestrator selected revised A after two independent architect candidates. src/inputwake.ts owns InputWake, an epoch and subscriber set. registerResultTool registers the input observer and session lifecycle scope. getAgentResult captures one epoch for the entire call and returns a truthful interim result with interruptedByInput when that epoch changes. Its sleep has one shared cleanup for timer, input subscriber and abort listener. Subscription rechecks the epoch after subscribing. Terminal evidence remains authoritative. Abort is rechecked after inspection.

The current model-facing result schema and single-shot execute remain unchanged. The legacy-compatible fixture still calls getAgentResult(params, {signal}) unchanged. It picks up the registered default scope from the actual new production engine. src/workflow/host.ts explicitly opts out with inputWake:null so background waits retain completion semantics.

One default session scope per loaded engine is supported. Multiple extension instances sharing that engine fail explicitly on a default wait instead of silently waking another session. Explicit inputWake or null remains usable. Session start replaces and retires the old scope; shutdown retires it and wakes owned waiters. The guard, explicit isolation, scope replacement and scope cleanup are unit-tested. This is an explicit SDK constraint, not an inference from the existing global registry.

Same command as RED, now real GREEN four times.

```text
node tests/circular-wait-live.mjs
GREEN parent consumed question and replied=true; elapsed=565ms
GREEN full circular exchange progressed and child completed after ACK
```

Further repetitions measured 567ms, 567ms and 570ms. Each child actually called messageAgent and awaited model-visible ACK before its final result. Parent result receipt must report delivered=true, not merely contain ACK text.

Busy mode passed with ACK at 1440ms after question arrival. The independent bash result included UNRELATED_TOOL_FINISHED and was not aborted. Workflow mode passed the complete question, ACK and aggregate completion chain. Ordinary user input was persisted as user context and followed by an additional actual assistant answer.

node tests/input-wake.mjs passed input-during-inspect, input-before-subscribe, synchronous subscribe wake, broadcast, poll cleanup, input cleanup, abort cleanup, bounded expiry, default legacy wake, background opt-out, session lifecycle, multiple-instance guard and explicit isolation. npm run typecheck passed. Full npm test passed with inherited PI_HERDR child variables removed. Full output is /tmp/pi-herdr-circular-unit-suite.log. Initial smoke failure counted registered lifecycle handlers; its expectation is updated to include the new input scope.

Independent review found an abort listener leak when a custom subscribe synchronously calls its listener. The original synchronous-subscribe test lacked an AbortSignal. Added getEventListeners(signal, 'abort').length===0. It failed with actual 1 before the patch. The finished branch now removes the newly registered abort listener as well as the returned subscription. Unit and typecheck passed, and same live circular command passed again with ACK at 566ms, completed child ACK consumption and ordinary user answer. No background finite-deadline behavior was changed; the old background poll may overshoot a numeric deadline by its poll interval.

Old processes have already registered and imported closures. Changing disk files cannot replace a pending old execute call. A fresh process or safe reload is necessary to activate this patch. No old pane was aborted, reloaded or messaged. An unrelated tool that never completes can still delay Pi steering consumption; this patch releases only result waits and never aborts unrelated tools.

## Deviations

Production edits follow the selected design. Existing unrelated dirty files and prior turn-release fixtures are preserved. Cross-function architecture selection was performed by the orchestrator's design exploration. Initial harness failures were boot/fixture issues, not counted as circular RED.
