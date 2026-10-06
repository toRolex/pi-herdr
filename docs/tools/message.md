# `herdr_message_agent`

**The open channel** (v0.6 issue 05) — one tool, anyone ↔ anyone, no broker:
any session (orchestrator, child, or peer) delivers text to any agent pane.
Absorbed `herdr_send_prompt` (same send machinery underneath; the deleted tool
was the last of the legacy result trio).

**Wraps:** `agent prompt <target> <text>` (submit) or `pane send-text <pane>
<text>` (`submit: false`) — the same delivery path the spawn engine uses for
task prompts.

## Params

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Always explicit: pane id → herdr name → spawn-registry handle. The reserved role `orchestrator` is only the sender's direct parent and is not stolen by a same-name agent. |
| `text` | string | yes | Message text to deliver. |
| `submit` | boolean | no | Press Enter after typing (default `true`). |

## Resolution chain

The reserved role `orchestrator` is resolved before any name lookup, and only
to `PI_HERDR_ORCHESTRATOR_PANE` (the pane of the agent that spawned this
session — the direct parent). A live agent or spawn handle named
`orchestrator` does not take the alias. Unset env: *no orchestrator above
you, answer in-conversation*. A parent pane that is no longer live names that
pane id and points at `herdr_list_agents`. Any other target goes through
`agent get` (pane-id / herdr name / label, which also yields the state the
physics branch needs) and then the spawn registry. A `gone` target errors
naming the handle; a queued (accepted-over-the-cap, no pane yet) spawn has
nothing to deliver to and errors the same way.

## Generations

A resolved pane whose spawn-registry lineage names an `ownerSession` other
than the sender's is refused, unless it is the sender's direct parent pane
or a record the sender itself spawned (the target's `ownerSession` is this
session). Peers — the same `ownerSession` — go through. The refusal is not
redirected; its text lists the fleet handles that are still in reach
(`Keep using:`). A pane that is in no registry and has no lineage stays
anyone↔anyone, so an explicit pane id or herdr name of such a pane still
delivers. A fleet query or registry read that fails is reported as that
failure and is not treated as permission to send. The `orchestrator` alias
is unchanged: it is only the direct parent.

## Physics-adaptive delivery

- **blocked** target → the **raw text** is typed into its question overlay —
  the message IS the answer (wrapping would pollute the recorded answer).
  Option-list questions still take `herdr_send_keys`; typed text never reaches
  option rows.
- **every other state** → enveloped:
  `<agent-message from="…" to="…">text</agent-message>`. Identity is
  spawner-declared (`PI_HERDR_AGENT_LABEL` → `PI_HERDR_NAME` → pane name →
  pane id → `"session"`), never verified, and there is no child-side parsing —
  the receiving *model* recognizes the tag.

## Receipt (fire-and-forget)

`{delivered: true, target: <resolved pane-id>, to, from, state, delivery:
"message" | "answer", name?, submit}` — no state gates (text to a working
child queues natively), no `wait` (that is `herdr_get_agent_result(wait)`),
and no read receipt: **delivered to the pane ≠ consumed by the model**.
Replies arrive as injected `<agent-message>` text or the next completion
notification.

## Inbound limit

Each receiving pi session admits **20 messages per 10 seconds per sender
label**, across sender processes. Transport delivery is not admission: the
21st envelope may reach the pane but is not delivered to the model. The
receiver emits one aggregate custom receipt and immediately sends a separate
`<agent-receipt>` to the affected sender. Further refusals in that window
fold into the receipt without another conversational input or turn. The
identity scope is local, same OS user; labels are spawner-declared and never
verified. Receipt delivery failures are shown in the receiver transcript
and UI. A **blocked** target's raw overlay answer has no envelope, does not
count, and is not refused.

## Pending inbox

A **busy** receiving pi session automatically holds accepted envelopes in
one inbox shared by all senders. No caller opt-in is needed; `pending` is a
deprecated compatibility parameter. The inbox holds **8**. A ninth pending
input drops only the oldest pending message and keeps the newest. Already
delivered text is unchanged. The receiver gets one custom aggregate receipt;
each affected dropped sender gets that receipt immediately, not on its next
call. Receipt envelopes bypass admission and never generate replies.

`agent_settled` drains the surviving pending inputs oldest first, without a
new inbound message. Idle input is delivered immediately. A sink failure
retains the unprocessed message and remainder; a visible failure receipt
reports the problem, and a later settle retries. These guarantees apply to
pi receivers with the inbox extension; non-pi panes keep raw transport.
