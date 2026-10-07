// The lifecycle actions (v0.6 issue 10): `herdr_interrupt_agent` and
// `herdr_resume_agent` — decided by wayfinder/tickets/06-interrupt-resume.md.
//
//   - interrupt: turn-level cancel. Escape to the child pane via the
//     existing key-send machinery (`pane send-keys <id> esc`), then stamp
//     record.interruptedAt so the projection (src/status.ts) flips to
//     `interrupted` IMMEDIATELY — ahead of herdr's own view — while stale
//     pre-interrupt activity snapshots are discarded. The pane stays open,
//     the session file and watcher intact; new work (herdr_message_agent)
//     clears the flag and returns the agent to `active` — stop-and-
//     redirect in one live flow. Pi-only promise: the Escape turn-cancel is
//     the pi TUI's; other kinds get an honest refusal pointing at
//     herdr_send_keys. A turn cancel, not a terminate — closing panes is
//     the kill-all menu action or herdr pane close.
//   - resume: the recovery move for a `gone` agent. Target is a REGISTRY
//     HANDLE, never a raw path; the registry holds the retained session
//     file. Relaunches pi --session <retained> in a fresh pane with a
//     re-derived launch plan (the definition's kind/model/thinking resolved
//     NOW via the issue-08 chain) and re-enters normal supervision. Same
//     gates as any spawn. Honest limit: resume replays the session file —
//     anything that lived only in the dead process is gone (pi-herdr owns
//     the file from boot, so that is the whole truth).
//
// Engine + thin pi registration, mirroring message.ts: injectable seams for
// offline red-green; defaults hit herdr + the live registry. This module
// sits beside message.ts rather than inside spawn.ts/orchestration.ts to
// keep the import graph acyclic (spawn imports orchestration; the engines
// here need spawn's registry + launch path AND orchestration-adjacent
// machinery).

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fleetList, herdr } from "../herdr.js";
import {
	buildAgentArgs,
	checkGates,
	currentStatus,
	defaultLoad,
	deriveStance,
	ensureDrainLoop,
	kindCaps,
	materializeAgentArgs,
	mergeSpawnSpec,
	persistSpawnRegistry,
	claimAgentExecution,
	spawnRecords,
	startRecordNow,
	validateKindEnforcement,
	type SpawnDeps,
	type SpawnRecord,
	type SpawnStatus,
	type Stance,
} from "../spawn.js";
import {
	defaultAgentDirs,
	resolveSpecifier,
	type AgentDefinition,
} from "../agentdefs.js";
import { resolveRouting, validateRouting } from "../launchplan.js";
import { clearSidecars } from "../sessionfile.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { completionEventPath } from "../completion-event.js";
import { defaultAgentGet, type AgentView } from "./message.js";
import type {
	HerdrErrorCode,
	Result,
	ToolReturn,
} from "../env.js";

// ---- small helpers ------------------------------------------------------------

function persistCompletionRun(sessionPath: string, runId: string): void {
	try {
		writeFileSync(completionEventPath(sessionPath), runId, { mode: 0o600 });
	} catch {
		/* The child's env identity remains authoritative on restart. */
	}
}

function err(
	code: HerdrErrorCode,
	message: string,
	details?: unknown,
): { ok: false; error: { code: HerdrErrorCode; message: string; details?: unknown } } {
	return { ok: false, error: { code, message, details } };
}

function fail(r: { code: HerdrErrorCode; message: string; details?: unknown }): ToolReturn {
	return {
		content: [{ type: "text", text: `Error (${r.code}): ${r.message}` }],
		details: { error: r },
		isError: true,
	};
}

/** Registry record for a pane id (the fleet addresses panes; we key handles). */
function byPaneId(
	registry: ReadonlyMap<string, SpawnRecord>,
	paneId: string,
): SpawnRecord | undefined {
	return [...registry.values()].find((r) => r.paneId === paneId);
}

/** The key-send path interrupt rides (the same argv herdr_send_keys builds). */
const defaultSendKeys = (
	paneId: string,
	keys: string[],
	signal?: AbortSignal,
): Promise<Result<true>> =>
	herdr(["pane", "send-keys", paneId, ...keys], {
		timeoutMs: 10_000,
		signal,
	}).then((r) => (r.ok ? { ok: true, data: true as const } : r));

// ---- interrupt ----------------------------------------------------------------

export interface InterruptDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** `agent get` — default: herdr CLI (message.ts's shared view). */
	agentGet?: (target: string, signal?: AbortSignal) => Promise<Result<AgentView>>;
	/** Key-send — default: `pane send-keys` (sync.ts's argv). */
	sendKeys?: typeof defaultSendKeys;
	now?: () => number;
	signal?: AbortSignal;
}

export interface InterruptReceipt {
	interrupted: true;
	/** Registry handle. */
	name: string;
	/** Resolved pane id the Escape went to. */
	target: string;
	/** Live agent_status observed at interrupt time. */
	was: string;
}

/**
 * interrupt_agent, end to end: resolve → gates → Escape → the flag.
 * Resolution: registry handle → live pane-id/name → registry-by-pane. A
 * pane this session didn't spawn has no registry record, so no projection
 * wiring exists for it — refused honestly (herdr_send_keys is the raw way).
 */
export async function interruptAgent(
	params: { target: string },
	deps: InterruptDeps = {},
): Promise<Result<InterruptReceipt>> {
	const registry = deps.registry ?? spawnRecords;
	const agentGet = deps.agentGet ?? defaultAgentGet;
	const sendKeys = deps.sendKeys ?? defaultSendKeys;
	const now = deps.now ?? (() => Date.now());
	const signal = deps.signal;

	// 1. resolve to a registry record: handle first, then pane-id/name.
	let record = registry().get(params.target);
	let paneId = record?.paneId;
	if (!record) {
		const view = await agentGet(params.target, signal);
		if (view.ok) {
			paneId = view.data.paneId;
			record = byPaneId(registry(), paneId);
		}
		if (!record) {
			return err(
				"NOT_FOUND",
				`no spawned agent matches "${params.target}" — herdr_interrupt_agent cancels the current turn of an agent THIS SESSION spawned (herdr_list_agents shows the fleet). For any other pane, send a raw Escape with herdr_send_keys.`,
				{ target: params.target },
			);
		}
	}

	// 2. the pi-only promise (the Escape turn-cancel is the pi TUI's).
	if (record.kind.toLowerCase() !== "pi") {
		return err(
			"VALIDATION_ERROR",
			`"${record.name}" is a ${record.kind} agent — interrupt (turn-cancel via Escape) is pi-only. Send a raw Escape with herdr_send_keys instead.`,
			{ name: record.name, kind: record.kind },
		);
	}

	// 3. pane presence — nothing to cancel before it exists or after it died.
	if (!paneId) {
		return record.startError
			? err(
					"NOT_FOUND",
					`"${record.name}" never started (no pane): ${record.startError}`,
					{ name: record.name },
				)
			: err(
					"NOT_FOUND",
					`"${record.name}" is still queued (fleet at max_parallel_agents) — nothing to interrupt yet.`,
					{ name: record.name },
				);
	}
	const view = await agentGet(paneId, signal);
	if (!view.ok) {
		if (view.error.code === "NOT_FOUND") {
			return err(
				"NOT_FOUND",
				`"${record.name}" is gone (pane ${paneId} is no longer live) — nothing to interrupt. Recover it with herdr_resume_agent: its session file is retained.`,
				{ name: record.name, paneId },
			);
		}
		return { ok: false, error: view.error }; // transport failure is NOT absence evidence
	}
	const was = view.data.status ?? "unknown";
	if (was === "idle" || was === "done") {
		return err(
			"VALIDATION_ERROR",
			`"${record.name}" is settled (${was}) — no turn to cancel. Send new work with herdr_trigger_turn.`,
			{ name: record.name, state: was },
		);
	}

	// 4. Escape first, then the flag only once it landed — a failed send
	//    must not leave a phantom interrupted state behind.
	const sent = await sendKeys(paneId, ["esc"], signal);
	if (!sent.ok) return { ok: false, error: sent.error };
	record.interruptedAt = now();
	return {
		ok: true,
		data: { interrupted: true, name: record.name, target: paneId, was },
	};
}

// ---- resume -------------------------------------------------------------------

export interface TriggerTurnParams {
	target: string;
	text: string;
}

export interface TriggerTurnReceipt {
	name: string;
	agentId: string;
	runId: string;
	sequence: number;
	status: "accepted" | "queued" | "starting";
	paneId?: string;
	started: boolean;
}

async function defaultFollowupSubmit(paneId: string, text: string, signal?: AbortSignal): Promise<Result<true>> {
	const sent = await herdr(["agent", "prompt", paneId, text], { signal, timeoutMs: 10_000 });
	return sent.ok ? { ok: true, data: true } : sent;
}

/** Accept a new followup run; only launch immediately when the pane is idle. */
export async function triggerTurn(
	params: TriggerTurnParams,
	deps: SpawnDeps = {},
): Promise<Result<TriggerTurnReceipt>> {
	const record = spawnRecords().get(params.target);
	if (!record) return err("NOT_FOUND", `no spawned agent matches "${params.target}" — use herdr_list_agents.`);
	if (record.kind.toLowerCase() !== "pi" || !record.sessionPath || !record.agentId) {
		return err("VALIDATION_ERROR", `"${record.name}" has no resumable pi session.`, { name: record.name });
	}
	const agentId = record.agentId;
	const release = claimAgentExecution(record);
	if (!release) return err("VALIDATION_ERROR", `a followup for "${record.name}" is already being accepted; retry shortly.`);
	try {
		const fleet = await (deps.fleet ?? fleetList)(deps.signal);
		if (!fleet.ok) return { ok: false, error: fleet.error };
		const live = record.paneId ? fleet.data.find((pane) => pane.paneId === record.paneId) : undefined;
		if (record.paneId && !live && record.startBeganAt && record.startedAt === undefined) {
			return err("VALIDATION_ERROR", `"${record.name}" is still starting; retry the followup when startup settles.`);
		}
		if (!record.paneId && !live && !record.startError && !record.delivery && !record.pendingFollowups?.length) {
			return err("VALIDATION_ERROR", `"${record.name}" is still queued; followup was not accepted to avoid losing work.`);
		}
		const busy = live ? live.agentStatus !== "idle" && live.agentStatus !== "done" : false;
		if (live?.agentStatus === "blocked") {
			return err("VALIDATION_ERROR", `"${record.name}" is blocked on user input; answer the question before triggering a followup.`);
		}
		const wasBusyQueue = (record.pendingFollowups?.length ?? 0) > 0;
		const oldRunId = record.runId;
		const oldSequence = record.sequence;
		const runId = randomUUID();
		if (busy) {
			record.pendingFollowups = [...(record.pendingFollowups ?? []), { runId, text: params.text }];

			persistSpawnRegistry(deps);
			ensureDrainLoop(deps);
			return { ok: true, data: { name: record.name, agentId, runId, sequence: 1, status: "queued", started: false } };
		}
		if ((live && (wasBusyQueue || record.pendingFollowups?.length || (record.delivery && record.delivery.kind !== "blocked"))) || (!live && record.pendingFollowups?.length)) {
			record.pendingFollowups = [...(record.pendingFollowups ?? []), { runId, text: params.text }];
			persistSpawnRegistry(deps);
			ensureDrainLoop(deps);
			return { ok: true, data: { name: record.name, agentId, runId, sequence: 1, status: "queued", started: false } };
		}
		if (live && live.paneId && !wasBusyQueue && (!record.delivery || record.delivery.kind === "blocked")) {
			const previousCloseAuthorization = record.paneCloseAuthorization;
			record.pendingFollowups = [{ runId, text: params.text }];
			record.pendingRunId = runId;
			record.runId = runId;
			record.sequence = 1;
			record.prompt = params.text;
			record.resumeSilent = false;
			record.paneClosePending = false;
			record.paneCloseAuthorization = undefined;
			record.delivery = undefined;
			persistSpawnRegistry(deps);
			clearSidecars(record.sessionPath);
			persistCompletionRun(record.sessionPath, runId);
			const envelope = `<herdr-followup runId="${runId}">\n${params.text}\n</herdr-followup>`;
			const result = await (deps.submit ? deps.submit(live.paneId, envelope, 30_000, deps.signal) : defaultFollowupSubmit(live.paneId, envelope, deps.signal));
			if (result && !result.ok) {
				record.pendingFollowups = [{ runId, text: params.text }];
				record.runId = oldRunId;
				record.sequence = oldSequence;
				record.pendingRunId = undefined;
				if (record.sessionPath) persistCompletionRun(record.sessionPath, oldRunId);
				record.paneCloseAuthorization = previousCloseAuthorization;
				record.startError = result.error.message;
				persistSpawnRegistry(deps);
				return { ok: false, error: { ...result.error, details: { name: record.name, agentId, runId, status: "start-error", started: false } } };
			}
			record.pendingFollowups = [];
			record.pendingRunId = undefined;
			record.submitted = true;
			persistSpawnRegistry(deps);
			return { ok: true, data: { name: record.name, agentId, runId, sequence: 1, status: "starting", paneId: live.paneId, started: false } };
		}
		record.paneId = live?.paneId;
		record.submitted = false;
		record.sawWorking = false;
		record.startedAt = undefined;
		record.startError = undefined;
		record.delivery = undefined;
		record.goneAt = undefined;
		const pending: Promise<Result<TriggerTurnReceipt>> = (async () => {
			const previousPaneId = record.paneId;
			const previousDelivery = record.delivery;
			record.delivery = undefined;
			record.paneId = undefined;
			record.pendingFollowups = [{ runId, text: params.text }];
			record.pendingRunId = runId;
			persistSpawnRegistry(deps);
			record.stance = "interactive";
			const envelope = `<herdr-followup runId="${runId}">\n${params.text}\n</herdr-followup>`;
			const result = await resumeAgentSerial({ target: record.name, message: envelope }, { ...deps, forceStart: true, followupRunId: runId });
			record.stance = record.definition?.interactive === true || record.definition?.auto_exit === false ? "interactive" : "autonomous";
			if (!result.ok) {
				record.runId = runId;
				record.sequence = 1;
				record.paneId = previousPaneId;
				record.delivery = previousDelivery;
				record.pendingRunId = undefined;
				record.startError = result.error.message;
				return { ok: false as const, error: result.error };
			}
			if (!result.data.queued) record.pendingFollowups = [];
			return { ok: true as const, data: { name: record.name, agentId, runId, sequence: 1, status: result.data.queued ? "queued" as const : "starting" as const, paneId: result.data.paneId, started: false } };
		})();
		const outcome = await pending;
		if (!outcome.ok) {
			record.runId = runId;
			record.sequence = 1;
			record.delivery = undefined;
			persistSpawnRegistry(deps);
			return { ok: false, error: { ...outcome.error, details: { name: record.name, agentId, runId, status: "start-error", started: false } } };
		}
		persistSpawnRegistry(deps);
		return outcome;
	} finally {
		release();
	}
}

export interface ResumeParams {
	/** Registry HANDLE (never a raw path — the registry holds the retained
	 * session file). */
	target: string;
	/** Optional opening prompt, submitted after the boot gate (with the
	 * task-artifact machinery). Omitted → the child
	 * replays the session and sits open (nothing is resubmitted). */
	message?: string;
}

export interface ResumeResultData {
	name: string;
	status: SpawnStatus;
	queued?: boolean;
	paneId?: string;
	kind: string;
	/** The retained session file — the SAME path the dead run wrote. */
	sessionPath: string;
	activityPath?: string;
	stance: Stance;
	/** Re-resolved NOW (issue 08 chain against current settings/parent). */
	model?: string;
	thinking?: string;
	resumed: true;
}

/**
 * resume_agent, end to end: handle → substrate → gone-check → re-derived
 * launch plan (NOW) → gates → fresh run. The record is REUSED (same handle,
 * same session file) so message/result/list keep addressing the agent, and
 * the delivery loop + watchdog resume supervision untouched.
 */
export async function resumeAgent(params: ResumeParams, deps: SpawnDeps = {}): Promise<Result<ResumeResultData>> {
	const record = spawnRecords().get(params.target);
	if (!record) return resumeAgentSerial(params, deps);
	const release = claimAgentExecution(record);
	if (!release) return err("VALIDATION_ERROR", `"${record.name}" already has an execution transition in progress.`);
	try { return await resumeAgentSerial(params, deps); } finally { release(); }
}

async function resumeAgentSerial(
	params: ResumeParams,
	deps: SpawnDeps = {},
): Promise<Result<ResumeResultData>> {
	const target = params.target;
	const env = deps.env ?? process.env;

	// 1. registry HANDLE only — never a raw path.
	const record = spawnRecords().get(target);
	if (!record) {
		const looksPath = /[\\/]/.test(target) || /\.jsonl$/i.test(target);
		return err(
			"NOT_FOUND",
			looksPath
				? `resume targets a registry HANDLE (the name herdr_spawn_agent returned), never a raw path — "${target}" looks like a path. herdr_list_agents shows the handles.`
				: `no spawned agent matches "${target}" — herdr_resume_agent recovers agents THIS SESSION spawned (herdr_list_agents shows the handles).`,
			{ target },
		);
	}

	// 2. substrate: resume replays the retained pi session file.
	if (record.kind.toLowerCase() !== "pi" || !record.sessionPath) {
		return err(
			"VALIDATION_ERROR",
			`"${record.name}" is a ${record.kind} agent with no retained pi session file — resume replays the session file, and there is nothing to replay. Spawn it again instead.`,
			{ name: record.name, kind: record.kind },
		);
	}

	// 3. gone only. One fleet observation feeds the absence check AND the
	//    cap count; a FAILED observation is never absence evidence.

	const fleet = await (deps.fleet ?? fleetList)(deps.signal);
	if (!fleet.ok) return { ok: false, error: fleet.error };
	const livePaneIds = new Set(
		fleet.data.map((a) => a.paneId).filter((p): p is string => Boolean(p)),
	);
	if (record.paneId && livePaneIds.has(record.paneId) && !deps.forceStart) {
		return err(
			"VALIDATION_ERROR",
			`"${record.name}" is still live (pane ${record.paneId}) — interrupt its turn with herdr_interrupt_agent or dispatch work with herdr_trigger_turn instead of resuming.`,
			{ name: record.name, paneId: record.paneId },
		);
	}
	if (!record.paneId && !record.startError && !deps.forceStart) {
		return err(
			"VALIDATION_ERROR",
			`"${record.name}" is still queued (fleet at max_parallel_agents) — nothing to resume yet.`,
			{ name: record.name },
		);
	}

	// 4. re-derive the launch plan NOW: definition re-resolved by `type`
	//    (fresh .md edits apply), falling back to the spawn-time snapshot
	//    when the type can no longer be resolved; kind/model/thinking run
	//    the issue-08 chain against CURRENT settings/parent/registry.
	const settings = (deps.load ?? defaultLoad)();
	let definition: AgentDefinition | undefined;
	if (record.type) {
		const resolved = resolveSpecifier(
			{ type: record.type },
			deps.agentDirs ?? defaultAgentDirs(),
		);
		if (resolved.ok) definition = resolved.data.definition;
	}
	definition ??= record.definition;
	if (!definition) {
		return err(
			"VALIDATION_ERROR",
			`"${record.name}" has no re-derivable definition (anonymous inline spawn, no snapshot) — resume cannot rebuild the launch plan.`,
			{ name: record.name },
		);
	}
	const merged = mergeSpawnSpec(definition, {}, settings.default_kind);
	if (merged.kind.toLowerCase() !== "pi") {
		return err(
			"VALIDATION_ERROR",
			`resume replays a pi session file (--session is pi-only), but "${record.name}"'s definition now resolves to kind "${merged.kind}" (default_kind: "${settings.default_kind}") — refused.`,
			{ name: record.name, kind: merged.kind },
		);
	}
	const routing = resolveRouting({ definition, settings, parent: deps.parent });
	merged.model =
		routing.modelSource === "parent" && !kindCaps(merged.kind).model
			? undefined
			: routing.model;
	merged.thinking = routing.thinking;
	const routingError = validateRouting(
		routing,
		kindCaps(merged.kind),
		deps.registry,
		definition.name || undefined,
		merged.kind,
	);
	if (routingError) return { ok: false, error: routingError.error };
	const enforcement = validateKindEnforcement(merged);
	if (enforcement) return enforcement;
	const agentArgs = buildAgentArgs(merged, {
		child: {
			name: record.name,
			type: record.type,
			stance: deriveStance(merged),
			sessionMode: merged.session_mode,
		},
	});
	const mat = materializeAgentArgs(agentArgs, record.name, merged.kind);
	if (!mat.ok) return mat;
	record.agentArgs = mat.data;
	record.routing = routing;
	record.stance = deriveStance(merged);

	// 5. the same gates as any spawn, in order (kill-switch → depth → cap).
	const liveCount = [...spawnRecords().values()].filter(
		(r) => r.paneId && livePaneIds.has(r.paneId),
	).length;
	const gates = checkGates(settings, env, liveCount);
	if (gates.decision === "refuse") return { ok: false, error: gates.error };

	// 6. fresh run on the SAME record: reset transients and drop the dead
	//    pane binding. TriggerTurn owns identity/event preparation; maintenance
	//    resume keeps the established run identity and sidecar reset behavior.
	if (!deps.forceStart) clearSidecars(record.sessionPath);
	if (deps.followupRunId) {
		record.pendingRunId = deps.followupRunId;
		record.sequence = 1;
	}
	record.prompt = params.message ?? record.prompt;
	record.resumeSilent = params.message === undefined;
	record.paneId = undefined;
	record.startedAt = undefined;
	record.submitted = false;
	record.sawWorking = false;
	record.startError = undefined;
	record.goneAt = undefined;
	record.watch = undefined;
	record.delivery = undefined;
	record.blockedNotified = false;
	record.interruptedAt = undefined;
	record.lastStatus = undefined;
	record.taskArtifactPath = undefined;

	// 7. start now, or re-enter the queue when the fleet is at cap.
	const common = {
		name: record.name,
		kind: merged.kind,
		sessionPath: record.sessionPath,
		...(record.activityPath ? { activityPath: record.activityPath } : {}),
		stance: record.stance,
		...(routing.model ? { model: routing.model } : {}),
		...(routing.thinking ? { thinking: routing.thinking } : {}),
		resumed: true as const,
	};
	if (gates.decision === "queue") {
		ensureDrainLoop(deps);
		return {
			ok: true,
			data: { ...common, status: "queued", queued: true },
		};
	}
	const startR = await startRecordNow(record, deps);
	if (!startR.ok) {
		record.startError = startR.error.message;
		return {
			ok: false,
			error: {
				...startR.error,
				details: {
					...(typeof startR.error.details === "object" && startR.error.details
						? startR.error.details
						: {}),
					name: record.name,
					paneId: record.paneId,
				},
			},
		};
	}
	// A silent resume's receipt is honestly `idle`: the boot gate just saw
	// the replayed pane settle — there is no turn in flight to report.
	return {
		ok: true,
		data: {
			...common,
			status: record.resumeSilent ? "idle" : await currentStatus(record, deps),
			paneId: record.paneId,
		},
	};
}

// ---- registration --------------------------------------------------------------

const RESUME_DESCRIPTION =
	"Bring a dead herdr agent back on its retained session — the recovery move for a `gone` agent " +
	"(crashed, errored, or pane-closed without finishing). Target is a spawn-registry HANDLE, never a " +
	"raw path; the registry holds the retained session file. Relaunches `pi --session <retained>` in a " +
	"fresh pane with a RE-DERIVED launch plan — the definition's kind/model/thinking resolved NOW (the " +
	"routing chain against current settings and this session's model), not the dead process's stale " +
	"runtime; a settings change between death and resume takes effect. The optional `message` is " +
	"submitted as the opening prompt (give the resumed child its next instruction); without one the " +
	"child replays the session and sits open — pass a message to give an autonomous child work. The " +
	"run re-enters normal supervision (fleet row, watchdog, push-on-completion). Same gates as any " +
	"spawn: kill-switch, spawn depth, parallel cap (over-cap = queued, started when a slot frees). " +
	"Stance follows the agent definition: autonomous resumes auto-exit-and-push again, interactive " +
	"resumes stay open for a human. Honest limit: resume replays the session file — anything that " +
	"lived only in the dead process is gone; the session file is the whole truth. Non-pi agents have " +
	"nothing to replay and are refused.";

const INTERRUPT_DESCRIPTION =
	"Cancel the current turn of a spawned herdr agent — a turn-level interrupt, NOT a terminate. " +
	"Sends Escape to the child pane (pi children only) and stamps the registry so herdr_list_agents / " +
	"herdr_get_agent_result report `interrupted` immediately — even while herdr still shows the pane " +
	"working; a lagging pre-interrupt activity snapshot cannot overwrite it. The pane stays open, the " +
	"session file and supervision intact; new work via herdr_trigger_turn returns it to active — " +
	"stop-and-redirect in one flow. The target resolves as: spawn-registry handle → pane id → herdr name " +
	"(agents THIS SESSION spawned only; anything else is refused — use herdr_send_keys for a raw Escape). " +
	"Honest refusals: non-pi kinds (Escape turn-cancel is the pi TUI's), queued/never-started agents, " +
	"settled (idle/done) panes — nothing to cancel — and gone panes, which point at herdr_resume_agent " +
	"(the recovery move: the session file is retained).";

export function registerLifecycle(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_interrupt_agent",
		label: "Interrupt herdr agent",
		description: INTERRUPT_DESCRIPTION,
		promptSnippet: "Interrupt a spawned herdr agent's current turn (Escape)",
		promptGuidelines: [
			"Use herdr_interrupt_agent to stop an agent's current turn without killing the pane; follow with herdr_trigger_turn to redirect it (stop-and-redirect), or herdr_send_agent for context-only correspondence.",
			"A gone agent cannot be interrupted — recover it with herdr_resume_agent instead.",
		],
		parameters: Type.Object({
			target: Type.String({
				description: "Spawn-registry handle, pane id, or herdr name.",
			}),
		}),
		async execute(_id, p, signal) {
			const r = await interruptAgent({ target: p.target }, { signal });
			if (!r.ok) return fail(r.error);
			const d = r.data;
			return {
				content: [
					{
						type: "text",
						text: `Interrupted "${d.name}" (pane ${d.target}, was: ${d.was}) — Escape sent; the projected state is interrupted until new work arrives. Redirect with herdr_trigger_turn, or recover later with herdr_resume_agent.`,
					},
				],
				details: d,
			};
		},
	});

	// trigger_turn --------------------------------------------------------------
	pi.registerTool({
		name: "herdr_trigger_turn",
		label: "Trigger herdr agent turn",
		description: "Accept a new followup run for a spawned pi agent. Busy agents queue it without interrupting their current tools; idle agents start immediately. A gone pane whose session is retained is restored automatically on the same session — no separate resume call is needed. The receipt distinguishes accepted/queued/starting and carries the new runId; accepted does not mean started. Use herdr_send_agent for context-only messaging; this tool triggers work.",
		promptSnippet: "Start a new run for a spawned agent, safely queueing if busy",
		promptGuidelines: ["Use herdr_trigger_turn when an agent must act on new work; it creates a new run while retaining the same logical agent and session.", "Busy agents are never interrupted; the new run is queued."],
		parameters: Type.Object({ target: Type.String({ description: "Spawn-registry handle returned by herdr_spawn_agent." }), text: Type.String({ description: "New work for the agent." }) }),
		async execute(_id, p, signal) {
			const r = await triggerTurn({ target: p.target, text: p.text }, { signal });
			if (!r.ok) return fail(r.error);
			const d = r.data;
			return { content: [{ type: "text", text: `Followup ${d.status} for "${d.name}" (agent ${d.agentId}, run ${d.runId}${d.paneId ? `, pane ${d.paneId}` : ""}); ${d.started ? "startup requested—not yet guaranteed active." : "accepted but not started."}` }], details: d };
		},
	});

	// resume_agent -------------------------------------------------------------
	pi.registerTool({
		name: "herdr_resume_agent",
		label: "Resume herdr agent",
		description: RESUME_DESCRIPTION,
		promptSnippet:
			"Relaunch a gone herdr agent on its retained session file",
		promptGuidelines: [
			"Use herdr_resume_agent to recover a gone agent (crash, error, closed pane) — it relaunches on the SAME session file, so the child keeps its full conversation.",
			"Pass `message` to give the resumed agent its next instruction; an autonomous child without a message replays and then sits idle.",
		],
		parameters: Type.Object({
			target: Type.String({
				description:
					"Spawn-registry handle (the name herdr_spawn_agent returned) — never a raw session path.",
			}),
			message: Type.Optional(
				Type.String({
					description:
						"Opening prompt for the resumed run (its next instruction).",
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
			const r = await resumeAgent(
				{ target: p.target, message: p.message },
				{
					signal,
					// Routing level 5 + exact-model validation resolve NOW,
					// against THIS session's pi context.
					parent: ctx?.model
						? { model: { provider: ctx.model.provider, id: ctx.model.id } }
						: undefined,
					registry: ctx?.modelRegistry,
				},
			);
			if (!r.ok) return fail(r.error);
			const d = r.data;
			const where = d.paneId
				? `pane ${d.paneId}`
				: "no pane yet (queued — a slot frees)";
			const routing = [
				d.model ? `model ${d.model}` : "",
				d.thinking ? `thinking ${d.thinking}` : "",
			]
				.filter(Boolean)
				.join(", ");
			return {
				content: [
					{
						type: "text",
						text: `Resumed "${d.name}" in ${where} on its retained session (${d.sessionPath}); status: ${d.status}.${routing ? ` Routing re-resolved now: ${routing}.` : ""} ${d.stance === "autonomous" ? "Stance autonomous — it will push its result and exit on settle." : "Stance interactive — the pane stays open for a human."}`,
					},
				],
				details: d,
			};
		},
	});
}
