import { randomUUID } from "node:crypto";
import type { CustomMessageEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SteeredMessage } from "./push.js";
import type { DeliveryProof } from "./delivery-ledger.js";
import type { HerdrSettings } from "./settings.js";
import { DeliveryLedger } from "./delivery-ledger.js";
import { ParentNotifyStore, pendingMessageKey } from "./parent-notify-store.js";

type Phase = "finished" | "busy" | "closing" | "natural";

/** Durable admission; commits use message_end or SDK durable turn_end drafts, never forced continuation. */
export function registerParentDelivery(pi: ExtensionAPI, dispatch: (msg: SteeredMessage) => void,
	notifications: () => HerdrSettings["notifications"],
) {
	let phase: Phase = "finished";
	let run = randomUUID();
	let hostFile: string | undefined;
	const transient = new Map<string, SteeredMessage>();
	const finalizedTools = new Map<string, { terminate: boolean }>();
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
	pi.on("tool_execution_end", event => {
		if (!event.parentToolCallId) finalizedTools.set(event.toolCallId, { terminate: event.result.terminate === true });
	});
	pi.on("turn_end", (event, ctx) => {
		const tools = event.toolResults.map(result => finalizedTools.get(result.toolCallId));
		const calls = event.message.role === "assistant" ? event.message.content.filter(block => block.type === "toolCall") : [];
		const completeBatch = calls.length > 0 && calls.length === event.toolResults.length &&
			calls.every(call => event.toolResults.some(result => result.toolCallId === call.id)) && tools.every(Boolean);
		finalizedTools.clear();
		// Only the final tool results establish natural continuation. Missing information,
		// all-terminate batches, aborted turns and final answers never authorize a new request.
		if (!completeBatch || tools.every(tool => tool?.terminate)) { phase = "closing"; return; }
		if (event.outcome !== "completed" || ctx.signal?.aborted || phase !== "busy" || notifications() !== "normal" || !hostFile) return;
		const ledger = new DeliveryLedger(hostFile);
		const drafts: CustomMessageEntryDraft[] = [];
		for (const { key, message } of items()) {
			const eventId = typeof message.details.eventId === "string" ? message.details.eventId : `parent-notice:${key}`;
			let proof: DeliveryProof | undefined;
			try {
				const claim = ledger.queuePush({ eventId, agentId: message.details.agentId as string | undefined,
					runId: message.details.runId as string | undefined, sequence: message.details.sequence as number | undefined,
					sessionPath: message.details.sessionPath as string | undefined });
				if (!claim.bodyAllowed) {
					if (claim.record.status === "delivered" || claim.record.status === "acked") store()?.remove(key);
					continue;
				}
				proof = ledger.proof(claim.record);
				if (!ledger.claimPush(eventId, proof.token)) continue;
				drafts.push({ type: "custom_message", customType: "herdr-delivery", content: message.content, display: true,
					details: { ...message.details, eventId, deliveryToken: proof.token, delivery: proof,
						deliveryParentRun: run, deliveryNaturalRun: false, deliveryHostBoundary: "turn_end", deliveryHostBodyCommitted: true } });
			} catch (error) {
				// Preserve earlier drafts. This body's draft has not been handed to SDK;
				// a token-matched empty receipt proves rejection even if ledger writes still fail.
				if (proof) drafts.push({ type: "custom_message", customType: "herdr-delivery", content: [], display: false,
					details: { eventId, deliveryToken: proof.token, deliveryHostWithdrawn: true, deliveryHostBoundary: "turn_end" } });
				console.error(`[herdr] turn_end delivery ${eventId} deferred after persistence failure: ${String(error)}`);
			}
		}
		// SDK persists drafts after this handler, before its already-selected natural request.
		// Do not set continue: true or send/steer/followUp; terminate must remain the SDK's decision.
		return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
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
