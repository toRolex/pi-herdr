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
export function makeDeliverySink(pi: ExtensionAPI): (msg: SteeredMessage) => void {
	return (msg: SteeredMessage): void => {
		try {
			const deliverAs: DeliverAs =
				msg.deliverAs ?? (msg.wake ? "steer" : "nextTurn");
			pi.sendMessage(
				{
					customType: "herdr-delivery",
					content: msg.content,
					display: true,
					details: msg.details,
				},
				{
					triggerTurn: deliverAs !== "nextTurn",
					deliverAs,
				},
			);
		} catch {
		/* best-effort — delivery must never break its caller */
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
