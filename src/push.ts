// The steer sink (v0.6 issue 14): the ONE envelope every consumer uses to
// steer a message into the orchestrator session — pi.sendMessage with the
// `herdr-delivery` custom type and the wake flags (steer/now vs nextTurn).
//
// Own module so the import graph stays acyclic: the workflow run registry
// (src/workflow/runs.ts) and the fleet widget (src/widget.ts, via runs) both
// need this, and delivery.ts imports the widget for its tick — a shared home
// under neither side keeps delivery → widget → runs → delivery from closing.
// delivery.ts re-exports for compatibility.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrSettings } from "./settings.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DeliveryLedger, type EventReference } from "./delivery-ledger.js";
import { assertDeliveryDispatchOptions, registerDeliveryMessageGate } from "./delivery-host.js";

/** How a push enters the orchestrator session. */
export type DeliverAs = "steer" | "followUp" | "nextTurn";

/** One steered message (tests capture these through the injected sink). */
export interface SteeredMessage {
	content: string;
	details: Record<string, unknown>;
	/** true → wake the orchestrator now; false → next natural turn. */
	wake: boolean;
	/**
	 * Explicit delivery. Unset keeps the historical mapping: wake → steer,
	 * no wake → nextTurn. `followUp` queues until the current run ends and
	 * does not cancel a tool that is already running.
	 */
	deliverAs?: DeliverAs;
}

type PendingAcknowledgement = { token: string; at: number };
const pendingSessionsKey = Symbol.for("pi-herdr.pending-delivery-acknowledgements");
const pendingHost = globalThis as typeof globalThis & {
	[pendingSessionsKey]?: Map<string, Map<string, PendingAcknowledgement>>;
};
const pendingSessions = pendingHost[pendingSessionsKey] ??= new Map();
const gatedHosts = new WeakSet<object>();
const hostBoundaries = new WeakMap<object, { allowCommit(details: Record<string, unknown>): boolean }>();
const parentSinks = new WeakMap<object, (msg: SteeredMessage) => void>();
export function rememberParentDeliverySink(pi: ExtensionAPI, sink: (msg: SteeredMessage) => void): void {
	parentSinks.set(pi, sink);
}

/**
 * Build the steer sink for a session: pi.sendMessage with delivery's exact
 * envelope (`herdr-delivery`, wake → steer/nextTurn flags). ONE factory so
 * every consumer (the delivery loop, the workflow run's completion report)
 * cannot drift apart.
 */
export function makeDeliverySink(
	pi: ExtensionAPI,
	confirmation?: { getBranch(): readonly unknown[]; getSessionFile?: () => string | undefined; now?: () => number; timeoutMs?: number },
	boundary?: { allowCommit(details: Record<string, unknown>): boolean },
): (msg: SteeredMessage) => void {
	if (boundary) hostBoundaries.set(pi, boundary);
	if (!confirmation && !boundary) {
		const governed = parentSinks.get(pi);
		if (governed) return governed;
	}
	let getBranch = confirmation?.getBranch;
	let getSessionFile = confirmation?.getSessionFile;
	let lastKnownHostFile: string | undefined;
	const hasDurableEvent = (eventId: unknown): boolean => {
		if (typeof eventId !== "string" || !getSessionFile) return false;
		const file = getSessionFile();
		if (!file) return false;
		try {
			return readFileSync(file, "utf8").split("\n").some(line => {
				if (line === "") return false;
				const row = JSON.parse(line);
				return row.type === "custom_message" && row.customType === "herdr-delivery" && row.details?.eventId === eventId;
			});
		} catch { return false; }
	};
	const confirmed = (token: string): boolean => {
		const matches = (entry: unknown): boolean => {
			const row = entry as { type?: string; customType?: string; details?: { deliveryToken?: string } };
			return row.type === "custom_message" && row.customType === "herdr-delivery" && row.details?.deliveryToken === token;
		};
		if (getSessionFile) {
			const file = getSessionFile();
			if (!file) return false;
			try { return readFileSync(file, "utf8").split("\n").some(line => line !== "" && matches(JSON.parse(line))); }
			catch { return false; }
		}
		return getBranch?.().some(matches) ?? false;
	};
	let pending = new Map<string, PendingAcknowledgement>();
	const selectPendingSession = (): void => {
		const file = getSessionFile?.();
		if (!file) return; // Unknown session/queue outcome must not release a token.
		let sessionPending = pendingSessions.get(file);
		if (!sessionPending) {
			sessionPending = new Map();
			pendingSessions.set(file, sessionPending);
		}
		pending = sessionPending;
		// Migration cannot depend on the latest body formatting matching the old key.
		for (const [key, acknowledgement] of sessionPending) {
			let fields: unknown[];
			try { fields = JSON.parse(key); } catch { continue; }
			const eventId = fields[0];
			if (typeof eventId === "string") new DeliveryLedger(file).migratePending({ eventId, sessionPath: typeof fields[1] === "string" ? fields[1] : undefined }, acknowledgement.token);
		}
	};
	selectPendingSession();
	if (typeof pi.on === "function" && !gatedHosts.has(pi)) {
		gatedHosts.add(pi);
		registerDeliveryMessageGate(pi, {
			owns: details => Boolean(details.delivery && typeof details.delivery === "object") || (typeof details.eventId === "string" && typeof details.deliveryToken === "string"),
			allow: (details, ctx) => {
				const file = ctx.sessionManager.getSessionFile();
				if (!file) return false;
				const ledger = new DeliveryLedger(file);
				const proof = details.delivery as { hostFile?: string; eventId?: string; token?: string; channel?: string } | undefined;
				if (!proof) {
					if (typeof details.eventId !== "string" || typeof details.deliveryToken !== "string") return false;
					ledger.migratePending({ eventId: details.eventId, sessionPath: details.sessionPath as string | undefined }, details.deliveryToken);
					// Unknown legacy queue outcomes stay pending for review; never unlock or replay.
					return false;
				}
				if (proof.hostFile !== file || !proof.eventId || !proof.token || proof.channel !== "push") return false;
				const currentBoundary = hostBoundaries.get(pi);
				if (currentBoundary && !currentBoundary.allowCommit(details)) {
					ledger.deferPush(proof.eventId, proof.token);
					return false;
				}
				return ledger.claimPush(proof.eventId, proof.token);
			},
		});
	}
	pi.on?.("session_start", (_event, ctx) => {
		getBranch = () => ctx.sessionManager.getBranch();
		getSessionFile = () => ctx.sessionManager.getSessionFile();
		selectPendingSession();
	});
	return (msg: SteeredMessage): void => {
		try {
			selectPendingSession();
			const currentFile = getSessionFile?.();
			if (currentFile) lastKnownHostFile = currentFile;
			const hostFile = currentFile ?? lastKnownHostFile;
			const eventId = msg.details.eventId;
			if (typeof eventId === "string" && msg.details.agentId && msg.details.runId) {
				if (!hostFile || typeof pi.on !== "function") throw new Error("durable completion push requires a receiver host and message_end hook");
				readFileSync(hostFile, "utf8"); // Production stable-identity events never downgrade on unknown host evidence.
			}
			if (hostFile && typeof eventId === "string" && typeof pi.on === "function") {
				const ledger = new DeliveryLedger(hostFile);
				const ref: EventReference = { eventId, agentId: msg.details.agentId as string | undefined, runId: msg.details.runId as string | undefined, sequence: msg.details.sequence as number | undefined, sessionPath: msg.details.sessionPath as string | undefined };
				const claim = ledger.queuePush(ref);
				if (!claim.bodyAllowed) {
					if (claim.record.status === "delivered" || claim.record.status === "acked") return;
					throw new Error(`delivery pending durable confirmation; outcome unknown (${claim.record.status}); no timeout retry; original token remains pending`);
				}
				const proof = ledger.proof(claim.record);
				const deliverAs: DeliverAs = msg.deliverAs ?? (msg.wake ? "steer" : "nextTurn");
				assertDeliveryDispatchOptions({ triggerTurn: deliverAs !== "nextTurn", deliverAs });
				try {
					pi.sendMessage({ customType: "herdr-delivery", content: msg.content, display: true, details: { ...msg.details, deliveryToken: proof.token, delivery: proof } }, { triggerTurn: deliverAs !== "nextTurn", deliverAs });
				} catch (error) {
					// The void extension binding cannot prove a thrown adapter rejected before enqueue.
					if ((error as { deliveryOutcome?: string })?.deliveryOutcome === "not-submitted") ledger.reject(eventId, proof.token, String(error));
					else ledger.uncertain(eventId, proof.token, String(error));
					throw error;
				}
				const submitted = ledger.reconcile(eventId);
				if (submitted?.status !== "delivered" && submitted?.status !== "acked") throw new Error("delivery pending durable confirmation; SDK accepted but host commit unconfirmed");
				return;
			}
			const key = JSON.stringify([msg.details.eventId, msg.details.sessionPath, msg.details.name, msg.details.kind, msg.content]);
			const now = (confirmation?.now ?? Date.now)();
			const existing = pending.get(key);
			if (hasDurableEvent(msg.details.eventId)) return;
			if (existing) {
				if (confirmed(existing.token)) return;
				if (now - existing.at >= (confirmation?.timeoutMs ?? 30_000)) {
					throw new Error("delivery confirmation timeout; outcome unknown, original token remains pending");
				}
				throw new Error("delivery pending durable confirmation");
			}
			const token = randomUUID();
			if (getBranch) pending.set(key, { token, at: now });
			const deliverAs: DeliverAs =
				msg.deliverAs ?? (msg.wake ? "steer" : "nextTurn");
			try {
				pi.sendMessage(
					{
						customType: "herdr-delivery",
						content: msg.content,
						display: true,
						details: getBranch ? { ...msg.details, deliveryToken: token } : msg.details,
					},
					{
						triggerTurn: deliverAs !== "nextTurn",
						deliverAs,
					},
				);
			} catch (error) {
				// A synchronous dispatch rejection did not enqueue. Only this
				// definite failure releases the token; async void outcomes and
				// confirmation timeouts retain it to avoid duplicate delivery.
				pending.delete(key);
				throw error;
			}
			if (getBranch) {
				if (!confirmed(token)) throw new Error("delivery pending durable confirmation");
			}
		} catch (err) {
			// Surface the failure. Callers that recycle a pane (orphan
			// delivery) must see a rejected push and leave the pane open.
			throw err instanceof Error ? err : new Error(String(err));
		}
	};
}

/**
 * Busy bit for this session. Pi's ExtensionAPI does not expose `isIdle`, so
 * the loop tracks the same edges the session uses: a run is busy from
 * `agent_start` until `agent_settled` (tools included — followUp waits for
 * that settle and does not abort them), and compaction is busy from
 * `session_before_compact` until it succeeds or fails. No event yet means
 * idle, which keeps the historical steer path.
 */
let orchestratorSessionPath: string | undefined;

/** This process's session file, once `session_start` has fired. */
export function currentOrchestratorSession(): string | undefined {
	return orchestratorSessionPath;
}

/** Remember the session file the delivery loop is running inside. */
export function rememberOrchestratorSession(pi: ExtensionAPI): void {
	if (typeof pi.on !== "function") return;
	pi.on("session_start", (_event, ctx) => {
		const file = ctx?.sessionManager?.getSessionFile?.();
		if (typeof file === "string" && file.trim()) orchestratorSessionPath = file;
	});
}

export function trackOrchestratorBusy(pi: ExtensionAPI): () => boolean {
	let running = false;
	let compacting = false;
	if (typeof pi.on !== "function") return () => false;
	pi.on("agent_start", () => {
		running = true;
	});
	pi.on("agent_settled", () => {
		running = false;
	});
	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});
	return () => running || compacting;
}

/** The wake flags for a terminal push under the notifications setting. */
export function terminalWake(
	notes: HerdrSettings["notifications"],
): SteeredMessage["wake"] {
	return notes !== "quiet"; // normal → wake; quiet → next turn; none → never reaches a push
}
