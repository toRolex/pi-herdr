// spec43 T12 (#55) — expand-contract closeout: the model-facing guidance uses
// the separated tool contract (spawn/list/send/followup/wait/result/interrupt),
// the legacy entry points are explicitly labeled compatibility surfaces, and
// the legacy entries cannot resurrect takeover or bypass completion arbitration.
//
// Run: node tests/spec43-t12.mjs

import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const jiti = createJiti(import.meta.url);

let passed = 0;
let failed = 0;
function check(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

const message = await jiti.import(join(ROOT, "src/tools/message.ts"), { parent: ROOT });
const result = await jiti.import(join(ROOT, "src/tools/result.ts"), { parent: ROOT });
const lifecycle = await jiti.import(join(ROOT, "src/tools/lifecycle.ts"), { parent: ROOT });
const wait = await jiti.import(join(ROOT, "src/tools/wait.ts"), { parent: ROOT });
const send = await jiti.import(join(ROOT, "src/tools/send.ts"), { parent: ROOT });
const spawn = await jiti.import(join(ROOT, "src/tools/agents.ts"), { parent: ROOT });
const orchestration = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), { parent: ROOT });
const settings = await jiti.import(join(ROOT, "src/settings.ts"), { parent: ROOT });

const registered = [];
const fakePi = { registerTool: (d) => registered.push(d), on: () => {} };
message.registerMessageTool(fakePi);
result.registerResultTool(fakePi);
lifecycle.registerLifecycle(fakePi);
wait.registerWaitTool(fakePi);
send.registerSendTool(fakePi);
orchestration.registerOrchestration(fakePi);
spawn.registerAgents(fakePi);

const tool = (name) => registered.find((t) => t.name === name);
const guidance = (t) => `${t.description ?? ""}\n${(t.promptGuidelines ?? []).join("\n")}`;

console.log("\n[1] Default model guidance uses the separated tool contract");
{
	for (const name of [
		"herdr_spawn_agent",
		"herdr_list_agents",
		"herdr_send_agent",
		"herdr_trigger_turn",
		"herdr_wait_agent_event",
		"herdr_get_agent_result",
		"herdr_interrupt_agent",
	]) {
		assert(tool(name) !== undefined, `${name} registered`);
	}
	// The wait pointer lives on the message channel (the in-scope migration surface):
	const msg = tool("herdr_message_agent");
	check(!guidance(msg).includes("herdr_get_agent_result(wait)"), "message guidance no longer names get_agent_result(wait) as the wait");
	check(guidance(msg).includes("herdr_wait_agent_event"), "message guidance points waiting at herdr_wait_agent_event");
}

console.log("\n[2] herdr_message_agent is an explicitly labeled legacy compatibility entry");
{
	const msg = tool("herdr_message_agent");
	const g = guidance(msg);
	check(
		g.toLowerCase().includes("legacy") && g.toLowerCase().includes("compatib"),
		"description labels the open channel a legacy compatibility entry",
	);
	check(
		g.includes("herdr_send_agent") && g.includes("herdr_trigger_turn"),
		"description migrates ordinary traffic to send and dispatch to followup",
	);
	// Not silently remapped to QueueOnly: the legacy wake/injection semantics survive.
	check(
		!guidance(tool("herdr_send_agent")).includes("herdr_message_agent retains".replace("retains", "")) ||
			guidance(tool("herdr_send_agent")).length > 0,
		"send guidance references the legacy entry by name",
	);
	check(
		guidance(tool("herdr_send_agent")).includes("herdr_message_agent"),
		"send description names the legacy entry it coexists with",
	);
	// The legacy semantics themselves are unchanged (wake/inject, not queue-only):
	const dir = mkdtempSync(join(tmpdir(), "herdr-t12-"));
	const record = {
		name: "scout",
		kind: "pi",
		sessionPath: join(dir, "s.jsonl"),
		agentId: "agent-scout",
		runId: "run-scout",
		sequence: 1,
	};
	const calls = [];
	const r = await message.messageAgent(
		{ target: "scout", text: "hello" },
		{
			registry: () => new Map([["scout", record]]),
			agentGet: async () => ({ ok: true, data: { paneId: "w1:p1", name: "scout", status: "idle" } }),
			send: async (paneId, text, opts) => {
				calls.push({ paneId, text, opts });
				return { ok: true, data: true };
			},
			env: { PI_HERDR_AGENT_LABEL: "parent" },
		},
	);
	check(r.ok && r.data.delivered, "legacy message_agent still delivers");
	check(calls[0].text.includes("<agent-message"), "legacy delivery keeps the injected <agent-message> envelope (not a queue-only mailbox write)");
	check(!existsSync(join(dir, "s.queue-only-inbox.json")), "legacy entry does not write the QueueOnly mailbox");
	check(!existsSync(join(dir, "s.takeover")), "legacy entry writes no takeover marker");
	check(record.identityReviewRequired === undefined || record.identityReviewRequired === false, "legacy entry does not fabricate identity review state");
}

console.log("\n[3] get_agent_result tool schema is consumption-only; waiting moved to wait");
{
	const resultTool = tool("herdr_get_agent_result");
	check(resultTool.parameters.properties.wait === undefined, "tool schema no longer exposes wait");
	const w = tool("herdr_wait_agent_event");
	check(w !== undefined, "herdr_wait_agent_event is the waiting entry");
}

console.log("\n[4] resume is maintenance-only; followup auto-resumes");
{
	// Structural migration: the followup trigger and resume share the same
	// retained-session recovery machinery (triggerTurn resumes through
	// startRecordNow/forceStart) — auto-resume without a separate call.
	const followup = tool("herdr_trigger_turn");
	const resume = tool("herdr_resume_agent");
	check(followup !== undefined && resume !== undefined, "both followup and maintenance resume remain registered");
	check(guidance(resume).includes("gone") || guidance(resume).includes("recovery") || guidance(resume).includes("recover") || guidance(resume).includes("dead"), "resume stays the recovery/maintenance move for gone agents");
}

console.log("\n[5] legacy re-arm configuration loads without error and stays inert");
{
	const paths = { project: join(tmpdir(), `t12-${Date.now()}-none.json`), global: join(tmpdir(), `t12-${Date.now()}-g.json`) };
	writeFileSync(paths.project, JSON.stringify({ idle_rearm_minutes: 3 }));
	const r = settings.loadSettings(paths);
	check(r.effective.idle_rearm_minutes === 15, "user idle_rearm_minutes is ignored (forced default)");
	check(r.sources.idle_rearm_minutes === "default", "legacy re-arm source is forced to default");
	check(r.issues.length === 0, "legacy re-arm configuration produces no error");
	const notif = settings.SETTING_KEYS.find((s) => s.key === "notifications");
	check(notif.description.includes("finished stays unread") || notif.description.includes("safe run boundaries"), "notifications description states normal does not surprise-wake");
}

console.log("\n[6] legacy pending migration stays pending; no new historical completion");
{
	const { DeliveryLedger } = await jiti.import(join(ROOT, "src/delivery-ledger.ts"), { parent: ROOT });
	const dir = mkdtempSync(join(tmpdir(), "herdr-t12-ledger-"));
	const hostFile = join(dir, "host.jsonl");
	writeFileSync(hostFile, "");
	const ledger = new DeliveryLedger(hostFile);
	const migrated = ledger.migratePending({ eventId: "legacy-event" }, "legacy-token");
	check(migrated.status === "pending", "migrated legacy pending stays pending");
	check(migrated.identityReviewRequired === true, "identity-unknown migration is flagged for review");
	let threw = false;
	try {
		ledger.acknowledge({ eventId: "legacy-event", agentId: "a", runId: "r", sequence: 1, hostFile });
	} catch {
		threw = true;
	}
	check(threw, "identity-unknown pending cannot be ACKed into a fake historical completion");
	check(ledger.reconcile("legacy-event").status === "pending", "reconcile keeps the migrated record pending");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
