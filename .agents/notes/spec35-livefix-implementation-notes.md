# Spec35 livefix

## Scope / seam
- Only spec29-livefix-spawn worktree; frozen integration 712692a. No push or issue closure.
- Regression seam: public messageAgent with default production CLI transport, subprocess fixture returning Herdr 0.9.3 CLI shapes. Live owned overlay remains required independently.
- Cancellation seam: real TUI spawnFromTool detached start, default submit/readEditor with owned transport adapter injecting AbortSignal boundary only.

## Initial evidence
- Supplied s29-latency-20261006-141411-62299/spawn-failures.jsonl contains three earlier `unknown option: --panes` errors, not the three later `prompt could not be submitted` receipts. Do not conflate.
- message blocked selects raw payload but calls sendAgentPrompt's default `agent prompt`; actual CLI rejects blocked targets requiring interactive input. Candidate cause is transport mismatch, not receiver admission.
- Parallel delegation refused at max_spawn_depth=3; requested coordinator's read-only receipt investigation.

## Hypotheses
1. Blocked payload is correct but wrong CLI command rejects it; raw pane input should succeed.
2. Later natural spawn submit returns hard error after turn executed; child transcript plus CLI receipt can distinguish.
3. Fixture inherited event options or submission timer failure may explain receipts independently; exact trace required.

## Findings and validation
- Default-transport regression `node tests/message-transport.mjs`: RED `agent_blocked / requires interactive input`; minimal fix adds explicit interactive pane transport for answers. GREEN blocked send-text + one Enter; submit=false sends text only; normal agent prompt unchanged. Added to npm test.
- Fresh owned live run `/tmp/pi-herdr-spec29/live35-cancel-20261006-142602-11796`: launch w7H / doctor HEALTHY, formal herdr_message_agent answers real ctx.ui.input with EXPLICIT_RAW_ANSWER. No envelope pollution; child transcript records the exact answer.
- Same run invokes spawnFromTool from real parent TUI; only owned CLI adapter injects cancellation during default agent-get readback. Detached acceptance starting; one default agent prompt; record uncertain/submitted=false; persistent registry uncertain; actual herdr-delivery uncertain push recorded in parent tree; no Enter after abort and no repaste. Child remains blocked until owned workspace cleanup, not silently treated as killed.
- Evidence CAPTURED then cleanup workspaceGone/scratchGone/evidenceRetained. About 360KB, each CLI <=15s, driver <=180s. Candidate source hashes retained. Scoped cleanup removes only w7H children; no main checkout writes.
- `node tests/spawn.mjs`: 300/300 (~100s <=180s); `node tests/message.mjs`: pass; `npm run typecheck`: pass. Dependencies installed only in ignored local node_modules, no lockfile changes.
- Exact 140804 receipt at 06:08:19.457 reports pane w76:p3 failure. Child tree bbcb28af -> 5e6b01a6(system) -> 620cae42(user at 06:08:17.956), original task text present, but no assistant/tool/provider execution retained. Thus paste accepted into session is proved; task execution, confirmed submission, and the proposed confirmed+idle race are NOT proved. Historical record/currentStatus/readback not captured, so root cause unknown. Pane now gone.
- The supplied three spawn-failures rows (06:16:11.245, 06:16:56.260, 06:17:46.281) explicitly report `unknown option: --panes`, not prompt-submission failure; this is CLI grid compatibility evidence, separate from the one prompt failure. No speculative spawn change.

## Deviations
- Natural root cause stays honest unknown; no unique Enter explanation or race claim.
- Boot-stage cancellation not exercised; readback cancellation is the tested AC. Deterministic provider replaces model decisions, not TUI/CLI/default submit/readback. Coordinator handles final current-integration merge after this isolated fix commit.
