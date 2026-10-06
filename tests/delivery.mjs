// Offline tests for push delivery + user takeover + idle re-arm (issue 06).
//
// Sections:
//   [1] sessionfile: sidecar rearm typing, takeover/steer markers, the
//       steer-watermark matcher (human typing vs the parent's own steering)
//   [2] child extension: takeover flag/marker, idle re-arm timer, error-grace
//       suppression under takeover
//   [3] delivery loop: the three detection routes, wake flags, push labels,
//       single-push dedupe, takeover suppression
//
// No live herdr server required: every herdr-facing seam is injected.
//
// Run: node tests/delivery.mjs

import { createJiti } from "jiti";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sf = await jiti.import(join(ROOT, "src/sessionfile.ts"), {
	parent: ROOT,
});

// temp area for real marker files (the helpers use the real fs, like
// readExitSidecar — substrates stay honest by testing against disk)
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-delivery-"));

// ---------------------------------------------------------------------------
console.log("\n[1] Sidecar rearm + takeover/steer markers");
{
	// rearm typing
	assert(
		sf.parseExitSidecar('{"type":"done"}').sidecar.rearm === undefined,
		"plain done sidecar carries no rearm (back-compat)",
	);
	assert(
		sf.parseExitSidecar('{"type":"done","rearm":true}').sidecar.rearm === true,
		"done + rearm parses",
	);
	const errS = sf.parseExitSidecar(
		'{"type":"error","errorMessage":"overload","stopReason":"error","rearm":true}',
	).sidecar;
	assert(
		errS.rearm === true && errS.errorMessage === "overload",
		"error + rearm parses with the mined message",
	);
	assert(
		sf.parseExitSidecar('{"type":"done","rearm":"yes"}').sidecar.rearm ===
			undefined,
		"non-boolean rearm ignored (tolerant)",
	);
	assert(
		sf.parseExitSidecar('{"type":"done","unknown":{"x":1}}').ok === true,
		"unknown fields tolerated (forward compat)",
	);
	const withText = sf.parseExitSidecar(
		'{"type":"done","text":"The scan found 3 issues."}',
	).sidecar;
	assert(
		withText.type === "done" && withText.text === "The scan found 3 issues.",
		"done sidecar keeps the committed final text",
	);
	assert(
		sf.parseExitSidecar('{"type":"done"}').sidecar.text === undefined,
		"old done sidecar without text still parses",
	);
	assert(
		sf.parseExitSidecar('{"type":"done","text":""}').sidecar.text === undefined &&
			sf.parseExitSidecar('{"type":"done","text":"   "}').sidecar.text ===
				undefined &&
			sf.parseExitSidecar('{"type":"done","text":12}').sidecar.text ===
				undefined,
		"blank or non-string sidecar text is treated as absent",
	);
	const withBoth = sf.parseExitSidecar(
		'{"type":"done","text":"final","rearm":true,"structured":"{\\"ok\\":true}"}',
	).sidecar;
	assert(
		withBoth.text === "final" &&
			withBoth.rearm === true &&
			withBoth.structured === '{"ok":true}',
		"sidecar text rides alongside rearm and structured",
	);
	const withRoot = sf.parseExitSidecar(
		'{"type":"done","text":"grandchild letter","rootSession":"/root/session.jsonl"}',
	).sidecar;
	assert(
		withRoot.rootSession === "/root/session.jsonl" &&
			withRoot.text === "grandchild letter",
		"done sidecar keeps the root session pointer with the committed text",
	);
	assert(
		sf.parseExitSidecar('{"type":"done"}').sidecar.rootSession === undefined &&
			sf.parseExitSidecar('{"type":"done","rootSession":""}').sidecar
				.rootSession === undefined &&
			sf.parseExitSidecar('{"type":"done","rootSession":12}').sidecar
				.rootSession === undefined,
		"a missing, blank, or non-string root pointer is absent",
	);
	const withEvent = sf.parseExitSidecar(
	'{"type":"done","eventId":"evt-done-1"}',
).sidecar;
assert(
	withEvent.eventId === "evt-done-1",
	"done sidecar keeps a business eventId",
);
const errEvent = sf.parseExitSidecar(
	'{"type":"error","errorMessage":"overload","stopReason":"error","eventId":"evt-err-1"}',
).sidecar;
assert(
	errEvent.eventId === "evt-err-1" && errEvent.errorMessage === "overload",
	"error sidecar keeps a business eventId",
);
assert(
	sf.parseExitSidecar('{"type":"done"}').sidecar.eventId === undefined &&
		sf.parseExitSidecar('{"type":"done","eventId":""}').sidecar.eventId ===
			undefined &&
		sf.parseExitSidecar('{"type":"done","eventId":12}').sidecar.eventId ===
			undefined,
	"an old sidecar with no eventId, or a blank/non-string one, still parses without inventing an id",
);

const errRoot = sf.parseExitSidecar(
		'{"type":"error","errorMessage":"boom","stopReason":"error","rootSession":"/root/session.jsonl"}',
	).sidecar;
	assert(
		errRoot.rootSession === "/root/session.jsonl" &&
			errRoot.errorMessage === "boom",
		"error sidecar keeps the root session pointer",
	);
	assert(
		sf.refuseBareDone("") !== null &&
			sf.refuseBareDone("   ") !== null &&
			sf.refuseBareDone(undefined) !== null,
		"bare agent_done is refused when the session has no assistant text",
	);
	assert(
		typeof sf.refuseBareDone("") === "string" &&
			sf.refuseBareDone("").length > 0,
		"the refusal is a non-empty message the model can correct from",
	);
	assert(
		sf.refuseBareDone("The scan found 3 issues.") === null,
		"agent_done is allowed once assistant text exists",
	);

	// takeover marker
	const sess = join(tmp, "a.jsonl");
	assert(sf.readTakeoverMarker(sess).taken === false, "no marker = not taken");
	writeFileSync(sf.takeoverPathFor(sess), "{}");
	const t = sf.readTakeoverMarker(sess);
	assert(t.taken === true, "marker present = taken");
	assert(typeof t.at === "number", "marker carries its mtime");

	// steer watermark + matcher
	assert(sf.readSteerWatermark(sess) === null, "no watermark = null");
	sf.writeSteerWatermark(sess, "scan the repo and report\nfailures");
	assert(
		sf.readSteerWatermark(sess)?.startsWith("scan the repo"),
		"watermark round-trips",
	);
	assert(
		sf.inputMatchesSteer("scan the repo and report\nfailures", sf.readSteerWatermark(sess)) ===
			true,
		"exact steer text matches",
	);
	assert(
		sf.inputMatchesSteer("  scan  the repo and report failures \n", sf.readSteerWatermark(sess)) ===
			true,
		"whitespace-insensitive match (chunked/pasted delivery)",
	);
	assert(
		sf.inputMatchesSteer("2", "2") === true,
		"short option-list answer matches its watermark",
	);
	assert(
		sf.inputMatchesSteer("let me just fix this myself", sf.readSteerWatermark(sess)) ===
			false,
		"a human's own words do not match",
	);
	assert(
		sf.inputMatchesSteer(undefined, "anything") === false &&
			sf.inputMatchesSteer("x", null) === false,
		"missing input or watermark never matches",
	);
	sf.clearSteerWatermark(sess);
	assert(
		sf.readSteerWatermark(sess) === null && !existsSync(sf.steerPathFor(sess)),
		"clear consumes the watermark",
	);
	sf.clearSteerWatermark(sess); // second clear is a harmless no-op
	assert(true, "double clear does not throw");
}

// ---------------------------------------------------------------------------
console.log("\n[2] Child extension — takeover + idle re-arm");
{
	const child = await jiti.import(join(ROOT, "src/child.ts"), { parent: ROOT });

	function makePi() {
		const registered = {
			widgets: {},
			tools: [],
			handlers: {},
			sessionName: undefined,
		};
		const mockPi = {
			setSessionName: (n) => (registered.sessionName = n),
			getAllTools: () => [],
			setWidget: (key, lines) => (registered.widgets[key] = lines),
			registerShortcut: () => {},
			registerTool: (t) => registered.tools.push(t),
			on: (ev, h) => (registered.handlers[ev] ??= []).push(h),
		};
		return { mockPi, registered };
	}

	async function childSession(env) {
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-takeover-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		for (const [k, v] of Object.entries(env)) process.env[k] = v;
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		return {
			dir,
			sess,
			registered,
			cleanup() {
				for (const k of Object.keys(env)) delete process.env[k];
				rmSync(dir, { recursive: true, force: true });
			},
		};
	}
	const sidecar = (sess) =>
		existsSync(`${sess}.exit`)
			? JSON.parse(readFileSync(`${sess}.exit`, "utf8"))
			: undefined;
	let shuts = 0;
	async function runTo(registered, stopReason = "stop") {
		await registered.handlers.agent_end[0]({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason }],
		});
		// pi fires every agent_settled listener; the activity recorder registers
		// before the exit decision, so the last handler is the one that exits.
		const settled = registered.handlers.agent_settled ?? [];
		for (const handler of settled) {
			await handler({}, { shutdown: () => shuts++ });
		}
	}

	// --- takeover marking: human vs steering echo vs programmatic ---------
	{
		const t = await childSession({
			PI_HERDR_SESSION: "",
		});
		// PI_HERDR_SESSION must be set AFTER makePi snapshots env — handle below
		t.cleanup();
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-takeover-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_NAME = "scout";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			const input = registered.handlers.input[0];

			// the parent's own steering echo: watermark matches → NOT takeover,
			// watermark consumed
			sf.writeSteerWatermark(sess, "scan the repo and report");
			await input({ type: "input", text: "scan the repo and report", source: "interactive" });
			assert(
				sf.readTakeoverMarker(sess).taken === false,
				"the parent's own steering echo is not a takeover",
			);
			assert(
				sf.readSteerWatermark(sess) === null,
				"a matched watermark is consumed",
			);

			// a human types their own words → takeover marker written once
			await input({ type: "input", text: "focus on the parser instead", source: "interactive" });
			assert(
				sf.readTakeoverMarker(sess).taken === true,
				"a human's typing marks the takeover",
			);
			const firstAt = sf.readTakeoverMarker(sess).at;
			await input({ type: "input", text: "more words", source: "interactive" });
			assert(
				sf.readTakeoverMarker(sess).at === firstAt,
				"the marker is written once (not rewritten per keystroke)",
			);

			// programmatic input is never a takeover…
			const dir2 = mkdtempSync(join(tmpdir(), "pi-herdr-takeover2-"));
			const sess2 = join(dir2, "s.jsonl");
			writeFileSync(sess2, "");
			process.env.PI_HERDR_SESSION = sess2;
			const pi2 = makePi();
			child.registerChildExtension(pi2.mockPi);
			await pi2.registered.handlers.input[0]({
				type: "input",
				text: "anything",
				source: "rpc",
			});
			assert(
				sf.readTakeoverMarker(sess2).taken === false,
				"rpc input is programmatic, not a human takeover",
			);
			// …but an input with no source (defensive, older pi) counts human
			await pi2.registered.handlers.input[0]({ type: "input", text: "hello" });
			assert(
				sf.readTakeoverMarker(sess2).taken === true,
				"input with no source field is treated as human (never slam shut)",
				
			);
			rmSync(dir2, { recursive: true, force: true });
			delete process.env.PI_HERDR_SESSION;
		} finally {
			delete process.env.PI_HERDR_SESSION;
			delete process.env.PI_HERDR_NAME;
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- idle re-arm: taken-over autonomous child -------------------------
	{
		const t = await childSession({
			PI_HERDR_SESSION: "",
		});
		t.cleanup();
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "80";
		process.env.PI_HERDR_ERROR_EXIT_GRACE_MS = "40";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			const input = registered.handlers.input[0];
			// human takes over first
			await input({ type: "input", text: "my own words", source: "interactive" });

			// clean settle under takeover: NO immediate exit, no sidecar yet
			shuts = 0;
			await runTo(registered, "stop");
			assert(
				shuts === 0 && sidecar(sess) === undefined,
				"taken-over settle does NOT auto-exit nor write an early sidecar",
			);

			// a keystroke resets the timer: input mid-window, no settle after
			await sleep(30);
			await input({ type: "input", text: "more steering", source: "interactive" });
			await sleep(80);
			assert(
				shuts === 0 && sidecar(sess) === undefined,
				"a keystroke resets the re-arm timer (cancelled until the next settle)",
			);

			// quiet window elapses after the fresh settle → rearm sidecar + exit
			await runTo(registered, "stop");
			await sleep(120);
			const s = sidecar(sess);
			assert(
				shuts === 1 && s && s.type === "done" && s.rearm === true,
				"quiet re-arm window → {type:done, rearm:true} sidecar + pane close",
			);
		} finally {
			for (const k of [
				"PI_HERDR_SESSION",
				"PI_HERDR_AUTO_EXIT",
				"PI_HERDR_IDLE_REARM_MS",
				"PI_HERDR_ERROR_EXIT_GRACE_MS",
			])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- error settle under takeover: re-arm governs, error-grace suppressed
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-err-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "80";
		process.env.PI_HERDR_ERROR_EXIT_GRACE_MS = "30";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			await registered.handlers.input[0]({
				type: "input",
				text: "human here",
				source: "interactive",
			});
			shuts = 0;
			await runTo(registered, "error");
			await sleep(60); // well past the 30ms error-grace
			assert(
				shuts === 0,
				"a pane never slams shut on a human: the 30s error-exit grace is suppressed",
			);
			await sleep(80); // past the 80ms re-arm window
			const s = sidecar(sess);
			assert(
				shuts === 1 && s && s.type === "error" && s.rearm === true,
				"the re-arm window exits with a typed, rearm-labeled error",
			);
		} finally {
			for (const k of [
				"PI_HERDR_SESSION",
				"PI_HERDR_AUTO_EXIT",
				"PI_HERDR_IDLE_REARM_MS",
				"PI_HERDR_ERROR_EXIT_GRACE_MS",
			])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- interactive stance + takeover: re-arm still applies ---------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-int-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "0";
		process.env.PI_HERDR_IDLE_REARM_MS = "60";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			await registered.handlers.input[0]({
				type: "input",
				text: "human here",
				source: "interactive",
			});
			shuts = 0;
			await runTo(registered, "stop");
			await sleep(100);
			const s = sidecar(sess);
			assert(
				shuts === 1 && s && s.type === "done" && s.rearm === true,
				"taken-over INTERACTIVE pane re-arms too (stance-independent)",
			);
		} finally {
			for (const k of ["PI_HERDR_SESSION", "PI_HERDR_AUTO_EXIT", "PI_HERDR_IDLE_REARM_MS"])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- aborted under takeover: open, no timer ----------------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-abort-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "40";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			await registered.handlers.input[0]({
				type: "input",
				text: "human here",
				source: "interactive",
			});
			shuts = 0;
			await runTo(registered, "aborted");
			await sleep(90);
			assert(
				shuts === 0 && sidecar(sess) === undefined,
				"aborted run under takeover stays open with no re-arm timer",
			);
		} finally {
			for (const k of ["PI_HERDR_SESSION", "PI_HERDR_AUTO_EXIT", "PI_HERDR_IDLE_REARM_MS"])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- untouched behavior: no takeover → the old paths hold --------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-rearm-off-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_AUTO_EXIT = "1";
		process.env.PI_HERDR_IDLE_REARM_MS = "40";
		process.env.PI_HERDR_ROOT_SESSION = "/sessions/root.jsonl";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			shuts = 0;
			await runTo(registered, "stop");
			assert(
				shuts === 1 && sidecar(sess)?.type === "done" && !sidecar(sess)?.rearm,
				"no takeover: autonomous clean settle still exits immediately (unlabeled)",
			);
			assert(
				sidecar(sess)?.rootSession === "/sessions/root.jsonl",
				"settle sidecar carries the stamped root session pointer",
			);
			assert(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
					sidecar(sess)?.eventId ?? "",
				),
				"clean settle sidecar carries a generated business eventId",
			);
		} finally {
			for (const k of ["PI_HERDR_SESSION", "PI_HERDR_AUTO_EXIT", "PI_HERDR_IDLE_REARM_MS", "PI_HERDR_ROOT_SESSION"])
				delete process.env[k];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// --- declared done also commits the root pointer ---------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-root-done-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(
			sess,
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "declared letter" }],
					stopReason: "stop",
				},
			}) + "\n",
		);
		process.env.PI_HERDR_SESSION = sess;
		process.env.PI_HERDR_ROOT_SESSION = "/sessions/root.jsonl";
		const { mockPi, registered } = makePi();
		child.registerChildExtension(mockPi);
		try {
			const tool = registered.tools.find((t) => t.name === "agent_done");
			await tool.execute("1", {}, undefined, undefined, { shutdown() {} });
			const s = sidecar(sess);
			assert(
				s?.type === "done" &&
					s.text === "declared letter" &&
					s.rootSession === "/sessions/root.jsonl",
				"agent_done sidecar carries the final text and the root session pointer",
			);
			assert(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
					s?.eventId ?? "",
				),
				"agent_done sidecar carries a generated business eventId",
			);
		} finally {
			delete process.env.PI_HERDR_SESSION;
			delete process.env.PI_HERDR_ROOT_SESSION;
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

// ---------------------------------------------------------------------------
console.log("\n[3] Delivery loop — detection routes + wake flags");
{
	const delivery = await jiti.import(join(ROOT, "src/delivery.ts"), {
		parent: ROOT,
	});

	const rec = (name, over = {}) => ({
		name,
		kind: "pi",
		prompt: "",
		agentArgs: [],
		depth: 1,
		isolated: false,
		spawnedAt: 0,
		submitted: true,
		sawWorking: true,
		stance: "autonomous",
		paneId: `w1:${name}`,
		...over,
	});
	const writeSession = (sess, messages) =>
		writeFileSync(
			sess,
			messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n") +
				"\n",
		);
	const assistantMsg = (text, extra = {}) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		...extra,
	});

	/** Fake world: registry + fleet statuses + fake clock + captured pushes
	 * + captured pane closes. */
	function world(records, opts = {}) {
		const pushes = [];
		const closes = [];
		let clock = 1_000_000;
		let fleet = opts.fleet ?? [];
		const registry = new Map(records.map((r) => [r.name, r]));
		const deps = {
			registry: () => registry,
			load: () => ({ notifications: opts.notifications ?? "normal" }),
			list: opts.failList
				? async () => ({ ok: false, error: { code: "TIMEOUT", message: "herdr down" } })
				: async () => ({
						ok: true,
						data: fleet.map((f) => ({
							paneId: f.paneId,
							name: f.name,
							agentStatus: f.status,
						})),
					}),
			push: (m) => pushes.push(m),
			busy: opts.busy,
			now: () => clock,
			goneGraceMs: opts.goneGraceMs ?? 10_000,
			// `close` (feature-branch name) and `closePane` (upstream name) both
			// map onto the close seam; readTail backs the session-less tail route.
			closePane:
				opts.closePane ??
				opts.close ??
				(async (paneId) => {
					closes.push(paneId);
				}),
			readTail: opts.readTail ?? (async () => ""),
		};
		return {
			deps,
			pushes,
			closes,
			setFleet: (f) => (fleet = f),
			advance: (ms) => (clock += ms),
			tick: () => delivery.deliverOnce(deps),
		};
	}

	// --- route 1: the typed sidecar --------------------------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("The scan found 3 issues. All fixed.")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "done" }] });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("The scan found 3 issues. All fixed.") &&
				w.pushes[0].content.includes('Agent "scout" finished'),
			"sidecar done → the FULL final message is the push (the letter, not a doorbell)",
		);
		assert(w.closes[0] === r.paneId, "autonomous done sidecar closes the pane after the result is pushed");
		assert(
			w.pushes[0].wake === true && w.pushes[0].deliverAs === "steer",
			"notifications normal → the push wakes (triggerTurn via sink flags)",
		);
		assert(
			w.pushes[0].details.kind === "done" && r.delivery?.kind === "done",
			"terminal event marked delivered in the registry",
		);
		assert(
			w.pushes[0].details.eventId === undefined,
			"a sidecar with no eventId does not invent one on the push",
		);
		await w.tick();
		assert(
			w.pushes.length === 1 && w.closes.length === 1,
			"exactly ONE push and ONE close per terminal event (inline waits + pulls never double it)",
		);
		assert(
			w.closes.includes(r.paneId) &&
				w.closes.filter((id) => id === r.paneId).length === 1,
			"done-delivery closes the child's leftover pane — exactly once (F2 promise)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("re-armed result")]);
		const r = rec("scout", { sessionPath: sess, takenOver: true });
		const closed = [];
		const w = world([r], {
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done", rearm: true }));
		await w.tick();
		assert(
			w.pushes[0]?.content.startsWith("auto-delivered after user steer: "),
			"rearm sidecar → honestly labeled auto-delivery",
		);
		assert(
			closed.length === 1 && closed[0] === r.paneId,
			"rearm sidecar delivery closes the pane (the settings promise: auto-delivered, pane closes)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-rearm-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("quiet rearm")]);
		const r = rec("scout", { sessionPath: sess });
		const closed = [];
		const w = world([r], {
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done", rearm: true }));
		await w.tick();
		assert(
			w.pushes.length === 1 && closed.length === 1 && r.takenOver !== true,
			"rearm:true alone still delivers and closes (upstream F2: only taken-over + non-rearm holds)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("", { stopReason: "error" })]);
		const r = rec("scout", { sessionPath: sess });
		const closed = [];
		const w = world([r], {
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		writeFileSync(
			`${sess}.exit`,
			JSON.stringify({ type: "error", errorMessage: "provider overloaded", stopReason: "error" }),
		);
		await w.tick();
		assert(
			w.pushes[0]?.content.includes('Agent "scout" FAILED: provider overloaded'),
			"error sidecar → typed failure reaches the parent",
		);
		assert(closed[0] === r.paneId, "autonomous error sidecar closes the pane after the failure is delivered");
		assert(
			w.pushes[0]?.details.error?.errorMessage === "provider overloaded",
			"error details carry the mined failure",
		);
		assert(
			w.pushes[0]?.details.eventId === undefined,
			"an error sidecar with no eventId does not invent one on the push",
		);
		assert(
			closed.includes(r.paneId),
			"typed error delivery closes the pane too",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-close-fail-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("delivered anyway")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], {
			close: async () => {
				throw new Error("pane close failed");
			},
		});
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("delivered anyway") &&
				r.delivery?.kind === "done",
			"a failed pane close does not swallow the delivered result",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	// quiet / none wake flags
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("quiet delivery")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { notifications: "quiet" });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].wake === false &&
				w.pushes[0].deliverAs === "nextTurn",
			"notifications quiet → delivers on the next natural turn (no wake)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("silent result")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { notifications: "none" });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 0 && r.delivery?.kind === "done",
			"notifications none → no completion push at all (pull-only), still marked delivered",
		);
		assert(
			w.closes.includes(r.paneId),
			"notifications none still closes the pane (lifecycle promise, not a notification)",
		);
		rmSync(dir, { recursive: true, force: true });
	}

	// --- route 2: the sentinel — a sidecar-less death ---------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("died mid-report but this text survived")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]); // fleet: pane absent from tick 1
		await w.tick();
		assert(
			w.pushes.length === 0 && typeof r.goneAt === "number",
			"first absence starts the bounded grace (no false gone on one lost poll)",
		);
		w.advance(100);
		await w.tick();
		assert(w.pushes.length === 0, "still within the grace window — nothing pushed");
		w.advance(11_000);
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("died mid-report but this text survived"),
			"sentinel: after grace the JSONL's last message IS the delivered letter",
		);
		assert(
			w.closes.includes(r.paneId),
			"the sentinel's mined-done delivery closes the leftover pane as well",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [
			assistantMsg("", { stopReason: "error", errorMessage: "rate limited" }),
		]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]);
		await w.tick(); // stamps goneAt (grace starts)
		w.advance(11_000);
		await w.tick();
		assert(
			w.pushes[0]?.content.includes("FAILED: rate limited") &&
				w.pushes[0].details.kind === "error",
			"sentinel mines stopReason=error → typed failure, not a mystery",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	// --- route 3: disappearance with nothing on disk -----------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		const r = rec("scout", { sessionPath: sess });
		const w = world([r]);
		await w.tick(); // stamps goneAt (grace starts)
		w.advance(11_000);
		await w.tick();
		assert(
			w.pushes[0]?.content.includes('Agent "scout" is gone') &&
				w.pushes[0].details.kind === "gone" &&
				w.pushes[0].content.includes("retained"),
			"pane vanished with no evidence → honest gone note, session retained",
		);
		assert(
			w.closes.includes(r.paneId),
			"gone-note delivery closes the leftover pane too (best-effort; already gone = harmless)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	// transient herdr errors are not absence evidence
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope.jsonl") });
		const w = world([r], { failList: true });
		w.advance(30_000);
		await w.tick();
		assert(
			w.pushes.length === 0 && r.goneAt === undefined,
			"a failed fleet observation skips the tick — never a false gone",
		);
	}
	// reappear clears the grace
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope2.jsonl") });
		const w = world([r]);
		await w.tick();
		const firstGone = r.goneAt;
		w.setFleet([{ paneId: r.paneId, status: "working" }]);
		w.advance(100);
		await w.tick();
		assert(r.goneAt === undefined, "reappearing clears the absence timer");
		w.setFleet([]);
		w.advance(100);
		await w.tick();
		assert(
			r.goneAt !== undefined && r.goneAt !== firstGone,
			"a second absence starts a FRESH grace window",
		);
		w.advance(9_000);
		await w.tick();
		assert(w.pushes.length === 0, "...and is honored (still in grace)");
	}

	// --- blocked always wakes ----------------------------------------------
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope3.jsonl") });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "blocked" }] });
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].wake === true &&
				w.pushes[0].details.kind === "blocked",
			"blocked always wakes (regardless of the notifications setting)",
		);
		await w.tick();
		assert(
			w.pushes.length === 1,
			"the blocked wake is per episode, not per tick",
			
		);
		// fresh episode re-wakes
		w.setFleet([{ paneId: r.paneId, status: "working" }]);
		await w.tick();
		w.setFleet([{ paneId: r.paneId, status: "blocked" }]);
		await w.tick();
		assert(w.pushes.length === 2, "a NEW blocked episode wakes again");
		assert(
			w.closes.length === 0,
			"a blocked child's pane is NEVER closed (it needs input, not a funeral)",
		);
	}
	{
		for (const notes of ["quiet", "none"]) {
			const r = rec("scout", { sessionPath: join(tmpdir(), "nope4.jsonl") });
			const w = world([r], {
				notifications: notes,
				fleet: [{ paneId: r.paneId, status: "blocked" }],
			});
			await w.tick();
			assert(
				w.pushes.length === 1 &&
					w.pushes[0].wake === true &&
					w.pushes[0].deliverAs === "steer",
				`blocked wakes even under notifications ${notes}`,
			);
		}
	}
	{
		const r = rec("scout", { sessionPath: join(tmpdir(), "nope5.jsonl") });
		r.takenOver = true;
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "blocked" }] });
		await w.tick();
		assert(
			w.pushes.length === 0,
			"a TAKEN-OVER pane never pushes mid-conversation (the human is right there)",
		);
	}

	// --- takeover note (quiet, once) ----------------------------------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-to-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "working" }] });
		writeFileSync(sf.takeoverPathFor(sess), "{}");
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content === "user took over scout" &&
				w.pushes[0].wake === false,
			"takeover marker → quiet (no-wake) `user took over <agent>` note",
		);
		assert(r.takenOver === true && r.tookNotified === true, "record flags set");
		await w.tick();
		assert(w.pushes.length === 1, "the note is sent once, not per tick");
		rmSync(dir, { recursive: true, force: true });
	}

	// --- never-started / queued / non-pi / live-idle ------------------------
	{
		const failed = rec("fizz", { startError: "boot gate timed out", paneId: undefined });
		const queued = rec("queued-one", { paneId: undefined });
		const w = world([failed, queued]);
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes('Agent "fizz" never started: boot gate timed out'),
			"a queued record that failed its deferred start pushes the typed failure",
		);
		assert(
			queued.delivery === undefined,
			"still-queued records are skipped (nothing to watch yet)",
		);
		assert(
			w.closes.length === 0,
			"a never-started record closes nothing (there was never a pane)",
		);
	}
	{
		const claude = rec("cc", { kind: "claude" });
		const closed = [];
		const w = world([claude], {
			fleet: [{ paneId: claude.paneId, status: "idle" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
			readTail: async () => "review: 能合入",
		});
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("review: 能合入") &&
				w.pushes[0].content.includes('Agent "cc" finished'),
			"an autonomous non-pi child that settled delivers its pane tail",
		);
		assert(closed[0] === claude.paneId, "and its pane is closed");
		await w.tick();
		assert(w.pushes.length === 1 && closed.length === 1, "one push and one close");
	}
	{
		const claude = rec("cc", { kind: "claude", sawWorking: false });
		const closed = [];
		const w = world([claude], {
			fleet: [{ paneId: claude.paneId, status: "idle" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
			readTail: async () => "should not be read",
		});
		await w.tick();
		assert(
			w.pushes.length === 0 && closed.length === 0 && claude.delivery === undefined,
			"an autonomous non-pi child that is idle before any working turn stays open (prompt may not be in yet)",
		);
	}
	{
		const claude = rec("cc", { kind: "claude", sawWorking: false });
		const closed = [];
		const w = world([claude], {
			fleet: [{ paneId: claude.paneId, status: "done" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
			readTail: async () => "fleet said done",
		});
		await w.tick();
		assert(
			w.pushes.length === 1 && closed[0] === claude.paneId,
			"fleet done is enough evidence for a session-less child, even without a seen working turn",
		);
	}
	{
		const claude = rec("cc", { kind: "claude" });
		const closed = [];
		let reads = 0;
		const w = world([claude], {
			fleet: [{ paneId: claude.paneId, status: "idle" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
			readTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("agent read failed");
				return "review: 能合入";
			},
		});
		await w.tick().catch(() => {});
		assert(
			w.pushes.length === 0 && closed.length === 0 && claude.delivery === undefined,
			"a failed pane-tail read delivers nothing and leaves the record unmarked",
		);
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				closed.length === 1 &&
				w.pushes[0].content.includes("review: 能合入"),
			"the next tick retries the tail read, then delivers and closes once",
		);
	}
	{
		const claude = rec("cc", { kind: "claude" });
		const closed = [];
		let reads = 0;
		const w = world([claude], {
			fleet: [{ paneId: claude.paneId, status: "idle" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
			readTail: async () => {
				reads += 1;
				return reads === 1 ? "   " : "late output";
			},
		});
		await w.tick();
		assert(
			w.pushes.length === 0 && closed.length === 0 && claude.delivery === undefined,
			"an empty pane tail is not a done result and does not close the pane",
		);
		await w.tick();
		assert(
			w.pushes.length === 1 && closed.length === 1,
			"a later tick with a real tail delivers and closes once",
		);
	}
	{
		const claude = rec("cc", { kind: "claude", stance: "interactive" });
		const closed = [];
		const w = world([claude], {
			fleet: [{ paneId: claude.paneId, status: "idle" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		await w.tick();
		assert(
			w.pushes.length === 0 && closed.length === 0,
			"an interactive non-pi child that is idle stays open",
		);
	}
	{
		const claude = rec("cc", { kind: "claude", workflow: "wf_x" });
		const closed = [];
		const w = world([claude], {
			fleet: [{ paneId: claude.paneId, status: "done" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		await w.tick();
		assert(
			w.pushes.length === 0 && closed.length === 0 && claude.delivery === undefined,
			"a workflow non-pi child is not closed by the per-child settle path",
		);
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-idle-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("interim work")]);
		const r = rec("scout", { sessionPath: sess, stance: "interactive" });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "idle" }] });
		await w.tick();
		await w.tick();
		assert(
			w.pushes.length === 0,
			"live idle WITHOUT a sidecar is not terminal (interactive children sit idle) — pull stays the route",
		);
		assert(
			w.closes.length === 0,
			"an UNDELIVERED record's pane is never closed",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-int-sc-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("interactive finished")]);
		const r = rec("scout", { sessionPath: sess, stance: "interactive" });
		const closed = [];
		const w = world([r], {
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 && w.pushes[0].content.includes("interactive finished"),
			"interactive done sidecar still delivers",
		);
		assert(closed.length === 1, "interactive done sidecar closes the pane too (fleet-wide F2)");
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-to-sc-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("taken over result")]);
		const r = rec("scout", { sessionPath: sess, takenOver: true });
		const closed = [];
		const w = world([r], {
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 && closed.length === 0,
			"a taken-over pane is not closed when its sidecar lands",
		);
		rmSync(dir, { recursive: true, force: true });
	}

	// --- autonomous child settled but never wrote a sidecar ----------------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-stuck-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("the review")]);
		const r = rec("stuck", { sessionPath: sess });
		const closed = [];
		const w = world([r], {
			fleet: [{ paneId: r.paneId, status: "idle" }],
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		await w.tick();
		assert(
			w.pushes.length === 1 && w.pushes[0].content.includes("the review"),
			"an autonomous child that settled without a sidecar still delivers its result",
		);
		assert(closed[0] === r.paneId, "and its pane is closed");
		rmSync(dir, { recursive: true, force: true });
	}

	// --- workflow children (v0.6 issue 12): the run reports, not the child --
	{
		// terminal sidecar → delivery marked (row leaves the fleet) but NO push
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-wf-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("child work")]);
		writeFileSync(sf.sidecarPathFor(sess), '{"type":"done"}');
		const child = rec("wfa", { sessionPath: sess, workflow: "wf_abc123" });
		const closed = [];
		const w = world([child], {
			fleet: [],
			close: async (paneId) => {
				closed.push(paneId);
			},
		});
		await w.tick();
		assert(
			w.pushes.length === 0 && child.delivery?.kind === "done",
			"a workflow child's terminal sidecar MARKS the record (row prunes) without a per-child push",
		);
		assert(
			closed.includes(child.paneId),
			"a workflow child's settled pane STILL closes at its terminal mark (F10 — only the push is suppressed)",
		);
		// ...and the error sidecar is equally silent
		const dir2 = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-wf2-"));
		const sess2 = join(dir2, "s.jsonl");
		writeSession(sess2, [assistantMsg("boom", { stopReason: "error" })]);
		writeFileSync(
			sf.sidecarPathFor(sess2),
			'{"type":"error","errorMessage":"provider overloaded","stopReason":"error"}',
		);
		const failing = rec("wfb", { sessionPath: sess2, workflow: "wf_abc123" });
		const w2 = world([failing], { fleet: [] });
		await w2.tick();
		assert(
			w2.pushes.length === 0 && failing.delivery?.kind === "error",
			"a workflow child's error sidecar is silent too (the run's report carries it)",
		);
		// blocked still wakes — the orchestrator can answer and resume the child
		const blocked = rec("wfc", { sessionPath: join(tmpdir(), "wf-nope.jsonl"), workflow: "wf_abc123" });
		const w3 = world([blocked], { fleet: [{ paneId: blocked.paneId, status: "blocked" }] });
		await w3.tick();
		assert(
			w3.pushes.length === 1 && w3.pushes[0].details.kind === "blocked" && w3.pushes[0].wake === true,
			"a BLOCKED workflow child still wakes (an answer via message_agent resumes it)",
		);
		// gone (bounded grace expiry) marks without a push
		const vanished = rec("wfd", { sessionPath: join(tmpdir(), "wf-nope2.jsonl"), workflow: "wf_abc123" });
		const w4 = world([vanished], { fleet: [] });
		await w4.tick();
		w4.advance(10_001);
		await w4.tick();
		assert(
			w4.pushes.length === 0 && vanished.delivery?.kind === "gone",
			"a workflow child that vanishes is marked gone without a per-child push",
		);
		// an ordinary child in the SAME registry still pushes normally
		const dir3 = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-wf3-"));
		const sess3 = join(dir3, "s.jsonl");
		writeSession(sess3, [assistantMsg("plain work")]);
		writeFileSync(sf.sidecarPathFor(sess3), '{"type":"done"}');
		const plain = rec("plain", { sessionPath: sess3 });
		const w5 = world([plain, rec("midflight-wf", { sessionPath: join(tmpdir(), "wf-nope3.jsonl"), workflow: "wf_x" })], {
			fleet: [{ paneId: "w1:midflight-wf", status: "working" }],
		});
		await w5.tick();
		assert(
			w5.pushes.length === 1 && w5.pushes[0].details.name === "plain",
			"ordinary children in the same registry keep their completion pushes",
		);
		for (const d of [dir, dir2, dir3]) rmSync(d, { recursive: true, force: true });
	}

	// --- pane-close guards + the auto-exit race (manual e2e F2) -------------
	{
		// A taken-over pane that has NOT re-arm-delivered: agent_done declared
		// under a human — delivered, but the pane stays (the human is driving).
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-to2-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("declared done under a human")]);
		const r = rec("scout", { sessionPath: sess, takenOver: true });
		const w = world([r]);
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.closes.length === 0 &&
				r.delivery?.kind === "done",
			"a taken-over pane that has NOT re-arm-delivered is never closed",
		);
		// The same situation ON the re-arm delivery: the settings copy promises
		// "auto-delivered ... and its pane closes" — so it does.
		const r2 = rec("scout-2", { sessionPath: sess, takenOver: true });
		const w2 = world([r2]);
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done", rearm: true }));
		await w2.tick();
		assert(
			w2.pushes.length === 1 &&
				w2.pushes[0].content.startsWith("auto-delivered after user steer: ") &&
				w2.closes.includes(r2.paneId),
			"the rearm-labeled delivery closes the taken-over pane (the promise)",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		// Sidecar text wins over a later (or different) JSONL assistant message.
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-text-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("stale jsonl body")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "done" }] });
		writeFileSync(
			`${sess}.exit`,
			JSON.stringify({ type: "done", text: "committed final letter" }),
		);
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("committed final letter") &&
				!w.pushes[0].content.includes("stale jsonl body") &&
				w.pushes[0].details.result === "committed final letter",
			"done push prefers the sidecar text over the session JSONL",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		// A done sidecar with no text and an empty session still uses the
		// existing empty-body sentence (#30 matches it).
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-empty-"));
		const sess = join(dir, "s.jsonl");
		writeFileSync(sess, "");
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "done" }] });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done", text: "   " }));
		await w.tick();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes(
					"(the child finished but its session file holds no assistant message)",
				),
			"blank sidecar text still uses the empty-assistant sentence",
		);
		rmSync(dir, { recursive: true, force: true });
	}
	{
		// Auto-exit race: the sidecar lands while the fleet still lists the pane
		// as working — never close under a live agent; the close is held and
		// retried on a later tick, so the promise does not lose the race.
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-race-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("finished mid-race")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "working" }] });
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			r.delivery?.kind === "done" &&
				w.closes.length === 0 &&
				r.paneClosePending === true,
			"a close never fires under a live agent — held pending (auto-exit race)",
		);
		w.setFleet([]); // the child finished exiting
		await w.tick();
		assert(
			w.closes.includes(r.paneId) && r.paneClosePending === false,
			"the held close retries once the fleet stops listing the pane",
		);
		rmSync(dir, { recursive: true, force: true });
	}

	// --- exit-sidecar watcher: one event, one push; poll is the backstop ---
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-watch-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("watched result")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "idle" }] });
		const logs = [];
		let notify;
		w.deps.watchSidecar = (_path, onWrite) => {
			notify = () => onWrite({ mtimeMs: 999_960 });
			return { close() { notify = undefined; } };
		};
		w.deps.debug = (line) => logs.push(line);
		w.deps.sidecarWrittenAt = () => 999_960;
		const obs = delivery.observeExitSidecars(w.deps, () => w.tick());
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		notify();
		notify();
		await obs.whenIdle();
		assert(
			w.pushes.length === 1 &&
				w.pushes[0].content.includes("watched result") &&
				r.delivery?.kind === "done",
			"sidecar write event triggers exactly one delivery tick",
		);
		assert(
			logs.some(
				(line) =>
					line.includes("segment=sidecar→push") &&
					line.includes("40ms") &&
					line.includes("scout"),
			),
			"debug log records detect latency from sidecar write to push (40ms)",
		);
		await w.tick();
		assert(
			w.pushes.length === 1,
			"the 2.5s poll backstop does not deliver the same sidecar event again",
		);
		obs.close();
		rmSync(dir, { recursive: true, force: true });
	}
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-watch-down-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("polled after a blind watch")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "idle" }] });
		const logs = [];
		let armed = 0;
		w.deps.watchSidecar = () => {
			armed += 1;
			throw new Error("watch unsupported");
		};
		w.deps.debug = (line) => logs.push(line);
		w.deps.sidecarWrittenAt = () => 997_500;
		const obs = delivery.observeExitSidecars(w.deps, () => w.tick());
		writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
		await w.tick();
		assert(
			armed >= 1 &&
				w.pushes.length === 1 &&
				w.pushes[0].content.includes("polled after a blind watch"),
			"a failed sidecar watcher still leaves the poll backstop to deliver",
		);
		assert(
			logs.some(
				(line) => line.includes("segment=sidecar→push") && line.includes("2500ms"),
			),
			"poll delivery still logs detect latency when the watcher never fired",
		);
		await w.tick();
		assert(w.pushes.length === 1, "poll backstop is still once per event");
		obs.close();
		rmSync(dir, { recursive: true, force: true });
	}

	// --- registration smoke: sink maps wake → sendMessage flags ------------
	{
		delivery.stopDeliveryLoop();
		const sent = [];
		const mockPi = {
			sendMessage: (msg, opts) => sent.push({ msg, opts }),
		};
		delivery.registerDelivery(mockPi);
		delivery.stopDeliveryLoop();
		delivery.registerDelivery(mockPi); // idempotent restart is fine
		delivery.stopDeliveryLoop();
		assert(sent.length === 0, "the loop ticks no-op on an empty registry");
	}

	// --- #32 orchestrator busy/idle at push time -----------------------------
	// busy?: () => boolean is injected. Default (unset) stays idle, so older
	// worlds keep steer. The sink is mocked: we assert the options it would
	// pass to sendMessage, and we never abort a tool.
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dlv-busy-"));
		const doneSess = (label) => {
			const sess = join(dir, `${label}.jsonl`);
			writeSession(sess, [assistantMsg(`${label} letter`)]);
			writeFileSync(`${sess}.exit`, JSON.stringify({ type: "done" }));
			return sess;
		};
		const errorSess = (label) => {
			const sess = join(dir, `${label}.jsonl`);
			writeSession(sess, [assistantMsg("", { stopReason: "error" })]);
			writeFileSync(
				`${sess}.exit`,
				JSON.stringify({ type: "error", errorMessage: "boom", stopReason: "error" }),
			);
			return sess;
		};
		const sinkOf = (w) => {
			const sent = [];
			const sink = delivery.makeDeliverySink({
				sendMessage: (msg, opts) => sent.push({ msg, opts }),
			});
			w.deps.push = (m) => {
				w.pushes.push(m);
				sink(m);
			};
			return sent;
		};

		// idle done → steer + triggerTurn
		{
			const r = rec("idle-done", { sessionPath: doneSess("idle") });
			const w = world([r], { busy: () => false });
			const sent = sinkOf(w);
			await w.tick();
			assert(
				sent.length === 1 &&
					sent[0].opts.deliverAs === "steer" &&
					sent[0].opts.triggerTurn === true,
				"idle done → steer + triggerTurn",
			);
		}
		// busy done → followUp + triggerTurn (queue; do not cancel the running tool)
		{
			const r = rec("busy-done", { sessionPath: doneSess("busy") });
			const w = world([r], { busy: () => true });
			const sent = sinkOf(w);
			await w.tick();
			assert(
				sent.length === 1 &&
					sent[0].opts.deliverAs === "followUp" &&
					sent[0].opts.triggerTurn === true &&
					w.pushes[0].deliverAs === "followUp",
				"busy done → followUp + triggerTurn (queued, tools not cancelled)",
			);
		}
		// unset busy stays the old idle path
		{
			const r = rec("default-idle", { sessionPath: doneSess("default") });
			const w = world([r]);
			const sent = sinkOf(w);
			await w.tick();
			assert(
				sent[0]?.opts.deliverAs === "steer" && sent[0]?.opts.triggerTurn === true,
				"busy unset → idle default (steer + triggerTurn)",
			);
		}
		// blocked stays steer, even while the orchestrator is busy, and even under none
		{
			for (const notes of ["normal", "quiet", "none"]) {
				const r = rec(`blocked-${notes}`, {
					sessionPath: join(dir, `blocked-${notes}.jsonl`),
				});
				const w = world([r], {
					notifications: notes,
					busy: () => true,
					fleet: [{ paneId: r.paneId, status: "blocked" }],
				});
				const sent = sinkOf(w);
				await w.tick();
				assert(
					sent.length === 1 &&
						sent[0].opts.deliverAs === "steer" &&
						sent[0].opts.triggerTurn === true &&
						w.pushes[0].details.kind === "blocked",
					`blocked stays steer + triggerTurn while busy (notifications ${notes})`,
				);
			}
		}
		// stalled stays steer while busy (watchdog push, not a terminal kind)
		{
			const r = rec("stalled-one", { sessionPath: join(dir, "stalled.jsonl") });
			const sent = [];
			const sink = delivery.makeDeliverySink({
				sendMessage: (msg, opts) => sent.push({ msg, opts }),
			});
			const pushes = [];
			await delivery.watchdogOnce({
				registry: () => new Map([[r.name, r]]),
				fleet: { ok: true, data: [] },
				readSidecar: () => ({ state: "missing" }),
				extract: () => null,
				busy: () => true,
				now: () => 1_000_000,
				push: (m) => {
					pushes.push(m);
					sink(m);
				},
			});
			assert(
				sent.length === 1 &&
					sent[0].opts.deliverAs === "steer" &&
					sent[0].opts.triggerTurn === true &&
					pushes[0].details.kind === "stalled",
				"stalled stays steer + triggerTurn while the orchestrator is busy",
			);
		}
		// error respects notifications: quiet → nextTurn, none → no push, normal → steer
		{
			const quiet = rec("err-quiet", { sessionPath: errorSess("eq") });
			const wq = world([quiet], { notifications: "quiet", busy: () => true });
			const sq = sinkOf(wq);
			await wq.tick();
			assert(
				sq.length === 1 &&
					sq[0].opts.deliverAs === "nextTurn" &&
					sq[0].opts.triggerTurn === false,
				"error + quiet → nextTurn (no wake), even while busy",
			);

			const none = rec("err-none", { sessionPath: errorSess("en") });
			const wn = world([none], { notifications: "none", busy: () => false });
			const sn = sinkOf(wn);
			await wn.tick();
			assert(
				sn.length === 0 && none.delivery?.kind === "error",
				"error + none → no push, still marked delivered",
			);

			const normal = rec("err-normal", { sessionPath: errorSess("eo") });
			const wo = world([normal], { notifications: "normal", busy: () => true });
			const so = sinkOf(wo);
			await wo.tick();
			assert(
				so.length === 1 &&
					so[0].opts.deliverAs === "steer" &&
					so[0].opts.triggerTurn === true,
				"error + normal → steer + triggerTurn, even while busy",
			);
		}
		// notifications matrix on done: quiet is nextTurn, none is silence, normal follows busy
		{
			const quiet = rec("done-quiet", { sessionPath: doneSess("dq") });
			const wq = world([quiet], { notifications: "quiet", busy: () => true });
			const sq = sinkOf(wq);
			await wq.tick();
			assert(
				sq[0]?.opts.deliverAs === "nextTurn" && sq[0]?.opts.triggerTurn === false,
				"done + quiet stays nextTurn even while busy",
			);

			const none = rec("done-none", { sessionPath: doneSess("dn") });
			const wn = world([none], { notifications: "none", busy: () => true });
			const sn = sinkOf(wn);
			await wn.tick();
			assert(
				sn.length === 0 && none.delivery?.kind === "done",
				"done + none → no push while busy",
			);

			const idle = rec("done-normal-idle", { sessionPath: doneSess("dni") });
			const wi = world([idle], { notifications: "normal", busy: () => false });
			const si = sinkOf(wi);
			await wi.tick();
			assert(
				si[0]?.opts.deliverAs === "steer" && si[0]?.opts.triggerTurn === true,
				"done + normal + idle → steer",
			);

			const busy = rec("done-normal-busy", { sessionPath: doneSess("dnb") });
			const wb = world([busy], { notifications: "normal", busy: () => true });
			const sb = sinkOf(wb);
			await wb.tick();
			assert(
				sb[0]?.opts.deliverAs === "followUp" && sb[0]?.opts.triggerTurn === true,
				"done + normal + busy → followUp",
			);
		}
			rmSync(dir, { recursive: true, force: true });
	}

	// --- #39 orphan adoption: dead owner, fleet still done/idle ----------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-orphan-"));
		const root = join(dir, "root.jsonl");
		const mid = join(dir, "mid.jsonl");
		const leaf = join(dir, "leaf.jsonl");
		const letter = "grandchild finished the scan: 3 issues, all fixed.";
		writeSession(leaf, [assistantMsg(letter)]);
		writeFileSync(
			`${leaf}.exit`,
			JSON.stringify({ type: "done", text: letter, rootSession: root }),
		);
		const rootRecords = [
			rec("mid", {
				sessionPath: mid,
				lineage: { rootSession: root, ownerSession: root },
			}),
		];
		const midFile = `${mid}.registry.json`;
		writeFileSync(
			midFile,
			JSON.stringify([
				{
					name: "leaf",
					kind: "pi",
					paneId: "w1:leaf",
					sessionPath: leaf,
					stance: "autonomous",
					lineage: { rootSession: root, ownerSession: mid },
				},
			]),
		);
		const pushes = [];
		const closes = [];
		const fleet = [{ paneId: "w1:leaf", status: "done" }];
		const depsFor = (selfPath, records) => ({
			registry: () => new Map(records.map((r) => [r.name, r])),
			load: () => ({ notifications: "normal" }),
			list: async () => ({
				ok: true,
				data: fleet.map((f) => ({
					paneId: f.paneId,
					agentStatus: f.status,
				})),
			}),
			readRegistry: (sessionPath) => {
				const path = `${sessionPath}.registry.json`;
				if (!existsSync(path)) return [];
				return JSON.parse(readFileSync(path, "utf8"));
			},
			sessionPath: selfPath,
			push: (m) => pushes.push(m),
			closePane: async (paneId) => {
				closes.push(paneId);
			},
			now: () => 1_000_000,
		});

		// middle process is gone (not in the fleet). Its registry file still
		// lists the leaf, and the fleet still lists that leaf done.
		await delivery.deliverOnce(depsFor(root, rootRecords));
		assert(
			pushes.length === 1 &&
				pushes[0].content.includes(letter) &&
				pushes[0].content.includes('Agent "leaf" finished'),
			"dead middle layer: the root push carries the grandchild's full letter",
		);
		assert(
			pushes[0].details.kind === "done" && pushes[0].details.adopted === true,
			"the adopted push is a done event marked adopted",
		);
		assert(
			pushes[0].details.eventId === undefined,
			"an adopted sidecar with no eventId does not invent one on the push",
		);
		assert(closes.includes("w1:leaf"), "adopting the orphan still closes its pane");

		// resume of the root session does not push the same letter again
		await delivery.deliverOnce(depsFor(root, rootRecords));
		assert(
			pushes.length === 1,
			"a later tick, including resume, does not deliver the orphan twice",
		);

		// parent still alive: its registry file still lists the leaf
		const liveSess = join(dir, "live.jsonl");
		writeSession(liveSess, [assistantMsg("still the parent's")]);
		writeFileSync(
			`${liveSess}.exit`,
			JSON.stringify({
				type: "done",
				text: "still the parent's",
				rootSession: root,
			}),
		);
		writeFileSync(
			midFile,
			JSON.stringify([
				{
					name: "leaf-live",
					kind: "pi",
					paneId: "w1:leaf-live",
					sessionPath: liveSess,
					stance: "autonomous",
					lineage: { rootSession: root, ownerSession: mid },
				},
			]),
		);
		fleet.push({ paneId: "w1:mid", status: "idle" });
		fleet.push({ paneId: "w1:leaf-live", status: "idle" });
		const before = pushes.length;
		await delivery.deliverOnce(depsFor(root, rootRecords));
		assert(
			pushes.length === before,
			"a living parent keeps the result: the root does not adopt it",
		);

		// a failed registry observation is not proof the owner died
		const lost = rec("leaf-unobserved", {
			sessionPath: join(dir, "unobserved.jsonl"),
			lineage: { rootSession: root, ownerSession: mid },
		});
		writeSession(lost.sessionPath, [assistantMsg("do not adopt me")]);
		writeFileSync(
			`${lost.sessionPath}.exit`,
			JSON.stringify({
				type: "done",
				text: "do not adopt me",
				rootSession: root,
			}),
		);
		fleet.push({ paneId: lost.paneId, status: "done" });
		writeFileSync(
			midFile,
			JSON.stringify([
				{
					name: lost.name,
					kind: "pi",
					paneId: lost.paneId,
					sessionPath: lost.sessionPath,
					stance: "autonomous",
					lineage: lost.lineage,
				},
			]),
		);
		const blind = depsFor(root, rootRecords);
		blind.readRegistry = () => {
			throw new Error("registry unreadable");
		};
		await delivery.deliverOnce(blind);
		assert(
			pushes.every((p) => !String(p.content).includes("do not adopt me")),
			"a failed registry observation is not treated as an orphan",
		);

		// wrong root: another orchestrator must not receive this letter
		const strangerPushes = [];
		const strangerDeps = depsFor(join(dir, "stranger.jsonl"), [
			rec("mid", {
				sessionPath: mid,
				lineage: { rootSession: root, ownerSession: root },
			}),
		]);
		strangerDeps.push = (m) => strangerPushes.push(m);
		strangerDeps.readRegistry = () => [];
		await delivery.deliverOnce(strangerDeps);
		assert(
			strangerPushes.length === 0,
			"a session that is not the recorded root does not receive the orphan",
		);

		rmSync(dir, { recursive: true, force: true });
	}

	// --- #41 orphan pane: recycle only after the result is delivered ----
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-orphan-close-"));
		const root = join(dir, "root.jsonl");
		const mid = join(dir, "mid.jsonl");
		const leaf = join(dir, "leaf.jsonl");
		const letter = "grandchild pane is empty after delivery.";
		writeSession(leaf, [assistantMsg(letter)]);
		writeFileSync(
			`${leaf}.exit`,
			JSON.stringify({ type: "done", text: letter, rootSession: root }),
		);
		const rootRecords = [
			rec("mid", {
				sessionPath: mid,
				lineage: { rootSession: root, ownerSession: root },
			}),
		];
		const leafRecord = {
			name: "leaf",
			kind: "pi",
			paneId: "w1:leaf",
			sessionPath: leaf,
			stance: "autonomous",
			lineage: { rootSession: root, ownerSession: mid },
		};
		writeFileSync(`${mid}.registry.json`, JSON.stringify([leafRecord]));
		const pushes = [];
		const closes = [];
		const closeNotes = [];
		let pushFails = true;
		let closeFails = false;
		const fleet = [{ paneId: "w1:leaf", status: "done" }];
		const depsFor = (records) => ({
			registry: () => new Map(records.map((r) => [r.name, r])),
			load: () => ({ notifications: "normal" }),
			list: async () => ({
				ok: true,
				data: fleet.map((f) => ({
					paneId: f.paneId,
					agentStatus: f.status,
				})),
			}),
			readRegistry: (sessionPath) => {
				const path = `${sessionPath}.registry.json`;
				if (!existsSync(path)) return [];
				return JSON.parse(readFileSync(path, "utf8"));
			},
			writeRegistry: (sessionPath, records) => {
				writeFileSync(`${sessionPath}.registry.json`, JSON.stringify(records));
			},
			sessionPath: root,
			push: (m) => {
				if (pushFails) throw new Error("push failed");
				pushes.push(m);
			},
			closePane: async (paneId) => {
				// A real asynchronous CLI-style Result exposes missing awaits.
				await sleep(15);
				if (closeFails) {
					closeNotes.push({ paneId, failed: true });
					return { ok: false, error: { message: "orphan pane close failed" } };
				}
				closes.push(paneId);
				return { ok: true };
			},
			now: () => 1_000_000,
		});

		await delivery.deliverOnce(depsFor(rootRecords));
		assert(
			pushes.length === 0 && closes.length === 0 && existsSync(leaf),
			"a failed orphan push does not close the pane and keeps the session",
		);
		assert(
			existsSync(`${mid}.registry.json`) &&
				!JSON.parse(readFileSync(`${mid}.registry.json`, "utf8"))[0].delivery,
			"a failed orphan push is not marked delivered",
		);

		// working / blocked: the letter may be ready, the pane is not empty
		pushFails = false;
		fleet[0].status = "working";
		await delivery.deliverOnce(depsFor(rootRecords));
		assert(
			pushes.length === 0 && closes.length === 0,
			"a working orphan pane is not delivered and not closed",
		);
		fleet[0].status = "blocked";
		await delivery.deliverOnce(depsFor(rootRecords));
		assert(
			pushes.length === 0 && closes.length === 0,
			"a blocked orphan pane is not delivered and not closed",
		);

		fleet[0].status = "done";

		// confirmed delivery, then a failed close is visible and does not delete the session
		closeFails = true;
		await delivery.deliverOnce(depsFor(rootRecords));
		assert(
			pushes.length === 1 &&
				pushes[0].content.includes(letter) &&
				pushes[0].details.adopted === true,
			"a confirmed orphan delivery pushes the letter once",
		);
		assert(
			closes.length === 0 &&
				closeNotes.some(
					(n) => n.paneId === "w1:leaf" && n.failed === true,
				),
			"a failed orphan pane close is observable and does not claim the pane closed",
		);
		assert(existsSync(leaf), "a failed close still retains the session file");
		const savedFailure = JSON.parse(readFileSync(`${mid}.registry.json`, "utf8"))[0];
		assert(
			savedFailure.delivery?.kind === "done" &&
				savedFailure.paneClosePending === true &&
				savedFailure.paneCloseError === "orphan pane close failed",
			"delayed failed close is awaited and its pending/error state is persisted",
		);

		// A fresh in-memory root registry simulates resume; retry must use disk.
		const restoredRoot = () => JSON.parse(JSON.stringify(rootRecords));
		for (const status of ["working", "blocked"]) {
			fleet[0].status = status;
			await delivery.deliverOnce(depsFor(restoredRoot()));
			assert(
				closeNotes.length === 1 && closes.length === 0 && pushes.length === 1,
				`a restored pending orphan close waits while the pane is ${status}`,
			);
		}
		fleet[0].status = "done";

		// the empty pane is recycled only after the letter was delivered
		closeFails = false;
		await delivery.deliverOnce(depsFor(restoredRoot()));
		assert(
			closes.includes("w1:leaf") && pushes.length === 1 && existsSync(leaf),
			"after the result is delivered the empty orphan pane is recycled and the session stays",
		);

		const savedSuccess = JSON.parse(readFileSync(`${mid}.registry.json`, "utf8"))[0];
		assert(
			!savedSuccess.paneClosePending && !savedSuccess.paneCloseError,
			"a successful restored retry clears the persisted close failure",
		);

		// A human may take over between failure and retry, without registry writes.
		writeFileSync(`${mid}.registry.json`, JSON.stringify([savedFailure]));
		writeFileSync(`${leaf}.takeover`, JSON.stringify({ at: 1_000_001 }));
		const beforeRetryTakeover = closes.length;
		await delivery.deliverOnce(depsFor(restoredRoot()));
		assert(
			closes.length === beforeRetryTakeover && pushes.length === 1 &&
				JSON.parse(readFileSync(`${mid}.registry.json`, "utf8"))[0].takenOver === true,
			"a fresh-memory close retry rereads the takeover marker and holds the pane",
		);

		// takeover: the letter can be delivered, the pane is not recycled
		const held = join(dir, "held.jsonl");
		writeSession(held, [assistantMsg("human is driving")]);
		writeFileSync(
			`${held}.exit`,
			JSON.stringify({
				type: "done",
				text: "human is driving",
				rootSession: root,
			}),
		);
		writeFileSync(
			`${mid}.registry.json`,
			JSON.stringify([
				{
					...leafRecord,
					name: "held",
					paneId: "w1:held",
					sessionPath: held,
				},
			]),
		);
		writeFileSync(`${held}.takeover`, JSON.stringify({ at: 1_000_002 }));
		fleet.push({ paneId: "w1:held", status: "done" });
		const beforeHeld = pushes.length;
		const beforeClose = closes.length;
		await delivery.deliverOnce(depsFor(rootRecords));
		await delivery.deliverOnce(depsFor(rootRecords));
		assert(
			pushes.length === beforeHeld + 1 &&
				pushes.at(-1).content.includes("human is driving") &&
				closes.length === beforeClose &&
				existsSync(held),
			"a taken-over orphan pane is not recycled after its result is delivered",
		);

		rmSync(dir, { recursive: true, force: true });
	}

	// --- #38: sidecar eventId is copied onto the terminal push only ------
	{
		const dir = mkdtempSync(join(tmpdir(), "pi-herdr-event-"));
		const sess = join(dir, "s.jsonl");
		writeSession(sess, [assistantMsg("letter body")]);
		const r = rec("scout", { sessionPath: sess });
		const w = world([r], { fleet: [{ paneId: r.paneId, status: "done" }] });
		writeFileSync(
			`${sess}.exit`,
			JSON.stringify({ type: "done", text: "letter body", eventId: "evt-from-disk" }),
		);
		const read = sf.readExitSidecar(sess);
		await w.tick();
		assert(
			read.state === "ok" &&
				read.sidecar.eventId === "evt-from-disk" &&
				w.pushes[0]?.details.eventId === read.sidecar.eventId,
			"sidecar JSON → readExitSidecar → deliverOnce push details.eventId equals the sidecar",
		);

		const errSess = join(dir, "e.jsonl");
		writeSession(errSess, [assistantMsg("boom", { stopReason: "error" })]);
		const er = rec("errant", { sessionPath: errSess, paneId: "w1:errant" });
		const ew = world([er], { fleet: [{ paneId: er.paneId, status: "done" }] });
		writeFileSync(
			`${errSess}.exit`,
			JSON.stringify({
				type: "error",
				errorMessage: "overload",
				stopReason: "error",
				eventId: "evt-error-disk",
			}),
		);
		await ew.tick();
		assert(
			ew.pushes[0]?.details.kind === "error" &&
				ew.pushes[0]?.details.eventId === "evt-error-disk",
			"an error sidecar's eventId is copied onto the error push",
		);

		const adoptedSess = join(dir, "a.jsonl");
		writeSession(adoptedSess, [assistantMsg("adopted letter")]);
		writeFileSync(
			`${adoptedSess}.exit`,
			JSON.stringify({
				type: "done",
				text: "adopted letter",
				eventId: "evt-adopted",
				rootSession: sess,
			}),
		);
		const mid = join(dir, "mid.jsonl");
		writeFileSync(
			`${mid}.registry.json`,
			JSON.stringify([
				{
					name: "leaf",
					kind: "pi",
					paneId: "w1:leaf-evt",
					sessionPath: adoptedSess,
					stance: "autonomous",
					lineage: { rootSession: sess, ownerSession: mid },
				},
			]),
		);
		const pushes = [];
		await delivery.deliverOnce({
			registry: () =>
				new Map([
					[
						"mid",
						rec("mid", {
							sessionPath: mid,
							paneId: "w1:mid-gone",
							lineage: { rootSession: sess, ownerSession: sess },
						}),
					],
				]),
			load: () => ({ notifications: "normal" }),
			list: async () => ({
				ok: true,
				data: [{ paneId: "w1:leaf-evt", agentStatus: "done" }],
			}),
			readRegistry: (sessionPath) => {
				const path = `${sessionPath}.registry.json`;
				if (!existsSync(path)) return [];
				return JSON.parse(readFileSync(path, "utf8"));
			},
			sessionPath: sess,
			push: (m) => pushes.push(m),
			closePane: async () => {},
			now: () => 1_000_000,
		});
		assert(
			pushes[0]?.details.adopted === true &&
				pushes[0]?.details.eventId === "evt-adopted",
			"an adopted done push copies sidecar.eventId",
		);

		const blocked = rec("waiter", { paneId: "w1:blocked" });
		const bw = world([blocked], {
			fleet: [{ paneId: blocked.paneId, status: "blocked" }],
		});
		await bw.tick();
		assert(
			bw.pushes[0]?.details.kind === "blocked" &&
				bw.pushes[0]?.details.eventId === undefined,
			"a blocked wake does not carry a completion eventId",
		);

		const gone = rec("ghost", { paneId: "w1:gone", sessionPath: undefined });
		const gw = world([gone], { fleet: [], goneGraceMs: 0 });
		gw.advance(1);
		await gw.tick();
		await gw.tick();
		assert(
			gw.pushes.some((p) => p.details.kind === "gone") &&
				gw.pushes.every((p) => p.details.eventId === undefined),
			"a gone note does not carry a completion eventId",
		);

		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------

try {
	rmSync(tmp, { recursive: true, force: true });
} catch {
	/* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
