# spec29-t37 pending inbox

## Decisions

- Capacity is 8 (`PENDING_CAP`). A pi fleet is a handful of panes on one machine; eight pending messages waiting on one idle pane is already a burst. The number is in the aggregate receipt, the tool description, and `docs/tools/message.md`. Not the CC 50 or 100.
- The queue is accepted-but-not-yet-typed text for one pane, in this process. It is not the per-sender rate window from #36. Rate limit still runs first and still refuses without delivering.
- Holding only happens when the caller passes `pending: true` and the target is idle. `working` keeps typing immediately: existing tests treat a working child as "queues natively" inside the pane, and rewriting that would change #36's idle deliveries too. `done` (and `working` / `blocked`) drain the inbox oldest-first, then type the new message.
- Overflow drops the oldest pending item only. Text already returned as delivered is not in the inbox, so a later overflow cannot rewrite it.
- One aggregate receipt per burst, returned on the call that caused the drop. Later drops in that burst say they are folded into the open receipt and are not an additional receipt. The receipt is the call result, never a `send` into the pane, so it cannot loop. A dropped sender who was not the caller hears a personal note on their next `messageAgent` call; that note says it is not a new receipt.
- A drain that fails to type restores the untyped remainder. Items already typed in that drain stay typed.

## Deviations

- The ticket says the accepted pending queue has a cap, but the public `messageAgent` path typed every non-blocked send immediately. Pending is therefore an explicit `pending: true` on an idle target, not an implicit hold of every working send. Holding every idle send would have broken the existing delivery tests and the "text to a working child queues natively" contract.
