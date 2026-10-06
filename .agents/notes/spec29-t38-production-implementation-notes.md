# #38 production completion channel

## Decisions

- Baseline fc7e427, integration ancestor fd5f668. Work restricted to spec29-t38b; identity rolex / torolex@163.com. No push or issue mutation.
- A child-owned `<session>.completion-event` marker supplies one UUID for the current run. Reset on extension registration (resume/reload) and agent_start. `completion:true` reads it; progress never implicitly gets an ID. A conflicting explicit ID fails rather than splitting the business event. Sidecar builder requires an ID; writer uses the run ID, never another UUID.
- Exact full agent-message envelopes with a valid event ID become herdr-agent-message via the input handler, preserving full text and details.eventId. handled suppresses the original user entry. ctx.isIdle chooses steer vs followUp, one sendMessage with triggerTurn true. Progress and invalid envelopes continue untouched.
- SDK references checked in installed pi 1.0.2: extensions/types.d.ts InputEvent/InputEventResult/sendMessage; core/session-manager.d.ts CustomMessageEntry is a flat type:custom_message entry. Wrapper message rows supported without casting the whole SessionEntry to a message.
- Real CustomMessageComponent only invokes the renderer factory on rebuild. The returned live component checks current branch on every render, so a completion append hides the earlier body without invalidate or ctrl+o. Reload reconstructs the same state from persisted entries. Completion-first is also hidden immediately.
- fc7e427 review: delivery copies sidecar IDs into done/error details; parser now validates IDs using the same grammar as input. The other two core gaps were independent child UUIDs and missing input ingestion, now connected. Prior fixture-only renderer tests retained; external channel test added to npm test.
- Removed tracked node_modules symlink from the implementation snapshot and ignored the symlink path as well as directory paths. Local symlink remains for tests.

## Validation

- RED /tmp/pi-herdr-spec29/t38-red.log: completion:true initially failed to supply an event ID.
- GREEN tests/completion-channel.mjs traverses child registration/run marker → real messageAgent envelope → registered input handler/custom sink and child agent_done sidecar → parse/read → deliverOnce → real delivery sink. Both orderings, busy/idle flags, persisted-entry reload, distinct IDs, progress, invalid IDs, conflicting IDs, new run, and extension resume reset covered.
- Actual installed CustomMessageComponent retained across live→done append and rendered again without invalidate; old live body gone.
- Logs for message, delivery, renderer, channel, substrate and tsc in /tmp/pi-herdr-spec29/t38-*.log. Commands bounded to 180 seconds. Substrate must clear inherited PI_HERDR_* env (test harness assumes non-child startup).

## Limitations / integration

- SDK CustomMessageComponent always prepends Spacer(1) outside the extension component. Renderer can hide the old body but cannot remove that fixed blank line through public API. Tests assert body absence, not a nonexistent ability to delete the wrapper.
- Display-only deduplication. Both messages remain in model/session context; no model-once guarantee.
- No fresh Herdr pane live end-to-end run in this task. The terminal send seam is injected; installed SDK component and session-entry shapes are tested directly.
- #36/#37 agent owns src/inbox.ts. Integration should replace registerAgentMessageInput in index with registerReceiverInbox(pi, {parse:parseAgentMessage, deliver:handleAgentMessageInput}); never register both input handlers.
- #33 agent independently fixes toolCall-only final-body extraction; this task deliberately does not alter that policy.
