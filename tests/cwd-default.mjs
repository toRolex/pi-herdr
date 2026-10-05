// Live test: the launch path's cwd default (startHerdrAgent machinery).
// Regression: without --cwd, herdr spawns panes in the DAEMON's cwd (home for a
// restored headless session), not the caller's project. The machinery now
// defaults cwd to process.cwd(). (herdr_start_agent died with the v0.6 surface
// cut; startHerdrAgent is the same code every spawn goes through.)
// Run this from a cwd DIFFERENT from the herdr daemon's cwd, else the two are
// indistinguishable:
//   cd some-temp-dir && node tests/cwd-default.mjs
// Requires a running herdr session. Closes the pane it creates.

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const orch = await jiti.import(join(ROOT, "src/tools/orchestration.ts"), {
	parent: ROOT,
});
const { herdr } = await jiti.import(join(ROOT, "src/herdr.ts"), {
	parent: ROOT,
});

const NAME = `cwd-fix-${Date.now()}`;
const r = await orch.startHerdrAgent({ name: NAME, agent: "pi" });
const agentObj = r.ok && r.data?.agent ? r.data.agent : {};
const paneId = agentObj.pane_id ?? agentObj.paneId ?? null;
if (!r.ok || !paneId) {
	console.log(
		"✗ startHerdrAgent failed:",
		JSON.stringify(r.ok ? r.data : r.error),
	);
	process.exit(1);
}

try {
	const get = await herdr(["pane", "get", paneId], { timeoutMs: 10_000 });
	const cwd = get.ok ? (get.data?.pane?.cwd ?? get.data?.cwd) : undefined;
	const pass = cwd === process.cwd();
	console.log(
		`${pass ? "✓" : "✗"} pane ${paneId} cwd=${cwd} (expected ${process.cwd()})`,
	);
	if (!pass) process.exitCode = 1;
} finally {
	await herdr(["pane", "close", paneId], { timeoutMs: 10_000 });
}

// Explicit cwd: herdr 0.9.3 accepts --cwd on tab create / pane split but
// ignores it, so startHerdrAgent types a cd into the shell before the agent
// attaches. Compare realpaths — /tmp is a symlink on macOS.
{
	const { mkdtempSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const target = mkdtempSync(join(tmpdir(), "spawn-cwd-live-"));
	const NAME2 = `cwd-explicit-${Date.now()}`;
	const r = await orch.startHerdrAgent({ name: NAME2, agent: "pi", cwd: target });
	const agentObj = r.ok && r.data?.agent ? r.data.agent : {};
	const paneId = agentObj.pane_id ?? agentObj.paneId ?? null;
	if (!r.ok || !paneId) {
		console.log("✗ explicit-cwd spawn failed:", JSON.stringify(r.ok ? r.data : r.error));
		process.exitCode = 1;
	} else {
		try {
			// Give the shell time to process the typed cd and boot the agent.
			await new Promise((res) => setTimeout(res, 4_000));
			const get = await herdr(["pane", "get", paneId], { timeoutMs: 10_000 });
			const pane = get.ok ? get.data?.pane : undefined;
			const cwd = pane?.foreground_cwd ?? pane?.cwd;
			const pass = cwd && realpathSync(cwd) === realpathSync(target);
			console.log(`${pass ? "✓" : "✗"} explicit cwd: pane cwd=${cwd} (expected ${target})`);
			if (!pass) process.exitCode = 1;
		} finally {
			await herdr(["pane", "close", paneId, "--force"], { timeoutMs: 10_000 });
		}
	}
}
