// Spec 22 / ticket 23 — layer-2 verification: the Roster rides a dedicated
// `<agent-roster>` system-prompt section through a REAL pi runtime.
//
// The external model decision boundary is replaced by the deterministic
// circular-exchange provider (tests/fixtures). Everything else is real: the
// pi CLI, extension loading via jiti, before_agent_start emission, session
// transcript writes. Scenarios drive the actual pi binary headless (--print).
//
// Not covered here (stays with the TUI recipes): manual dialogs, live
// providers, herdr panes. Pre-existing (unrelated to spec 22): print-mode
// runs exit 1 via a stale-ctx ui.setStatus in src/index.ts session_start —
// the transcript is complete before that point, so the gate is on the
// transcript, not the exit code.
//
// Run: node tests/roster-section-live.mjs
// Evidence: .artifacts/verification/roster-section-live-<run-id>/

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const ART = join(ROOT, ".artifacts/verification", `roster-section-live-${RUN_ID}`);
mkdirSync(ART, { recursive: true });

const results = [];
const record = (scenario, ok, detail) => {
	results.push({ scenario, ok, detail });
	console.log(`${ok ? "✓" : "✗"} ${scenario}${detail ? ` — ${detail}` : ""}`);
};

function runPi({ session, extraArgs = [], prompt = "roster-probe", name, cwd = ROOT }) {
	const args = [
		"-ne", "-ns", "-np",
		"-e", join(ROOT, "tests/fixtures/turn-probe-entry.ts"),
		"-e", join(ROOT, "tests/fixtures/circular-exchange.ts"),
		...(extraArgs.flatMap((a) => (Array.isArray(a) ? a : [a]))),
		"--model", "circular-exchange/deterministic",
		"--thinking", "off",
		"--session", session,
		"-p", prompt,
	];
	const r = spawnSync("pi", args, { cwd, encoding: "utf8", timeout: 120_000 });
	const jsonl = existsSync(session) ? readFileSync(session, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { r, jsonl };
}

// Latest model-visible system-prompt sections: replay transcript in order,
// later system entries carry the full state (pi appends a diff entry when
// sections change mid-session; the final state is what the model sees).
function finalSections(jsonl) {
	let sections = null;
	for (const e of jsonl) {
		const m = e.message ?? {};
		if (m.role !== "system") continue;
		if (m.sections) sections = { ...sections, ...m.sections };
		if (m.sectionsDelta) {
			sections = sections ?? {};
			for (const [k, v] of Object.entries(m.sectionsDelta)) {
				if (v === null) delete sections[k]; else sections[k] = v;
			}
		}
	}
	return sections;
}

function countOccurrences(haystack, needle) {
	return haystack.split(needle).length - 1;
}

function assertRosterOnce(sections, label, mustInclude = []) {
	const roster = sections?.["agent-roster"];
	if (typeof roster !== "string") throw new Error(`${label}: agent-roster section missing`);
	const n = countOccurrences(roster, "<agent-roster>");
	if (n !== 1) throw new Error(`${label}: expected exactly one <agent-roster> tag pair, found ${n}`);
	if (!roster.includes("general-purpose")) throw new Error(`${label}: built-in layer missing from roster`);
	for (const name of mustInclude) {
		if (!roster.includes(`"${name}"`)) throw new Error(`${label}: roster missing "${name}"`);
	}
}

const simFixture = ["-e", join(ROOT, "tests/fixtures/roster-codemode-sim.ts")];

// S1 — baseline: real pi run, roster rides its section exactly once.
{
	const session = join(ART, "s1-baseline.jsonl");
	const { r, jsonl } = runPi({ session });
	const sections = finalSections(jsonl);
	let ok = true, detail = "";
	try {
		assertRosterOnce(sections, "S1");
		if (!sections["cwd"] || !sections["rules"]) throw new Error("core sections missing — sections damaged");
		if (sections["agent-roster"].includes("CODEMODE_SIM")) throw new Error("sim leak");
		detail = `roster ${sections["agent-roster"].length} bytes; sections: ${Object.keys(sections).join(",")}`;
	} catch (e) { ok = false; detail = e.message; }
	if (!jsonl.some((e) => e.message?.role === "assistant" && e.message.stopReason === "stop")) {
		ok = false; detail += "; no completed assistant turn";
	}
	record("S1 baseline: roster exactly once, core sections intact", ok, detail);
}

// S2/S3 — cross-extension ordering: a codemode-sim extension that (a) clobbers
// herdr_spawn_agent's description via prepareLoadout (the defect that motivated
// spec 22) and (b) writes its own section. Roster must survive both orders.
for (const [label, order] of [
	["S2 codemode-sim loads BEFORE herdr", [simFixture]],
	["S3 codemode-sim loads AFTER herdr", [[], simFixture]],
]) {
	const session = join(ART, `${label.slice(0, 2).toLowerCase()}-order.jsonl`);
	const { jsonl } = runPi({ session, extraArgs: order });
	const sections = finalSections(jsonl);
	let ok = true, detail = "";
	try {
		assertRosterOnce(sections, label);
		if (!sections["codemode-sim"]?.includes("CODEMODE_SIM_SECTION")) {
			throw new Error("sim's own section missing — sections cross-contaminated");
		}
		detail = "roster + sim section coexist; prepareLoadout clobber absorbed";
	} catch (e) { ok = false; detail = e.message; }
	record(`${label}: roster intact, other sections preserved`, ok, detail);
}

// S4 — active-tools gating. With the spawn tool excluded from the active set
// the section must be absent (no orphan menu advertising a dead tool).
{
	const session = join(ART, "s4-gated.jsonl");
	const { jsonl } = runPi({ session, extraArgs: ["--tools", "read,bash"] });
	const sections = finalSections(jsonl);
	const present = typeof sections?.["agent-roster"] === "string";
	record("S4 gating: spawn tool deactivated → roster section absent", !present,
		present ? "roster section leaked while tool inactive" : "no agent-roster key in final sections");
}

// S5 — refresh: registry change between turns must re-render on the next turn
// with no stale copy. Two runs share one session file and a scratch cwd; a
// project agent file (.pi/agents/) appears between them.
{
	const scratch = mkdtempSync(join(tmpdir(), "roster-refresh-"));
	mkdirSync(join(scratch, ".pi/agents"), { recursive: true });
	const session = join(ART, "s5-refresh.jsonl");
	const agentFile = join(scratch, ".pi/agents/refresh-probe-agent.md");
	const { jsonl: j1 } = runPi({ session, cwd: scratch, prompt: "roster-probe-1" });
	writeFileSync(agentFile, "---\nname: refresh-probe-agent\ndescription: Ticket 23 refresh probe.\n---\nbody\n");
	const { jsonl: j2 } = runPi({ session, cwd: scratch, prompt: "roster-probe-2" });
	const first = finalSections(j1)["agent-roster"] ?? "";
	const second = finalSections(j2)["agent-roster"] ?? "";
	let ok = true, detail = "";
	try {
		if (first.includes("refresh-probe-agent")) throw new Error("stale roster saw a not-yet-written agent");
		if (!second.includes("refresh-probe-agent")) throw new Error("refresh did not pick up the new agent");
		assertRosterOnce(finalSections(j2), "S5");
		detail = `run1 ${first.length}B → run2 ${second.length}B, new entry visible, exactly one section`;
	} catch (e) { ok = false; detail = e.message; }
	rmSync(scratch, { recursive: true, force: true });
	record("S5 refresh: roster change lands next run, no stale copy", ok, detail);
}

// S6 — determinism / prompt-cache conclusion: identical inputs must render
// byte-identical section text (no gratuitous cache invalidation).
{
	const s1 = join(ART, "s6a.jsonl"), s2 = join(ART, "s6b.jsonl");
	const a = finalSections(runPi({ session: s1 }).jsonl)["agent-roster"];
	const b = finalSections(runPi({ session: s2 }).jsonl)["agent-roster"];
	const identical = a === b;
	record("S6 determinism: identical registry → byte-identical section", identical,
		identical ? "cache-safe: section only changes when content changes" : "non-deterministic render — cache hazard");
}

const failed = results.filter((r) => !r.ok);
writeFileSync(join(ART, "summary.json"), JSON.stringify({ runId: RUN_ID, results, verdict: failed.length === 0 ? "GREEN" : "RED" }, null, 2));
console.log(`\n${failed.length === 0 ? "✅ ALL PASS" : "❌ FAILURES"} (${results.length - failed.length}/${results.length})`);
console.log(`evidence: ${ART}`);
process.exit(failed.length === 0 ? 0 : 1);
