import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	const childName = process.env.TURN_PROBE_CHILD_NAME ?? "turn-probe-child";
	pi.registerProvider("turn-probe", {
		api: "turn-probe-api",
		baseUrl: "http://localhost.invalid",
		apiKey: "fixture",
		models: [{ id: "deterministic", name: "Deterministic turn probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const last = context.messages.at(-1) as any;
				const user = [...context.messages].reverse().find((m: any) => m.role === "user") as any;
				const text = typeof user?.content === "string" ? user.content : (user?.content ?? []).map((c: any) => c.text ?? "").join("");
				let content: any[];
				let stopReason = "stop";
				if (text.includes("probe-dispatch") && last?.role === "user") {
					content = [{ type: "toolCall", id: "spawn-probe", name: "herdr_spawn_agent", arguments: { name: childName, prompt: "probe-child", model: "turn-probe/deterministic", thinking: "off", group: childName, agent: { name: childName, agent_args: ["-ne", "-e", process.env.TURN_PROBE_EXTENSION!] } } }];
					stopReason = "toolUse";
				} else if (text === "probe-child" && last?.role === "user") {
					content = [{ type: "toolCall", id: "child-delay", name: "bash", arguments: { command: "sleep 8" } }];
					stopReason = "toolUse";
				} else if (last?.role === "toolResult" && last?.toolName === "herdr_spawn_agent") {
					content = [{ type: "toolCall", id: "inspect-probe", name: "herdr_get_agent_result", arguments: { target: childName, wait: true } }];
					stopReason = "toolUse";
				} else if (text.includes("probe-workflow") && last?.role === "user") {
					content = [{ type: "toolCall", id: "workflow-probe", name: "herdr_run_workflow", arguments: { script: `export const meta = { name: 'turn-probe-workflow', description: 'Turn release probe' }; return await agent('probe-child', { agentType: '${childName}', label: '${childName}-workflow', model: 'turn-probe/deterministic', effort: 'off' });` } }];
					stopReason = "toolUse";
				} else {
					content = [{ type: "text", text: text === "probe-child" ? "CHILD_COMPLETE" : "PARENT_READY" }];
				}
				const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: stopReason as any, message });
				stream.end();
			});
			return stream;
		},
	});
	pi.on("agent_settled", () => {
		if (process.env.TURN_PROBE_LOG) appendFileSync(process.env.TURN_PROBE_LOG, JSON.stringify({ event: "settled", at: Date.now(), name: process.env.PI_HERDR_NAME ?? "parent" }) + "\n");
	});
}
