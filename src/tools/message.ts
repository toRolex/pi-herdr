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
import { herdr } from "../herdr.js";
import { sendAgentPrompt } from "./orchestration.js";
import { spawnRecords, type SpawnRecord } from "../spawn.js";
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
	target: string;
	text: string;
	submit?: boolean;
	/**
	 * Accept into the pending inbox instead of typing now. Only an idle
	 * target holds; any other state still delivers immediately and drains
	 * what was pending.
	 */
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

export function envelope(from: string, to: string, text: string): string {
	return `<agent-message from="${from}" to="${to}">\n${text}\n</agent-message>`;
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
	// No generation check here — that is a separate ticket.
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

// ---- inbound rate limit ------------------------------------------------------------

/** pi fleet budget: one declared sender, one receiving process. */
export const INBOUND_LIMIT = 20;
export const INBOUND_WINDOW_MS = 10_000;

/**
 * What the limit is actually about. Labels are spawner-declared and never
 * verified, and every pane on this machine shares one OS user — so the
 * bucket is local courtesy, not an identity boundary.
 */
const IDENTITY_SCOPE =
	"Identity scope: local, same OS user. The sender label is spawner-declared and never verified; panes on this machine share one OS account, so this limit is not a trust boundary.";

interface SenderBucket {
	times: number[];
	/** Refusals waiting to be named on the next aggregate receipt. */
	pending: number;
	/** When the current window's one receipt was returned. */
	lastReceiptAt?: number;
}

const buckets = new Map<string, SenderBucket>();

/** Test seam: drop every sender's window. */
export function resetInboundRateLimit(): void {
	buckets.clear();
}

/**
 * Admit one inbound send, or refuse it. A refusal is itself the aggregate
 * receipt for every refusal since the previous receipt — the refused send
 * is not delivered anywhere, so a receipt cannot spawn another refusal.
 *
 * Blocked-overlay answers do not enter here: that path is the target's
 * question, and starving it would leave the pane stuck.
 */
export function admitInbound(
	sender: string,
	now: number,
): { ok: true } | { ok: false; error: SendError } {
	const cutoff = now - INBOUND_WINDOW_MS;
	let bucket = buckets.get(sender);
	if (!bucket) {
		bucket = { times: [], pending: 0 };
		buckets.set(sender, bucket);
	}
	bucket.times = bucket.times.filter((t) => t > cutoff);
	if (bucket.times.length < INBOUND_LIMIT) {
		bucket.times.push(now);
		bucket.pending = 0;
		bucket.lastReceiptAt = undefined;
		return { ok: true };
	}
	bucket.pending += 1;
	const cooled =
		bucket.lastReceiptAt == null ||
		now - bucket.lastReceiptAt >= INBOUND_WINDOW_MS;
	if (!cooled) {
		return {
			ok: false,
			error: err(
				"RATE_LIMITED",
				`Folded into the open aggregate receipt: refused ${bucket.pending} more inbound message${bucket.pending === 1 ? "" : "s"} from "${sender}" — not delivered, and no additional receipt. Limit is ${INBOUND_LIMIT} messages per ${INBOUND_WINDOW_MS / 1000} seconds per sender. ${IDENTITY_SCOPE}`,
				{ sender, refused: bucket.pending, folded: true },
			),
		};
	}
	const refused = bucket.pending;
	bucket.pending = 0;
	bucket.lastReceiptAt = now;
	return {
		ok: false,
		error: err(
			"RATE_LIMITED",
			`Aggregate receipt: refused ${refused} inbound message${refused === 1 ? "" : "s"} from "${sender}" — not delivered. Limit is ${INBOUND_LIMIT} messages per ${INBOUND_WINDOW_MS / 1000} seconds per sender. ${IDENTITY_SCOPE}`,
			{
				sender,
				refused,
				limit: INBOUND_LIMIT,
				windowSeconds: INBOUND_WINDOW_MS / 1000,
			},
		),
	};
}

// ---- pending inbox ----------------------------------------------------------------

/**
 * How many accepted-but-not-yet-typed messages one pane holds. A pi fleet
 * is a handful of panes; eight is already a burst waiting on one busy
 * agent. Not the CC 50/100 figures.
 */
export const PENDING_CAP = 8;

interface PendingItem {
	from: string;
	text: string;
	submit: boolean;
	name?: string;
	to: string;
}

interface Inbox {
	items: PendingItem[];
	/** Dropped senders still waiting to be named on the open aggregate receipt. */
	dropped: string[];
	/** The one aggregate receipt for the current burst, returned to whoever caused it. */
	aggregate?: string;
	/** Senders who have already been shown that receipt. */
	told: Set<string>;
}

const inboxes = new Map<string, Inbox>();

/** Test seam: drop every pane's pending inbox. */
export function resetPendingInbox(): void {
	inboxes.clear();
}

function inboxFor(paneId: string): Inbox {
	let inbox = inboxes.get(paneId);
	if (!inbox) {
		inbox = { items: [], dropped: [], told: new Set() };
		inboxes.set(paneId, inbox);
	}
	return inbox;
}

function dropNotice(dropped: readonly string[], fresh: boolean): string {
	const who = dropped.map((s) => `"${s}"`).join(", ");
	const noun = dropped.length === 1 ? "message" : "messages";
	if (fresh) {
		return (
			`Aggregate receipt: dropped ${dropped.length} oldest pending ${noun} from ${who} — not delivered. ` +
			`Pending inbox holds ${PENDING_CAP}. The receiver is told on this receipt; the dropped sender is told here if they caused it, otherwise on their next call. ` +
			`already-delivered text is kept. This receipt is the call result, not a new inbound message.`
		);
	}
	return (
		`Folded into the open aggregate inbox receipt: dropped ${dropped.length} oldest pending ${noun} from ${who} — not delivered, and no additional receipt. ` +
		`Pending inbox holds ${PENDING_CAP}. The receiver is told on this receipt. already-delivered text is kept.`
	);
}

function personalDrop(sender: string, dropped: readonly string[]): string {
	const who = dropped.map((s) => `"${s}"`).join(", ");
	return (
		`Pending message from "${sender}" was dropped (oldest pending, senders ${who}) — not delivered. ` +
		`Pending inbox holds ${PENDING_CAP}; already-delivered text is kept. ` +
		`The receiver was told on the open aggregate inbox receipt; this is not a new receipt.`
	);
}

/**
 * Accept one message into the pane's pending inbox. Over the cap, the
 * oldest pending item is dropped. The first drop of a burst is the one
 * aggregate receipt; later drops in that burst fold into it. Nothing here
 * is typed into a pane, so the receipt cannot loop.
 */
function enqueuePending(paneId: string, item: PendingItem): { dropped: boolean; notice?: string } {
	const inbox = inboxFor(paneId);
	inbox.items.push(item);
	if (inbox.items.length <= PENDING_CAP) return { dropped: false };
	const oldest = inbox.items.shift();
	if (!oldest) return { dropped: false };
	inbox.dropped.push(oldest.from);
	const fresh = inbox.aggregate == null;
	inbox.aggregate = dropNotice(inbox.dropped, fresh);
	inbox.told.add(item.from);
	return { dropped: true, notice: inbox.aggregate };
}

/** Notice owed to this sender from an earlier drop, without opening a new receipt. */
function owedNotice(paneId: string, sender: string): string | undefined {
	const inbox = inboxes.get(paneId);
	if (!inbox || inbox.told.has(sender) || !inbox.dropped.includes(sender)) return undefined;
	inbox.told.add(sender);
	const notice = personalDrop(sender, inbox.dropped);
	if (inbox.items.length === 0 && inbox.dropped.every((s) => inbox.told.has(s))) {
		inboxes.delete(paneId);
	}
	return notice;
}

function clearInbox(paneId: string): PendingItem[] {
	const inbox = inboxes.get(paneId);
	if (!inbox) return [];
	const items = inbox.items;
	inbox.items = [];
	inbox.aggregate = undefined;
	// Dropped senders who have not been told yet still get the personal
	// note on their next call. Senders already told do not get another.
	if (inbox.dropped.length === 0 || inbox.dropped.every((s) => inbox.told.has(s))) {
		inboxes.delete(paneId);
	}
	return items;
}

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
	const resolved = await resolveTarget(params.target, deps);
	if (resolved.kind === "err") return { ok: false, error: resolved.error };

	const submit = params.submit !== false;
	const blocked = resolved.state === "blocked";
	// A burst is held only while the pane is idle and the caller asked to
	// queue it. Working, blocked, and done type immediately.
	const holding = resolved.state === "idle" && params.pending === true;
	const from = await senderLabel(deps);
	if (!blocked) {
		const admitted = admitInbound(from, (deps.now ?? Date.now)());
		if (!admitted.ok) return admitted;
	}

	const send = deps.send ?? sendAgentPrompt;
	const deliver = async (
		item: PendingItem,
		asAnswer: boolean,
	): Promise<Result<true>> => {
		const payload = asAnswer
			? item.text
			: envelope(item.from, item.to, item.text);
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
		return send(resolved.paneId, payload, {
			submit: item.submit,
			signal: deps.signal,
		});
	};

	const receipt = (over: Partial<MessageReceipt>): Result<MessageReceipt> => ({
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
			...over,
		},
	});

	const item: PendingItem = {
		from,
		text: params.text,
		submit,
		to: resolved.to,
		...(resolved.name ? { name: resolved.name } : {}),
	};

	// Idle: the pane has not started on this burst. Hold it. Over the cap,
	// drop the oldest pending item. The receipt stays on this call — it is
	// never typed into the pane, so it cannot loop.
	if (holding) {
		const held = enqueuePending(resolved.paneId, item);
		const notice = held.notice ?? owedNotice(resolved.paneId, from);
		return receipt({
			delivered: false,
			queued: true,
			...(notice ? { notice } : {}),
		});
	}

	// Leaving idle (done drains; working / blocked type now). Pending text
	// goes out oldest-first, then this message. Already-typed text stays.
	const waiting = clearInbox(resolved.paneId);
	for (const pending of waiting) {
		const drained = await deliver(pending, false);
		if (!drained.ok) return drained;
	}
	const r = await deliver(item, blocked);
	if (!r.ok) return r;
	return receipt({});
}

// ---- registration --------------------------------------------------------------

const DESCRIPTION =
	"Send a message to a herdr agent pane — the open channel, anyone ↔ anyone, no broker. " +
	"The target is always explicit and resolves as: exact pane-id → herdr name → spawn-registry handle " +
	"(the name herdr_spawn_agent returned). The reserved role \"orchestrator\" is only your direct parent's pane " +
	"(PI_HERDR_ORCHESTRATOR_PANE) — a live agent of that name does not take the alias; unset or a gone parent " +
	"errors honestly. Delivery is physics-adaptive: a BLOCKED " +
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
	"Over the limit, nothing is typed into the target; the error is one aggregate receipt for the refused sends, not a message back (that would loop). " +
	"A BLOCKED overlay answer does not count and is never refused by this limit. " +
	"An idle target can accept a pending burst of 8; over that, the oldest pending message is dropped and both sides hear one aggregate receipt. Already-typed text is kept.";

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
		}),
		async execute(_id, p, signal) {
			const r = await messageAgent(
				{ target: p.target, text: p.text, submit: p.submit },
				{ signal },
			);
			if (!r.ok) return fail(r.error);
			const d = r.data;
			const who = d.name ?? d.to;
			const text =
				d.delivery === "answer"
					? `Delivered to "${who}" (pane ${d.target}, state: ${d.state}) as a RAW ANSWER — typed into its question overlay, unsubmitted=${!d.submit}. If it was an option list, select with herdr_send_keys instead.`
					: `Delivered to "${who}" (pane ${d.target}, state: ${d.state}) as an <agent-message> envelope (from "${d.from}"). Fire-and-forget: delivered ≠ consumed — the reply arrives as injected <agent-message> text or its next completion (wait with herdr_get_agent_result).`;
			return { content: [{ type: "text", text }], details: d };
		},
	});
}
