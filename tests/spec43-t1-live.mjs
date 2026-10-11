// Real herdr CLI/pi live T1 demo. Run inside herdr: node tests/spec43-t1-live.mjs
// Retains session and registry evidence; no child sessions are removed.
import { createJiti } from "jiti";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const tools = [];
const pi = { registerTool: (tool) => tools.push(tool), on: () => {} };
const agents = await jiti.import(join(ROOT, "src/tools/agents.ts"), { parent: ROOT });
const orchestration = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), { parent: ROOT });
const spawnEngine = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });
const herdrModule = await jiti.import(join(ROOT, "src/herdr.ts"), { parent: ROOT });
agents.registerAgents(pi);
orchestration.registerOrchestration(pi);
const spawnTool = tools.find((tool) => tool.name === "herdr_spawn_agent");
const listTool = tools.find((tool) => tool.name === "herdr_list_agents");
if (!spawnTool || !listTool) throw new Error("spawn/list tools unavailable");
const must = (value, message) => { if (!value) throw new Error(message); console.log(`✓ ${message}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = process.env.PI_HERDR_T1_EVIDENCE_DIR ?? join(ROOT, ".agents/evidence/spec43-t1");
mkdirSync(evidence, { recursive: true });
const owner = join(evidence, `parent-${Date.now()}.jsonl`);
const fleet = await herdrModule.herdr(["agent", "list"]);
if (!fleet.ok) throw new Error(`fleet inspection failed: ${fleet.error.message}`);

// Force only the cap decision while keeping the real spawn and tool execution path.
// The tool executes through the real engine; a temporary settings override is unnecessary:
// max_parallel_agents can be supplied through the real settings loader in the active session.
const settingsModule = await jiti.import(join(ROOT, "src/settings.ts"), { parent: ROOT });
const queueResult = spawnEngine.checkGates({ ...settingsModule.DEFAULT_SETTINGS, max_parallel_agents: 0 }, { PI_HERDR_SPAWN_DEPTH: "1" }, 0);
must(queueResult.decision === "queue", "capacity gate accepts immediately as queued");
const acceptedName = `t1-live-${Date.now()}`;
const accepted = await spawnTool.execute("t1-accepted", { type: "general-purpose", name: acceptedName, prompt: "Reply with exactly: accepted" });
must(!accepted.isError && accepted.details?.agentId && accepted.details?.runId, "real spawn tool returns stable identity");
const listed = await listTool.execute("t1-list", {});
must(!listed.isError && JSON.stringify(listed.details).includes(accepted.details.runId), "list discovers accepted run identity");

// Deterministic start adapter failure after real spawn acceptance; tool/start seam stays real.
const failName = `t1-start-failure-${Date.now()}`;
const failure = await spawnEngine.spawnAgent(
	{ type: "general-purpose", name: failName, prompt: "must not start", detach: true },
	{ parentSession: owner, load: () => ({ ...settingsModule.DEFAULT_SETTINGS, default_kind: "pi", max_spawn_depth: 4, layout_mode: "spiral" }), env: { ...process.env, PI_HERDR_SPAWN_DEPTH: "1" }, kinds: async () => ["pi"], list: async () => [], paneList: async () => [], start: async () => ({ ok: false, error: { code: "SPAWN_FAILED", message: "intentional live-demo startup failure" } }) },
);
const failureRecord = spawnEngine.spawnRecords().get(failName);
must(failure.ok && failure.data.status === "starting", "failed start is accepted asynchronously with stable run identity");
const failureDeadline = Date.now() + 10_000;
let failedRows = [];
while (Date.now() < failureDeadline) {
	const failedList = await listTool.execute("t1-failed-list", {});
	failedRows = failedList.details?.rows ?? [];
	if (failedRows.some((row) => row.runId === failure.data.runId && row.state === "gone")) break;
	await sleep(100);
}
const failedRow = failedRows.find((row) => row.runId === failure.data.runId);
must(Boolean(failedRow) && failedRow.agentId === failure.data.agentId, "startup failure remains attributed to original run");
must(failedRow?.state === "gone", "failed run becomes discoverable in list as gone");
const registry = spawnEngine.readPersistedRegistry(owner);
writeFileSync(join(evidence, "live-summary.json"), JSON.stringify({ at: new Date().toISOString(), session: owner, accepted: accepted.details, failure: failure.data, registryCount: registry.length }, null, 2));
spawnEngine.clearSpawnRegistry();
spawnEngine.restoreSpawnRegistry(owner);
must(spawnEngine.spawnRecords().size === registry.length, "registry reload restores retained records");
must(existsSync(join(evidence, "live-summary.json")), `live evidence retained: ${join(evidence, "live-summary.json")}`);
console.log(`Evidence: ${join(evidence, "live-summary.json")}`);
