# ticket #2 — spawn non-blocking at the tool layer

## Baseline (before any ticket-2 change)

`npm test` after `npm install` (worktree had no `node_modules`; jiti missing until install).

Exit 1 inside `tests/substrate.mjs` section [7] "Child extension — registration against a mock pi", before later suites (spawn included) ran:

- ✗ without PI_HERDR_SESSION the extension is a no-op
- ✗ session named herdr/<spawn-name>
- ✗ identity strip rendered aboveEditor content
- then throw `ENOENT` reading `<tmpdir>/pi-herdr-child-*/s.jsonl.exit` at tests/substrate.mjs:413

Cause: `registerChildExtension` no-ops only when `process.env.PI_HERDR_SESSION` is unset. This process inherited `PI_HERDR_SESSION` (we are a spawned child), so the first "no env" assertion registers tools anyway, and the later `agent_done` sidecar write targets a path that never got created. Pre-existing, environmental, unrelated to spawn's `wait`. Not fixed in this ticket.

## Seams (agreed by the ticket, not a separate user confirmation)

1. `herdr_spawn_agent` tool surface: schema has no `wait`; description does not claim the tool blocks; execute returns before a still-running child finishes; return text/details are accepted / queued / starting and do not claim the child has booted; a caller-supplied `wait` is not forwarded and cannot re-block.
2. Internal `spawnAgent({ wait })` stays for existing callers (workflow host, tests). Not the seam under change except that the tool must not use it.

## Decisions

- `spawnFromTool` is the tool's execute path (exported). It always passes `detach: true` and never forwards `wait`. Tests call it with the same injected seams as `spawnAgent`.
- `detach` on `SpawnParams` returns `queued` or `starting` before `startRecordNow` resolves, then starts the pane in the background. A rejected start sets `record.startError` so pull does not report a forever-queued child. `wait` is ignored on this path.
- `starting` added to `SpawnStatus` for the accept-time return only. `deriveStatus` / `projectStatus` unchanged: a record with no paneId is still `queued` there until start begins. Acceptable — the tool result is the contract that says starting.
- Tool text says "accepted as STARTING" / "accepted as QUEUED" and does not mention a pane id. The child has not booted.
- `listAgentTypes` assertion fails when `~/.pi/agent/agents` has `comment-sicko.md` and `poteto-agent.md`. Pre-existing, environment. Not this ticket. Recorded in baseline addendum below.

## Baseline addendum (clean child env)

`PI_HERDR_SESSION` was inherited from this agent process and broke substrate.mjs [7] (extension no longer a no-op; later ENOENT on the sidecar). Re-ran with that env unset: `node tests/substrate.mjs` 89/89 pass. The failure is environmental, not a product bug.

`node tests/spawn.mjs` still fails one assertion with a clean env: `listAgentTypes: session first, then built-ins`. Actual list includes global agents `Comment Sicko` and `poteto-agent` from `~/.pi/agent/agents`. Pre-existing. Not fixed here.

- Tool layer only. Do not change `spawnAgent`'s default wait path or `waitPhase`. Workflow host already passes `wait: false` and then awaits settle itself; that is the internal caller the ticket keeps.
- Return before pane start: `execute` calls `spawnAgent` with an internal non-blocking flag (not a schema param) so the engine returns at accept time. Status on the immediate path is `queued` when over cap, otherwise `starting` (accepted, start kicked off in the background — does not promise the child has booted).
- `wait` on the tool call is stripped. If it arrives anyway (stale caller), it is not passed through. `wait: true` cannot block.
- Description: drop "wait: true blocks…". State that the tool always returns immediately with accepted/queued/starting and does not promise the child has started. Keep spiral layout wording — layout mode is another ticket; do not announce grid behavior.
- Global `~/.pi/agent/AGENTS.md` 「### 派发」: non-blocking wording only. Leave the `group` / 3×2 grid sentences as they already are (this ticket does not add or remove layout claims).
