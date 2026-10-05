// Display fold for herdr-delivery custom messages (issue #30).
// The model still receives message.content in full; these assertions only
// cover the display string the renderer chooses from {expanded}.
//
// Run: node tests/delivery-render.mjs

import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { renderDeliveryDisplay } = jiti(join(ROOT, "src/delivery-render.ts"));

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
