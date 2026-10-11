import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Only the owned fixture executable is adapted; all other spawns (including
// the owned missing path) use the unmodified native boundary.
export function installSmokeSpawn(fixture) {
	const originalSpawn = childProcess.spawn;
	childProcess.spawn = (binary, args, options) => {
		if (binary !== fixture.binary) return originalSpawn(binary, args, options);
		if (options?.shell !== false) throw new Error("Smoke fixture requires shell:false");
		return originalSpawn(binary, [fixture.script, ...args], options);
	};
	syncBuiltinESMExports();
	return () => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); };
}

export function createSmokeFixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-herdr-smoke-fixture-"));
	const binary = process.execPath;
	const script = join(directory, "owned.mjs");
	const missing = join(directory, "missing-herdr");
	const log = join(directory, "calls.jsonl");
	writeFileSync(script, `import { appendFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({binary: process.execPath, script: process.argv[1], args}) + "\\n");
if (args[0] === "--fixture-identity") {
 console.log(JSON.stringify({result: {identity: "owned-smoke-fixture"}}));
} else if (args.join(" ") === "api schema --json") {
 console.log(JSON.stringify({result: {schemas: {}}}));
} else if (args[0] === "--version") {
 console.log(process.version);
} else if (args[0] === "-e") {
 runInThisContext(args[1]);
} else {
 console.error("Unexpected fixture argv");
 process.exit(97);
}
`, { mode: 0o700 });
	return { binary, script, missing, log, directory };
}

export function pinSmokeBinary(binary) {
	// The public resolver gives HERDR_BIN_PATH precedence over the legacy alias.
	process.env.HERDR_BIN_PATH = binary;
	process.env.HERDR_BIN = binary;
}
