// Public message engine with production subprocess transport and CLI-shaped receipts.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dir = mkdtempSync(join(tmpdir(), "herdr-message-transport-"));
const previousBin = process.env.HERDR_BIN;
const previousState = process.env.TEST_MESSAGE_STATE;
const log = join(dir, "calls.jsonl");
const bin = join(dir, "herdr");
writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
 console.log('herdr 0.9.3'); process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'get') {
 console.log(JSON.stringify({result: {agent: {
  pane_id: 'w1:p1', name: 'target', agent_status: process.env.TEST_MESSAGE_STATE
 }}})); process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'prompt' && process.env.TEST_MESSAGE_STATE === 'blocked') {
 console.log(JSON.stringify({error: {
  code: 'agent_blocked', message: 'requires interactive input'
 }})); process.exit(1);
}
console.log(JSON.stringify({result: {}}));
`, { mode: 0o700 });
process.env.HERDR_BIN = bin;

try {
	const jiti = createJiti(import.meta.url);
	const { messageAgent } = await jiti.import("../src/tools/message.ts");
	const run = async (state, submit = true) => {
		process.env.TEST_MESSAGE_STATE = state;
		writeFileSync(log, "");
		const result = await messageAgent(
			{ target: "target", text: "raw answer", submit },
			{ env: {}, registry: () => new Map() },
		);
		const calls = readFileSync(log, "utf8").trim().split("\n")
			.map(JSON.parse).filter((args) =>
				args[0] !== "--version" && !(args[0] === "agent" && args[1] === "get"),
			);
		return { result, calls };
	};

	let { result, calls } = await run("blocked");
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.data.delivery, "answer");
	assert.deepEqual(calls, [
		["pane", "send-text", "w1:p1", "raw answer"],
		["pane", "send-keys", "w1:p1", "Enter"],
	]);

	({ result, calls } = await run("blocked", false));
	assert.equal(result.ok, true);
	assert.deepEqual(calls, [["pane", "send-text", "w1:p1", "raw answer"]]);

	({ result, calls } = await run("working"));
	assert.equal(result.ok, true);
	assert.equal(result.data.delivery, "message");
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].slice(0, 3), ["agent", "prompt", "w1:p1"]);
	assert.match(calls[0][3], /<agent-message/);
	console.log("GREEN blocked default transport raw input; submit false; normal prompt unchanged");
} finally {
	if (previousBin === undefined) delete process.env.HERDR_BIN;
	else process.env.HERDR_BIN = previousBin;
	if (previousState === undefined) delete process.env.TEST_MESSAGE_STATE;
	else process.env.TEST_MESSAGE_STATE = previousState;
	rmSync(dir, { recursive: true, force: true });
}
