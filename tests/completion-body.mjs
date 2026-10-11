// Real SDK persistence order: message_end stores the tool-call assistant before execute.
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const jiti = createJiti(import.meta.url);
const { registerChildExtension } = await jiti.import("../src/child.ts");
const { deliverOnce } = await jiti.import("../src/delivery.ts");
const dir = mkdtempSync(join(tmpdir(), "herdr-completion-body-"));
const session = join(dir, "child.jsonl");
const keys = ["PI_HERDR_SESSION", "PI_HERDR_AUTO_EXIT", "PI_HERDR_IDLE_REARM_MS", "PI_HERDR_ERROR_EXIT_GRACE_MS", "PI_HERDR_SCHEMA", "PI_HERDR_ACTIVITY_FILE"];
const saved = keys.map(k => process.env[k]);
const message = (role, content, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
const user = message("user", "current task");
const letter = "FULL FINAL RESULT\nAll evidence and limitations.\n尾行";
const body = message("assistant", [{ type: "text", text: letter }]);
const doneCall = message("assistant", [{ type: "toolCall", id: "done-1", name: "agent_done", arguments: {} }], { stopReason: "toolUse" });
const persist = entries => writeFileSync(session, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
function boot() {
 const handlers = {}, tools = [];
 registerChildExtension({ on: (n, h) => (handlers[n] ??= []).push(h), registerTool: t => tools.push(t), registerShortcut() {}, sendUserMessage() {} });
 let shutdowns = 0;
 const ctx = { shutdown: () => shutdowns++ };
 return { tools, ctx, shutdowns: () => shutdowns, emit: async (n, e = {}) => { for (const h of handlers[n] ?? []) await h(e, ctx); } };
}
const sidecar = () => JSON.parse(readFileSync(`${session}.exit`, "utf8"));
const clean = () => { rmSync(`${session}.exit`, { force: true }); };
try {
 process.env.PI_HERDR_SESSION = session;
 process.env.PI_HERDR_AUTO_EXIT = "1";
 process.env.PI_HERDR_IDLE_REARM_MS = "5";
 process.env.PI_HERDR_ERROR_EXIT_GRACE_MS = "5";
 delete process.env.PI_HERDR_SCHEMA;
 delete process.env.PI_HERDR_ACTIVITY_FILE;
 persist([user]);
 let child = boot();
 await child.emit("agent_start");
 persist([user, body, doneCall]);
 const result = await child.tools.find(t => t.name === "agent_done").execute("done-1", {}, undefined, undefined, child.ctx);
 assert.notEqual(result.isError, true, "tool-only final assistant must not hide the letter");
 assert.equal(child.shutdowns(), 1);
 assert.equal(sidecar().text, letter);
 const record = { name: "body-child", kind: "pi", paneId: "w1:body", sessionPath: session, stance: "autonomous" };
 const pushes = [];
 await deliverOnce({ registry: () => new Map([[record.name, record]]), load: () => ({ notifications: "normal" }), list: async () => ({ ok: true, data: [{ paneId: record.paneId, agentStatus: "done" }] }), push: p => pushes.push(p), closePane: async () => ({ ok: true }) });
 assert.equal(pushes.length, 1);
 assert.equal(pushes[0].details.result, letter);
 assert.equal(pushes[0].content, letter, "push is the exact complete final answer without protocol shell");
 assert.equal(pushes[0].details.sessionPath, session, "session path remains metadata");
 console.log("✓ persisted toolCall-only declaration delivers full sidecar + push body");

 // Sidecar write failures must keep the pane open and report governance failure.
 clean(); persist([user]); child = boot(); await child.emit("agent_start"); persist([user, body, doneCall]);
 const exitDir = `${session}.exit`; mkdirSync(exitDir);
 const failed = await child.tools.find(t => t.name === "agent_done").execute("done-failed", {}, undefined, undefined, child.ctx);
 assert.equal(failed.isError, true);
 assert.equal(child.shutdowns(), 0);
 const events = [];
 const failedRecord = { ...record, delivery: undefined };
 await deliverOnce({ registry: () => new Map([[failedRecord.name, failedRecord]]), load: () => ({ notifications: "normal" }), list: async () => ({ ok: true, data: [{ paneId: failedRecord.paneId, agentStatus: "working" }] }), readSidecar: () => ({ state: "ok", sidecar: { type: "persistence-error", errorMessage: "completion persistence failed", eventId: "stable" } }), push: p => events.push(p), closePane: async () => ({ ok: true }) });
 assert.equal(events[0]?.details.kind, "persistence-error");
 assert.equal(failedRecord.delivery, undefined);
 rmSync(exitDir, { recursive: true, force: true });
 console.log("✓ sidecar persistence failure is visible and never closes the pane");

 for (const entries of [[user, body, user, doneCall], [user, doneCall]]) {
  clean(); persist(entries); child = boot();
  const refused = await child.tools.find(t => t.name === "agent_done").execute("done-2", {}, undefined, undefined, child.ctx);
  assert.equal(refused.isError, true); assert.equal(child.shutdowns(), 0); assert.equal(existsSync(`${session}.exit`), false);
 }
 console.log("✓ old-user-turn body and bare declaration are refused");
 clean(); persist([user, body]); child = boot(); await child.emit("agent_start"); persist([user, body, doneCall]);
 const stale = await child.tools.find(t => t.name === "agent_done").execute("done-3", {}, undefined, undefined, child.ctx);
 assert.equal(stale.isError, true); assert.equal(existsSync(`${session}.exit`), false);
 console.log("✓ new run cannot reuse previous run body without a new user entry");

 for (const mode of ["settle", "error", "rearm"]) {
  clean(); persist([user]); child = boot(); await child.emit("agent_start"); persist([user, body, doneCall]);
  if (mode === "rearm") await child.emit("input", { source: "interactive", text: "human steer" });
  await child.emit("agent_end", { messages: [body.message, { ...doneCall.message, ...(mode === "error" ? { stopReason: "error", errorMessage: "overloaded" } : {}) }] });
  await child.emit("agent_settled");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sidecar().text, letter, `${mode} preserves completion body`);
  assert.equal(sidecar().type, mode === "error" ? "error" : "done");
  if (mode === "rearm") { assert.equal(sidecar().rearm, undefined); assert.equal(existsSync(`${session}.takeover`), false, "ordinary input never writes a takeover marker"); }
  assert.equal(child.shutdowns(), 1);
  const settledPushes = [];
  const settledRecord = { ...record, name: mode, delivery: undefined };
  await deliverOnce({ registry: () => new Map([[mode, settledRecord]]), load: () => ({ notifications: "normal" }), list: async () => ({ ok: true, data: [{ paneId: record.paneId, agentStatus: "done" }] }), push: p => settledPushes.push(p), closePane: async () => ({ ok: true }) });
  const terminal = settledPushes.filter(p => p.details?.kind === (mode === "error" ? "error" : "done"));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].details.result, letter);
  assert.equal(terminal[0].content, letter, `${mode} push is the exact full body`);
  await child.emit("session_shutdown");
 }
 console.log("✓ auto-settle / error / direct input preserve the same body");
 clean(); persist([user]);
 const schema = join(dir, "schema.json"); writeFileSync(schema, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }));
 process.env.PI_HERDR_SCHEMA = schema;
 child = boot(); await child.emit("agent_start"); persist([user, doneCall]);
 await child.tools.find(t => t.name === "StructuredOutput").execute("structured", { ok: true });
 const structured = await child.tools.find(t => t.name === "agent_done").execute("done-4", {}, undefined, undefined, child.ctx);
 assert.notEqual(structured.isError, true); assert.equal(sidecar().structured, '{"ok":true}'); assert.equal(child.shutdowns(), 1);
 console.log("✓ validated structured-only completion remains allowed");

 // Pull's public tool seam keeps association metadata out of completion prose.
 const { registerResultTool } = await jiti.import("../src/tools/result.ts");
 const failures = [];
 for (const name of ["error-final", "done-final", "done-empty", "done-no-body-review"]) {
  const folder = join(dir, name); mkdirSync(folder);
  const artifact = join(folder, "deliverable.txt"); writeFileSync(artifact, "Actual fixture deliverable\n");
  const final = `FINAL_HEAD_51\n真实交付物：[报告](${artifact})\n` + Array.from({ length: 1605 }, (_, i) => `line-${i}: complete final content 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ`).join("\n") + "\nFINAL_TAIL_51";
  const childFile = join(folder, "child.jsonl"), host = join(folder, "host.jsonl");
  const decoy = "TOOL_LOG_DECOY_51_MUST_NOT_LEAK";
  writeFileSync(childFile, JSON.stringify(message("toolResult", [{ type: "text", text: decoy }])) + "\n");
  writeFileSync(host, "");
  const eventId = `event-51-${name}`;
  const record = { name: "fixture-child", kind: "pi", paneId: "fixture:never-contact", stance: "autonomous", submitted: true, sawWorking: true, sessionPath: childFile, agentId: `agent-${name}`, runId: eventId, sequence: 1, ...(name === "done-no-body-review" ? { identityReviewRequired: true } : {}) };
  const event = { type: name === "error-final" ? "error" : "done", text: name === "done-empty" ? "" : final, eventId, agentId: record.agentId, runId: eventId, sequence: 1, ...(name === "error-final" ? { stopReason: "error", errorMessage: "durable failure" } : {}) };
  writeFileSync(childFile + ".exit", JSON.stringify(event));
  writeFileSync(childFile + `.completion-${eventId}.json`, JSON.stringify(event));
  const tools = [];
  const forbidden = () => { throw new Error("unexpected live status / extract / pane-tail access"); };
  registerResultTool({ on() {}, registerTool: tool => tools.push(tool) }, { registry: () => new Map([["fixture-child", record]]), status: forbidden, extract: forbidden, readTail: forbidden });
  const tool = tools.find(t => t.name === "herdr_get_agent_result"); assert.ok(tool);
  const returned = await tool.execute(`call-${name}`, { target: "fixture-child" }, undefined, undefined, { sessionManager: { getSessionFile: () => host } });
  const text = returned.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  const check = (label, fn) => { try { fn(); } catch (error) { failures.push(`${name}: ${label}: ${error.message}`); } };
  const carriesFinal = name.endsWith("-final");
  check("terminal semantics retained", () => {
   assert.equal(returned.details.status, name === "error-final" || name === "done-empty" ? "error" : "done");
   assert.equal(Boolean(returned.isError), name === "error-final" || name === "done-empty");
  });
  check("metadata identity and session linkage retained", () => {
   for (const key of ["eventId", "agentId", "runId", "sequence"]) assert.equal(returned.details[key], event[key]);
   assert.equal(returned.details.sessionPath, childFile);
   assert.equal(returned.details.exitPath, childFile + ".exit");
  });
  if (carriesFinal) {
   check("full final exact and actual deliverable reference retained", () => {
    assert.equal(returned.details.result, final);
    const at = text.indexOf("FINAL_HEAD_51"); assert.notEqual(at, -1);
    assert.equal(text.slice(at), final);
    assert.ok(text.includes(`[报告](${artifact})`));
   });
   check("delivery association retained in metadata", () => {
    assert.equal(returned.details.delivery.eventId, eventId);
    assert.equal(returned.details.delivery.hostFile, host);
    assert.equal(returned.details.delivery.channel, "pull");
    assert.equal(returned.details.delivery.bodyCommitted, true);
    assert.ok(returned.details.delivery.token);
   });
   if (name === "error-final") check("failure metadata retained", () => assert.deepEqual(returned.details.error, { stopReason: "error", errorMessage: "durable failure" }));
  } else {
   check("no final branch does not deliver a body", () => {
    assert.equal(returned.details.result, undefined);
    assert.equal(returned.details.delivery, undefined);
    assert.ok(!text.includes("FINAL_HEAD_51"));
   });
  }
  for (const [label, value] of [["sessionPath", childFile], ["exitPath", childFile + ".exit"], ["delivery token", returned.details.delivery?.token], ["tool/log decoy", decoy]]) {
   if (value) check(`body excludes ${label}`, () => assert.equal(text.includes(value), false, `unexpected ${label} in completion body`));
  }
  check("only minimal terminal shell", () => {
   const shell = carriesFinal ? text.slice(0, text.indexOf("FINAL_HEAD_51")) : text;
   assert.ok(shell.length < 240);
   assert.ok(!shell.includes("session:"));
  });
  console.log(`Pull ${name}: checked`);
 }
 assert.equal(failures.length, 0, failures.join("\n"));
 console.log("✓ Pull completion bodies preserve full finals and metadata without internal linkage");
} finally {
 keys.forEach((k, i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]);
 rmSync(dir, { recursive: true, force: true });
}
