// Display fold for herdr-delivery custom messages (issue #30), plus the
// presentation merge for one business event on two channels (issue #38).
// The model still receives message.content in full; these assertions only
// cover the display string the renderer chooses from {expanded}.
//
// Run: node tests/delivery-render.mjs

import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { renderDeliveryDisplay, presentNotices } = jiti(
	join(ROOT, "src/delivery-render.ts"),
);

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

const letter = {
	content: "done\nline-two",
	details: { name: "scout", kind: "done" },
};

const folded = renderDeliveryDisplay(letter, false);
const opened = renderDeliveryDisplay(letter, true);
assert(folded !== opened, "same message differs when expanded flips");
assert(
	folded === "herdr-delivery · scout · done · 13 chars",
	`folded summary names agent, kind, and char count (got ${JSON.stringify(folded)})`,
);
assert(opened === "done\nline-two", `expanded display is the full body (got ${JSON.stringify(opened)})`);

const empty = {
	content: "   \n",
	details: { name: "scout", kind: "done" },
};
const emptyLine = renderDeliveryDisplay(empty, false);
assert(
	emptyLine === "herdr-delivery · scout · done · empty result",
	`empty body is one explicit line (got ${JSON.stringify(emptyLine)})`,
);
assert(!emptyLine.includes("\n"), "empty-result display stays a single line");

const explained = {
	content: 'Agent "scout" finished — full final message:\n\n(the child finished but its session file holds no assistant message)',
	details: { name: "scout", kind: "done" },
};
const explainedLine = renderDeliveryDisplay(explained, false);
assert(
	explainedLine === "herdr-delivery · scout · done · empty result",
	`the no-assistant sentence folds as an empty result (got ${JSON.stringify(explainedLine)})`,
);
assert(!explainedLine.includes("chars"), "empty-result sentence is not a char count");

const legacy = { details: { name: "scout", kind: "done" } };
const legacyLine = renderDeliveryDisplay(legacy, false);
assert(
	legacyLine === "herdr-delivery · scout · done · empty result",
	`legacy empty result (no content field) is one line (got ${JSON.stringify(legacyLine)})`,
);
assert(!legacyLine.includes("\n"), "legacy empty result stays a single line");

const modelContent = "paragraph one\n\nparagraph two keeps every character";
const modelMessage = {
	content: modelContent,
	details: { name: "scout", kind: "done" },
};
assert(
	modelMessage.content === modelContent,
	"model-facing content is not truncated by display folding",
);
assert(
	renderDeliveryDisplay(modelMessage, true) === modelContent,
	"expanded display returns the same full content the model receives",
);

// ---- issue #38: one presented notice per eventId ----------------------------
// Arrival order is the transcript order. A live agent-message and the
// terminal completion that share eventId collapse to the completion.
// Progress (no eventId, or a different one) stays. Reload is just the same
// transcript presented again — no second copy appears.

const live = (eventId, text = "still working") => ({
	role: "custom",
	customType: "herdr-agent-message",
	content: `<agent-message from="scout" to="orchestrator">\n${text}\n</agent-message>`,
	display: true,
	details: { eventId, from: "scout", to: "orchestrator" },
});
const done = (eventId, text = "final letter") => ({
	role: "custom",
	customType: "herdr-delivery",
	content: text,
	display: true,
	details: { name: "scout", kind: "done", eventId, result: text },
});
const progress = (text) => ({
	role: "user",
	content: `<agent-message from="scout" to="orchestrator">\n${text}\n</agent-message>`,
});

function visible(entries) {
	return presentNotices(entries).filter((entry) => entry.display !== false);
}

{
	const messageFirst = visible([live("evt-1", "live"), done("evt-1", "final")]);
	assert(
		messageFirst.length === 1 && messageFirst[0].customType === "herdr-delivery",
		"message then completion: one notice, the completion",
	);
	assert(
		messageFirst[0].content === "final",
		"message-first merge keeps the completion body",
	);

	const completionFirst = visible([done("evt-1", "final"), live("evt-1", "live")]);
	assert(
		completionFirst.length === 1 && completionFirst[0].content === "final",
		"completion then message: still one notice, the completion",
	);
}

{
	const reloaded = visible([live("evt-1"), done("evt-1", "final")]);
	const again = visible(reloaded);
	assert(
		again.length === 1 && again[0].content === "final",
		"reload of an already merged transcript does not present a second copy",
	);
}

{
	const both = visible([
		live("evt-1", "one"),
		done("evt-1", "final-one"),
		live("evt-2", "two"),
		done("evt-2", "final-two"),
	]);
	assert(
		both.length === 2 &&
			both[0].content === "final-one" &&
			both[1].content === "final-two",
		"different event ids stay two notices",
	);
}

{
	const withProgress = visible([
		progress("checkpoint"),
		live("evt-1", "live"),
		done("evt-1", "final"),
	]);
	assert(
		withProgress.length === 2 &&
			withProgress[0].content.includes("checkpoint") &&
			withProgress[1].content === "final",
		"a progress message without eventId is not merged away",
	);
}

{
	const lone = visible([live("evt-9", "only the live note")]);
	assert(
		lone.length === 1 && lone[0].content.includes("only the live note"),
		"a live message whose completion has not arrived is still presented",
	);
}

// The pair is built from real push details and a real message receipt, not
// a hand-written two-line fixture. Order and reload both collapse to the
// completion. A blocked row and a different eventId stay.
{
	const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), { parent: ROOT });
	const sf = await jiti.import(join(ROOT, "src/sessionfile.ts"), { parent: ROOT });
	const msg = await jiti.import(join(ROOT, "src/tools/message.ts"), { parent: ROOT });
	const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-present-"));
	const sess = join(dir, "s.jsonl");
	writeFileSync(
		sess,
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final letter" }],
				stopReason: "stop",
			},
		}) + "\n",
	);
	writeFileSync(
		`${sess}.exit`,
		JSON.stringify({ type: "done", text: "final letter", eventId: "evt-real" }),
	);
	const read = sf.readExitSidecar(sess);
	const pushes = [];
	const record = {
		name: "scout",
		kind: "pi",
		paneId: "w1:scout",
		sessionPath: sess,
		stance: "autonomous",
		submitted: true,
		sawWorking: true,
	};
	await delivery.deliverOnce({
		registry: () => new Map([[record.name, record]]),
		load: () => ({ notifications: "normal" }),
		list: async () => ({
			ok: true,
			data: [{ paneId: record.paneId, agentStatus: "done" }],
		}),
		push: (m) => pushes.push(m),
		closePane: async () => {},
		now: () => 1,
	});
	const sendCalls = [];
	const sent = await msg.messageAgent(
		{ target: "scout", text: "still working", eventId: "evt-real" },
		{
			registry: () => new Map(),
			agentGet: async () => ({
				ok: true,
				data: { paneId: "w1:p1", name: "orchestrator", status: "idle" },
			}),
			send: async (paneId, text) => {
				sendCalls.push(text);
				return { ok: true, data: true };
			},
			env: { PI_HERDR_NAME: "scout" },
		},
	);
	const pushDetails = pushes[0]?.details;
	const messageDetails = sent.data;
	assert(
		read.state === "ok" &&
			pushDetails?.eventId === "evt-real" &&
			messageDetails?.eventId === "evt-real" &&
			sendCalls[0]?.includes('event="evt-real"'),
		"the presented pair is the real push details and the real message receipt",
	);
	const messageRow = {
		role: "custom",
		customType: "herdr-agent-message",
		content: sendCalls[0],
		display: true,
		details: messageDetails,
	};
	const doneRow = {
		role: "custom",
		customType: "herdr-delivery",
		content: pushes[0].content,
		display: true,
		details: pushDetails,
	};
	const blockedRow = {
		role: "custom",
		customType: "herdr-delivery",
		content: "blocked",
		display: true,
		details: { name: "scout", kind: "blocked" },
	};
	const other = {
		role: "custom",
		customType: "herdr-agent-message",
		content: "other event",
		display: true,
		details: { eventId: "evt-other", from: "scout", to: "orchestrator" },
	};
	const messageFirst = visible([blockedRow, messageRow, doneRow, other]);
	assert(
		messageFirst.length === 3 &&
			messageFirst[0].details.kind === "blocked" &&
			messageFirst[1].customType === "herdr-delivery" &&
			messageFirst[1].details.eventId === "evt-real" &&
			messageFirst[2].details.eventId === "evt-other",
		"message then completion: blocked and a different eventId stay, the paired message is gone",
	);
	const completionFirst = visible([doneRow, messageRow]);
	assert(
		completionFirst.length === 1 && completionFirst[0].customType === "herdr-delivery",
		"completion then message: only the completion remains",
	);
	const again = visible(messageFirst);
	assert(
		again.length === messageFirst.length && again[1] === messageFirst[1],
		"reload of the same presented array does not add a row",
	);
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
