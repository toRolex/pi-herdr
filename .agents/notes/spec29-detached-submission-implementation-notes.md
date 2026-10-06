# Spec29 detached prompt submission

## Decisions
- Tool acceptance stays immediate STARTING/QUEUED. Background editor readback gets an independent `prompt-submission` delivery, never a terminal result or a second paste.
- Persist readback outcome after submit; persist its dedicated dedupe marker after push. `notifications:none` keeps pull-only behavior; quiet does not wake. List text/details and result text/details expose uncertain outcomes.
- Readback notification precedes fleet observation: a failed fleet poll must not hide locally established submission evidence.
- Reuse the existing delivery loop/sink instead of adding an accept-time wait or a second push channel. Ordinary terminal pushes remain independent.

## Validation
- `node tests/spawn.mjs`: 300 assertions pass, including actual `spawnFromTool` detach, background completion, sink uncertain event exactly once (even failed fleet observation), persisted readback/dedupe, result/list visibility, one paste.
- `node tests/delivery.mjs`: 151 assertions pass.
- Initial typecheck blocked by existing missing direct `@earendil-works/pi-tui` dependency; installed offline dependencies for runtime tests without retaining a generated lockfile.

## Deviations
- Blocked editor readback proves the task has started; confirm without Enter, avoiding input into approval overlays. Covered by dedicated regression assertion.
- No child re-send or automatic recovery on uncertain evidence: inspect pane before retrying. Preserves one-paste contract.
