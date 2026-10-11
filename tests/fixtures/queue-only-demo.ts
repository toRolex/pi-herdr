import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { writePersistedRegistry } from "../../src/spawn.js";

export default function (pi: ExtensionAPI) {
 if (process.env.QUEUE_DEMO_RECEIVER_SESSION) pi.on("session_start", (_event, ctx) => {
  const self=ctx.sessionManager.getSessionFile()!;
  const record:any={name:"queue-demo-receiver",kind:"pi",paneId:process.env.QUEUE_DEMO_TARGET,sessionPath:process.env.QUEUE_DEMO_RECEIVER_SESSION,stance:"interactive",lineage:{ownerSession:self,rootSession:self}};
  writePersistedRegistry(self,[record]);
 });
 const log = (kind: string, value: unknown) => appendFileSync(process.env.QUEUE_DEMO_LOG!, JSON.stringify({at: Date.now(), kind, value}) + "\n");
 pi.on("input", event => { log("input", event); });
 pi.on("agent_start", () => { log("agent_start", {}); });
 pi.on("agent_end", () => { log("agent_end", {}); });
 pi.registerProvider("queue-only-demo", {
  api: "queue-only-demo-api", baseUrl: "http://localhost.invalid", apiKey: "fixture",
  models: [{id: "deterministic", name: "QueueOnly demo", reasoning: false, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:128000,maxTokens:1024}],
  streamSimple(model, context) {
   log("stream", context.messages);
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const messages = context.messages as any[];
    const last = messages.at(-1);
    const text = (m: any) => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c:any)=>c.text??"").join("");
    let content: any[]; let stopReason = "stop";
    const call = (name: string, args: any) => {stopReason="toolUse";return [{type:"toolCall",id:`queue-demo-${messages.length}`,name,arguments:args}];};
    if(last?.role === "user" && text(last) === "busy-start") content=call("bash",{command:"sleep 5; printf QUEUE_BUSY_TOOL_FINISHED"});
    else if(last?.role === "user" && text(last).startsWith("send:")) content=call("herdr_send_agent",{target:process.env.QUEUE_DEMO_TARGET,text:text(last).slice(5)});
    else if(last?.role === "toolResult" && last.toolName === "bash") content=[{type:"text",text:"QUEUE_RECEIVER_BUSY_DONE"}];
    else if(last?.role === "toolResult" && last.toolName === "herdr_send_agent") content=[{type:"text",text:"QUEUE_SENDER_DONE"}];
    else content=[{type:"text",text:"QUEUE_RECEIVER_NEXT_TURN_DONE"}];
    const message:any={role:"assistant",api:model.api,provider:model.provider,model:model.id,content,stopReason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    stream.push({type:"start",partial:message});stream.push({type:"done",reason:stopReason as any,message});stream.end();
   });
   return stream;
  }
 });
}
