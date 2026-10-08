import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const lifecycle = await jiti.import(join(ROOT, "src/tools/lifecycle.ts"), { parent: ROOT });
const spawn = await jiti.import(join(ROOT, "src/spawn.js"), { parent: ROOT });
const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), { parent: ROOT });
const settings = await jiti.import(join(ROOT, "src/settings.ts"), { parent: ROOT });
const { writeFileSync, rmSync } = await import("node:fs");
const { parseTriggerTurn } = await jiti.import(join(ROOT, "src/agent-message.ts"), { parent: ROOT });
const { randomUUID } = await import("node:crypto");
const { tmpdir } = await import("node:os");
let passed = 0;
let failed = 0;
function assert(ok, label) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
function record(overrides = {}) {
  return {
    name: "scout", agentId: "agent-1", runId: "old-run", sequence: 1,
    kind: "pi", type: "Explore", prompt: "old task", agentArgs: [], depth: 1,
    isolated: false, spawnedAt: 1, paneId: "pane-old", submitted: true,
    sawWorking: true, stance: "autonomous", sessionPath: "/tmp/scout-session.jsonl",
    definition: { name: "scout", kind: "pi" }, ...overrides,
  };
}
const deps = (r, over = {}) => ({
  fleet: async () => ({ ok: true, data: r.paneId ? [{ paneId: r.paneId, name: r.name, agentStatus: r.name.startsWith("busy") ? "working" : "idle" }] : [] }),
  load: () => ({ ...settings.DEFAULT_SETTINGS, max_parallel_agents: 1 }), env: {},
  childExtension: "child.ts", autodrain: false,
  registry: { find: (provider, id) => ({ provider, id }), hasConfiguredAuth: () => true },
  start: async () => ({ ok: true, data: { agent: { pane_id: "pane-new" } } }),
  boot: async () => ({ ok: true, data: true }), submit: async () => ({ ok: true, data: true }),
  status: async () => ({ ok: true, data: "working" }), ...over,
});
spawn.clearSpawnRegistry();
const sessionPath = `${tmpdir()}/spec43-t5-${randomUUID()}.jsonl`;
writeFileSync(sessionPath, "");
writeFileSync(`${sessionPath}.completion-event`, "old-run");
const rec = record({ sessionPath });
spawn.putSpawnRecordForTests(rec);
assert(typeof lifecycle.triggerTurn === "function", "triggerTurn engine is exported");
assert(parseTriggerTurn('<herdr-followup runId="123e4567-e89b-12d3-a456-426614174000">\ntask\n</herdr-followup>')?.body === "task", "followup envelope parser extracts the durable body");
const result = await lifecycle.triggerTurn({ target: "scout", text: "continue" }, deps(rec));
assert(result.ok, `idle followup accepted (${result.ok ? "" : result.error.message})`);
assert(rec.agentId === "agent-1", "logical agent identity is preserved");
assert(rec.runId !== "old-run", "followup receives a distinct run identity");
assert(rec.sessionPath === sessionPath, "followup retains the original session");
assert(result.ok && result.data.runId === rec.runId, "receipt carries its run identity");
assert(!rec.pendingFollowups?.length, "idle followup is submitted directly rather than left in the queue");
spawn.clearSpawnRegistry();
writeFileSync(`${sessionPath}.completion-event`, "old-run");
const busyRecord = record({ name: "busy", sessionPath });
spawn.putSpawnRecordForTests(busyRecord);
const queued1 = await lifecycle.triggerTurn({ target: "busy", text: "first" }, deps(busyRecord));
const queued2 = await lifecycle.triggerTurn({ target: "busy", text: "second" }, deps(busyRecord));
assert(queued1.ok && queued1.data.status === "queued", "busy followup queues without interrupting");
assert(queued2.ok && queued2.data.status === "queued", "second busy followup also queues");
assert(queued1.ok && queued2.ok && queued1.data.runId !== queued2.data.runId, "busy followups carry distinct run identities");
assert(busyRecord.pendingFollowups?.length === 2, "busy followups remain separately addressable in order");
const priorCompletionMarker = (await import("node:fs")).readFileSync(`${sessionPath}.completion-event`, "utf8");
assert(priorCompletionMarker === "old-run", "busy acceptance does not overwrite the active run completion marker");
assert(busyRecord.pendingFollowups[0].runId === queued1.data.runId && !busyRecord.pendingRunId, "accepted identity stays queued until execution");
assert(busyRecord.runId === "old-run", "busy acceptance does not replace the active child run identity");
busyRecord.pendingFollowups = [busyRecord.pendingFollowups[0]];
busyRecord.runId = queued1.ok ? queued1.data.runId : busyRecord.runId;
busyRecord.paneId = undefined;
const drain = await spawn.drainQueueOnce(deps(busyRecord, {
  fleet: async () => ({ ok: true, data: [] }),
  list: async () => [],
  start: async (input) => ({ ok: true, data: { agent: { pane_id: input.agentArgs.includes("first") ? "pane-first" : "pane-second" } } }),
}));
assert(drain === 1, "queued followup starts when the pane/slot is gone");
assert(queued1.ok && busyRecord.runId === queued1.data.runId, "drain binds the head followup run identity");
assert(busyRecord.pendingFollowups?.length === 0, "drain removes the started entry only after successful startup");
spawn.clearSpawnRegistry();
const settling = record({ name: "settling", sessionPath, runId: "settled-old", paneId: "pane-settling", pendingFollowups: [{ runId: "settled-next", text: "next work" }] });
spawn.putSpawnRecordForTests(settling);
writeFileSync(`${sessionPath}.exit`, JSON.stringify({ type: "done", text: "old result", eventId: "settled-old", agentId: settling.agentId, runId: settling.runId, sequence: 1 }));
const pushes = [];
await delivery.deliverOnce({
  registry: spawn.spawnRecords,
  fleet: { ok: true, data: [{ paneId: "pane-settling", name: "settling", agentStatus: "idle" }] },
  sessionPath: undefined,
  push: (message) => pushes.push(message),
  closePane: async () => ({ ok: true, data: true }),
  notifications: "normal",
});
await delivery.deliverOnce({ registry: spawn.spawnRecords, fleet: { ok: true, data: [] }, push: message => pushes.push(message), closePane: async () => ({ ok: true, data: true }) });
assert(settling.paneId === undefined && settling.pendingFollowups?.length === 1, "delivery settles prior run and releases pane for queued followup");
const resumedQueued = await spawn.drainQueueOnce(deps(settling, {
  list: async () => [], fleet: async () => ({ ok: true, data: [] }),
  start: async () => ({ ok: true, data: { agent: { pane_id: "pane-settled-followup" } } }),
}));
assert(resumedQueued === 1 && settling.runId === "settled-next", "settled busy followup drains as its own run");
assert(pushes.some((message) => message.details?.eventId === "settled-old"), "old run completion remains delivered before next run starts");
spawn.clearSpawnRegistry();
const originalRun = record({ name: "gone", sessionPath, paneId: undefined, delivery: { kind: "gone", at: 1 } });
spawn.putSpawnRecordForTests(originalRun);
const restored = await lifecycle.triggerTurn({ target: "gone", text: "recover" }, deps(originalRun, {
  fleet: async () => ({ ok: true, data: [] }),
  start: async () => ({ ok: true, data: { agent: { pane_id: "pane-restored" } } }),
  submit: async (_paneId, text) => {
    assert(text.includes("<herdr-followup runId="), "restored run submits its run identity envelope");
    return { ok: true, data: true };
  },
}));
assert(restored.ok && restored.data.paneId === "pane-restored", "pane-gone followup restores the same agent session");
assert(originalRun.runId === (restored.ok ? restored.data.runId : undefined), "restored completion is bound to the accepted run");
spawn.clearSpawnRegistry();
const concurrent = record({ name: 'concurrent', sessionPath, paneId: undefined, delivery: { kind: 'done', at: 1 } });
spawn.putSpawnRecordForTests(concurrent);
let releaseStart; const heldStart = new Promise(resolve => { releaseStart = resolve; });
let starts = 0;
const concurrentDeps = deps(concurrent, { fleet: async () => ({ ok: true, data: [] }), start: async () => { starts++; await heldStart; return { ok: true, data: { agent: { pane_id: 'single-pane' } } }; } });
const firstStart = lifecycle.triggerTurn({ target: concurrent.name, text: 'new work' }, concurrentDeps);
while (!starts) await new Promise(resolve => setTimeout(resolve, 1));
const duplicate = await lifecycle.resumeAgent({ target: concurrent.name, message: 'duplicate' }, concurrentDeps);
assert(!duplicate.ok && starts === 1, 'resume and followup share a single executor transition lock');
releaseStart(); await firstStart;
spawn.clearSpawnRegistry();
const failedRecord = record({ name: 'failed', sessionPath }); spawn.putSpawnRecordForTests(failedRecord);
const failedStart = await lifecycle.triggerTurn({ target: failedRecord.name, text: 'fail' }, deps(failedRecord, { submit: async () => ({ ok: false, error: { code: 'AGENT_START_FAILED', message: 'fixture start failure' } }) }));
assert(!failedStart.ok && failedStart.error.details.runId && failedStart.error.details.status === 'start-error', 'startup failure receipt carries accepted run and explicit failure status');
const reclaimed = record({ name: 'reclaimed', sessionPath, pendingFollowups: [{ runId: 'reclaimed-next', text: 'recover queue' }] }); spawn.clearSpawnRegistry(); spawn.putSpawnRecordForTests(reclaimed);
rmSync(`${sessionPath}.exit`, { force: true });
await delivery.deliverOnce({ registry: spawn.spawnRecords, fleet: { ok: true, data: [] }, push: () => {} });
const reclaimedDrain = await spawn.drainQueueOnce(deps(reclaimed, { list: async () => [], fleet: async () => ({ ok: true, data: [] }) }));
assert(reclaimedDrain === 1 && reclaimed.runId === 'reclaimed-next', 'queued request survives pane reclamation without a prior terminal sidecar');
rmSync(sessionPath, { force: true });
console.log(`\n[done] ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
