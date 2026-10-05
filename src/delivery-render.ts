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
	if (body.trim().length === 0) {
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

/**
 * Fold herdr-delivery messages in the transcript.
 * pi passes `{expanded}` from the global tool-output toggle (ctrl+o →
 * InteractiveMode.setToolsExpanded → CustomMessageComponent.setExpanded).
 * Returning a component only replaces the TUI; sendMessage content is untouched.
 */
export function registerDeliveryRenderer(pi: ExtensionAPI): void {
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
}
