# Workflow exchange

A parent dispatches a workflow that starts a real child and completes its question and ACK exchange.

## Sub-features

- `workflow-dispatch` calls the workflow tool.
- `workflow-child` uses a registered child definition.
- `workflow-exchange` completes the child exchange.

## How to get to it (user POV)

Ask pi to call `herdr_run_workflow` with a script. The fixture terminal prompt `exchange-workflow` submits `circular-workflow`.

## Driving it with verify.mjs

Preconditions:

- Launch has created an owned workspace.
- Doctor reports HEALTHY.
- Set `V=.pi/skills/verify-pi-herdr/scripts/verify.mjs` and `A` to this run's artifact directory.

Run `"$V" drive "$A" workflow`. Inspect `parent.jsonl` for a successful `herdr_run_workflow` result. Inspect `transport.jsonl` for the parent start, prompt, and terminal reads. Inspect `parent.jsonl` for the ACK message-tool receipt and `children/1.jsonl` for the actual user ACK followed by the assistant completion. Extension-internal CLI calls are not logged by the driver. Require the full-exchange GREEN marker and `CHILD_COMPLETE_AFTER_ACK` in parent evidence.

Run `"$V" evidence "$A"`, then `"$V" cleanup "$A"`. Require retained evidence and no owned workspace or scratch.

## Gotchas

This covers one workflow, not pipeline fan-out, journal replay, or structured outputs. Saved-script invocation and resumeFromRunId remain unverified.
