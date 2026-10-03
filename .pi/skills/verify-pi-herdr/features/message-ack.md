# Agent message and ACK

A child sends a question to its orchestrator. The child completes only after consuming the parent ACK.

## Sub-features

- `message-question` delivers the question.
- `message-ack` delivers the ACK.
- `message-complete` finishes the child.
- `user-input` answers a subsequent normal turn.

## How to get to it (user POV)

Ask pi to use `herdr_message_agent` to send or answer a message. The fixture terminal prompt `exchange-start` drives both roles.

## Driving it with verify.mjs

Preconditions:

- Launch has created an owned workspace.
- Doctor reports HEALTHY.
- Set `V=.pi/skills/verify-pi-herdr/scripts/verify.mjs` and `A` to this run's artifact directory.

Run `"$V" drive "$A" message-ack`. Require the full-exchange GREEN marker and the ordinary-user-input GREEN marker. Inspect input events, the successful message-tool receipt, and `CHILD_COMPLETE_AFTER_ACK` in parent and child transcripts.

Run `"$V" evidence "$A"`, then `"$V" cleanup "$A"`. Require retained evidence and no owned workspace or scratch.

## Gotchas

Delivery receipts do not prove consumption. Completion after ACK provides that proof. Blocked freeform answers, option lists, and non-pi agents are distinct entry points and remain unverified.
