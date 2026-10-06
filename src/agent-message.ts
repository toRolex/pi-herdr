import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { validEventId } from "./completion-event.js";

export interface AgentMessageEnvelope { from: string; to: string; body: string; eventId?: string }
/** Full terminal envelope only. Ordinary progress may be parsed but has no event ID. */
export function parseAgentMessage(text: string): AgentMessageEnvelope | undefined {
	const match = /^<agent-message from="([^"<>\r\n]+)" to="([^"<>\r\n]+)"(?: event="([^"<>\r\n]+)")?>\n?([\s\S]*?)\n?<\/agent-message>$/.exec(text);
	if (!match || (match[3] !== undefined && !validEventId(match[3]))) return undefined;
	return { from: match[1], to: match[2], body: match[4], ...(match[3] ? { eventId: match[3] } : {}) };
}
export function handleAgentMessageInput(pi: ExtensionAPI, event: Pick<InputEvent, "text">, ctx: Pick<ExtensionContext, "isIdle">): InputEventResult {
	const parsed = parseAgentMessage(event.text);
	if (!parsed?.eventId) return { action: "continue" };
	pi.sendMessage({ customType: "herdr-agent-message", content: event.text, details: { eventId: parsed.eventId, from: parsed.from, to: parsed.to }, display: true }, { triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" });
	return { action: "handled" };
}
export function registerAgentMessageInput(pi: ExtensionAPI): void {
	pi.on("input", (event, ctx) => handleAgentMessageInput(pi, event, ctx));
}
