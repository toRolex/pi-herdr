import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SteeredMessage } from "./push.js";
import type { HerdrSettings } from "./settings.js";
import { DeliveryLedger } from "./delivery-ledger.js";
import { ParentNotifyStore, pendingMessageKey } from "./parent-notify-store.js";

type Phase = "finished" | "busy" | "closing" | "natural";

/** Admission is durable; actual body commitment remains governed by the public SDK message_end gate. */
export function registerParentDelivery(pi: ExtensionAPI, dispatch: (msg: SteeredMessage) => void,
	notifications: () => HerdrSettings["notifications"],
) {
	let phase: Phase = "finished";
	let run = randomUUID();
	let hostFile: string | undefined;
	const transient = new Map<string, SteeredMessage>();
	const store = () => hostFile ? new ParentNotifyStore(hostFile) : undefined;
	const items = () => store()?.pending().map(message => ({ key: pendingMessageKey(message), message })) ?? [...transient].map(([key, message]) => ({ key, message }));
	const flush = (natural: boolean, subscriptionId?: string, selectedKey?: string, wakeExpiresAt?: number): void => {
		if (notifications() === "none" || (!natural && notifications() !== "normal")) return;
		for (const { key, message } of items()) {
			if (selectedKey && key !== selectedKey) continue;
			// Non-completion notices need a receiver-owned queue identity too; this is not a child run ID.
			const eventId = typeof message.details.eventId === "string" ? message.details.eventId : `parent-notice:${key}`;
			if (hostFile) {
				const record = new DeliveryLedger(hostFile).reconcile(eventId);
				if (record?.status === "delivered" || record?.status === "acked") { store()?.remove(key); continue; }
			}
			try {
				dispatch({ ...message, wake: !natural, deliverAs: natural ? "nextTurn" : "steer",
					details: { ...message.details, eventId, deliveryParentRun: run, deliveryNaturalRun: natural, ...(subscriptionId ? { deliveryWakeSubscription: subscriptionId, deliveryWakeExpiresAt: wakeExpiresAt } : {}) } });
			} catch (error) {
				// Accepted SDK queue is not an ACK. The ledger owns unknown/pending outcomes.
				if (!(error instanceof Error) || !error.message.includes("pending durable confirmation")) throw error;
			}
		}
	};
	if (typeof pi.on !== "function") return { phase: () => phase, allowCommit: () => false, accept: dispatch };
	pi.on("session_start", (_event, ctx) => {
		hostFile = ctx.sessionManager.getSessionFile();
		phase = "finished";
	});
	pi.on("before_agent_start", () => {
		run = randomUUID();
		phase = "natural";
		flush(true);
	});
	pi.on("agent_start", () => { if (phase !== "natural") { run = randomUUID(); phase = "busy"; } });
	pi.on("message_start", event => { if (event.message.role === "assistant") phase = "busy"; });
	pi.on("message_end", event => {
		if (event.message.role !== "assistant") return;
		const toolCalls = event.message.content.some(block => block.type === "toolCall");
		if (!toolCalls) phase = "closing";
	});
	pi.on("turn_end", event => {
		// toolResults do not expose the SDK terminate hint. Never manufacture a
		// continuation merely because a tool batch finished; hold for a natural run.
		if (!event.toolResults.length) phase = "closing";
	});
	pi.on("agent_settled", () => { phase = "finished"; });
	pi.on("session_before_compact", () => { phase = "busy"; });
	pi.on("session_shutdown", () => { phase = "finished"; });
	return {
		phase: () => phase,
		allowCommit(details: Record<string, unknown>): boolean {
			const policy = notifications();
			if (policy === "none" || (policy === "quiet" && details.deliveryNaturalRun !== true)) return false;
			if (details.deliveryWakeSubscription && (typeof details.deliveryWakeExpiresAt !== "number" || details.deliveryWakeExpiresAt <= Date.now())) return false;
			return details.deliveryParentRun === run && phase === "natural";
		},
		accept(message: SteeredMessage): void {
			const saved = store();
			if (hostFile && typeof message.details.eventId === "string") {
				const status = new DeliveryLedger(hostFile).reconcile(message.details.eventId)?.status;
				if (status === "delivered" || status === "acked") return;
			}
			const key = saved ? saved.put(message) : pendingMessageKey(message);
			if (!saved) transient.set(key, message);
			if (phase !== "finished" || notifications() !== "normal") return;
			const subscription = (message.details.kind === "done" || message.details.kind === "error" || message.details.kind === "gone" || message.details.kind === "start-error")
				? saved?.matching(message.details, notifications())[0] : undefined;
			if (!subscription) return;
			// Persist consumption before dispatch: crash cannot re-arm a one-shot authorization.
			if (!saved!.consume(subscription.id)) return;
			phase = "natural";
			flush(false, subscription.id, key, subscription.expiresAt);
		},
	};
}
