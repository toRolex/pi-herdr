# spec43 T8 implementation notes

## Delivery body contract regression tests

Ticket #51 changes completion prose to the complete final assistant message with a minimal source shell. Source identity and protocol semantics belong in `details`, not the body. Inspected the issue and delivery-path notes before changes.

### Decisions

- Updated `tests/delivery.mjs` assertions that incorrectly required legacy `Agent finished`/`FAILED` prose wrappers or a rearm prefix. Assert exact final body and typed `details` metadata instead.
- Kept semantic guarantees: rearm is asserted in `details.rearm`; error class/message in `details.kind`/`details.error`; gone remains an honest explicit gone sentence; rearm takeover still closes its pane.
- Blank sidecar text plus empty JSONL resolves to an empty body in `doneContent`; matched the test to this implementation rather than restoring a protocol sentence.
- Orphan adoption asserts the exact grandchild letter, with source identity in metadata.

### Validation

- Initially reproduced all 8 failures with `node tests/delivery.mjs` (161 passed, 8 failed); failures were old body-contract expectations, not missing semantic behavior.
- `npm run typecheck && npm test` passed (entire serial suite; included `delivery.mjs`: 169 passed, 0 failed). Initial attempt inherited Herdr `PI_HERDR_*` variables and stopped at unrelated substrate environment-sensitive checks; reran the full chain with those variables unset and it passed.
- Committed as `5157846` (`fix(delivery): align delivery body contract tests with minimal source shell (#51)`).
