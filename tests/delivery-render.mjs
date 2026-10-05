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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
