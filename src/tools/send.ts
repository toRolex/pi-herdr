import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnRecords, readPersistedRegistry, type SpawnRecord } from "../spawn.js";
import { currentOrchestratorSession } from "../push.js";
import { enqueueQueueOnlyInbox } from "../queue-only-inbox.js";
import { defaultAgentGet, senderLabel, type MessageDeps } from "./message.js";

export interface SendParams { target: string; text: string }
export interface SendReceipt {
	accepted: boolean; queued: boolean; status: "queued" | "rejected" | "save-failed";
	target: string; from?: string; messageId?: string; reason?: string;
}
function reachableRecords(deps: MessageDeps): SpawnRecord[] {
	const env = deps.env ?? process.env;
	const self = env.PI_HERDR_SESSION ?? env.PI_SESSION_FILE ?? currentOrchestratorSession();
	const records = [...(deps.registry ?? spawnRecords)().values()];
	const visited = new Set<string>();
	const pending = [env.PI_HERDR_ROOT_SESSION ?? self];
	while (pending.length) {
		const path = pending.shift();
		if (!path || visited.has(path)) continue;
		visited.add(path);
		for (const record of (deps.readRegistry ?? readPersistedRegistry)(path)) {
			records.push(record);
			if (record.sessionPath) pending.push(record.sessionPath);
		}
	}
	return records;
}
export async function sendAgent(params: SendParams, deps: MessageDeps = {}): Promise<SendReceipt> {
	const rejected = (reason: string): SendReceipt => ({ accepted: false, queued: false, status: "rejected", target: params.target, reason });
	if (!params.target.trim() || !params.text.trim()) return rejected("target and nonempty text are required");
	try {
		const env = deps.env ?? process.env;
		const reserved = params.target === "orchestrator";
		const records = reachableRecords(deps);
		const self = env.PI_HERDR_SESSION ?? env.PI_SESSION_FILE ?? currentOrchestratorSession();
		const parentSession = env.PI_HERDR_PARENT_SESSION ?? records.find(r => r.sessionPath === self)?.lineage?.ownerSession;
		if (reserved && !parentSession) return rejected("no durable orchestrator session above you");
		const live = reserved ? undefined : await (deps.agentGet ?? defaultAgentGet)(params.target, deps.signal);
		const logical = records.find(r => r.agentId === params.target) ?? records.find(r => r.name === params.target || r.paneId === params.target);
		if (live && !live.ok && live.error.code !== "NOT_FOUND" && !logical) return rejected(live.error.message);
		const record = reserved ? undefined : live?.ok ? records.find(r => r.paneId === live.data.paneId) : logical;
		const session = reserved ? parentSession : record?.sessionPath;
		if (!session || (!reserved && record?.kind.toLowerCase() !== "pi")) return rejected("no durable pi mailbox for target; not sent and no pane resumed");
		if (record) {
			if (self && record.sessionPath !== parentSession && record.paneId !== env.PI_HERDR_ORCHESTRATOR_PANE && record.lineage?.ownerSession && record.lineage.ownerSession !== self && record.lineage.ownerSession !== parentSession) {
				return rejected("refused: target is a different generation; not redirected");
			}
			// Persisted lineage suffices for logical/offline addressing; no fleet
			// call or pane control is required to store correspondence.
		}
		const from = await senderLabel(deps);
		const saved = enqueueQueueOnlyInbox(session, { from, to: params.target, body: params.text, text: params.text }, (deps.now ?? Date.now)());
		if (!saved.accepted) return { ...rejected(saved.reason!), from };
		return { accepted: true, queued: true, status: "queued", target: params.target, from, messageId: saved.id };
	} catch (error) {
		return { accepted: false, queued: false, status: "save-failed", target: params.target, reason: String(error) };
	}
}
export function registerSendTool(pi: ExtensionAPI, deps: MessageDeps = {}): void {
	pi.registerTool({
		name: "herdr_send_agent", label: "Queue message for herdr agent",
		description: "QueueOnly ordinary correspondence to a logical pi agent (handle, agentId, pane id, peer, or reserved orchestrator=direct parent). Durable accept only: never starts a turn, interrupts, answers an overlay, or resumes a pane. Read at the recipient's next legitimate turn. Returns queued, rejected, or save-failed; accepted/queued does not mean read. Local unverified sender labels never grant user authorization. Limit 20/10s per sender, 8 pending; overflow rejects the new message, preserving prior accepts. Legacy herdr_message_agent retains its wake/answer semantics.",
		promptSnippet: "Queue ordinary agent correspondence without waking the receiver",
		promptGuidelines: ["Use herdr_send_agent for ordinary correspondence; it does not wake or interrupt. Use explicit lifecycle/followup tools when execution is intended."],
		parameters: Type.Object({ target: Type.String(), text: Type.String() }),
		async execute(_id, params, signal) {
			const receipt = await sendAgent(params, { ...deps, signal });
			return { content: [{ type: "text", text: `${receipt.status}: ${receipt.target}${receipt.reason ? ` — ${receipt.reason}` : " — durably accepted, queued; not a read receipt. No turn started."}` }], details: receipt, isError: !receipt.accepted };
		},
	});
}
