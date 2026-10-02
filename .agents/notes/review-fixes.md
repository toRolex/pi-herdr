# Review fixes — int/spec-1

## Scope and decisions

Continue the interrupted fixer's edits, not a rewrite. TDD skill loaded; orchestrator confirmed the existing seams: planGridPlacement/splitFor, spawnAgent/startRecordNow with the herdr boundary fake, and registered live tool execute.

1. **Seventh occupant:** main counts toward six. Restore the precise main + five boundary; consume openedTab, create an unfocused tab and attach to its shell. Overflow creation carries workspace and child environment. Missing tab/shell refuses instead of silently splitting the full tab.
2. **Concurrent START:** retain predecessor's widened critical section (observe → plan → create pane → register seat). Regression checks not only distinct cells but that the second start actually targets the first newly created pane.
3. **Hole reuse:** retain split-then-swap for an upper hole; add equivalent left-hole handling. Resolve embedded `{new}` only after pane creation; do not send a placeholder argv before start. Failed swap propagates, with paneId retained and no false seat registration. Remove the test fake's artificial placeholder substitution.
4. **Nonblocking tool live coverage:** update tests/spawn-live.mjs to assert starting/queued acceptance before completion even with legacy wait supplied; child runs real `bash` (`sleep 15; echo ...`), then parent observes active bash after return and pulls final session result through get_agent_result. Model-pinned check also waits via inspection, not spawn.
5. **Lock budget/cancellation:** gridTimeoutMs defaults to 30s; AbortSignal and expiry return TIMEOUT. A cancelled waiter remains ordered behind its predecessor, preventing later starts from bypassing the owner. Release and timer/listener cleanup happen in finally.
6. **Pure argv:** createGridTabArgs handles workspace, label, no-focus and env for both group and overflow tabs.
7. **Environment:** one buildChildEnv supplies pane and tab launches, including PI_HERDR_IDLE_REARM_MS and trusted extraEnv overrides.
8. **Seat vocabulary:** shared GridSeat is used by GridPlacement and claim; existing gridAt/gridTab fields use indexed GridSeat types to preserve consumers without a registry migration.

Also fixed the interrupted patch's TS2339 double-unwrapping, deleted debugging logs, corrected misleading capacity tests.

## TDD evidence

- Red: strengthened upper-hole assertion exposed two swaps, one containing literal `{new}` (202/204, the other failure was pre-existing listAgentTypes).
- Green: corrected deferred argv substitution, added left-hole, lock timeout/abort/no-bypass, predecessor split-target and env parity regressions.
- Existing listAgentTypes assertion read developer-local registry files, contradicting its expected session + built-ins fixture. Supply explicit absent fixture dirs through its existing public dirs parameter; product behavior unchanged.

## Validation

- PI_HERDR_* unset for offline commands.
- npm test: all suites passed; spawn 210/210, grid initially 21/21 then 22/22 with left-hole regression.
- npm run typecheck: passed.
- Active LSP check of all five changed source/test paths: no type errors; auxiliary style hints/warnings remain.
- git diff --check: passed.

## Deviations / limits

- Live suite authored but **not executed** this run: earlier agents were interrupted by provider 503s, and no reliable paid-model live run was established. Thus issue #2 AC1/AC4 has an executable acceptance design, not claimed empirical live evidence. Run `node tests/spawn-live.mjs` inside a configured herdr session to establish that evidence.
- Lock timeout bounds waiting, not an injected implementation that ignores its AbortSignal forever; real herdr operations retain their own timeout boundary. Do not release an active critical section merely because a later waiter expires.
- Kept gridAt/gridTab compatibility rather than changing every registry consumer.
