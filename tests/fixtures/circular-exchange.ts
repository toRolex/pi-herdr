import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { registerMessageTool } from "../../src/tools/message.js";

export default function (pi: ExtensionAPI) {
 const child = process.env.PI_HERDR_NAME?.startsWith("circular-") === true;
 if (!child && process.env.CIRCULAR_INPUT_LOG) pi.on("input", (event) => {
  appendFileSync(process.env.CIRCULAR_INPUT_LOG!, JSON.stringify({ at: Date.now(), event }) + "\n");
 });
 if (child) registerMessageTool(pi);
 pi.registerProvider("circular-exchange", {
  api: "circular-exchange-api", baseUrl: "http://localhost.invalid", apiKey: "fixture",
  models: [{ id: "deterministic", name: "Circular exchange", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  streamSimple(model, context) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const messages = context.messages as any[];
    const last = messages.at(-1);
    const text = (m: any) => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join("");
    const inbound = messages.filter(m => m.role === "user" || m.role === "custom").map(text).join("\n");
    let content: any[];
    let stopReason = "toolUse";
    const call = (name: string, args: any) => [{ type: "toolCall", id: `exchange-${messages.length}`, name, arguments: args }];
    if (child) {
     if (inbound.includes("PARENT_ACK")) {
      content = [{ type: "text", text: "CHILD_COMPLETE_AFTER_ACK" }]; stopReason = "stop";
     } else if (!messages.some(m => m.role === "toolResult" && m.toolName === "herdr_message_agent")) {
      content = call("herdr_message_agent", { target: "orchestrator", text: "CHILD_QUESTION_NEEDS_ACK" });
     } else {
      content = call("bash", { command: "sleep 0.1" });
     }
    } else if (inbound.includes("CHILD_QUESTION_NEEDS_ACK") && !messages.some(m => m.role === "toolResult" && m.toolName === "herdr_message_agent")) {
     content = call("herdr_message_agent", { target: process.env.TURN_PROBE_CHILD_NAME, text: "PARENT_ACK" });
    } else if (last?.role === "user" && text(last) === "exchange-workflow") {
     content = call("herdr_run_workflow", { script: `export const meta = { name: 'circular-workflow', description: 'Circular exchange regression' }; return await agent('exchange-child', { label: '${process.env.TURN_PROBE_CHILD_NAME}', agentType: '${process.env.TURN_PROBE_CHILD_NAME}', model: 'circular-exchange/deterministic', effort: 'off' });` });
    } else if (last?.role === "user" && text(last) === "exchange-start") {
     content = call("herdr_spawn_agent", { name: process.env.TURN_PROBE_CHILD_NAME, prompt: "exchange-child", model: "circular-exchange/deterministic", thinking: "off", group: process.env.TURN_PROBE_CHILD_NAME, agent: { name: process.env.TURN_PROBE_CHILD_NAME, agent_args: ["-ne", "-e", process.env.TURN_PROBE_EXTENSION] } });
    } else if (last?.role === "toolResult" && last.toolName === "herdr_spawn_agent") {
     content = call("herdr_get_agent_result", { target: process.env.TURN_PROBE_CHILD_NAME, wait: true });
     if (process.env.CIRCULAR_BUSY === "1") content.push({ type: "toolCall", id: "independent-busy", name: "bash", arguments: { command: "sleep 7; printf UNRELATED_TOOL_FINISHED" } });
    } else {
     content = [{ type: "text", text: "PARENT_EXCHANGE_PROGRESS" }]; stopReason = "stop";
    }
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: stopReason as any, message }); stream.end();
   });
   return stream;
  },
 });
}
