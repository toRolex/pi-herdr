# Agent tools

**The default agent surface.** The protocol separates seven responsibilities:

| Responsibility | Registered tool | Contract |
|----------------|-----------------|----------|
| spawn | `herdr_spawn_agent` | Accept work immediately with stable agent/run identity; acceptance is not completion. |
| list | `herdr_list_agents` | Discover state, activity, and unread counts without message bodies or consumption. |
| send | `herdr_send_agent` | QueueOnly correspondence: durably queue text without starting, interrupting, or resuming a turn; queued is not read. |
| followup | `herdr_trigger_turn` | Dispatch a fresh run: idle starts, busy safely queues, and a gone pane's retained session auto-resumes. |
| wait | `herdr_wait_agent_event` | Wait for event availability (or recoverable blocked state); return status and identity reference only, without body, consumption, or ACK. Timeout/cancellation never stops the child. |
| result | `herdr_get_agent_result` | Consume a durable completion body; one call returns one snapshot and never waits. |
| interrupt | `herdr_interrupt_agent` | Explicitly cancel this session's live pi child's current turn, not its process. |

[`herdr_message_agent`](message.md) remains a **legacy compatibility entry**
with wake/injection semantics (including raw answers to blocked overlays), not
an alias for QueueOnly send. It never restores takeover or bypasses
completion-event arbitration to repeat a body. Prefer send for correspondence
and followup for dispatch. `herdr_resume_agent` remains a **maintenance entry**
for retained gone pi children; ordinary followups auto-resume internally.

> This page details result and list. See the project [README](../../README.md#tools)
> for the registered tool surface and spawn/followup parameters; the legacy
> message entry has its own [page](message.md). Cross-cutting behavior
> (envelope, version floor, targeting, ⚠️ markers) lives in
> [concepts](../concepts.md). Raw pane control is in [pane-sync](pane-sync.md).

---

### `herdr_get_agent_result`

Consume an agent's result (spec 43: consumption semantics — the old
inspection-with-wait contract is retired; waiting lives in
`herdr_wait_agent_event`). For **pi children this session spawned**, the
source is the child's durable completion event: the exact final assistant
message object — no screen scraping, no tail heuristics, no truncation
ambiguity. Mid-flight calls return **status only** — no drafts, no
consumption, no ACK. A failing child surfaces as a **typed error**
(`stopReason` / `errorMessage`, from the child's completion sidecar or its
session). Panes this session did not spawn (adopted) and non-pi kinds fall
back to **pane-tail reading**.

The completion sidecar (`<session>.exit`, written by the injected child
extension) is checked BEFORE pane status: an auto-exited autonomous child is
already gone from the fleet when its typed sidecar lands, and `gone` must not
swallow a finished result. A `gone` answer carries last-known registry
metadata; sessions are never deleted by pi-herdr, so the session file remains
readable and resumable.

**Reads:** the session JSONL directly; sidecar `<session>.exit`;
`agent read` (fallback only).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `target` | string | yes | Spawn handle (the name `herdr_spawn_agent` returned), pane id, or completion eventId. |
| `reread` | bool | no | Explicitly reread the immutable final body (including after ACK); not a new delivery. |
| `ack` | object | no | `{eventId, agentId, runId, sequence, hostFile}` — declare the event handled; no body returned, no claim of reading. |
| `lines` | int | no | Pane-tail line budget for the unspawned fallback (default 80). |

**Statuses:** this session's children use projected state (`queued`,
`starting`, `active`, `waiting`, `blocked`, `interrupted`, `stalled`, `running`,
`finalizing`, `gone`), with `done` / `error` for terminal pull answers.
`details` carries state and identity references, with `result` (exact text)
and `message` (the verbatim message object) only when returning a body;
`source` is `session-jsonl`, `pane-tail`, or `registry`. Available metadata
includes `sessionPath`, `exitPath`, typed `error`, and `lastKnown` for `gone`.

> **Snapshot and retry semantics:** one result call returns one snapshot; it
> never polls for a sidecar or waits for the pane to exit. A failed attempt on
> a live pane is not yet retry exhaustion. While the child is retrying, result
> reports only the current nonterminal state — no draft body, consumption, or
> ACK. Use `herdr_wait_agent_event` to wait for event availability, then call
> result to consume the durable terminal outcome. Already claimed events
> return status references; `reread: true` explicitly repeats the immutable
> original body without creating a new delivery.

---

### `herdr_send_prompt` — ABSORBED (issue 05)

Removed from the surface. Its historical delivery path (`agent prompt` /
`pane send-text`) lives on in the legacy compatibility entry
[`herdr_message_agent`](message.md), with the envelope, resolution chain, and
reserved `orchestrator` role. This is not the default steering contract:
ordinary correspondence uses `herdr_send_agent`, and new work uses
`herdr_trigger_turn`. Freeform answers to a blocked agent's question still use
`herdr_message_agent` (the legacy raw-text "answer" path); option-list answers
stay on `herdr_send_keys`.

---

### `herdr_list_agents`

Discover the fleet's state without consuming messages. This session's
children include projected state, title, activity, and unread count; panes
from elsewhere keep their coarse status. Listing never returns message bodies
or consumes completion events.

**Wraps:** herdr inspection combined with this session's retained registry.

**Returns:** a fleet summary and one line per agent, plus structured
`details.rows` with `paneId`, `name`, `agentId`, `runId`, `sequence`, `title`,
`activity`, `unread`, and `state`.

---

## What was cut (v0.6)

`herdr_start_agent`, `herdr_get_agent`, `herdr_stop_agent`,
`herdr_rename_agent`, `herdr_focus_agent`, `herdr_explain_agent`, the
`herdr_delegate` composite, and — with the substrate (issue 04) —
`herdr_wait_agent` + `herdr_read_agent` are **off the model surface**. Their
replacements:

- `herdr_start_agent` / `herdr_delegate` → `herdr_spawn_agent`
  (accept work in one call), then `herdr_wait_agent_event` for availability
  and `herdr_get_agent_result` for consumption.
- `herdr_get_agent` / `herdr_explain_agent` → `herdr_list_agents`.
- `herdr_stop_agent` → the confirmed **Kill all agents** action in
  `/subagents config` (or close the pane yourself in the herdr UI); for a
  live pi child spawned by this session, `herdr_interrupt_agent` cancels its
  current turn without terminating its process. Raw `herdr_send_keys` with
  `["ctrl+c"]` is pane control and can interrupt a process.
- `herdr_rename_agent` / `herdr_focus_agent` → the herdr UI (rename/focus a
  pane yourself); the machinery survives internally.

See the README's [Upgrading](../README.md#upgrading-v05--v06) note.
