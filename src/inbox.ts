import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { herdr } from "./herdr.js";
import { randomUUID } from "node:crypto";
export { readQueueOnlyInbox, acknowledgeQueueOnlyInbox, enqueueQueueOnlyInbox, registerQueueOnlyReceiver } from "./queue-only-inbox.js";

export interface InboundMessage {
	from: string;
	to: string;
	body: string;
	eventId?: string;
	text: string;
}
export interface InboxReceipt {
	id: string;
	kind: "rate-limited" | "dropped" | "delivery-failed";
	senders: string[];
	count: number;
	text: string;
	/** Only these senders need the aggregate receipt sent to their pane. */
	notify: string[];
	receiver: boolean;
}
export interface ReceiverInboxDeps {
	now?: () => number;
	/** QueueOnly accepts are durably written by the caller before receive(). */
	persist?: (message: InboundMessage) => void | Promise<void>;
	deliver: (message: InboundMessage) => void | Promise<void>;
	receipt: (receipt: InboxReceipt) => void | Promise<void>;
}
const SCOPE = "Identity scope: local, same OS user; sender labels are spawner-declared and never verified, not a trust boundary.";
export const INBOUND_LIMIT = 20;
export const INBOUND_WINDOW_MS = 10_000;
export const PENDING_CAP = 8;

/** One instance belongs to one receiving session, across all senders. */
export function createReceiverInbox(deps: ReceiverInboxDeps) {
	let busy = false;
	let serial = Promise.resolve();
	let sequence = 0;
	const pending: InboundMessage[] = [];
	const buckets = new Map<string, { times: number[]; receipt?: InboxReceipt }>();
	let drops: InboxReceipt | undefined;
	const emit = async (kind: InboxReceipt["kind"], sender: string, aggregate?: InboxReceipt) => {
		const fresh = !aggregate;
		const r = aggregate ?? { id: `inbox-${++sequence}`, kind, senders: [], count: 0, text: "", notify: [], receiver: true };
		r.count++;
		const notify = r.senders.includes(sender) ? [] : [sender];
		if (notify.length) r.senders.push(sender);
		r.text = `Aggregate receipt ${r.id}: ${r.kind}, ${r.count} message(s) from ${r.senders.join(", ")} not delivered. Limit ${INBOUND_LIMIT}/10s per sender; pending cap ${PENDING_CAP}, oldest pending dropped; already-delivered text kept. Further losses fold into this receipt. ${SCOPE}`;
		if (fresh || notify.length) await deps.receipt({ ...r, senders: [...r.senders], notify, receiver: fresh });
		return r;
	};
	const run = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = serial.then(fn);
		serial = result.then(() => {}, () => {});
		return result;
	};
	const drain = async () => {
		while (!busy && pending.length) {
			const message = pending[0];
			try { await deps.deliver(message); }
			catch (error) {
				await deps.receipt({ id: `inbox-${++sequence}`, kind: "delivery-failed", senders: [message.from], notify: [message.from], count: 1, receiver: true,
					text: `Inbox delivery failed; retained pending message from ${message.from}: ${String(error)}. ${SCOPE}` });
				throw error;
			}
			pending.shift();
		}
		if (!pending.length) drops = undefined;
	};
	return {
		setBusy(value: boolean) { busy = value; },
		receive(message: InboundMessage) {
			return run(async () => {
				const now = (deps.now ?? Date.now)();
				let bucket = buckets.get(message.from);
				if (!bucket) { bucket = { times: [] }; buckets.set(message.from, bucket); }
				bucket.times = bucket.times.filter(t => t > now - INBOUND_WINDOW_MS);
				if (!bucket.times.length) bucket.receipt = undefined;
				if (bucket.times.length >= INBOUND_LIMIT) {
					bucket.receipt = await emit("rate-limited", message.from, bucket.receipt);
					return "refused" as const;
				}
				if (deps.persist) {
					await deps.persist(message);
					bucket.times.push(now);
					return "pending" as const;
				}
				bucket.times.push(now);
				pending.push(message);
				if (pending.length > PENDING_CAP) {
					const oldest = pending.shift()!;
					drops = await emit("dropped", oldest.from, drops);
				}
				await drain();
				return busy ? "pending" as const : "delivered" as const;
			});
		},
		settle() { busy = false; return run(drain); },
	};
}

export interface ReceiverInputAdapter {
	parse: (text: string) => Omit<InboundMessage, "text"> | undefined;
	/** Return handled for a completion; continue for an ordinary message. */
	deliver: (pi: ExtensionAPI, event: InputEvent, ctx: ExtensionContext) => InputEventResult | Promise<InputEventResult>;
}

/** Single input owner: receipts bypass both admission and the conversational queue. */
export function registerReceiverInbox(pi: ExtensionAPI, adapter: ReceiverInputAdapter): void {
	let context: ExtensionContext | undefined;
	const internalInputs = new Map<string, string>();
	const report = (error: unknown) => context?.ui.notify(`herdr inbox: ${String(error)}`, "error");
	const makeInbox = () => createReceiverInbox({
		deliver: async message => {
			if (!context) throw new Error("receiver context unavailable");
			const result = await adapter.deliver(pi, { type: "input", text: message.text, source: "interactive", images: undefined }, context);
			if (result.action !== "handled") {
				const watermark = `<herdr-internal-${randomUUID()}>\n${message.text}`;
				internalInputs.set(watermark, message.text);
				try { pi.sendUserMessage(watermark, { deliverAs: "followUp" }); }
				catch (error) { internalInputs.delete(watermark); throw error; }
			}
		},
		receipt: async receipt => {
			if (receipt.receiver) pi.sendMessage({ customType: "herdr-inbox-receipt", content: receipt.text, display: true, details: receipt }, { triggerTurn: false, deliverAs: "nextTurn" });
			const failures: string[] = [];
			for (const sender of receipt.notify) {
				// Separate envelope: never re-admitted as an agent-message, never answered.
				const r = await herdr(["agent", "prompt", sender, `<agent-receipt>\n${receipt.text}\n</agent-receipt>`], { timeoutMs: 10_000 });
				if (!r.ok) failures.push(`${sender}: ${r.error.message}`);
			}
			if (failures.length) {
				const text = `Inbox receipt delivery failed: ${failures.join("; ")}`;
				pi.sendMessage({ customType: "herdr-inbox-receipt", content: text, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
				report(text);
			}
		},
	});
	let inbox = makeInbox();
	pi.on("session_start", (_event, ctx) => { context = ctx; inbox = makeInbox(); });
	pi.on("input", async (event, ctx) => {
		context = ctx;
		if (event.source === "extension" && internalInputs.has(event.text)) {
			const text = internalInputs.get(event.text)!;
			internalInputs.delete(event.text);
			return { action: "transform", text, images: event.images };
		}
		const receipt = /^<agent-receipt>\n([\s\S]*)\n<\/agent-receipt>$/.exec(event.text);
		if (receipt) {
			pi.sendMessage({ customType: "herdr-inbox-receipt", content: receipt[1], display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
			return { action: "handled" };
		}
		const parsed = adapter.parse(event.text);
		if (!parsed) return { action: "continue" };
		try { await inbox.receive({ ...parsed, text: event.text }); }
		catch (error) { report(error); }
		return { action: "handled" };
	});
	pi.on("agent_start", (_event, ctx) => { context = ctx; inbox.setBusy(true); });
	pi.on("agent_settled", async (_event, ctx) => { context = ctx; try { await inbox.settle(); } catch (error) { report(error); } });
}
