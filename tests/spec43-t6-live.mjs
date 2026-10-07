// Real-host T6 demonstration: real pi children, completion events and herdr CLI.
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(ROOT, ".agents/evidence/spec43-t6");
mkdirSync(evidenceDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-spec43-t6-live-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });
writeFileSync(join(tmp, ".pi/herdr.json"), JSON.stringify({ agents_kill_switch: false, max_parallel_agents: 2, max_spawn_depth: 3, default_kind: "pi", notifications: "normal" }));
process.chdir(tmp);
const jiti = createJiti(import.meta.url);
const agents = await jiti.import(join(ROOT, "src/tools/agents.ts"), { parent: ROOT });
const waitModule = await jiti.import(join(ROOT, "src/tools/wait.ts"), { parent: ROOT });
const resultModule = await jiti.import(join(ROOT, "src/tools/result.ts"), { parent: ROOT });
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT });
const tools = [];
const pi = { registerTool: t => tools.push(t), on: () => {} };
agents.registerAgents(pi);
waitModule.registerWaitTool(pi);
resultModule.registerResultTool(pi);
const spawn = tools.find(t => t.name === "herdr_spawn_agent");
const wait = tools.find(t => t.name === "herdr_wait_agent_event");
const getResult = tools.find(t => t.name === "herdr_get_agent_result");
assert.ok(spawn && wait && getResult, "T6 tools registered");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const panes = new Set();
const check = (scenario, ok, details = {}) => { checks.push({ scenario, ok, ...details }); console.log(`${ok ? "✓" : "✗"} ${scenario}`); assert.ok(ok, `${scenario}: ${JSON.stringify(details)}`); };
async function launch(prompt, label) {
  const name = `t6live-${label}-${Date.now()}`;
  const res = await spawn.execute("t6-live-spawn", { type: "general-purpose", name, prompt });
  assert.equal(res.isError, undefined, JSON.stringify(res.details));
  const d = res.details ?? {};
  if (d.paneId) panes.add(d.paneId);
  const deadline = Date.now() + 120000;
  while (!d.paneId && Date.now() < deadline) {
    await sleep(250);
    const r = await getResult.execute("t6-live-inspect", { target: name }, undefined);
    Object.assign(d, r.details);
    if (d.paneId) panes.add(d.paneId);
  }
  assert.ok(d.sessionPath, `child session was not created: ${JSON.stringify(d)}`);
  return { name, d };
}
function persistedEvent(sessionPath) {
  const base = sessionPath.split("/").pop();
  return existsSync(`${sessionPath}.completion-event`) || readdirSync(dirname(sessionPath)).some(name => name.startsWith(`${base}.completion-`));
}
async function save(summary) { writeFileSync(join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n"); }
try {
  // Event arrives before wait begins; durable state must still satisfy the wait.
  const first = await launch("Reply with exactly EVENT_FIRST_OK", "eventfirst");
  const final1 = await getResult.execute("t6-first-result", { target: first.name, wait: 180000 }, undefined);
  check("event-first result completed", final1.details?.status === "done", { status: final1.details?.status });
  const e1 = await wait.execute("t6-first-wait", { target: first.name, timeout: 10000 }, undefined);
  check("event-first wait observes persisted completion", !e1.isError && e1.details?.status === "available", { status: e1.details?.status, eventId: e1.details?.eventId });
  check("event-first completion event persisted", persistedEvent(first.d.sessionPath), { sessionPath: first.d.sessionPath });

  // Wait starts before the real child completes.
  const second = await launch("Use bash to run exactly: sleep 8; echo WAIT_FIRST_OK. Then reply with the command output only.", "waitfirst");
  const e2 = await wait.execute("t6-pending", { target: second.name, timeout: 180000 }, undefined);
  check("wait-first resolves on child completion", !e2.isError && e2.details?.status === "available", { status: e2.details?.status, eventId: e2.details?.eventId });

  // Abort a pending wait, then prove result/event remain available.
  const third = await launch("Use bash to run exactly: sleep 12; echo CANCEL_RESULT_OK. Then reply with the command output only.", "cancel");
  const controller = new AbortController();
  const waiting = wait.execute("t6-cancel", { target: `${third.name}-pending-event`, timeout: 180000 }, controller.signal);
  await sleep(250);
  controller.abort();
  const cancellation = await waiting;
  check("cancellation returns cancelled", cancellation.details?.status === "cancelled", { status: cancellation.details?.status });
  const recovered = await getResult.execute("t6-recover", { target: third.name, wait: 180000 }, undefined);
  check("result retrievable after cancellation", recovered.details?.status === "done" && String(recovered.details?.result ?? "").trim().length > 0, { status: recovered.details?.status, result: recovered.details?.result });
  const after = await wait.execute("t6-after-cancel", { target: third.name, timeout: 10000 }, undefined);
  check("completion event remains observable after cancellation", after.details?.status === "available", { status: after.details?.status, eventId: after.details?.eventId });
  await save({ host: "real-herdr-cli+pi-spawn", scenarios: checks, pass: checks.length, fail: 0, childHandles: [first.name, second.name, third.name], paneIds: [...panes] });
} catch (error) {
  await save({ host: "real-herdr-cli+pi-spawn", scenarios: checks, pass: checks.filter(c => c.ok).length, fail: 1, error: String(error), paneIds: [...panes] });
  throw error;
} finally {
  for (const paneId of panes) await herdr(["pane", "close", paneId], { timeoutMs: 10000 }).catch(() => {});
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
}
console.log(`PASS: ${checks.length} T6 live assertions`);
