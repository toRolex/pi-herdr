import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
type HostCustomMessage = Extract<MessageEndEvent["message"], { role: "custom" }>;

export type HostDeliveryMode = "steer" | "followUp" | "nextTurn";
export type HostMessage = {
	customType: string;
	content: unknown;
	display: boolean;
	details?: Record<string, unknown>;
};
export interface HostReceipt {
	status: "persisted" | "absent" | "unknown";
	durability: "jsonl-readback-no-fsync";
	entry?: Record<string, unknown>;
	/** A persisted empty withdrawal is not acknowledgement that the push body was delivered. */
	withdrawn?: boolean;
	reason?: string;
}

type SessionFile = () => string | undefined;

/** Reject SDK context-only appends, which do not dispatch the extension message_end gate. */
export function assertDeliveryDispatchOptions(options: { deliverAs?: string; triggerTurn?: boolean }): void {
	if (options.deliverAs === "nextTurn") return;
	if ((options.deliverAs === "steer" || options.deliverAs === "followUp") && options.triggerTurn === true) return;
	throw new Error("governed delivery requires nextTurn or explicit wake steer/followUp; context-only append bypasses message_end arbitration");
}

/**
 * Public host seam: redact an owned push at message_end, before model request and append.
 * This is body withdrawal, NOT queue cancellation: message_start may already expose the body.
 * Later extension handlers can replace it again; registration order is a host trust boundary.
 */
export function registerDeliveryMessageGate(pi: ExtensionAPI, options: {
	owns(details: Record<string, unknown>, ctx: ExtensionContext): boolean;
	allow(details: Record<string, unknown>, ctx: ExtensionContext): boolean | Promise<boolean>;
	onError?: (error: unknown) => void;
}): () => void {
	return installQueuedDeliveryArbitration(pi, {
		arbitrate: (message, ctx) => {
			const details = message.details as Record<string, unknown> | undefined;
			if (!details || !options.owns(details, ctx)) return undefined;
			return options.allow(details, ctx);
		},
		onError: options.onError,
	});
}

/** undefined leaves unrelated delivery alone; true commits body; false withdraws body. */
export function installQueuedDeliveryArbitration(pi: ExtensionAPI, options: {
	arbitrate(message: HostCustomMessage, ctx: ExtensionContext): boolean | undefined | Promise<boolean | undefined>;
	onError?: (error: unknown) => void;
}): () => void {
	return pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (!message || message.role !== "custom" || message.customType !== "herdr-delivery") return;
		const details = message.details as Record<string, unknown> | undefined ?? {};
		let allowed = false;
		try {
			const decision = await options.arbitrate(message, ctx);
			if (decision === undefined) return;
			allowed = decision === true;
		} catch (error) {
			// ExtensionRunner otherwise swallows handler errors and persists the old body.
			try { options.onError?.(error); } catch { /* Reporting must not release the old body. */ }
		}
		if (allowed) return { message: {
			...message,
			details: { ...details, deliveryHostBodyCommitted: true },
		} };
		// Metadata can contain a second copy of the old body (result/message/error).
		// Keep only identity/audit fields; never propagate arbitrary rejected payload.
		const receiptDetails: Record<string, unknown> = { deliveryHostWithdrawn: true };
		if (typeof details.eventId === "string") receiptDetails.eventId = details.eventId;
		if (typeof details.deliveryToken === "string") receiptDetails.deliveryToken = details.deliveryToken;
		return { message: {
			role: "custom",
			customType: "herdr-delivery",
			content: [],
			display: false,
			details: receiptDetails,
			timestamp: message.timestamp,
		} };
	});
}

/** A readable JSONL record is not a power-loss-safe commit: the SDK does not fsync. */
function inspectReceipt(getSessionFile: SessionFile, matches: (row: Record<string, unknown>) => boolean): HostReceipt {
	const durability = "jsonl-readback-no-fsync" as const;
	try {
		const file = getSessionFile();
		if (!file) return { status: "unknown", durability, reason: "session file unavailable" };
		const content = readFileSync(file, "utf8");
		// An interrupted append may leave a partial last line. Do not mistake it for absence.
		if (content && !content.endsWith("\n")) return { status: "unknown", durability, reason: "incomplete JSONL tail" };
		const rows = content.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		const entry = rows.find(matches);
		return entry ? { status: "persisted", durability, entry } : { status: "absent", durability };
	} catch (error) {
		return { status: "unknown", durability, reason: error instanceof Error ? error.message : String(error) };
	}
}

export function inspectDeliveryReceipt(getSessionFile: SessionFile, token: string): HostReceipt {
	const receipt = inspectReceipt(getSessionFile, row => row.type === "custom_message" && row.customType === "herdr-delivery" &&
		(row.details as Record<string, unknown> | undefined)?.deliveryToken === token);
	if (receipt.entry) receipt.withdrawn = (receipt.entry.details as Record<string, unknown> | undefined)?.deliveryHostWithdrawn === true;
	if (receipt.withdrawn) {
		receipt.status = "absent";
		receipt.reason = "withdrawal receipt exists, but no committed push body";
	}
	return receipt;
}

/** tool_result and message_end extension events happen BEFORE SessionManager append. */
export function inspectToolResultReceipt(
	getSessionFile: SessionFile,
	toolCallId: string,
	matches: (message: Record<string, unknown>) => boolean = () => true,
): HostReceipt {
	return inspectReceipt(getSessionFile, row => {
		const message = row.message as Record<string, unknown> | undefined;
		return row.type === "message" && message?.role === "toolResult" && message.toolCallId === toolCallId && matches(message);
	});
}

