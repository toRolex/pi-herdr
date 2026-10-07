# spec43 T6 (#49) implementation notes

- Added `herdr_wait_agent_event`, separate from result retrieval. It resolves durable completion event sidecars (`.completion-<eventId>.json`) and legacy `.exit`, returning only status and identity references; body fields are never copied.
- Wait is read-only. Per-call AbortSignal and deadline exit without changing child/run state or event files. Listener set is broadcast, not a queue, so waiters and repeat calls can observe the same event.
- Added injectable watcher hook plus polling fallback; the persisted event is rechecked on every wake, so reload/reentry recovers from durable storage rather than volatile wait state.
- TDD: `tests/spec43-t6.mjs` first failed because the wait module did not exist, then exercised arrival, cancellation, timeout, non-body response and multiple waiters.
- Host demo limitation: this environment is an agent sub-session without a reliable real child spawn/TUI lifecycle; `tests/spec43-t6-live.mjs` is a host registration/timeout/cancel smoke probe, not full end-to-end proof. Full live event-first/wait-first/result-recovery remains a risk.
