# ADR-0001: Subagent communication lifecycle — one delivery, explicit followup, safe wake

- Status: Accepted
- Date: 2026-10-07
- Spec: [issue #43](https://github.com/toRolex/pi-herdr/issues/43) (tickets #44–#55)
- Supersedes: the v0.6 Push/Pull contract, user takeover, and 15-minute idle re-arm

## Context

Before spec 43, `herdr_message_agent` merged ordinary correspondence, wake-dispatch,
and input injection into one open channel; `herdr_get_agent_result` simultaneously
served status inspection, blocking waits, and body consumption (so Push and Pull
could both deliver the same final body). Input events triggered User takeover and a
default 15-minute idle re-arm, so typing into a child pane changed its lifecycle.
Parent input acted as a child lifecycle signal, and pane recycling was coupled to
parent ACK, which could retain finished panes indefinitely.

## Decision

The model-facing tool surface is split by responsibility (herdr-prefixed names):

- **spawn** — start work; returns stable agent/run identity at acceptance, never completion.
- **list** — discover Projected state, title, activity, unread; never bodies, never consumption.
- **send** (`herdr_send_agent`) — QueueOnly ordinary correspondence: durable accept only; never starts a turn, interrupts, or resumes a pane.
- **followup** (`herdr_trigger_turn`) — explicit dispatch of a new run: idle starts, busy safely queues, a gone pane's retained session auto-resumes; each acceptance gets a fresh run identity.
- **wait** (`herdr_wait_agent_event`) — wait for an event reference (status/identity only; no body, no consumption, no ACK).
- **result** (`herdr_get_agent_result`) — consume a durable completion event: mid-flight reports status only; `reread: true` is the only repeat-body path; `ack` declares an event handled without claiming it was read.
- **interrupt** (`herdr_interrupt_agent`) — explicit turn-level cancel only.

Completion bodies are arbitrated **once per receiver host** through a durable
delivery ledger shared by push and pull; queued ≠ delivered ≠ read. The full final
assistant answer is the payload, plus minimal provenance. `notifications: normal`
delivers at safe run boundaries without surprise wakes; a finished parent only
accumulates unread until its next natural run or an explicit, scoped, TTL-bounded,
one-shot wake subscription (`herdr_wake_subscription`) that can never override
`quiet`/`none`. Autonomous children recycle their panes once the result and
undelivered events are durably saved — not on parent ACK; interactive children stay
resident. Input-driven takeover, markers, and idle re-arm are deleted; direct input
is an ordinary channel with no lifecycle side effects on either side.

### Compatibility (migration contract)

- `herdr_message_agent` remains as a labeled legacy compatibility entry with its
  wake/injection semantics (including raw answers to blocked overlays). It is not
  remapped onto QueueOnly send, never restores takeover, and never bypasses
  completion-event delivery arbitration.
- `herdr_get_agent_result` is consumption-only; old waiting usage migrates to
  `herdr_wait_agent_event`. `herdr_resume_agent` remains a maintenance entry;
  regular followups auto-resume internally.
- Old `idle_rearm_minutes` config and takeover markers parse without error but are
  inert. Already-delivered historical notifications never replay.
- Legacy registry/pending records migrate only on durable evidence; records with
  indeterminate identity are held for review (`identityReviewRequired`), never
  fabricated into new historical completions.

## Consequences

- Workflows keep their aggregated single-report promise: per-child completion
  bodies are never separately delivered, so migration cannot duplicate child prose.
- The delivery ledger is the single arbitration point; host seams (SDK queue
  injection, Pull tool result) must prove durable commit before exactly-once is
  claimed for a receiver host.
- Glossary, tool descriptions, and docs were migrated to this vocabulary; the old
  Push/Pull/takeover/re-arm contract terms are retired (GLOSSARY.md keeps them only
  as historical notes where needed).
