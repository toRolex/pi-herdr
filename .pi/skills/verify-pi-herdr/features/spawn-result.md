# Spawn and result

Spawn accepts a child task before its answer is ready. Result snapshots and retained session output expose progress.

## Sub-features

- `spawn-accept` returns starting.
- `result-snapshot` reports mid-flight state.
- `result-retained` preserves the final answer.

## How to get to it (user POV)

Ask pi to use `herdr_spawn_agent`, then `herdr_get_agent_result`. The fixture terminal prompt `exchange-start` produces these calls.

## Driving it with verify.mjs

Preconditions:

- Launch has created an owned workspace.
- Doctor reports HEALTHY.
- Set `V=.pi/skills/verify-pi-herdr/scripts/verify.mjs` and `A` to this run's artifact directory.

Run `"$V" drive "$A" spawn-result`. Inspect `parent.jsonl` for successful spawn acceptance and a non-error result snapshot. Inspect `children/1.jsonl` and the parent completion delivery for `CHILD_COMPLETE_AFTER_ACK`.

Run `"$V" evidence "$A"`, then `"$V" cleanup "$A"`. Require retained evidence and no owned workspace or scratch.

## Gotchas

Starting is not a boot promise. The snapshot can report no pane yet. The final answer in this recipe arrives through completion delivery, not a blocking result call. Exact post-completion result polling is not covered.
