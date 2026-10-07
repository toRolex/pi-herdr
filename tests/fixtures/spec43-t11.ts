import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { registerResultTool } from "../../src/tools/result.js";
import type { SpawnRecord } from "../../src/spawn.js";

/** Real TUI fixture: deterministic provider only replaces model decisions. */
export default function (pi: ExtensionAPI) {
 const record = JSON.parse(readFileSync(`${process.cwd()}/record.json`, "utf8")) as SpawnRecord;
 registerResultTool(pi, { registry: () => new Map([[record.name, record]]) });
 pi.registerProvider("t11-demo", {
  api: "t11-demo-api", baseUrl: "http://localhost.invalid", apiKey: "fixture",
  models: [{ id: "deterministic", name: "T11 demo", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  streamSimple(model, context) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const results = context.messages.filter((m: any) => m.role === "toolResult" && m.toolName === "herdr_get_agent_result") as any[];
    const reference = results[0]?.details;
    const args = [{ target: record.name }, { target: record.name, ack: reference && { eventId: reference.eventId, agentId: reference.agentId, runId: reference.runId, sequence: reference.sequence, hostFile: `${process.cwd()}/parent.jsonl` } }, { target: record.name }, { target: record.name, reread: true }][results.length];
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: args ? [{ type: "toolCall", id: `t11-${results.length}`, name: "herdr_get_agent_result", arguments: args }] : [{ type: "text", text: "T11_TUI_COMPLETE" }], stopReason: args ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
   });
   return stream;
  },
 });
}
