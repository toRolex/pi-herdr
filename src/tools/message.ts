// herdr_message_agent — the open channel (v0.6 issue 05).
//
// One tool, anyone ↔ anyone, no broker: any session (orchestrator, child, or
// peer) injects text into any agent pane. Decided by
// wayfinder/archive/v0.5-tickets/11-message-channel-surface.md, ruling
// unchanged per the surface-cut keeper table (#3):
//   - target always explicit, resolved by the shared chain:
//     exact pane-id → herdr name → spawn-registry handle, except the
//     reserved role `orchestrator`, which is resolved first and only as
//     the sender's direct parent;
//   - `orchestrator` resolves via PI_HERDR_ORCHESTRATOR_PANE (stamped by
//     spawn when the spawner itself runs in a pane). A live agent or
//     spawn handle of that name does not take the alias. Unset or a
//     missing parent pane → the honest error;
//   - delivery = text injection through the existing send machinery — one
//     code path, no pane-metadata channel, no file+notice;
//   - physics-adaptive: a BLOCKED target gets the RAW text typed into its
//     overlay (the message IS the answer; wrapping would pollute the recorded
//     answer); everything else is enveloped
//     `<agent-message from to>` — spawner-declared identity, never verified,
//     no child-side parsing (the receiving MODEL recognizes the tag);
//   - no state gates (text to a working child queues natively), no `wait`
//     (fire-and-forget — get_agent_result(wait) covers waiting), and a
//     `gone` target errors naming the handle, pointing at herdr_list_agents.
//
// This file is the engine + thin pi registration; the send machinery lives in
// orchestration.ts. Separate from orchestration.ts because it needs the spawn
// registry (spawn.ts) — which imports orchestration.ts — so importing
// spawnRecords there would close a cycle.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PENDING_CAP } from "../inbox.js";
import { readCompletionEvent, validEventId } from "../completion-event.js";
import { fleetList, herdr } from "../herdr.js";
import { sendAgentPrompt } from "./orchestration.js";
import {
	readPersistedRegistry,
	spawnRecords,
	type SpawnRecord,
} from "../spawn.js";
import { currentOrchestratorSession } from "../push.js";
import { writeSteerWatermark } from "../sessionfile.js";
import {
	normalizeAgent,
	type HerdrErrorCode,
	type Result,
	type ToolReturn,
} from "../env.js";

// ---- engine types ------------------------------------------------------------

/** How the text physically landed (ticket 11's receipt axis). */
export type Delivery = "message" | "answer";

/** What one `agent get` yields for resolution + the physics branch. */
export interface AgentView {
	paneId: string;
	name?: string;
	/** Raw herdr agent_status (idle | working | blocked | done | unknown). */
	status?: string;
}

export interface MessageParams {
	/** Final report only: correlate with this child's completion sidecar. */
	completion?: boolean;
	target: string;
	text: string;
	submit?: boolean;
	/** Business event id. Absent means the envelope and receipt stay untagged. */
	eventId?: string;
	/** Deprecated compatibility flag; receiver lifecycle owns pending input. */
	pending?: boolean;
}

/** Structured receipt (tool `details`). */
export interface MessageReceipt {
	delivered: boolean;
	/** Resolved pane id. */
	target: string;
	/** Envelope `to` — the address the message is labeled with. */
	to: string;
	/** Envelope `from` — spawner-declared identity, never verified. */
	from: string;
	/** Live agent_status observed at delivery time. */
	state: string;
	delivery: Delivery;
	/** Registry handle when the target is one of this session's spawns. */
	name?: string;
	submit: boolean;
	/** Accepted into the pending inbox; not typed into the pane yet. */
	queued?: boolean;
	/** Drop notice for the sender of this call and for the receiver. */
	notice?: string;
	/** Copied from the caller. Never generated here. */
	eventId?: string;
}

/** Injectable seams (offline red-green; defaults hit herdr + disk). */
export interface MessageDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** `agent get` — default: herdr CLI. */
	agentGet?: (target: string, signal?: AbortSignal) => Promise<Result<AgentView>>;
	/** Text injection — default: orchestration's sendAgentPrompt. */
	send?: typeof sendAgentPrompt;
	/** Env view — default: process.env. */
	env?: Record<string, string | undefined>;
	/** Fleet names for the generation check — default: `herdr agent list`. */
	list?: () => Promise<{ name?: string; paneId?: string }[]>;
	/** Another session's spawn registry — default: readPersistedRegistry.
	 * A throw is a failed observation, not an empty registry. */
	readRegistry?: (sessionPath: string) => readonly SpawnRecord[];
	signal?: AbortSignal;
	/** Clock for the inbound window — default: Date.now. */
	now?: () => number;
}

/** The bare error payload a Result carries (env.ts's Err.error). */
interface SendError {
	code: HerdrErrorCode;
	message: string;
	details?: unknown;
}

function err(
	code: HerdrErrorCode,
	message: string,
	details?: unknown,
): SendError {
	return { code, message, details };
}

function fail(r: SendError): ToolReturn {
	return {
		content: [{ type: "text", text: `Error (${r.code}): ${r.message}` }],
		details: { error: r },
		isError: true,
	};
}

/** The bare `agent get` view (resolution + the physics/state inputs).
 * Exported for the lifecycle tools (issue 10) — same resolution inputs. */
export const defaultAgentGet = async (
	target: string,
	signal?: AbortSignal,
): Promise<Result<AgentView>> => {
	const r = await herdr<unknown>(["agent", "get", target], {
		timeoutMs: 10_000,
		signal,
	});
	if (!r.ok) return { ok: false, error: r.error };
	const a = normalizeAgent(
		(r.data as { agent?: unknown })?.agent ?? r.data,
	);
	if (!a.paneId) {
		return {
			ok: false,
			error: err("NOT_FOUND", `No pane found for target "${target}"`, r.data),
		};
	}
	return {
		ok: true,
		data: { paneId: a.paneId, name: a.name, status: a.agentStatus },
	};
};

// ---- envelope ----------------------------------------------------------------

export function envelope(
	from: string,
	to: string,
	text: string,
	eventId?: string,
): string {
	const event = eventId ? ` event="${eventId}"` : "";
	return `<agent-message from="${from}" to="${to}"${event}>\n${text}\n</agent-message>`;
}

/**
 * The `from` identity, spawner-declared, never verified (ticket 11):
 * PI_HERDR_AGENT_LABEL → PI_HERDR_NAME (what spawn stamps) → the sending
 * pane's herdr name → the pane id → "session" (a top-level session outside
 * herdr has no pane identity at all).
 */
export async function senderLabel(
	deps: MessageDeps = {},
): Promise<string> {
	const env = deps.env ?? process.env;
	const declared = env.PI_HERDR_AGENT_LABEL ?? env.PI_HERDR_NAME;
	if (declared) return declared;
	const paneId = env.HERDR_PANE_ID;
	if (paneId) {
		const v = await (deps.agentGet ?? defaultAgentGet)(paneId, deps.signal);
		return v.ok && v.data.name ? v.data.name : paneId;
	}
	return "session";
}

// ---- resolution chain ----------------------------------------------------------

type Resolved =
	| {
			kind: "live";
			paneId: string;
			state?: string;
			name?: string;
			to: string;
			/** The spawn-registry record when the target is one of ours. */
			record?: SpawnRecord;
	  }
	| { kind: "err"; error: SendError };

function byPaneId(
	registry: ReadonlyMap<string, SpawnRecord>,
	paneId: string,
): SpawnRecord | undefined {
	return [...registry.values()].find((r) => r.paneId === paneId);
}

async function resolveTarget(
	target: string,
	deps: MessageDeps,
): Promise<Resolved> {
	const agentGet = deps.agentGet ?? defaultAgentGet;
	const registry = deps.registry ?? spawnRecords;
	const env = deps.env ?? process.env;

	// Reserved role, before any name lookup. The string "orchestrator" is
	// only the sender's direct parent (PI_HERDR_ORCHESTRATOR_PANE). A fleet
	// agent or spawn handle of the same name must not take the alias.
	if (target === "orchestrator") {
		const orchestratorPane = env.PI_HERDR_ORCHESTRATOR_PANE;
		if (!orchestratorPane) {
			return {
				kind: "err",
				error: err(
					"NOT_FOUND",
					`no orchestrator above you: this session was not spawned by a pi-herdr agent (PI_HERDR_ORCHESTRATOR_PANE unset), so there is nothing to message as "orchestrator" — answer in-conversation, or address a peer via herdr_list_agents.`,
				),
			};
		}
		const above = await agentGet(orchestratorPane, deps.signal);
		if (above.ok) {
			return {
				kind: "live",
				paneId: above.data.paneId,
				state: above.data.status,
				to: "orchestrator",
			};
		}
		return {
			kind: "err",
			error: err(
				"NOT_FOUND",
				`the orchestrator pane (${orchestratorPane}) is gone — see herdr_list_agents.`,
				{ orchestratorPane },
			),
		};
	}

	// 1. exact pane-id / herdr name / label (herdr resolves all three; this
	//    also fetches the state the physics branch needs).
	const live = await agentGet(target, deps.signal);
	if (live.ok) {
		const records = registry();
		const record = records.get(target) ?? byPaneId(records, live.data.paneId);
		return {
			kind: "live",
			paneId: live.data.paneId,
			state: live.data.status,
			name: record?.name,
			to: record?.name ?? live.data.name ?? live.data.paneId,
			...(record ? { record } : {}),
		};
	}

	// 2. spawn-registry handle (queued records have no herdr presence yet).
	//    A transport failure is NOT evidence of gone — surface it honestly.
	const record = registry().get(target);
	if (record) {
		if (live.error.code !== "NOT_FOUND") return { kind: "err", error: live.error };
		if (!record.paneId) {
			if (record.startError) {
				return {
					kind: "err",
					error: err(
						"NOT_FOUND",
						`agent "${record.name}" never started (no pane): ${record.startError} — see herdr_list_agents.`,
						{ name: record.name },
					),
				};
			}
			return {
				kind: "err",
				error: err(
					"NOT_FOUND",
					`agent "${record.name}" is still queued (fleet at max_parallel_agents) — no pane exists to deliver to yet. Wait it into the world with herdr_get_agent_result(wait) first.`,
					{ name: record.name },
				),
			};
		}
		return {
			kind: "err",
			error: err(
				"NOT_FOUND",
				`agent "${record.name}" is gone (pane ${record.paneId} is no longer live) — see herdr_list_agents.`,
				{ name: record.name, paneId: record.paneId },
			),
		};
	}

	// 3. nothing matched.
	return {
		kind: "err",
		error: err(
			"NOT_FOUND",
			`no live agent matches "${target}" — see herdr_list_agents for the fleet.`,
		),
	};
}

// ---- generation gate (issue 40) ------------------------------------------------

/** A fleet row the generation check can name. */
interface FleetHandle {
	name?: string;
	paneId?: string;
}

/** The sender's own session file. Absent means this process has no lineage. */
function senderSession(env: Record<string, string | undefined>): string | undefined {
	return env.PI_HERDR_SESSION?.trim() || currentOrchestratorSession();
}

/** Where this sender sits: the ownerSession of the record that is this session. */
function senderOwner(
	self: string | undefined,
	root: string | undefined,
	read: (sessionPath: string) => readonly SpawnRecord[],
): string | undefined {
	if (!self || !root || root === self) return undefined;
	const seen = new Set<string>();
	const pending = [root];
	while (pending.length > 0) {
		const session = pending.shift();
		if (!session || seen.has(session)) continue;
		seen.add(session);
		for (const rec of read(session)) {
			if (rec.sessionPath === self) return rec.lineage?.ownerSession;
			if (rec.sessionPath) pending.push(rec.sessionPath);
		}
	}
	return undefined;
}

/**
 * Walk registry lineage and attach each known record to the fleet pane that
 * is still live. A registry read that throws is a failed observation — it
 * propagates, it is not an empty registry and it is not permission to send.
 */
type KnownTarget = Pick<SpawnRecord, "name" | "paneId" | "lineage"> & { root?: true };

function knownLive(
	root: string,
	fleet: readonly FleetHandle[],
	read: (sessionPath: string) => readonly SpawnRecord[],
): Map<string, KnownTarget> {
	const liveByPane = new Map<string, FleetHandle>();
	for (const handle of fleet) {
		if (handle.paneId && !liveByPane.has(handle.paneId)) {
			liveByPane.set(handle.paneId, handle);
		}
	}
	const byPane = new Map<string, KnownTarget>();
	const seen = new Set<string>();
	const pending = [root];
	while (pending.length > 0) {
		const session = pending.shift();
		if (!session || seen.has(session)) continue;
		seen.add(session);
		for (const rec of read(session)) {
			if (rec.sessionPath) pending.push(rec.sessionPath);
			// The root is not itself a spawn. A root-owned child's persisted
			// parent pane identifies it without inventing a root SpawnRecord.
			if (session === root && rec.lineage?.rootSession === root &&
				rec.lineage.ownerSession === root && rec.orchestratorPane) {
				const rootPane = liveByPane.get(rec.orchestratorPane);
				if (rootPane) {
					byPane.set(rec.orchestratorPane, {
						name: rootPane.name ?? rec.orchestratorPane,
						paneId: rec.orchestratorPane,
						root: true,
					});
				}
			}
			if (!rec.paneId || !rec.lineage?.ownerSession) continue;
			if (liveByPane.has(rec.paneId)) byPane.set(rec.paneId, rec);
		}
	}
	return byPane;
}

function handleOf(rec: KnownTarget, fleet: readonly FleetHandle[]): string {
	return (
		rec.name ||
		fleet.find((a) => a.paneId === rec.paneId)?.name ||
		rec.paneId ||
		"?"
	);
}

/**
 * Refuse a known cross-generation target. Same ownerSession (a peer), the
 * direct parent pane, and a record this session itself spawned are allowed.
 * A pane with no lineage stays anyone↔anyone. The reserved role
 * `orchestrator` never reaches here.
 *
 * Returns undefined when the send may proceed.
 */
async function generationGate(
	resolved: Extract<Resolved, { kind: "live" }>,
	deps: MessageDeps,
): Promise<SendError | undefined> {
	const env = deps.env ?? process.env;
	const self = senderSession(env);
	if (!self) return undefined;
	const read = deps.readRegistry ?? readPersistedRegistry;
	const root = env.PI_HERDR_ROOT_SESSION?.trim() || self;
	const parentPane = env.PI_HERDR_ORCHESTRATOR_PANE;
	if (parentPane && resolved.paneId === parentPane) return undefined;
	if (resolved.record?.lineage?.ownerSession === self) return undefined;

	let fleet: FleetHandle[];
	try {
		fleet = await (deps.list ?? ((signal?: AbortSignal) => defaultFleetList(signal)))(
			deps.signal,
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err(
			"HERDR_UNAVAILABLE",
			`cannot check generation: fleet query failed (${message}) — not sent.`,
		);
	}

	let known: Map<string, KnownTarget>;
	let mine: string | undefined;
	try {
		known = knownLive(root, fleet, read);
		mine = senderOwner(self, root, read);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err(
			"HERDR_UNAVAILABLE",
			`cannot check generation: registry read failed (${message}) — not sent.`,
		);
	}

	const target = known.get(resolved.paneId);
	if (!target || (!target.root && !target.lineage?.ownerSession)) return undefined;
	if (target.root && self === root) return undefined;

	const directChild = target.lineage?.ownerSession === self;
	const peer = mine != null && target.lineage?.ownerSession === mine;
	if (directChild || peer) return undefined;

	const usable = [...known.values()].flatMap((rec) => {
		if (rec.paneId === resolved.paneId) return [];
		const owner = rec.lineage?.ownerSession;
		const reachable =
			rec.paneId === parentPane ||
			owner === self ||
			(mine != null && owner === mine);
		return reachable ? [handleOf(rec, fleet)] : [];
	});
	const who = target.name || resolved.to;
	const listed = usable.length > 0 ? usable.join(", ") : "(none)";
	return err(
		"VALIDATION_ERROR",
		`refused: "${who}" is a different generation from you — not sent, and not redirected. Keep using: ${listed}.`,
		{ target: who, handles: usable },
	);
}

async function defaultFleetList(signal?: AbortSignal): Promise<FleetHandle[]> {
	const r = await fleetList(signal);
	if (!r.ok) throw new Error(r.error.message);
	return r.data.map((a) => ({ name: a.name, paneId: a.paneId }));
}

// Legacy test seams retained for API compatibility; enforcement belongs to the receiver.
export { INBOUND_LIMIT, INBOUND_WINDOW_MS, PENDING_CAP } from "../inbox.js";
export function resetInboundRateLimit(): void {}
export function resetPendingInbox(): void {}
export function admitInbound(_sender: string, _now: number): { ok: true } { return { ok: true }; }

// ---- the engine ----------------------------------------------------------------

/**
 * message_agent, end to end: resolve → physics branch → inject → receipt.
 * Fire-and-forget by design; no state gates. Inbound sends (everything
 * except a blocked-overlay answer) are capped per sender label.
 */
export async function messageAgent(
	params: MessageParams,
	deps: MessageDeps = {},
): Promise<Result<MessageReceipt>> {
	if (params.completion) {
		const session = (deps.env ?? process.env).PI_HERDR_SESSION;
		const eventId = session ? readCompletionEvent(session) : undefined;
		if (!eventId) return { ok: false, error: err("VALIDATION_ERROR", "completion requires a readable child run event marker — not sent.") };
		if (params.eventId && params.eventId !== eventId) return { ok: false, error: err("VALIDATION_ERROR", "explicit eventId conflicts with this child run — not sent.") };
		params = { ...params, eventId };
	}
	if (params.eventId !== undefined && !validEventId(params.eventId)) return { ok: false, error: err("VALIDATION_ERROR", "invalid eventId — not sent.") };
	const resolved = await resolveTarget(params.target, deps);
	if (resolved.kind === "err") return { ok: false, error: resolved.error };
	const generation = await generationGate(resolved, deps);
	if (generation) return { ok: false, error: generation };

	const submit = params.submit !== false;
	const blocked = resolved.state === "blocked";
	const from = await senderLabel(deps);

	const send = deps.send ?? sendAgentPrompt;
	const payload = blocked
		? params.text
		: envelope(from, resolved.to, params.text, params.eventId);
	// Steer watermark (issue 06): the exact text about to be typed into a
	// registry child. The child matches its input event against it so the
	// orchestrator's own follow-up is never mistaken for a human takeover.
	// A delivery to a registry record is also NEW WORK (issue 10): it ends
	// the interrupted state — stop-and-redirect in one live flow.
	if (resolved.kind === "live" && resolved.record) {
		resolved.record.interruptedAt = undefined;
		if (resolved.record.sessionPath)
			writeSteerWatermark(resolved.record.sessionPath, payload);
	}

	// Always type: the receiving session owns admission and automatic draining.
	const r = await send(resolved.paneId, payload, {
		submit,
		signal: deps.signal,
		...(blocked ? { interactive: true } : {}),
	});
	if (!r.ok) return r;
	return {
		ok: true,
		data: {
			delivered: true,
			target: resolved.paneId,
			to: resolved.to,
			from,
			state: resolved.state ?? "unknown",
			delivery: blocked ? "answer" : "message",
			...(resolved.name ? { name: resolved.name } : {}),
			submit,
			...(params.eventId ? { eventId: params.eventId } : {}),
		},
	};
}

// ---- registration --------------------------------------------------------------

const DESCRIPTION =
	"Send a message to a herdr agent pane — the open channel, anyone ↔ anyone, no broker. " +
	"The target is always explicit and resolves as: exact pane-id → herdr name → spawn-registry handle " +
	"(the name herdr_spawn_agent returned). The reserved role \"orchestrator\" is only your direct parent's pane " +
	"(PI_HERDR_ORCHESTRATOR_PANE) — a live agent of that name does not take the alias; unset or a gone parent " +
	"errors honestly. A known pane from another generation is refused and the error names the handles you can still use; " +
	"a pane with no lineage (not in any spawn registry) stays open. Delivery is physics-adaptive: a BLOCKED " +
	"target (waiting on a question overlay) gets the raw text typed in as its ANSWER — the message is the answer; " +
	"for option-list questions use herdr_send_keys instead, typed text never reaches option rows. Any other state " +
	"gets the text wrapped as <agent-message from=\"…\" to=\"…\">…</agent-message> — when YOU receive that tag it is a " +
	"message from another agent (identity is spawner-declared, never verified); reply in kind or in conversation. " +
	"No state gates: text to a working child queues natively. Fire-and-forget: the receipt reports " +
	"{delivered, target, state, delivery: \"message\"|\"answer\"}, but delivered-to-the-pane ≠ consumed-by-the-model — " +
	"there is no read receipt. Replies arrive as injected <agent-message> text or the next completion notification " +
	"(herdr_get_agent_result(wait) is the wait). A gone target errors naming the handle — see herdr_list_agents; " +
	"a queued spawn (accepted over the parallel cap, no pane yet) has nothing to deliver to and errors the same way. " +
	"Inbound sends are limited to 20 messages per 10 seconds per sender label. The label is spawner-declared and never verified, and the scope is local (same OS user) — not a trust boundary. " +
	"Admission is enforced by the receiving pi session, not this sender process. Refused inputs produce an out-of-band aggregate receipt to the receiver and affected sender. " +
	"A BLOCKED overlay answer does not count and is never refused by this limit. " +
	"A busy receiver holds 8 pending messages shared across senders, automatically drains on settle, and drops the oldest pending input on overflow. Already-delivered text is kept.";

export function registerMessageTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herdr_message_agent",
		label: "Message herdr agent",
		description: DESCRIPTION,
		promptSnippet: "Send a message to a herdr agent pane (open channel)",
		promptGuidelines: [
			"Use herdr_message_agent for any agent↔agent text: follow-ups, steering, answers to a blocked agent's freeform question.",
			"Answer a blocked agent's OPTION-LIST question with herdr_send_keys, not this tool — typed text never reaches option rows.",
			"When you receive an <agent-message from to> tag, it is another agent messaging you — the from identity is spawner-declared, never verified.",
		],
		parameters: Type.Object({
			target: Type.String({
				description:
					'Pane id (w1:p3), herdr name, spawn-registry handle, or the reserved role "orchestrator".',
			}),
			text: Type.String({ description: "Message text to deliver." }),
			submit: Type.Optional(
				Type.Boolean({
					description:
						"Press Enter after typing (default true). false leaves the text unsubmitted.",
				}),
			),
			pending: Type.Optional(
				Type.Boolean({
					description:
						"Deprecated compatibility flag; receiving pi automatically holds busy input and drains on settle. This flag does not change transport delivery.",
				}),
			),
			completion: Type.Optional(Type.Boolean({ description: "Final report only. Read this child's run completion event ID; the sidecar uses the same ID. Ordinary progress must omit this flag." })),
			eventId: Type.Optional(
				Type.String({
					description:
						"Business event id. When set, the envelope gains event=\"…\" and the receipt details carry eventId. Omit it and neither is added.",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const r = await messageAgent(
				{
					target: p.target,
					text: p.text,
					submit: p.submit,
					pending: p.pending,
					eventId: p.eventId,
					completion: p.completion,
				},
				{ signal },
			);
			if (!r.ok) return fail(r.error);
			const d = r.data;
			const who = d.name ?? d.to;
			const body = d.queued
				? `Accepted pending for "${who}" (pane ${d.target}, state: ${d.state}) — not typed yet. Pending inbox holds ${PENDING_CAP}.`
				: d.delivery === "answer"
					? `Delivered to "${who}" (pane ${d.target}, state: ${d.state}) as a RAW ANSWER — typed into its question overlay, unsubmitted=${!d.submit}. If it was an option list, select with herdr_send_keys instead.`
					: `Delivered to "${who}" (pane ${d.target}, state: ${d.state}) as an <agent-message> envelope (from "${d.from}"). Fire-and-forget: delivered ≠ consumed — the reply arrives as injected <agent-message> text or its next completion (wait with herdr_get_agent_result).`;
			const text = d.notice ? `${body} ${d.notice}` : body;
			return { content: [{ type: "text", text }], details: d };
		},
	});
}
