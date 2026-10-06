// Offline tests for the open message channel (issue 05): the resolution chain
// (pane-id / herdr name / registry handle). The reserved role "orchestrator"
// is only the direct parent pane (PI_HERDR_ORCHESTRATOR_PANE) — a live agent
// or spawn handle of that name does not take it. Physics-adaptive delivery
// (blocked → raw answer,
// otherwise enveloped), the receipt shapes, and the spawner-declared `from`
// identity chain.
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/message.mjs

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}
function eq(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

const msg = await jiti.import(join(ROOT, "src/tools/message.ts"), {
	parent: ROOT,
});
const spawnMod = await jiti.import(join(ROOT, "src/spawn.ts"), { parent: ROOT });

// ---- seam helpers -------------------------------------------------------------

const okGet = (paneId, name, status) => async () => ({
	ok: true,
	data: { paneId, name, status },
});
const notFound = () => async () => ({
	ok: false,
	error: { code: "NOT_FOUND", message: "no such agent" },
});
const recorder = () => {
	const calls = [];
	const fn = async (paneId, text, opts = {}) => {
		calls.push({ paneId, text, opts });
		return { ok: true, data: true };
	};
	fn.calls = calls;
	return fn;
};
/** A registry record like spawnAgent leaves behind. */
const record = (over = {}) => ({
	name: "scout",
	kind: "pi",
	type: "Explore",
	prompt: "do things",
	agentArgs: [],
	depth: 2,
	isolated: false,
	spawnedAt: 1,
	submitted: true,
	sawWorking: true,
	paneId: "w1:p9",
	stance: "interactive",
	...over,
});
const registryWith = (records) => () => {
	const m = new Map();
	for (const r of records) m.set(r.name, r);
	return m;
};
const DEPS = (over = {}) => ({
	registry: registryWith([]),
	agentGet: okGet("w1:p1", "scout", "idle"),
	send: recorder(),
	env: {},
	...over,
});

// ---------------------------------------------------------------------------
console.log("\n[1] Resolution chain — pane-id, herdr name, enrichment");
{
	const send = recorder();
	const r = await msg.messageAgent(
		{ target: "w1:p3", text: "hello" },
		DEPS({ agentGet: okGet("w1:p3", "scout", "idle"), send }),
	);
	assert(r.ok, "pane-id target resolves");
	assert(r.data.target === "w1:p3", "receipt carries the resolved pane id");
	assert(r.data.to === "scout", "to = herdr name");
	assert(send.calls[0].paneId === "w1:p3", "send hit the resolved pane");

	// registry enrichment: addressed by pane id, named by the spawn handle
	const r2 = await msg.messageAgent(
		{ target: "w1:p9", text: "hello" },
		DEPS({
			agentGet: okGet("w1:p9", "scout", "working"),
			registry: registryWith([record()]),
		}),
	);
	assert(r2.ok && r2.data.name === "scout", "byPane match names the handle");
}

console.log("\n[2] Resolution chain — registry handle states");
{
	// gone: herdr knows no such pane, registry does
	const gone = await msg.messageAgent(
		{ target: "scout", text: "hello" },
		DEPS({
			agentGet: notFound(),
			registry: registryWith([record()]),
		}),
	);
	assert(!gone.ok && gone.error.code === "NOT_FOUND", "gone handle errors");
	assert(
		gone.error.message.includes('"scout"') &&
			gone.error.message.includes("herdr_list_agents"),
		"gone error names the handle and points at list_agents",
	);

	// queued: accepted over the cap, no pane yet — nothing to deliver to
	const queued = await msg.messageAgent(
		{ target: "late", text: "hello" },
		DEPS({
			agentGet: notFound(),
			registry: registryWith([record({ name: "late", paneId: undefined })]),
		}),
	);
	assert(!queued.ok, "queued handle errors (no pane exists to type into)");
	assert(
		queued.error.message.includes("queued") &&
			queued.error.message.includes('"late"'),
		"queued error names the handle and the queued state",
	);

	// never started: deferred start failed
	const dead = await msg.messageAgent(
		{ target: "doa", text: "hello" },
		DEPS({
			agentGet: notFound(),
			registry: registryWith([
				record({
					name: "doa",
					paneId: undefined,
					startError: "boot gate timed out",
				}),
			]),
		}),
	);
	assert(
		dead.ok === false && dead.error.message.includes("never started"),
		"startError reads as never-started, not queued",
	);

	// transport failure ≠ gone — pass through honestly
	const transport = await msg.messageAgent(
		{ target: "scout", text: "hello" },
		DEPS({
			agentGet: async () => ({
				ok: false,
				error: { code: "HERDR_UNAVAILABLE", message: "server unreachable" },
			}),
			registry: registryWith([record()]),
		}),
	);
	assert(
		transport.ok === false &&
			transport.error.code === "HERDR_UNAVAILABLE",
		"transport error passes through (not misreported as gone)",
	);
}

console.log("\n[3] Reserved role — orchestrator");
{
	// unset env: the honest error
	const human = await msg.messageAgent(
		{ target: "orchestrator", text: "hello" },
		DEPS({ agentGet: notFound() }),
	);
	assert(!human.ok && human.error.code === "NOT_FOUND", "unset env errors");
	assert(
		human.error.message.includes("no orchestrator above you"),
		"honest wording: no orchestrator above you / answer in-conversation",
	);

	// set env resolves to the spawner's pane (herdr knows the pane id, not
	// the role name — the stub answers by target like the real CLI)
	const env = { PI_HERDR_ORCHESTRATOR_PANE: "w1:p0" };
	const send = recorder();
	const up = await msg.messageAgent(
		{ target: "orchestrator", text: "status?" },
		DEPS({
			agentGet: async (t) =>
				t === "w1:p0"
					? { ok: true, data: { paneId: "w1:p0", name: "the-boss", status: "working" } }
					: { ok: false, error: { code: "NOT_FOUND", message: "no such agent" } },
			env,
			send,
		}),
	);
	assert(up.ok && up.data.target === "w1:p0", "env pane resolves");
	assert(up.data.to === "orchestrator", "to = the role label");
	assert(send.calls[0].paneId === "w1:p0", "sent to the orchestrator pane");

	// set env but the orchestrator pane died
	const deadAbove = await msg.messageAgent(
		{ target: "orchestrator", text: "status?" },
		DEPS({ agentGet: notFound(), env }),
	);
	assert(
		deadAbove.ok === false &&
			deadAbove.error.message.includes("w1:p0"),
		"dead orchestrator pane errors naming the pane",
	);

	// a live agent named orchestrator must not take the reserved role
	const sendNamed = recorder();
	const named = await msg.messageAgent(
		{ target: "orchestrator", text: "hello" },
		DEPS({
			agentGet: async (t) => {
				if (t === "orchestrator")
					return { ok: true, data: { paneId: "w1:p7", name: "orchestrator", status: "idle" } };
				if (t === "w1:p0")
					return { ok: true, data: { paneId: "w1:p0", name: "the-boss", status: "working" } };
				return { ok: false, error: { code: "NOT_FOUND", message: "no such agent" } };
			},
			env,
			send: sendNamed,
		}),
	);
	assert(
		named.ok && named.data.target === "w1:p0" && named.data.to === "orchestrator",
		"same-name agent does not steal the alias; it still resolves to the parent pane",
	);
	assert(sendNamed.calls.length === 1 && sendNamed.calls[0].paneId === "w1:p0", "text went to the parent, not w1:p7");
	assert(!("name" in named.data), "no registry handle claimed for the role");

	// unset env stays the honest error even when that name is live in the fleet
	const sendUnset = recorder();
	const unsetNamed = await msg.messageAgent(
		{ target: "orchestrator", text: "hello" },
		DEPS({
			agentGet: okGet("w1:p7", "orchestrator", "idle"),
			send: sendUnset,
		}),
	);
	assert(
		unsetNamed.ok === false &&
			unsetNamed.error.message.includes("no orchestrator above you"),
		"unset env still says there is no orchestrator above you when a namesake is live",
	);
	assert(sendUnset.calls.length === 0, "unset env does not deliver to the namesake");
}

console.log("\n[4] No match");
{
	const none = await msg.messageAgent(
		{ target: "who-is-this", text: "hello" },
		DEPS({ agentGet: notFound() }),
	);
	assert(!none.ok && none.error.code === "NOT_FOUND", "unknown target errors");
	assert(
		none.error.message.includes("who-is-this") &&
			none.error.message.includes("herdr_list_agents"),
		"error names the target and points at list_agents",
	);
}

console.log("\n[5] Physics-adaptive delivery");
{
	// idle → enveloped
	const send = recorder();
	const idle = await msg.messageAgent(
		{ target: "scout", text: "focus on auth" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "idle"), send }),
	);
	const idleText = send.calls[0].text;
	assert(idle.ok && idle.data.delivery === "message", "idle → message receipt");
	assert(
		idleText.startsWith('<agent-message from="session" to="scout">') &&
			idleText.trimEnd().endsWith("</agent-message>") &&
			idleText.includes("focus on auth"),
		"idle payload is enveloped (from/to attributes + text inside)",
	);
	assert(idle.data.state === "idle", "receipt carries the observed state");

	// working → enveloped too
	const working = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "working"), send: recorder() }),
	);
	assert(working.data.delivery === "message", "working queues enveloped");

	// blocked → RAW text into the overlay (the message IS the answer)
	const bsend = recorder();
	const blocked = await msg.messageAgent(
		{ target: "scout", text: "option 2" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "blocked"), send: bsend }),
	);
	assert(
		blocked.ok && blocked.data.delivery === "answer",
		"blocked → answer receipt",
	);
	assert(
		eq(bsend.calls[0].text, "option 2"),
		"blocked payload is the raw text — no envelope",
	);

	// submit plumbing
	const withSub = await msg.messageAgent(
		{ target: "scout", text: "x", submit: false },
		DEPS({ send: recorder() }),
	);
	assert(withSub.data.submit === false, "submit=false echoed in the receipt");
	const sent = DEPS({ send: recorder() });
	await msg.messageAgent(
		{ target: "scout", text: "x", submit: false },
		sent,
	);
	assert(sent.send.calls[0].opts.submit === false, "submit=false reaches send");
	const def = DEPS({ send: recorder() });
	await msg.messageAgent({ target: "scout", text: "x" }, def);
	assert(def.send.calls[0].opts.submit === true, "submit defaults true");

	const eventSend = recorder();
	const withEvent = await msg.messageAgent(
		{ target: "scout", text: "the letter", eventId: "evt-msg-1" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "idle"), send: eventSend }),
	);
	assert(
		withEvent.ok &&
			eventSend.calls[0].text.includes('event="evt-msg-1"') &&
			withEvent.data.eventId === "evt-msg-1",
		"messageAgent({eventId}) puts event= on the envelope and eventId on the receipt",
	);
	const plainSend = recorder();
	const plain = await msg.messageAgent(
		{ target: "scout", text: "no id" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "working"), send: plainSend }),
	);
	assert(
		!plainSend.calls[0].text.includes("event=") && plain.data.eventId === undefined,
		"a message without eventId is not given one",
	);

	// send failure propagates
	const broken = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({
			send: async () => ({
				ok: false,
				error: { code: "VALIDATION_ERROR", message: "cannot encode" },
			}),
		}),
	);
	assert(!broken.ok && broken.error.code === "VALIDATION_ERROR", "send error propagates");
}

console.log("\n[6] `from` identity chain (spawner-declared, never verified)");
{
	assert(
		eq(msg.envelope("a", "b", "hi"), '<agent-message from="a" to="b">\nhi\n</agent-message>'),
		"envelope shape: <agent-message from to> wrapping the text",
	);
	assert(
		eq(
			msg.envelope("a", "b", "hi", "evt-9"),
			'<agent-message from="a" to="b" event="evt-9">\nhi\n</agent-message>',
		),
		"envelope with an eventId adds the event attribute",
	);

	const label = await msg.senderLabel(DEPS({ env: { PI_HERDR_AGENT_LABEL: "lab" } }));
	assert(eq(label, "lab"), "PI_HERDR_AGENT_LABEL wins");

	const name = await msg.senderLabel(DEPS({ env: { PI_HERDR_NAME: "scout-2" } }));
	assert(eq(name, "scout-2"), "PI_HERDR_NAME (what spawn stamps) is next");

	const paneName = await msg.senderLabel(
		DEPS({
			env: { HERDR_PANE_ID: "w1:p2" },
			agentGet: okGet("w1:p2", "pane-named", "idle"),
		}),
	);
	assert(eq(paneName, "pane-named"), "own pane's herdr name via HERDR_PANE_ID");

	const paneId = await msg.senderLabel(
		DEPS({ env: { HERDR_PANE_ID: "w1:p2" }, agentGet: notFound() }),
	);
	assert(eq(paneId, "w1:p2"), "pane id when the lookup fails");

	const session = await msg.senderLabel(DEPS({ env: {} }));
	assert(eq(session, "session"), '"session" when nothing is set (top-level)');
}

console.log("\n[7] Receipt shape + registration");
{
	const r = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "idle") }),
	);
	assert(
		eq(Object.keys(r.data).sort(), [
			"delivered",
			"delivery",
			"from",
			"state",
			"submit",
			"target",
			"to",
		]),
		"receipt keys for a foreign target: delivered/target/to/from/state/delivery/submit",
	);
	const ours = await msg.messageAgent(
		{ target: "scout", text: "x" },
		DEPS({
			agentGet: okGet("w1:p1", "scout", "idle"),
			registry: registryWith([record()]),
		}),
	);
	assert(ours.data.name === "scout", "receipt names the handle for our spawns");
	assert(r.data.delivered === true, "delivered is literally true");

	const tools = [];
	msg.registerMessageTool({ registerTool: (d) => tools.push(d), on: () => {} });
	assert(
		tools.some((t) => t.name === "herdr_message_agent"),
		"herdr_message_agent registered",
	);
	const tool = tools.find((t) => t.name === "herdr_message_agent");
	assert(
		!!tool.parameters.properties.target &&
			!!tool.parameters.properties.text &&
			!!tool.parameters.properties.submit,
		"schema: required target+text, optional submit",
	);
	// the description teaches receiving models the envelope tag
	assert(
		tool.description.includes("<agent-message"),
		"description documents the envelope tag (no child-side parsing — the model reads it)",
	);
	assert(
		tool.description.includes("herdr_send_keys"),
		"description carries the option-list caveat",
	);
}

console.log("\n[9] Sender transport does not own receiver admission or pending queues");
{
 const send = recorder();
 for (let i = 0; i < 25; i++) {
  const r = await msg.messageAgent({target:"scout",text:`n${i}`,pending:true}, DEPS({agentGet:okGet("w1:p1","scout","idle"),send,env:{PI_HERDR_AGENT_LABEL:"flood"}}));
  assert(r.ok && r.data.delivered && !r.data.queued, "legacy pending flag does not hold text in sender process");
 }
 assert(send.calls.length === 25, "receiver receives every transport input and applies its own shared budget");
 const answer = await msg.messageAgent({target:"scout",text:"raw answer"}, DEPS({agentGet:okGet("w1:p1","scout","blocked"),send}));
 assert(answer.ok && send.calls.at(-1).text === "raw answer", "blocked answer stays raw and exempt");
}

console.log("\n[9] Known generations — refuse a cross-generation send and name the handles");
{
	// gp spawned parent. parent spawned this sender (mid), sibling, and cousin.
	// mid spawned child. child spawned grandchild — one generation past mid.
	const GP = "/sessions/gp.jsonl";
	const PARENT = "/sessions/parent.jsonl";
	const MID = "/sessions/mid.jsonl";
	const CHILD = "/sessions/child.jsonl";
	const lin = (owner) => ({ rootSession: GP, ownerSession: owner });
	const parent = record({
		name: "parent",
		paneId: "w1:p0",
		sessionPath: PARENT,
		lineage: lin(GP),
	});
	const senderRec = record({
		name: "mid",
		paneId: "w1:p1",
		sessionPath: MID,
		lineage: lin(PARENT),
	});
	const sibling = record({
		name: "sibling",
		paneId: "w1:p2",
		sessionPath: "/sessions/sib.jsonl",
		lineage: lin(PARENT),
	});
	const child = record({
		name: "child",
		paneId: "w1:p3",
		sessionPath: CHILD,
		lineage: lin(MID),
	});
	const cousin = record({
		name: "cousin",
		paneId: "w1:p4",
		sessionPath: "/sessions/cousin.jsonl",
		lineage: lin(PARENT),
	});
	const grandchild = record({
		name: "grandchild",
		paneId: "w1:p5",
		sessionPath: "/sessions/grand.jsonl",
		lineage: lin(CHILD),
	});
	const mine = [child];
	const fleet = [
		{ name: "parent", paneId: "w1:p0" },
		{ name: "sibling", paneId: "w1:p2" },
		{ name: "child", paneId: "w1:p3" },
		{ name: "cousin", paneId: "w1:p4" },
		{ name: "grandchild", paneId: "w1:p5" },
	];
	const bySession = {
		[GP]: [parent],
		[PARENT]: [senderRec, sibling, cousin],
		[MID]: [child],
		[CHILD]: [grandchild],
	};
	const send = recorder();
	const deps = (over = {}) => ({
		registry: registryWith(mine),
		agentGet: async (t) => {
			const hit = fleet.find((a) => a.paneId === t || a.name === t);
			if (!hit)
				return { ok: false, error: { code: "NOT_FOUND", message: "no such agent" } };
			return { ok: true, data: { paneId: hit.paneId, name: hit.name, status: "idle" } };
		},
		send,
		list: async () => fleet,
		// A session with no registry file is empty. A throw is reserved for
		// the failed-read case below — missing is not a failure.
		readRegistry: (session) =>
			Object.prototype.hasOwnProperty.call(bySession, session)
				? [...bySession[session]]
				: [],
		env: {
			PI_HERDR_SESSION: MID,
			PI_HERDR_ROOT_SESSION: GP,
			PI_HERDR_ORCHESTRATOR_PANE: "w1:p0",
			PI_HERDR_NAME: "mid",
		},
		...over,
	});

	const same = await msg.messageAgent({ target: "sibling", text: "peer" }, deps());
	assert(
		same.ok === true && same.data.target === "w1:p2" && send.calls.at(-1).paneId === "w1:p2",
		"same generation (same ownerSession) explicit send succeeds",
	);

	const up = await msg.messageAgent({ target: "parent", text: "hi parent" }, deps());
	assert(
		up.ok === true && up.data.target === "w1:p0",
		"explicit send to the direct parent pane succeeds",
	);

	const down = await msg.messageAgent({ target: "child", text: "hi child" }, deps());
	assert(
		down.ok === true && down.data.target === "w1:p3",
		"explicit send to the sender's own direct child succeeds",
	);

	const alias = await msg.messageAgent({ target: "orchestrator", text: "status?" }, deps());
	assert(
		alias.ok === true && alias.data.to === "orchestrator" && alias.data.target === "w1:p0",
		"orchestrator still resolves only to the direct parent pane",
	);

	const before = send.calls.length;
	const skip = await msg.messageAgent({ target: "grandchild", text: "skip a generation" }, deps());
	const skipMsg = skip.ok ? "" : skip.error.message;
	const usable = skipMsg.split("Keep using:")[1] ?? "";
	assert(
		skip.ok === false &&
			skip.error.code === "VALIDATION_ERROR" &&
			skipMsg.includes('"grandchild"') &&
			usable.includes("parent") &&
			usable.includes("sibling") &&
			usable.includes("child") &&
			usable.includes("cousin") &&
			!usable.includes("grandchild"),
		"a known grandchild is refused and Keep using lists only the reachable handles",
	);
	assert(send.calls.length === before, "a refused cross-generation send is not redirected");

	const bareSend = recorder();
	const bare = await msg.messageAgent(
		{ target: "w1:p9", text: "stranger" },
		deps({
			send: bareSend,
			agentGet: async (t) =>
				t === "w1:p9" || t === "stranger"
					? { ok: true, data: { paneId: "w1:p9", name: "stranger", status: "idle" } }
					: {
							ok: false,
							error: { code: "NOT_FOUND", message: "no such agent" },
						},
		}),
	);
	assert(
		bare.ok === true && bare.data.target === "w1:p9" && bareSend.calls.length === 1,
		"an unowned bare pane (no registry, no lineage) still accepts an explicit pane-id",
	);

	const namedBare = await msg.messageAgent(
		{ target: "stranger", text: "by name" },
		deps({
			send: recorder(),
			agentGet: async (t) =>
				t === "stranger"
					? { ok: true, data: { paneId: "w1:p9", name: "stranger", status: "idle" } }
					: { ok: false, error: { code: "NOT_FOUND", message: "no such agent" } },
		}),
	);
	assert(
		namedBare.ok === true && namedBare.data.target === "w1:p9",
		"an unowned bare pane still accepts an explicit herdr name",
	);

	const broken = await msg.messageAgent(
		{ target: "sibling", text: "peer" },
		deps({ list: async () => { throw new Error("agent list down"); } }),
	);
	assert(
		broken.ok === false &&
			broken.error.message.includes("agent list down") &&
			!broken.error.message.includes("Delivered"),
		"a failed fleet query is an honest error, not permission to send",
	);

	const brokenReg = await msg.messageAgent(
		{ target: "sibling", text: "peer" },
		deps({
			readRegistry: () => {
				throw new Error("spawn registry unreadable");
			},
		}),
	);
	assert(
		brokenReg.ok === false && brokenReg.error.message.includes("spawn registry unreadable"),
		"a failed registry read is an honest error, not permission to send",
	);
}

console.log("\n[8] Registry contract — spawnRecords stays the shared home");
{
	spawnMod.clearSpawnRegistry();
	assert(
		spawnMod.spawnRecords().size === 0,
		"clearSpawnRegistry/spawnRecords exported for engine consumers",
	);
}

console.log(
	`\n${failed === 0 ? "✅ ALL PASS" : "❌ SOME FAILED"} (${passed}/${passed + failed})`,
);
process.exit(failed === 0 ? 0 : 1);
