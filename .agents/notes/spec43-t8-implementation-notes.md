# spec43 T8 (#51) implementation notes

## Decisions

- Push completion prose now contains the child's complete final assistant text verbatim, without an agent/name wrapper or absolute session-path suffix. Empty successful results remain empty rather than manufacturing a pseudo-answer. Error prose preserves available final text; when none exists it emits a compact completion-error notice.
- Existing `details.sessionPath`, `details.result`, `details.eventId`, error metadata, and durable delivery token behavior remain metadata. `name` and `kind` remain because renderer and push dedupe require them; crucially, the pending key still includes the exact `content`, avoiding silent changes to T8-adjacent dedupe semantics.
- The completion display renderer remains presentation-only: collapsed view is a one-line summary and expanded view renders `content`; neither rewrites the model-facing payload.
- Updated `agent_done` and autonomous launch guidance to request concise conclusion, key evidence, limitations, and deliverable references, with large reports stored in files. No summarizer, truncation, or token budget added.

## Deviations / limits

- A real pi TUI expand/collapse check was not run in this headless worktree. Existing renderer tests and inspection show the display path does not mutate custom-message content; host-level visible verification remains outstanding.
- Ticket's "minimal source shell" is represented by message metadata (`name`, `kind`, optional event ID) rather than prose. Existing result/metadata schema is retained for downstream compatibility.

## Validation

- `npm run typecheck`: passed.
- `node tests/completion-body.mjs`: passed, including exact-body assertion and metadata session path.
- `npm test`: blocked by existing flaky/failing `tests/substrate.mjs` registration assertions and missing generated `.exit` file; failure occurs after earlier smoke checks. Re-run reproduced it.
