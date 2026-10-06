# #39/#40 live lineage fixes

## Scope / seams
- Only this worktree, base 712692a. No integration edits, push, issue closure, or nested spawn (depth 3).
- User-approved seams: messageAgent explicit delivery; deliverOnce disk registry/typed sidecar → SDK push and pane close.
- Live evidence: /tmp/spec29-live-C-20261006-140741. Root has no SpawnRecord; its direct child's ownerSession/rootSession and orchestratorPane identify the root. Leaf exits into shell: agent_status unknown.

## Hypotheses
1. #40 knownLive only indexes spawned records, omitting root. Predict root pane derived from root-owned records closes bypass while strangers stay open.
2. #39 adoption idle/done-only gate discards typed terminal declarations when pane is unknown/absent. Predict exact root/owner lineage + typed sidecar restores delivery without accepting working/blocked.
3. Registry/fleet read failure could mimic absence. Preserve failure skips and current takeover/ack/serial guards.

## Decisions
- #40 index the root pane from a root registry's direct child only when rootSession and ownerSession both equal that root; require fleet presence. Root has no synthetic SpawnRecord. Direct parent shortcut and truly external panes remain allowed.
- #39 healthy fleet + owner pane absent + child's exact owner/root lineage + typed terminal permits unknown/absent leaf recovery. Working/blocked remain excluded. Current takeover marker still holds close.
- #41 added by coordinator: synchronous sendMessage throw before SDK enqueue releases pending token for same-sink retry. Asynchronous void outcome and pending/timeout retain original token. Disk ACK, durable owner mark, awaited close, serial pass unchanged.

## Validation
- message red: 89/91, known-root bypass reproduced; green: 91/91.
- delivery-lineage-sdk red: unknown-shell terminal queued 0 instead of 1; green validates actual SDK queue → disk custom entry → owner mark before close; fresh sink dedupe, fleet failure, active statuses, lineage conflicts, malformed sidecar, takeover, absent leaf.
- #41 SDK wrapper red: repaired dispatch attempts 1 instead of 2; green same sink repairs, waits for disk ACK, never double-enqueues pending outcome.
- Targeted message + delivery entry/SDK/durable/reload/registry-failure + delivery 169/169 + tsc passed. Log /tmp/spec29-livefix-targeted.log.
- Full npm test passes with inherited PI_HERDR_* removed: /tmp/spec29-livefix-full-clean-env.log. First ambient-env attempt fails existing substrate child assumptions; not a code failure.
- Integration tip remained 712692a at validation. No integration edits, pushes, pane operations or issue writes.

## Deviations
- No additional agents: user forbids spawn at depth 3.
