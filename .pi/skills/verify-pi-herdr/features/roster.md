# Roster

The Roster is the model-visible menu of addressable agent definitions. It renders one entry per name, the winning definition under session > project > global > built-in precedence, in fixed layer order, sorted by name. `src/agentdefs.ts` builds it (`effectiveRoster`, `renderRoster`); `registerAgents` delivers it as the `agent-roster` key of `systemPromptOptions.sections` on every `before_agent_start` (spec 22) — the model sees `<agent-roster>…</agent-roster>` in the system prompt. When `herdr_spawn_agent` is not in the active tool set the key is removed instead (no orphan menu).

## Sub-features

- `precedence` — first-hit-wins per name; project shadows global; built-in only when no file layer claims the name.
- `deterministic-render` — the same registry renders byte-identical output. Fixed layer order, code-point sort, lossless names, non-built-in descriptions flattened and capped at 512 UTF-8 bytes.
- `section-delivery` (spec 22, ticket 23) — the roster survives cross-extension loadout post-processing (codemode's description rewrite), is gated on the spawn tool's active-set membership, and refreshes on registry changes with no stale copy. Verified live by `tests/roster-section-live.mjs`.

## How to get to it (user POV)

Open any pi session with the extension loaded. The system prompt carries the `<agent-roster>` section; the `herdr_spawn_agent` description points to it. Names in it must round-trip as the spawn tool's `type` parameter.

## Driving it

- Offline: `node tests/agentfiles.mjs` (precedence, shadowing, malformed files) and `node tests/spawn.mjs` (section handler contract: idempotency, gating, key isolation).
- Real pi runtime (deterministic provider): `node tests/roster-section-live.mjs` — S1 exactly-once + section isolation, S2/S3 codemode-sim load-order permutations, S4 active-tools gating, S5 refresh between runs, S6 byte-determinism. Evidence lands in `.artifacts/verification/roster-section-live-<run-id>/`.

One-off render check through the jiti seam is still available for quick manual checks (see git history of this file for the snippet).

## Gotchas

Session-layer entries come from the mutable in-memory registry, so a fresh process shows only file and built-in layers. The 512-byte description cap applies to non-built-in winners. Long descriptions do not fail the render, they truncate. Print-mode runs of the live script exit 1 via a pre-existing stale-ctx `ui.setStatus` in `src/index.ts` — the transcript is complete before that point; the gate is the transcript.
