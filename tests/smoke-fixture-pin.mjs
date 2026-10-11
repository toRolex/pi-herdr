import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import { createSmokeFixture, pinSmokeBinary, installSmokeSpawn } from "./smoke-fixture.mjs";

const fixture = createSmokeFixture();
assert.equal(fixture.binary, process.execPath, 'fixture executes a real native binary on every platform, not a shebang script');
const restoreSpawn = installSmokeSpawn(fixture);
const { resolveHerdrBin } = await import('../src/herdr-transport.mjs');
// A safe owned stand-in for an inherited real-binary override. The resolver
// guard must pass before any public CLI call is allowed to execute.
process.env.HERDR_BIN_PATH = fixture.missing;
pinSmokeBinary(fixture.binary);
assert.equal(resolveHerdrBin(), fixture.binary,
	"fixture pin must override inherited HERDR_BIN_PATH before spawning");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { herdr, refreshHerdrProbe } = await jiti.import("../src/herdr.ts");
assert.equal((await refreshHerdrProbe()).state, "ok");
assert.deepEqual(await herdr(["--fixture-identity"]), {
	ok: true, data: { identity: "owned-smoke-fixture" },
});
process.env.HERDR_BIN = fixture.missing;
assert.equal(resolveHerdrBin(), fixture.binary, 'primary pin wins over conflicting legacy alias');
const argv = ['space separated', '"quoted"', 'C:\\owned path\\file', '& | ; $HOME', '', '中文'];
const program = 'console.log(JSON.stringify({result:{args:process.argv.slice(4)}}))';
assert.deepEqual(await herdr(['-e', program, ...argv]), {ok:true, data:{args:argv}}, 'native shell:false preserves positional argv without shell expansion');
pinSmokeBinary(fixture.missing);
assert.equal(resolveHerdrBin(), fixture.missing);
assert.equal((await refreshHerdrProbe()).state, "missing");
assert.equal((await herdr(["agent", "list"])).error.code, "HERDR_UNAVAILABLE");
const calls = readFileSync(fixture.log, "utf8").trim().split("\n").map(JSON.parse);
assert.deepEqual(calls.map(call => call.args), [["--version"], ["--fixture-identity"], ['-e', program, ...argv]]);
assert(calls.every(call => call.binary === fixture.binary && call.script === fixture.script));
restoreSpawn();
console.log(JSON.stringify({ status: "PASS", fixture, calls }));
