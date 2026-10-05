// Push delivery (v0.6 issue 06): ONE shared poll loop that watches the spawn
// registry and steers terminal events into THIS session — the push carries
// the letter (the child's full final assistant message), no doorbell, no
// summary-then-fetch. Tickets 07 (status projection) and 08/11 (workflows)
// hang off the same loop.
//
// Completion detection is triply redundant (research §3):
//   1. exit sidecar (`<session>.exit`, typed done/error, optional rearm) —
//      the child's own terminal declaration (auto-settle or `agent_done`);
//   2. terminal sentinel — the agent vanished with no sidecar: after a
//      bounded grace, the session JSONL's last assistant message is the
//      delivered letter (typed error when stopReason=error) — a death the
//      sidecar missed still delivers;
//   3. pane disappearance — the same absence path lands on an honest gone
//      note when there is nothing on disk to deliver.
// Transient herdr errors are never absence evidence (the tick is skipped).
//
// Wake governance (the `notifications` setting): `normal` → steer + wake,
// `quiet` → next natural turn (no wake), `none` → no terminal push at all
// (pull-only; results stay in the registry + JSONL). A `done` push read while
// the orchestrator is busy queues as followUp + wake instead of steer — the
// running tool is not cancelled. blocked and stalled stay steer. error keeps
// the notifications matrix (quiet → nextTurn, none → no push, normal → steer).
// A BLOCKED child always wakes regardless of the setting — unless a human took
// the pane over (no mid-conversation pushes from a taken-over pane; the human
// is right there).
//
// User takeover arrives as the `<session>.takeover` marker written by the
// child extension (human typing that is not the parent's own steer echo):
// the loop sends the quiet `user took over <agent>` note once and holds back
// mid-conversation pushes for that record. A final result still lands —
// declared (`agent_done`) or re-armed (idle re-arm, labeled).

import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetList, herdr } from "./herdr.js";
import { extractText, type NormalizedAgent, type Result } from "./env.js";
import {
	getSettingsPaths,
	loadSettings,
	type HerdrSettings,
} from "./settings.js";
import {
	extractSessionResult,
	minedAssistantError,
	readExitSidecar,
	readTakeoverMarker,
	sidecarPathFor,
	type ExtractedResult,
	type ReadSidecarResult,
	type ReadTakeoverResult,
} from "./sessionfile.js";
import {
	isSubstrateChild,
	readActivityFile,
	STALL_AFTER_MS,
	type ActivityRead,
} from "./status.js";
import { fleetWidgetOnce } from "./widget.js";
import {
	readPersistedRegistry,
	spawnRecords,
	writePersistedRegistry,
	type DeliveryKind,
	type SpawnRecord,
} from "./spawn.js";
import {
	currentOrchestratorSession,
	type DeliverAs,
	type SteeredMessage,
	makeDeliverySink,
	rememberOrchestratorSession,
	trackOrchestratorBusy,
	terminalWake,
} from "./push.js";

export { makeDeliverySink };

// ---- types -----------------------------------------------------------------

/** Injectable seams (offline red-green; defaults hit herdr + disk). */
export interface DeliveryDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** Effective settings (notifications) — default: live settings read. */
	load?: () => HerdrSettings;
	/** One fleet observation per tick — default: the shared fleetList(). */
	list?: () => Promise<Result<NormalizedAgent[]>>;
	/** Completion-sidecar read — default: readExitSidecar. */
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	/** Takeover-marker read — default: readTakeoverMarker. */
	readTakeover?: (sessionPath: string) => ReadTakeoverResult;
	/** Session-JSONL extraction — default: extractSessionResult. */
	extract?: (sessionPath: string) => ExtractedResult | null;
	/** The steer sink — default: pi.sendMessage into THIS session. */
	push?: (msg: SteeredMessage) => void;
	now?: () => number;
	/** Bounded grace between first absence and the gone resolution (10s). */
	goneGraceMs?: number;
	/** A pre-fetched fleet observation (shared with the watchdog so one tick
	 * costs one `agent list`). When set, `list` is not called. */
	fleet?: Result<NormalizedAgent[]>;
	/** Best-effort pane close after a terminal delivery (manual e2e F2) —
	 * default: `herdr pane close` (the session is retained). */
	closePane?: (paneId: string) => Promise<unknown>;
	/** Pane-tail read for kinds with no session file — default: `herdr agent read`.
	 * Throws (or rejects) when the read itself failed; an empty string is a pane
	 * that was read and held nothing. */
	readTail?: (paneId: string) => Promise<string>;
	/**
	 * Orchestrator streaming state at the moment of a push. True while a run
	 * (or compaction) is in progress. Default false — older callers stay on
	 * the idle steer path. A true reading queues a `done` push as followUp;
	 * it does not cancel a tool that is already running.
	 */
	busy?: () => boolean;
	/** Sidecar appearance watcher. Default: fs.watch on the session's directory.
	 * A throw means the watcher is unavailable; the 2.5s poll remains the backstop. */
	watchSidecar?: (
		path: string,
		onWrite: (event: { mtimeMs?: number }) => void,
	) => { close(): void };
	/** Debug line (detect latency). Default: stderr, so a quiet parent stays quiet. */
	debug?: (line: string) => void;
	/** Sidecar mtime in ms epoch, measured when the push is about to land.
	 * Default: the file's mtime. */
	sidecarWrittenAt?: (sessionPath: string) => number | undefined;
	/** This orchestrator's session file. Default: the path remembered at
	 * session_start. Adoption only delivers into this session. */
	sessionPath?: string;
	/** Another session's persisted spawn registry. A throw is a failed
	 * observation — not an empty registry, and not an orphan. */
	readRegistry?: (sessionPath: string) => readonly SpawnRecord[];
	/** Write a registry back after an adopted delivery so resume does not
	 * push the same letter again. */
	writeRegistry?: (sessionPath: string, records: readonly SpawnRecord[]) => void;
}

// ---- push composition ---------------------------------------------------------

/** Session-retained pointer appended to pi children's pushes. */
function sessionNote(record: SpawnRecord): string {
	return record.sessionPath
		? ` (session: ${record.sessionPath} — retained for resume)`
		: "";
}

function tailContent(record: SpawnRecord, text: string): string {
	return `Agent "${record.name}" finished — pane output:\n\n${text.trim()}`;
}

/** Read the pane tail. A failed read throws so the caller can retry the tick;
 * an empty string means the pane was read and held nothing. */
async function readPaneTail(deps: DeliveryDeps, paneId: string | undefined): Promise<string> {
	if (!paneId) return "";
	const read =
		deps.readTail ??
		(async (id: string) => {
			const r = await herdr<unknown>(
				["agent", "read", id, "--source", "recent", "--lines", "200", "--format", "text"],
				{ timeoutMs: 15_000, textOk: true },
			);
				if (!r.ok) throw new Error(r.error.message);
				return extractText(r.data);
			});
	return read(paneId);
}

/** Autonomous, not taken over, not a workflow child. Those panes stay open. */
function ownsPane(record: SpawnRecord): boolean {
	return record.stance === "autonomous" && !record.takenOver && !record.workflow;
}

/**
 * Fleet says the child settled, and this record is one we close. Not enough
 * on its own for a session-less child: the prompt may not be in the pane yet.
 */
function shouldCloseSettled(record: SpawnRecord, live: string | undefined): boolean {
	return ownsPane(record) && (live === "idle" || live === "done");
}

function doneContent(
	record: SpawnRecord,
	extracted: ExtractedResult | null,
	rearm: boolean,
	sidecarText?: string,
): string {
	const label = rearm ? "auto-delivered after user steer: " : "";
	const committed = sidecarText?.trim() ? sidecarText : undefined;
	const mined = extracted && extracted.text.trim() ? extracted.text : undefined;
	const body =
		committed ??
		mined ??
		"(the child finished but its session file holds no assistant message)";
	return `${label}Agent "${record.name}" finished — full final message:\n\n${body}${sessionNote(record)}`;
}

function errorContent(
	record: SpawnRecord,
	errorMessage: string,
	extracted: ExtractedResult | null,
	rearm: boolean,
): string {
	const label = rearm ? "auto-delivered after user steer: " : "";
	const body =
		extracted && extracted.text.trim() ? `\n\nLast message:\n${extracted.text}` : "";
	return `${label}Agent "${record.name}" FAILED: ${errorMessage}${body}${sessionNote(record)}`;
}

function goneContent(record: SpawnRecord): string {
	return `Agent "${record.name}" is gone (no live pane; it died or its pane was closed without completing).${sessionNote(record)}`;
}

// ---- the delivery pass --------------------------------------------------------

/**
 * One pass over the registry: takeover notes, terminal pushes, blocked wakes.
 * Non-blocking — the loop calls it on an interval; tests call it directly and
 * advance their own clock between calls.
 */
export async function deliverOnce(deps: DeliveryDeps = {}): Promise<void> {
	const registry = (deps.registry ?? spawnRecords)();
	if (registry.size === 0) return;
	const records = [...registry.values()];
	const now = deps.now ?? (() => Date.now());
	const push = deps.push ?? (() => {});
	const graceMs = deps.goneGraceMs ?? 10_000;

	// One fleet observation per tick. A FAILED observation is not absence
	// evidence — skip the whole tick rather than risk false gones.
	const fleet = deps.fleet ?? (await (deps.list ?? fleetList)());
	if (!fleet.ok) return;
	const statusByPane = new Map<string, string>();
	for (const a of fleet.data) {
		if (a.paneId && a.agentStatus) statusByPane.set(a.paneId, a.agentStatus);
	}
	// Actively live = mid-work or waiting on input — a pane in this state is
	// never closed under a terminal delivery (guard; also the auto-exit race:
	// the retry sweep holds until the fleet stops listing the pane).
	const paneLive = (paneId: string | undefined): boolean => {
		if (!paneId) return false;
		const s = statusByPane.get(paneId);
		return s === "working" || s === "blocked";
	};

	for (const record of records) {
		// --- takeover marker → quiet note, once. Sent regardless of the
		// notifications setting (no-wake either way; the orchestrator must
		// learn auto-exit is off).
		if (record.sessionPath && !record.tookNotified) {
			const t = (deps.readTakeover ?? readTakeoverMarker)(record.sessionPath);
			if (t.taken) {
				record.takenOver = true;
				record.tookNotified = true;
				push({
					content: `user took over ${record.name}`,
					details: { name: record.name, kind: "takeover" },
					wake: false,
				});
			}
		}

		if (record.delivery) {
			// Terminal already steered — one push per event. A pane close skipped
			// by the live-agent guard (the auto-exit race) retries here: once the
			// fleet stops listing the pane, the leftover empty pane still closes
			// (manual e2e F2 — the promise must not lose the race).
			if (record.paneClosePending && record.paneId && !paneLive(record.paneId)) {
				attemptPaneClose(deps, record);
			}
			continue;
		}

		// --- never started (a queued record failed in the drain loop, after
		// the spawn tool had already returned "queued")
		if (record.startError) {
			deliverTerminal(deps, record, "start-error", {
				content: `Agent "${record.name}" never started: ${record.startError}`,
				details: { name: record.name, kind: "start-error" },
				wake: terminalWake(notifications(deps)),
			});
			continue;
		}
		if (!record.paneId) continue; // still queued — nothing to watch yet

		// --- route 1: the typed sidecar (pi children). The child's own
		// terminal declaration wins over anything the fleet says.
		const isPi = record.kind.toLowerCase() === "pi" && Boolean(record.sessionPath);
		if (isPi && record.sessionPath) {
			const sidecar = (deps.readSidecar ?? readExitSidecar)(record.sessionPath);
			if (sidecar.state === "ok") {
				deliverSidecar(record, sidecar.sidecar, deps, paneLive(record.paneId));
				continue;
			}
		}

		const live = statusByPane.get(record.paneId);
		if (live === undefined) {
			// --- routes 2+3: absence evidence. First sight starts the bounded
			// grace (a dying auto-exit writes its sidecar just before exit and
			// the fleet may drop it first); expiry resolves by best evidence.
			if (record.goneAt === undefined) {
				record.goneAt = now();
				continue;
			}
			if (now() - record.goneAt < graceMs) continue; // still in grace
			if (isPi && record.sessionPath) {
				const extracted = (deps.extract ?? extractSessionResult)(
					record.sessionPath,
				);
				if (extracted) {
					// the sentinel: a sidecar-less death whose last message is
					// still deliverable (typed error when stopReason=error)
					const mined = minedAssistantError(extracted.message);
					if (mined) {
						deliverTerminal(
							deps,
							record,
							"error",
							{
								content: errorContent(record, mined.errorMessage, extracted, false),
								details: {
									name: record.name,
									kind: "error",
									error: mined,
									message: extracted.message,
									sessionPath: record.sessionPath,
								},
								wake: terminalWake(notifications(deps)),
							},
						);
					} else {
						deliverTerminal(
							deps,
							record,
							"done",
							{
								content: doneContent(record, extracted, false),
								details: {
									name: record.name,
									kind: "done",
									result: extracted.text,
									message: extracted.message,
									sessionPath: record.sessionPath,
								},
								wake: terminalWake(notifications(deps)),
							},
						);
					}
					continue;
				}
			}
			// route 3: nothing on disk — an honest gone note (session retained)
			deliverTerminal(
				deps,
				record,
				"gone",
				{
					content: goneContent(record),
					details: { name: record.name, kind: "gone" },
					wake: terminalWake(notifications(deps)),
				},
			);
			continue;
		}

		// present again — grace resets. A live working turn is the evidence
		// the prompt landed; spawn stamps the same flag, but only when
		// something asks it for a status.
		record.goneAt = undefined;
		record.lastStatus = live;
		if (live === "working") record.sawWorking = true;

		// --- blocked always wakes (unless a human has the pane); the wake is
		// per blocked episode, not per tick.
		if (live === "blocked") {
			if (!record.blockedNotified && !record.takenOver) {
				record.blockedNotified = true;
				// always wakes — the notifications setting does not apply
				push({
					content:
						`Agent "${record.name}" is BLOCKED on a question and needs input — ` +
						`answer with herdr_message_agent (raw text) or herdr_send_keys (option lists).`,
					details: { name: record.name, kind: "blocked" },
					wake: true,
					deliverAs: "steer",
				});
			}
			continue;
		}
		record.blockedNotified = false; // fresh episodes re-wake

		// Fleet reports idle or done. Pi children with a session deliver the
		// JSONL — including the no-sidecar case: an autonomous child whose
		// shell never got PI_HERDR_AUTO_EXIT would otherwise sit idle forever,
		// so what the session already holds is delivered and the pane closes.
		// Every other kind has no sidecar, so the pane tail is the letter —
		// but only after a working turn was seen, or the fleet says `done`.
		// `submitted` is stamped even when the prompt never landed, and a
		// pre-submit pane is already idle. Then close the pane. Interactive,
		// takeover, and workflow children stay open.
		if (shouldCloseSettled(record, live)) {
			if (isPi && record.sessionPath) {
				const extracted = (deps.extract ?? extractSessionResult)(record.sessionPath);
				const stop = (extracted?.message as { stopReason?: unknown } | undefined)?.stopReason;
				if (extracted && (stop === "stop" || stop === "error")) {
					const mined = minedAssistantError(extracted.message);
					deliverTerminal(
						deps,
						record,
						mined ? "error" : "done",
						mined
							? {
									content: errorContent(record, mined.errorMessage, extracted, false),
									details: { name: record.name, kind: "error", error: mined, message: extracted.message, sessionPath: record.sessionPath },
									wake: terminalWake(notifications(deps)),
								}
							: {
									content: doneContent(record, extracted, false),
									details: { name: record.name, kind: "done", result: extracted.text, message: extracted.message, sessionPath: record.sessionPath },
									wake: terminalWake(notifications(deps)),
								},
					);
				} else {
					continue; // still mid-run, or nothing deliverable yet
				}
			} else if (record.sawWorking || live === "done") {
				// Read before marking. A failed read throws out of this tick
				// (the loop swallows it) and the record stays unmarked, so
				// the next tick retries. An empty tail is not a result.
				const text = await readPaneTail(deps, record.paneId);
				if (!text.trim()) continue;
				deliverTerminal(deps, record, "done", {
					content: tailContent(record, text),
					details: { name: record.name, kind: "done", result: text },
					wake: terminalWake(notifications(deps)),
				});
			}
		}
	}

	await adoptOrphans(deps, records, statusByPane);
}

/**
 * Claim a settled child whose registry owner is gone (issue 39). The owner
 * is gone only when this tick's fleet does not list its pane. A registry
 * read that throws is a failed observation, not an empty registry, and is
 * not a claim. A living owner keeps the result. The letter is pushed into
 * THIS session only when the record and sidecar name it as the root.
 * The owner's registry is written back with the delivery mark so a later
 * tick — including resume — does not push the same letter again.
 */
async function adoptOrphans(
	deps: DeliveryDeps,
	records: SpawnRecord[],
	statusByPane: Map<string, string>,
): Promise<void> {
	const self = deps.sessionPath ?? currentOrchestratorSession();
	if (!self) return;
	const read = deps.readRegistry ?? readPersistedRegistry;
	const write = deps.writeRegistry ?? writePersistedRegistry;
	const seen = new Set<string>();
	const pending = [...records];
	while (pending.length > 0) {
		const owner = pending.shift();
		if (!owner?.sessionPath || !owner.paneId || seen.has(owner.sessionPath)) continue;
		if (statusByPane.has(owner.paneId)) continue;
		seen.add(owner.sessionPath);
		let children: SpawnRecord[];
		try {
			children = [...read(owner.sessionPath)];
		} catch {
			continue;
		}
		let dirty = false;
		for (const child of children) {
			if (child.sessionPath && child.paneId && !statusByPane.has(child.paneId)) {
				pending.push(child);
			}
			if (child.delivery) {
				// The letter was already confirmed. A rejected close stays pending
				// and is retried here — working/blocked and takeover still hold the
				// pane (the same guards as the first close).
				if (child.paneClosePending && child.paneId) {
					const again = statusByPane.get(child.paneId);
					if (again !== "working" && again !== "blocked") {
						await closeDeliveredPane(deps, child, false, false);
						dirty = true;
					}
				}
				continue;
			}
			const live = child.paneId ? statusByPane.get(child.paneId) : undefined;
			if (live !== "done" && live !== "idle") continue;
			if (!child.sessionPath || child.kind.toLowerCase() !== "pi") continue;
			if (child.lineage?.rootSession !== self) continue;
			const sidecar = (deps.readSidecar ?? readExitSidecar)(child.sessionPath);
			if (sidecar.state !== "ok") continue;
			if (sidecar.sidecar.rootSession && sidecar.sidecar.rootSession !== self) continue;
			await deliverSidecar(child, sidecar.sidecar, deps, false, true);
			dirty = true;
		}
		if (!dirty) continue;
		try {
			write(owner.sessionPath, children);
		} catch {
			/* the in-memory mark is lost with this read; the next tick retries */
		}
	}
}

async function deliverSidecar(
	record: SpawnRecord,
	sidecar:
		| { type: "done"; rearm?: true; text?: string }
		| { type: "error"; errorMessage: string; stopReason: string; rearm?: true },
	deps: DeliveryDeps,
	paneLive = false,
	adopted = false,
): Promise<void> {
	const notes = notifications(deps);
	const extracted = record.sessionPath
		? (deps.extract ?? extractSessionResult)(record.sessionPath)
		: null;
	const rearm = sidecar.rearm === true;
	const adoptedFlag = adopted ? { adopted: true as const } : {};
	if (sidecar.type === "done") {
		const committed = sidecar.text?.trim() ? sidecar.text : undefined;
		deliverTerminal(
			deps,
			record,
			"done",
			{
				content: doneContent(record, extracted, rearm, committed),
				details: {
					name: record.name,
					kind: "done",
					...adoptedFlag,
					...(rearm ? { rearm: true } : {}),
					result: committed ?? extracted?.text,
					...(extracted ? { message: extracted.message } : {}),
					...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
				},
				wake: terminalWake(notes),
			},
			paneLive,
			adopted,
		);
		return;
	}
	await deliverTerminal(
		deps,
		record,
		"error",
		{
			content: errorContent(record, sidecar.errorMessage, extracted, rearm),
			details: {
				name: record.name,
				kind: "error",
				...adoptedFlag,
				...(rearm ? { rearm: true } : {}),
				error: { stopReason: sidecar.stopReason, errorMessage: sidecar.errorMessage },
				...(extracted ? { message: extracted.message } : {}),
				...(record.sessionPath ? { sessionPath: record.sessionPath } : {}),
			},
			wake: terminalWake(notes),
		},
		paneLive,
		adopted,
	);
}

// ---- small helpers ------------------------------------------------------------

function markTerminal(record: SpawnRecord, kind: DeliveryKind, now: () => number): void {
	record.delivery = { kind, at: now() };
}

// ---- the pane-close promise (manual e2e F2) ----------------------------------

/** Injectable-seam default: the herdr CLI, same shape as the workflow host's
 * abort close (best-effort, bounded budget). */
const defaultClosePane = (paneId: string): Promise<unknown> =>
	herdr(["pane", "close", paneId], { timeoutMs: 10_000 });

/** Fire the close once and clear the pending flag — never retried after a
 * failed attempt (best-effort, like the kill-all path). */
function attemptPaneClose(deps: DeliveryDeps, record: SpawnRecord): void {
	record.paneClosePending = false;
	if (!record.paneId) return;
	void (deps.closePane ?? defaultClosePane)(record.paneId).catch(() => {});
}

/**
 * The documented promise, kept at the single choke point (manual e2e F2): a
 * terminally delivered child's pane closes — the child has exited on every
 * terminal route (the sidecar IS its exit declaration; sentinel/gone mean the
 * fleet no longer lists it), so the leftover empty pane goes too. Sessions are
 * never deleted (issue 04 ruling), so closing loses nothing. Guards: no pane
 * (queued/never-started), a pane the fleet still reports actively live
 * (working/blocked — defensive; held as pending and retried on later ticks,
 * because a dying auto-exit can still be listed when its sidecar lands), and
 * a taken-over pane that has not re-arm-delivered (the human is driving; only
 * the re-arm delivery closes it).
 */
function closeRecordPane(
	deps: DeliveryDeps,
	record: SpawnRecord,
	rearm: boolean,
	paneLive: boolean,
): void {
	if (!record.paneId) return;
	if (record.takenOver && !rearm) return;
	if (paneLive) {
		record.paneClosePending = true;
		return;
	}
	attemptPaneClose(deps, record);
}

/**
 * Mark a record's terminal event, then steer it — UNLESS the record belongs to
 * a workflow run (v0.6 issue 12): the RUN reports for its children, so the
 * per-child push is suppressed while the delivery mark (row leaves the fleet,
 * one event per record) still happens. The pane-close promise is fleet-wide
 * (manual e2e F2/F10): a settled child's pane closes at its terminal mark,
 * workflow children included — the run's abort close remains as the in-flight
 * backstop, and a best-effort double close is harmless. Takeover notes and
 * blocked wakes are NOT routed through here — a blocked workflow child still
 * wakes the orchestrator, whose answer via herdr_message_agent resumes it.
 */
/** Busy read at push time. A throwing or missing probe stays idle. */
function orchestratorIsBusy(deps: { busy?: () => boolean }): boolean {
	try {
		return deps.busy?.() === true;
	} catch {
		return false;
	}
}

/**
 * Delivery mode for one push. Only a waking `done` queues while busy
 * (followUp). error/gone/start-error follow notifications. blocked and
 * stalled are steer even when busy — followUp would wait out the run.
 */
function deliverAsFor(
	deps: DeliveryDeps,
	kind: DeliveryKind | "stalled" | "stall-recovered" | "blocked",
): DeliverAs {
	if (kind === "blocked" || kind === "stalled" || kind === "stall-recovered") {
		return "steer";
	}
	if (!terminalWake(notifications(deps))) return "nextTurn";
	if (kind === "done" && orchestratorIsBusy(deps)) return "followUp";
	return "steer";
}

async function deliverTerminal(
	deps: DeliveryDeps,
	record: SpawnRecord,
	kind: DeliveryKind,
	msg: SteeredMessage,
	paneLive = false,
	adopted = false,
): Promise<void> {
	if (adopted) {
		await deliverAdopted(deps, record, kind, msg, paneLive);
		return;
	}
	markTerminal(record, kind, deps.now ?? (() => Date.now()));
	closeRecordPane(deps, record, msg.details.rearm === true, paneLive);
	if (record.workflow) return;
	pushTerminal(
		deps,
		{ ...msg, deliverAs: msg.deliverAs ?? deliverAsFor(deps, kind) },
		notifications(deps),
	);
}

/**
 * Orphan letter (issue 41): the push has to land before the pane is recycled.
 * A rejected push leaves the record unmarked and the pane open. A rejected
 * close is recorded on the record and retried later; the session file stays.
 */
async function deliverAdopted(
	deps: DeliveryDeps,
	record: SpawnRecord,
	kind: DeliveryKind,
	msg: SteeredMessage,
	paneLive: boolean,
): Promise<void> {
	if (!record.workflow) {
		try {
			pushTerminal(
				deps,
				{ ...msg, deliverAs: msg.deliverAs ?? deliverAsFor(deps, kind) },
				notifications(deps),
			);
		} catch (err) {
			record.pushError = err instanceof Error ? err.message : String(err);
			return;
		}
	}
	record.pushError = undefined;
	markTerminal(record, kind, deps.now ?? (() => Date.now()));
	await closeDeliveredPane(deps, record, msg.details.rearm === true, paneLive);
}

/** Same guards as closeRecordPane, but the rejection is visible on the record. */
async function closeDeliveredPane(
	deps: DeliveryDeps,
	record: SpawnRecord,
	rearm: boolean,
	paneLive: boolean,
): Promise<void> {
	if (!record.paneId) return;
	if (record.takenOver && !rearm) return;
	if (paneLive) {
		record.paneClosePending = true;
		return;
	}
	record.paneClosePending = false;
	try {
		await (deps.closePane ?? defaultClosePane)(record.paneId);
		record.paneCloseError = undefined;
	} catch (err) {
		record.paneClosePending = true;
		record.paneCloseError = err instanceof Error ? err.message : String(err);
	}
}

function notifications(deps: DeliveryDeps): HerdrSettings["notifications"] {
	return (deps.load ?? defaultLoad)().notifications;
}

/**
 * Terminal pushes honor `notifications: none` by NOT steering (pull-only) —
 * but the event is still marked delivered in the registry, so 07 can prune
 * the row and the loop never re-pushes.
 */
function pushTerminal(
	deps: DeliveryDeps,
	msg: SteeredMessage,
	notes: HerdrSettings["notifications"],
): void {
	if (notes === "none") return;
	logDetectLatency(deps, msg);
	(deps.push ?? (() => {}))(msg);
}

const defaultLoad = (): HerdrSettings =>
	loadSettings(getSettingsPaths(process.cwd())).effective;

// ---- the watchdog (v0.6 issue 07) ----------------------------------------------

/** Injectable seams for watchdogOnce (offline red-green; defaults hit herdr
 * + disk). */
export interface WatchdogDeps {
	/** The session spawn registry — default: the LIVE spawnRecords(). */
	registry?: () => ReadonlyMap<string, SpawnRecord>;
	/** One fleet observation — default: the shared fleetList(). */
	list?: () => Promise<Result<NormalizedAgent[]>>;
	/** Pre-fetched observation (shared with deliverOnce — one list per tick). */
	fleet?: Result<NormalizedAgent[]>;
	/** Completion-sidecar read — default: readExitSidecar. */
	readSidecar?: (sessionPath: string) => ReadSidecarResult;
	/** Activity-sidecar read — default: readActivityFile (src/status.ts). */
	readActivity?: (activityPath?: string) => ActivityRead;
	/** Session-JSONL extraction — default: extractSessionResult. */
	extract?: (sessionPath: string) => ExtractedResult | null;
	/** The steer sink — default: pi.sendMessage into THIS session. */
	push?: (msg: SteeredMessage) => void;
	/** Accepted so a tick can pass the same probe. Stall pings stay steer. */
	busy?: () => boolean;
	now?: () => number;
	/** How long a broken-substrate problem must hold before `stalled`.
	 * Default STALL_AFTER_MS (60s, prior art). */
	stallAfterMs?: number;
}

/** First sighting of a broken-substrate problem (idempotent). */
function stampProblem(record: SpawnRecord, now: number): number {
	record.watch ??= {};
	record.watch.problemSince ??= now;
	return record.watch.problemSince;
}

/**
 * One watchdog pass over the registry. Stall rules reference ONLY broken-
 * substrate evidence: a pane vanished without a completion sidecar, a
 * substrate child whose activity snapshot stays missing/invalid while herdr
 * reports it working, or a fleet-level inspection outage that outlasts the
 * threshold. Aged-but-valid `active`/`waiting` snapshots are healthy no
 * matter how old: the state never stalls merely by aging (ticket ruling).
 * The projected stalled STATE stays derived (src/status.ts); this pass only
 * stamps `record.watch` bookkeeping (problem age, ping-once-per-episode) and
 * steers the pings — entry + recovery — AUTONOMOUS agents only. Interactive
 * panes stay widget-only: a steer there burns an orchestrator turn on a
 * no-op.
 */
export async function watchdogOnce(deps: WatchdogDeps = {}): Promise<void> {
	const registry = (deps.registry ?? spawnRecords)();
	if (registry.size === 0) return;
	const now = deps.now ?? (() => Date.now());
	const push = deps.push ?? (() => {});
	const stallAfterMs = deps.stallAfterMs ?? STALL_AFTER_MS;

	const fleet = deps.fleet ?? (await (deps.list ?? fleetList)());

	for (const record of registry.values()) {
		// queued / never-started / delivered records are out of scope
		if (!record.paneId || record.startError || record.delivery) continue;

		const was = record.watch?.stalled ?? false;
		let stalled = false;
		let reason = "";

		if (!fleet.ok) {
			// Inspection unhealthy at fleet level: never absence evidence, but
			// every watchable pane is blind to us — stamp the problem and
			// stall+ping past the threshold; a later healthy tick recovers.
			const heldMs = now() - stampProblem(record, now());
			if (heldMs >= stallAfterMs) {
				stalled = true;
				reason = `herdr fleet inspection unavailable for ${Math.round(heldMs / 1000)}s`;
			}
		} else {
			const sidecarOk =
				isSubstrateChild(record) &&
				record.sessionPath &&
				(deps.readSidecar ?? readExitSidecar)(record.sessionPath).state ===
					"ok";
			const present = fleet.data.some((a) => a.paneId === record.paneId);
			const live = fleet.data.find((a) => a.paneId === record.paneId)
				?.agentStatus;
			let problem = false;

			const settled = record.sessionPath
				? (deps.extract ?? extractSessionResult)(record.sessionPath)
				: null;
			const stop = (settled?.message as { stopReason?: unknown } | undefined)?.stopReason;
			const finished = stop === "stop" || stop === "error";

			if (!present && !sidecarOk && !finished) {
				stalled = true;
				reason = "the pane vanished without a completion sidecar";
			} else if (
				present &&
				isSubstrateChild(record) &&
				!sidecarOk &&
				live === "working"
			) {
				const read = (deps.readActivity ?? readActivityFile)(
					record.activityPath,
				);
				if (read.state !== "ok") {
					problem = true;
					const heldMs = now() - stampProblem(record, now());
					if (heldMs >= stallAfterMs) {
						stalled = true;
						reason = `no usable activity snapshot for ${Math.round(heldMs / 1000)}s`;
					}
				}
			}
			// healthy presence (or a completion sidecar in hand): clear stamps
			if (!problem && !stalled && record.watch)
				record.watch.problemSince = undefined;
		}

		record.watch ??= {};
		record.watch.stalled = stalled;
		if (stalled === was) continue; // no episode edge — nothing to say
		if (record.stance !== "autonomous") continue; // interactive: widget-only

		if (stalled) {
			push({
				content:
					`Agent "${record.name}" looks STALLED (${reason}). ` +
					`Steer it with herdr_message_agent, or inspect with herdr_get_agent_result.`,
				details: { name: record.name, kind: "stalled", reason },
				wake: true,
				deliverAs: "steer",
			});
		} else {
			push({
				content: `Agent "${record.name}" recovered from a stall — responsive again.`,
				details: { name: record.name, kind: "stall-recovered" },
				wake: true,
				deliverAs: "steer",
			});
		}
	}
}

// ---- the loop -----------------------------------------------------------------

const DELIVERY_INTERVAL_MS = 2_500;

let deliveryTimer: NodeJS.Timeout | null = null;
let exitWatch: ReturnType<typeof observeExitSidecars> | null = null;

/** Sidecar mtime at the moment a push is composed. Missing file → no sample. */
function sidecarWrittenAt(sessionPath: string): number | undefined {
	try {
		return statSync(sidecarPathFor(sessionPath)).mtimeMs;
	} catch {
		return undefined;
	}
}

function debugLine(deps: DeliveryDeps, line: string): void {
	(deps.debug ?? ((text) => process.stderr.write(`${text}\n`)))(line);
}

/**
 * Detect latency for a terminal sidecar push: sidecar mtime → this push.
 * Busy-queue delay is a different clock and is not folded into this number.
 * Only done/error pushes that carry a session path are sampled.
 */
function logDetectLatency(deps: DeliveryDeps, msg: SteeredMessage): void {
	const sessionPath = msg.details.sessionPath;
	if (typeof sessionPath !== "string") return;
	if (msg.details.kind !== "done" && msg.details.kind !== "error") return;
	const written = (deps.sidecarWrittenAt ?? sidecarWrittenAt)(sessionPath);
	if (written === undefined) return;
	const now = deps.now ?? (() => Date.now());
	const latencyMs = Math.max(0, Math.round(now() - written));
	debugLine(
		deps,
		`pi-herdr delivery detect segment=sidecar→push name=${String(msg.details.name)} ${latencyMs}ms`,
	);
}

/** Watch one pi child's `<session>.exit`. A throw leaves that child to the poll. */
function watchOneSidecar(
	deps: DeliveryDeps,
	record: SpawnRecord,
	onWrite: (event: { mtimeMs?: number }) => void,
): { close(): void } | undefined {
	if (!record.sessionPath || record.kind.toLowerCase() !== "pi") return undefined;
	const path = sidecarPathFor(record.sessionPath);
	const watchSidecar =
		deps.watchSidecar ??
		((target, cb): { close(): void } => {
			const dir = dirname(target);
			const file = basename(target);
			let w: FSWatcher;
			try {
				w = watch(dir, (_event: string, name: string | null) => {
					if (name !== file && name !== null) return;
					cb({ mtimeMs: sidecarWrittenAt(record.sessionPath!) });
				});
			} catch {
				// The file itself may not exist yet; watching it directly fails on
				// some platforms until the child creates it. Directory watch is the
				// primary path — this is only the last attempt.
				w = watch(target, () => {
					cb({ mtimeMs: sidecarWrittenAt(record.sessionPath!) });
				});
			}
			return { close: () => w.close() };
		});
	return watchSidecar(path, onWrite);
}

/**
 * Arm one watcher per undelivered pi sidecar. A write wakes exactly one tick;
 * the existing delivery mark keeps a later poll from pushing the same event.
 * Watcher failure is per record — the 2.5s loop still delivers that child.
 */
export function observeExitSidecars(
	deps: DeliveryDeps,
	tick: () => Promise<void>,
): { close(): void; whenIdle(): Promise<void>; sync(): void } {
	const watches = new Map<string, { close(): void }>();
	let chain: Promise<void> = Promise.resolve();
	const wake = (): void => {
		chain = chain.then(() => tick()).catch(() => {});
	};
	const sync = (): void => {
		const registry = (deps.registry ?? spawnRecords)();
		const live = new Set<string>();
		for (const record of registry.values()) {
			if (record.delivery || !record.paneId || !record.sessionPath) continue;
			if (record.kind.toLowerCase() !== "pi") continue;
			live.add(record.sessionPath);
			if (watches.has(record.sessionPath)) continue;
			try {
				const one = watchOneSidecar(deps, record, () => wake());
				if (one) watches.set(record.sessionPath, one);
			} catch {
				/* this child's poll backstop still runs */
			}
		}
		for (const [path, one] of watches) {
			if (live.has(path)) continue;
			watches.delete(path);
			try {
				one.close();
			} catch {
				/* best-effort */
			}
		}
	};
	sync();
	return {
		close(): void {
			for (const one of watches.values()) {
				try {
					one.close();
				} catch {
					/* best-effort */
				}
			}
			watches.clear();
		},
		whenIdle: () => chain,
		sync,
	};
}

/**
 * Register the steer sink + start the shared loop (orchestrator side).
 * Idempotent; ticks no-op when the registry is empty. 07/11 attach their own
 * consumers to the same tick later. Sidecar writes wake one tick immediately;
 * the interval stays as the idempotent backstop.
 */
export function registerDelivery(pi: ExtensionAPI): void {
	if (deliveryTimer) return;
	rememberOrchestratorSession(pi);
	const push = makeDeliverySink(pi);
	const busy = trackOrchestratorBusy(pi);
	const tick = async (): Promise<void> => {
		try {
			// An idle registry costs nothing — no fleet call. But a stale
			// widget must not outlive its fleet: clear it on the way out.
			if (spawnRecords().size === 0) {
				await fleetWidgetOnce();
				return;
			}
			// ONE fleet observation per tick, shared by every pass (deliver,
			// watchdog, widget — the one-poll-loop-many-consumers ruling).
			// busy is read at push time, not at tick start.
			const fleet = await fleetList();
			await deliverOnce({
				push,
				fleet,
				busy,
				sessionPath: currentOrchestratorSession(),
			});
			await watchdogOnce({ push, fleet, busy });
			await fleetWidgetOnce({ fleet });
		} catch {
			/* best-effort */
		}
	};
	exitWatch = observeExitSidecars({ push, busy }, tick);
	deliveryTimer = setInterval(() => {
		exitWatch?.sync();
		void tick();
	}, DELIVERY_INTERVAL_MS);
	if (typeof deliveryTimer.ref === "function") deliveryTimer.ref();
	deliveryTimer.unref?.();
}

/** Stop the loop (tests; /reload tears the module down anyway). */
export function stopDeliveryLoop(): void {
	if (deliveryTimer) {
		clearInterval(deliveryTimer);
		deliveryTimer = null;
	}
	exitWatch?.close();
	exitWatch = null;
}
