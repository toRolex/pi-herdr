// Real SDK persistence order: message_end stores the tool-call assistant before execute.
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
 registerChildExtension({ on: (n, h) => (handlers[n] ??= []).push(h), registerTool: t => tools.push(t), registerShortcut() {} });
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
 assert.ok(pushes[0].content.includes(letter), "push contains the entire committed body");
 console.log("✓ persisted toolCall-only declaration delivers full sidecar + push body");

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
  if (mode === "rearm") assert.equal(sidecar().rearm, true);
  assert.equal(child.shutdowns(), 1);
  const settledPushes = [];
  const settledRecord = { ...record, name: mode, delivery: undefined };
  await deliverOnce({ registry: () => new Map([[mode, settledRecord]]), load: () => ({ notifications: "normal" }), list: async () => ({ ok: true, data: [{ paneId: record.paneId, agentStatus: "done" }] }), push: p => settledPushes.push(p), closePane: async () => ({ ok: true }) });
  const terminal = settledPushes.filter(p => p.details?.kind === (mode === "error" ? "error" : "done"));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].details.result, letter);
  assert.ok(terminal[0].content.includes(letter), `${mode} push contains the entire body`);
  await child.emit("session_shutdown");
 }
 console.log("✓ auto-settle / error / idle-rearm preserve the same body");
 clean(); persist([user]);
 const schema = join(dir, "schema.json"); writeFileSync(schema, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }));
 process.env.PI_HERDR_SCHEMA = schema;
 child = boot(); await child.emit("agent_start"); persist([user, doneCall]);
 await child.tools.find(t => t.name === "StructuredOutput").execute("structured", { ok: true });
 const structured = await child.tools.find(t => t.name === "agent_done").execute("done-4", {}, undefined, undefined, child.ctx);
 assert.notEqual(structured.isError, true); assert.equal(sidecar().structured, '{"ok":true}'); assert.equal(child.shutdowns(), 1);
 console.log("✓ validated structured-only completion remains allowed");
} finally {
 keys.forEach((k, i) => saved[i] === undefined ? delete process.env[k] : process.env[k] = saved[i]);
 rmSync(dir, { recursive: true, force: true });
}
