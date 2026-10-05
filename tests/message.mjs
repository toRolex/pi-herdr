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

console.log("\n[9] Inbound rate limit — first over-limit send is one aggregate receipt");
{
	msg.resetInboundRateLimit();
	const send = recorder();
	const deps = () =>
		DEPS({
			agentGet: okGet("w1:p1", "scout", "idle"),
			send,
			env: { PI_HERDR_AGENT_LABEL: "flood" },
		});
	let last = null;
	for (let i = 0; i < 20; i++) {
		last = await msg.messageAgent({ target: "scout", text: `n${i}` }, deps());
		if (!last.ok) break;
	}
	assert(last.ok === true, "20 inbound messages from one sender in one window are delivered");
	assert(send.calls.length === 20, "those 20 actually hit the target pane");

	const refused = await msg.messageAgent({ target: "scout", text: "over" }, deps());
	assert(
		refused.ok === false && refused.error.code === "RATE_LIMITED",
		"the 21st inbound from that sender is refused",
	);
	const receipt = refused.ok ? "" : refused.error.message;
	assert(
		receipt.includes("Aggregate receipt") &&
			receipt.includes("refused 1") &&
			receipt.includes("20 messages per 10 seconds") &&
			receipt.includes("local") &&
			receipt.includes("same OS user") &&
			receipt.includes('"flood"') &&
			receipt.includes("not delivered"),
		"the refusal text is one aggregate receipt: limit, sender, and local same-OS-user scope",
	);
	assert(send.calls.length === 20, "the refusal is not typed into any pane (no receipt loop)");

	// further refusals fold into the next receipt instead of one error each
	const again = await msg.messageAgent({ target: "scout", text: "over-2" }, deps());
	const third = await msg.messageAgent({ target: "scout", text: "over-3" }, deps());
	assert(again.ok === false && third.ok === false, "later over-limit sends stay refused");
	assert(
		third.error.message.includes("refused 2") &&
			!third.error.message.includes("refused 1 "),
		"several refusals collapse into the next single aggregate receipt",
	);
	assert(send.calls.length === 20, "aggregated refusals never become outbound sends");
}

console.log("\n[10] Blocked-overlay answers are exempt from the inbound limit");
{
	msg.resetInboundRateLimit();
	const send = recorder();
	const deps = () =>
		DEPS({
			agentGet: okGet("w1:p1", "scout", "blocked"),
			send,
			env: { PI_HERDR_AGENT_LABEL: "answerer" },
		});
	let last = null;
	for (let i = 0; i < 25; i++) {
		last = await msg.messageAgent({ target: "scout", text: `answer ${i}` }, deps());
	}
	assert(last.ok === true && last.data.delivery === "answer", "a 25th blocked answer still lands");
	assert(send.calls.length === 25, "every blocked answer is typed into the overlay");
	assert(
		eq(send.calls[24].text, "answer 24"),
		"the exempt path stays raw overlay text, not an envelope",
	);

	// filling the inbound budget must not block a later overlay answer
	msg.resetInboundRateLimit();
	const limited = recorder();
	const env = { PI_HERDR_AGENT_LABEL: "answerer" };
	for (let i = 0; i < 20; i++) {
		await msg.messageAgent(
			{ target: "scout", text: `chat ${i}` },
			DEPS({ agentGet: okGet("w1:p1", "scout", "idle"), send: limited, env }),
		);
	}
	const still = await msg.messageAgent(
		{ target: "scout", text: "the answer" },
		DEPS({ agentGet: okGet("w1:p1", "scout", "blocked"), send: limited, env }),
	);
	assert(
		still.ok === true && still.data.delivery === "answer" && limited.calls.at(-1).text === "the answer",
		"an overlay answer still lands after that sender is already over the inbound limit",
	);
}

console.log("\n[11] The window is per sender, and it reopens");
{
	msg.resetInboundRateLimit();
	let clock = 1_000_000;
	const send = recorder();
	const one = (label) =>
		DEPS({
			agentGet: okGet("w1:p1", "scout", "idle"),
			send,
			env: { PI_HERDR_AGENT_LABEL: label },
			now: () => clock,
		});
	for (let i = 0; i < 20; i++) {
		await msg.messageAgent({ target: "scout", text: `a${i}` }, one("alpha"));
	}
	const other = await msg.messageAgent({ target: "scout", text: "from beta" }, one("beta"));
	assert(other.ok === true, "a different sender still has a full budget");
	const held = await msg.messageAgent({ target: "scout", text: "still over" }, one("alpha"));
	assert(held.ok === false, "alpha stays limited inside the window");
	clock += 10_001;
	const reopened = await msg.messageAgent({ target: "scout", text: "later" }, one("alpha"));
	assert(reopened.ok === true, "alpha is admitted again once the 10 second window has passed");
}

console.log("\n[12] Pending inbox — overflow drops the oldest, one aggregate receipt, drain keeps what was already typed");
{
	msg.resetPendingInbox();
	msg.resetInboundRateLimit();
	let clock = 5_000_000;
	const send = recorder();
	const from = (label, status) =>
		DEPS({
			agentGet: okGet("w1:p1", "scout", status),
			send,
			env: { PI_HERDR_AGENT_LABEL: label },
			now: () => clock,
		});

	const early = await msg.messageAgent(
		{ target: "scout", text: "already-in", pending: true },
		from("early", "working"),
	);
	assert(
		early.ok === true && early.data.delivered === true && early.data.queued !== true,
		"a working send is typed immediately and is not pending",
	);
	assert(
		send.calls.length === 1 && send.calls[0].text.includes("already-in"),
		"that delivery is already in the pane",
	);

	for (let i = 0; i < 8; i++) {
		clock += 1;
		const held = await msg.messageAgent(
			{ target: "scout", text: `payload-s${i}-end`, pending: true },
			from(`s${i}`, "idle"),
		);
		assert(
			held.ok === true && held.data.queued === true && held.data.delivered === false,
			`idle send s${i} is accepted pending and not typed`,
		);
	}
	assert(send.calls.length === 1, "eight pending messages are not typed while the target stays idle");

	clock += 1;
	const ninth = await msg.messageAgent(
		{ target: "scout", text: "payload-s8-end", pending: true },
		from("s8", "idle"),
	);
	assert(ninth.ok === true && ninth.data.queued === true, "the newest idle send is still accepted");
	const notice = ninth.ok ? ninth.data.notice ?? "" : "";
	assert(
		notice.includes("Aggregate receipt") &&
			notice.includes("dropped 1") &&
			notice.includes("oldest") &&
			notice.includes('"s0"') &&
			notice.includes("holds 8") &&
			notice.includes("not delivered") &&
			notice.includes("already-delivered text is kept") &&
			notice.includes("receiver"),
		"the first overflow is one aggregate receipt: dropped sender, cap 8, both sides, already-delivered kept",
	);
	assert(
		send.calls.length === 1 && !send.calls.some((c) => c.text.includes("Aggregate receipt") || c.text.includes("dropped")),
		"the receipt is not typed into the pane (no receipt loop)",
	);

	let folded = null;
	for (const label of ["s9", "s10", "s11"]) {
		clock += 1;
		const n = Number(label.slice(1));
		folded = await msg.messageAgent(
			{ target: "scout", text: `payload-s${n}-end`, pending: true },
			from(label, "idle"),
		);
	}
	const foldedNotice = folded && folded.ok ? folded.data.notice ?? "" : "";
	assert(
		folded.ok === true &&
			foldedNotice.includes("Folded into the open aggregate inbox receipt") &&
			foldedNotice.includes("dropped 4") &&
			foldedNotice.includes("no additional receipt") &&
			foldedNotice.includes('"s0"') &&
			foldedNotice.includes('"s3"') &&
			!foldedNotice.includes("Aggregate receipt"),
		"later drops in the same frozen burst fold into that one receipt",
	);
	assert(send.calls.length === 1, "folded receipts never become outbound sends");
	assert(send.calls[0].text.includes("already-in"), "the already-typed message is unchanged");

	clock += 1;
	const after = await msg.messageAgent(
		{ target: "scout", text: "after-drain", pending: true },
		from("tail", "done"),
	);
	assert(
		after.ok === true && after.data.delivered === true && after.data.queued !== true,
		"once the target is done the pending inbox drains and the new message is delivered",
	);
	assert(send.calls.length === 10, "drain types the eight survivors, then the new message");
	const survived = send.calls.slice(1, 9).map((c) => c.text);
	assert(
		[0, 1, 2, 3].every((i) => survived.every((t) => !t.includes(`payload-s${i}-end`))),
		"the four oldest pending messages are gone",
	);
	assert(
		survived[0].includes("payload-s4-end") && survived[7].includes("payload-s11-end"),
		"the survivors are typed oldest-first",
	);
	assert(send.calls[9].text.includes("after-drain"), "the post-drain message is typed last");
	assert(send.calls[0].text.includes("already-in"), "drain does not rewrite the earlier delivery");

	clock += 1;
	const fresh = await msg.messageAgent(
		{ target: "scout", text: "payload-new-end", pending: true },
		from("newcomer", "idle"),
	);
	assert(
		fresh.ok === true && fresh.data.queued === true && fresh.data.notice === undefined,
		"after drain the inbox is empty, so the next idle send is not a drop",
	);
	clock += 1;
	const owed = await msg.messageAgent(
		{ target: "scout", text: "payload-again-end", pending: true },
		from("s0", "idle"),
	);
	const owedNotice = owed.ok ? owed.data.notice ?? "" : "";
	assert(
		owed.ok === true &&
			owedNotice.includes('"s0"') &&
			owedNotice.includes("not delivered") &&
			owedNotice.includes("holds 8") &&
			owedNotice.includes("already-delivered text is kept") &&
			owedNotice.includes("not a new receipt") &&
			!owedNotice.startsWith("Aggregate receipt"),
		"the dropped sender hears it on their next call, still not as a second aggregate receipt",
	);
	assert(send.calls.length === 10, "that notice is not typed into the pane either");

	const tools = [];
	msg.registerMessageTool({ registerTool: (d) => tools.push(d), on: () => {} });
	const tool = tools.find((t) => t.name === "herdr_message_agent");
	assert(
		msg.PENDING_CAP === 8,
		"the pending cap is 8, the number the receipt names",
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
