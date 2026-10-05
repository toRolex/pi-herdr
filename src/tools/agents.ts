// The v0.5 agent surface — `herdr_spawn_agent`.
//
// One call: resolve the agent (registry `type` or inline `agent`), pass the
// gates, spawn a pane, submit the prompt, return {name, paneId, status}.
// The engine and every decision live in src/spawn.ts + src/agentdefs.ts;
// this file is the thin pi registration (name, description, schema, format).
//
// Tool naming keeps the repo's herdr_ prefix (wayfinder ticket 06's naming
// note: the charter's unprefixed names were shorthand).

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawnAgent } from "../spawn.js";
import { saveAgent } from "../agentdefs.js";
import type { AgentDirs } from "../agentdefs.js";
import {
	defaultAgentDirs,
	effectiveRoster,
	renderRoster,
} from "../agentdefs.js";
import type { ToolReturn } from "../env.js";

const ROSTER_TOOL_NAME = "herdr_spawn_agent";

/** The system-prompt section key the Roster is delivered under (spec 22,
 * ticket 25). pi renders each section as `<key>…</key>`, so the model sees
 * `<agent-roster>…</agent-roster>`. */
const ROSTER_SECTION = "agent-roster";

function fail(message: string, code: string, details?: unknown): ToolReturn {
	return {
		content: [{ type: "text", text: `Error (${code}): ${message}` }],
		details: { error: { code, message, details } },
		isError: true,
	};
}

/** The honest fork costs (issue 09, wayfinder ticket 05) — one wording shared
 * by the tool description and the fork param description. */
const FORK_COSTS =
	'A context-copy tax (the child re-processes the whole conversation) and a snapshot (freezes at spawn; the delivered result is the only sync-back) — for "you know what we have discussed, now do X", never a default.';

const DESCRIPTION =
	"Spawn a background AI agent in a herdr pane, submit the task prompt, and return " +
	"{name, paneId, status}. Address the agent by `name` afterwards. " +
	"Specify the agent by `type` (registry), an inline `agent` definition, or NEITHER — " +
	"a prompt-only spawn (just `prompt`, optionally `name`) defaults to the built-in general-purpose " +
	"type (pi kind, autonomous stance). `type` and `agent` are mutually exclusive — never both. " +
	"The current agent menu (the effective Roster) is delivered in the `<agent-roster>` " +
	"section of the system prompt every turn — choose types from it, not from a static list. " +
	"Inline `agent` fields: name, description, kind, model, thinking, system_prompt, prompt_mode " +
	"(replace|append, default replace), tools, exclude_tools, skills (pi-only), agent_args " +
	"(raw CLI flags), session_mode (standalone|lineage-only|fork), auto_exit, interactive, " +
	"spawning, cwd. Honesty rule: a field the chosen kind cannot enforce refuses the spawn " +
	"naming the field — use agent_args or another kind. `kind` (default: settings default_kind, " +
	"'pi') is an unopinionated passthrough onto herdr's native `agent start --kind` axis: a non-pi " +
	"child is text in a pane with a TUI-detected lifecycle, nothing else. " +
	"`kind`/`model`/`thinking` override the definition's; unset ones resolve down the routing chain — " +
	"spawn param > frontmatter > models.agents.<name> (settings) > models.default (settings) > this session's model — " +
	"exact authenticated provider/model-id only, no fuzzy resolution; a bad value refuses the spawn naming the routing level " +
	"that supplied it. Thinking never inherits from the parent (the child keeps its own default). Every pi child runs on a parent-owned session file in " +
	"pi's default sessions dir (`--session`, seeded before launch), loads the injected child extension " +
	"(`agent_done`, identity strip, typed completion sidecars), and is named `herdr/<name>` in /resume — " +
	"the session file is the source of truth for its result; sessions are never deleted. Session modes (pi children): " +
	"`standalone` (default — fresh, no lineage); `lineage-only` (the child's header carries the parentSession link to this session, zero copied turns — " +
	"/resume shows the relationship); `fork` (this conversation is copied into the child's session, truncated just before your last user message — " +
	"the child boots knowing everything discussed and receives its prompt as the natural next user turn). Honest costs: fork is a " +
	FORK_COSTS + " Select via frontmatter `session-mode:` or force with the spawn-level `fork: true`. Prompts over " +
	"2000 chars are written to `<session>.task.md` and delivered as a one-line reference. Raw CLI flags " +
	"ride `agent_args` (spawn level, appended after the definition's `args:` — last-wins). Stance (v0.6): " +
	"autonomous by default (auto-exit on settle; pane closes, session retained), `interactive: true` or " +
	"`auto_exit: false` keeps the pane open. Always returns immediately: accepted as `starting` " +
	"(the child is not promised to have booted), or `queued` when the fleet is at max_parallel_agents " +
	"(no pane until a slot frees). There is no wait parameter — a caller-supplied wait is ignored and " +
	"cannot block this call. The result arrives later by push-on-completion (the notifications setting) " +
	"or by herdr_get_agent_result. " +
	"`isolated: true` runs the agent in a fresh auto-created herdr-side git worktree " +
	"(worktree stays after the agent — remove it yourself with `herdr worktree remove` or git). " +
	"Gates, checked in order before any side effect: kill-switch, spawn depth, parallel cap. " +
	"Layout follows the `layout_mode` setting, read when the pane is created: `grid` " +
		"(the default) fills an equal-width 3×2 and opens another tab for the 7th live occupant; " +
		"`spiral` is the golden spiral — alternating right/down, the existing pane keeps the larger share. " +
		"Omit `group` to land on the orchestrator's tab; pass `group` to gather related agents on a tab " +
		"titled with that name (a full page of 6 opens another tab of the same group, and the next " +
		"member of the group fills the earliest page that still has room). Changing `layout_mode` never " +
		"moves a pane that already exists.";

/** The inline `agent: {…}` definition schema — shared by spawn_agent and save_agent. */
const AGENT_DEF_SCHEMA = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"Definition name; registers session-ephemerally (addressable by type later).",
		}),
	),
	description: Type.Optional(Type.String()),
	kind: Type.Optional(
		Type.String({ description: "Agent kind (default: settings default_kind)." }),
	),
	model: Type.Optional(
		Type.String({ description: "Model pin (omit to inherit)." }),
	),
	thinking: Type.Optional(
		Type.String({ description: "Thinking-level pin (omit to inherit)." }),
	),
	system_prompt: Type.Optional(
		Type.String({ description: "System prompt; empty = child CLI default." }),
	),
	prompt_mode: Type.Optional(
		StringEnum(["replace", "append"] as const, {
			description: "How system_prompt applies (default replace).",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Tool allowlist, e.g. [read, bash, grep, find, ls].",
		}),
	),
	exclude_tools: Type.Optional(
		Type.Array(Type.String(), { description: "Tool denylist." }),
	),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Skill paths to preload (pi-only; other kinds refuse).",
		}),
	),
	agent_args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Raw agent-CLI flags appended last (escape hatch).",
		}),
	),
	session_mode: Type.Optional(
		StringEnum(["standalone", "lineage-only", "fork"] as const, {
			description: "How the child session begins (default standalone).",
		}),
	),
	auto_exit: Type.Optional(
		Type.Boolean({
			description:
				"Stance: auto-exit on settle — autonomous (default when interactive unset).",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Stance override: pane intentionally open, stall pings suppressed.",
		}),
	),
	spawning: Type.Optional(
		Type.Boolean({ description: "Whether this agent may spawn children." }),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for spawns of this definition.",
		}),
	),
});

/** The call the tool's execute makes. Exported so tests drive the same
 * path (detach, wait stripped) without a pi session. */
export function spawnFromTool(
	p: {
		prompt: string;
		fork?: boolean;
		type?: string;
		agent?: unknown;
		name?: string;
		kind?: string;
		model?: string;
		thinking?: string;
		agent_args?: string[];
		cwd?: string;
		isolated?: boolean;
		group?: string;
	},
	deps: Parameters<typeof spawnAgent>[1],
): ReturnType<typeof spawnAgent> {
	return spawnAgent(
		{
			prompt: p.prompt,
			fork: p.fork,
			type: p.type,
			agent: p.agent,
			name: p.name,
			kind: p.kind,
			model: p.model,
			thinking: p.thinking,
			agent_args: p.agent_args,
			cwd: p.cwd,
			isolated: p.isolated,
			group: p.group,
			detach: true,
		},
		deps,
	);
}

export function registerAgents(
	pi: ExtensionAPI,
	opts: { dirs?: AgentDirs } = {},
): void {
	const dirs = opts.dirs ?? defaultAgentDirs();
	// The Roster's delivery path (spec 22 / ticket 25): a dedicated
	// `<agent-roster>` system-prompt section, (re)written every turn on
	// before_agent_start — assignment is naturally idempotent. Rendering goes
	// through the unchanged renderRoster contract (layer order, sorting,
	// lossless names, 512-byte description budget, deterministic bytes); the
	// linkage line satisfies the spec's two-way pointing (section names the
	// tool and the `type` parameter) without touching the frozen render.
	// Gating: only when the spawn tool is active this turn; and only this
	// key is touched — other extensions' sections pass through untouched.
	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions.sections;
		if (!event.systemPromptOptions.selectedTools.includes(ROSTER_TOOL_NAME)) {
			// Never leave a stale roster behind when the tool is inactive.
			delete sections[ROSTER_SECTION];
			return;
		}
		if (effectiveRoster(dirs).length === 0) {
			// Defensive: an empty registry should not produce an empty XML
			// section. Unreachable in practice (built-ins are always present).
			delete sections[ROSTER_SECTION];
			return;
		}
		sections[ROSTER_SECTION] =
			"This is the agent menu for herdr_spawn_agent — each entry name maps " +
			"to its `type` parameter.\n" + renderRoster(dirs);
	});
	pi.registerTool({
		name: "herdr_spawn_agent",
		label: "Spawn herdr agent",
		description: DESCRIPTION,
		promptSnippet: "Spawn a background herdr agent pane running a task prompt",
		promptGuidelines: [
			"Use herdr_spawn_agent to fan out background work: it spawns the pane, submits the prompt, and returns a handle you address later.",
			"For herdr_spawn_agent, choose an agent by matching the task to the responsibilities in the current roster.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "Task for the agent (its first prompt).",
			}),
			type: Type.Optional(
				Type.String({
					description:
						'Registry agent type, e.g. "general-purpose", "Explore", "Plan", or a session inline definition name. Omit both type and agent to spawn the general-purpose default on the prompt alone; never pass both.',
				}),
			),
			agent: Type.Optional(AGENT_DEF_SCHEMA),
			name: Type.Optional(
				Type.String({
					description:
						"Pane handle for addressing the agent later (fallback chain when omitted/taken: definition name → agent-<timestamp>, uniquified).",
				}),
			),
			kind: Type.Optional(
				Type.String({ description: "Kind override (merges over the definition)." }),
			),
			model: Type.Optional(
				Type.String({
					description: "Model override (merges over the definition).",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking-level override (routing level 1): off|minimal|low|medium|high|xhigh|max. Pi children only — other kinds refuse an explicit pin.",
				}),
			),
			fork: Type.Optional(
				Type.Boolean({
					description:
						'Force session_mode "fork" (pi children): the child boots with THIS conversation (truncated just before your last user message) as context, then receives the prompt as its natural next turn. Overrides the definition\'s session_mode. ' +
						FORK_COSTS,
				}),
			),
			agent_args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Raw agent-CLI flags appended after the definition's args: — later duplicates win (last-wins override).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory (mutually exclusive with isolated).",
				}),
			),
			isolated: Type.Optional(
				Type.Boolean({
					description: "Spawn into a fresh auto-created herdr-side git worktree.",
				}),
			),
			group: Type.Optional(
				Type.String({
					description:
						"Task category. The same group shares one tab (a new name opens a new tab; a full grid of 6 opens another tab of the same group, and later members fill the earliest page with room). Omit to stay on the orchestrator's tab. Empty is treated as omitted. Honored when layout_mode is grid.",
				}),
			),
		}),
		async execute(
			_id,
			p,
			signal,
			_onUpdate,
			ctx: ExtensionContext | undefined,
		) {
			const r = await spawnFromTool(p, {
					signal,
					// Routing level 5 (parent session's model) + exact-model
					// validation come from THIS session's pi context.
					parent:
						ctx?.model
							? { model: { provider: ctx.model.provider, id: ctx.model.id } }
							: undefined,
					registry: ctx?.modelRegistry,
					// Session modes (issue 09): the parent's own session file is
					// both the `parentSession` header link and the fork source.
					parentSession: ctx?.sessionManager?.getSessionFile() ?? undefined,
				},
			);
			if (!r.ok) return fail(r.error.message, r.error.code, r.error.details);
			const d = r.data;
			const type = d.type ? ` (type ${d.type})` : "";
			const stance = ` Stance: ${d.stance}.`;
			// Manual e2e F12: a fired specifier coercion is surfaced, not silent —
			// the caller should know the shape it passed was not taken literally.
			const coerced = d.coercedNote ? ` Note: ${d.coercedNote}.` : "";
			// starting/queued are accept-time facts. Do not report a pane id or
			// session path here — those would claim the child has booted.
			const text = d.queued
				? `Spawn accepted as QUEUED: "${d.name}"${type} — fleet is at max_parallel_agents; the pane starts when a slot frees. The child is not started yet.${stance}${coerced}`
				: `Spawn accepted as STARTING: "${d.name}"${type} (${d.kind}). The child is not promised to have booted; status: ${d.status}.${stance}${coerced}`;
			return {
				content: [{ type: "text", text }],
				details: d,
			};
		},
	});

	// save_agent --------------------------------------------------------------
	pi.registerTool({
		name: "herdr_save_agent",
		label: "Save agent definition",
		description:
			"Persist an agent definition to the `.md` registry so every session (this one included) " +
			"can spawn it by `type`. Source is EITHER an inline `agent` definition OR the `type` of an " +
			"existing registry entry (session inline, `.md` file, or built-in — saving a copy of a " +
			"built-in to customize it is fine). Target folder: `project` (`.pi/agents/`, default — " +
			"local and reversible) or `global` (the user-wide agents dir). The file is `---` frontmatter " +
			"(`name`, `description`, `kind`, `model`, `thinking`, `session-mode`, `auto-exit`, " +
			"`interactive`, `spawning`, `tools`, `deny-tools`, `skills`, `args`, `cwd`, `prompt_mode`) " +
			"plus the system prompt as the body; unknown keys in hand-written files are ignored (the " +
			"folder is shared with other agent tools). Ungated by design — deleting the file undoes it. " +
			"Refuses to overwrite an existing file unless `overwrite: true`.",
		promptSnippet: "Persist an inline agent definition to the .md registry",
		promptGuidelines: [
			"Use herdr_save_agent when a task defines an agent worth reusing: it writes the .md file the registry resolves by type.",
			"Prefer the project target (reversible via file deletion); go global only when the user asks for a user-wide agent.",
		],
		parameters: Type.Object({
			agent: Type.Optional(AGENT_DEF_SCHEMA),
			type: Type.Optional(
				Type.String({
					description:
						"Registry name of an existing definition to persist (inline definitions must carry a name). Exactly one of type/agent.",
				}),
			),
			target: Type.Optional(
				StringEnum(["project", "global"] as const, {
					description: "Which registry folder to write (default: project).",
				}),
			),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
						"Replace an existing file at the target path (default: refuse).",
				}),
			),
		}),
		async execute(_id, p) {
			const r = saveAgent({
				type: p.type,
				agent: p.agent,
				target: p.target,
				overwrite: p.overwrite,
			});
			if (!r.ok) return fail(r.error.message, r.error.code, r.error.details);
			const d = r.data;
			return {
				content: [
					{
						type: "text",
						text: `Saved agent "${d.name}" to ${d.path} (${d.target} registry) — spawn it by type "${d.name}" in any session.`,
					},
				],
				details: d,
			};
		},
	});
}
