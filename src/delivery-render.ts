import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** customType pushed by makeDeliverySink and rendered here. */
export const HERDR_DELIVERY_CUSTOM_TYPE = "herdr-delivery";

/** Display fold for a herdr-delivery custom message. `content` is unchanged. */
export interface DeliveryDisplayMessage {
	content?: string | ReadonlyArray<{ type?: string; text?: string }>;
	details?: unknown;
}

/** One display string. Collapsed is a single summary line; expanded is the body. */
export function renderDeliveryDisplay(
	message: DeliveryDisplayMessage,
	expanded: boolean,
): string {
	const body = deliveryBody(message);
	if (expanded) return body;
	const details = recordDetails(message.details);
	const name = stringField(details?.name) ?? "unknown";
	const kind = stringField(details?.kind) ?? "unknown";
	if (body.trim().length === 0 || body.includes("holds no assistant message")) {
		return `herdr-delivery · ${name} · ${kind} · empty result`;
	}
	return `herdr-delivery · ${name} · ${kind} · ${body.length} chars`;
}

function deliveryBody(message: DeliveryDisplayMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function recordDetails(
	details: unknown,
): { name?: unknown; kind?: unknown } | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	return details as { name?: unknown; kind?: unknown };
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Live <agent-message> custom type. Completion stays herdr-delivery. */
export const HERDR_AGENT_MESSAGE_CUSTOM_TYPE = "herdr-agent-message";

/** One transcript row the presentation merge can see. */
export interface NoticeEntry {
	role?: string;
	customType?: string;
	content?: string | ReadonlyArray<{ type?: string; text?: string }>;
	display?: boolean;
	details?: unknown;
}

function noticeOf(entry: object): NoticeEntry | undefined {
	const row = entry as NoticeEntry & { message?: NoticeEntry };
	if (row.customType) return row;
	if (row.message && typeof row.message === "object" && row.message.customType) {
		return row.message;
	}
	return undefined;
}

function eventIdOf(entry: NoticeEntry): string | undefined {
	if (entry.customType !== HERDR_DELIVERY_CUSTOM_TYPE &&
		entry.customType !== HERDR_AGENT_MESSAGE_CUSTOM_TYPE) {
		return undefined;
	}
	const details = recordDetails(entry.details);
	return stringField((details as { eventId?: unknown } | undefined)?.eventId);
}

/**
 * Present one notice per business event. A live agent-message and the
 * terminal completion that share `details.eventId` collapse to the
 * completion, whichever arrived first. Rows without that id (progress,
 * takeover, blocked) stay. Idempotent, so a reload of the same transcript
 * does not grow a second copy. Content of what remains is unchanged.
 */
export function presentNotices<T extends NoticeEntry>(entries: readonly T[]): T[] {
	const completionIds = new Set<string>();
	for (const entry of entries) {
		if (entry.customType !== HERDR_DELIVERY_CUSTOM_TYPE) continue;
		const id = eventIdOf(entry);
		if (id) completionIds.add(id);
	}
	return entries.filter((entry) => {
		if (entry.customType !== HERDR_AGENT_MESSAGE_CUSTOM_TYPE) return true;
		const id = eventIdOf(entry);
		return !(id && completionIds.has(id));
	});
}

/**
 * Fold herdr-delivery messages in the transcript.
 * pi passes `{expanded}` from the global tool-output toggle (ctrl+o →
 * InteractiveMode.setToolsExpanded → CustomMessageComponent.setExpanded).
 * Returning a component only replaces the TUI; sendMessage content is untouched.
 */
/** Session view the merge reads. Tests inject a fixed branch. */
export interface NoticeSession {
	getBranch(): readonly object[];
}

/**
 * Fold herdr-delivery messages in the transcript, and hide a live
 * agent-message once the completion that shares its eventId is on the
 * branch. pi passes `{expanded}` from the global tool-output toggle.
 * Returning a component only replaces the TUI; sendMessage content is
 * untouched. Returning undefined leaves pi's default custom view, which is
 * how a not-yet-paired live message stays visible.
 */
export function registerDeliveryRenderer(
	pi: ExtensionAPI,
	session: NoticeSession,
): void {
	// Hosts and test doubles older than the renderer API simply show the
	// default custom-message view. The fold is display-only.
	if (typeof pi.registerMessageRenderer !== "function") return;
	pi.registerMessageRenderer(
		HERDR_DELIVERY_CUSTOM_TYPE,
		(message, { expanded, outputPad }, theme) => {
			const text = renderDeliveryDisplay(message, expanded);
			const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
			box.addChild(new Text(theme.fg("customMessageText", text), 0, 0));
			return box;
		},
	);
	pi.registerMessageRenderer(
		HERDR_AGENT_MESSAGE_CUSTOM_TYPE,
		(message, _options, theme) => {
			const branch = session.getBranch() as NoticeEntry[];
			const shown = presentNotices(
				branch.includes(message) ? branch : [...branch, message],
			);
			// Hidden half of a pair: an empty component draws nothing. A live
			// message that is still the only copy falls through to pi's default.
			if (!shown.includes(message)) {
				return new Box(0, 0, (line) => theme.bg("customMessageBg", line));
			}
			return undefined;
		},
	);
}
