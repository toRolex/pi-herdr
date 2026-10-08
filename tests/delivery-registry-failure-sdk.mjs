import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const jiti = createJiti(import.meta.url);
const sp = await jiti.import("../src/spawn.ts");
const dl = await jiti.import("../src/delivery.ts");
const dir = mkdtempSync(join(tmpdir(), "registry-fail-"));
const unhandled = [];
const listener = (error) => unhandled.push(String(error));
process.on("unhandledRejection", listener);
try {
	for (const adopted of [false, true]) {
		for (const failAt of [1, 2, 3]) {
			sp.clearSpawnRegistry();
			const root = join(dir, `root-${adopted}-${failAt}`);
			const mid = join(dir, `mid-${adopted}-${failAt}`);
			const leaf = join(dir, `leaf-${adopted}-${failAt}`);
			writeFileSync(leaf, "");
			writeFileSync(`${leaf}.exit`, JSON.stringify({ type: "done", text: "final", eventId: "failure" }));
			const child = { name: "leaf", kind: "pi", paneId: "w1:leaf", sessionPath: leaf, stance: "autonomous", lineage: { ownerSession: adopted ? mid : root, rootSession: root } };
			const owner = { name: "mid", kind: "pi", paneId: "w1:mid", sessionPath: mid, stance: "interactive", delivery: { kind: "done", at: 1 } };
			if (adopted) sp.writePersistedRegistry(mid, [child]);
			else sp.putSpawnRecordForTests(child);
			let writes = 0;
			let closes = 0;
			let pushes = 0;
			const deps = {
				...(adopted ? { registry: () => new Map([["mid", owner]]) } : {}),
				sessionPath: root,
				load: () => ({ notifications: "normal" }),
				fleet: { ok: true, data: [{ paneId: child.paneId, agentStatus: "done" }] },
				push: () => { pushes++; },
				closePane: async () => { closes++; return { ok: true }; },
				writeRegistry: (path, records) => {
					if (++writes === failAt) throw new Error("injected persistence failure");
					sp.writePersistedRegistry(path, records);
				},
			};
			const label = adopted ? "adopted" : "ordinary";
			await assert.rejects(dl.deliverOnce(deps), /persist|registry/i, `${label} write ${failAt} failure is awaited`);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(unhandled.length, 0, "persistence failure never becomes unhandled");
			assert.equal(pushes, 1);
			assert.equal(closes, failAt === 1 ? 0 : 1, `${label} pre-close failure cannot close`);
			if (failAt === 1) {
				assert.equal(adopted ? sp.readPersistedRegistry(mid)[0].delivery : child.delivery, undefined);
				continue;
			}
			const saved = JSON.parse(readFileSync(`${adopted ? mid : root}.registry.json`, "utf8"))[0];
			assert.equal(saved.delivery.kind, "done", `${label} terminal ack survives post-close persistence failure`);
			assert.equal(saved.paneClosePending, failAt === 2, `${label} close intent persists before close`);
			await dl.deliverOnce(deps);
			assert.equal(pushes, 1, `${label} retry never duplicates terminal push`);
			sp.clearSpawnRegistry();
			if (adopted) deps.registry = () => new Map([["mid", structuredClone(owner)]]);
			else sp.restoreSpawnRegistry(root);
			await dl.deliverOnce(deps);
			assert.equal(pushes, 1, `${label} restored retry never duplicates terminal push`);
			assert.equal(sp.readPersistedRegistry(adopted ? mid : root)[0].paneClosePending, false);
		}
	}
	console.log("delivery-registry-failure-sdk: passed");
} finally {
	process.off("unhandledRejection", listener);
	dl.stopDeliveryLoop();
	sp.clearSpawnRegistry();
	rmSync(dir, { recursive: true, force: true });
}
