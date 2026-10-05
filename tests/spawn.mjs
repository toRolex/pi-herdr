// Tests for the spawn_agent tracer bullet (issue 02): specifier xor, the
// verbatim built-in trio, the name fallback chain, kind/model merge with
// enforce-or-error, the gate order (kill-switch → depth → cap), the queued
// spawn + drain, isolated worktrees, the wait vocabulary, and the child env
// contract (PI_HERDR_SPAWN_DEPTH / PI_HERDR_ORCHESTRATOR_PANE).
//
// No live herdr server required: every herdr-facing seam is injected, and no
// test depends on wall-clock timing — fakes settle instantly and `wait: 0`
// exercises expiry paths deterministically.
//
// NOTE: agentdefs APIs are consumed through src/spawn.ts's re-exports — the
// session registry is mutable module state and must have exactly ONE jiti
// instance in this process (importing src/agentdefs.ts directly here would
// create a second, split-brain instance).
//
// Run: node tests/spawn.mjs

import { createJiti } from "jiti";
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}
function eq(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

const spawn = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });
const agentsTool = await jiti.import(join(ROOT, "src/tools/agents.ts"), {
	parent: ROOT,
});
const settingsMod = await jiti.import(join(ROOT, "src/settings.ts"), {
	parent: ROOT,
});
const TINTINWEB = JSON.parse(
	readFileSync(
		join(ROOT, "tests/fixtures/tintinweb-default-agents.json"),
		"utf8",
	),
);

// fresh state between sections
function reset() {
	spawn.clearSessionAgents();
	spawn.clearSpawnRegistry();
}

// ---------------------------------------------------------------------------
console.log("\n[1] `type` xor `agent` — exactly one");
{
	reset();
	const both = spawn.resolveSpecifier({ type: "Explore", agent: { name: "x" } });
	assert(
		!both.ok && /exactly one/i.test(both.error.message),
		"both type+agent errors mentioning 'exactly one'",
	);
	const neither = spawn.resolveSpecifier({});
	assert(
		!neither.ok && /one of/i.test(neither.error.message),
		"bare resolveSpecifier (no opt-in) still errors asking for one — save_agent keeps the demand",
	);
	// Manual e2e F1: the prompt-only default rides the ordinary registry path
	// (inline=false, built-in layer) — the spawn surface opts in per call.
	const defaulted = spawn.resolveSpecifier(
		{},
		undefined,
		{ defaultType: "general-purpose" },
	);
	assert(
		defaulted.ok &&
			defaulted.data.definition.name === "general-purpose" &&
			defaulted.data.inline === false,
		"prompt-only specifier (neither type nor agent) resolves the general-purpose registry type",
	);
	const badInline = spawn.resolveSpecifier({
		agent: { name: "x", tools: ["read", 5] },
	});
	assert(
		!badInline.ok && /agent\.tools/.test(badInline.error.message),
		"inline field type error names the field",
	);
	const unknownKeys = spawn.resolveSpecifier({
		agent: { name: "x", thinking: "high", max_turns: 10 },
	});
	assert(unknownKeys.ok, "unknown inline keys ignored (cross-dialect no-ops)");

	// Manual e2e F12 boundary coercion: wrong-shape single-side specifiers
	// coerce instead of refusing — a bare string cannot be an inline def, a
	// non-string object cannot be a registry name. Both-present still refuses.
	const coercedType = spawn.resolveSpecifier({ agent: "Explore" });
	assert(
		coercedType.ok &&
			coercedType.data.inline === false &&
			coercedType.data.definition.name === "Explore" &&
			coercedType.data.coerced === "specifier coerced — agent string treated as type 'Explore'",
		"agent string coerces to the registry type, honestly noted",
	);
	const coercedInline = spawn.resolveSpecifier({
		type: { name: "x", system_prompt: "do x" },
	});
	assert(
		coercedInline.ok &&
			coercedInline.data.inline === true &&
			coercedInline.data.definition.name === "x" &&
			coercedInline.data.coerced ===
				"specifier coerced — type object treated as the inline agent definition",
		"type object coerces to the inline definition, honestly noted",
	);
	const bothWrongShapes = spawn.resolveSpecifier({
		type: { name: "x" },
		agent: "Explore",
	});
	assert(
		!bothWrongShapes.ok && /exactly one/i.test(bothWrongShapes.error.message),
		"both-present refuses BEFORE coercion even when both shapes are wrong",
	);

	// Engine-level: the coercion lands on the spawn record and the result.
	reset();
	const hCo = makeDeps({ env: { HERDR_PANE_ID: "w1:p1" } });
	const rCo = await spawn.spawnAgent(
		{ prompt: "search it", agent: "Explore", name: "coerced-scout" },
		hCo.deps,
	);
	assert(rCo.ok, `agent-string spawn ok (${rCo.ok ? "" : rCo.error.message})`);
	assert(
		rCo.data.type === "Explore" && rCo.data.coercedNote !== undefined,
		"engine: agent string treated as type, coercedNote surfaced",
	);
	reset();
	const hIn = makeDeps({ env: { HERDR_PANE_ID: "w1:p1" } });
	const rIn = await spawn.spawnAgent(
		{ prompt: "inline it", type: { name: "inl", system_prompt: "p" }, name: "coerced-inline" },
		hIn.deps,
	);
	assert(rIn.ok, `type-object spawn ok (${rIn.ok ? "" : rIn.error.message})`);
	assert(
		rIn.data.coercedNote !== undefined && rIn.data.type === "inl",
		"engine: type object treated as inline definition, coercedNote surfaced",
	);
	reset();
}

// ---------------------------------------------------------------------------
console.log("\n[2] Built-in trio — tintinweb content verbatim, no model pins");
{
	reset();
	const B = spawn.BUILT_IN_AGENTS;
	assert(
		eq([...B.keys()], ["general-purpose", "Explore", "Plan"]),
		"exactly the trio, in order",
	);
	for (const [key, fx] of Object.entries(TINTINWEB)) {
		const b = B.get(key);
		assert(!!b, `${key} present`);
		assert(b.name === fx.name, `${key} name verbatim`);
		assert(b.description === fx.description, `${key} description verbatim`);
		assert(b.system_prompt === fx.systemPrompt, `${key} system prompt verbatim`);
		assert(
			eq(b.tools ?? null, fx.builtinToolNames),
			`${key} tools ${fx.builtinToolNames ? "allowlist verbatim" : "= all tools (omitted)"}`,
		);
		assert(
			b.prompt_mode === fx.promptMode,
			`${key} prompt_mode ${fx.promptMode} verbatim`,
		);
		assert(b.model === undefined, `${key} carries NO model pin (inherit)`);
		assert(b.kind === "pi", `${key} kind pi`);
	}
	// the fixture proves the pin existed in tintinweb and we dropped it on purpose
	assert(
		TINTINWEB.Explore.model === "anthropic/claude-haiku-4-5",
		"fixture records tintinweb's Explore pin (deliberately dropped)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[3] Unknown `type` errors listing available types");
{
	reset();
	const r = spawn.resolveAgentType("nope");
	assert(!r.ok, "unknown type errors");
	assert(
		["general-purpose", "Explore", "Plan"].every((n) =>
			r.error.message.includes(n),
		),
		"error lists the built-in trio",
	);
	spawn.registerSessionAgent({ name: "my-inline", description: "d" });
	const r2 = spawn.resolveAgentType("nope");
	assert(
		r2.error.message.includes("my-inline"),
		"error lists session inline definitions too",
	);
	// File-layer behavior has its own suite; do not read developer agent folders.
	const layers = spawn.listAgentTypes({ project: join(ROOT, "tests/fixtures/no-project-agents"), global: join(ROOT, "tests/fixtures/no-global-agents") }).map((t) => t.name);
	assert(
		eq(layers, ["my-inline", "general-purpose", "Explore", "Plan"]),
		"listAgentTypes: session first, then built-ins",
	);
	// session shadows built-in (precedence observable today; file layers come with the .md ticket)
	spawn.registerSessionAgent({ name: "Explore", description: "shadow" });
	assert(
		spawn.resolveAgentType("Explore").data.layer === "session",
		"session layer shadows a same-name built-in",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[4] `name` fallback chain → unique pane handle");
{
	reset();
	const taken = new Set(["alpha", "beta"]);
	assert(
		spawn.uniqueHandle("alpha", taken) === "alpha-2",
		"taken name falls back to -2",
	);
	taken.add("alpha-2");
	assert(spawn.uniqueHandle("alpha", taken) === "alpha-3", "chain continues -3");
	assert(spawn.uniqueHandle("gamma", taken) === "gamma", "free name untouched");
}

// ---------------------------------------------------------------------------
console.log("\n[5] kind/model merge + enforce-or-error per kind");
{
	reset();
	const gp = { name: "gp", kind: "pi" };
	// merge order: spawn param > definition > default
	const m1 = spawn.mergeSpawnSpec(gp, { kind: "claude", model: "m1" }, "pi");
	assert(m1.kind === "claude" && m1.model === "m1", "spawn params win");
	const m2 = spawn.mergeSpawnSpec(
		{ name: "d", kind: "codex", model: "dm" },
		{},
		"pi",
	);
	assert(
		m2.kind === "codex" && m2.model === "dm",
		"definition fills when param absent",
	);
	const m3 = spawn.mergeSpawnSpec({ name: "d" }, {}, "pi");
	assert(m3.kind === "pi", "settings default_kind fills the chain");
	// enforcement
	assert(
		spawn.validateKindEnforcement(m1) === null,
		"pi spec with all fields is fine",
	);
	const skillsOnClaude = spawn.mergeSpawnSpec(
		{ name: "x", skills: ["/skills/foo"] },
		{ kind: "claude" },
		"pi",
	);
	const e1 = spawn.validateKindEnforcement(skillsOnClaude);
	assert(
		!!e1 &&
			/"skills"/.test(e1.error.message) &&
			/agent_args/.test(e1.error.message),
		"claude + skills errors naming the field, pointing at agent_args",
	);
	const sysOnCodex = spawn.mergeSpawnSpec(
		{ name: "x", system_prompt: "be brief" },
		{ kind: "codex" },
		"pi",
	);
	assert(
		/spawn|system_prompt/.test(
			String(spawn.validateKindEnforcement(sysOnCodex)?.error.message),
		),
		"codex + system_prompt errors",
	);
	const modelOnCodex = spawn.mergeSpawnSpec(
		{ name: "x", model: "o3" },
		{ kind: "codex" },
		"pi",
	);
	assert(
		spawn.validateKindEnforcement(modelOnCodex) === null,
		"codex + model is allowed (verified -m flag)",
	);
	const modelOnUnknown = spawn.mergeSpawnSpec(
		{ name: "x", model: "z" },
		{ kind: "kimi" },
		"pi",
	);
	const e2 = spawn.validateKindEnforcement(modelOnUnknown);
	assert(
		!!e2 && /"model"/.test(e2.error.message),
		"unknown kind + model errors (passthrough knows no flags)",
	);
	const modelOnGemini = spawn.mergeSpawnSpec(
		{ name: "x", model: "z" },
		{ kind: "gemini" },
		"pi",
	);
	assert(
		spawn.validateKindEnforcement(modelOnGemini) === null,
		"gemini + model allowed (verified --model)",
	);
	// merged validation once: definition field + kind override must agree
	const exploreAsClaude = spawn.mergeSpawnSpec(
		spawn.resolveAgentType("Explore").data.definition,
		{ kind: "claude" },
		"pi",
	);
	assert(
		spawn.validateKindEnforcement(exploreAsClaude) === null,
		"Explore + kind claude merges cleanly (claude enforces its fields)",
	);
	const planAsCodex = spawn.mergeSpawnSpec(
		spawn.resolveAgentType("Plan").data.definition,
		{ kind: "codex" },
		"pi",
	);
	const e3 = spawn.validateKindEnforcement(planAsCodex);
	assert(
		!!e3 && e3.error.details?.field === "system_prompt",
		"Plan + kind codex errors on the MERGED spec (system_prompt)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6] buildAgentArgs — definition → CLI flags per kind");
{
	reset();
	const explore = spawn.resolveAgentType("Explore").data.definition;
	const spec = spawn.mergeSpawnSpec(explore, {}, "pi");
	const args = spawn.buildAgentArgs(spec);
	assert(
		args[0] === "--system-prompt" && args[1] === explore.system_prompt,
		"Explore pins its read-only system prompt (replace mode)",
	);
	assert(
		args.includes("--tools") &&
			args[args.indexOf("--tools") + 1] === "read,bash,grep,find,ls",
		"Explore allowlist joins comma-separated",
	);
	const gpSpec = spawn.mergeSpawnSpec(
		spawn.resolveAgentType("general-purpose").data.definition,
		{},
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(gpSpec), []),
		"general-purpose passes no flags (empty prompt, all tools, no model)",
	);
	const appended = spawn.mergeSpawnSpec(
		{ name: "x", system_prompt: "extra", prompt_mode: "append" },
		{},
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(appended), ["--append-system-prompt", "extra"]),
		"prompt_mode append maps to --append-system-prompt",
	);
	const skillsSpec = spawn.mergeSpawnSpec(
		{ name: "x", skills: ["/a", "/b"], model: "m" },
		{},
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(skillsSpec), [
			"--model",
			"m",
			"--skill",
			"/a",
			"--skill",
			"/b",
		]),
		"skills repeat --skill; model pins",
	);
	const claudeDeny = spawn.mergeSpawnSpec(
		{ name: "x", exclude_tools: ["write"] },
		{ kind: "claude" },
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(claudeDeny), ["--disallowedTools", "write"]),
		"claude denylist maps to --disallowedTools",
	);
	const raw = spawn.mergeSpawnSpec(
		{ name: "x", agent_args: ["--continue"] },
		{ kind: "claude" },
		"pi",
	);
	assert(
		eq(spawn.buildAgentArgs(raw), ["--continue"]),
		"agent_args passthrough (raw flags last)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[6b] multiline args — temp-file carrier (pi) or honest refusal");
{
	reset();
	const writes = [];
	const deps = {
		writeFile: (p, t) => writes.push({ p, t }),
		tmpPath: (h, n) => `/tmp/${h}-${n}.md`,
	};
	const ok = spawn.materializeAgentArgs(
		["--system-prompt", "a\nb", "--tools", "read"],
		"exp",
		"pi",
		deps,
	);
	assert(
		ok.ok && eq(ok.data, ["--system-prompt", "/tmp/exp-1.md", "--tools", "read"]),
		"pi multiline prompt → temp-file path substituted in place",
	);
	assert(
		writes.length === 1 &&
			writes[0].p === "/tmp/exp-1.md" &&
			writes[0].t === "a\nb",
		"prompt file written verbatim",
	);
	const two = spawn.materializeAgentArgs(
		["--append-system-prompt", "x\n", "--append-system-prompt", "y\n"],
		"exp",
		"pi",
		deps,
	);
	assert(
		two.ok && two.data[1] === "/tmp/exp-1.md" && two.data[3] === "/tmp/exp-2.md",
		"repeatable append values get distinct files",
	);
	const claude = spawn.materializeAgentArgs(
		["--system-prompt", "a\nb"],
		"e",
		"claude",
		deps,
	);
	assert(
		!claude.ok && /claude.*no file-based/.test(claude.error.message),
		"claude multiline prompt refuses (no file flag)",
	);
	const other = spawn.materializeAgentArgs(["--model", "x\ny"], "e", "pi", deps);
	assert(
		!other.ok && /--model/.test(other.error.message),
		"non-prompt multiline value refuses naming the flag",
	);
	const single = spawn.materializeAgentArgs(
		["--system-prompt", "one line"],
		"e",
		"pi",
		deps,
	);
	assert(
		single.ok &&
			eq(single.data, ["--system-prompt", "one line"]) &&
			writes.length === 3,
		"single-line values pass through untouched",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[7] Spawn depth — env counter, boundary correct");
{
	reset();
	assert(spawn.parseSpawnDepth(undefined) === 1, "unset = 1");
	assert(spawn.parseSpawnDepth("") === 1, "empty = 1");
	assert(spawn.parseSpawnDepth("3") === 3, "valid int parses");
	assert(spawn.parseSpawnDepth("garbage") === 1, "malformed = 1");
	assert(spawn.parseSpawnDepth("0") === 1, "non-positive = 1");
	const S = (over) => ({ ...settingsMod.DEFAULT_SETTINGS, ...over });
	// default max_spawn_depth = 2
	assert(
		spawn.checkGates(S({}), {}, 0).decision === "spawn",
		"root (unset=1) → child 2 ≤ max 2: allowed",
	);
	assert(
		spawn.checkGates(S({}), { PI_HERDR_SPAWN_DEPTH: "2" }, 0).decision ===
			"refuse",
		"depth 2 → child 3 > max 2: refused",
	);
	assert(
		spawn.checkGates(S({ max_spawn_depth: 1 }), {}, 0).decision === "refuse",
		"max 1 → root cannot spawn at all",
	);
	assert(
		spawn.checkGates(S({ max_spawn_depth: 3 }), { PI_HERDR_SPAWN_DEPTH: "2" }, 0)
			.decision === "spawn",
		"max 3, depth 2 → child 3: allowed",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[8] Gate order — kill-switch before depth before cap");
{
	reset();
	const S = (over) => ({ ...settingsMod.DEFAULT_SETTINGS, ...over });
	const allBad = S({
		agents_kill_switch: true,
		max_spawn_depth: 1, // depth would refuse too
		max_parallel_agents: 1, // cap would queue too
	});
	const r1 = spawn.checkGates(allBad, { PI_HERDR_SPAWN_DEPTH: "1" }, 5);
	assert(
		r1.decision === "refuse" && /kill_switch/.test(r1.error.message),
		"kill-switch wins when all three gates trip",
	);
	const depthAndCap = S({ max_spawn_depth: 1, max_parallel_agents: 1 });
	const r2 = spawn.checkGates(depthAndCap, { PI_HERDR_SPAWN_DEPTH: "1" }, 5);
	assert(
		r2.decision === "refuse" && /spawn depth/.test(r2.error.message),
		"depth wins over cap",
	);
	const capOnly = S({ max_parallel_agents: 1 });
	const r3 = spawn.checkGates(capOnly, {}, 1);
	assert(r3.decision === "queue", "cap alone queues (accepted, not refused)");
	const clear = spawn.checkGates(S({}), {}, 0);
	assert(clear.decision === "spawn", "all clear spawns");
}

// ---------------------------------------------------------------------------
// Engine harness: every herdr-facing seam injected; autodrain off so queue
// tests drive drains explicitly (no timers, no wall-clock dependence).
function makeDeps(opts = {}) {
	const calls = { start: [], submit: [], worktree: [] };
	const live = opts.live ?? []; // [{name, paneId, agent_status}]
	const panesBox = { current: opts.panes ?? null }; // [paneId,...] — null → derive from live
	return {
		calls,
		live,
		panes: panesBox,
		deps: {
			load: () => ({ ...settingsMod.DEFAULT_SETTINGS, ...opts.settings }),
			kinds: async () => opts.kinds ?? ["pi", "claude", "codex", "gemini"],
			list: async () =>
				live
					.filter((a) => a.paneId)
					.map((a) => ({ name: a.name, paneId: a.paneId })),
			paneList: async () =>
				panesBox.current ?? live.filter((a) => a.paneId).map((a) => a.paneId),
			start: async (input) => {
				if (opts.startDelayMs)
						await new Promise((r) => setTimeout(r, opts.startDelayMs));
				calls.start.push(input);
				const paneId = `p${calls.start.length}`;
				live.push({ name: input.name, paneId, agent_status: "idle" });
				return { ok: true, data: { agent: { pane_id: paneId } } };
			},
			boot: async () => ({ ok: true, data: true }),
			submit: async (paneId, text) => {
				calls.submit.push({ paneId, text });
				const a = live.find((x) => x.paneId === paneId);
				if (a) a.agent_status = "working";
				return { ok: true, data: true };
			},
			status: async (paneId) => {
				const a = live.find((x) => x.paneId === paneId);
				return a
					? { ok: true, data: a.agent_status }
					: { ok: false, error: { code: "NOT_FOUND", message: "agent gone" } };
			},
			worktree: async (cwd) => {
				calls.worktree.push(cwd);
				return { ok: true, data: "D:/wt/auto-branch" };
			},
			seed: (cwd) => {
				calls.seed = calls.seed ?? [];
				calls.seed.push(cwd);
				return {
					path: `D:/tmp/sessions/${calls.seed.length}.jsonl`,
					dir: "D:/tmp/sessions",
				};
			},
			childExtension: "D:/ext/child.ts",
			env: opts.env ?? {},
			autodrain: false,
		},
	};
}

// Grid harness: a fake herdr that answers pane/tab queries and records the
// commands placeOnGrid runs before the pane is created. `start` still lands
// in calls.start, so assertions read the launch the engine actually asked for.
function makeGridDeps(opts = {}) {
	const base = makeDeps(opts);
	const settings = base.deps.load();
	base.deps.load = () => settings;
	const world = {
		panes: [{ pane_id: "w9:p1", tab_id: "t-main" }],
		tabs: [{ tab_id: "t-main", label: "main" }],
		next: 1,
	};
	const commands = [];
	base.deps.herdr = async (args) => {
		commands.push(args);
		const [noun, verb] = args;
		if (noun === "pane" && verb === "current") {
			return {
				ok: true,
				data: {
					pane: {
						pane_id: "w9:p1",
						tab_id: "t-main",
						workspace_id: "ws",
					},
				},
			};
		}
		if (noun === "pane" && verb === "list") {
			return { ok: true, data: { panes: world.panes.map((p) => ({ ...p })) } };
		}
		if (noun === "tab" && verb === "list") {
			return { ok: true, data: { tabs: world.tabs.map((t) => ({ ...t })) } };
		}
		if (noun === "tab" && verb === "create") {
			const labelAt = args.indexOf("--label");
			const label = labelAt === -1 ? undefined : args[labelAt + 1];
			const tab_id = `t-${world.next++}`;
			const pane_id = `shell-${tab_id}`;
			world.tabs.push({ tab_id, label });
			world.panes.push({ pane_id, tab_id });
			return {
				ok: true,
				data: { tab: { tab_id, root_pane: pane_id } },
			};
		}
		if (noun === "pane" && verb === "swap") {
			const spec = args[args.indexOf("--panes") + 1] ?? "";
			const [a, b] = spec.split(",");
			const pa = world.panes.find((p) => p.pane_id === a);
			const pb = world.panes.find((p) => p.pane_id === b);
			if (pa && pb) {
				const tab = pa.tab_id;
				pa.tab_id = pb.tab_id;
				pb.tab_id = tab;
			}
			world.swaps = world.swaps ?? [];
			world.swaps.push(spec);
			return { ok: true, data: {} };
		}
		return { ok: true, data: {} };
	};
	const innerStart = base.deps.start;
	base.deps.start = async (input) => {
		const r = await innerStart(input);
		if (r.ok) {
			const paneId = r.data.agent.pane_id;
			const from = input.existingPane ?? input.splitFrom;
			const tab =
				world.panes.find((p) => p.pane_id === from)?.tab_id ?? "t-main";
			world.panes.push({ pane_id: paneId, tab_id: tab });

			if (input.existingPane) {
				world.panes = world.panes.filter(
					(p) => p.pane_id !== input.existingPane,
				);
			}
		}
		return r;
	};
	base.commands = commands;
	base.world = world;
	return base;
}

// ---------------------------------------------------------------------------
console.log("\n[9] Engine — background spawn end to end, child env stamped");
{
	reset();
	const h = makeDeps({ env: { HERDR_PANE_ID: "w9:p9" } });
	const r = await spawn.spawnAgent(
		{ prompt: "find the entry point", type: "Explore", name: "scout" },
		h.deps,
	);
	assert(r.ok, `spawn ok (${r.ok ? "" : r.error.message})`);
	assert(r.data.status === "working", "right after submit: working");
	assert(r.data.paneId === "p1", "paneId returned");
	assert(r.data.name === "scout", "explicit name is the handle");
	assert(r.data.type === "Explore", "definition type reported");
	assert(r.data.depth === 2, "child depth = root(1) + 1");
	const start = h.calls.start[0];
	assert(start.env.PI_HERDR_SPAWN_DEPTH === "2", "child env: incremented depth");
	assert(
		start.env.PI_HERDR_ORCHESTRATOR_PANE === "w9:p9",
		"child env: orchestrator pane from HERDR_PANE_ID",
	);
	assert(
		start.agentArgs[0] === "--session" &&
			start.agentArgs[2] === "-e" &&
			start.agentArgs.includes("--system-prompt"),
		"launch plan leads with the parent-owned --session + injected child extension; Explore's prompt follows",
	);
	assert(
		h.calls.submit[0].text === "find the entry point",
		"prompt submitted to the pane",
	);
	// Manual e2e F1: {prompt} alone spawns the default — general-purpose on
	// the ordinary registry path (the most natural minimal call must work).
	reset();
	const hDefault = makeDeps({ env: { HERDR_PANE_ID: "w9:p9" } });
	const rDefault = await spawn.spawnAgent({ prompt: "do the thing" }, hDefault.deps);
	assert(
		rDefault.ok,
		`prompt-only spawn accepted (${rDefault.ok ? "" : rDefault.error.message})`,
	);
	assert(
		rDefault.ok && rDefault.data.type === "general-purpose",
		"{prompt} alone resolves type general-purpose",
	);
	assert(
		rDefault.ok && rDefault.data.kind === "pi",
		"prompt-only default rides the built-in's pi kind",
	);
	// no HERDR_PANE_ID → no orchestrator var
	const h2 = makeDeps();
	await spawn.spawnAgent({ prompt: "x", type: "Plan", name: "quiet" }, h2.deps);
	assert(
		h2.calls.start[0].env.PI_HERDR_ORCHESTRATOR_PANE === undefined,
		"no HERDR_PANE_ID → orchestrator var omitted",
	);
	// kill-switched settings refuse before any start
	const h3 = makeDeps({ settings: { agents_kill_switch: true } });
	const r3 = await spawn.spawnAgent({ prompt: "x", type: "Plan" }, h3.deps);
	assert(
		!r3.ok && r3.error.code === "SPAWN_REFUSED" && h3.calls.start.length === 0,
		"kill-switch refuses with zero pane side effects",
	);
	// deep session refuses
	const h4 = makeDeps({ env: { PI_HERDR_SPAWN_DEPTH: "2" } });
	const r4 = await spawn.spawnAgent({ prompt: "x", type: "Plan" }, h4.deps);
	assert(
		!r4.ok && /spawn depth/.test(r4.error.message) && h4.calls.start.length === 0,
		"depth-2 session refused at max_spawn_depth 2",
	);
	// unknown kind: general-purpose sets no enforced fields, so the kind itself
	// fails against the (injected) live kind list
	const h5 = makeDeps();
	const r5 = await spawn.spawnAgent(
		{ prompt: "x", type: "general-purpose", kind: "bogus" },
		h5.deps,
	);
	assert(
		!r5.ok && /Unknown agent kind/.test(r5.error.message),
		"unknown kind errors against the kind list",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[10] Inline definitions spawn and register session-ephemerally");
{
	reset();
	const h = makeDeps();
	const r = await spawn.spawnAgent(
		{
			prompt: "audit deps",
			agent: {
				name: "dep-auditor",
				kind: "pi",
				system_prompt: "You audit dependencies.",
				tools: ["read", "bash"],
			},
			name: "audit-1",
		},
		h.deps,
	);
	assert(
		r.ok && r.data.type === "dep-auditor",
		"inline spawn ok, type = its name",
	);
	assert(
		h.calls.start[0].agentArgs.includes("You audit dependencies."),
		"inline system_prompt reached the child CLI",
	);
	assert(
		spawn
			.listAgentTypes()
			.some((t) => t.name === "dep-auditor" && t.layer === "session"),
		"inline definition registered session-ephemerally",
	);
	const h2 = makeDeps();
	const r2 = await spawn.spawnAgent(
		{ prompt: "again", type: "dep-auditor", name: "audit-2" },
		h2.deps,
	);
	assert(
		r2.ok && r2.data.type === "dep-auditor",
		"later spawn resolves the inline definition via `type`",
	);
	const h3 = makeDeps();
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", agent: { system_prompt: "" } },
		h3.deps,
	);
	assert(
		r3.ok && /^agent-\d+$/.test(r3.data.name),
		"anonymous inline gets agent-<timestamp>",
	);
	assert(
		!spawn.listAgentTypes().some((t) => t.name === ""),
		"anonymous inline is NOT registered (no name to address)",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[11] Name chain through the engine (param → def → auto, uniquified)",
);
{
	reset();
	const h = makeDeps();
	const a = await spawn.spawnAgent({ prompt: "x", type: "Explore" }, h.deps);
	assert(
		a.data.name === "Explore",
		"no param, no inline name → definition name",
	);
	const b = await spawn.spawnAgent({ prompt: "x", type: "Explore" }, h.deps);
	assert(b.data.name === "Explore-2", "taken definition name falls back -2");
	const c = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "probe" },
		h.deps,
	);
	assert(c.data.name === "probe", "explicit param wins");
	const d = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "probe" },
		h.deps,
	);
	assert(d.data.name === "probe-2", "taken explicit name falls back -2");
}

// ---------------------------------------------------------------------------
console.log("\n[12] Over-cap spawn queues; pane appears when a slot frees");
{
	reset();
	const h = makeDeps({ settings: { max_parallel_agents: 1 } });
	const a = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "first" },
		h.deps,
	);
	assert(a.ok && a.data.paneId === "p1", "cap 1: first spawn starts");
	const b = await spawn.spawnAgent(
		{ prompt: "y", type: "Plan", name: "second" },
		h.deps,
	);
	assert(
		b.ok &&
			b.data.status === "queued" &&
			!b.data.paneId &&
			b.data.queued === true,
		"over-cap spawn accepted as queued with no pane",
	);
	assert(h.calls.start.length === 1, "queued record created no pane");
	// bounded wait on a queued record returns the current (queued) state
	const bWait = await spawn.spawnAgent(
		{ prompt: "z", type: "Plan", name: "third", wait: 0 },
		h.deps,
	);
	assert(
		bWait.ok && bWait.data.status === "queued" && bWait.data.waited === true,
		"wait: ms on a queued spawn returns queued on expiry",
	);
	// a slot frees: first pane leaves the fleet
	h.live.splice(0, h.live.findIndex((x) => x.name === "first") + 1);
	const started = await spawn.drainQueueOnce(h.deps);
	assert(started === 1, "drain starts one queued record");
	const rec = spawn.spawnRecords().get("second");
	assert(!!rec?.paneId, "queued record now has a pane");
	const rec3 = spawn.spawnRecords().get("third");
	assert(!rec3?.paneId, "the third stays queued (cap still held)");
	// hand-spawned fleet panes never hold a session slot (watch-scope decision)
	const h2 = makeDeps({
		settings: { max_parallel_agents: 1 },
		live: [{ name: "human-pane", paneId: "px" }],
	});
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "next-to-human" },
		h2.deps,
	);
	assert(
		r2.ok && r2.data.paneId !== undefined,
		"a hand-spawned pane in the fleet does not queue the session's spawn",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[13] `wait` vocabulary (deterministic — fakes settle instantly)",
);
{
	reset();
	// wait: true → done when the pane settles idle right after submission
	const h2 = makeDeps();
	h2.deps.submit = async (paneId, text) => {
		h2.calls.submit.push({ paneId, text });
		h2.live[0].agent_status = "idle";
		return { ok: true, data: true };
	};
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w2", wait: true },
		h2.deps,
	);
	assert(
		r2.ok && r2.data.status === "done" && r2.data.waited === true,
		"wait: true returns done on settle",
	);
	// blocked is terminal for wait: true
	const h3 = makeDeps();
	h3.deps.status = async () => ({ ok: true, data: "blocked" });
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w3", wait: true },
		h3.deps,
	);
	assert(r3.ok && r3.data.status === "blocked", "wait: true returns on blocked");
	// wait: 0 → immediate expiry returns the CURRENT state (working)
	const h4 = makeDeps();
	const r4 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w4", wait: 0 },
		h4.deps,
	);
	assert(
		r4.ok && r4.data.status === "working" && r4.data.waited === true,
		"wait: ms returns working on expiry",
	);
	// default: no wait, returns immediately
	const h5 = makeDeps();
	const r5 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "w5" },
		h5.deps,
	);
	assert(
		r5.ok && r5.data.waited === undefined && r5.data.status === "working",
		"default returns immediately (background)",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[14] isolated: true — herdr-side worktree");
{
	reset();
	const h = makeDeps();
	const r = await spawn.spawnAgent(
		{ prompt: "x", type: "general-purpose", name: "iso", isolated: true },
		h.deps,
	);
	assert(
		r.ok && r.data.worktreePath === "D:/wt/auto-branch",
		"worktree path returned",
	);
	assert(h.calls.worktree.length === 1, "worktree create called once");
	assert(
		h.calls.start[0].cwd === "D:/wt/auto-branch",
		"child cwd = worktree path",
	);
	const h2 = makeDeps();
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", isolated: true, cwd: "D:/elsewhere" },
		h2.deps,
	);
	assert(
		!r2.ok && /mutually exclusive/i.test(r2.error.message),
		"isolated + cwd errors (no silent surprise)",
	);
}

// ---------------------------------------------------------------------------
console.log(
	"\n[15] Failure honesty — start/boot/submit errors carry the handle",
);
{
	reset();
	const h = makeDeps();
	h.deps.start = async () => ({
		ok: false,
		error: { code: "AGENT_START_FAILED", message: "boom" },
	});
	const r = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "doomed" },
		h.deps,
	);
	assert(
		!r.ok && r.error.details?.name === "doomed",
		"start failure names the handle",
	);
	const h2 = makeDeps();
	h2.deps.boot = async () => ({
		ok: false,
		error: { code: "TIMEOUT", message: "never idle" },
	});
	const r2 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "slowboot" },
		h2.deps,
	);
	assert(
		!r2.ok && r2.error.details?.paneId === "p1",
		"boot failure reports the pane id (pane exists)",
	);
	// lost prompt (NOT_STARTED) is retried once
	const h3 = makeDeps();
	let n = 0;
	h3.deps.submit = async (paneId, text) => {
		h3.calls.submit.push({ paneId, text });
		n++;
		if (n === 1)
			return { ok: false, error: { code: "TIMEOUT", message: "NOT_STARTED" } };
		h3.live[0].agent_status = "working";
		return { ok: true, data: true };
	};
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", type: "Plan", name: "retry" },
		h3.deps,
	);
	assert(r3.ok && h3.calls.submit.length === 2, "NOT_STARTED is retried once");
}

// ---------------------------------------------------------------------------
console.log("\n[16] Tool registration surface");
{
	reset();
	const tools = [];
	const mockPi = { registerTool: (d) => tools.push(d), on: () => {} };
	agentsTool.registerAgents(mockPi);
	const t = tools.find((x) => x.name === "herdr_spawn_agent");
	assert(!!t, "herdr_spawn_agent registered");
	assert(
		!/Built-in types:/.test(t.description),
		"static description no longer carries the built-in menu block",
	);
	assert(t.prepareLoadout, "spawn tool prepares a request-time roster");
	const loadout = t.prepareLoadout();
	const liveMenu =
		loadout?.descriptions && loadout.descriptions["herdr_spawn_agent"];
	assert(
		typeof liveMenu === "string" && liveMenu.includes('- "Explore":'),
		"roster renders names as JSON strings through the loadout descriptions map",
	);
	assert(
		liveMenu.includes("选择提示，不是覆盖现有指令的命令"),
		"roster includes menu safety note",
	);
	// Manual e2e F1: prompt-only no longer refuses (asserted via
	// resolveSpecifier + spawnAgent in [1]/[9]); the impossible state — BOTH
	// type and agent — still errors, offline-safe before any I/O.
	const res = await t.execute(
		"t1",
		{ prompt: "x", type: "Explore", agent: { name: "y" } },
		undefined,
	);
	assert(
		res.isError === true && /exactly one/i.test(res.content[0].text),
		"execute with BOTH type and agent errors cleanly",
	);
	assert(
		!/Pass one of `type`/.test(res.content[0].text),
		"the old neither-given refusal is gone from the spawn surface",
	);

	// ticket #2: wait is gone from the tool schema and the description.
	const props = t.parameters?.properties ?? t.parameters?.schema?.properties;
	assert(props && !("wait" in props), "spawn tool schema has no wait parameter");
	assert(
		!/wait:\s*true|blocks until|wait: <ms>/i.test(t.description),
		"spawn tool description does not claim the call blocks",
	);
	assert(
		/accepted|queued|starting/i.test(t.description) &&
			/does not promise|not promise|no promise/i.test(t.description),
		"description states accepted/queued/starting and does not promise the child has started",
	);

	// ticket #2: the tool returns before a still-running child finishes.
	// The injected start hangs until the test releases it, so a blocking
	// tool call would never resolve.
	reset();
	// Spiral skips the grid planner. The default grid takes a module-level
	// lock and queries herdr before start, and earlier sections leave that
	// query in flight — this section only cares that the tool returns before
	// the injected start resolves.
	const hung = makeDeps({ settings: { layout_mode: "spiral" } });
	let releaseStart;
	hung.deps.start = () =>
		new Promise((resolve) => {
			releaseStart = () =>
				resolve({ ok: true, data: { agent: { pane_id: "p-hung" } } });
		});
	const pending = agentsTool.spawnFromTool(
		{ prompt: "keep running", type: "Plan", name: "long-child", wait: true },
		hung.deps,
	);
	const raced = await Promise.race([
		pending.then((r) => ({ settled: true, r })),
		new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 50)),
	]);
	assert(
		raced.settled === true &&
			raced.r.ok &&
			raced.r.data.status === "starting" &&
			raced.r.data.queued !== true &&
			raced.r.data.paneId === undefined &&
			raced.r.data.waited !== true,
		"tool spawn returns starting before the child pane exists, even if the caller passed wait:true",
	);
	assert(
		hung.calls.start.length === 0 &&
			spawn.spawnRecords().get("long-child")?.paneId === undefined,
		"returning starting does not mean the child has booted",
	);
	releaseStart();
	await pending;

	reset();
	const capped = makeDeps({ settings: { max_parallel_agents: 1 } });
	const first = await agentsTool.spawnFromTool(
		{ prompt: "x", type: "Plan", name: "holds-slot" },
		capped.deps,
	);
	assert(first.ok && first.data.status === "starting", "under cap: accepted as starting");
	// occupy the slot the way the drain counts it: a live registry pane
	const held = spawn.spawnRecords().get("holds-slot");
	held.paneId = "p-held";
	capped.live.push({ name: "holds-slot", paneId: "p-held", agent_status: "working" });
	const second = await agentsTool.spawnFromTool(
		{ prompt: "y", type: "Plan", name: "overflow", wait: true },
		capped.deps,
	);
	assert(
		second.ok &&
			second.data.status === "queued" &&
			second.data.queued === true &&
			second.data.waited !== true,
		"over cap: queued immediately, wait:true does not block through the queue",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[17] Golden-spiral pane layout (nextSplit + start-time wiring)");
{
	reset();
	// pure decision: #1 → spawner's pane right; #2 → child #1 down; #3 → child
	// #2 right; no live sibling → the spawner's pane again; ratio favors the
	// EXISTING pane (verified: herdr --ratio is the source pane's share).
	const s1 = spawn.nextSplit({ spawnerPane: "w1:p1", liveChildCount: 0 });
	assert(
		s1.targetPaneId === "w1:p1" &&
			s1.direction === "right" &&
			s1.ratio === 0.6,
		"spawn #1: spawner's pane, right, ratio 0.6",
	);
	const s2 = spawn.nextSplit({
		spawnerPane: "w1:p1",
		lastChildPane: "w1:p1A",
		liveChildCount: 1,
	});
	assert(
		s2.targetPaneId === "w1:p1A" && s2.direction === "down",
		"spawn #2: previous child's pane, down",
	);
	const s3 = spawn.nextSplit({
		spawnerPane: "w1:p1",
		lastChildPane: "w1:p1B",
		liveChildCount: 2,
	});
	assert(
		s3.targetPaneId === "w1:p1B" && s3.direction === "right",
		"spawn #3: previous child's pane, right (alternates)",
	);
	assert(
		spawn.nextSplit({ spawnerPane: "w1:p1", liveChildCount: 0 })
			.targetPaneId === "w1:p1",
		"no live sibling → the spawner's pane (fallback)",
	);
	assert(
		spawn.nextSplit({ liveChildCount: 0 }).targetPaneId === undefined,
		"spawner not in a pane → undefined target (--current)",
	);

	// wiring: three engine spawns — target/direction thread into the split
	// call, resolved at START time against live siblings (registry order).
	// The default layout is now grid; this section pins spiral so the
	// golden-spiral contract stays the thing under test.
	const h = makeDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { layout_mode: "spiral" },
	});
	for (const name of ["ga", "gb", "gc"]) {
		const r = await spawn.spawnAgent(
			{ prompt: "x", type: "Explore", name },
			h.deps,
		);
		assert(r.ok, `spawn ${name} ok (${r.ok ? "" : r.error?.message})`);
	}
	const [sA, sB, sC] = h.calls.start;
	assert(
		sA.splitFrom === "w9:p1" && sA.split === "right" && sA.ratio === 0.6,
		"#1 splits the spawner's pane right at 0.6",
	);
	assert(
		sB.splitFrom === "p1" && sB.split === "down",
		"#2 splits child #1's pane (p1) down",
	);
	assert(
		sC.splitFrom === "p2" && sC.split === "right",
		"#3 splits child #2's pane (p2) right",
	);

	// fallback: every child exited (fleet list empty) → the spawner's pane.
	h.live.length = 0;
	const rd = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "gd" },
		h.deps,
	);
	assert(rd.ok, `fallback spawn ok (${rd.ok ? "" : rd.error?.message})`);
	const sD = h.calls.start[3];
	assert(
		sD.splitFrom === "w9:p1" && sD.split === "down",
		"all children exited → the spawner's pane again (direction by ordinal parity)",
	);

	// regression (parallel batch): siblings still BOOTING are invisible to the
	// agent list but their panes exist — split targeting reads the pane list,
	// not the agent list, or every parallel spawn falls back to the spawner.
	h.live.length = 0; // fleet detects no agents yet (all booting)
	h.panes.current = ["w9:p1", "p1", "p2", "p3", "p4"]; // ...but every pane exists
	const re = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "ge" },
		h.deps,
	);
	assert(re.ok, `booting-sibling spawn ok (${re.ok ? "" : re.error?.message})`);
	const sE = h.calls.start[4];
	assert(
		sE.splitFrom === "p4" && sE.split === "right",
		"booting sibling's pane (p4) is the split target — pane list, not agent list",
	);

	// a CLOSED sibling pane is gone from the pane list → spawner fallback
	h.panes.current = ["w9:p1"];
	const rf = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "gf" },
		h.deps,
	);
	assert(rf.ok, `gf fallback spawn ok (${rf.ok ? "" : rf.error?.message})`);
	const sF = h.calls.start[5];
	assert(
		sF.splitFrom === "w9:p1" && sF.split === "down",
		"closed sibling panes are skipped → the spawner's pane, direction by ordinal parity",
	);

	// parallel batch: the predecessor may be MID-START (no paneId yet) — the
	// spiral waits for its pane instead of falling back to the spawner.
	const hp = makeDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		startDelayMs: 400,
		settings: { layout_mode: "spiral" },
	});
	const pending = spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "ha" },
		hp.deps,
	);
	await new Promise((r) => setTimeout(r, 120)); // ha mid-start, no paneId yet
	const rhb = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "hb" },
		hp.deps,
	);
	const sHb = hp.calls.start[1];
	assert(
		sHb.splitFrom === "p1" && sHb.split === "down",
		`parallel: mid-start predecessor is awaited and targeted (down) (${JSON.stringify(sHb)})`,
	);
	assert(rhb.ok, `hb spawn ok (${rhb.ok ? "" : rhb.error?.message})`);
	await pending;
}

// ---------------------------------------------------------------------------
console.log("\n[18] layout_mode is read at START: grid by default, spiral when set");
{
	reset();
	// Missing setting → grid. The first agent splits the orchestrator's pane
	// to the right at half (equal columns), not the spiral's 0.6.
	const hg = makeGridDeps({ env: { HERDR_PANE_ID: "w9:p1" } });
	const g1 = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "ga" },
		hg.deps,
	);
	assert(g1.ok, `grid spawn ok (${g1.ok ? "" : g1.error?.message})`);
	const gs = hg.calls.start[0];
	assert(
		gs.split === "right" && gs.splitFrom === "w9:p1" && gs.ratio === 0.5,
		`default layout is grid: first agent is the right half of the main pane (${JSON.stringify({ split: gs.split, from: gs.splitFrom, ratio: gs.ratio })})`,
	);

	// Explicit spiral keeps the golden-spiral contract (ratio 0.6, alternating).
	reset();
	const hs = makeDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { layout_mode: "spiral" },
	});
	for (const name of ["sa", "sb"]) {
		const r = await spawn.spawnAgent(
			{ prompt: "x", type: "Explore", name },
			hs.deps,
		);
		assert(r.ok, `spiral ${name} ok`);
	}
	assert(
		hs.calls.start[0].ratio === 0.6 && hs.calls.start[0].split === "right",
		"explicit spiral: spawn #1 still splits right at 0.6",
	);
	assert(
		hs.calls.start[1].split === "down" && hs.calls.start[1].splitFrom === "p1",
		"explicit spiral: spawn #2 still splits the previous child down",
	);
}

console.log("\n[18b] grid tab creation carries the spawn cwd");
{
	reset();
	const h = makeGridDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { max_parallel_agents: 20 },
	});
	const r = await spawn.spawnAgent(
		{
			prompt: "x",
			type: "Explore",
			name: "cw",
			group: "roster",
			cwd: "/tmp/spawn-cwd-target",
		},
		h.deps,
	);
	assert(r.ok, `group spawn with cwd ok (${r.ok ? "" : r.error?.message})`);
	const create = h.commands.find(
		(c) => c[0] === "tab" && c[1] === "create",
	);
	assert(
		create &&
			create.includes("--cwd") &&
			create[create.indexOf("--cwd") + 1] === "/tmp/spawn-cwd-target",
		`the group's new tab is created with the spawn cwd (${JSON.stringify(create)})`,
	);
}

console.log(
	"\n[19] grid group: same group shares a tab; the 7th live occupant opens another",
);
{
	reset();
	const h = makeGridDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { max_parallel_agents: 20 },
	});
	const placed = [];
	for (let i = 1; i <= 7; i++) {
		const r = await spawn.spawnAgent(
			{ prompt: "x", type: "Explore", name: `g${i}`, group: "coding" },
			h.deps,
		);
		assert(r.ok, `group spawn g${i} ok (${r.ok ? "" : r.error?.message})`);
		if (!r.ok || !h.calls.start[i - 1]) break;
		const rec = spawn.spawnRecords().get(`g${i}`);
		placed.push({
			tab: rec?.gridTab,
			at: rec?.gridAt,
			reuse: h.calls.start[i - 1].existingPane,
			split: h.calls.start[i - 1].split,
		});
	}
	const firstTab = placed[0].tab;
	assert(
		firstTab && firstTab !== "t-main" && placed.slice(0, 6).every((p) => p.tab === firstTab),
		`the first six of a group share one tab that is not the main tab (${JSON.stringify(placed.map((p) => p.tab))})`,
	);
	assert(
		placed[6].tab && placed[6].tab !== firstTab,
		`the 7th live occupant of the group opens another tab (${placed[6].tab})`,
	);
	assert(
		placed[0].reuse && !placed[0].split,
		"a brand-new group tab reuses the tab's shell pane instead of splitting",
	);
	const created = h.commands.find((c) => c[0] === "tab" && c[1] === "create");
	assert(
		created?.includes("--env") &&
			created.some((a) => a.startsWith("PI_HERDR_SESSION=")),
		"the new group tab is created with the child's env, since agent start cannot stamp it",
	);

	// An 8th member of the same group fills the earliest page that still has
	// room — the new page — rather than opening a third or joining the main tab.
	const r8 = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "g8", group: "coding" },
		h.deps,
	);
	assert(r8.ok, "8th group member ok");
	const rec8 = spawn.spawnRecords().get("g8");
	assert(
		rec8?.gridTab === placed[6].tab,
		`the 8th joins the group's second tab (${rec8?.gridTab} vs ${placed[6].tab})`,
	);

	// A spawn with no group stays on the orchestrator's tab.
	const plain = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "loose" },
		h.deps,
	);
	assert(plain.ok, "ungrouped spawn ok");
	assert(
		spawn.spawnRecords().get("loose")?.gridTab === "t-main",
		"no group → the orchestrator's tab",
	);

	// Switching the setting does not move panes already placed. The next
	// START is the only one that changes shape.
	const live = h.deps.load();
	live.layout_mode = "spiral";
	const before = spawn.spawnRecords().get("g1")?.gridAt;
	const switched = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "spiraled" },
		h.deps,
	);
	assert(switched.ok, "post-switch spawn ok");
	const sw = h.calls.start.at(-1);
	assert(
		sw.ratio === 0.6 && sw.split && !sw.existingPane,
		`the spawn after the switch uses spiral (${JSON.stringify({ ratio: sw.ratio, split: sw.split })})`,
	);
	assert(
		JSON.stringify(spawn.spawnRecords().get("g1")?.gridAt) ===
			JSON.stringify(before),
		"panes placed before the switch stay where they were",
	);
}

console.log(
	"\n[19b] the 7th live occupant of the main tab opens a tab, and does not become a 7th pane",
);
{
	reset();
	const h = makeGridDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { max_parallel_agents: 20 },
	});
	for (let i = 1; i <= 5; i++) {
		const r = await spawn.spawnAgent(
			{ prompt: "x", type: "Explore", name: `m${i}` },
			h.deps,
		);
		assert(r.ok, `main-tab spawn m${i} ok`);
	}
	const before = h.world.panes.filter((p) => p.tab_id === "t-main").length;
	const r7 = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "m7" },
		h.deps,
	);
	assert(r7.ok, "7th main-tab occupant ok");
	const rec7 = spawn.spawnRecords().get("m7");
	const overflow = h.commands.filter(
		(c) => c[0] === "tab" && c[1] === "create" && !c.includes("--label"),
	);
	assert(
		overflow.length === 1,
		`exactly one unlabeled tab is created for the 7th occupant (commands ${JSON.stringify(h.commands.filter((c) => c[0] === "tab"))})`,
	);
	assert(
		rec7?.gridTab && rec7.gridTab !== "t-main",
		`the 7th occupant is recorded on the new tab (${rec7?.gridTab})`,
	);
	assert(
		h.world.panes.filter((p) => p.tab_id === "t-main").length === before,
		`the main tab still holds ${before} panes, not 7`,
	);
	assert(
		h.calls.start[5].existingPane && !h.calls.start[5].split,
		"the 7th attaches to the new tab's shell instead of splitting the main tab",
	);
}

console.log(
	"\n[19c] a hole above a live pane is reused by swapping, not by growing downward",
);
{
	reset();
	const h = makeGridDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { max_parallel_agents: 20 },
	});
	for (const name of ["h1", "h2"]) {
		const r = await spawn.spawnAgent(
			{ prompt: "x", type: "Explore", name },
			h.deps,
		);
		assert(r.ok, `${name} placed`);
	}
	const gone = spawn.spawnRecords().get("h1");
	h.world.panes = h.world.panes.filter((p) => p.pane_id !== gone.paneId);
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "h3" },
		h.deps,
	);
	assert(r3.ok, "h3 placed");
	const rec3 = spawn.spawnRecords().get("h3");
	assert(
		rec3.gridAt.row === gone.gridAt.row &&
			rec3.gridAt.col === gone.gridAt.col,
		`h3 is recorded on the closed cell r${gone.gridAt.row}c${gone.gridAt.col}`,
	);
	const issued = h.commands.filter(
		(c) => c[0] === "pane" && c[1] === "swap",
	);
	const expected = `pane swap --panes ${spawn.spawnRecords().get("h2").paneId},${rec3.paneId}`;
	assert(
		issued.length === 1 && issued[0].join(" ") === expected,
		`the newcomer swaps with the pane that was under the hole (${expected}; got ${JSON.stringify(issued)})`,
	);
}

console.log(
	"\n[20] concurrent grid starts do not take the same hole",
);
{
	reset();
	const h = makeGridDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { max_parallel_agents: 20 },
		startDelayMs: 300,
	});
	const pending = ["c1", "c2", "c3"].map((name) =>
		spawn.spawnAgent({ prompt: "x", type: "Explore", name }, h.deps),
	);
	const results = await Promise.all(pending);
	assert(results.every((r) => r.ok), "three concurrent grid spawns all start");
	const cells = ["c1", "c2", "c3"].map((name) => {
		const at = spawn.spawnRecords().get(name)?.gridAt;
		return at ? `${at.row}:${at.col}` : "none";
	});
	assert(
		new Set(cells).size === 3,
		`each concurrent start lands on its own cell (${cells.join(", ")})`,
	);
	assert(h.calls.start[1].splitFrom === spawn.spawnRecords().get("c1").paneId, "concurrent second START splits the completed predecessor pane");
}

console.log("\n[21] a closed pane's cell is reused inside its own tab");
{
	reset();
	const h = makeGridDeps({
		env: { HERDR_PANE_ID: "w9:p1" },
		settings: { max_parallel_agents: 20 },
	});
	for (const name of ["k1", "k2"]) {
		const r = await spawn.spawnAgent(
			{ prompt: "x", type: "Explore", name, group: "coding" },
			h.deps,
		);
		assert(r.ok, `${name} placed`);
	}
	const gone = spawn.spawnRecords().get("k2");
	const hole = `${gone.gridAt.row}:${gone.gridAt.col}`;
	h.world.panes = h.world.panes.filter((p) => p.pane_id !== gone.paneId);
	const r3 = await spawn.spawnAgent(
		{ prompt: "x", type: "Explore", name: "k3", group: "coding" },
		h.deps,
	);
	assert(r3.ok, "k3 placed");
	const at = spawn.spawnRecords().get("k3").gridAt;
	assert(
		`${at.row}:${at.col}` === hole &&
			spawn.spawnRecords().get("k3").gridTab === gone.gridTab,
		`the newcomer takes the closed cell on the same tab (${hole})`,
	);
}

console.log("\n[22] grid lock timeout / abort preserve serialization");
{
 reset();
 const h = makeGridDeps({ settings: { max_parallel_agents: 20 } });
 const start = h.deps.start;
 let release;
 let entered;
 const ready = new Promise(r => { entered = r; });
 const held = new Promise(r => { release = r; });
 h.deps.start = async input => { if (input.name === "lock-owner") { entered(); await held; } return start(input); };
 const owner = spawn.spawnAgent({ prompt: "x", type: "Explore", name: "lock-owner" }, h.deps);
 await ready;
 const timed = await spawn.spawnAgent({ prompt: "x", type: "Explore", name: "lock-timeout" }, { ...h.deps, gridTimeoutMs: 10 });
 assert(!timed.ok && timed.error.code === "TIMEOUT", "queued grid START expires with TIMEOUT");
 const controller = new AbortController();
 const aborted = spawn.spawnAgent({ prompt: "x", type: "Explore", name: "lock-abort" }, { ...h.deps, signal: controller.signal });
 controller.abort();
 const cancelled = await aborted;
 assert(!cancelled.ok && cancelled.error.code === "TIMEOUT", "aborted grid waiter resolves TIMEOUT");
 const follower = spawn.spawnAgent({ prompt: "x", type: "Explore", name: "lock-follower" }, h.deps);
 await new Promise(r => setTimeout(r, 20));
 assert(h.calls.start.length === 0, "expired waiters cannot release the live owner's lock");
 release();
 await Promise.all([owner, follower]);
 assert(h.calls.start.length === 2 && h.calls.start[1].splitFrom === spawn.spawnRecords().get("lock-owner").paneId, "next waiter observes owner pane after release");
 const tab = makeGridDeps({ settings: { idle_rearm_minutes: 7 } });
 await spawn.spawnAgent({ prompt: "x", type: "Explore", name: "env-check", group: "env" }, tab.deps);
 const command = tab.commands.find(c => c[0] === "tab" && c[1] === "create");
 assert(Object.entries(tab.calls.start[0].env).every(([k,v]) => command.includes(k + "=" + v)), "tab and agent launch carry identical child env including idle re-arm");
}

// ---------------------------------------------------------------------------
console.log("\n[23] roster menu — prepareLoadout renders the effective registry");
{
	reset();
	const project = mkdtempSync(join(tmpdir(), "pi-herdr-roster-p-"));
	const global = mkdtempSync(join(tmpdir(), "pi-herdr-roster-g-"));
	mkdirSync(project, { recursive: true });
	mkdirSync(global, { recursive: true });
	const w = (dir, file, content) => writeFileSync(join(dir, file), content, "utf8");
	const md = (front) => `---\n${front}\n---\n\nbody prompt\n`;
	// same name in both file layers — project must win
	w(project, "dup.md", md('name: Dup\ndescription: project wins'));
	w(global, "dup.md", md('name: Dup\ndescription: global loses'));
	w(global, "zebra.md", md('name: Zebra\ndescription: stripes'));
	// legal name with leading/trailing whitespace, quotes, newline
	w(project, 'weird.md', md('name: "  \\"q\\" \\n"\ndescription: odd name'));
	// no description
	w(project, "nodesc.md", md('name: NoDesc'));
	// malformed — must be skipped silently
	w(project, "broken.md", "no frontmatter here\n");
	// built-in override
	w(project, "explore.md", md('name: Explore\ndescription: project Explore'));
	// session inline registration
	spawn.registerSessionAgent({ name: "Inline", description: "session layer" });

	const tools2 = [];
	const mockPi2 = { registerTool: (d) => tools2.push(d), on: () => {} };
	agentsTool.registerAgents(mockPi2, { dirs: { project, global } });
	const t2 = tools2.find((x) => x.name === "herdr_spawn_agent");
	assert(t2.promptGuidelines.every((line) => line.includes("herdr_spawn_agent")),
		"every spawn prompt guideline names herdr_spawn_agent");
	const menuOf = () =>
		t2.prepareLoadout().descriptions["herdr_spawn_agent"];
	const menu = menuOf();

	assert(menu.includes('- "Inline": session layer'), "session inline defs are on the menu");
	assert(menu.includes('- "Dup": project wins'), "project file wins over global");
	assert(!menu.includes("global loses"), "shadowed global definition does not appear");
	assert(menu.includes('- "Zebra": stripes'), "global-only defs are on the menu");
	assert(
		menu.includes('- "Explore": project Explore') &&
			!menu.includes("Fast read-only search agent"),
		"overridden built-in shows only the winning definition",
	);
	assert(
		!menu.includes("Fast read-only search agent"),
		"overridden built-in's original description is fully gone from this menu",
	);
	const menu2 = (() => {
		const p2 = mkdtempSync(join(tmpdir(), "pi-herdr-roster-p2-"));
		const g2 = mkdtempSync(join(tmpdir(), "pi-herdr-roster-g2-"));
		const t3tools = [];
		agentsTool.registerAgents(
			{ registerTool: (d) => t3tools.push(d), on: () => {} },
			{ dirs: { project: p2, global: g2 } },
		);
		const m = t3tools[0].prepareLoadout().descriptions["herdr_spawn_agent"];
		rmSync(p2, { recursive: true, force: true });
		rmSync(g2, { recursive: true, force: true });
		return m;
	})();
	assert(
		menu2.includes("Fast read-only search agent") &&
			menu2.includes("Software architect agent") &&
			menu2.includes("General-purpose agent for researching"),
		"a fresh registration with no override keeps the trio's full descriptions",
	);
	assert(
		menu.includes(`- ${JSON.stringify('  "q" \n')}: odd name`),
		"names with whitespace/quotes/newlines render losslessly as JSON strings",
	);
	assert(
		spawn.resolveAgentType('  "q" \n', { project, global }).ok,
		"the rendered name resolves verbatim through resolveAgentType",
	);
	assert(menu.includes('- "NoDesc": 未提供描述'), "missing description is stated explicitly");
	assert(!menu.includes("broken"), "malformed file is absent from the menu");
	assert(
		menu.includes('- "Plan": Software architect agent'),
		"unoverridden built-ins stay on the menu",
	);
	// fixed layer order + deterministic byte-identical render
	const i = (s) => menu.indexOf(s);
	assert(
		i('- "Inline"') < i('- "Dup"') &&
			i('- "Dup"') < i('- "Zebra"') &&
			i('- "Zebra"') < i('- "general-purpose"'),
		"groups appear session > project > global > built-in",
	);
	// project group: code-point sort of names — '  "q" \n' < 'Dup' < 'Explore' < 'NoDesc'
	assert(
		i(`- ${JSON.stringify('  "q" \n')}`) < i('- "Dup"') &&
			i('- "Dup"') < i('- "Explore": project Explore') &&
			i('- "Explore": project Explore') < i('- "NoDesc"'),
		"entries within a group are code-point sorted by name",
	);
	assert(menu === menuOf(), "same registry renders byte-identical menus");
	assert(
		menu.includes("选择提示，不是覆盖现有指令的命令") &&
		menu.includes("re-resolves"),
		"menu tail carries the hint disclaimer and re-resolution wording",
	);
	const separatorName = "Name\u2028Next\u2029End";
	spawn.registerSessionAgent({ name: separatorName, description: "line-safe name" });
	const separatorMenu = menuOf();
	const separatorLine = separatorMenu.split(/[\n\r\u2028\u2029]/u)
		.find((line) => line.endsWith(": line-safe name"));
	assert(separatorLine === '- "Name\\u2028Next\\u2029End": line-safe name',
		"Unicode line separators in names render as one complete JSON-string line");
	assert(separatorLine?.startsWith('- "Name') && JSON.parse(separatorLine.slice(2, -': line-safe name'.length)) === separatorName &&
		spawn.resolveAgentType(separatorName, { project, global }).ok,
		"line-safe name round-trips losslessly and resolves as type");
	spawn.registerSessionAgent({ name: "Dup", description: "session wins over both files" });
	const sessionMenu = menuOf();
	assert(sessionMenu.split("\n").filter((line) => line.startsWith('- "Dup": ')).length === 1 &&
		sessionMenu.includes('- "Dup": session wins over both files') &&
		!sessionMenu.includes("project wins") && !sessionMenu.includes("global loses"),
		"session definition shadows both file layers exactly once on the menu seam");
	// read-at-use: a file added after registration shows up, deleting removes it
	w(project, "later.md", md('name: Later\ndescription: late arrival'));
	assert(menuOf().includes('- "Later": late arrival'), "a saved .md enters the menu without refresh");
	rmSync(join(project, "later.md"));
	assert(!menuOf().includes('- "Later"'), "a deleted .md leaves the menu without refresh");
	// rename = old name gone, new name present
	w(project, "renamed.md", md('name: Renamed\ndescription: moved'));
	const menuR = menuOf();
	assert(menuR.includes('- "Renamed": moved'), "renamed file appears under the new name");
	rmSync(join(project, "renamed.md"));
	assert(!menuOf().includes('- "Renamed"'), "removing the file removes the entry");
	spawn.clearSessionAgents();
	rmSync(project, { recursive: true, force: true });
	rmSync(global, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log(
	"\n[24] roster description budget — flatten/escape/512-byte cap (issue 18)",
);
{
	reset();
	const project = mkdtempSync(join(tmpdir(), "pi-herdr-roster18-p-"));
	const global = mkdtempSync(join(tmpdir(), "pi-herdr-roster18-g-"));
	mkdirSync(project, { recursive: true });
	mkdirSync(global, { recursive: true });
	const w = (dir, file, content) => writeFileSync(join(dir, file), content, "utf8");
	const md = (name, desc) =>
		desc === undefined
			? `---\nname: ${JSON.stringify(name)}\n---\n\nbody\n`
			: `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(desc)}\n---\n\nbody\n`;

	// multi-line + tab description — flattened to a single line
	w(project, "multi.md", md("Multi", "line one\nline two\ttail"));
	w(project, "unicode.md", md("Unicode", "  one\u00a0\u2003two\u2028three\u2029four  "));
	// control character — escaped, visible as escape text
	w(project, "bell.md", md("Bell", "alert \u0007 end"));
	w(project, "controls.md", md("Controls", "a\u0000\u001b\u007f\u0085\u009fb"));
	// over-budget description (long ascii, will exceed 512 bytes)
	w(project, "long.md", md("Long", "A".repeat(600)));
	// description exactly at the budget after flattening — must NOT be cut
	const exactly512 = "B".repeat(512);
	w(project, "exact.md", md("Exact", exactly512));
	// multibyte boundary: 200 × 3-byte CJK = 600 bytes; 512-3=509 bytes fit →
	// 169 full chars (507 bytes) + 3-byte marker = 510; one more char would be 513
	const cjk = "漢".repeat(200);
	w(project, "cjk.md", md("Cjk", cjk));
	w(project, "emoji.md", md("Emoji", "😀".repeat(129)));
	w(project, "escape-exact.md", md("EscapeExact", "\u0007".repeat(85) + "ab"));
	w(project, "escape-long.md", md("EscapeLong", "\u0007".repeat(100)));
	// missing description — placeholder unaffected by any of this
	w(project, "nodesc.md", md("NoDesc18"));
	// long legal name — never truncated, resolves verbatim
	const longName = '  "' + "名".repeat(300) + '\n  ';
	w(project, "longname.md", md(longName, "fine"));

	const tools18 = [];
	agentsTool.registerAgents(
		{ registerTool: (d) => tools18.push(d), on: () => {} },
		{ dirs: { project, global } },
	);
	const t18 = tools18.find((x) => x.name === "herdr_spawn_agent");
	const menu18 = () => t18.prepareLoadout().descriptions["herdr_spawn_agent"];
	const menu = menu18();
	const entryLine = (m, name) =>
		m.split("\n").find((l) => l.startsWith(`- ${JSON.stringify(name)}: `));

	assert(
		entryLine(menu, "Multi")?.includes("line one line two tail"),
		"multi-line/tab description flattened to a single line",
	);
	assert(
		entryLine(menu, "Multi") === '- "Multi": line one line two tail',
		"flattened entry is one complete physical line in the menu",
	);
	assert(
		entryLine(menu, "Bell")?.includes("\\u0007"),
		"control character rendered as an escape, not a raw byte",
	);
	assert(
		entryLine(menu, "Unicode") === '- "Unicode": one two three four',
		"Unicode whitespace and line separators flatten to ordinary spaces",
	);
	assert(
		entryLine(menu, "Controls") === '- "Controls": a\\u0000\\u001b\\u007f\\u0085\\u009fb',
		"non-whitespace C0, DEL and C1 controls render visibly as escapes",
	);
	const longLine = entryLine(menu, "Long");
	assert(longLine.endsWith("…"), "over-budget description carries the ellipsis marker");
	assert(
		!longLine.includes("A".repeat(600)),
		"over-budget description is actually cut",
	);
	const byteLen = (s) => Buffer.byteLength(s, "utf8");
	assert(
		byteLen(longLine.split(": ").slice(1).join(": ")) <= 512,
		"rendered description (escaping + marker included) fits 512 UTF-8 bytes",
	);
	assert(
		entryLine(menu, "Exact")?.split(": ").slice(1).join(": ") === exactly512,
		"description at exactly the budget is not truncated",
	);
	assert(
		entryLine(menu, "Emoji") === `- "Emoji": ${"😀".repeat(127)}…`,
		"astral code points are not split at the UTF-8 budget boundary",
	);
	assert(
		entryLine(menu, "EscapeExact") === `- "EscapeExact": ${"\\u0007".repeat(85)}ab`,
		"512 bytes after control escaping remain complete without a marker",
	);
	// Each generated escape is one representation unit, even near the cutoff.
	for (const prefix of [508, 507, 506, 503]) {
		spawn.registerSessionAgent({ name: "EscapeBoundary", description: "A".repeat(prefix) + "\u0007" + "B".repeat(10) });
		const expected = prefix === 503 ? "A".repeat(503) + "\\u0007…" : "A".repeat(prefix) + "…";
		assert(entryLine(menu18(), "EscapeBoundary") === `- "EscapeBoundary": ${expected}`,
			`control escape stays whole at ${prefix}-byte prefix`);
	}
	spawn.clearSessionAgents();
	const escapeDesc = entryLine(menu, "EscapeLong").slice('- "EscapeLong": '.length);
	assert(byteLen(escapeDesc) <= 512 && escapeDesc.endsWith("…"),
		"escape expansion and omission marker both count toward the budget");
	const cjkDesc = entryLine(menu, "Cjk")?.split(": ").slice(1).join(": ");
	assert(
		cjkDesc?.endsWith("…") && byteLen(cjkDesc) <= 512 && !cjkDesc.includes("\ufffd"),
		"multibyte description truncated on a code-point boundary with marker, ≤512 bytes, no replacement chars",
	);
	assert(
		entryLine(menu, "NoDesc18")?.endsWith(": 未提供描述"),
		"missing-description placeholder still intact",
	);
	assert(
		menu.includes(`- ${JSON.stringify(longName)}: fine`),
		"name over 512 UTF-8 bytes with quotes/newline renders losslessly",
	);
	assert(
		spawn.resolveAgentType(longName, { project, global }).ok,
		"long name still resolves verbatim through resolveAgentType",
	);
	// built-in exemption: only true built-in winners keep full descriptions
	assert(
		entryLine(menu, "Explore") === `- "Explore": ${TINTINWEB.Explore.description}`,
		"true built-in Explore winner keeps its entire over-512-byte description",
	);
	const menu18a = menu18();
	assert(menu === menu18a, "same registry renders byte-identical menus (budget path)");
	// visible change reflects on the next request
	w(project, "long.md", md("Long", "short now"));
	assert(
		entryLine(menu18(), "Long")?.endsWith(": short now"),
		"changed description reflects on the next request",
	);
	// a project override of a built-in does NOT enjoy the exemption
	w(project, "explore.md", md("Explore", "X".repeat(600)));
	const expLine = entryLine(menu18(), "Explore");
	assert(
		expLine?.endsWith("…") &&
			!expLine.includes("Fast read-only search agent"),
		"overridden built-in gets the budget + marker, not the original description",
	);

	// A modest fixture can exceed any per-description budget without losing entries.
	for (let i = 0; i < 40; i++) {
		w(global, `bulk-${i}.md`, md(`Bulk${i}`, "Z".repeat(600)));
	}
	spawn.registerSessionAgent({ name: "Inline18", description: "I".repeat(600) });
	const fullMenu = menu18();
	assert(Array.from({ length: 40 }, (_, i) => `Bulk${i}`).every(name =>
		entryLine(fullMenu, name)?.endsWith("…")), "all file entries survive with no total menu budget or count cap");
	assert(entryLine(fullMenu, "Inline18") === `- "Inline18": ${"I".repeat(509)}…`,
		"session winners use the same description budget as file winners");
	assert(fullMenu.includes("small trusted registries") && fullMenu.includes("large directories is not promised"),
		"model-visible menu states the small trusted registry scale contract");

	reset();
	rmSync(project, { recursive: true, force: true });
	rmSync(global, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed}/${passed + failed})`,
);
process.exit(failed === 0 ? 0 : 1);
