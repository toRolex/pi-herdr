# pi-herdr verification map

Use an isolated workspace created by `scripts/verify.mjs launch`. Run Doctor before Drive. Capture actions and resulting session state before Cleanup. Use a unique artifact directory outside scratch.

## Features

- [Spawn and result](spawn-result.md) covers acceptance, a mid-flight snapshot, and retained child output.
- [Agent message and ACK](message-ack.md) covers the question, ACK, child completion, and normal terminal input.
- [Workflow exchange](workflow.md) covers dispatch through the real parent TUI and child exchange.
- [Roster](roster.md) covers the effective agent menu: layer precedence and deterministic render.

## Proof reporting

Record the feature, actual entry point, exit code, and artifact directory. These deterministic-provider recipes exercise real CLI and TUI transport. Natural-language reasoning, live model providers, manual UI dialogs, resume, and visual layout remain unverified. Each drive uses a fresh Launch and Doctor. Spawn and message recipes intentionally share one exchange, not independent coverage claims.
