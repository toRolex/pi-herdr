# spec29-t36 inbound rate limit

## Decisions

- Seam is `messageAgent`'s public result, not a private counter. A refused send returns `RATE_LIMITED` and does not call `send`. That return is the receipt. A second `messageAgent` back to the sender would be another inbound send and could loop, so there is no outbound receipt.
- Budget is 20 admitted sends per sender label per 10 seconds. Smaller than the CC figures this ticket said not to copy. A pi fleet is a handful of panes on one machine; 20/10s is already a flood, and the number is repeated in the receipt and the tool description.
- Sender key is `senderLabel` (label → name → pane id → `"session"`). Same label shares one bucket inside this process. The receipt says the scope is local and the same OS user, because the label is spawner-declared and never verified.
- Only the first refusal in a window is worded as `Aggregate receipt`. Later refusals in that window stay `RATE_LIMITED` (the call must not look delivered) but say they are folded into the open receipt and are not an additional receipt. The count on that line is the refusals still waiting. The next admitted send, or a receipt after the window, clears it.
- Blocked overlay answers skip the limiter entirely. `resolved.state === "blocked"` is the existing answer path (raw text, `delivery: "answer"`). Counting or refusing it would leave a question overlay unanswered. The exemption is the branch before `admitInbound`, not a separate bucket.

## Deviations

- None from the ticket. Queue capacity and dropping the oldest message are #37 and were not added. `resolveTarget`'s orchestrator alias is untouched.
