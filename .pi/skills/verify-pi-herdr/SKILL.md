---
name: verify-pi-herdr
description: Verify pi-herdr's local pi extension through the real Herdr CLI and pi TUI. Use when proving spawn, result snapshots, agent messages, or workflow behavior in this checkout, or when a pi-herdr runtime check needs persistent evidence and scoped cleanup.
---

# Verify pi-herdr

Read [the feature index](features/README.md), then select a mapped entry point. Run from the repository root inside Herdr. Keep each run's artifact directory unique.

## Launch

Require Node >=20, checkout dependencies, `pi`, a running Herdr >=0.9.0, and `HERDR_ENV=1`. The extension is TypeScript loaded by pi through jiti. There is no build script or standalone app binary in `package.json`. If `node_modules/jiti` is missing, install the checkout dependencies before this recipe. Do not change global pi package registration.

```bash
V=.pi/skills/verify-pi-herdr/scripts/verify.mjs
A="$PWD/.artifacts/verification/verify-$(date +%Y%m%d-%H%M%S)-$$"
"$V" launch "$A"
```

Require `READY workspace=... scratch=...`. Launch allocates a fresh no-focus workspace and temporary cwd, not a second Herdr server. Drive starts each real pi parent TUI in that owned workspace. The shared server must already be healthy. Do not start, stop, update, or replace the user's server.

The parent uses `-ne -ns -e tests/fixtures/turn-probe-entry.ts -e tests/fixtures/circular-exchange.ts --model circular-exchange/deterministic --thinking off --session <owned-scratch>/parent.jsonl`. The adapter passes `--snapshot`, so `TURN_PROBE_LEGACY_RESULT=0` loads current `src/index.ts` without the legacy result-tool proxy. This verifies the checkout, not the installed pi-herdr package. The pi executable itself is the installed host.

## Doctor

```bash
"$V" doctor "$A"
```

Require `HEALTHY` and exit 0. `doctor.json` records executable paths, versions, cwd, source hashes, runtime compatibility, and the owned workspace's pane IDs. Runtime probes are read-only. Doctor writes only proof files. It does not dump environment variables, auth files, provider keys, global settings, or other panes' transcripts.

Readiness is not a behavior proof. If startup fails, preserve the attempted command and error, then run Evidence and Cleanup. Report an unmet prerequisite instead of treating a unit test as a substitute.

## Drive

```bash
"$V" drive "$A" message-ack
```

Require all three `GREEN` results. The child sends `CHILD_QUESTION_NEEDS_ACK` through the actual message tool. The parent sends `PARENT_ACK`. The child finishes with `CHILD_COMPLETE_AFTER_ACK`. The parent then consumes and answers `ordinary-user-message` through actual terminal input.

Use a new Launch and Doctor for another feature. `spawn-result` uses the same exchange-start entry point, but inspect spawn acceptance, the mid-flight result, and the retained child final message as specified in its map. `workflow` submits `exchange-workflow` through the actual workflow tool. Entry points that require untested manual dialogs remain explicitly unverified.

The helper adapts `tests/circular-wait-live.mjs` in scratch. It replaces the cwd, explicitly routes tab creation to the owned workspace, checks the returned workspace, captures evidence, and removes the original cleanup. It leaves assertions and the real transport intact. If the harness shape changes, the helper fails instead of silently applying an obsolete adapter.

## Evidence

```bash
"$V" evidence "$A"
```

Require `CAPTURED`, `parent.jsonl`, `transport.jsonl`, and `result.json` with exit code 0 for a successful run. `*-commands.jsonl` records actions, stdout, stderr, cwd, and exit status. `transport.jsonl` pairs actual Herdr commands with their returned output. `terminal.json` captures the parent terminal. `input-events.jsonl` proves input delivery. `children/` copies referenced child transcripts and the scratch-specific retained session directory before scratch is removed. Each copied transcript must have this run's cwd in its header. `evidence.json` records the feature and parent transcript hash.

The deterministic provider replaces the external model decision boundary only. The Herdr server, CLI transport, pi TUI, local extension, child process, message tool, ACK, and session writes are real. This is a real CLI/TUI integration fixture, not an autonomous-model quality evaluation. It does not prove live provider authentication, blocked-dialog handling, or visual layout fidelity. Do not label an unvisited entry point verified.

Run Evidence before Cleanup, including after a failed drive. Evidence can fail if startup never wrote a transcript. Keep the existing command logs and still run Cleanup. Artifact files can contain fixture prompts and local paths. Use a private directory when running a non-fixture extension later.

## Cleanup

```bash
"$V" cleanup "$A"
test -s "$A/parent.jsonl"
test -s "$A/transport.jsonl"
```

Require `cleanup.json` to report `workspaceGone`, `scratchGone`, and `evidenceRetained` as true for a captured run. The helper closes only the workspace ID returned by its own Launch. Before any closure, it validates the canonical immediate-child scratch path and the token receipt inside scratch against the artifact manifest. It then checks that all panes still have the owned scratch cwd. A changed cwd triggers refusal and requires inspection of the recorded IDs. Never replace that refusal with name-based closure.

Cleanup removes the owned workspace, its tabs and panes, and the owned temporary cwd. Proof files and pi's retained child session files survive. Repeating Cleanup cross-checks the persisted cleanup receipt and confirms that the workspace is still absent. Missing scratch with a live workspace is a refusal, never permission to close it. A run manifest with no workspace still permits scratch cleanup after an early Launch failure.

Do not directly recommend blanket `test:live` for this skill. Existing live tests have different cleanup rules. `circular-wait-live.mjs` deletes its tmp transcript and searches agents by name plus cwd. `turn-release-live.mjs` covers spawn/result responsiveness and asynchronous workflow completion, but has its own name-plus-cwd cleanup. The generated adapter deliberately removes that cleanup. `message-live.mjs` uses fixed names and lacks scratch cleanup. `workflow-live.mjs` drives tool registrations through a mock pi object and a cwd-prefix pane sweep. Those are supplemental tests, not the isolated TUI proof recipe here.

## Helpers

[scripts/verify.mjs](scripts/verify.mjs) is executable and accepts five commands.

```bash
"$V" launch "$A"
"$V" doctor "$A"
"$V" drive "$A" message-ack
"$V" evidence "$A"
"$V" cleanup "$A"
```

Run the cleanup guard regression without starting any Herdr instance.

```bash
.pi/skills/verify-pi-herdr/scripts/cleanup-safety.mjs
```

Require exit 0. The regression checks path traversal, symlinks, altered workspace IDs, null workspace, wrong token, and missing scratch. All are refused before any Herdr CLI command. It removes only its own test directories.

Pass an absolute artifact directory outside scratch. The default recipe uses the repository root's `.artifacts/verification/<run-id>/`, ignored by `/.artifacts/verification/`. An explicit `A` may select another private directory, including `$HOME/.pi/agent/artifacts/pi-herdr/<run-id>/`. Keep `run.json` until Cleanup succeeds. When relocating a cleaned run, preserve original files and paths byte-for-byte; add a relocation receipt with old/new directories and per-file SHA256 hashes. Read evidence at the new directory without rerunning Evidence or Cleanup. The helper takes `A` explicitly; historical ownership receipts are not generation defaults. Use `/maintain-verification-skill` when commands or mapped entry points change.
