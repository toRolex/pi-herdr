# pi-herdr

[English](README.md) | [简体中文](README.zh-CN.md)

A [pi](https://pi.dev) extension that coordinates AI agents in visible [herdr](https://herdr.dev) terminal panes. Spawn an agent, send follow-up messages, and collect its result without leaving your pi session. Each child is a separate CLI process that you can inspect and steer.

This is the [toRolex/pi-herdr](https://github.com/toRolex/pi-herdr) fork of [AndrewJacop/pi-herdr](https://github.com/AndrewJacop/pi-herdr). The extension version is **1.0.0**. The separate herdr application must be **0.9.0 or newer**. These are different version numbers.

## Requirements

- Node.js 22.19.0 or newer, as declared in [package.json](package.json).
- A working pi installation with at least one authenticated model. See [pi](https://pi.dev) for setup. Child pi processes use your pi configuration.
- herdr 0.9.0 or newer, installed separately from [herdr.dev](https://herdr.dev), available on `PATH`, with its server running.
- The CLI for any other agent kind that you want to launch. Valid kinds come from herdr's live kind list.

Check the prerequisites and launch herdr from your terminal:

```bash
node --version
pi --version
herdr --version
herdr status
herdr
```

On macOS, a herdr server started by launchd or `brew services` can lack the shell's `PATH`. Node-based children then fail to start. If you enabled that service, stop **only herdr** with `brew services stop herdr`, then launch `herdr` from your terminal. Reattaching to the old server does not repair its environment.

The extension checks herdr's version at startup and reload. A missing binary or failure to launch the herdr CLI produces `HERDR_UNAVAILABLE`. Other CLI or server failures can produce `VALIDATION_ERROR` or `TIMEOUT`. A version below the floor produces `HERDR_TOO_OLD`.

## Install from Git

Install this fork through pi's Git source support:

```bash
pi install git:github.com/toRolex/pi-herdr
```

Restart pi or use `/reload` after installation. Review third-party extension code before loading it.

To use a local checkout instead:

```bash
git clone https://github.com/toRolex/pi-herdr.git
cd pi-herdr
pi install ./
```

For one invocation from the checkout, load only this extension:

```bash
pi -ne -e ./src/index.ts
```

Do not load the installed and checkout copies together. The Git command follows the repository's default branch. To try an unmerged change, check out its branch locally before loading the checkout.

## Quick start

In a project with herdr running, start pi and ask:

```text
Spawn an agent named summ to summarize README.md in three bullets.
Give me its result when the completion notification arrives.
```

The corresponding spawn arguments are:

```json
{
	"name": "summ",
	"prompt": "Summarize README.md in three bullets."
}
```

`herdr_spawn_agent` returns immediately with an accepted handle, stable agent/run identity, and `starting` or `queued`. `starting` does not guarantee that the child has booted. `queued` means there is no pane yet because the concurrency cap is full.

Completion arrives later, subject to the notification setting. To inspect the current state, call `herdr_list_agents`. To wait for the completion event reference, call `herdr_wait_agent_event` with:

```json
{ "target": "summ" }
```

Then consume the final body with `herdr_get_agent_result`. One result call returns one snapshot and never waits; the waiting concern lives in `herdr_wait_agent_event`.

## Tools

The extension registers **16 tools by default**, or **15** when `workflows_enabled: false` at load. [src/index.ts](src/index.ts) registers them. Run `node tests/smoke.mjs` to verify the default tool list.

The protocol tools separate concerns: **spawn** starts work, **list** discovers state, **send** is ordinary queue-only correspondence, **trigger_turn** dispatches a new run (followup), **wait** waits for an event reference, **result** consumes a completion body, and **interrupt** explicitly cancels a turn.

| Tool | Parameters and contract |
| --- | --- |
| `herdr_spawn_agent` | Required `prompt`. Optional `type` or inline `agent`, never both. Also accepts `name`, `kind`, `model`, `thinking`, `fork`, `agent_args`, `cwd`, `isolated`, and `group`. Returns acceptance immediately with stable agent/run identity, not completion. |
| `herdr_save_agent` | Exactly one of `type` or inline `agent`. `target` is `project` by default or `global`. Existing files require `overwrite: true`. Saving is not gated by the spawn kill-switch. |
| `herdr_list_agents` | No parameters. This session's children report projected state, title, activity, and unread count — never message bodies. Consumes nothing. |
| `herdr_send_agent` | Required `target` and `text`. QueueOnly: durably queues ordinary correspondence. Never starts a turn, never interrupts, never resumes a pane. `queued` is not a read receipt. |
| `herdr_trigger_turn` | Required `target` and `text`. Dispatches a new run: idle starts immediately, busy safely queues, a gone pane's retained session is resumed automatically. Each acceptance gets a fresh runId. |
| `herdr_wait_agent_event` | Required `target`; optional `timeout` (default 30000 ms). Waits for a completion event (or recoverable blocked state) to become available and returns only its status and identity reference — no body, no consumption. Timeout/cancellation never stops the child. |
| `herdr_get_agent_result` | `target` is a spawn handle, pane ID, or completion eventId. Optional `lines` (default 80, fallback pane output only), `reread` (explicit repeat of the original body), and `ack` (declare the event handled without receiving the body). Mid-flight calls report status only. Single snapshot, never blocks. |
| `herdr_wake_subscription` | `action` is `subscribe`, `revoke`, or `list`. A subscription is explicit, scoped (agent/run/event), TTL-bounded (max 1 hour), and one-shot; it never overrides `quiet`/`none`. |
| `herdr_message_agent` | Legacy compatibility entry. Required `target` and `text`. `submit` defaults to true. False types text without pressing Enter. Retains the legacy wake/injection semantics (raw answers to blocked overlays); it is not remapped onto the queue-only mailbox and never bypasses completion-event delivery arbitration. Prefer `herdr_send_agent` for correspondence and `herdr_trigger_turn` for dispatch. |
| `herdr_interrupt_agent` | `target` resolves to a pi child spawned by this session. Cancels its current turn with Escape, not its process. |
| `herdr_resume_agent` | Maintenance entry for a gone pi child: `target` must be a retained spawn handle, not a file path. Optional `message` gives the resumed child new work. Regular followups auto-resume via `herdr_trigger_turn` instead. |
| `herdr_run_workflow` | `scriptPath` takes precedence over `script`, then saved `name`. Also accepts JSON-shaped `args` and `resumeFromRunId`. Returns a background run ID and script path. |
| `herdr_run_command` | Required `paneId` and `command`. Types a shell command and presses Enter in an existing raw pane. |
| `herdr_read_pane` | Required `paneId`. `source` is `recent`, `visible`, or `recent-unwrapped`. Defaults are `recent`, `lines: 50`, and `format: "text"`. Format can also be `ansi`. |
| `herdr_wait_output` | Required `paneId` and exactly one of literal `match` or Rust `regex`. Optional `source`, `lines`, `timeoutMs`, and `raw`. Searches existing output, then waits. Timeout defaults to 30000 ms. |
| `herdr_send_keys` | Required `target` and nonempty `keys` array of logical key names. `agentScope: true` addresses an agent name or label instead of a raw pane ID. Keys such as `ctrl+c` can interrupt a process. |

Schemas and implementations are in [src/tools](src/tools). Pane, tab, workspace, and manual worktree management remain in the herdr UI or CLI, not additional model-facing tools.

### Agent definitions and routing

Registry precedence is session-inline definitions, project `.pi/agents/*.md`, global `~/.pi/agent/agents/*.md`, then built-ins. The built-ins are `general-purpose`, `Explore`, and `Plan`. Omit both `type` and `agent` to resolve `general-purpose` through this registry. `Explore` and `Plan` are read-only search and planning agents.

An inline `agent` accepts `name`, `description`, `kind`, `model`, `thinking`, `system_prompt`, `prompt_mode`, `tools`, `exclude_tools`, `skills`, `agent_args`, `session_mode`, `auto_exit`, `interactive`, `spawning`, and `cwd`. `prompt_mode` is `replace` by default or `append`. Definitions use frontmatter keys `session-mode`, `auto-exit`, `deny-tools`, and `args` for the corresponding inline fields. Unknown frontmatter keys are ignored.

Model resolution uses five levels, in order:

1. Spawn `model`.
2. Definition `model`.
3. `models.agents.<definition-name>`.
4. `models.default`.
5. The parent session's model.

Model IDs must be exact, authenticated `provider/model-id` values in pi's registry. Invalid routing reports the level that supplied the value. A spawn's display `name` does not select the definition-name model pin.

Thinking uses **only spawn `thinking`, then definition `thinking`**. It does not inherit the parent's thinking or a settings model pin. If neither is set, the child uses its own default. Accepted values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. An explicit thinking pin is pi-only.

The `kind` selects the CLI through herdr's `agent start --kind`. A field that the chosen kind cannot enforce causes a refusal. Non-pi children do not receive pi's session-file, exact-result, or resume guarantees. Raw `agent_args` append after definition arguments, with later flags taking precedence.

### Sessions, isolation, and layout

Pi children use parent-owned session files with an injected child extension. Sessions remain available after a pane closes and appear as `herdr/<name>` in pi's `/resume`.

- `standalone` is the default, with a fresh session and no lineage.
- `lineage-only` adds a `parentSession` header link without copying turns.
- `fork` copies the parent conversation, truncated before the parent's last user message. Spawn `fork: true` overrides the definition's `session_mode`. The copy costs context tokens and is a snapshot, not live shared memory. Without a readable parent session file, the disk contents are empty even though the selected mode remains `fork`.

Children are autonomous by default and close their panes after completion. Set `agent: { interactive: true }` or `agent: { auto_exit: false }` to keep a pane open for follow-ups. These are definition fields, not top-level spawn parameters.

`isolated: true` creates a herdr-side Git worktree and cannot be combined with `cwd`. The worktree remains after the agent exits. Remove it separately when no longer needed. Prompts longer than 2000 characters use a retained `<session>.task.md` file.

Spawn gates run in order: kill-switch, spawn depth, then parallel cap. Exceeding the cap queues the accepted spawn.

Layout is read when a pane is created:

- `grid` is the default, with up to three equal-width columns and two rows, six live occupants per tab. On the orchestrator's tab, the main pane counts as an occupant. The seventh occupant opens another tab.
- Omit `group` to use the orchestrator's tab. In grid mode, a `group` uses tabs with that name. Full groups open another page. Later children use the earliest group page with room. An empty group is treated as omitted.
- `spiral` alternates right and down splits. The existing pane keeps the larger share. Spiral mode ignores `group`.

Changing `layout_mode` affects future pane creation only. It does not move existing panes.

### Results, messages, and recovery

For pi children spawned by this session, result inspection reads the exact final assistant text from the retained session JSONL, not a screen scrape. Mid-flight responses are interim snapshots. Failures expose typed errors. Non-pi children and panes spawned elsewhere use a potentially truncated pane-tail fallback.

Messages resolve a pane ID or herdr name first, then a spawn handle. The reserved `orchestrator` role is only the sender's direct parent; a same-name agent does not take it. A normal message uses an `<agent-message from="…" to="…">` envelope. Its identity is declared by the spawner, not verified.

A blocked freeform question takes raw text through the legacy `herdr_message_agent` (the message becomes its answer). An option-list question takes logical keys through `herdr_send_keys`. Queued children have no pane to receive a message, and gone targets refuse delivery.

Interrupt works only for this session's live pi children. It refuses non-pi, queued, settled, and gone children. After an interrupt, dispatch new work with `herdr_trigger_turn` (or correspond with `herdr_send_agent`). A gone pi child is recovered by `herdr_trigger_turn`, which auto-resumes the retained session, or by the maintenance entry `herdr_resume_agent` with a new `message`. Resume reuses the retained session file and re-resolves the definition and routing against current settings. Without a message, the resumed child replays the session and sits idle. Process-only state is not recovered.

Completion notifications carry the full final message of the run that produced them. A completion body is delivered to each receiver host once through the durable delivery ledger; `herdr_get_agent_result` with `reread: true` is the explicit repeat path. `normal` delivers at safe run boundaries without surprise wakes: after the parent has produced its final answer, a late completion only increments the unread count until the next natural run or an explicit wake subscription. `quiet` delivers on the next natural run without waking. `none` disables automatic delivery entirely — results stay stored for `wait`/`result`. Blocked and failure notices respect the same boundaries and never restart a finished parent on their own. Typing into a child pane is ordinary direct input: busy input queues safely, and it neither disables auto-close nor affects delivery.

The circular-wait fix affects **internal foreground result waits only**. New input lets that internal wait return an interim snapshot with `interruptedByInput`. It does not abort unrelated tools. Public result inspection remains single-shot. Background workflow waits explicitly use `inputWake: null` and still await child completion.

### Background workflows

`herdr_run_workflow` returns immediately. The script runs in a sandbox, and the parent receives one aggregated result when the run finishes. Child completion bodies are never separately pushed — the run reports once, so migration to the once-per-event delivery contract cannot duplicate child prose. Blocked children still request attention (respecting the notification setting).

Example `script` value:

```javascript
export const meta = { name: "parallel-review", description: "Review two files" };
const results = await parallel([
	() => agent("Review src/inputwake.ts", { label: "review-input" }),
	() => agent("Review src/tools/result.ts", { label: "review-result" }),
]);
return results.filter(Boolean);
```

The sandbox provides `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, and nested `workflow`. It has no filesystem, network, or `eval`. `Date.now()`, zero-argument `new Date()`, and `Math.random()` throw. Children are pi-only and pass through the same spawn gates.

`agent` options include `label`, `phase`, `agentType`, exact `model`, `effort`, `isolation: "worktree"`, a shell-command `gate`, a prior workflow child's `label` as `resume`, and structured-output `schema`. Labels must start with a lowercase letter and contain only lowercase letters, digits, hyphens, or underscores. Failed calls resolve to `null`. Await every launch. `parallel` is a barrier, while `pipeline` connects stages without a whole-stage barrier. Nested workflows have one level. `budget.total` is always `null`; `budget.spent()` reports output-token usage or `Infinity` when usage cannot be recovered.

Inline scripts auto-save to `.pi/workflows/<meta.name>.js`. Different contents use a numbered suffix. An unwritable project falls back to temporary scratch. Saved names resolve through `.pi/workflows/`, `.agents/workflows/`, then the global agent directory's `workflows/`.

To iterate, edit the returned file and run it with `scriptPath`. `resumeFromRunId` replays the unchanged prefix of a prior run in the same session. Changed or failed calls and their suffix run again. If the prior journal contains any agent resume call, no calls from that run are replayed. Workflow runs do not outlive the parent session. Disabling workflows refuses new runs, not those already running.

## Settings

Open `/subagents` or `/subagents config`. The menu edits settings and offers a confirmed **Kill all agents** action. There is no `/subagents set key value` command.

Settings merge from global `~/.pi/agent/herdr.json` and project `.pi/herdr.json`. Project values win per key, and `models.agents` merges per definition name. Malformed files are reported and ignored, not overwritten by the menu.

| Setting | Default | Effect |
| --- | --- | --- |
| `agents_kill_switch` | `false` | Refuses new spawns. Does not terminate existing children. |
| `default_kind` | `"pi"` | Default CLI kind. |
| `models.default` | unset | Fallback model before the parent model. |
| `models.agents` | `{}` | Map from agent definition names to model ID strings. |
| `max_parallel_agents` | `3` | Excess spawns queue. |
| `max_spawn_depth` | `2` | Limits recursive spawning. |
| `notifications` | `"normal"` | `normal` = safe run boundaries, no surprise wake; `quiet` = next natural run, no wake; `none` = stored pull-only. |
| `idle_rearm_minutes` | `15` | Legacy compatibility value; accepted in old config files but ignored. Ordinary input never changes pane recycling. |
| `workflows_enabled` | `true` | Registration is evaluated at load. A later disable refuses new runs. Reload to change the registered tool list. |
| `layout_mode` | `"grid"` | `grid` or `spiral`, applied to newly created panes. |

Spawn gates, model routing, and notifications read their settings when used. `HERDR_BIN` overrides the binary path. `PI_HERDR_NO_SELF_REPORT=1` disables self-report in that pi process.

## Limitations and platform support

- Upstream reports Windows and macOS testing. Linux is not verified. Check herdr's own platform availability separately.
- Self-report is pi-only. Other CLIs rely on herdr's TUI detection and internal status polling.
- A retained session records conversation, not every piece of process memory. Non-pi result reads are not exact session-file reads.
- Starting a child requires a working CLI, model authentication, and the server's environment. An accepted spawn is not proof of successful startup.

## Development

From a checkout, install **local development dependencies**, then run the repository scripts. These commands are for development, not an extension distribution channel:

```bash
npm install
npm test
npm run typecheck
npm run test:live
npm run test:multi
npm run test:stress
```

`npm test` runs offline suites. Live, multi-agent, and stress tests require a running herdr server and working model authentication. TypeScript loads directly, without a build step. Restart pi or reload after changes. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [documentation index](docs/README.md).

## Attribution and license

This fork retains the upstream project's [MIT license](LICENSE), © Andrew.

The workflow core derives from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents), under MIT. Ported modules include `runtime.ts`, `worker-source.ts`, `meta.ts`, `journal.ts`, `saved.ts`, `progress.ts`, and `json-schema.ts` in `src/workflow`, plus the child `StructuredOutput` tool. The card arrangement follows its `workflow-card.ts`. Source headers record the port provenance and changes. The host integration, run lifecycle, card module, and tool registration are pi-herdr code. The upstream un-awaited-launch error text is retained.
