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

/**
 * Build the steer sink for a session: pi.sendMessage with delivery's exact
 * envelope (`herdr-delivery`, wake → steer/nextTurn flags). ONE factory so
 * every consumer (the delivery loop, the workflow run's completion report)
 * cannot drift apart.
 */
export function makeDeliverySink(
	pi: ExtensionAPI,
	confirmation?: { getBranch(): readonly unknown[]; getSessionFile?: () => string | undefined; now?: () => number; timeoutMs?: number },
): (msg: SteeredMessage) => void {
	let getBranch = confirmation?.getBranch;
	let getSessionFile = confirmation?.getSessionFile;
	const confirmed = (token: string): boolean => {
		const matches = (entry: unknown): boolean => {
			const row = entry as { type?: string; customType?: string; details?: { deliveryToken?: string } };
			return row.type === "custom_message" && row.customType === "herdr-delivery" && row.details?.deliveryToken === token;
		};
		if (getSessionFile) {
			const file = getSessionFile();
			if (!file) return false;
			try { return readFileSync(file, "utf8").split("\n").filter(Boolean).some(line => matches(JSON.parse(line))); }
			catch { return false; }
		}
		return getBranch?.().some(matches) ?? false;
	};
	const pending = new Map<string, { token: string; at: number }>();
	pi.on?.("session_start", (_event, ctx) => {
		getBranch = () => ctx.sessionManager.getBranch();
		getSessionFile = () => ctx.sessionManager.getSessionFile();
		pending.clear();
	});
	return (msg: SteeredMessage): void => {
		try {
			const key = JSON.stringify([msg.details.eventId, msg.details.sessionPath, msg.details.name, msg.details.kind, msg.content]);
			const now = (confirmation?.now ?? Date.now)();
			const existing = pending.get(key);
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
